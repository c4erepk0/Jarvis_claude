// Модели-мозги для режима «только iPhone» — порт jarvis/models.py. Из браузера доступен только Claude:
// GigaChat, YandexGPT и DeepSeek работают через сервер (CORS и ключи), поэтому здесь их нет.
export const TITLES = { claude: "Claude", gigachat: "GigaChat", yandex: "YandexGPT", deepseek: "DeepSeek" };

export const CATALOG = {
  claude: [
    ["claude-opus-5-5", "Opus 5.5", "умная, по умолчанию"],
    ["claude-sonnet-5-5", "Sonnet 5.5", "быстрее и дешевле"],
    ["claude-haiku-5-5", "Haiku 5.5", "самая быстрая и дешёвая"],
    ["claude-fable-5-2", "Fable 5.2", "самая сильная, дорогая"],
  ],
};
export const DEFAULT_MODEL = "claude-opus-5-5";

/** Серверный фолбэк при отказе (`fallbacks: "default"`) — у Haiku его нет. */
export const claudeFallback = (model) => !String(model).includes("haiku");
/** Поиск в интернете web_search_20260209 — у Opus, Sonnet и Fable, не у Haiku. */
export const claudeWebSearch = (model) => !String(model).includes("haiku");

export function label(model) {
  const hit = CATALOG.claude.find(([m]) => m === model);
  return hit ? hit[1] : String(model || "");
}

/** Модели для списка выбора: те же поля, что у GET /api/brain на сервере. */
export function options(settings, available) {
  if (!available) return [];
  const active = settings.model || DEFAULT_MODEL;
  const items = [...CATALOG.claude];
  if (!items.some(([m]) => m === active)) items.unshift([active, active, "из настроек"]);
  return items.map(([model, short, note]) => ({
    backend: "claude", provider: "Claude", model, label: short, note, default: model === DEFAULT_MODEL,
    active: model === active, error: "",
  }));
}

export const isKnown = (settings, model) => options(settings, true).some((o) => o.model === model);
