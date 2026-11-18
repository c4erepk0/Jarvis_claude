// Ядро Atom, которое целиком работает в Safari на iPhone — без сервера.
// Отвечает на те же запросы /api/…, что и Python-сервер, поэтому интерфейс (app.js) один на оба режима.
import { MONTHS_GEN, WEEKDAYS, greeting, humanDate, isoDay, money, plural, weekdayIndex } from "./ru.js";
import { parse } from "./intents.js";
import { Vault, VaultError, checkPath, contentVersion } from "./vault.js";
import { TaskBook } from "./tasks.js";
import { Ledger, analytics, guessCategory } from "./finance.js";
import { Portfolio, Quotes, assetsPhrase } from "./assets.js";
import { catalog, setInCatalog } from "./apps.js";
import { Memory, hhmm } from "./memory.js";
import { Projects, STATUSES, projectLine } from "./projects.js";
import { Notes, noteTags } from "./notes.js";
import { Briefing } from "./briefing.js";
import { Brain } from "./brain.js";
import { Protocols } from "./protocols.js";
import { description as synthesisDescription, synthesize } from "./synthesis.js";

const NOTE_LIMIT = 200000;   // больше — показываем, но не даём править (чтобы не обрезать заметку при сохранении)
const ACKS = ["Слушаюсь, {t}.", "Сделано, {t}.", "Готово, {t}.", "Как скажете, {t}.", "Будет исполнено, {t}."];
export const HELP = `Вот что я умею, {t}:
• «Атом, доброе утро» — брифинг: погода, задачи, финансы, проекты, курс.
• «Добавь задачу написать оферту для IPAStore в пятницу, срочно» · «задачи на сегодня» · «выполнил …».
• «Потратил 450 на кофе» · «получил 50 000 зарплата» · «сколько я потратил в этом месяце».
• «Напомни через 20 минут позвонить» · «запомни, что …» · «найди в заметках …» · «заметка: …».
• «Открой заметку IPAStore» — покажу её в голограмме; там же её можно поправить.
• «Открой хранилище» — заметки и проекты: папки, теги, шаблоны, корзина.
• «Создай проект Кофейня» · «открой проект IPAStore» — страница проекта: задачи, прогресс, заметки.
• «Синтез проектов» — найду в хранилище заметки проектов и то, что похоже на новый проект, и подсвечу их.
• «Статус проектов» · «поручи IPAStore: добавить экспорт в CSV» (задача для @claude) · «задеплой IPAStore».
• Протоколы: Утро, Фокус, Итоги дня, Неделя, Диагностика, Чистый лист, Вечеринка, Тишина и ваши из Obsidian.
• С ключом Claude — свободный разговор, поиск в интернете и разбор фото чеков.`;

export class Jarvis {
  constructor(settings, { store, github = null, clientFactory = null, fetchImpl = (...a) => fetch(...a), clock = () => new Date() }) {
    this.settings = settings;
    this.clock = clock;
    this.vault = new Vault(store);
    this.tasks = new TaskBook(this.vault, "Tasks/Inbox.md", ["Jarvis/Conversations/"]);
    this.ledger = new Ledger(this.vault, "Finance", settings.currency || "RUB");
    this.memory = new Memory(this.vault);
    this.notes = new Notes(this.vault);
    this.github = github;
    this.projects = new Projects(this.vault, "Projects", github, { fetchImpl,
      statsToken: (p) => (settings.statsTokens || {})[p.name] || "" });
    this.portfolio = new Portfolio(this.vault, "Finance", settings.currency || "RUB", this.projects);
    this.quotes = new Quotes(fetchImpl);
    this.briefing = new Briefing(settings, fetchImpl);
    this.brain = new Brain(this, clientFactory);
    this.protocols = new Protocols(this);
    this.pending = new Map();
    this.listeners = new Set();
    this.events = [];
    this.focusUntil = null;
    this.muted = false;
    this.lastPoll = 0;
    this.vault.onChange(async (paths) => {
      this.emit("vault", { paths: paths.slice(0, 50), count: paths.length });
      this.changed("all");
    });
  }

  async init() { await this.vault.load(); return this; }

  // ---------- время ----------
  now() { return this.clock(); }
  today() { return isoDay(this.now()); }
  hhmm() { return hhmm(this.now()); }
  get title() { return this.settings.title || "сэр"; }
  ack() { return ACKS[Math.floor(Math.random() * ACKS.length)].replace("{t}", this.title); }
  projectNames() { return this.projects.list().map((p) => p.name); }

  // ---------- события ----------
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, data, keep = false) {
    const e = { type, data, ts: Date.now() / 1000 };
    if (keep) { this.events.push(e); this.events = this.events.slice(-150); }
    for (const fn of this.listeners) { try { fn(e); } catch { /* слушатель не должен ронять ядро */ } }
  }
  changed(what) { this.emit("refresh", { what }); }
  async log(text, journal = true) {
    this.emit("log", { text }, true);
    if (journal) await this.memory.logEvent(text, this.today(), this.hhmm()).catch(() => {});
  }
  async alert(text, level = "warn", speak = true) {
    this.emit("alert", { text, level, speak }, true);
    await this.memory.logEvent(`⚠ ${text}`, this.today(), this.hhmm()).catch(() => {});
  }

  // ---------- подтверждения ----------
  askConfirm(kind, title, params) {
    const item = { id: Math.random().toString(16).slice(2, 10), kind, title, params, created: Date.now() / 1000 };
    this.pending.set(item.id, item);
    return item;
  }
  latestPending() {
    const fresh = [...this.pending.values()].filter((p) => Date.now() / 1000 - p.created < 600);
    return fresh.sort((a, b) => b.created - a.created)[0] || null;
  }
  async confirm(id) {
    const item = this.pending.get(id);
    if (!item) return { text: "Нет такого ожидающего действия — возможно, оно уже выполнено.", kind: "warn" };
    this.pending.delete(id);
    try {
      const r = await this.execute(item);
      this.brain.note(`Владелец подтвердил действие «${item.title}», результат: ${r.text}`);
      return r;
    } catch (e) {
      await this.log(`Не удалось выполнить «${item.title}»: ${e.message}`);
      this.brain.note(`Действие «${item.title}» подтверждено, но не выполнено: ${e.message}.`);
      return { text: `Не получилось, ${this.title}: ${e.message}`, kind: "error" };
    }
  }
  async cancel(id) {
    const had = this.pending.delete(id);
    return { text: had ? "Отменено." : "Отменять нечего.", kind: "info" };
  }
  async execute(item) {
    const stamp = `${this.today()} ${this.hhmm()}`;
    if (item.kind === "delegate_github") {
      const p = this.project(item.params.project);
      const issue = await this.projects.delegateGithub(p, item.params.task, stamp);
      await this.log(`Задача для @claude в ${p.name}: #${issue.number}`);
      this.changed("projects");
      return { text: `Задача #${issue.number} создана в ${p.repo}. Claude возьмёт её в работу и откроет PR.`,
        speech: `Передал задачу Claude в ${p.name}.`, kind: "ok", data: issue };
    }
    if (item.kind === "deploy") {
      const names = item.params.projects || [item.params.project];
      for (const n of names) await this.projects.deploy(this.project(n), stamp);
      await this.log(`Деплой запущен: ${names.join(", ")}`);
      this.changed("projects");
      return { text: `Деплой запущен: ${names.join(", ")}. Слежу за GitHub Actions.`, kind: "ok" };
    }
    if (item.kind === "trash") {
      const r = await this.actTrashNote(item.params.path);
      return { text: `Заметка «${item.params.path.split("/").pop().replace(/\.[^.]+$/, "")}» — в корзине Obsidian (${r.trash}).`, kind: "ok" };
    }
    if (item.kind === "forget") {
      const n = await this.memory.forget(item.params.query);
      this.changed("memory");
      return { text: n ? `Забыл: удалено фактов — ${n}.` : "Таких фактов в памяти нет.", kind: "ok" };
    }
    return { text: "Неизвестное действие.", kind: "error" };
  }
  project(name) {
    const p = this.projects.get(name);
    if (!p) throw new Error(`проект «${name}» не найден в Projects/`);
    return p;
  }

  // ---------- действия ----------
  // toNote — записать задачу в раздел «Задачи» заметки проекта, а не во входящие
  async actAddTask(text, due = null, priority = null, project = null, toNote = false) {
    let tags = [], note = null;
    if (project) {
      const p = this.projects.get(project);
      tags = [p ? p.tag : project.toLowerCase()];
      if (p && toNote) note = p.note;
    }
    const t = await this.tasks.add(text, this.today(), { due, priority, tags, note });
    await this.log(`Новая задача: ${t.text}`);
    this.changed("tasks");
    return t;
  }
  async actCompleteTask(id = null, query = null) {
    if (!id && query) {
      const found = this.tasks.find(query);
      if (!found.length) throw new Error(`не нашёл открытую задачу «${query}»`);
      if (found.length > 1) return { ambiguous: found.slice(0, 5) };
      id = found[0].id;
    }
    if (!id) throw new Error("какую задачу отметить?");
    const t = await this.tasks.setStatus(id, "done", this.today());
    await this.log(`Выполнено: ${t.text}`);
    this.changed("tasks");
    return t;
  }
  actListTasks(view = "today", project = null) {
    let tag = null;
    if (project) { const p = this.projects.get(project); tag = p ? p.tag : project; }
    const v = ["today", "overdue", "week", "nodate", "all", "tomorrow"].includes(view) ? view : "today";
    return this.tasks.view(this.today(), v, tag);
  }
  async actMoney(amount, category, note = "", day = null, account = "") {
    const d = day || this.today();
    const e = await this.ledger.add(Math.trunc(amount), category || "Прочее", note, d, account);
    await this.log(`${amount > 0 ? "Доход" : "Расход"}: ${money(e.amount, this.ledger.currency, true)} · ${e.category} · ${note}`);
    this.changed("finance");
    if (amount < 0) {
      const warn = this.ledger.budgetAlert(e.category, d.slice(0, 7));
      if (warn) { e.budget_alert = warn; await this.alert(warn, "warn", false); }
    }
    return e;
  }
  actFinance(month = null) { return this.ledger.summary(month || this.today().slice(0, 7), this.today()); }
  actFinanceAnalytics(months = 6) { return analytics(this.ledger, this.today(), months); }
  /** Активы и долги с котировками; record — строка дня в Finance/Capital.md (динамика капитала). */
  async actAssets(record = true) {
    const [assets, debts] = this.portfolio.read();
    const quotes = await this.quotes.get(assets);
    const report = this.portfolio.valuate(assets, debts, quotes, this.today());
    report.history = record ? await this.portfolio.record(this.today(), report) : this.portfolio.history();
    return report;
  }
  async actAssetAdd(action, data) {
    const kop = (v) => {
      const n = Number(String(v ?? "0").replace(/\s/g, "").replace(",", ".").replace("−", "-"));
      if (!Number.isFinite(n)) throw new Error("сумма должна быть числом");
      return Math.round(n * 100);
    };
    let res;
    if (action === "init") { const path = await this.portfolio.init(); this.changed("finance"); return { path }; }
    if (action === "debt") {
      res = await this.portfolio.addDebt(String(data.name || ""), kop(data.amount), String(data.due || ""), String(data.note || ""));
      await this.log(`Долг записан: ${res.name} — ${money(res.amount, this.ledger.currency)}`);
    } else {
      const qty = Number(String(data.qty || "1").replace(",", ".").replace(/\s/g, ""));
      if (!Number.isFinite(qty)) throw new Error("количество должно быть числом");
      res = await this.portfolio.addAsset(String(data.name || ""), String(data.kind || ""), qty, kop(data.buy),
        String(data.ticker || ""), String(data.date || ""), data.price === undefined || data.price === null || data.price === "" ? null : kop(data.price));
      await this.log(`Актив записан: ${res.name}`);
    }
    this.changed("finance");
    return res;
  }
  async actRemember(fact) {
    const r = await this.memory.remember(fact, this.today());
    if (!r.duplicate) { await this.log(`Запомнил: ${r.text}`, false); this.changed("memory"); }
    return r;
  }
  // ---------- заметки в голограмме ----------
  actReadNote(path) {
    const text = this.vault.read(path);
    const rel = checkPath(path);
    return { path: rel, title: rel.split("/").pop().replace(/\.[^.]+$/, ""), content: text.slice(0, NOTE_LIMIT),
      version: contentVersion(text), truncated: text.length > NOTE_LIMIT,
      editable: text.length <= NOTE_LIMIT && /\.(md|txt)$/i.test(rel),
      tags: noteTags(text), backlinks: this.notes.backlinks(rel) };
  }
  actOpenNote(query) {
    const path = this.vault.findNote(query);
    if (!path) throw new Error(`не нашёл заметку «${query}»`);
    this.emit("open_note", { path });
    return { path, title: path.split("/").pop().replace(/\.[^.]+$/, "") };
  }
  async actSaveNote(path, text, base) {
    path = String(path || "").trim();
    if (path && !/\.[^/.]+$/.test(path)) path += ".md";
    if (!/\.(md|txt)$/i.test(path)) throw new VaultError("в голограмме правятся только заметки .md и .txt");
    const rel = await this.vault.save(path, String(text).replace(/\r\n/g, "\n"), base ?? null);
    await this.log(`Заметка «${rel.split("/").pop().replace(/\.[^.]+$/, "")}» ${base ? "изменена" : "создана"} в голограмме`, false);
    this.changed("notes");
    return { path: rel, version: contentVersion(this.vault.read(rel)) };
  }
  async actEditNote(path, find, replace) {
    const text = this.vault.read(path);
    const count = find ? text.split(find).length - 1 : 0;
    if (count !== 1) {
      throw new Error(!count ? "фрагмент не найден — сначала прочитай заметку (note_read)"
        : `фрагмент встречается ${count} раз — возьми фрагмент длиннее, чтобы он был единственным`);
    }
    return this.actSaveNote(path, text.replace(find, () => replace), contentVersion(text));
  }

  // ---------- менеджер заметок ----------
  actFiles() { return this.notes.index(); }
  async actCreateNote(path, template = null, content = null) {
    const rel = await this.notes.create(path, { template, now: this.now(), content });
    await this.log(`Новая заметка «${rel.split("/").pop().replace(/\.[^.]+$/, "")}»`, false);
    this.changed("notes");
    return { path: rel, version: contentVersion(this.vault.read(rel)) };
  }
  async actMkdir(path) { const rel = this.notes.mkdir(path); this.changed("notes"); return { path: rel }; }
  async actMoveNote(src, dst) {
    const r = await this.notes.move(src, dst);
    if (r.moved) await this.log(`«${src}» → «${r.path}»${r.updated.length ? `, ссылки поправлены в ${r.updated.length} заметках` : ""}`, false);
    this.changed("notes");
    return r;
  }
  async actTrashNote(path) {
    const r = await this.notes.trash(path);
    await this.log(`В корзину: «${path}»`, false);
    this.changed("notes");
    return r;
  }
  askTrash(path) {
    const rel = this.vault.exists(path) || this.vault.isDir(path) ? path : this.vault.findNote(path);
    if (!rel) throw new Error(`не нашёл заметку «${path}»`);
    return this.askConfirm("trash", `Переместить «${rel}» в корзину`, { path: rel });
  }

  // ---------- проекты: создание, статус, страница ----------
  async actProjectCreate(name, description = "", repo = "", tag = "", status = "active") {
    const p = await this.projects.create(name, `${this.today()} ${this.hhmm()}`, { description, repo, tag, status });
    await this.log(`Новый проект: ${p.name}`);
    this.changed("projects");
    this.changed("notes");
    return p;
  }
  async actProjectUpdate(name, key, value) {
    const p = await this.projects.setField(this.project(name), key, value);
    if (key === "status") await this.projects.log(p, `Статус: ${STATUSES[value] || value}`, `${this.today()} ${this.hhmm()}`);
    this.changed("projects");
    return p;
  }
  actProjectOverview(name) {
    const p = this.project(name);
    const linked = this.notes.backlinks(p.note);
    for (const o of this.notes.outlinks(p.note)) if (!linked.some((x) => x.path === o.path)) linked.push(o);   // «Материалы»
    return this.projects.overview(p, this.tasks.all(), this.notes.index().files, linked);
  }

  // ---------- синтез проектов (core/synthesis.js) ----------
  actSynthesis() {
    const tasks = this.tasks.all().map((t) => ({ path: t.path, tags: t.tags, open: t.status === "todo" || t.status === "doing" }));
    return synthesize(this.notes.index().files, this.projects.list(), tasks, { projectsDir: this.projects.folder });
  }
  async actSynthesisCreate(name, status = "idea") {
    const k = String(name || "").toLowerCase().trim();
    const cands = this.actSynthesis().candidates;
    const c = cands.find((x) => x.name.toLowerCase() === k || x.tag === k) || cands.find((x) => k && x.name.toLowerCase().includes(k));
    if (!c) throw new VaultError(`в синтезе нет кандидата «${name}»`);
    return this.actProjectCreate(c.name, synthesisDescription(c), "", c.tag, status);
  }
  synthesisReply() {
    const syn = this.actSynthesis(), t = this.title;
    const linked = syn.projects.reduce((n, p) => n + p.notes.length, 0);
    const head = `Проектов: ${syn.projects.length}, заметок при них: ${linked}.`;
    if (!syn.candidates.length) return { text: `${head} Новых проектов в хранилище не вижу, ${t}.`, data: syn };
    const names = syn.candidates.slice(0, 4).map((c) => `${c.name} (${c.notes.length} ${plural(c.notes.length, "заметка", "заметки", "заметок")})`).join(", ");
    return { text: `${head} Похоже на проекты: ${names}. Подсветил их в хранилище.`, kind: "ok", data: syn };
  }

  async actNote(text) {
    const path = this.memory.journalPath(this.today());
    await this.vault.appendToSection(path, "Заметки", `- ${this.hhmm()} ${text.trim()}`, { header: `# ${this.today()}\n\n` });
    this.changed("memory");
    return { path };
  }
  async actReminder(text, seconds) {
    const at = new Date(this.now().getTime() + Math.max(5, seconds) * 1000);
    const r = await this.memory.addReminder(text, at);
    this.changed("reminders");
    return { ...r, in_minutes: Math.round(seconds / 60) };
  }
  async actProjectStatus(name = null) {
    return name ? [await this.projects.status(this.project(name))] : this.projects.statusAll();
  }
  actDelegate(project, task) {
    const p = this.project(project);
    if (!p.repo) throw new Error(`у проекта ${p.name} не указан repo`);
    if (!this.github || !this.settings.githubToken) throw new Error("нужен токен GitHub (Настройки)");
    return this.askConfirm("delegate_github", `Задача для @claude в ${p.repo}: ${task}`, { project: p.name, task });
  }
  actDeploy(project) {
    const p = this.project(project);
    if (!p.deploy_workflow) throw new Error(`у проекта ${p.name} не задан deploy_workflow`);
    return this.askConfirm("deploy", `Деплой ${p.name} (${p.deploy_workflow})`, { project: p.name });
  }

  // ---------- главный вход ----------
  // note — заметка, открытая сейчас в голограмме: «эта заметка» в просьбе — она.
  async handle(text, source = "iphone", depth = 0, note = null) {
    text = String(text || "").trim();
    if (!text) return { text: `Слушаю вас, ${this.title}.` };
    const it = parse(text, this.today(), this.projectNames(), this.settings.wakeWord || "атом");
    let reply = null;
    try {
      if (it && (it.name === "confirm" || it.name === "cancel")) {
        const p = this.latestPending();
        if (p) reply = await (it.name === "confirm" ? this.confirm(p.id) : this.cancel(p.id));
        else if (!this.brain.available) reply = { text: `Подтверждать нечего, ${this.title}.` };
      } else if (it) {
        reply = await this.runIntent(it, depth);
      }
    } catch (e) {
      reply = { text: `Не вышло, ${this.title}: ${e.message}`, kind: "error" };
    }
    if (!reply) {
      reply = this.brain.available ? await this.brain.ask(text, source, note)
        : { text: `Без ключа Claude я понимаю только команды, ${this.title}. Скажите «что ты умеешь» — перечислю. Ключ добавляется в настройках (⚙).`, kind: "warn" };
    }
    reply.kind = reply.kind || "info";
    reply.source = reply.source || "local";
    if (depth === 0 && source !== "protocol") {
      await this.memory.logDialog(text, reply.text, this.today(), this.hhmm(), source).catch(() => {});
    }
    return reply;
  }

  async runIntent(it, depth) {
    const a = it.args, t = this.title;
    switch (it.name) {
      case "greet": return { text: `${greeting(this.now().getHours())}, ${t}. Все системы в норме. Чем могу помочь?` };
      case "help": return { text: HELP.replace("{t}", t), speech: `Я веду ваши задачи, финансы, проекты и память в Obsidian, ${t}. Список команд — на экране.` };
      case "time": {
        const n = this.now();
        return { text: `Сейчас ${this.hhmm()}, ${WEEKDAYS[weekdayIndex(this.today())]}, ${n.getDate()} ${MONTHS_GEN[n.getMonth()]}.` };
      }
      case "weather": { const w = await this.briefing.weather(); return { text: Briefing.weatherPhrase(w), data: w }; }
      case "currency": { const r = await this.briefing.rates(); return { text: Briefing.ratesPhrase(r) || "Курсы сейчас недоступны.", data: r }; }
      case "protocol": return this.protocols.run(a.name, depth);
      case "task_add": {
        if (!a.text) return { text: `Что записать в задачу, ${t}?`, kind: "warn" };
        const task = await this.actAddTask(a.text, a.due, a.priority, a.project);
        return { text: `${this.ack()} Задача «${task.text}» добавлена${task.due ? ` на ${humanDate(task.due, this.today())}` : ""}.`, kind: "ok", data: task };
      }
      case "task_done": {
        const r = await this.actCompleteTask(null, a.query);
        if (r.ambiguous) return { text: `Нашёл несколько задач: ${r.ambiguous.map((x) => x.text).join("; ")}. Уточните, какую закрыть.`, kind: "warn" };
        return { text: `Отметил выполненной: «${r.text}». Отличная работа, ${t}.`, kind: "ok", data: r };
      }
      case "tasks_list": return this.tasksReply(a.view, a.project);
      case "expense": case "income": {
        const r = await this.actMoney(a.amount, a.category, a.note);
        let s = `${this.ack()} Записал ${it.name === "income" ? "доход" : "расход"} ${money(Math.abs(r.amount), this.ledger.currency)} — ${r.category}.`;
        if (r.budget_alert) s += " " + r.budget_alert;
        return { text: s, kind: r.budget_alert ? "warn" : "ok", data: r };
      }
      case "finance_report": return this.financeReply(a.period);
      case "finance_analytics": return this.analyticsReply();
      case "assets_report": { const r = await this.actAssets(); return { text: assetsPhrase(r, t, this.ledger.currency), data: r }; }
      case "remember": {
        const r = await this.actRemember(a.fact);
        return r.duplicate ? { text: `Я это уже помню, ${t}.` } : { text: `Запомнил, ${t}.`, kind: "ok", data: r };
      }
      case "forget": {
        const item = this.askConfirm("forget", `Удалить из памяти факты про «${a.query}»`, { query: a.query });
        return { text: `Удалить из памяти всё про «${a.query}»? Подтвердите.`, kind: "warn", confirm: item };
      }
      case "note_open": {
        const r = this.actOpenNote(a.query);
        return { text: `Открываю «${r.title}» в голограмме, ${t}.`, kind: "ok", data: { open_note: r.path } };
      }
      case "files": this.emit("open_files", {}); return { text: `Открываю хранилище, ${t}.`, kind: "ok", data: { open_files: true } };
      case "note_delete": {
        const item = this.askTrash(a.query);
        return { text: `${item.title}? Подтвердите.`, kind: "warn", confirm: item };
      }
      case "project_create": {
        const p = await this.actProjectCreate(a.name);
        this.emit("open_project", { name: p.name });
        return { text: `Проект «${p.name}» создан, ${t}. Заметка — ${p.note}.`, kind: "ok", data: p };
      }
      case "project_open": {
        const p = this.project(a.project);
        this.emit("open_project", { name: p.name });
        return { text: `Открываю проект ${p.name}, ${t}.`, kind: "ok", data: { open_project: p.name } };
      }
      case "recall": return this.recallReply(a.query);
      case "note": { const r = await this.actNote(a.text); return { text: `Записал в журнал, ${t}.`, kind: "ok", data: r }; }
      case "reminder": {
        const r = await this.actReminder(a.text, a.seconds);
        const m = Math.max(1, r.in_minutes);
        return { text: `Напомню через ${m} ${plural(m, "минуту", "минуты", "минут")}: «${r.text}».`, kind: "ok", data: r };
      }
      case "synthesis": this.emit("open_synthesis", {}); return this.synthesisReply();
      case "project_status": {
        const st = await this.actProjectStatus(a.project);
        return st.length ? { text: st.map(projectLine).join(" "), data: st }
          : { text: "Проектов пока нет. Создайте заметку в Projects/ с полем repo." };
      }
      case "delegate": {
        if (a.mode === "local") return { text: "На iPhone нет компьютера с кодом — поручаю через GitHub: скажите без слова «локально».", kind: "warn" };
        const item = this.actDelegate(a.project, a.task);
        return { text: `Для ${item.params.project} создам задачу для @claude на GitHub: «${a.task}». Подтверждаете?`, kind: "warn", confirm: item };
      }
      case "deploy": {
        const item = this.actDeploy(a.project);
        return { text: `Запустить деплой ${item.params.project}? Это затронет боевой сервер.`, kind: "warn", confirm: item };
      }
      default: return { text: "Команда не распознана.", kind: "warn" };
    }
  }

  tasksReply(view, project) {
    const items = this.actListTasks(view, project);
    const label = { today: "на сегодня", overdue: "просроченных", week: "на неделю", tomorrow: "на завтра", all: "открытых", nodate: "без срока" }[view] || "";
    const scope = project ? ` по ${project}` : "";
    if (!items.length) return { text: `Задач ${label}${scope} нет, ${this.title}. Можно выдохнуть.`, data: items };
    const n = items.length;
    return { text: `${n} ${plural(n, "задача", "задачи", "задач")} ${label}${scope}: ${items.slice(0, 7).map((x) => x.text).join("; ")}${n > 7 ? ` и ещё ${n - 7}` : ""}.`, data: items };
  }

  financeReply(period) {
    const cur = this.ledger.currency;
    if (period === "today") {
      const items = this.ledger.entries(this.today().slice(0, 7)).filter((e) => e.date === this.today());
      const spent = -items.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0);
      return { text: `Сегодня потрачено ${money(spent, cur)} (${items.length} операций).`, data: items };
    }
    const s = this.actFinance();
    let text = `В этом месяце расходы ${money(s.expense, cur)}, доходы ${money(s.income, cur)}.`;
    if (s.budget_total) text += ` Бюджет израсходован на ${s.budget_percent}%.`;
    const top = s.categories.filter((c) => c.spent).slice(0, 3);
    if (top.length) text += ` Больше всего: ${top.map((c) => `${c.category} — ${money(c.spent, cur)}`).join(", ")}.`;
    if (s.budget_total && s.forecast > s.budget_total) text += ` При таком темпе к концу месяца выйдет ${money(s.forecast, cur)} — выше бюджета.`;
    return { text, data: s };
  }

  analyticsReply() {
    const a = this.actFinanceAnalytics();
    const lines = a.insights.length ? [...a.insights] : ["Данных пока мало: нужно хотя бы несколько операций."];
    const rec = a.recurring.filter((r) => !r.paid).slice(0, 3);
    if (rec.length) lines.push(`Ожидаются: ${rec.map((r) => `${r.note} — ${money(r.amount, this.ledger.currency)}`).join(", ")}.`);
    return { text: lines.join(" "), data: a };
  }

  recallReply(query) {
    if (!query) {
      const facts = this.memory.facts();
      if (!facts.length) return { text: `Пока я знаю о вас немного, ${this.title}. Скажите «запомни, что…».` };
      return { text: `Вот что я помню: ${facts.slice(-8).map((f) => f.text).join("; ")}.`, data: { facts } };
    }
    const hits = this.vault.search(query, 5);
    if (!hits.length) return { text: `В заметках ничего не нашёл про «${query}».`, data: [] };
    return { text: `Нашёл в заметках: ${hits.slice(0, 4).map((h) => h.title).join(", ")}. ${hits[0].snippet}`, data: hits };
  }

  // ---------- состояние, диагностика, фоновые проверки ----------
  state() {
    const ref = this.today();
    return {
      now: this.now().toISOString(), title: this.title, name: this.settings.name || "",
      mode: "standalone", llm: this.brain.available, model: this.brain.available ? (this.settings.model || "claude-opus-5-5") : null,
      voice: { engine: "browser", server: false, muted: this.muted, wake_word: this.settings.wakeWord || "атом" },
      tasks: { summary: this.tasks.summary(ref), today: this.actListTasks("today"), week: this.actListTasks("week").slice(0, 20),
        nodate: this.actListTasks("nodate").slice(0, 15), done_today: this.tasks.doneOn(ref) },
      finance: this.actFinance(),
      memory: { facts: this.memory.facts().slice(-12), notes: this.vault.list().length },
      projects: this.projects.list(),
      pending: [...this.pending.values()],
      reminders: this.memory.reminders(),
      protocols: this.protocols.list(),
      focus_until: this.focusUntil,
      events: this.events.slice(-60),
      telegram: Boolean(this.settings.telegramToken && this.settings.telegramChat),
      vault: this.vault.store.kind === "github" ? this.settings.vaultRepo : "в браузере (демо)",
    };
  }

  async diagnostics() {
    const est = typeof navigator !== "undefined" && navigator.storage && navigator.storage.estimate
      ? await navigator.storage.estimate().catch(() => null) : null;
    const rate = this.github && this.github.rate;
    return { mode: "device", notes: this.vault.list().length, store: this.vault.store.kind,
      online: typeof navigator !== "undefined" ? navigator.onLine : true,
      github_rate: rate, storage_mb: est ? Math.round((est.usage || 0) / 2 ** 20) : null,
      storage_quota_mb: est ? Math.round((est.quota || 0) / 2 ** 20) : null,
      last_sync: this.lastPoll ? Math.round(Date.now() / 1000 - this.lastPoll) : null,
      load: rate && rate.limit ? 1 - rate.remaining / rate.limit : 0 };
  }

  // Вызывается раз в несколько секунд, пока приложение открыто.
  async tick({ pollEvery = 15 } = {}) {
    if (this.focusUntil && Date.now() / 1000 >= this.focusUntil) { this.focusUntil = null; this.emit("focus", { until: null }); }
    const due = this.memory.reminders().filter((r) => r.at <= Date.now() / 1000);
    if (due.length) {
      await this.memory.removeReminders(due.map((r) => r.id));
      for (const r of due) await this.alert(`Напоминание: ${r.text}`, "info");
      this.changed("reminders");
    }
    if (Date.now() / 1000 - this.lastPoll >= pollEvery) {
      this.lastPoll = Date.now() / 1000;
      try { await this.vault.poll(); this.emit("sync", { ok: true }); } catch (e) { this.emit("sync", { ok: false, error: e.message }); }
    }
  }

  /** Запись калибровки взгляда или журнала нажатий — как jarvis/gaze.py: проверка и новый файл в Jarvis/Gaze. */
  async saveGazeRecord(data) {
    const KINDS = { "jarvis-gaze-session": ["sessions", "frames"], "jarvis-gaze-usage": ["usage", "clicks"] };
    const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
    if (!data || typeof data !== "object" || !KINDS[data.kind]) throw bad("это не запись взгляда");
    const [sub, items] = KINDS[data.kind];
    if (!Number.isInteger(data.version) || data.version < 1) throw bad("нет версии записи");
    const rows = data[items];
    if (!Array.isArray(rows) || !rows.length) throw bad(`пустая запись: нет ${items}`);
    if (rows.length > 20000) throw bad("слишком длинная запись");
    const sc = data.screen;
    if (!sc || !["w", "h"].every((k) => typeof sc[k] === "number" && sc[k] > 0)) throw bad("нет размера экрана");
    const text = JSON.stringify(data);
    if (new TextEncoder().encode(text).length > 6 * 2 ** 20) throw bad("слишком большая запись");
    const d = this.now(), pad = (v) => String(v).padStart(2, "0");
    const base = `Jarvis/Gaze/${sub}/${isoDay(d)}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    let rel = `${base}.json`;
    for (let n = 2; this.vault.exists(rel); n++) rel = `${base}-${n}.json`;
    return this.vault.write(rel, `${text}\n`, `Atom: запись взгляда ${rel}`);
  }

  // ---------- те же маршруты /api/…, что у Python-сервера ----------
  async request(method, path, body) {
    const url = new URL(path, "http://local");
    const q = Object.fromEntries(url.searchParams);
    const p = url.pathname;
    let m;
    if (p === "/api/session") return { auth: false, logged_in: true, standalone: true };
    if (p === "/api/state") return this.state();
    if (p === "/api/command") return this.handle(String(body.text || "").slice(0, 4000), body.source || "iphone", 0, body.note || null);
    if (p === "/api/tasks" && method === "GET") return this.actListTasks(q.view || "today", q.project || null);
    if (p === "/api/tasks") return this.actAddTask(String(body.text || ""), body.due || null, body.priority || null, body.project || null);
    if ((m = /^\/api\/tasks\/(.+)\/status$/.exec(p))) {
      const id = decodeURIComponent(m[1]);
      if (body.status === "done") return this.actCompleteTask(id);
      const t = await this.tasks.setStatus(id, body.status, this.today());
      this.changed("tasks");
      return t;
    }
    if (p === "/api/finance" && method === "GET") return this.actFinance(q.month || null);
    if (p === "/api/apps" && method === "GET") return catalog(this.vault, this.projects);
    if (p === "/api/apps") {
      const r = await setInCatalog(this.vault, this.projects, String(body.name || ""), body.on !== false);
      this.changed("projects");
      return r;
    }
    if (p === "/api/finance/analytics") return this.actFinanceAnalytics(Number(q.months) || 6);
    if (p === "/api/finance/assets" && method === "GET") return this.actAssets(q.record !== "0");
    if (p === "/api/finance/assets") return this.actAssetAdd(String(body.action || "asset"), body);
    if (p === "/api/finance") {
      const amount = Math.round(Number(String(body.amount).replace(",", ".")) * 100);
      if (!Number.isFinite(amount)) throw new VaultError("сумма должна быть числом");
      return this.actMoney(amount, body.category || guessCategory(String(body.note || ""), amount > 0), body.note || "", body.date || null);
    }
    if (p === "/api/projects" && method === "POST") {
      return this.actProjectCreate(String(body.name || ""), String(body.description || ""), String(body.repo || ""),
        String(body.tag || ""), String(body.status || "active"));
    }
    if (p === "/api/projects") return this.actProjectStatus();
    if ((m = /^\/api\/projects\/([^/]+)$/.exec(p)) && method === "GET") return this.actProjectOverview(decodeURIComponent(m[1]));
    if ((m = /^\/api\/projects\/([^/]+)\/update$/.exec(p))) {
      return this.actProjectUpdate(decodeURIComponent(m[1]), String(body.key || "status"), String(body.value || ""));
    }
    if ((m = /^\/api\/projects\/([^/]+)\/task$/.exec(p))) {
      return this.actAddTask(String(body.text || ""), body.due || null, body.priority || null, decodeURIComponent(m[1]), true);
    }
    if (p === "/api/synthesis" && method === "GET") return this.actSynthesis();
    if (p === "/api/synthesis") {
      if (!String(body.name || "").trim()) throw new VaultError("не указано: name");
      return this.actSynthesisCreate(String(body.name), String(body.status || "idea"));
    }
    if (p === "/api/files" && method === "GET") return this.actFiles();
    if ((m = /^\/api\/files\/(new|folder|move|trash)$/.exec(p))) {
      if (m[1] === "new") return this.actCreateNote(String(body.path || ""), body.template || null, body.content ?? null);
      if (m[1] === "folder") return this.actMkdir(String(body.path || ""));
      if (m[1] === "move") return this.actMoveNote(String(body.from || ""), String(body.to || ""));
      return this.actTrashNote(String(body.path || ""));
    }
    if ((m = /^\/api\/projects\/([^/]+)\/(delegate|deploy)$/.exec(p))) {
      const name = decodeURIComponent(m[1]);
      const item = m[2] === "delegate" ? this.actDelegate(name, String(body.task || "").trim() || (() => { throw new Error("не указано, что сделать"); })())
        : this.actDeploy(name);
      return { confirm: item };
    }
    if ((m = /^\/api\/confirm\/(.+)$/.exec(p))) return this.confirm(m[1]);
    if ((m = /^\/api\/cancel\/(.+)$/.exec(p))) return this.cancel(m[1]);
    if (p === "/api/memory" && method === "GET") return q.q ? { hits: this.vault.search(q.q, 12) } : { facts: this.memory.facts(), profile: this.memory.profile() };
    if (p === "/api/memory") return this.actRemember(String(body.fact || ""));
    if (p === "/api/note" && method === "GET") return this.actReadNote(q.path || "");
    if (p === "/api/note") {
      // PUT — правка (base — версия, с которой начали править), POST — новая заметка; конфликт — 409, как у сервера
      if (method === "PUT" && !body.base) throw Object.assign(new Error("не указана версия заметки (base)"), { status: 400 });
      try {
        return await this.actSaveNote(body.path, String(body.content ?? ""), method === "PUT" ? body.base : null);
      } catch (e) {
        if (e.status !== 409) throw e;
        const current = e.current == null ? null : { content: e.current, version: contentVersion(e.current) };
        throw Object.assign(new Error(e.message), { status: 409, data: { error: e.message, conflict: true, current } });
      }
    }
    if (p === "/api/graph") return this.vault.graph();
    if (p === "/api/gaze" && method === "POST") return { path: await this.saveGazeRecord(body) };
    if (p === "/api/diagnostics") return this.diagnostics();
    if (p === "/api/weather") return { weather: await this.briefing.weather(), rates: await this.briefing.rates() };
    if (p === "/api/voice") { if ("muted" in body) this.muted = Boolean(body.muted); return { muted: this.muted }; }
    if (p === "/api/tts") return null;
    if (p === "/api/scan") {
      if (!this.brain.available) throw Object.assign(new Error("Анализ фото работает с ключом Claude API (Настройки)."), { status: 503 });
      return this.brain.analyzeImage(body.base64, body.mediaType, body.hint || "");
    }
    throw Object.assign(new Error(`нет такого маршрута: ${p}`), { status: 404 });
  }
}

export { isoDay };
