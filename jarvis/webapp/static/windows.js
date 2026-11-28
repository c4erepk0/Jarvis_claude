// Окна Atom — один менеджер вместо девяти одинаковых «загрузить модуль, создать, показать».
// Держит одно окно на экране, помнит открытые (чтобы Esc и переходы работали одинаково) и уважает
// отказ окна закрыться: например, «Хранилище» с несохранённой правкой возвращает false.
// Логика без DOM — тест tests/js/windows.test.mjs.

export class WindowManager {
  constructor() {
    this.defs = new Map();        // id → { load }
    this.instances = new Map();   // id → окно (создаётся лениво, один раз)
    this.stack = [];              // порядок открытия; верхнее — последнее
  }

  /** Окно открывается по id; load() вызывается один раз и только когда окно впервые нужно. */
  register(id, { load }) {
    if (typeof load !== "function") throw new TypeError(`Окну «${id}» нужен load()`);
    this.defs.set(id, { load });
    return this;
  }

  has(id) { return this.defs.has(id); }

  /** Уже созданное окно (или null). Нужно, чтобы обновить открытое окно данными. */
  get(id) { return this.instances.get(id) || null; }

  isOpen(id) { return Boolean(this.instances.get(id)?.isOpen); }

  /** Открыть окно. Другое открытое закрывается; если оно отказалось (несохранённое) — ничего не меняем. */
  async open(id, arg) {
    const def = this.defs.get(id);
    if (!def) throw new Error(`Неизвестное окно: ${id}`);
    const top = this.stack[this.stack.length - 1];
    if (top && top !== id && !this.close(top)) return null;
    let win = this.instances.get(id);
    if (!win) {
      win = await def.load();
      this.instances.set(id, win);
    }
    const show = win.show || win.open;            // AppViewer открывается через open(app)
    if (typeof show !== "function") throw new TypeError(`Окно «${id}» не умеет показываться`);
    await show.call(win, arg);
    this.stack = this.stack.filter((x) => x !== id);
    this.stack.push(id);
    return win;
  }

  /** Закрыть верхнее открытое (или указанное). false — окно попросило не закрывать. */
  close(id = this.stack[this.stack.length - 1]) {
    if (!id) return false;
    const win = this.instances.get(id);
    if (!win) { this.stack = this.stack.filter((x) => x !== id); return false; }
    const dismiss = win.escape || win.close;
    if (typeof dismiss !== "function") return false;
    if (dismiss.call(win) === false) return false;
    this.stack = this.stack.filter((x) => x !== id);
    return true;
  }

  /** Esc: верхнее окно, которое действительно открыто. Окна могли закрыться сами — чистим стек. */
  dismiss() {
    for (let i = this.stack.length - 1; i >= 0; i -= 1) {
      const id = this.stack[i];
      if (this.isOpen(id)) return this.close(id);
      this.stack.splice(i, 1);
    }
    return false;
  }

  anyOpen() { return this.stack.some((id) => this.isOpen(id)); }
}
