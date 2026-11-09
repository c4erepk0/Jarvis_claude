// Протоколы — макросы в духе Железного человека. Встроенные + свои из Jarvis/Protocols.md. Порт jarvis/protocols.py.
import { MONTHS_GEN, WEEKDAYS, addDays, greeting, money, plural, weekdayIndex } from "./ru.js";
import { Briefing } from "./briefing.js";
import { projectLine } from "./projects.js";

export const BUILTIN = {
  "утро": "Утренний брифинг: погода, задачи, финансы, проекты, курс",
  "фокус": "25 минут фокуса без отвлечений, потом напоминание о перерыве",
  "итоги": "Итоги дня: что сделано и потрачено — в ежедневную заметку",
  "неделя": "Обзор недели — отдельной заметкой в журнале",
  "диагностика": "Проверка систем: связь, память, синхронизация, мозг",
  "чистый лист": "Убрать старые выполненные задачи в архив",
  "вечеринка": "Все проекты: статус и выкатка (с подтверждением)",
  "тишина": "Выключить голос (включить — «протокол голос»)",
  "голос": "Включить голос",
};
const ALIASES = { "итоги дня": "итоги", "утренний брифинг": "утро", "брифинг": "утро", "домашняя вечеринка": "вечеринка",
  "режим фокуса": "фокус", "обзор недели": "неделя", "итоги недели": "неделя" };
const FOCUS_MIN = 25;

export class Protocols {
  constructor(j) { this.j = j; }
  get path() { return "Jarvis/Protocols.md"; }

  custom() {
    if (!this.j.vault.exists(this.path)) return {};
    const out = {};
    let cur = null;
    for (const line of this.j.vault.read(this.path).split("\n")) {
      let m = /^##\s+(?:Протокол\s+)?[«"']?(.+?)[»"']?\s*$/iu.exec(line.trim());
      if (m) { cur = m[1].trim(); out[cur] = []; continue; }
      m = /^\s*[-*]\s+(.+)$/.exec(line);
      if (m && cur) out[cur].push(m[1].trim());
    }
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v.length));
  }

  list() {
    return [...Object.entries(BUILTIN).filter(([k]) => k !== "голос")
      .map(([k, v]) => ({ name: k, title: k[0].toUpperCase() + k.slice(1), description: v, builtin: true })),
    ...Object.entries(this.custom()).map(([k, v]) => ({ name: k, title: k, description: v.join(" → "), builtin: false }))];
  }

  async run(name, depth = 0) {
    let key = name.toLowerCase().trim().replace(/^[«"']|[»"']$/g, "");
    key = ALIASES[key] || key;
    const custom = Object.fromEntries(Object.entries(this.custom()).map(([k, v]) => [k.toLowerCase(), [k, v]]));
    if (custom[key] && !BUILTIN[key]) return this.runCustom(...custom[key], depth);
    const handlers = { "утро": "morning", "фокус": "focus", "итоги": "evening", "неделя": "week", "диагностика": "diag",
      "чистый лист": "cleanSlate", "вечеринка": "party", "тишина": "silence", "голос": "unmute" };
    if (!handlers[key]) {
      const match = [...Object.keys(BUILTIN), ...Object.keys(custom)].find((k) => key && (k.includes(key) || key.includes(k)));
      if (match) return this.run(match, depth);
      return { text: `Протокол «${name}» не найден, ${this.j.title}. Свои протоколы описываются в ${this.path}.`, kind: "warn" };
    }
    this.j.emit("protocol", { name: key });
    const reply = await this[handlers[key]]();
    reply.source = "protocol";
    if (!["тишина", "голос"].includes(key)) await this.j.log(`Протокол «${key}»`);
    return reply;
  }

  async runCustom(title, steps, depth) {
    if (depth >= 2) return { text: "Протоколы слишком глубоко вложены — остановился.", kind: "warn" };
    this.j.emit("protocol", { name: title });
    const texts = [];
    for (const step of steps) texts.push((await this.j.handle(step, "protocol", depth + 1)).text);
    await this.j.log(`Протокол «${title}»: ${steps.length} шагов`);
    return { text: `Протокол «${title}» выполнен. ${texts.join(" ")}`, source: "protocol" };
  }

  async morning() {
    const j = this.j, n = j.now(), ref = j.today();
    const parts = [`${greeting(n.getHours())}, ${j.title}. Сейчас ${j.hhmm()}, ${WEEKDAYS[weekdayIndex(ref)]}, ${n.getDate()} ${MONTHS_GEN[n.getMonth()]}.`];
    const w = await j.briefing.weather();
    parts.push(Briefing.weatherPhrase(w));
    const today = j.tasks.view(ref, "today"), overdue = j.tasks.view(ref, "overdue");
    parts.push(today.length ? `На сегодня ${today.length} ${plural(today.length, "задача", "задачи", "задач")}: ${today.slice(0, 5).map((t) => t.text).join("; ")}.`
      : "На сегодня задач со сроком нет.");
    if (overdue.length) parts.push(`Просрочено: ${overdue.length}.`);
    const fin = j.actFinance();
    if (fin.expense || fin.income) {
      parts.push(`В этом месяце потрачено ${money(fin.expense, fin.currency)}${fin.budget_percent !== null ? ` — ${fin.budget_percent}% бюджета` : ""}.`);
    }
    try {
      const st = await j.actProjectStatus();
      parts.push(...st.filter((s) => s.github || s.health).map(projectLine));
    } catch { /* брифинг не должен падать из-за сети */ }
    const rates = Briefing.ratesPhrase(await j.briefing.rates());
    if (rates) parts.push(rates);
    const rem = j.memory.reminders().length;
    if (rem) parts.push(`Активных напоминаний: ${rem}.`);
    parts.push(`Хорошего дня, ${j.title}.`);
    return { text: parts.join(" "), data: { weather: w, finance: fin } };
  }

  async focus() {
    const j = this.j;
    const until = Date.now() / 1000 + FOCUS_MIN * 60;
    j.focusUntil = until;
    await j.memory.addReminder(`${FOCUS_MIN} минут фокуса позади, ${j.title}. Рекомендую перерыв на пять минут.`, new Date(until * 1000));
    j.emit("focus", { until, minutes: FOCUS_MIN });
    j.changed("reminders");
    const next = j.tasks.view(j.today(), "today");
    return { text: `Режим фокуса на ${FOCUS_MIN} минут. Уведомления приглушены.${next.length ? ` Предлагаю начать с «${next[0].text}».` : ""}`, kind: "ok" };
  }

  async evening() {
    const j = this.j, ref = j.today();
    const done = j.tasks.doneOn(ref), left = j.tasks.view(ref, "today");
    const entries = j.ledger.entries(ref.slice(0, 7)).filter((e) => e.date === ref);
    const spent = -entries.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0);
    const earned = entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
    const cur = j.settings.currency || "RUB";
    const lines = [`- Выполнено задач: ${done.length}${done.length ? ": " + done.map((t) => t.text).join("; ") : ""}`,
      `- Осталось на сегодня: ${left.length}${left.length ? ": " + left.map((t) => t.text).join("; ") : ""}`,
      `- Расходы: ${money(spent, cur)}; доходы: ${money(earned, cur)}`];
    await j.vault.appendToSection(j.memory.journalPath(ref), "Итоги дня", lines.join("\n"), { header: `# ${ref}\n\n` });
    j.changed("memory");
    const tomorrow = j.tasks.view(ref, "tomorrow");
    let text = `Итоги дня, ${j.title}: выполнено задач — ${done.length}, осталось — ${left.length}. Потрачено ${money(spent, cur)}.`;
    if (tomorrow.length) text += ` Завтра ждут ${tomorrow.length} ${plural(tomorrow.length, "задача", "задачи", "задач")}.`;
    return { text: text + " Записал в журнал.", data: { done: done.length, spent } };
  }

  async week() {
    const j = this.j, ref = j.today();
    const start = addDays(ref, -weekdayIndex(ref));
    const days = [];
    for (let d = start; d <= ref; d = addDays(d, 1)) days.push(d);
    const done = days.flatMap((d) => j.tasks.doneOn(d));
    const entries = [...new Set(days.map((d) => d.slice(0, 7)))].flatMap((m) => j.ledger.entries(m)).filter((e) => days.includes(e.date));
    const spent = -entries.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0);
    const byCat = {};
    for (const e of entries) if (e.amount < 0) byCat[e.category] = (byCat[e.category] || 0) - e.amount;
    const d = new Date(ref + "T12:00:00");
    const jan4 = new Date(d.getFullYear(), 0, 4);
    const wk = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
    const cur = j.settings.currency || "RUB";
    const path = `Journal/Week-${d.getFullYear()}-W${String(wk).padStart(2, "0")}.md`;
    const body = [`# Неделя ${wk}, ${d.getFullYear()}`, "", `Период: ${start} — ${ref}`, "", "## Сделано",
      ...(done.length ? done.map((t) => `- [x] ${t.text}`) : ["- пока ничего"]), "", "## Деньги", `- Расходы: ${money(spent, cur)}`,
      ...Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, v]) => `- ${c}: ${money(v, cur)}`), "",
      "## Открытые задачи", ...j.tasks.view(ref, "week").slice(0, 20).map((t) => `- [ ] ${t.text}`), "", "## Мысли и выводы", "- "];
    await j.vault.write(path, body.join("\n") + "\n");
    j.changed("memory");
    return { text: `Обзор недели готов: выполнено ${done.length} задач, расходы ${money(spent, cur)}. Заметка — ${path}.`, data: { path } };
  }

  async diag() {
    const j = this.j;
    const d = await j.diagnostics();
    const parts = ["Диагностика систем."];
    parts.push(`Память: ${d.notes} заметок, хранилище — ${d.store === "github" ? `GitHub ${j.settings.vaultRepo}` : "в браузере (демо)"}.`);
    if (d.github_rate) parts.push(`Запросов к GitHub осталось ${d.github_rate.remaining} из ${d.github_rate.limit}.`);
    parts.push(j.brain.available ? "Мозг Claude подключён." : "Мозг Claude не подключён — работаю на командах.");
    parts.push(`Голос: ${j.muted ? "выключен" : "включён"}.`);
    if (d.online === false) parts.push("Нет подключения к интернету.");
    const down = [];
    for (const p of j.projects.list()) {
      const h = await j.projects.checkHealth(p);
      if (h && !h.ok) down.push(p.name);
    }
    parts.push(down.length ? `Не отвечают: ${down.join(", ")}.` : "Сервисы проектов отвечают.");
    parts.push(down.length || d.online === false ? "Требуется внимание." : "Все системы в норме.");
    return { text: parts.join(" "), kind: down.length ? "warn" : "ok", data: d };
  }

  async cleanSlate() {
    const moved = await this.j.tasks.archiveDone(this.j.today());
    this.j.changed("tasks");
    return moved ? { text: `Протокол «Чистый лист»: перенёс ${moved} выполненных задач в архив.`, kind: "ok" }
      : { text: "Чистить нечего — входящие и так в порядке." };
  }

  async party() {
    const j = this.j;
    const st = await j.actProjectStatus();
    const deployable = st.filter((s) => s.deploy_workflow && s.repo).map((s) => s.name);
    const text = `Протокол «Вечеринка»: все проекты на связи. ${st.map(projectLine).join(" ")}`;
    if (!deployable.length) return { text: text + " Выкатывать нечего: ни у одного проекта нет deploy_workflow.", data: st };
    const item = j.askConfirm("deploy", `Выкатить проекты: ${deployable.join(", ")}`, { projects: deployable });
    return { text: `${text} Выкатить ${deployable.join(", ")}? Подтвердите.`, kind: "warn", confirm: item, data: st };
  }

  async silence() { this.j.muted = true; this.j.emit("voice", { muted: true }); return { text: "Перехожу в беззвучный режим.", speech: "" }; }
  async unmute() { this.j.muted = false; this.j.emit("voice", { muted: false }); return { text: `Снова на связи, ${this.j.title}.` }; }
}
