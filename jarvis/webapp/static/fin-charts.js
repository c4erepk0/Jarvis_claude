// Графики финансов без библиотек и без DOM — строки SVG (тест — tests/js/fin-charts.test.mjs).
// Цвета — через CSS-классы (.fc-*), поэтому графики следуют теме дашборда.
import { esc } from "./util.js?v=33";

export { esc };
const SYM = { RUB: "₽", USD: "$", EUR: "€" };
export function money(k, cur = "RUB", { signed = false, short = false } = {}) {
  const sign = k < 0 ? "−" : signed && k > 0 ? "+" : "";
  const v = Math.abs(k) / 100;
  if (short && v >= 1e6) return `${sign}${(v / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млн ${SYM[cur] || cur}`;
  if (short && v >= 1e4) return `${sign}${Math.round(v / 1e3).toLocaleString("ru-RU")} тыс ${SYM[cur] || cur}`;
  return `${sign}${v.toLocaleString("ru-RU", { maximumFractionDigits: v % 1 ? 2 : 0 })} ${SYM[cur] || cur}`;
}
const MON = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
export const monthShort = (m) => MON[Number(String(m).slice(5, 7)) - 1] || String(m);

/** Доходы и расходы по месяцам: пара столбиков на месяц, линия — разница (сбережения). */
export function trendBars(trend, { w = 900, h = 220, currency = "RUB" } = {}) {
  if (!trend || !trend.length) return "";
  const padB = 22, padT = 10, inner = h - padB - padT;
  const max = Math.max(1, ...trend.map((t) => Math.max(t.income, t.expense)));
  const slot = w / trend.length, bw = Math.max(4, Math.min(22, slot * 0.28));
  const y = (v) => padT + inner - (v / max) * inner;
  const parts = [`<line class="fc-axis" x1="0" x2="${w}" y1="${y(0)}" y2="${y(0)}"/>`];
  const pts = [];
  trend.forEach((t, i) => {
    const cx = slot * i + slot / 2;
    const title = `${monthShort(t.month)}: доход ${money(t.income, currency)}, расход ${money(t.expense, currency)}`;
    parts.push(`<g><title>${esc(title)}</title>`
      + `<rect class="fc-inc" x="${(cx - bw - 1).toFixed(1)}" y="${y(t.income).toFixed(1)}" width="${bw.toFixed(1)}" height="${(y(0) - y(t.income)).toFixed(1)}" rx="2"/>`
      + `<rect class="fc-exp" x="${(cx + 1).toFixed(1)}" y="${y(t.expense).toFixed(1)}" width="${bw.toFixed(1)}" height="${(y(0) - y(t.expense)).toFixed(1)}" rx="2"/>`
      + `<text class="fc-lbl" x="${cx.toFixed(1)}" y="${h - 6}">${esc(monthShort(t.month))}</text></g>`);
    if (t.count) pts.push([cx, y(Math.max(0, t.net))]);
  });
  if (pts.length > 1) parts.push(`<polyline class="fc-net" points="${pts.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(" ")}"/>`);
  return `<svg class="fc" viewBox="0 0 ${w} ${h}" role="img" aria-label="Доходы и расходы по месяцам">${parts.join("")}</svg>`;
}

/** Линия капитала по дням (history из /api/finance/assets). */
export function sparkline(values, { w = 280, h = 56 } = {}) {
  const v = (values || []).filter((x) => Number.isFinite(x));
  if (v.length < 2) return "";
  const min = Math.min(...v), max = Math.max(...v), span = max - min || 1;
  const pts = v.map((x, i) => [(i / (v.length - 1)) * w, h - 4 - ((x - min) / span) * (h - 8)]);
  const line = pts.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(" ");
  const up = v[v.length - 1] >= v[0];
  return `<svg class="fc spark ${up ? "up" : "down"}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Динамика капитала">`
    + `<polygon class="fc-area" points="0,${h} ${line} ${w},${h}"/><polyline class="fc-line" points="${line}"/></svg>`;
}

/** Кольцо долей (структура активов). parts: [{label, value}]. */
export function donut(parts, { size = 132, stroke = 16 } = {}) {
  const total = (parts || []).reduce((s, p) => s + Math.max(0, p.value), 0);
  if (!total) return "";
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  let off = 0;
  const segs = parts.map((p, i) => {
    const len = (Math.max(0, p.value) / total) * c;
    const seg = `<circle class="fc-seg s${i % 8}" cx="${size / 2}" cy="${size / 2}" r="${r.toFixed(2)}" stroke-width="${stroke}"`
      + ` stroke-dasharray="${Math.max(0, len - 1.5).toFixed(2)} ${c.toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"><title>${esc(p.label)}</title></circle>`;
    off += len;
    return seg;
  });
  return `<svg class="fc donut" viewBox="0 0 ${size} ${size}" role="img" aria-label="Структура активов">`
    + `<g transform="rotate(-90 ${size / 2} ${size / 2})">${segs.join("")}</g></svg>`;
}

/**
 * Столбики 3D-карты расходов (категория × месяц) из analytics.matrix: позиции на сетке, высота 0..1,
 * подпись. Пустые клетки — тоже столбики нулевой высоты (сетка видна целиком).
 */
export function barGrid(matrix, { gap = 1.4 } = {}) {
  const cats = matrix?.categories || [], months = matrix?.months || [];
  const max = Math.max(1, ...((matrix?.values || []).flat()));
  const bars = [];
  cats.forEach((c, ci) => months.forEach((m, mi) => {
    const v = matrix.values[ci]?.[mi] || 0;
    bars.push({ category: c, month: m, value: v, h: v / max, ci, mi,
      x: (mi - (months.length - 1) / 2) * gap, z: (ci - (cats.length - 1) / 2) * gap });
  }));
  return { bars, max, width: months.length * gap, depth: cats.length * gap };
}
