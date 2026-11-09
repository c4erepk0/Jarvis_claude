// J.A.R.V.I.S. — дашборд. Без сборки и фреймворков: модули ES.
// Два режима: с сервером (REST + WebSocket к Python) и «только iPhone» — ядро работает прямо в Safari
// (core/*.js), память — GitHub-репозиторий с хранилищем Obsidian. Интерфейс один и тот же.
import { Reactor } from "./reactor.js?v=6";
import { Voice } from "./voice.js?v=6";

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const CLIENT = Math.random().toString(36).slice(2, 10);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (k, cur = "RUB") => {
  const sym = { RUB: "₽", USD: "$", EUR: "€" }[cur] || cur;
  const v = Math.abs(k) / 100;
  return `${k < 0 ? "−" : ""}${v.toLocaleString("ru-RU", { maximumFractionDigits: v % 1 ? 2 : 0 })} ${sym}`;
};
const store = {
  get(k, d) { try { const v = localStorage.getItem(`jarvis.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`jarvis.${k}`, JSON.stringify(v)); } catch { /* приватный режим */ } },
};

let S = null;                 // состояние с сервера
let projects = [];            // живой статус проектов
let diag = null;
let taskView = "today";
let ws = null;
let greeted = false;
let local = null;             // ядро Jarvis в браузере (режим «только iPhone»)
let SA = null;                // модуль standalone.js
const reactor = new Reactor($("#reactor"));
const voice = new Voice({
  onCommand: (t) => send(t),
  onState: (s) => setMode(s),
  onLevel: (l) => reactor.setLevel(l),
  onHeard: (t) => { $("#heard").textContent = t; },
});

// ---------- API ----------
async function api(path, { method = "GET", body, form } = {}) {
  if (local) {
    try { return await local.request(method, path, body || {}); }
    catch (e) { throw new Error(e.message || String(e)); }
  }
  const opts = { method, credentials: "same-origin", headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
  const r = await fetch(path, opts);
  if (r.status === 401) { showLogin(); throw new Error("нужен вход"); }
  const data = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
  return data;
}

// ---------- загрузка ----------
async function boot() {
  const lines = ["> инициализация ядра…", "> подключение памяти: Obsidian", "> синхронизация каналов связи",
    "> калибровка голосового модуля", "> все системы в норме"];
  const log = $("#boot-log");
  for (const l of lines) { log.textContent += l + "\n"; await new Promise((r) => setTimeout(r, 170)); }
  const server = await fetch("api/session", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!server || server.standalone) {
    // сервера нет (GitHub Pages / с экрана «Домой») — Jarvis работает прямо на телефоне
    SA = await import("./standalone.js?v=6");
    document.body.classList.add("standalone");
    if (!SA.hasSettings()) { hideBoot(); openSettings(true); return; }
    try {
      local = await SA.createLocal(SA.loadSettings());
    } catch (e) {
      hideBoot();
      toast(`Не удалось открыть память: ${e.message}`, "error");
      openSettings(false, e.message);
      return;
    }
    await start();
    hideBoot();
    if (SA.needsSeed(local)) offerSeed();
    return;
  }
  if (server.auth && !server.logged_in) { hideBoot(); showLogin(); return; }
  await start();
  hideBoot();
}
function hideBoot() { $("#boot").classList.add("off"); setTimeout(() => $("#boot").remove(), 700); }

function showLogin() {
  $("#login").classList.remove("hidden");
  $("#login-code").focus();
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-err").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: { code: $("#login-code").value } });
    $("#login").classList.add("hidden");
    await start();
  } catch (err) { $("#login-err").textContent = err.message; }
});

async function start() {
  await loadState(true);
  if (local) {
    local.on(handleEvent);
    chip("#chip-sync", "on");
    setInterval(() => local.tick().catch(() => {}), 5000);
    setInterval(() => api("/api/diagnostics").then(renderDiag).catch(() => {}), 30000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") local.tick({ pollEvery: 0 }).catch(() => {});
    });
  } else connect();
  loadProjects();
  setInterval(loadProjects, 120000);
  setInterval(() => loadWeather(), 15 * 60000);
  loadWeather();
  api("/api/diagnostics").then(renderDiag).catch(() => {});
  say(`${greeting()}, ${S.title}. J.A.R.V.I.S. на связи. ${S.llm ? "" : "Работаю в режиме команд."}`, { speak: false });
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Доброй ночи" : h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : h < 23 ? "Добрый вечер" : "Доброй ночи";
}

let stateTimer = null;
async function loadState(first = false) {
  S = await api("/api/state");
  if (first) {
    voice.wake = (S.voice.wake_word || "джарвис").toLowerCase();
    voice.serverTTS = S.voice.server;
    if (SA) voice.preferredVoice = SA.loadSettings().voiceName;
    voice.muted = S.voice.muted || store.get("muted", false);
    $("#opt-mute").checked = voice.muted;
    renderLog(S.events);
  }
  renderAll();
}
function refreshSoon(what) {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => { loadState().catch(() => {}); if (what === "projects" || what === "all") loadProjects(); }, 250);
}
async function loadProjects() {
  try { projects = await api("/api/projects"); renderProjects(); } catch { /* офлайн */ }
}
async function loadWeather() {
  try {
    const w = (await api("/api/weather")).weather;
    if (w) $("#weather").innerHTML = `<b>${w.temp > 0 ? "+" : ""}${w.temp}°</b> ${esc(w.city)}<br><span class="muted">${esc(w.text)} · ${w.min}…${w.max}°</span>`;
  } catch { /* нет сети */ }
}

// ---------- WebSocket ----------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => chip("#chip-sync", "on");
  ws.onclose = () => { chip("#chip-sync", "bad"); setTimeout(connect, 2500); };
  ws.onmessage = (m) => {
    let e; try { e = JSON.parse(m.data); } catch { return; }
    handleEvent(e);
  };
}

function handleEvent(e) {
    const d = e.data || {};
    switch (e.type) {
      case "refresh": refreshSoon(d.what); break;
      case "vault":
        chip("#chip-sync", "on", true);
        addLog({ type: "log", ts: e.ts, data: { text: `Obsidian: изменено заметок — ${d.count}` } });
        break;
      case "reply":
        if (d.client && d.client === CLIENT) break;
        $("#heard").textContent = `${d.via === "telegram" ? "✈ " : ""}${d.request || ""}`;
        showReply(d, { speak: false });
        break;
      case "alert": onAlert(d, e.ts); break;
      case "log": addLog(e); break;
      case "diag": renderDiag(d); break;
      case "pending": refreshSoon("pending"); break;
      case "focus": S.focus_until = d.until; renderFocus(); break;
      case "voice": voice.muted = d.muted; $("#opt-mute").checked = d.muted; renderChips(); break;
      case "tool": setMode("thinking"); $("#heard").textContent = `⚙ ${toolName(d.name)}…`; break;
      case "workshop": workshop(d); break;
      case "job": workshop({ text: `— ${d.project}: ${d.status} ${d.result ? "· " + d.result.slice(0, 300) : ""}` });
        toast(`Мастерская: ${d.project} — ${d.status === "done" ? "готово" : d.status}`, d.status === "done" ? "ok" : "warn"); break;
      case "sync": chip("#chip-sync", d.ok ? "on" : "bad"); if (!d.ok) $("#chip-sync").title = `Синхронизация: ${d.error}`; break;
      default: break;
    }
}
const TOOL_NAMES = { memory_search: "ищу в памяти", tasks_list: "смотрю задачи", task_add: "записываю задачу",
  money_add: "записываю операцию", finance_report: "считаю финансы", projects_status: "проверяю проекты",
  memory_remember: "запоминаю", note_read: "читаю заметку", web_search: "ищу в интернете", project_delegate: "готовлю поручение" };
const toolName = (n) => TOOL_NAMES[n] || n;

// ---------- диалог ----------
async function send(text, { source = "dashboard" } = {}) {
  text = text.trim();
  if (!text) return;
  voice.unlock();
  $("#heard").textContent = text;
  setMode("thinking");
  try {
    const r = await api("/api/command", { method: "POST", body: { text, source, client: CLIENT } });
    showReply(r);
  } catch (e) {
    showReply({ text: `Связь потеряна: ${e.message}`, kind: "error", speech: "" });
  }
}

function showReply(r, { speak = true } = {}) {
  const said = $("#said");
  said.className = `said ${r.kind || ""}`;
  typeText(said, r.text || "");
  if (r.confirm) renderConfirms([r.confirm]);
  if (r.kind === "error") setMode("error"); else setMode(r.kind === "warn" ? "alert" : "idle");
  if (speak && r.speech !== "") say(r.speech ?? r.text);
}

function say(text, { speak = true } = {}) {
  if (!speak) { typeText($("#said"), text); return; }
  if (!voice.muted) voice.say(text);
}

let typing = null;
function typeText(el, text) {
  clearInterval(typing);
  el.textContent = "";
  let i = 0;
  const step = Math.max(1, Math.ceil(text.length / 90));
  typing = setInterval(() => { i += step; el.textContent = text.slice(0, i); if (i >= text.length) clearInterval(typing); }, 16);
}

function setMode(m) {
  const labels = { idle: "ОЖИДАНИЕ", listening: voice.wakeMode ? `СЛУШАЮ «${voice.wake.toUpperCase()}»` : "СЛУШАЮ",
    armed: "ДА, СЭР?", thinking: "АНАЛИЗ", speaking: "ГОВОРЮ", alert: "ВНИМАНИЕ", error: "СБОЙ", denied: "НЕТ ДОСТУПА К МИКРОФОНУ" };
  reactor.setState({ armed: "listening", denied: "error" }[m] || m);
  $("#reactor-state").textContent = labels[m] || "";
  $("#btn-mic").classList.toggle("live", m === "listening" || m === "armed");
  if (m === "denied") toast("Браузер не дал доступ к микрофону.", "error");
}

function onAlert(d, ts) {
  toast(d.text, d.level);
  addLog({ type: "alert", ts, data: d });
  const focus = S && S.focus_until && S.focus_until * 1000 > Date.now();
  if (d.speak && (!focus || d.level === "error")) voice.say(d.text);
  if (d.level === "error") setMode("error");
}

// ---------- отрисовка ----------
function renderAll() {
  if (!S) return;
  renderChips(); renderTasks(); renderProtocols(); renderFacts(); renderFinance(); renderConfirms(); renderFocus();
  if (!projects.length) renderProjects();
  updateMetrics();
}

function chip(sel, cls, flash = false) {
  const el = $(sel);
  el.classList.remove("on", "warn", "bad");
  if (cls) el.classList.add(cls);
  if (flash) { el.style.boxShadow = "0 0 14px var(--holo)"; setTimeout(() => { el.style.boxShadow = ""; }, 600); }
}
function renderChips() {
  chip("#chip-brain", S.llm ? "on" : "warn");
  $("#chip-brain").title = S.llm ? `${S.brain || "Claude"}: ${S.model}` : "Модель не подключена — только команды";
  chip("#chip-voice", voice.muted ? "warn" : "on");
  chip("#chip-tg", S.telegram ? "on" : "");
}

function dueLabel(t) {
  if (!t.due) return "";
  const today = S.now.slice(0, 10);
  if (t.due < today) return `<div class="t-meta over">ПРОСРОЧЕНО · ${t.due.slice(5)}</div>`;
  if (t.due === today) return `<div class="t-meta today">СЕГОДНЯ</div>`;
  const d = new Date(t.due + "T00:00");
  return `<div class="t-meta">${d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }).toUpperCase()}</div>`;
}
function renderTasks() {
  const list = taskView === "today" ? S.tasks.today : taskView === "week" ? S.tasks.week : S.tasks.nodate;
  const done = taskView === "today" ? S.tasks.done_today : [];
  const sm = S.tasks.summary;
  $("#tasks-meta").textContent = `${sm.open} ОТКР · ${sm.done_today} ГОТОВО${sm.overdue ? ` · ${sm.overdue} ПРОСР` : ""}`;
  const items = [...list, ...done];
  $("#tasks-list").innerHTML = items.length ? items.map((t) => `
    <li class="task ${t.status === "done" ? "done" : ""} prio-${t.priority}" data-id="${esc(t.id)}">
      <button class="check" aria-label="Выполнено" ${t.status === "done" ? "disabled" : ""}></button>
      <div class="t-text">${esc(t.text)}${t.tags.map((g) => `<span class="tag">#${esc(g)}</span>`).join("")}</div>
      ${dueLabel(t)}
    </li>`).join("") : `<li class="empty">${taskView === "today" ? "На сегодня задач нет. Можно выдохнуть, сэр." : "Пусто."}</li>`;
}
$("#tasks-list").addEventListener("click", async (e) => {
  const btn = e.target.closest(".check");
  if (!btn) return;
  const li = btn.closest(".task");
  li.classList.add("done");
  try { await api(`/api/tasks/${encodeURIComponent(li.dataset.id)}/status`, { method: "POST", body: { status: "done" } }); }
  catch (err) { li.classList.remove("done"); toast(err.message, "error"); }
});
$("#tasks-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  taskView = b.dataset.view;
  $$("#tasks-seg button").forEach((x) => x.classList.toggle("on", x === b));
  renderTasks();
});
$("#task-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#task-input").value.trim();
  if (v) { send(`добавь задачу ${v}`); $("#task-input").value = ""; }
});

function renderProtocols() {
  $("#protocols").innerHTML = S.protocols.map((p) => `
    <button class="btn ghost proto" data-name="${esc(p.name)}">${esc(p.title.toUpperCase())}<small>${esc(p.description)}</small></button>`).join("");
}
$("#protocols").addEventListener("click", (e) => {
  const b = e.target.closest(".proto"); if (b) send(`протокол ${b.dataset.name}`);
});

function renderFacts(hits) {
  $("#memory-meta").textContent = `${S.memory.notes} ЗАМЕТОК`;
  if (hits) {
    $("#facts").innerHTML = hits.length ? hits.map((h) => `<li class="hit" data-path="${esc(h.path)}"><b>${esc(h.title)}</b><small>${esc(h.snippet)}</small></li>`).join("")
      : `<li class="empty">Ничего не нашлось.</li>`;
    return;
  }
  const facts = [...S.memory.facts].reverse();
  $("#facts").innerHTML = facts.length ? facts.map((f) => `<li>${esc(f.text)}<small>${esc(f.date || "")}</small></li>`).join("")
    : `<li class="empty">Скажите «запомни, что…» — и я сохраню это в Obsidian.</li>`;
}
$("#mem-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#mem-q").value.trim();
  if (!q) { renderFacts(); return; }
  const r = await api(`/api/memory?q=${encodeURIComponent(q)}`);
  renderFacts(r.hits);
});
$("#facts").addEventListener("click", (e) => { const li = e.target.closest(".hit"); if (li) openNote(li.dataset.path); });

function renderFinance() {
  const f = S.finance, cur = f.currency;
  const [y, m] = f.month.split("-");
  $("#fin-month").textContent = new Date(+y, +m - 1, 1).toLocaleDateString("ru-RU", { month: "long", year: "numeric" }).toUpperCase();
  $("#fin-exp").textContent = money(f.expense, cur);
  $("#fin-inc").textContent = money(f.income, cur);
  $("#fin-fc").textContent = money(f.forecast, cur);
  const pct = f.budget_percent;
  const g = $("#fin-gauge-val");
  g.style.strokeDasharray = `${Math.min(100, pct || 0) * 3.1416} 400`;
  g.classList.toggle("warn", pct >= 80 && pct < 100);
  g.classList.toggle("bad", pct >= 100);
  $("#fin-gauge-num").textContent = pct === null ? "—" : `${pct}%`;
  $("#fin-cats").innerHTML = f.categories.filter((c) => c.spent || c.limit).slice(0, 7).map((c) => {
    const p = c.limit ? Math.min(100, c.percent) : 0;
    const cls = c.percent >= 100 ? "bad" : c.percent >= 80 ? "warn" : "";
    return `<li><div class="cat-row"><span>${esc(c.category)}</span><span>${money(c.spent, cur)}${c.limit ? ` / ${money(c.limit, cur)}` : ""}</span></div>
      <div class="bar"><i class="${cls}" style="width:${c.limit ? p : 100}%;${c.limit ? "" : "opacity:.25"}"></i></div></li>`;
  }).join("");
  $("#fin-ops").innerHTML = f.recent.map((o) => `<li><span class="d">${o.date.slice(8)}.${o.date.slice(5, 7)}</span>
    <span>${esc(o.category)}<span class="muted"> · ${esc(o.note)}</span></span><span class="m ${o.amount > 0 ? "in" : ""}">${money(o.amount, cur)}</span></li>`).join("")
    || `<li class="empty">Операций пока нет. Скажите «потратил 450 на кофе».</li>`;
}
$("#fin-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = $("#fin-amount").value.trim().replace("−", "-"), note = $("#fin-note").value.trim();
  if (!raw) return;
  const n = parseFloat(raw.replace(",", "."));
  if (Number.isNaN(n)) { toast("Сумма должна быть числом", "warn"); return; }
  const income = raw.startsWith("+") || (n > 0 && /зарплат|доход|получил|выплат|продаж/i.test(note));
  send(income ? `получил ${Math.abs(n)} ${note || "доход"}` : `потратил ${Math.abs(n)} ${note || "прочее"}`);
  $("#fin-amount").value = ""; $("#fin-note").value = "";
});

function ciBadge(ci) {
  if (!ci) return `<span class="badge">CI —</span>`;
  if (ci.status !== "completed") return `<span class="badge run">CI ИДЁТ</span>`;
  const ok = ci.conclusion === "success";
  return `<span class="badge ${ok ? "ok" : "bad"}">CI ${ok ? "OK" : esc((ci.conclusion || "FAIL").toUpperCase())}</span>`;
}
function renderProjects() {
  const list = projects.length ? projects : (S ? S.projects : []);
  if (!list.length) { $("#projects").innerHTML = `<p class="empty">Добавьте заметку проекта в Projects/ с полем repo.</p>`; return; }
  $("#projects").innerHTML = list.map((p) => {
    const gh = p.github || {}, st = p.stats && !p.stats.error ? p.stats : null;
    const h = p.health;
    const dot = h ? (h.ok ? "ok" : "bad") : gh.ci && gh.ci.status !== "completed" ? "run" : gh.url ? "ok" : "";
    const kpis = [["PR", (gh.pulls || []).length], ["ЗАДАЧИ", (gh.issues || []).length]];
    if (st) {
      if ("users" in st) kpis.push(["ЮЗЕРЫ", st.users]);
      if ("active_subs" in st) kpis.push(["ПОДПИСКИ", st.active_subs]);
      if ("new_users_24h" in st) kpis.push(["НОВЫЕ 24Ч", st.new_users_24h]);
      if ("stars_24h" in st) kpis.push(["★ 24Ч", st.stars_24h]);
    } else if (h && h.latency_ms) kpis.push(["ПИНГ", `${h.latency_ms}мс`]);
    const c = gh.last_commit;
    return `<div class="proj" data-name="${esc(p.name)}">
      <div class="proj-h"><span class="dot ${dot}"></span><span class="proj-name">${esc(p.name.toUpperCase())}</span>${gh.url || p.repo ? ciBadge(gh.ci) : ""}</div>
      ${p.description ? `<div class="proj-desc">${esc(p.description)}</div>` : ""}
      ${gh.url || st ? `<div class="kpis">${kpis.slice(0, 6).map(([k, v]) => `<div class="kpi"><b>${esc(v)}</b><span>${k}</span></div>`).join("")}</div>` : ""}
      ${c ? `<div class="proj-commit" title="${esc(c.message)}">⎇ ${esc(c.sha)} ${esc(c.message)}</div>` : ""}
      ${(gh.issues || []).length ? `<ul class="proj-list">${gh.issues.slice(0, 3).map((i) => `<li><a href="${esc(i.url)}" target="_blank" rel="noopener">#${i.number} ${esc(i.title)}</a></li>`).join("")}</ul>` : ""}
      ${p.github_error ? `<div class="proj-err">⚠ ${esc(p.github_error)}</div>` : ""}
      ${st && (st.open_reports || st.pending_devs || st.pending_apps) ? `<div class="proj-err">⚑ ждут вас: жалобы ${st.open_reports || 0}, заявки ${st.pending_devs || 0}, приложения ${st.pending_apps || 0}</div>` : ""}
      ${h && !h.ok ? `<div class="proj-err">⚠ сервис не отвечает${h.status ? ` (HTTP ${h.status})` : ""}</div>` : ""}
      <div class="proj-actions">
        <button class="btn" data-act="delegate">◆ ПОРУЧИТЬ CLAUDE</button>
        ${p.deploy_workflow ? `<button class="btn warn" data-act="deploy">▲ ДЕПЛОЙ</button>` : ""}
        ${gh.url ? `<a class="btn ghost" href="${esc(gh.url)}" target="_blank" rel="noopener">GITHUB</a>` : ""}
        <button class="btn ghost" data-act="note" data-path="${esc(p.note)}">ЗАМЕТКА</button>
      </div></div>`;
  }).join("");
}
$("#projects").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const name = b.closest(".proj").dataset.name;
  if (b.dataset.act === "note") openNote(b.dataset.path);
  if (b.dataset.act === "deploy") {
    try { const r = await api(`/api/projects/${encodeURIComponent(name)}/deploy`, { method: "POST", body: {} }); renderConfirms([r.confirm]); }
    catch (err) { toast(err.message, "error"); }
  }
  if (b.dataset.act === "delegate") delegateForm(name);
});
$("#projects-refresh").addEventListener("click", () => { $("#projects").style.opacity = ".5"; loadProjects().finally(() => { $("#projects").style.opacity = ""; }); });

function delegateForm(name) {
  modal(`ПОРУЧЕНИЕ · ${name.toUpperCase()}`, `
    <form id="dlg-form">
      <div class="form-row"><label>ЧТО СДЕЛАТЬ</label><textarea id="dlg-task" required placeholder="Например: добавить экспорт статистики в CSV для админа, с тестом"></textarea></div>
      <div class="form-row"><label>КАК</label><select id="dlg-mode">
        <option value="github">Задача для @claude на GitHub — он сделает PR</option>
        <option value="local">Claude Code на этом компьютере (папка path из заметки)</option></select></div>
      <div class="modal-actions"><button type="button" class="btn ghost" data-close>ОТМЕНА</button><button class="btn primary">ДАЛЕЕ</button></div>
    </form>`);
  $("#dlg-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const r = await api(`/api/projects/${encodeURIComponent(name)}/delegate`, { method: "POST",
        body: { task: $("#dlg-task").value, mode: $("#dlg-mode").value } });
      closeModal();
      renderConfirms([r.confirm]);
    } catch (err) { toast(err.message, "error"); }
  });
}

function renderConfirms(extra = []) {
  const items = new Map();
  for (const p of [...(S ? S.pending : []), ...extra]) if (p) items.set(p.id, p);
  $("#confirms").innerHTML = [...items.values()].map((p) => `
    <div class="confirm" data-id="${esc(p.id)}"><p><b>ТРЕБУЕТСЯ ПОДТВЕРЖДЕНИЕ</b>${esc(p.title)}</p>
      <button class="btn warn" data-c="yes">ПОДТВЕРДИТЬ</button><button class="btn ghost" data-c="no">✕</button></div>`).join("");
}
$("#confirms").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-c]"); if (!b) return;
  const card = b.closest(".confirm"), id = card.dataset.id;
  card.remove();
  if (S) S.pending = S.pending.filter((p) => p.id !== id);
  const r = await api(`/api/${b.dataset.c === "yes" ? "confirm" : "cancel"}/${id}`, { method: "POST", body: {} });
  showReply(r);
});

function renderDiag(d) {
  if (d && d.mode === "device") return renderDeviceDiag(d);
  if (!d || !d.ram) return;
  diag = d;
  $("#diag-host").textContent = (d.host || "").toUpperCase().slice(0, 18);
  const meter = (label, pct, value) => {
    const cls = pct >= 90 ? "bad" : pct >= 75 ? "warn" : "";
    return `<div><div class="meter-h">${label}<b>${value}</b></div><div class="meter"><i class="${cls}" style="width:${Math.min(100, pct)}%"></i></div></div>`;
  };
  $("#diag").innerHTML = [
    meter("ПРОЦЕССОР", d.cpu, `${d.cpu}% · ${d.cores} ядер`),
    meter("ПАМЯТЬ", d.ram.percent, `${d.ram.used_gb} / ${d.ram.total_gb} ГБ`),
    d.disk ? meter("ДИСК", d.disk.percent, `свободно ${d.disk.free_gb} ГБ`) : "",
    meter("СЕТЬ", Math.min(100, (d.net.rx_kbs + d.net.tx_kbs) / 50), `↓${d.net.rx_kbs} ↑${d.net.tx_kbs} КБ/с`),
    `<div class="diag-foot"><span>АПТАЙМ ${d.uptime_h} Ч</span>${d.temp ? `<span>T ${d.temp}°</span>` : ""}${d.battery ? `<span>БАТ ${d.battery.percent}%${d.battery.plugged ? "⚡" : ""}</span>` : ""}<span>JARVIS ${d.jarvis.rss_mb} МБ</span></div>`,
  ].join("");
  updateMetrics();
}

// Диагностика в режиме «только iPhone»: связь, синхронизация с GitHub, память, хранилище браузера.
function renderDeviceDiag(d) {
  diag = { cpu: Math.round((d.load || 0) * 100) };
  $("#diag-host").textContent = "IPHONE";
  const meter = (label, pct, value) => {
    const cls = pct >= 90 ? "bad" : pct >= 75 ? "warn" : "";
    return `<div><div class="meter-h">${label}<b>${value}</b></div><div class="meter"><i class="${cls}" style="width:${Math.min(100, pct)}%"></i></div></div>`;
  };
  const r = d.github_rate;
  $("#diag").innerHTML = [
    meter("СВЯЗЬ", d.online === false ? 100 : 8, d.online === false ? "нет сети" : "в сети"),
    r ? meter("ЛИМИТ GITHUB", 100 * (1 - r.remaining / r.limit), `${r.remaining} / ${r.limit}`) : "",
    d.storage_quota_mb ? meter("ХРАНИЛИЩЕ", 100 * d.storage_mb / d.storage_quota_mb, `${d.storage_mb} / ${d.storage_quota_mb} МБ`) : "",
    `<div class="diag-foot"><span>ЗАМЕТОК ${d.notes}</span><span>ПАМЯТЬ: ${d.store === "github" ? "GITHUB" : "ДЕМО"}</span>${d.last_sync !== null ? `<span>СИНХР ${d.last_sync} С НАЗАД</span>` : ""}</div>`,
  ].join("");
  updateMetrics();
}

// ---------- настройки (режим «только iPhone») ----------
function openSettings(first = false, error = "") {
  const s = SA.loadSettings();
  const tokens = Object.entries(s.statsTokens || {}).map(([k, v]) => `${k}=${v}`).join("\n");
  const voices = ("speechSynthesis" in window ? speechSynthesis.getVoices() : []).filter((v) => /^(ru|en-GB)/.test(v.lang));
  modal(first ? "ПЕРВЫЙ ЗАПУСК · НАСТРОЙКА" : "НАСТРОЙКИ", `
    ${first ? `<p>Jarvis работает прямо на iPhone. Память — ваше хранилище Obsidian в приватном репозитории GitHub
      (на телефоне его синхронизирует плагин <b>Obsidian Git</b>). Ключи хранятся только на этом устройстве.
      Можно начать без настройки — в демо-режиме заметки останутся в браузере.</p>` : ""}
    ${error ? `<p class="err">${esc(error)}</p>` : ""}
    <form id="set-form">
      <div class="form-row"><label>КАК ОБРАЩАТЬСЯ</label><input name="title" value="${esc(s.title)}"></div>
      <div class="form-row"><label>КЛЮЧ CLAUDE API (console.anthropic.com) — свободная речь, фото</label>
        <input name="anthropicKey" type="password" autocomplete="off" value="${esc(s.anthropicKey)}" placeholder="sk-ant-…"></div>
      <div class="form-row"><label>ТОКЕН GITHUB — память и проекты</label>
        <input name="githubToken" type="password" autocomplete="off" value="${esc(s.githubToken)}" placeholder="github_pat_…"></div>
      <div class="form-row"><label>РЕПОЗИТОРИЙ ПАМЯТИ (владелец/имя)</label>
        <input name="vaultRepo" value="${esc(s.vaultRepo)}" placeholder="c4erepk0/jarvis-vault" autocapitalize="off"></div>
      <div class="form-row"><label>ГОРОД ДЛЯ ПОГОДЫ</label>
        <div class="inline-add" style="margin:0"><input name="city" value="${esc(s.city)}">
        <button type="button" class="btn ghost" id="set-geo">⌖ ЗДЕСЬ</button></div>
        <input type="hidden" name="lat" value="${s.lat}"><input type="hidden" name="lon" value="${s.lon}"></div>
      <div class="form-row"><label>ГОЛОС</label><select name="voiceName"><option value="">автоматически (русский мужской)</option>
        ${voices.map((v) => `<option ${v.name === s.voiceName ? "selected" : ""}>${esc(v.name)}</option>`).join("")}</select></div>
      <div class="form-row"><label>ГЛУБИНА РАЗМЫШЛЕНИЙ CLAUDE</label><select name="effort">
        ${["low", "medium", "high"].map((x) => `<option value="${x}" ${x === s.effort ? "selected" : ""}>${{ low: "быстро (голос)", medium: "сбалансированно", high: "глубоко" }[x]}</option>`).join("")}</select></div>
      <div class="form-row"><label>ТОКЕНЫ МЕТРИК ПРОЕКТОВ (Имя=токен, по строке)</label>
        <textarea name="statsTokens" rows="2" placeholder="IPAStore=…">${esc(tokens)}</textarea></div>
      <p class="err" id="set-err"></p>
      <div class="modal-actions">
        ${first ? `<button type="button" class="btn ghost" id="set-demo">ДЕМО БЕЗ НАСТРОЙКИ</button>` : `<button type="button" class="btn ghost danger" id="set-reset">СБРОСИТЬ</button>`}
        <button class="btn primary">СОХРАНИТЬ</button></div>
    </form>`);
  const f = $("#set-form");
  $("#set-geo").addEventListener("click", () => navigator.geolocation && navigator.geolocation.getCurrentPosition((pos) => {
    f.lat.value = pos.coords.latitude.toFixed(4); f.lon.value = pos.coords.longitude.toFixed(4);
    toast("Координаты обновлены", "ok");
  }, () => toast("Нет доступа к геопозиции", "warn")));
  if ($("#set-demo")) $("#set-demo").addEventListener("click", () => { SA.saveSettings(SA.loadSettings()); location.reload(); });
  if ($("#set-reset")) $("#set-reset").addEventListener("click", () => {
    if (confirm("Удалить ключи и настройки с этого устройства?")) { SA.clearSettings(); location.reload(); }
  });
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const n = { ...s };
    for (const k of ["title", "anthropicKey", "githubToken", "vaultRepo", "city", "voiceName", "effort"]) n[k] = f[k].value.trim();
    n.lat = Number(f.lat.value) || s.lat; n.lon = Number(f.lon.value) || s.lon;
    n.vaultRepo = n.vaultRepo.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
    n.statsTokens = Object.fromEntries(f.statsTokens.value.split("\n").map((l) => l.split("=")).filter((x) => x.length >= 2)
      .map(([k, ...v]) => [k.trim(), v.join("=").trim()]));
    $("#set-err").textContent = "";
    try {
      if (n.githubToken && n.vaultRepo) {
        if (!/^[\w.-]+\/[\w.-]+$/.test(n.vaultRepo)) throw new Error("репозиторий — в виде владелец/имя");
        const info = await SA.checkVaultRepo(n.githubToken, n.vaultRepo);
        n.vaultBranch = info.branch;
        if (!info.private) toast("Внимание: репозиторий памяти публичный — лучше сделать его приватным.", "warn");
      }
      SA.saveSettings(n);
      location.reload();
    } catch (err) { $("#set-err").textContent = err.message; }
  });
}

function offerSeed() {
  renderConfirmsRaw(`<div class="confirm" id="seed-card"><p><b>ПАМЯТЬ ПУСТА</b>Создать в хранилище стартовую структуру:
    задачи, финансы, проекты, протоколы?</p><button class="btn warn" id="seed-yes">СОЗДАТЬ</button></div>`);
  $("#seed-yes").addEventListener("click", async () => {
    $("#seed-card").remove();
    toast("Создаю заметки…", "info");
    try { const n = await SA.seedVault(local); toast(`Готово: заметок — ${n}`, "ok"); refreshSoon("all"); }
    catch (e) { toast(`Не получилось: ${e.message}`, "error"); }
  });
}
function renderConfirmsRaw(html) { $("#confirms").insertAdjacentHTML("afterbegin", html); }

function updateMetrics() {
  if (!S) return;
  const t = S.tasks.summary, total = t.done_today + t.today;
  reactor.setMetrics([
    { label: "ЗАДАЧИ", value: total ? t.done_today / total : 0 },
    { label: "БЮДЖЕТ", value: (S.finance.budget_percent || 0) / 100 },
    { label: "НАГРУЗКА", value: diag ? diag.cpu / 100 : 0 },
  ]);
}

function renderFocus() {
  const el = $("#focus-timer");
  const until = S && S.focus_until;
  if (!until || until * 1000 < Date.now()) { el.classList.add("hidden"); reactor.focus = null; return; }
  reactor.focus = { until, total: 25 * 60 };
  el.classList.remove("hidden");
}
setInterval(() => {
  const el = $("#focus-timer");
  if (S && S.focus_until && S.focus_until * 1000 > Date.now()) {
    const s = Math.round(S.focus_until - Date.now() / 1000);
    el.textContent = `ФОКУС ${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  } else if (!el.classList.contains("hidden")) renderFocus();
}, 1000);

// ---------- журнал, мастерская, уведомления ----------
function renderLog(events) { $("#log").innerHTML = ""; (events || []).forEach(addLog); }
function addLog(e) {
  const d = e.data || {};
  const li = document.createElement("li");
  li.className = e.type === "alert" ? (d.level === "error" ? "error" : d.level === "ok" ? "ok" : "alert") : "";
  const time = new Date((e.ts || Date.now() / 1000) * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  li.innerHTML = `<time>${time}</time><span>${esc(d.text || d.project || e.type)}</span>`;
  const log = $("#log");
  log.prepend(li);
  while (log.children.length > 80) log.lastChild.remove();
}
function workshop(d) {
  $("#p-workshop").classList.remove("hidden");
  const pre = $("#workshop");
  pre.textContent += (d.project ? `[${d.project}] ` : "") + d.text + "\n";
  pre.scrollTop = pre.scrollHeight;
}
function toast(text, level = "info") {
  const el = document.createElement("div");
  el.className = `toast ${level}`;
  el.textContent = text;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 7000);
}

// ---------- модальные окна, заметки ----------
function modal(title, html) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = html;
  $("#modal").classList.remove("hidden");
}
function closeModal() { $("#modal").classList.add("hidden"); }
$("#modal-close").addEventListener("click", closeModal);
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal" || e.target.closest("[data-close]")) closeModal(); });
async function openNote(path) {
  try {
    const n = await api(`/api/note?path=${encodeURIComponent(path)}`);
    modal(path, `<pre>${esc(n.content)}</pre>`);
  } catch (err) { toast(err.message, "error"); }
}

// ---------- ввод ----------
$("#cmd-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#cmd").value;
  $("#cmd").value = "";
  send(v);
});
$("#btn-mic").addEventListener("click", () => {
  voice.unlock();
  if (!voice.supported) { toast("Этот браузер не распознаёт речь. Попробуйте Chrome или Safari.", "warn"); return; }
  voice.listenOnce();
});
$("#reactor-wrap").addEventListener("click", () => { voice.unlock(); if (voice.supported) voice.listenOnce(); });
$("#opt-wake").addEventListener("change", (e) => {
  const on = voice.setWakeMode(e.target.checked);
  e.target.checked = on;
  store.set("wake", on);
  if (e.target.checked && !on) toast("Распознавание речи недоступно в этом браузере.", "warn");
});
$("#opt-fx").checked = store.get("fx", true);
voice.setFx($("#opt-fx").checked);
$("#opt-fx").addEventListener("change", (e) => { voice.setFx(e.target.checked); store.set("fx", e.target.checked); });
$("#opt-mute").addEventListener("change", (e) => {
  voice.muted = e.target.checked;
  store.set("muted", voice.muted);
  api("/api/voice", { method: "POST", body: { muted: voice.muted } }).catch(() => {});
  if (voice.muted && "speechSynthesis" in window) speechSynthesis.cancel();
});
$("#scan-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  $("#heard").textContent = "📷 анализ изображения…";
  setMode("thinking");
  try {
    if (local) {
      const img = await shrinkImage(file);
      showReply(await api("/api/scan", { method: "POST", body: img }));
    } else {
      const form = new FormData();
      form.append("image", file, file.name);
      showReply(await api("/api/scan", { method: "POST", form }));
    }
  } catch (err) { showReply({ text: err.message, kind: "error", speech: "" }); }
});

// Фото с iPhone большие — уменьшаем до 1568 px по длинной стороне (так их видит Claude) и шлём JPEG.
async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const data = c.toDataURL("image/jpeg", 0.85);
  return { base64: data.split(",")[1], mediaType: "image/jpeg" };
}
document.addEventListener("pointerdown", () => {
  voice.unlock();
  if (!greeted && S) { greeted = true; if (store.get("wake", false)) { $("#opt-wake").checked = voice.setWakeMode(true); } }
}, { once: false });
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") {
    e.preventDefault(); $("#cmd").focus();
  }
  if (e.key === "Escape") { closeModal(); }
});

// вкладки на телефоне
function setTab(tab) {
  const map = { core: ".col-center", missions: ".col-left", projects: ".col-right", finance: ".col-right2" };
  $$(".col").forEach((c) => c.classList.remove("active"));
  $(map[tab]).classList.add("active");
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
}
$("#tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setTab(b.dataset.tab); });
setTab("core");

// часы
function tick() {
  const n = new Date();
  $("#clock-time").textContent = n.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  $("#clock-date").textContent = n.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });
}
tick(); setInterval(tick, 1000);

// ---------- голограмма ----------
let holo = null;
$("#btn-holo").addEventListener("click", async () => {
  $("#holo").classList.remove("hidden");
  try {
    const { Hologram } = await import("./hologram.js?v=6");
    if (!holo) holo = new Hologram($("#holo"), { onOpen: openNote, onStatus: (s) => { $("#holo-stats").textContent = s; } });
    else { holo.running = true; requestAnimationFrame(holo.loop); }
    holo.setData(await api("/api/graph"));
  } catch (err) {
    $("#holo-stats").textContent = `голограмма недоступна: ${err.message}`;
  }
});
$("#holo-close").addEventListener("click", () => {
  $("#holo").classList.add("hidden");
  if (tutorial) tutorial.close();
  if (holo) { holo.running = false; holo.disableGestures(); $("#holo-gestures").classList.remove("primary"); }
});

// Первоначальное обучение жестам: показывается при первом включении, повторить — кнопка «?».
let tutorial = null;
async function startCamera() {
  await holo.startGestures($("#holo-video"), $("#holo-hands"));
  $("#holo-gestures").classList.add("primary");
}
async function openTutorial() {
  if (!holo) return;
  try {
    const { GestureTutorial } = await import("./gesture-tutorial.js?v=6");
    tutorial ??= new GestureTutorial({
      root: $("#holo"), holo, startCamera,
      say: (text) => { if (!voice.muted) voice.say(text); },
      onFinish: () => store.set("gestures_trained", true),
      onError: (err) => toast(`Жесты недоступны: ${err.message}`, "error"),
    });
    if (!tutorial.active) tutorial.open();
  } catch (err) { toast(`Обучение недоступно: ${err.message}`, "error"); }
}
$("#holo-gestures").addEventListener("click", async () => {
  if (!holo) return;
  voice.unlock();
  if (!holo.hands && !store.get("gestures_trained", false)) { openTutorial(); return; }
  try {
    const on = await holo.enableGestures($("#holo-video"), $("#holo-hands"));
    $("#holo-gestures").classList.toggle("primary", on);
    if (!on && tutorial) tutorial.close();
  } catch (err) { toast(`Жесты недоступны: ${err.message}`, "error"); }
});
$("#holo-train").addEventListener("click", () => { voice.unlock(); openTutorial(); });

$("#btn-settings").addEventListener("click", () => { if (SA) openSettings(false); });

// PWA
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

boot();
