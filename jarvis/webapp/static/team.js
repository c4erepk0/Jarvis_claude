// Операторы в интерфейсе — помощники без DOM (тест — tests/js/team.test.mjs): ссылка-приглашение, статусы,
// лента чата по дням, относительное «был в сети».
export const STATUS = { invited: "приглашён", active: "в работе", disabled: "отключён", expired: "приглашение истекло" };

/** Что показывать в «Команде»: на телефоне — сначала весь список, затем карточка выбранного с «←»;
 *  на компьютере — список и карточка рядом. Без этого список уезжал в горизонтальную карусель. */
export function opsView({ mobile = false, selected = null, creating = false } = {}) {
  const detail = Boolean(selected) || Boolean(creating) || !mobile;
  return { detail, listOnly: !detail };
}

/** Код приглашения из ссылки «https://…/?invite=КОД» или из самого кода. */
export function inviteToken(text) {
  const s = String(text || "").trim();
  const m = /[?&#]invite=([\w-]+)/.exec(s);
  if (m) return m[1];
  return /^[\w-]{16,}$/.test(s) ? s : "";
}

export const inviteLink = (origin, token) => `${String(origin).replace(/\/+$/, "")}/?invite=${encodeURIComponent(token)}`;

/** Сообщения → группы по дням: [{ day: "2026-11-19", label: "Сегодня", items }]. */
export function chatDays(messages, today) {
  const out = [];
  const yesterday = (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
  for (const m of messages) {
    let g = out[out.length - 1];
    if (!g || g.day !== m.date) {
      const label = m.date === today ? "Сегодня" : m.date === yesterday ? "Вчера" : `${m.date.slice(8)}.${m.date.slice(5, 7)}.${m.date.slice(0, 4)}`;
      g = { day: m.date, label, items: [] };
      out.push(g);
    }
    g.items.push(m);
  }
  return out;
}

/** «был(а) в сети 5 мин назад» по unix-времени. */
export function seen(ts, now = Date.now() / 1000) {
  if (!ts) return "ещё не заходил(а)";
  const s = Math.max(0, now - ts);
  if (s < 120) return "в сети";
  if (s < 3600) return `был(а) ${Math.round(s / 60)} мин назад`;
  if (s < 86400) return `был(а) ${Math.round(s / 3600)} ч назад`;
  return `был(а) ${Math.round(s / 86400)} дн назад`;
}
