"""Мозг Jarvis на моделях, доступных в России: GigaChat (Сбер) и YandexGPT (Яндекс AI Studio).

Разговор ведёт `Brain` одинаково для всех моделей: личность, служебная строка, инструменты Jarvis,
история только дописывается. Здесь — только перевод в формат конкретного API:

- **GigaChat** (`https://api.giga.chat/v1`): функции — в `functions`, вызов приходит как `function_call`
  (+ `functions_state_id`), результат возвращается сообщением с ролью `function`, содержимое —
  JSON-объект строкой. Токен OAuth (`ngw.devices.sberbank.ru`) живёт 30 минут. TLS у GigaChat —
  на сертификате Минцифры: он лежит в `jarvis/certs/` и подключается только к запросам GigaChat,
  а не ко всей системе.
- **YandexGPT** (`https://ai.api.cloud.yandex.net/v1`): OpenAI-совместимый Chat Completions —
  `tools`, `tool_calls`, результат с ролью `tool`; заголовки `Authorization: Api-Key …`
  и `OpenAI-Project: <каталог>`.
"""
from __future__ import annotations

import asyncio
import json
import logging
import ssl
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

import aiohttp

if TYPE_CHECKING:
    from .config import Config

log = logging.getLogger("jarvis.llm")
RU_ROOT_CA = Path(__file__).parent / "certs" / "russian_trusted_root_ca.pem"
TIMEOUT = aiohttp.ClientTimeout(total=90, connect=15)
# только то, что точно понимают оба API; additionalProperties и пр. — убираем
SCHEMA_KEYS = {"type", "properties", "required", "enum", "description", "items", "minimum", "maximum"}


RETRY_DELAY = 1.5   # временный сбой (сеть, 5xx, лимит) — одна повторная попытка через полторы секунды

# Примеры вызовов для GigaChat (few_shot_examples): с ними он точнее выбирает инструмент и аргументы.
FEW_SHOT: dict[str, list[dict]] = {
    "tasks_list": [{"request": "что у меня на сегодня", "params": {"view": "today"}}],
    "task_add": [{"request": "добавь задачу позвонить в банк", "params": {"text": "позвонить в банк"}}],
    "money_add": [{"request": "потратил 300 на кофе",
                   "params": {"amount_rub": -300, "category": "Кафе", "note": "кофе"}}],
    "memory_search": [{"request": "что я писал про отпуск", "params": {"query": "отпуск"}}],
    "memory_remember": [{"request": "запомни, что я не пью кофе после шести",
                         "params": {"fact": "Не пьёт кофе после 18:00"}}],
    "note_show": [{"request": "открой заметку про IPAStore", "params": {"path": "IPAStore"}}],
    "notes_list": [{"request": "какие у меня есть заметки по проектам", "params": {"folder": "Projects"}}],
    "run_protocol": [{"request": "включи режим фокуса", "params": {"name": "фокус"}}],
}


class LLMError(Exception):
    """Модель недоступна: сеть, лимит, ошибка сервера."""

    def __init__(self, message: str, transient: bool = False):
        super().__init__(message)
        self.transient = transient


class LLMAuthError(LLMError):
    """Ключ не принят."""

    def __init__(self, message: str):
        super().__init__(message, transient=False)


@dataclass
class Turn:
    """Ответ модели в общем виде."""
    text: str = ""
    calls: list[tuple[str, str, dict]] = field(default_factory=list)   # (id вызова, инструмент, аргументы)
    message: dict = field(default_factory=dict)                        # как дописать в историю
    refused: bool = False
    usage: tuple[int, int] = (0, 0)                                    # (вход, выход) в токенах


def clean_schema(schema: dict) -> dict:
    out = {k: v for k, v in schema.items() if k in SCHEMA_KEYS and k not in ("properties", "items")}
    if isinstance(schema.get("properties"), dict):
        out["properties"] = {name: clean_schema(p) for name, p in schema["properties"].items()}
    if isinstance(schema.get("items"), dict):
        out["items"] = clean_schema(schema["items"])
    return out


def functions(tools: list[dict], examples: bool = False) -> list[dict]:
    """Инструменты Jarvis (формат Anthropic) → описания функций для GigaChat / OpenAI."""
    out = []
    for t in tools:
        if "input_schema" not in t:
            continue
        spec = {"name": t["name"], "description": t.get("description", ""),
                "parameters": clean_schema(t["input_schema"])}
        if examples and t["name"] in FEW_SHOT:
            spec["few_shot_examples"] = FEW_SHOT[t["name"]]
        out.append(spec)
    return out


def parse_args(raw: Any) -> dict:
    """Аргументы вызова: у GigaChat — объект, у OpenAI-совместимых — JSON строкой."""
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        log.warning("модель прислала аргументы не в JSON: %.200s", raw)
        return {}
    return value if isinstance(value, dict) else {}


def _message(data: dict) -> str:
    for key in ("message", "error", "description"):
        val = data.get(key)
        if isinstance(val, dict):
            val = val.get("message")
        if val:
            return str(val)[:300]
    return ""


class ChatLLM:
    name = ""
    title = ""

    def __init__(self, cfg: "Config"):
        self.cfg = cfg
        self._session: aiohttp.ClientSession | None = None

    @property
    def model(self) -> str:
        raise NotImplementedError

    def ssl_context(self) -> ssl.SSLContext | None:
        return None   # обычная проверка сертификатов

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def post(self, url: str, *, headers: dict, json_body: dict | None = None,
                   form: dict | None = None) -> dict:
        """Запрос к API; при временном сбое (сеть, 5xx, лимит) — одна повторная попытка."""
        try:
            return await self._post_once(url, headers=headers, json_body=json_body, form=form)
        except LLMError as e:
            if not e.transient:
                raise
            log.warning("%s: %s — повторяю через %.1f с", self.title, e, RETRY_DELAY)
            await asyncio.sleep(RETRY_DELAY)
            return await self._post_once(url, headers=headers, json_body=json_body, form=form)

    async def _post_once(self, url: str, *, headers: dict, json_body: dict | None, form: dict | None) -> dict:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=TIMEOUT, trust_env=True)
        try:
            async with self._session.post(url, headers=headers, json=json_body, data=form,
                                          ssl=self.ssl_context() if url.startswith("https:") else None) as r:
                status, body = r.status, await r.text()
        except aiohttp.ClientSSLError as e:
            raise LLMError(f"ошибка сертификата TLS ({e})") from e
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            raise LLMError(f"нет связи с {self.title} ({str(e) or type(e).__name__})", transient=True) from e
        try:
            data = json.loads(body) if body else {}
        except ValueError:
            data = {"message": body[:300]}
        if not isinstance(data, dict):
            data = {"data": data}
        if status in (401, 403):
            raise LLMAuthError(_message(data) or f"HTTP {status}")
        if status == 429:
            raise LLMError("лимит запросов — попробуйте через минуту", transient=True)
        if status >= 400:
            raise LLMError(f"HTTP {status}: {_message(data) or 'ошибка сервера'}", transient=status >= 500)
        return data

    async def complete(self, system: str, messages: list[dict], tools: list[dict]) -> Turn:
        raise NotImplementedError

    def tool_message(self, call_id: str, name: str, content: str, is_error: bool) -> dict:
        raise NotImplementedError


class GigaChat(ChatLLM):
    name, title = "gigachat", "GigaChat"

    def __init__(self, cfg: "Config"):
        super().__init__(cfg)
        self.token: str | None = None
        self.token_until = 0.0
        self._ssl: ssl.SSLContext | None = None

    @property
    def model(self) -> str:
        return self.cfg.gigachat_model

    def ssl_context(self) -> ssl.SSLContext:
        if self._ssl is None:
            ca = Path(self.cfg.gigachat_ca_file).expanduser() if self.cfg.gigachat_ca_file else RU_ROOT_CA
            ctx = ssl.create_default_context()   # системные сертификаты + корневой Минцифры — только здесь
            try:
                ctx.load_verify_locations(cafile=str(ca))
            except (OSError, ssl.SSLError) as e:
                raise LLMError(f"не прочитать сертификат Минцифры {ca}: {e}") from e
            self._ssl = ctx
        return self._ssl

    async def auth(self, force: bool = False) -> str:
        if self.token and not force and time.time() < self.token_until - 60:
            return self.token
        key = self.cfg.gigachat_auth_key.strip()
        if key.lower().startswith("basic "):
            key = key[6:].strip()
        data = await self.post(self.cfg.gigachat_oauth_url, form={"scope": self.cfg.gigachat_scope}, headers={
            "Authorization": f"Basic {key}", "RqUID": str(uuid.uuid4()), "Accept": "application/json"})
        token = data.get("access_token")
        if not token:
            raise LLMAuthError("GigaChat не выдал токен доступа")
        expires = float(data.get("expires_at") or 0)
        if expires > 1e11:   # в документации — миллисекунды (бывают и секунды)
            expires /= 1000
        self.token, self.token_until = token, expires or time.time() + 25 * 60
        return token

    async def complete(self, system: str, messages: list[dict], tools: list[dict]) -> Turn:
        body = {"model": self.model, "messages": [{"role": "system", "content": system}, *messages],
                "functions": functions(tools, examples=True), "function_call": "auto"}
        data: dict = {}
        for attempt in (0, 1):
            token = await self.auth(force=attempt == 1)
            try:
                data = await self.post(f"{self.cfg.gigachat_url.rstrip('/')}/chat/completions", json_body=body,
                                       headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
                break
            except LLMAuthError:
                if attempt:   # свежий токен тоже не принят — дело в ключе
                    raise
                self.token = None
        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        usage = data.get("usage") or {}
        used = (int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0))
        if choice.get("finish_reason") == "blacklist":
            return Turn(refused=True, usage=used)
        fc = msg.get("function_call") or {}
        calls = [(msg.get("functions_state_id") or "call", fc["name"], parse_args(fc.get("arguments")))] \
            if fc.get("name") else []
        keep = {"role": "assistant", "content": msg.get("content") or ""}
        for k in ("function_call", "functions_state_id"):
            if msg.get(k):
                keep[k] = msg[k]
        return Turn(text=msg.get("content") or "", calls=calls, message=keep, usage=used)

    def tool_message(self, call_id: str, name: str, content: str, is_error: bool) -> dict:
        # GigaChat ждёт в content JSON-объект строкой
        try:
            value = json.loads(content)
        except ValueError:
            value = None
        if not isinstance(value, dict):
            value = {"error": content} if is_error else {"result": content if value is None else value}
        return {"role": "function", "name": name, "content": json.dumps(value, ensure_ascii=False)}


class YandexGPT(ChatLLM):
    name, title = "yandex", "YandexGPT"

    @property
    def model(self) -> str:
        m = self.cfg.yandex_model
        return m if "://" in m else f"gpt://{self.cfg.yandex_folder_id}/{m}"

    async def complete(self, system: str, messages: list[dict], tools: list[dict]) -> Turn:
        body = {"model": self.model, "messages": [{"role": "system", "content": system}, *messages],
                "tools": [{"type": "function", "function": f} for f in functions(tools)], "tool_choice": "auto"}
        data = await self.post(f"{self.cfg.yandex_url.rstrip('/')}/chat/completions", json_body=body, headers={
            "Authorization": f"Api-Key {self.cfg.yandex_api_key}", "OpenAI-Project": self.cfg.yandex_folder_id})
        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        usage = data.get("usage") or {}
        used = (int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0))
        if choice.get("finish_reason") == "content_filter":
            return Turn(refused=True, usage=used)
        tool_calls = msg.get("tool_calls") or []
        calls = [(tc.get("id") or f"call_{i}", (tc.get("function") or {}).get("name", ""),
                  parse_args((tc.get("function") or {}).get("arguments"))) for i, tc in enumerate(tool_calls)]
        keep: dict = {"role": "assistant", "content": msg.get("content") or ""}
        if tool_calls:
            keep["tool_calls"] = tool_calls
        return Turn(text=msg.get("content") or "", calls=[c for c in calls if c[1]], message=keep, usage=used)

    def tool_message(self, call_id: str, name: str, content: str, is_error: bool) -> dict:
        return {"role": "tool", "tool_call_id": call_id, "content": content}


PROVIDERS: dict[str, type[ChatLLM]] = {"gigachat": GigaChat, "yandex": YandexGPT}


def make_chat(cfg: "Config", backend: str) -> ChatLLM:
    try:
        return PROVIDERS[backend](cfg)
    except KeyError:
        raise ValueError(f"неизвестная модель {backend!r}") from None
