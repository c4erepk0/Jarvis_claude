// Мозг на iPhone: Claude через официальный JS SDK прямо из браузера (ключ хранится только на телефоне).
// Как и на сервере: история только дописывается, системный промпт и инструменты неизменны в разговоре,
// время — в начале сообщения, отказ модели не остаётся в истории, включён фолбэк fallbacks: "default".
import { WEEKDAYS, speechText } from "./ru.js";

export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const IDLE_RESET_MS = 30 * 60 * 1000;
const MAX_ROUNDS = 10;
const MAX_RESULT = 12000;
const S = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

export const TOOLS = [
  { name: "tasks_list", description: "Список открытых задач владельца из Obsidian.",
    input_schema: obj({ view: { type: "string", enum: ["today", "overdue", "week", "tomorrow", "nodate", "all"] },
      project: S }, ["view"]) },
  { name: "task_add", description: "Добавить задачу (в формате Obsidian Tasks).",
    input_schema: obj({ text: S, due: { ...S, description: "срок YYYY-MM-DD" },
      priority: { type: "string", enum: ["highest", "high", "medium", "low", "lowest"] }, project: S }, ["text"]) },
  { name: "task_complete", description: "Отметить задачу выполненной — по id из tasks_list или по тексту.",
    input_schema: obj({ task_id: S, query: S }) },
  { name: "money_add", description: "Записать расход (отрицательная сумма) или доход (положительная) в рублях.",
    input_schema: obj({ amount_rub: { type: "number" }, category: S, note: S, date: { ...S, description: "YYYY-MM-DD" } },
      ["amount_rub", "category", "note"]) },
  { name: "finance_report", description: "Сводка финансов за месяц: доходы, расходы, категории, бюджет, прогноз.",
    input_schema: obj({ month: { ...S, description: "YYYY-MM" } }) },
  { name: "memory_remember", description: "Сохранить устойчивый факт о владельце в долговременную память.",
    input_schema: obj({ fact: S }, ["fact"]) },
  { name: "memory_search", description: "Поиск по всем заметкам Obsidian.", input_schema: obj({ query: S }, ["query"]) },
  { name: "note_read", description: "Прочитать заметку Obsidian по пути.", input_schema: obj({ path: S }, ["path"]) },
  { name: "note_append", description: "Дописать текст в конец заметки (создаст её). Только .md.",
    input_schema: obj({ path: S, text: S }, ["path", "text"]) },
  { name: "notes_list", description: "Список заметок Obsidian (пути) — всех или в одной папке.",
    input_schema: obj({ folder: { ...S, description: "папка, например Projects; пусто — все заметки" } }) },
  { name: "note_show", description: "Открыть заметку на экране владельца — в голограмме (там её можно читать и править).",
    input_schema: obj({ path: { ...S, description: "путь или название заметки" } }, ["path"]) },
  { name: "note_create", description: "Создать новую заметку .md (если такая уже есть — ошибка).",
    input_schema: obj({ path: { ...S, description: "путь, например Ideas/Новая идея.md" }, text: S }, ["path", "text"]) },
  { name: "note_edit", description: "Точечно поправить заметку: заменить фрагмент find на replace. find — точная копия куска "
    + "из note_read, встречается в заметке ровно один раз; пустой replace — удалить фрагмент.",
    input_schema: obj({ path: S, find: S, replace: S }, ["path", "find", "replace"]) },
  { name: "journal_note", description: "Короткая запись в сегодняшнюю ежедневную заметку.",
    input_schema: obj({ text: S }, ["text"]) },
  { name: "reminder_add", description: "Напоминание через N минут (голосом и в Telegram).",
    input_schema: obj({ text: S, minutes: { type: "integer", minimum: 1 } }, ["text", "minutes"]) },
  { name: "projects_status", description: "Живой статус проектов: CI, PR, задачи GitHub, health, метрики.",
    input_schema: obj({ project: S }) },
  { name: "project_delegate", description: "Поручить работу над кодом проекта: задача для @claude в репозитории "
    + "(он откроет PR). Требует подтверждения владельца.",
    input_schema: obj({ project: S, task: { ...S, description: "подробное техзадание" } }, ["project", "task"]) },
  { name: "project_deploy", description: "Запустить деплой проекта (GitHub Actions). Требует подтверждения.",
    input_schema: obj({ project: S }, ["project"]) },
  { name: "run_protocol", description: "Запустить протокол (утро, фокус, итоги, неделя, диагностика, чистый лист, "
    + "вечеринка или свой из Obsidian).", input_schema: obj({ name: S }, ["name"]) },
  { name: "weather_and_rates", description: "Текущая погода в городе владельца и курсы ЦБ.", input_schema: obj({}) },
];

const PERSONA = `Ты — J.A.R.V.I.S., личный ИИ-ассистент владельца. Обращайся к нему «{title}»{name}.
Манера: безупречно вежливый британский дворецкий с суховатым юмором — спокойный, точный, немногословный, заботливый без подобострастия.
Ответы звучат голосом на iPhone: обычно 1–3 коротких предложения, без markdown, таблиц, списков и эмодзи, если владелец сам не попросил подробностей. Отвечай на языке владельца (обычно русский).

Твоя долговременная память — хранилище Obsidian:
- Jarvis/Memory.md — факты о владельце, Jarvis/Profile.md — его профиль;
- Tasks/Inbox.md — входящие задачи (формат Obsidian Tasks, задачи бывают и в других заметках);
- Projects/ — проекты; Finance/ — финансы по месяцам; Journal/ — ежедневные заметки.
Правила:
- Узнал устойчивое о владельце (предпочтения, планы, решения, важных людей) — сохрани через memory_remember, не спрашивая. Вопросы о прошлом и о заметках — сначала memory_search.
- Задачи, деньги, статусы проектов бери только из инструментов, ничего не выдумывай.
- Деньги — в рублях; расход — отрицательная сумма. Категории: Еда, Кафе, Транспорт, Подписки, Связь, Дом, Здоровье, Спорт, Развлечения, Одежда, Образование, Бизнес, Подарки, Доход, Прочее.
- Работа над кодом — через project_delegate с ясным техзаданием. Внешние действия ждут подтверждения владельца — так и скажи.
- Заметки: показать владельцу — note_show (откроется в голограмме); найти — memory_search или notes_list; поправить — note_read, затем note_edit точным фрагментом; дописать — note_append; новая — note_create. Заметки правит и сам владелец в Obsidian — не переписывай их целиком без просьбы.
- Каждое сообщение владельца начинается со служебной строки в квадратных скобках: дата, время, источник; если там указана открытая в голограмме заметка — «эта заметка», «здесь» означают её.

Профиль владельца:
{profile}

Что ты помнишь о владельце:
{facts}

Проекты: {projects}`;

export class Brain {
  constructor(jarvis, clientFactory) {
    this.j = jarvis;
    this.clientFactory = clientFactory;   // () => Promise<Anthropic>
    this.client = null;
    this.messages = [];
    this.system = null;
    this.turns = 0;
    this.last = 0;
    this.notes = [];
    this.busy = Promise.resolve();
  }

  get available() { return Boolean(this.j.settings.anthropicKey) || Boolean(this.clientFactory && this.clientFactory.fake); }

  note(text) { this.notes.push(text); }

  tools() {
    return this.j.settings.webSearch === false ? TOOLS
      : [...TOOLS, { type: "web_search_20260209", name: "web_search", max_uses: 3 }];
  }

  buildSystem() {
    const st = this.j.settings;
    return PERSONA.replace("{title}", st.title || "сэр").replace("{name}", st.name ? ` (имя — ${st.name})` : "")
      .replace("{profile}", this.j.memory.profile().slice(0, 4000) || "(пусто)")
      .replace("{facts}", this.j.memory.facts().slice(-60).map((f) => `- ${f.text}`).join("\n") || "(пока ничего)")
      .replace("{projects}", this.j.projects.list().map((p) => p.name + (p.repo ? ` (repo ${p.repo})` : "")).join(", ") || "нет");
  }

  header(source, note = null) {
    const n = this.j.now();
    let h = `[${this.j.today()} ${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}, `
      + `${WEEKDAYS[(n.getDay() + 6) % 7]}; источник: ${source}]`;
    if (note) h += `\n[В голограмме открыта заметка: ${note}]`;
    if (this.notes.length) { h += `\n[Служебно: ${this.notes.join(" ")}]`; this.notes = []; }
    return h;
  }

  summary() {
    const said = this.messages.filter((m) => m.role === "user" && typeof m.content === "string")
      .map((m) => m.content.split("\n").slice(1).join(" ").slice(0, 200));
    return said.length ? `Ранее в разговоре владелец говорил: ${said.slice(-8).join(" | ")}` : "";
  }

  ask(text, source = "iphone", note = null) {
    const run = this.busy.then(async () => {
      if (this.messages.length && (Date.now() - this.last > IDLE_RESET_MS || this.turns >= 40)) {
        const s = this.summary();
        this.messages = []; this.system = null; this.turns = 0;
        if (s) this.notes.unshift(s);
      }
      if (!this.system) this.system = this.buildSystem();
      this.last = Date.now();
      this.messages.push({ role: "user", content: `${this.header(source, note)}\n${text}` });
      this.turns++;
      return this.run(this.messages, this.system);
    });
    this.busy = run.catch(() => {});
    return run;
  }

  analyzeImage(base64, mediaType, hint = "") {
    const task = hint.trim() || "Посмотри на изображение. Если это чек или квитанция — запиши расходы через money_add. "
      + "Если это документ или скриншот с делами — добавь важные задачи. Коротко доложи, что сделал.";
    const msgs = [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
      { type: "text", text: `${this.header("камера")}\n${task}` }] }];
    return this.run(msgs, this.system || this.buildSystem());
  }

  async run(messages, system) {
    if (!this.client) this.client = await this.clientFactory();
    const start = messages.length;
    let confirm = null;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let resp;
      try {
        resp = await this.client.beta.messages.create({
          model: this.j.settings.model || "claude-opus-5-5",
          max_tokens: 16000,
          system,
          tools: this.tools(),
          messages,
          output_config: { effort: this.j.settings.effort || "low" },
          cache_control: { type: "ephemeral" },
          betas: [FALLBACK_BETA],
          fallbacks: "default",
        });
      } catch (e) {
        messages.splice(start - 1);
        const status = e && e.status;
        if (status === 401) return { text: `Ключ Claude API недействителен, ${this.j.title}. Проверьте его в настройках.`, kind: "error", source: "system" };
        if (status === 429) return { text: "Claude просит передышку — лимит запросов. Попробуйте через минуту.", kind: "warn", source: "system" };
        if (!status) return { text: "Нет связи с Claude. Команды без интернета по-прежнему работают.", kind: "warn", source: "system" };
        return { text: `Claude ответил ошибкой ${status}.`, kind: "error", source: "system" };
      }
      if (resp.stop_reason === "refusal") {
        messages.splice(start - 1);
        return { text: `Боюсь, с этим я помочь не могу, ${this.j.title}.`, kind: "warn", source: "claude" };
      }
      messages.push({ role: "assistant", content: resp.content });
      if (resp.stop_reason === "pause_turn") continue;
      const calls = resp.content.filter((b) => b.type === "tool_use");
      if (resp.stop_reason !== "tool_use" || !calls.length) {
        const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
        const out = text || `Готово, ${this.j.title}.`;
        return { text: out, speech: speechText(out), kind: "info", source: "claude", confirm };
      }
      const results = [];
      for (const call of calls) {
        const [content, isError, pending] = await this.tool(call.name, call.input || {});
        if (pending) confirm = pending;
        results.push({ type: "tool_result", tool_use_id: call.id, content, ...(isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
    }
    return { text: "Слишком много шагов для одной просьбы — остановился. Уточните задачу.", kind: "warn", source: "claude", confirm };
  }

  async tool(name, a) {
    const j = this.j;
    j.emit("tool", { name, args: a });
    let pending = null, res;
    try {
      if (typeof a !== "object" || a === null) throw new Error("аргументы должны быть объектом");
      const need = (k) => { if (a[k] === undefined || a[k] === null || a[k] === "") throw new Error(`не хватает параметра ${k}`); return a[k]; };
      switch (name) {
        case "tasks_list": res = j.actListTasks(a.view || "today", a.project || null); break;
        case "task_add": res = await j.actAddTask(String(need("text")), a.due || null, a.priority || null, a.project || null); break;
        case "task_complete": res = await j.actCompleteTask(a.task_id || null, a.query || null); break;
        case "money_add": res = await j.actMoney(Math.round(Number(need("amount_rub")) * 100), String(a.category || "Прочее"),
          String(a.note || ""), a.date || null); break;
        case "finance_report": res = j.actFinance(a.month || null); break;
        case "memory_remember": res = await j.actRemember(String(need("fact"))); break;
        case "memory_search": res = j.vault.search(String(need("query")), 8); break;
        case "note_read": {
          let path = String(need("path"));
          if (!j.vault.exists(path)) path = j.vault.findNote(path) || path;   // можно и по названию
          const text = j.vault.read(path);
          res = { path, content: text.slice(0, MAX_RESULT), truncated: text.length > MAX_RESULT };
          break;
        }
        case "notes_list": {
          const files = j.vault.list(String(a.folder || "").replace(/^\/+|\/+$/g, ""), [".md", ".txt"]);
          res = { count: files.length, notes: files.slice(0, 300), truncated: files.length > 300 };
          break;
        }
        case "note_show": res = j.actOpenNote(String(need("path"))); break;
        case "note_create": res = await j.actSaveNote(String(need("path")), String(need("text")), null); break;
        case "note_edit": res = await j.actEditNote(String(need("path")), String(need("find")), String(a.replace ?? "")); break;
        case "note_append": {
          const path = String(need("path"));
          if (!path.endsWith(".md")) throw new Error("дописывать можно только .md заметки");
          await j.vault.append(path, String(need("text")));
          j.changed("memory");
          res = { ok: true, path };
          break;
        }
        case "journal_note": res = await j.actNote(String(need("text"))); break;
        case "reminder_add": res = await j.actReminder(String(need("text")), Number(need("minutes")) * 60); break;
        case "projects_status": res = await j.actProjectStatus(a.project || null); break;
        case "project_delegate": {
          const item = j.actDelegate(String(need("project")), String(need("task")));
          pending = item;
          res = { status: "awaiting_confirmation", action_id: item.id, title: item.title,
            note: "Скажи владельцу, что действие ждёт подтверждения (кнопка или «подтверждаю»)." };
          break;
        }
        case "project_deploy": {
          const item = j.actDeploy(String(need("project")));
          pending = item;
          res = { status: "awaiting_confirmation", action_id: item.id, title: item.title };
          break;
        }
        case "run_protocol": {
          const r = await j.protocols.run(String(need("name")), 1);
          if (r.confirm) pending = r.confirm;
          res = { result: r.text };
          break;
        }
        case "weather_and_rates": res = { weather: await j.briefing.weather(), rates: await j.briefing.rates() }; break;
        default: return [`неизвестный инструмент ${name}`, true, null];
      }
    } catch (e) {
      return [`ошибка: ${e.message}`, true, null];
    }
    let out = JSON.stringify(res ?? null);
    if (out.length > MAX_RESULT) out = out.slice(0, MAX_RESULT) + "…(обрезано)";
    return [out, false, pending];
  }
}
