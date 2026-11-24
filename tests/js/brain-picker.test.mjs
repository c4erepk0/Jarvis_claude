// Выбор модели на главном экране: группы провайдеров, надпись на кнопке, выбор в ядре для iPhone.
import assert from "node:assert/strict";
import { test } from "node:test";

import { buttonView, groupOptions } from "../../jarvis/webapp/static/brain-picker.js";
import { claudeFallback, claudeWebSearch, label, options } from "../../jarvis/webapp/static/core/models.js";

test("модели группируются по провайдерам в порядке списка", () => {
  const opts = [
    { backend: "claude", provider: "Claude", model: "claude-opus-5-5", label: "Opus 5.5", active: true, error: "" },
    { backend: "claude", provider: "Claude", model: "claude-haiku-5-5", label: "Haiku 5.5", active: false, error: "" },
    { backend: "deepseek", provider: "DeepSeek", model: "deepseek-chat", label: "Chat", active: false,
      error: "ключ не принят" },
  ];
  const g = groupOptions(opts);
  assert.deepEqual(g.map((x) => [x.backend, x.items.length, x.error]), [["claude", 2, ""], ["deepseek", 1, "ключ не принят"]]);
  assert.deepEqual(groupOptions(), []);
});

test("кнопка показывает активную модель", () => {
  assert.deepEqual(buttonView({ llm: true, brain: "DeepSeek", model: "deepseek-chat", model_label: "Chat" }).label,
    "Chat");
  const v = buttonView({ llm: true, brain: "Claude", model: "claude-opus-5-5", model_label: "Opus 5.5" });
  assert.equal(v.provider, "Claude");
  assert.equal(v.cls, "on");
  assert.match(v.title, /claude-opus-5-5/);
  assert.equal(buttonView({ llm: false }).label, "Только команды");
  assert.equal(buttonView(null).cls, "warn");
});

test("ядро для iPhone: только Claude, у Haiku — без фолбэка и поиска", () => {
  assert.deepEqual(options({}, false), []);
  const opts = options({ model: "claude-sonnet-5-5" }, true);
  assert.deepEqual(opts.filter((o) => o.active).map((o) => o.model), ["claude-sonnet-5-5"]);
  assert.ok(opts.every((o) => o.backend === "claude"));
  assert.equal(options({ model: "claude-opus-4-8" }, true)[0].note, "из настроек");
  assert.equal(label("claude-fable-5-2"), "Fable 5.2");
  assert.equal(claudeFallback("claude-haiku-5-5"), false);
  assert.equal(claudeWebSearch("claude-opus-5-5"), true);
});
