// Рендер заметок в голограмме: безопасность и разметка Obsidian. node --test tests/js
import assert from "node:assert/strict";
import { test } from "node:test";

import { renderMarkdown } from "../../jarvis/webapp/static/markdown.js";

const notes = { "IPAStore": "Projects/IPAStore.md", "Jarvis": "Projects/Jarvis.md" };
const resolve = (name) => notes[name] || null;

test("HTML и скрипты из заметки не выполняются", () => {
  const { html } = renderMarkdown('<script>alert(1)</script>\n<img src=x onerror="alert(1)">\n'
    + "[клик](javascript:alert(1)) [[x\" onclick=\"alert(1)]]\n```\n<b>код</b>\n```", { resolve });
  assert.ok(!/<script|<img|onerror="|onclick="|href="javascript/i.test(html), html);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<pre class="md-code"><code>&lt;b&gt;код&lt;\/b&gt;<\/code><\/pre>/);
});

test("разметка Obsidian", () => {
  const src = [
    "---", "type: project", "status: active", "---",
    "# IPAStore", "Связан с [[Jarvis]] и [[Несуществующая|черновиком]], см. [сайт](https://t.me/IPA_Market_bot).",
    "**Важно**: *курсив*, ~~старое~~, ==главное==, `код` и #ipastore.",
    "- [ ] написать оферту", "  - [x] собрать цены", "1. первый шаг",
    "> [!warning] Осторожно", "> деньги — в копейках",
    "| Месяц | Доход |", "|---|---:|", "| Ноябрь | 50 000 |",
    "---", "Файл snake_case_name и 2*3=6.",
  ].join("\n");
  const { html, links } = renderMarkdown(src, { resolve });
  assert.match(html, /<div class="md-meta"><div><span>type<\/span><b>project<\/b><\/div>/);
  assert.match(html, /<h1>IPAStore<\/h1>/);
  assert.match(html, /<a class="md-link" data-note="Jarvis" data-path="Projects\/Jarvis.md">Jarvis<\/a>/);
  assert.match(html, /<a class="md-link md-missing" data-note="Несуществующая">черновиком<\/a>/);
  assert.match(html, /<a class="md-ext" href="https:\/\/t.me\/IPA_Market_bot" target="_blank" rel="noopener noreferrer">сайт<\/a>/);
  assert.match(html, /<b>Важно<\/b>: <i>курсив<\/i>, <s>старое<\/s>, <mark>главное<\/mark>, <code>код<\/code> и <span class="md-tag">#ipastore<\/span>/);
  assert.match(html, /<li class="md-task" data-line="7" style="--d:0"><span class="md-check" aria-hidden="true"><\/span>написать оферту<\/li>/);
  assert.match(html, /<li class="md-task done" data-line="8" style="--d:1">/);
  assert.match(html, /<span class="md-num">1\.<\/span>первый шаг/);
  assert.match(html, /<blockquote class="md-callout md-callout-warning"><div class="md-callout-t">Осторожно<\/div>деньги — в копейках<\/blockquote>/);
  assert.match(html, /<th>Месяц<\/th><th>Доход<\/th>.*<td>Ноябрь<\/td><td>50 000<\/td>/s);
  assert.match(html, /<hr>/);
  assert.match(html, /Файл snake_case_name и 2\*3=6\./);
  assert.deepEqual(links, ["Jarvis", "Несуществующая"]);
});

test("задача отмечается прямо в голограмме — как в Obsidian Tasks", async () => {
  const { toggleTask } = await import("../../jarvis/webapp/static/markdown.js");
  const text = "# Дела\n- [ ] написать оферту 📅 2026-11-13\n  - [x] собрать цены ✅ 2026-11-08\nтекст";
  const done = toggleTask(text, 1, "2026-11-09");
  assert.equal(done.split("\n")[1], "- [x] написать оферту 📅 2026-11-13 ✅ 2026-11-09");
  assert.equal(toggleTask(done, 1, "2026-11-09"), text);
  assert.equal(toggleTask(text, 2, "2026-11-09").split("\n")[2], "  - [ ] собрать цены");
  assert.equal(toggleTask(text, 3, "2026-11-09"), null);
});
