// Приложение «Настройки и диагностика»: показатели сервера (перенесены сюда с главной), состояние служб,
// ключи и токены (Telegram, Claude, GitHub… и свои), SSH-серверы, версия и обновления с GitHub (вручную —
// с подтверждения, или автоматически раз в N часов), перезапуск. Данные — /api/system/… (только владелец).
// В режиме «только iPhone» сервера нет — показываются диагностика устройства и настройки телефона (standalone.js).
import { esc } from "./markdown.js?v=30";

const TABS = [["diag", "Диагностика"], ["keys", "Ключи и токены"], ["ssh", "SSH-серверы"], ["update", "Обновления"]];
const when = (iso) => (iso ? new Date(iso).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

/** Шкала показателя: подпись, процент (цвет — от 75% и 90%), значение. Общая с главной (если вернут). */
export function meter(label, pct, value) {
  const cls = pct >= 90 ? "bad" : pct >= 75 ? "warn" : "";
  return `<div class="sys-meter"><div class="meter-h">${esc(label)}<b>${esc(value)}</b></div><div class="meter"><i class="${cls}" style="width:${Math.max(0, Math.min(100, pct))}%"></i></div></div>`;
}

export class SystemWindow {
  /** device() — диагностика в режиме «только iPhone»; settings() — открыть настройки телефона (standalone). */
  constructor(root, { api, toast, store, standalone = false, device = null, settings = null, onConfirm = null }) {
    Object.assign(this, { root, api, toast, store, standalone, device, settings, onConfirm });
    this.tab = store.get("sys.tab", "diag");
    this.data = null;
    root.innerHTML = `
      <div class="fw-top">
        <div class="fw-title">Настройки и диагностика <span class="muted" data-el="meta"></span></div>
        <div class="seg fw-tabs" data-el="tabs">${(standalone ? TABS.slice(0, 1) : TABS).map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join("")}</div>
        <button class="btn ghost" data-act="refresh" title="Обновить" aria-label="Обновить">⟳</button>
        <button class="btn ghost" data-act="close" title="Закрыть (Esc)" aria-label="Закрыть">✕</button>
      </div>
      <div class="fw-body sys-body" data-el="body"><p class="empty">Загружаю…</p></div>`;
    this.el = (n) => root.querySelector(`[data-el="${n}"]`);
    root.addEventListener("click", (e) => this.onClick(e));
    root.addEventListener("submit", (e) => this.onSubmit(e));
    root.addEventListener("change", (e) => { if (e.target.matches("[data-auto]")) this.saveAuto(); });
  }

  get isOpen() { return !this.root.classList.contains("hidden"); }

  async show(tab = null) {
    if (tab) this.tab = tab;
    if (this.standalone) this.tab = "diag";
    this.root.classList.remove("hidden");
    document.body.classList.add("fw-on");
    await this.reload();
    clearInterval(this.timer);
    this.timer = setInterval(() => { if (this.isOpen && this.tab === "diag") this.reload({ quiet: true }); }, 15000);
  }

  close() { clearInterval(this.timer); this.root.classList.add("hidden"); document.body.classList.remove("fw-on"); }

  async reload({ quiet = false } = {}) {
    try {
      this.data = this.standalone ? { device: await this.device() } : await this.api("/api/system");
    } catch (e) { if (!quiet) this.toast(e.message, "error"); return; }
    this.render();
  }

  render() {
    this.store.set("sys.tab", this.tab);
    this.root.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === this.tab));
    const d = this.data;
    this.el("meta").textContent = d?.diag?.host || (this.standalone ? "iPhone" : "");
    const restart = d?.settings?.restart_needed
      ? `<div class="sys-banner"><span>Настройки изменены — они вступят в силу после перезапуска Atom.</span>
          ${d.can_restart ? `<button class="btn primary" data-act="restart">Перезапустить</button>` : `<small class="muted">Перезапустите службу: bash scripts/vps.sh update или make run.</small>`}</div>` : "";
    const safe = d?.safe_mode
      ? `<div class="sys-banner warn"><span>Atom запущен без настроек из интерфейса: ${esc(d.safe_mode)}. Исправьте значение и перезапустите.</span></div>` : "";
    this.el("body").innerHTML = safe + restart + (this.standalone ? this.render_device() : this[`render_${this.tab}`]());
  }

  // ---------- диагностика ----------
  render_diag() {
    const d = this.data.diag, v = this.data.version || {};
    const services = this.data.services.map((s) => `<li class="${s.ok ? "ok" : "warn"}"><i></i><b>${esc(s.label)}</b><span>${esc(s.text)}</span></li>`).join("");
    return `<div class="fw-grid">
      <section class="fw-card wide"><h3>Сервер <small class="muted">· ${esc(d.os || "")}</small></h3>
        <div class="sys-meters">
          ${meter("Процессор", d.cpu, `${d.cpu}% · ${d.cores} ядер`)}
          ${meter("Память", d.ram.percent, `${d.ram.used_gb} / ${d.ram.total_gb} ГБ`)}
          ${d.disk ? meter("Диск", d.disk.percent, `свободно ${d.disk.free_gb} из ${d.disk.total_gb} ГБ`) : ""}
          ${meter("Сеть", Math.min(100, (d.net.rx_kbs + d.net.tx_kbs) / 50), `↓ ${d.net.rx_kbs} · ↑ ${d.net.tx_kbs} КБ/с`)}
        </div>
        <div class="sys-facts"><span>Аптайм сервера <b>${d.uptime_h} ч</b></span><span>Atom работает <b>${this.data.atom_uptime_min} мин</b></span>
          <span>Atom в памяти <b>${d.jarvis.rss_mb} МБ</b></span>${d.load ? `<span>Нагрузка <b>${d.load.join(" · ")}</b></span>` : ""}
          ${d.temp ? `<span>Температура <b>${d.temp}°</b></span>` : ""}${d.battery ? `<span>Батарея <b>${d.battery.percent}%${d.battery.plugged ? " ⚡" : ""}</b></span>` : ""}</div>
        ${this.advice(d)}</section>
      <section class="fw-card"><h3>Службы</h3><ul class="sys-services">${services}</ul></section>
      <section class="fw-card"><h3>Версия</h3>${v.git ? `<p><b>${esc(v.commit)}</b> · ${esc(v.subject)}</p>
        <p class="muted small">ветка ${esc(v.branch)} · ${esc(when(v.date))}${v.dirty ? ` · локальных правок: ${v.dirty}` : ""}</p>
        <button class="btn ghost" data-tab="update">Проверить обновления →</button>` : `<p class="muted">${esc(v.reason || "нет данных")}</p>`}</section>
    </div>`;
  }

  /** Подсказка, когда серверу тесно: что сделать или когда пора на тариф побольше. */
  advice(d) {
    const tips = [];
    if (d.ram.percent >= 85) tips.push(`Память занята на ${d.ram.percent}% — перезапустите Atom или возьмите сервер с ${Math.ceil(d.ram.total_gb * 2)} ГБ.`);
    if (d.disk && d.disk.percent >= 85) tips.push(`На диске осталось ${d.disk.free_gb} ГБ — почистите data/tts и журналы или увеличьте диск.`);
    if (d.cpu >= 85) tips.push(`Процессор загружен на ${d.cpu}% — если так постоянно, нужен сервер с ${Math.max(2, d.cores * 2)} ядрами.`);
    return tips.length ? `<ul class="sys-tips">${tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : `<p class="muted small">Ресурсов хватает.</p>`;
  }

  render_device() {
    const d = this.data.device || {};
    const r = d.github_rate;
    return `<div class="fw-grid"><section class="fw-card wide"><h3>Это устройство</h3><div class="sys-meters">
        ${meter("Связь", d.online === false ? 100 : 8, d.online === false ? "нет сети" : "в сети")}
        ${r ? meter("Лимит GitHub", 100 * (1 - r.remaining / r.limit), `${r.remaining} / ${r.limit}`) : ""}
        ${d.storage_quota_mb ? meter("Хранилище браузера", 100 * d.storage_mb / d.storage_quota_mb, `${d.storage_mb} / ${d.storage_quota_mb} МБ`) : ""}</div>
        <div class="sys-facts"><span>Заметок <b>${d.notes ?? "—"}</b></span><span>Память <b>${d.store === "github" ? "GitHub" : "демо"}</b></span>
          ${d.last_sync !== null && d.last_sync !== undefined ? `<span>Синхронизация <b>${d.last_sync} с назад</b></span>` : ""}</div></section>
      <section class="fw-card"><h3>Ключи и настройки</h3><p class="muted small">На iPhone без сервера ключи Claude и GitHub хранятся только на этом устройстве.</p>
        <button class="btn primary" data-act="device-settings">Открыть настройки</button></section></div>`;
  }

  // ---------- ключи и токены ----------
  render_keys() {
    const s = this.data.settings;
    const groups = {};
    for (const k of s.known) (groups[k.group] ||= []).push(k);
    const row = (k) => `<form class="sys-key" data-form="known" data-name="${esc(k.name)}">
      <label><span>${esc(k.label)} <code>${esc(k.name)}</code></span>
        <input name="value" ${k.secret ? `type="password" autocomplete="off" placeholder="${k.set ? `задан: ${esc(k.preview)}` : "не задан"}"` : `value="${esc(k.value || "")}" placeholder="не задано"`}></label>
      <span class="sys-src">${k.source === "ui" ? "из настроек" : k.source === "env" ? "из .env" : ""}</span>
      <button class="btn ghost">Сохранить</button>${k.source === "ui" ? `<button type="button" class="h-btn" data-clear="${esc(k.name)}" title="Убрать значение из настроек (останется .env)" aria-label="Сбросить">↺</button>` : ""}</form>`;
    return `<div class="fw-grid">${Object.entries(groups).map(([g, list]) => `<section class="fw-card"><h3>${esc(g)}</h3>${list.map(row).join("")}</section>`).join("")}
      <section class="fw-card wide"><h3>Свои токены и ключи</h3>
        <p class="muted small">Для чего угодно: API сервисов, метрики проектов. Atom кладёт их в окружение под этим именем — их видят протоколы, проекты и Claude Code.</p>
        <ul class="sys-list">${s.custom.map((c) => `<li><code>${esc(c.name)}</code><span class="muted">${esc(c.preview)}${c.note ? ` · ${esc(c.note)}` : ""}</span>
          <button class="h-btn" data-custom-del="${esc(c.name)}" aria-label="Удалить">✕</button></li>`).join("") || `<li class="empty">Своих токенов пока нет.</li>`}</ul>
        <form class="sys-add" data-form="custom"><input name="name" required placeholder="ИМЯ_ТОКЕНА" autocapitalize="characters" autocomplete="off" pattern="[A-Za-z][A-Za-z0-9_]{1,63}">
          <input name="value" type="password" required placeholder="значение" autocomplete="off"><input name="note" placeholder="для чего (необязательно)" autocomplete="off">
          <button class="btn primary">Добавить</button></form></section>
      <p class="muted small sys-foot">Хранится на сервере в <code>data/settings.json</code> (только владелец, права 600), не в хранилище Obsidian. Значения из настроек главнее <code>.env</code> и вступают в силу после перезапуска.</p></div>`;
  }

  // ---------- SSH ----------
  render_ssh() {
    const list = this.data.settings.ssh;
    const edit = this.editing ? list.find((x) => x.id === this.editing) || {} : null;
    return `<div class="fw-grid">
      <section class="fw-card wide"><h3>Серверы · ${list.length}</h3>
        <ul class="sys-list ssh">${list.map((x) => `<li><b>${esc(x.name)}</b><span class="muted">${esc(x.user)}@${esc(x.host)}:${x.port}${x.has_password ? " · пароль" : ""}${x.has_key ? " · ключ" : ""}${x.note ? ` · ${esc(x.note)}` : ""}</span>
          <span class="sys-ping" data-ping="${esc(x.id)}">${this.pings?.[x.id] || ""}</span>
          <button class="btn ghost" data-ssh-check="${esc(x.id)}">Проверить</button><button class="btn ghost" data-ssh-edit="${esc(x.id)}">✎</button>
          <button class="h-btn" data-ssh-del="${esc(x.id)}" aria-label="Удалить">✕</button></li>`).join("") || `<li class="empty">Добавьте сервер — VPS, где живёт Atom или ваши проекты.</li>`}</ul></section>
      <form class="fw-card sys-ssh" data-form="ssh"><h3>${edit && edit.id ? `Изменить «${esc(edit.name)}»` : "Новый сервер"}</h3>
        <input type="hidden" name="id" value="${esc(edit?.id || "")}">
        <label>Название<input name="name" value="${esc(edit?.name || "")}" placeholder="VPS Timeweb" autocomplete="off"></label>
        <label>Адрес<input name="host" required value="${esc(edit?.host || "")}" placeholder="203.0.113.7" autocomplete="off" autocapitalize="off"></label>
        <label>Порт<input name="port" type="number" min="1" max="65535" value="${edit?.port || 22}"></label>
        <label>Пользователь<input name="user" value="${esc(edit?.user || "root")}" autocomplete="off" autocapitalize="off"></label>
        <label>Пароль<input name="password" type="password" autocomplete="new-password" placeholder="${edit?.has_password ? "задан — оставьте пустым, чтобы не менять" : ""}"></label>
        <label>Закрытый ключ (необязательно)<textarea name="key" rows="3" placeholder="${edit?.has_key ? "задан — оставьте пустым, чтобы не менять" : "-----BEGIN OPENSSH PRIVATE KEY-----"}"></textarea></label>
        <label>Заметка<input name="note" value="${esc(edit?.note || "")}" autocomplete="off"></label>
        <div class="fw-form-acts"><button class="btn primary">Сохранить</button>${edit ? `<button type="button" class="btn ghost" data-act="ssh-cancel">Отмена</button>` : ""}</div>
        <p class="muted small">«Проверить» — доступен ли сервер и отвечает ли SSH (без входа). Пароли и ключи не показываются и не уходят в хранилище.</p></form>
    </div>`;
  }

  // ---------- обновления ----------
  render_update() {
    const v = this.data.version || {}, u = this.data.settings.update, c = this.check || v.last_check;
    if (!v.git) return `<div class="fw-grid"><section class="fw-card wide"><h3>Обновления</h3><p class="muted">${esc(v.reason || "")}</p></section></div>`;
    return `<div class="fw-grid">
      <section class="fw-card wide"><h3>Версия <small class="muted">· ветка ${esc(v.branch)}</small></h3>
        <p><b>${esc(v.commit)}</b> · ${esc(v.subject)} <span class="muted small">· ${esc(when(v.date))}</span></p>
        ${c ? (c.behind ? `<p>На GitHub новее на <b>${c.behind}</b> ${c.behind === 1 ? "коммит" : c.behind < 5 ? "коммита" : "коммитов"}:</p>
          <ul class="sys-commits">${c.commits.map((x) => `<li><code>${esc(x.commit)}</code> ${esc(x.subject)}</li>`).join("")}</ul>`
          : `<p class="muted">Это последняя версия${c.at ? ` · проверено ${esc(new Date(c.at * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }))}` : ""}.</p>`) : ""}
        <div class="mw-acts"><button class="btn ghost" data-act="check">Проверить обновления</button>
          ${c?.behind ? `<button class="btn primary" data-act="apply">Обновить и перезапустить</button>` : ""}</div>
        ${v.dirty ? `<p class="muted small">В коде есть локальные правки (${v.dirty}) — автообновление их не тронет и откажется.</p>` : ""}</section>
      <section class="fw-card"><h3>Автоматически</h3>
        <label class="tw-check"><input type="checkbox" data-auto name="auto" ${u.auto ? "checked" : ""}> Обновляться самому, когда на GitHub есть новое</label>
        <label class="sys-inline">Проверять каждые <input type="number" data-auto name="hours" min="1" max="168" value="${u.hours || 6}"> ч</label>
        <label class="sys-inline">Ветка <input data-auto name="branch" value="${esc(u.branch || "")}" placeholder="${esc(v.branch)}"></label>
        <p class="muted small">Обновление: git fetch → перемотка вперёд → зависимости, если изменились → перезапуск. Если что-то пойдёт не так, Atom останется на текущей версии и напишет в журнал.</p></section>
    </div>`;
  }

  async saveAuto() {
    const q = (n) => this.root.querySelector(`[data-auto][name=${n}]`);
    try {
      const r = await this.api("/api/system/update", { method: "POST", body: { action: "auto", auto: q("auto").checked, hours: Number(q("hours").value) || 6, branch: q("branch").value.trim() } });
      this.data.settings.update = r.update;
      this.toast(r.update.auto ? `Автообновление включено: каждые ${r.update.hours} ч` : "Автообновление выключено", "ok");
    } catch (e) { this.toast(e.message, "error"); }
  }

  // ---------- события ----------
  async onClick(e) {
    const t = e.target;
    const tab = t.closest("[data-tab]");
    if (tab) { this.tab = tab.dataset.tab; this.render(); return; }
    const act = t.closest("[data-act]")?.dataset.act;
    if (act === "close") { this.close(); return; }
    if (act === "refresh") { this.check = null; await this.reload(); return; }
    if (act === "device-settings") { this.close(); this.settings?.(); return; }
    if (act === "ssh-cancel") { this.editing = null; this.render(); return; }
    if (act === "restart") {
      const b = t.closest("button");
      if (!b.dataset.sure) { b.dataset.sure = "1"; b.textContent = "Точно перезапустить?"; return; }
      await this.call(async () => { await this.api("/api/system/restart", { method: "POST", body: {} }); this.toast("Перезапускаюсь — страница переподключится сама", "info"); });
      return;
    }
    if (act === "check") {
      const b = t.closest("button"); b.disabled = true; b.textContent = "Проверяю…";
      try { this.check = await this.api("/api/system/update", { method: "POST", body: { action: "check" } }); } catch (err) { this.toast(err.message, "error"); }
      this.render();
      return;
    }
    if (act === "apply") {
      try {
        const r = await this.api("/api/system/update", { method: "POST", body: { action: "apply" } });
        this.onConfirm?.(r.confirm);
        this.toast("Подтвердите обновление на главной — карточка «Обновить Atom»", "info");
        this.close();
      } catch (err) { this.toast(err.message, "error"); }
      return;
    }
    const clear = t.closest("[data-clear]");
    if (clear) { await this.settingsCall({ action: "known", name: clear.dataset.clear, clear: true }, "Сброшено — после перезапуска будет значение из .env"); return; }
    const cdel = t.closest("[data-custom-del]");
    if (cdel) { await this.settingsCall({ action: "custom", name: cdel.dataset.customDel, remove: true }, "Токен удалён"); return; }
    const chk = t.closest("[data-ssh-check]");
    if (chk) {
      const id = chk.dataset.sshCheck; this.pings = { ...(this.pings || {}), [id]: "…" }; this.render();
      try {
        const r = await this.api("/api/system/ssh", { method: "POST", body: { action: "check", id } });
        this.pings[id] = r.ok ? `✓ ${r.ms} мс` : `✕ ${r.error || "нет ответа"}`;
      } catch (err) { this.pings[id] = `✕ ${err.message}`; }
      this.render();
      return;
    }
    const ed = t.closest("[data-ssh-edit]");
    if (ed) { this.editing = ed.dataset.sshEdit; this.render(); return; }
    const del = t.closest("[data-ssh-del]");
    if (del) {
      if (!del.dataset.sure) { del.dataset.sure = "1"; del.textContent = "?"; del.title = "Нажмите ещё раз — удалить"; return; }
      await this.call(async () => { this.data.settings = await this.api("/api/system/ssh", { method: "POST", body: { action: "remove", id: del.dataset.sshDel } }); });
    }
  }

  async settingsCall(body, okText) {
    await this.call(async () => { this.data.settings = await this.api("/api/system/settings", { method: "POST", body }); this.toast(okText, "ok"); });
  }

  async call(fn) {
    try { await fn(); this.render(); } catch (err) { this.toast(err.message, "error"); }
  }

  async onSubmit(e) {
    const f = e.target.closest("form[data-form]");
    if (!f) return;
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    if (f.dataset.form === "known") {
      const k = this.data.settings.known.find((x) => x.name === f.dataset.name);
      if (k.secret && !v.value) { this.toast("Введите новое значение", "warn"); return; }
      await this.settingsCall({ action: "known", name: f.dataset.name, value: v.value }, `${k.label}: сохранено`);
    } else if (f.dataset.form === "custom") {
      await this.settingsCall({ action: "custom", name: v.name, value: v.value, note: v.note }, `Токен ${v.name.toUpperCase()} сохранён`);
    } else if (f.dataset.form === "ssh") {
      await this.call(async () => {
        this.data.settings = await this.api("/api/system/ssh", { method: "POST", body: { action: "save", ...v, port: Number(v.port) || 22 } });
        this.editing = null;
        this.toast("Сервер сохранён", "ok");
      });
    }
  }
}
