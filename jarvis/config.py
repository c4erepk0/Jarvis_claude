"""Настройки Jarvis из переменных окружения (.env).

Новая настройка → поле здесь + строка в .env.example + раздел README.
"""
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def _bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on", "да")


def _int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    return int(raw) if raw else default


def _float(name: str, default: float) -> float:
    raw = os.getenv(name, "").strip().replace(",", ".")
    return float(raw) if raw else default


def _str(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


DEFAULT_CLAUDE_TOOLS = ("Read,Edit,Write,Glob,Grep,Bash(git status:*),Bash(git diff:*),Bash(git log:*),"
                        "Bash(git checkout -b:*),Bash(git switch -c:*),Bash(git add:*),Bash(git commit:*),"
                        "Bash(make test:*),Bash(make check:*),Bash(make lint:*),Bash(pytest:*),"
                        "Bash(python -m pytest:*),Bash(npm test:*)")


@dataclass(frozen=True)
class Config:
    # --- сервер ---
    host: str = "127.0.0.1"
    port: int = 8765
    access_code: str = ""          # код входа в дашборд (обязателен, если сервер слушает не localhost)
    secret: str = ""               # ключ подписи сессий; пусто — создаётся в data/secret.key
    data_dir: Path = Path("data")
    # --- память (Obsidian) ---
    vault_path: Path = Path("vault")
    jarvis_dir: str = "Jarvis"
    projects_dir: str = "Projects"
    finance_dir: str = "Finance"
    journal_dir: str = "Journal"
    tasks_file: str = "Tasks/Inbox.md"
    watch_interval: float = 1.5     # как часто проверять изменения в хранилище, сек
    # --- личность ---
    user_title: str = "сэр"
    user_name: str = ""
    timezone: str = "Europe/Moscow"
    currency: str = "RUB"
    # --- мозг (Claude API) ---
    model: str = "claude-opus-5-5"
    effort: str = "low"             # low — быстрее отвечает голосом; medium/high — глубже думает
    web_search: bool = True
    local_first: bool = True        # простые команды (задачи, траты, протоколы) — без обращения к Claude
    max_history_turns: int = 40     # после — разговор сжимается в краткое резюме
    # --- голос ---
    tts_engine: str = "edge"        # edge | piper | browser
    tts_voice: str = "ru-RU-DmitryNeural"
    tts_rate: str = "-4%"
    tts_pitch: str = "-8Hz"
    piper_bin: str = "piper"
    piper_model: str = ""
    wake_word: str = "джарвис"
    # --- погода / брифинг ---
    city: str = "Москва"
    latitude: float = 55.7558
    longitude: float = 37.6173
    briefing_time: str = "08:30"     # утренний брифинг в Telegram, пусто — выключено
    # --- проекты ---
    github_token: str = ""
    claude_code_bin: str = "claude"
    claude_code_permission_mode: str = "acceptEdits"
    claude_code_allowed_tools: str = DEFAULT_CLAUDE_TOOLS
    ci_check_minutes: int = 5
    # --- Telegram ---
    telegram_token: str = ""
    telegram_owner_id: int = 0
    telegram_voice_reply: bool = False
    # --- диагностика ---
    cpu_alert: int = 90
    ram_alert: int = 90
    disk_alert: int = 90

    @property
    def is_local_only(self) -> bool:
        return self.host in ("127.0.0.1", "localhost", "::1")

    @property
    def llm_enabled(self) -> bool:
        return bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN")
                    or os.getenv("ANTHROPIC_PROFILE"))

    @property
    def telegram_enabled(self) -> bool:
        return bool(self.telegram_token and self.telegram_owner_id)

    def session_secret(self) -> bytes:
        if self.secret:
            return self.secret.encode()
        path = self.data_dir / "secret.key"
        if path.exists():
            return path.read_bytes().strip()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        key = secrets.token_hex(32).encode()
        path.write_bytes(key)
        try:
            path.chmod(0o600)
        except OSError:
            pass
        return key


def load_config() -> Config:
    cfg = Config(
        host=_str("JARVIS_HOST", "127.0.0.1"),
        port=_int("JARVIS_PORT", 8765),
        access_code=_str("JARVIS_ACCESS_CODE"),
        secret=_str("JARVIS_SECRET"),
        data_dir=Path(_str("JARVIS_DATA_DIR", "data")).expanduser(),
        vault_path=Path(_str("VAULT_PATH", "vault")).expanduser(),
        jarvis_dir=_str("VAULT_JARVIS_DIR", "Jarvis"),
        projects_dir=_str("VAULT_PROJECTS_DIR", "Projects"),
        finance_dir=_str("VAULT_FINANCE_DIR", "Finance"),
        journal_dir=_str("VAULT_JOURNAL_DIR", "Journal"),
        tasks_file=_str("VAULT_TASKS_FILE", "Tasks/Inbox.md"),
        watch_interval=max(0.3, _float("VAULT_WATCH_INTERVAL", 1.5)),
        user_title=_str("USER_TITLE", "сэр"),
        user_name=_str("USER_NAME"),
        timezone=_str("TIMEZONE", "Europe/Moscow"),
        currency=_str("CURRENCY", "RUB").upper(),
        model=_str("JARVIS_MODEL", "claude-opus-5-5"),
        effort=_str("JARVIS_EFFORT", "low"),
        web_search=_bool("JARVIS_WEB_SEARCH", True),
        local_first=_bool("JARVIS_LOCAL_FIRST", True),
        max_history_turns=max(6, _int("JARVIS_MAX_TURNS", 40)),
        tts_engine=_str("TTS_ENGINE", "edge").lower(),
        tts_voice=_str("TTS_VOICE", "ru-RU-DmitryNeural"),
        tts_rate=_str("TTS_RATE", "-4%"),
        tts_pitch=_str("TTS_PITCH", "-8Hz"),
        piper_bin=_str("PIPER_BIN", "piper"),
        piper_model=_str("PIPER_MODEL"),
        wake_word=_str("WAKE_WORD", "джарвис").lower(),
        city=_str("WEATHER_CITY", "Москва"),
        latitude=_float("WEATHER_LAT", 55.7558),
        longitude=_float("WEATHER_LON", 37.6173),
        briefing_time=_str("BRIEFING_TIME", "08:30"),
        github_token=_str("GITHUB_TOKEN"),
        claude_code_bin=_str("CLAUDE_CODE_BIN", "claude"),
        claude_code_permission_mode=_str("CLAUDE_CODE_PERMISSION_MODE", "acceptEdits"),
        claude_code_allowed_tools=_str("CLAUDE_CODE_ALLOWED_TOOLS", DEFAULT_CLAUDE_TOOLS),
        ci_check_minutes=max(1, _int("CI_CHECK_MINUTES", 5)),
        telegram_token=_str("TELEGRAM_BOT_TOKEN"),
        telegram_owner_id=_int("TELEGRAM_OWNER_ID", 0),
        telegram_voice_reply=_bool("TELEGRAM_VOICE_REPLY", False),
        cpu_alert=_int("DIAG_CPU_ALERT", 90),
        ram_alert=_int("DIAG_RAM_ALERT", 90),
        disk_alert=_int("DIAG_DISK_ALERT", 90),
    )
    if cfg.effort not in ("low", "medium", "high", "xhigh", "max"):
        raise RuntimeError("JARVIS_EFFORT: допустимо low | medium | high | xhigh | max")
    if cfg.tts_engine not in ("edge", "piper", "browser"):
        raise RuntimeError("TTS_ENGINE: допустимо edge | piper | browser")
    return cfg
