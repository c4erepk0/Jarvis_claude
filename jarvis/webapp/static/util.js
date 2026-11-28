// Общие мелочи интерфейса. Раньше `esc` был скопирован в шести файлах (в трёх — без апострофа),
// а «сегодня» собиралось вручную в четырёх местах. Теперь один экземпляр на всё приложение.
// Логика без DOM — тест tests/js/util.test.mjs.

/** Экранирование текста и атрибутов. Единственная реализация: `'` тоже закрываем. */
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

/** Дата в хранилище — всегда ISO `ГГГГ-ММ-ДД` (правило проекта). Принимает Date, ISO-строку или пустое. */
export function todayISO(value = new Date()) {
  if (typeof value === "string") {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
    if (m) return m[1];
    value = new Date(value);
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return "";
  const d = value;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Короткая дата для человека: «пн, 24 ноя». Пустая дата — свой текст (по умолчанию пусто). */
export const fmtDay = (iso, { empty = "" } = {}) => (iso
  ? new Date(`${iso}T00:00`).toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "short" })
  : empty);

/** Русское склонение по числу: plural(2, ["задача", "задачи", "задач"]) → «задачи». */
export function plural(n, [one, few, many]) {
  const a = Math.abs(Number(n) || 0) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
