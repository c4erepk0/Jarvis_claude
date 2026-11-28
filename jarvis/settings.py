"""Настройки из интерфейса — приложение «Настройки и диагностика».

Владелец задаёт ключи и токены (Telegram, Claude, GitHub…), свои токены для чего угодно, доступы к SSH-серверам и
автообновление — без правки .env. Всё лежит в data/settings.json (права 600), а не в хранилище: оно
синхронизируется с GitHub и телефоном, секретам там не место.

  {"env":    {"TELEGRAM_BOT_TOKEN": "…"},            — известные настройки (см. KNOWN), поверх .env
   "custom": [{"name": "OPENWEATHER_KEY", "value": "…", "note": "…"}],   — свои токены (тоже в окружение)
   "ssh":    [{"id", "name", "host", "port", "user", "password", "key", "note"}],
   "update": {"auto": false, "hours": 6, "branch": ""},
   "brain":  {"backend": "deepseek", "model": "deepseek-chat"}}   — модель, выбранная на главном экране (сразу)

Значения из интерфейса попадают в окружение при запуске (apply_saved_env — до load_config) и потому вступают в силу
после перезапуска Atom. Секреты наружу не отдаются: в API — только «задано» и последние символы.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import time
from pathlib import Path
from typing import Any

# имя переменной → (подпись, раздел, секрет?)
KNOWN: dict[str, tuple[str, str, bool]] = {
    "ANTHROPIC_API_KEY": ("Ключ Claude API", "Мозг", True),
    "JARVIS_MODEL": ("Модель Claude", "Мозг", False),
    "JARVIS_EFFORT": ("Глубина размышлений (low · medium · high)", "Мозг", False),
    "JARVIS_LLM": ("Какой мозг (claude · gigachat · yandex · deepseek, пусто — по ключу)", "Мозг", False),
    "GIGACHAT_AUTH_KEY": ("GigaChat: ключ авторизации", "Мозг", True),
    "YANDEX_API_KEY": ("YandexGPT: API-ключ", "Мозг", True),
    "YANDEX_FOLDER_ID": ("YandexGPT: каталог (folder id)", "Мозг", False),
    "DEEPSEEK_API_KEY": ("DeepSeek: API-ключ (sk-…)", "Мозг", True),
    "DEEPSEEK_MODEL": ("DeepSeek: модель (deepseek-chat · deepseek-reasoner)", "Мозг", False),
    "LLM_URL": ("Своя модель: адрес API (OpenRouter, прокси, Ollama)", "Мозг", False),
    "LLM_KEY": ("Своя модель: ключ", "Мозг", True),
    "LLM_MODEL": ("Своя модель: имя модели", "Мозг", False),
    "TELEGRAM_BOT_TOKEN": ("Токен бота Telegram", "Telegram", True),
    "TELEGRAM_OWNER_ID": ("Ваш ID в Telegram", "Telegram", False),
    "BRIEFING_TIME": ("Утренний брифинг в Telegram (ЧЧ:ММ, пусто — выкл.)", "Telegram", False),
    "GITHUB_TOKEN": ("Токен GitHub (проекты, хранилище, обновления)", "GitHub", True),
    "VAULT_GIT": ("Репозиторий хранилища (владелец/имя)", "GitHub", False),
    "USER_TITLE": ("Как обращаться", "Личное", False),
    "USER_NAME": ("Имя", "Личное", False),
    "WEATHER_CITY": ("Город для погоды", "Личное", False),
    "WEATHER_LAT": ("Широта", "Личное", False),
    "WEATHER_LON": ("Долгота", "Личное", False),
    "TIMEZONE": ("Часовой пояс", "Личное", False),
    "WAKE_WORD": ("Слово-обращение", "Голос", False),
    "NEWS_FEEDS": ("Свои ленты RSS через запятую (пусто — встроенные)", "Новости", False),
    "NEWS_INTERVAL": ("Опрашивать ленты раз в … минут", "Новости", False),
    "NEWS_ALERTS": ("Оповещать о сильных прогнозах по вашим активам (1/0)", "Новости", False),
    "TTS_VOICE": ("Голос: имя (edge) / id (ElevenLabs) / голос SpeechKit (filipp, alena…)", "Голос", False),
    "TTS_ENGINE": ("Синтез речи (yandex · openai · eleven · edge · piper · browser)", "Голос", False),
    "TTS_MODEL": ("Голос: модель (gpt-4o-mini-tts · eleven_multilingual_v2)", "Голос", False),
    "TTS_KEY": ("Голос: ключ синтеза", "Голос", True),
    "TTS_URL": ("Голос: адрес API (пусто — по провайдеру)", "Голос", False),
    "TTS_STYLE": ("Голос: манера («спокойно, тепло») или эмоция good", "Голос", False),
    "TTS_RATE": ("Голос: скорость (-4%)", "Голос", False),
}
# свои токены не могут подменить то, от чего зависит запуск и безопасность
BLOCKED = re.compile(r"^(PATH|HOME|USER|SHELL|PWD|LANG|LC_\w*|TZ|LD_\w*|DYLD_\w*|PYTHON\w*|VIRTUAL_ENV|SSL_\w*|"
                     r"REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|HTTPS?_PROXY|NO_PROXY|JARVIS_(HOST|PORT|DATA_DIR|SECRET|"
                     r"ACCESS_CODE)|VAULT_PATH|GIT_\w*)$", re.I)
NAME = re.compile(r"^[A-Z][A-Z0-9_]{1,63}$")
HOST = re.compile(r"^[A-Za-z0-9._:-]{1,253}$")
MAX_VALUE = 4000
MAX_ITEMS = 50


def mask(value: str) -> str:
    """«sk-ant-…a1b2»: видно, какой ключ задан, но не сам ключ."""
    v = str(value or "")
    if not v:
        return ""
    if len(v) <= 8:
        return "•" * len(v)
    return f"{v[:3]}…{v[-4:]}"


def _path(data_dir: Path) -> Path:
    return Path(data_dir) / "settings.json"


def apply_saved_env(data_dir: Path | None = None) -> list[str]:
    """При запуске: значения из интерфейса → в окружение (поверх .env). Возвращает, что задано."""
    from . import config  # noqa: F401 — загружает .env до того, как мы его перекроем

    data_dir = Path(data_dir or os.getenv("JARVIS_DATA_DIR", "data")).expanduser()
    try:
        data = json.loads(_path(data_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    names = []
    env = _migrate(data)
    for k, v in env.items():
        if k in KNOWN and isinstance(v, str):
            os.environ[k] = v
            names.append(k)
    for c in data.get("custom") or []:
        k, v = str(c.get("name") or ""), c.get("value")
        if NAME.match(k) and not BLOCKED.match(k) and k not in KNOWN and isinstance(v, str):
            os.environ[k] = v
            names.append(k)
    return names


def _migrate(data: dict) -> dict:
    """Свой токен, который потом стал известной настройкой (например, DEEPSEEK_API_KEY), — переносим в env,
    иначе после обновления он молча пропал бы."""
    env = data.setdefault("env", {})
    keep = []
    for c in data.get("custom") or []:
        k = str(c.get("name") or "")
        if k in KNOWN:
            if k not in env and isinstance(c.get("value"), str):
                env[k] = c["value"]
            continue
        keep.append(c)
    data["custom"] = keep
    return env


class Settings:
    def __init__(self, data_dir: Path):
        self.path = _path(data_dir)
        self.data = self._load()
        self.changed_at: float | None = None          # было изменение, требующее перезапуска

    def _load(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        data.setdefault("custom", [])
        _migrate(data)
        data.setdefault("ssh", [])
        data.setdefault("update", {"auto": False, "hours": 6, "branch": ""})
        data.setdefault("brain", {})
        return data

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)

    # ---------- вид для интерфейса (без секретов) ----------
    def public(self) -> dict:
        env = self.data["env"]
        known = []
        for name, (label, group, secret) in KNOWN.items():
            ui = env.get(name)
            cur = ui if ui is not None else os.getenv(name, "")
            item = {"name": name, "label": label, "group": group, "secret": secret, "set": bool(cur),
                    "source": "ui" if ui is not None else ("env" if cur else "")}
            item["value" if not secret else "preview"] = cur if not secret else mask(cur)
            known.append(item)
        custom = [{"name": c["name"], "note": c.get("note", ""), "preview": mask(c.get("value", "")),
                   "set": bool(c.get("value"))} for c in self.data["custom"]]
        ssh = [{k: v for k, v in s.items() if k not in ("password", "key")}
               | {"has_password": bool(s.get("password")), "has_key": bool(s.get("key"))} for s in self.data["ssh"]]
        return {"known": known, "custom": custom, "ssh": ssh, "update": dict(self.data["update"]),
                "restart_needed": self.changed_at is not None}

    # ---------- изменения ----------
    def _value(self, value: Any) -> str:
        v = str(value if value is not None else "").strip()
        if len(v) > MAX_VALUE:
            raise ValueError(f"значение длиннее {MAX_VALUE} символов")
        if "\n" in v or "\x00" in v:
            raise ValueError("значение — одной строкой")
        return v

    def set_known(self, name: str, value: Any) -> None:
        """value None — убрать значение из интерфейса (останется то, что в .env)."""
        if name not in KNOWN:
            raise ValueError(f"неизвестная настройка {name}")
        if value is None:
            self.data["env"].pop(name, None)
        else:
            v = self._value(value)
            if name == "JARVIS_LLM":
                from .config import LLM_ALIASES, LLM_PROVIDERS
                v = LLM_ALIASES.get(v.lower(), v.lower())
                if v and v not in LLM_PROVIDERS:
                    raise ValueError(f"мозг — {' · '.join(LLM_PROVIDERS)} или пусто (по заданному ключу)")
            self.data["env"][name] = v
        self._touch()

    def set_custom(self, name: str, value: Any = None, note: str = "", remove: bool = False) -> None:
        name = str(name or "").strip().upper()
        if not NAME.match(name):
            raise ValueError("имя токена — латиницей заглавными, цифры и _, например OPENWEATHER_KEY")
        if BLOCKED.match(name) or name in KNOWN:
            raise ValueError(f"{name} — служебная переменная, задайте её в своём разделе или в .env")
        items = self.data["custom"]
        cur = next((c for c in items if c["name"] == name), None)
        if remove:
            if cur:
                items.remove(cur)
                self._touch()
            return
        if cur is None:
            if len(items) >= MAX_ITEMS:
                raise ValueError("слишком много токенов")
            cur = {"name": name, "value": "", "note": ""}
            items.append(cur)
        if value is not None:
            cur["value"] = self._value(value)
        cur["note"] = str(note or cur.get("note") or "").strip()[:200]
        items.sort(key=lambda c: c["name"])
        self._touch()

    def ssh_upsert(self, data: dict) -> dict:
        sid = str(data.get("id") or "")
        items = self.data["ssh"]
        cur = next((s for s in items if s["id"] == sid), None) if sid else None
        host = str(data.get("host") or (cur or {}).get("host") or "").strip()
        if not HOST.match(host):
            raise ValueError("укажите адрес сервера: 203.0.113.7 или my.server.ru")
        try:
            port = int(data.get("port") or (cur or {}).get("port") or 22)
        except (TypeError, ValueError):
            raise ValueError("порт — число") from None
        if not 0 < port < 65536:
            raise ValueError("порт — от 1 до 65535")
        user = str(data.get("user") or (cur or {}).get("user") or "root").strip()
        if not re.match(r"^[\w.-]{1,64}$", user):
            raise ValueError("имя пользователя — латиницей")
        key = None
        if data.get("key") is not None and (data["key"] != "" or data.get("clear_key")):
            key = str(data["key"]).strip()
            if len(key) > 16000:
                raise ValueError("ключ слишком длинный")
            if key and "PRIVATE KEY" not in key:
                raise ValueError("вставьте закрытый ключ целиком (-----BEGIN … PRIVATE KEY-----)")
        password = None
        if data.get("password") is not None and (data["password"] != "" or data.get("clear_password")):
            password = self._value(data["password"])
        if cur is None:
            if len(items) >= MAX_ITEMS:
                raise ValueError("слишком много серверов")
            cur = {"id": secrets.token_hex(4), "password": "", "key": ""}
            items.append(cur)
        cur.update(name=str(data.get("name") or cur.get("name") or host).strip()[:60], host=host, port=port, user=user,
                   note=str(data.get("note") if data.get("note") is not None else cur.get("note", "")).strip()[:200])
        if password is not None:
            cur["password"] = password
        if key is not None:
            cur["key"] = key
        self._save()
        return {k: v for k, v in cur.items() if k not in ("password", "key")}

    def ssh_remove(self, sid: str) -> None:
        before = len(self.data["ssh"])
        self.data["ssh"] = [s for s in self.data["ssh"] if s["id"] != sid]
        if len(self.data["ssh"]) == before:
            raise ValueError("нет такого сервера")
        self._save()

    def ssh_get(self, sid: str) -> dict:
        s = next((s for s in self.data["ssh"] if s["id"] == sid), None)
        if not s:
            raise ValueError("нет такого сервера")
        return s

    def set_update(self, auto: Any = None, hours: Any = None, branch: Any = None) -> dict:
        u = self.data["update"]
        if auto is not None:
            u["auto"] = bool(auto)
        if hours is not None:
            try:
                u["hours"] = max(1, min(168, int(hours)))
            except (TypeError, ValueError):
                raise ValueError("как часто проверять — число часов") from None
        if branch is not None:
            b = str(branch).strip()
            if b and not re.match(r"^[\w./-]{1,100}$", b):
                raise ValueError("недопустимое имя ветки")
            u["branch"] = b
        self._save()
        return dict(u)

    def set_brain(self, backend: str, model: str) -> None:
        """Модель, выбранная на главном экране: действует сразу, перезапуск не нужен."""
        self.data["brain"] = {"backend": str(backend), "model": self._value(model)}
        self._save()

    def _touch(self) -> None:
        self.changed_at = time.time()
        self._save()
