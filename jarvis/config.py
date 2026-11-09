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
    vault_git: str = ""             # репозиторий с хранилищем (тот же, что у Obsidian Git на iPhone)
    vault_git_interval: float = 20  # как часто синхронизироваться с ним, сек
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
    # --- мозг: другие модели (jarvis/llm.py) ---
    llm_provider: str = ""          # claude | gigachat | yandex; пусто — та, для которой задан ключ
    gigachat_auth_key: str = ""     # «Ключ авторизации» из личного кабинета GigaChat API
    gigachat_scope: str = "GIGACHAT_API_PERS"
    gigachat_model: str = "GigaChat-2-Max"
    gigachat_url: str = "https://api.giga.chat/v1"
    gigachat_oauth_url: str = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
    gigachat_ca_file: str = ""      # пусто — сертификат Минцифры из jarvis/certs/
    yandex_api_key: str = ""        # API-ключ сервисного аккаунта (роль ai.languageModels.user)
    yandex_folder_id: str = ""
    yandex_model: str = "yandexgpt/rc"
    yandex_url: str = "https://ai.api.cloud.yandex.net/v1"
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
    def llm_backend(self) -> str:
        """Какая модель — мозг: claude | gigachat | yandex, пусто — нет ни одного ключа."""
        ready = {
            "claude": bool(os.getenv("ANTHROPIC_API_KEY") or os.getenv("ANTHROPIC_AUTH_TOKEN")
                           or os.getenv("ANTHROPIC_PROFILE")),
            "gigachat": bool(self.gigachat_auth_key),
            "yandex": bool(self.yandex_api_key and self.yandex_folder_id),
        }
        if self.llm_provider:
            return self.llm_provider if ready.get(self.llm_provider) else ""
        return next((name for name, ok in ready.items() if ok), "")

    @property
    def llm_enabled(self) -> bool:
        return bool(self.llm_backend)

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


def _vault_git(raw: str) -> str:
    """«c4erepk0/jarvis-vault» или ссылка → https://github.com/c4erepk0/jarvis-vault.git"""
    raw = raw.strip()
    if raw and "://" not in raw and not raw.startswith("git@") and raw.count("/") == 1:
        return f"https://github.com/{raw.removesuffix('.git')}.git"
    return raw


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
        vault_git=_vault_git(_str("VAULT_GIT")),
        vault_git_interval=max(5.0, _float("VAULT_GIT_INTERVAL", 20)),
        user_title=_str("USER_TITLE", "сэр"),
        user_name=_str("USER_NAME"),
        timezone=_str("TIMEZONE", "Europe/Moscow"),
        currency=_str("CURRENCY", "RUB").upper(),
        model=_str("JARVIS_MODEL", "claude-opus-5-5"),
        effort=_str("JARVIS_EFFORT", "low"),
        web_search=_bool("JARVIS_WEB_SEARCH", True),
        local_first=_bool("JARVIS_LOCAL_FIRST", True),
        max_history_turns=max(6, _int("JARVIS_MAX_TURNS", 40)),
        llm_provider=_str("JARVIS_LLM").lower(),
        gigachat_auth_key=_str("GIGACHAT_AUTH_KEY"),
        gigachat_scope=_str("GIGACHAT_SCOPE", "GIGACHAT_API_PERS"),
        gigachat_model=_str("GIGACHAT_MODEL", "GigaChat-2-Max"),
        gigachat_url=_str("GIGACHAT_URL", "https://api.giga.chat/v1"),
        gigachat_oauth_url=_str("GIGACHAT_OAUTH_URL", "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"),
        gigachat_ca_file=_str("GIGACHAT_CA_FILE"),
        yandex_api_key=_str("YANDEX_API_KEY"),
        yandex_folder_id=_str("YANDEX_FOLDER_ID"),
        yandex_model=_str("YANDEX_MODEL", "yandexgpt/rc"),
        yandex_url=_str("YANDEX_URL", "https://ai.api.cloud.yandex.net/v1"),
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
    if cfg.llm_provider not in ("", "claude", "gigachat", "yandex"):
        raise RuntimeError("JARVIS_LLM: допустимо claude | gigachat | yandex (или пусто — по заданному ключу)")
    if cfg.tts_engine not in ("edge", "piper", "browser"):
        raise RuntimeError("TTS_ENGINE: допустимо edge | piper | browser")
    return cfg
