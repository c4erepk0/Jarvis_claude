"""Какие модели можно выбрать мозгом Atom: каталог по провайдерам и список подключённых.

Подключённая модель — та, у провайдера которой задан ключ (`Config.llm_ready`). В списке — модели из каталога
и модель из настроек (`JARVIS_MODEL`, `DEEPSEEK_MODEL`…), если её в каталоге нет. Выбор хранится в
data/settings.json (`brain`) и действует сразу, без перезапуска: Brain начинает новый разговор — у каждой модели
свой формат истории, а системный промпт и инструменты внутри разговора не меняются.

То же — в JS-ядре для iPhone (`static/core/models.js`, там только Claude).
"""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .config import Config

TITLES = {"claude": "Claude", "gigachat": "GigaChat", "yandex": "YandexGPT", "deepseek": "DeepSeek",
          "custom": "Своя модель"}

# провайдер → [(модель, коротко, пояснение)]
CATALOG: dict[str, list[tuple[str, str, str]]] = {
    "claude": [
        ("claude-opus-5-5", "Opus 5.5", "умная, по умолчанию"),
        ("claude-sonnet-5-5", "Sonnet 5.5", "быстрее и дешевле"),
        ("claude-haiku-5-5", "Haiku 5.5", "самая быстрая и дешёвая"),
        ("claude-fable-5-2", "Fable 5.2", "самая сильная, дорогая"),
    ],
    "gigachat": [
        ("GigaChat-2-Max", "2 Max", "самая умная"),
        ("GigaChat-2-Pro", "2 Pro", "баланс"),
        ("GigaChat-2", "2 Lite", "быстрая"),
    ],
    "yandex": [
        ("yandexgpt/rc", "Pro", "по умолчанию"),
        ("yandexgpt-lite/latest", "Lite", "быстрая"),
    ],
    "deepseek": [
        ("deepseek-chat", "Chat", "быстрая, по умолчанию"),
        ("deepseek-reasoner", "Reasoner", "думает дольше"),
    ],
    "custom": [],          # модель задаётся в настройках: OpenRouter, прокси, Ollama
}


def claude_fallback(model: str) -> bool:
    """Серверный фолбэк при отказе (`fallbacks: "default"`): у Haiku его нет."""
    return "haiku" not in model


def claude_web_search(model: str) -> bool:
    """Поиск в интернете `web_search_20260209` — у Opus, Sonnet и Fable, не у Haiku."""
    return "haiku" not in model


def default_model(cfg: "Config", backend: str) -> str:
    return {"claude": cfg.model, "gigachat": cfg.gigachat_model, "yandex": cfg.yandex_model,
            "deepseek": cfg.deepseek_model, "custom": cfg.custom_model}.get(backend, "")


def label(backend: str, model: str) -> str:
    """Коротко, без имени провайдера: «Opus 5.5», «Chat» (DeepSeek); незнакомую модель — как есть."""
    for m, short, _ in CATALOG.get(backend, []):
        if m == model:
            return short
    return model


def catalog(cfg: "Config", backend: str) -> list[tuple[str, str, str]]:
    items = list(CATALOG.get(backend, []))
    own = default_model(cfg, backend)
    if own and all(m != own for m, _, _ in items):
        items.insert(0, (own, own, "из настроек"))
    return items


def options(cfg: "Config", ready: dict[str, bool], active: tuple[str, str] | None,
            health: dict[str, str] | None = None) -> list[dict]:
    """Модели подключённых провайдеров для списка выбора."""
    health = health or {}
    out = []
    for backend in TITLES:
        if not ready.get(backend):
            continue
        for model, short, note in catalog(cfg, backend):
            out.append({"backend": backend, "provider": TITLES[backend], "model": model, "label": short,
                        "note": note, "default": model == default_model(cfg, backend),
                        "active": active == (backend, model), "error": health.get(backend, "")})
    return out


def is_known(cfg: "Config", backend: str, model: str) -> bool:
    return any(m == model for m, _, _ in catalog(cfg, backend))
