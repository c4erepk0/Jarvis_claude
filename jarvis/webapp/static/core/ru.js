// Русский язык: даты в речи («завтра», «в пятницу», «12 ноября»), суммы («1,5к»), склонения, деньги.
// Порт jarvis/ru.py — формат одинаковый, чтобы сервер и iPhone работали с одним хранилищем.

export const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа",
  "сентября", "октября", "ноября", "декабря"];
export const MONTHS_NOM = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август",
  "сентябрь", "октябрь", "ноябрь", "декабрь"];
export const WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];
const WEEKDAY_FORMS = [["понедельник"], ["вторник"], ["среду", "среда"], ["четверг"], ["пятницу", "пятница"],
  ["субботу", "суббота"], ["воскресенье"]];
const NUM_WORDS = { один: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8,
  девять: 9, десять: 10, пятнадцать: 15, двадцать: 20, тридцать: 30, сорок: 40, пару: 2, несколько: 3 };

// ---------- даты без часовых поясов: «день» = строка YYYY-MM-DD ----------
export function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function parseDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(iso, n) {
  const d = parseDay(iso);
  d.setDate(d.getDate() + n);
  return isoDay(d);
}
export function weekdayIndex(iso) { return (parseDay(iso).getDay() + 6) % 7; }   // 0 — понедельник
function safeDay(y, m, d) {
  const dt = new Date(y, m - 1, d);
  return dt.getMonth() === m - 1 && dt.getDate() === d ? isoDay(dt) : null;
}
function addMonths(iso, n) {
  const d = parseDay(iso);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return isoDay(d);
}

export function plural(n, one, few, many) {
  n = Math.abs(Math.trunc(n));
  if (n % 10 === 1 && n % 100 !== 11) return one;
  if (n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14)) return few;
  return many;
}

export function humanDate(iso, ref) {
  const delta = Math.round((parseDay(iso) - parseDay(ref)) / 86400000);
  if (delta === 0) return "сегодня";
  if (delta === 1) return "завтра";
  if (delta === -1) return "вчера";
  if (delta === 2) return "послезавтра";
  const d = parseDay(iso);
  const s = `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
  return d.getFullYear() === parseDay(ref).getFullYear() ? s : `${s} ${d.getFullYear()}`;
}

export function money(kopecks, currency = "RUB", signed = false) {
  const sign = kopecks < 0 ? "−" : signed && kopecks > 0 ? "+" : "";
  const v = Math.abs(kopecks);
  const rub = Math.floor(v / 100), kop = v % 100;
  const whole = String(rub).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const sym = { RUB: "₽", USD: "$", EUR: "€" }[currency] || currency;
  return `${sign}${whole}${kop ? "," + String(kop).padStart(2, "0") : ""} ${sym}`;
}

const MONTH_ALT = MONTHS_GEN.join("|");
const DATE_PATTERNS = [
  /(?<![а-яё])(?:до |к |на )?сегодня(?:шн[а-яё]*)?(?![а-яё])/i,
  /(?<![а-яё])(?:до |к |на )?послезавтра(?![а-яё])/i,
  /(?<![а-яё])(?:до |к |на )?завтра(?![а-яё])/i,
  /(?<![а-яё])через (?:(\d+|[а-яё]+) )?(день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев)(?![а-яё])/i,
  /(?<![а-яё])(?:в|во|до|к|на) (?:следующ[а-яё]+ )?(понедельник|вторник|среду|среда|четверг|пятницу|пятница|субботу|суббота|воскресенье)(?![а-яё])/i,
  new RegExp(`(?<![а-яё\\d])(?:до |к |на )?(\\d{1,2}) (${MONTH_ALT})(?: (\\d{4}))?(?![а-яё])`, "i"),
  /(?<![\d.])(?:до |к |на )?(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?![\d.])/,
  /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/,
];
const num = (w) => (!w ? 1 : /^\d+$/.test(w) ? Number(w) : NUM_WORDS[w.toLowerCase()] || 1);

export function parseDate(text, ref) {
  for (let i = 0; i < DATE_PATTERNS.length; i++) {
    const m = DATE_PATTERNS[i].exec(text);
    if (!m) continue;
    const frag = m[0].toLowerCase();
    let d = null;
    if (i === 0) d = ref;
    else if (i === 1) d = addDays(ref, 2);
    else if (i === 2) d = addDays(ref, 1);
    else if (i === 3) {
      const n = num(m[1]), unit = m[2].toLowerCase();
      d = unit.startsWith("нед") ? addDays(ref, 7 * n) : unit.startsWith("месяц") ? addMonths(ref, n) : addDays(ref, n);
    } else if (i === 4) {
      const wd = WEEKDAY_FORMS.findIndex((f) => f.includes(m[1].toLowerCase()));
      const ahead = ((wd - weekdayIndex(ref)) % 7 + 7) % 7 || 7;
      d = addDays(ref, ahead);
    } else if (i === 5 || i === 6) {
      const day = Number(m[1]);
      const month = i === 5 ? MONTHS_GEN.indexOf(m[2].toLowerCase()) + 1 : Number(m[2]);
      let year = m[3] ? Number(m[3]) : parseDay(ref).getFullYear();
      if (year < 100) year += 2000;
      d = safeDay(year, month, day);
      if (d && !m[3] && d < ref) d = safeDay(year + 1, month, day);
    } else {
      d = safeDay(Number(m[1]), Number(m[2]), Number(m[3]));
    }
    if (!d) continue;
    void frag;
    const cleaned = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/\s{2,}/g, " ").trim()
      .replace(/^[ ,.]+|[ ,.]+$/g, "");
    return [d, cleaned];
  }
  return [null, text];
}

export function parseDuration(text) {
  const m = /(?<![а-яё])через (полчаса|час|(\d+|[а-яё]+) (минуту|минуты|минут|час|часа|часов|секунд|секунды))(?![а-яё])/i.exec(text);
  if (!m) return [null, text];
  let seconds;
  if (m[1].toLowerCase() === "полчаса") seconds = 1800;
  else if (m[1].toLowerCase() === "час") seconds = 3600;
  else {
    const n = num(m[2]), unit = m[3].toLowerCase();
    seconds = unit.startsWith("час") ? n * 3600 : unit.startsWith("секунд") ? n : n * 60;
  }
  const rest = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/\s{2,}/g, " ").trim()
    .replace(/^[ ,.]+|[ ,.]+$/g, "");
  return [seconds, rest];
}

const AMOUNT = /(?<![\w.,])([+\-−]?\s?\d[\d\s ]*(?:[.,]\d{1,2})?)\s*(к|k|тыс\.?|тысяч[аи]?|косар[а-яё]*|т\.р\.?)?\s*(?:₽|руб[а-яё]*|р(?![а-яё])|р\.)?/gi;

export function parseAmount(text) {
  AMOUNT.lastIndex = 0;
  let m;
  while ((m = AMOUNT.exec(text))) {
    if (!m[0]) { AMOUNT.lastIndex++; continue; }
    const digits = m[1].replace(/[\s ]/g, "").replace("−", "-").replace(",", ".");
    if (!/\d/.test(digits)) continue;
    let value = Number(digits);
    if (Number.isNaN(value)) continue;
    if (m[2]) value *= 1000;
    const rest = (text.slice(0, m.index) + " " + text.slice(m.index + m[0].length)).replace(/\s{2,}/g, " ").trim()
      .replace(/^[ ,.]+|[ ,.]+$/g, "");
    return [Math.round(value * 100), rest];
  }
  return [null, text];
}

export function parseMoneyCell(cell) {
  const s = cell.trim().replace(/[\s ₽$€]|руб\.?/g, "").replace("−", "-").replace(",", ".");
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

export function greeting(hour) {
  if (hour >= 5 && hour < 12) return "Доброе утро";
  if (hour >= 12 && hour < 18) return "Добрый день";
  if (hour >= 18 && hour < 23) return "Добрый вечер";
  return "Доброй ночи";
}

// Текст для голоса: модели любят markdown (**жирный**, списки, ссылки) — читать его вслух не нужно.
// То же — speech_text в jarvis/ru.py.
export function speechText(text) {
  let t = String(text || "").replace(/```[\s\S]*?```/g, " ");
  t = t.replace(/!?\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/!?\[\[([^\]]+)\]\]/g, "$1");
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/^\s*>\s?(?:\[![^\]]*\]\s*)?/gm, "");
  t = t.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "");
  t = t.replace(/(\*\*|__|~~|==)(.+?)\1/g, "$2");
  t = t.replace(/(?<![\p{L}\p{N}_*])[*_]([^*_\n]+)[*_](?![\p{L}\p{N}_*])/gu, "$1");
  t = t.replace(/`/g, "");
  const parts = [];
  for (const raw of t.split("\n")) {
    const line = raw.trim();
    if (!line || /^[-*_=|: ]{3,}$/.test(line)) continue;
    if (parts.length && !/[.!?…:;,]$/.test(parts[parts.length - 1])) parts[parts.length - 1] += ".";
    parts.push(line);
  }
  return parts.join(" ");
}
