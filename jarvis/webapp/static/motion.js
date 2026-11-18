// Плавность интерфейса без библиотек: счётчики «докручиваются» до нового значения, панели появляются по очереди.
// Логика без DOM — tween/ease (тест — tests/js/motion.test.mjs). «Уменьшить движение» в системе — всё сразу.
export const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export const easeOutCubic = (t) => 1 - (1 - Math.max(0, Math.min(1, t))) ** 3;

/** Значение между from и to на доле t (0..1) с замедлением к концу. */
export function tween(from, to, t, ease = easeOutCubic) { return from + (to - from) * ease(t); }

/** Из «−10 812,50 ₽» достать число и обёртку, чтобы крутить только цифры. null — числа нет. */
export function splitNumber(text) {
  const m = /^(.*?)([−-]?)(\d[\d\s  ]*(?:,\d+)?)(.*)$/su.exec(String(text));
  if (!m) return null;
  const digits = m[3].replace(/[\s  ]/g, "");
  const frac = digits.includes(",") ? digits.split(",")[1].length : 0;
  const value = Number(digits.replace(",", ".")) * (m[2] ? -1 : 1);
  return Number.isFinite(value) ? { prefix: m[1], value, frac, suffix: m[4] } : null;
}

export function formatLike(value, { prefix, frac, suffix }) {
  const sign = value < 0 ? "−" : "";
  const s = Math.abs(value).toLocaleString("ru-RU", { minimumFractionDigits: frac, maximumFractionDigits: frac });
  return `${prefix}${sign}${s}${suffix}`;
}

/** Показать текст в элементе: если в нём число — докрутить от прежнего значения за ms. */
export function countTo(el, text, ms = 700) {
  if (!el) return;
  const to = splitNumber(text), from = splitNumber(el.dataset.shown ?? el.textContent);
  el.dataset.shown = text;
  cancelAnimationFrame(el._raf);
  if (!to || !from || reduced() || from.value === to.value || typeof requestAnimationFrame !== "function") { el.textContent = text; return; }
  const t0 = performance.now();
  const step = (now) => {
    const t = (now - t0) / ms;
    if (t >= 1) { el.textContent = text; return; }
    el.textContent = formatLike(tween(from.value, to.value, t), to);
    el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

/** Панели появляются по очереди: каждой — свой --i для задержки анимации (CSS .rise). */
export function stagger(nodes, cls = "rise") {
  [...nodes].forEach((n, i) => { n.style.setProperty("--i", String(i)); n.classList.add(cls); });
}
