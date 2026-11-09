// Жесты для заметки в голограмме: что делает поза в каждом режиме панели, история переходов между
// заметками (взмах ладонью — назад/вперёд) и диктовка строки голосом. Без DOM — тест в node --test.

/**
 * Действие с заметкой для жеста. gesture: fist | thumb | victory | swipe-left | swipe-right (ладонь — сброс вида,
 * её обрабатывает голограмма). s: { mode, dirty, editable, armed, back, forward, dictation }.
 * Возвращает { act, label } или null, если сейчас этот жест к заметке не относится.
 */
export function noteAction(gesture, s) {
  switch (s.mode) {
    case "view":
      if (gesture === "fist") return { act: "close", label: "закрыть заметку" };
      if (gesture === "victory" && s.editable) return { act: "edit", label: "править заметку" };
      // как листают страницы: ладонь вправо — назад, влево — вперёд
      if (gesture === "swipe-right" && s.back) return { act: "back", label: "предыдущая заметка" };
      if (gesture === "swipe-left" && s.forward) return { act: "forward", label: "следующая заметка" };
      return null;
    case "edit":
      if (gesture === "thumb") return { act: "save", label: "сохранить" };
      if (gesture === "victory" && s.dictation) return { act: "dictate", label: "диктовать строку" };
      if (gesture === "fist") {
        if (!s.dirty) return { act: "cancel", label: "закончить правку" };
        // несохранённые правки молча не выбрасываем: первый кулак — предупреждение, второй — выбросить
        return s.armed ? { act: "cancel", label: "выбросить правки" } : { act: "arm", label: "отменить правку" };
      }
      return null;
    case "create":
      if (gesture === "thumb") return { act: "submit", label: "создать заметку" };
      if (gesture === "victory" && s.dictation) return { act: "dictate-name", label: "продиктовать название" };
      if (gesture === "fist") return { act: "leave", label: "не создавать" };
      return null;
    case "conflict":
      if (gesture === "fist") return { act: "back-edit", label: "вернуться к правке" };
      return null;
    default:
      return null;
  }
}

/** История открытых заметок, как в браузере: открыли новую — «вперёд» обрезается. */
export class Trail {
  constructor(limit = 50) {
    this.items = [];
    this.at = -1;
    this.limit = limit;
  }

  visit(path) {
    if (this.items[this.at] === path) return;
    this.items = this.items.slice(0, this.at + 1);
    this.items.push(path);
    if (this.items.length > this.limit) this.items.shift();
    this.at = this.items.length - 1;
  }

  get back() { return this.at > 0 ? this.items[this.at - 1] : null; }
  get forward() { return this.at >= 0 && this.at < this.items.length - 1 ? this.items[this.at + 1] : null; }

  /** Сдвинуться на step (-1 назад, +1 вперёд) после того, как заметка открылась. */
  move(step) {
    const at = this.at + step;
    if (at < 0 || at >= this.items.length) return null;
    this.at = at;
    return this.items[at];
  }

  /** Заметку удалили или переименовали — убрать из истории. */
  drop(path) {
    const i = this.items.indexOf(path);
    if (i < 0) return;
    this.items.splice(i, 1);
    if (this.at >= i) this.at = Math.max(this.items.length ? 0 : -1, this.at - 1);
  }

  clear() { this.items = []; this.at = -1; }
}

// ---------- диктовка ----------
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const MARK = /^\s*(?:- \[[ xX]\] |[-*+] |#{1,6} |\d+[.)] )/;      // маркер в начале строки: задача, пункт, заголовок

/** Фраза с голоса → строка заметки. «Задача купить молоко» → «- [ ] Купить молоко», «пункт …» → «- …»,
 *  «заголовок …» → «## …»; остальное — как сказано, с заглавной буквы. */
export function dictationLine(text) {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  const m = t.match(/^(задач[аиуе]|пункт|заголовок)[\s,.:—-]+(.+)$/i);
  if (!m) return cap(t);
  const word = m[1].toLowerCase(), body = cap(m[2].trim());
  if (word.startsWith("задач")) return `- [ ] ${body}`;
  return word === "пункт" ? `- ${body}` : `## ${body}`;
}

/** Вставить продиктованное в текст у курсора. Пустая строка или строка из одного маркера («- [ ] ») —
 *  дописываем в неё; иначе — новой строкой после текущей. Возвращает { value, cursor } или null. */
export function insertDictation(value, cursor, text) {
  const line = dictationLine(text);
  if (!line) return null;
  const at = Math.max(0, Math.min(cursor ?? value.length, value.length));
  const start = value.lastIndexOf("\n", at - 1) + 1;
  let end = value.indexOf("\n", at);
  if (end < 0) end = value.length;
  const cur = value.slice(start, end);
  const marker = cur.match(MARK);
  if (!cur.trim() || (marker && marker[0].length === cur.length)) {
    // маркер уже стоит («☐ задача» нажали пальцем) — второй не добавляем
    const add = marker ? line.replace(MARK, "") : line;
    const before = value.slice(0, end);
    return { value: before + add + value.slice(end), cursor: before.length + add.length };
  }
  const add = `\n${line}`;
  return { value: value.slice(0, end) + add + value.slice(end), cursor: end + add.length };
}
