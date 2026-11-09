// Логика первоначального обучения жестам (без DOM — проверяется в node --test).
// Голограмма присылает события: { type: "frame", kind } на каждый кадр камеры, { type: "rotate", amount },
// { type: "zoom", amount }, { type: "reset" }, { type: "dwell", progress, press }, { type: "select", id },
// { type: "press" } (палец нажал кнопку), { type: "hold", kind, progress } и { type: "pose", kind } (удержание
// ✊ ✌ 👍 ✋), { type: "swipe", dir }. Шаг засчитывается только когда жест действительно распознан камерой.

/** Версия обучения: кто прошёл прежнюю (без жестов для заметок), тому показываем только новые шаги. */
export const TRAINING_VERSION = 2;
export const NEW_STEPS_FROM = "press";

export const STEPS = [
  {
    id: "intro", manual: true, pose: "intro", title: "Перед началом",
    text: "Поставьте iPhone вертикально на опору экраном к себе и отойдите на 40–60 см. Свет — спереди, не из-за спины. "
      + "Камера работает только в этом браузере: кадры никуда не отправляются.",
    speech: "Начнём калибровку жестов, сэр. Поставьте телефон на опору и отойдите на полметра.",
  },
  {
    id: "hand", goal: "hold", kinds: ["hand", "point", "pinch", "pinch2", "palm", "victory", "thumb", "fist"], ms: 800, pose: "palm",
    title: "Покажите руку", text: "Поднимите руку перед камерой, чтобы она целиком была в кадре.",
    speech: "Покажите мне руку, сэр.", praise: "Вижу вас.",
  },
  {
    id: "point", goal: "hold", kinds: ["point"], ms: 1000, pose: "point",
    title: "Указка", text: "Вытяните указательный палец, остальные сожмите в кулак. По голограмме поедет курсор — водите им.",
    speech: "Вытяните указательный палец. Это ваш курсор.", praise: "Курсор ваш.",
  },
  {
    id: "rotate", goal: "sum", event: "rotate", need: 1.5, pose: "pinch", anim: "slide",
    title: "Щипок — вращение",
    text: "Сведите большой и указательный пальцы и, не разжимая, ведите руку в сторону — голограмма поворачивается следом.",
    speech: "Сведите большой и указательный пальцы и ведите руку в сторону.", praise: "Превосходно.",
  },
  {
    id: "zoom", goal: "sum", event: "zoom", need: 40, pose: "pinch2", anim: "spread",
    title: "Две руки — масштаб",
    text: "Щипок обеими руками: разводите руки — приблизить, сводите — отдалить. "
      + "Если телефон у вас в руке — пропустите шаг: экран масштабируется и двумя пальцами.",
    speech: "Щипок обеими руками. Разведите их — я приближу.", praise: "Масштаб под контролем.",
  },
  {
    id: "palm", goal: "event", event: "reset", holdKind: "palm", ms: 1000, pose: "palm", anim: "pulse",
    title: "Ладонь — сброс", text: "Раскройте ладонь и задержите на секунду — вид вернётся в исходное положение.",
    speech: "Раскройте ладонь и задержите на секунду.", praise: "Вид сброшен.",
  },
  {
    id: "select", goal: "event", event: "select", progressEvent: "dwell", press: false, pose: "point", anim: "target",
    needsNodes: true, title: "Открыть заметку",
    text: "Наведите палец на светящийся узел и задержите, пока кольцо курсора не замкнётся. После обучения так открываются заметки.",
    speech: "Наведите палец на любую заметку и задержите.", praise: "Цель захвачена.",
  },
  {
    id: "press", goal: "event", event: "press", progressEvent: "dwell", press: true, pose: "point", anim: "press",
    title: "Палец на кнопке — нажать",
    text: "Наведите палец на кнопку «НАЖМИ МЕНЯ» ниже и задержите на секунду. Так же в заметке нажимаются кнопки, "
      + "отмечаются галочки задач и открываются [[ссылки]]. А щипок над текстом заметки листает его.",
    speech: "Наведите палец на кнопку внизу и задержите. Так нажимаются кнопки в заметке.", praise: "Нажато.",
  },
  {
    id: "victory", goal: "pose", kind: "victory", pose: "victory", anim: "pulse", title: "Два пальца — править",
    text: "Покажите два пальца (✌) и задержите: открытая заметка перейдёт в правку. В правке ✌ — продиктовать строку "
      + "голосом: «задача купить молоко» станет задачей.",
    speech: "Покажите два пальца — так заметка открывается для правки.", praise: "Есть.",
  },
  {
    id: "thumb", goal: "pose", kind: "thumb", pose: "thumb", anim: "pulse", title: "Большой палец — сохранить",
    text: "Большой палец вверх (👍), остальные сжаты, — задержите. Правка сохранится, новая заметка — создастся.",
    speech: "Большой палец вверх — и я сохраню правку.", praise: "Принято.",
  },
  {
    id: "fist", goal: "pose", kind: "fist", pose: "fist", anim: "pulse", title: "Кулак — закрыть",
    text: "Сожмите кулак (✊) и задержите — заметка закроется, правка — отменится. Если есть несохранённые правки, "
      + "Jarvis переспросит: ✊ ещё раз — выбросить, 👍 — сохранить.",
    speech: "Сожмите кулак — заметка закроется.", praise: "Закрыто.",
  },
  {
    id: "swipe", goal: "event", event: "swipe", pose: "palm", anim: "swipe", title: "Взмах ладонью — листать",
    text: "Раскрытой ладонью быстро проведите вбок. С открытой заметкой: вправо — предыдущая, влево — следующая. "
      + "Без заметки взмах поворачивает граф.",
    speech: "Взмахните ладонью в сторону.", praise: "Отлично.",
  },
  {
    id: "done", manual: true, pose: "done", title: "Готово, сэр",
    text: "☝ указка — курсор; палец 1 с на узле — открыть заметку, на кнопке или задаче — нажать\n"
      + "🤏 щипок и движение — вращать, над заметкой — листать\n🤏🤏 две руки — масштаб\n✋ ладонь 1 с — сброс вида\n"
      + "👋 взмах — предыдущая / следующая заметка\n✌ — править, в правке — диктовать\n👍 — сохранить\n✊ — закрыть\n"
      + "Повторить обучение — кнопка «?» вверху.",
    speech: "Калибровка завершена. Жесты в вашем распоряжении, сэр.",
  },
];

export class GestureCoach {
  /** start — id шага, с которого начать (только новые жесты: NEW_STEPS_FROM). */
  constructor(steps = STEPS, { graceMs = 300, hasNodes = true, start = null } = {}) {
    this.steps = steps;
    this.graceMs = graceMs;   // MediaPipe иногда теряет руку на кадр-другой — не сбрасываем удержание
    this.hasNodes = hasNodes;
    this.first = Math.max(0, start ? steps.findIndex((s) => s.id === start) : 0);
    this.i = this.first;
    this.lastKind = "none";
    this.lastHandAt = null;
    this.startedAt = null;
    this.selected = null;
    this.resetStep();
  }

  get step() { return this.steps[this.i]; }
  get index() { return this.i; }
  /** Номер шага среди действий (без вступления и итога) и их число — для «ШАГ 2/6». */
  get counter() {
    const acts = this.steps.slice(this.first).filter((s) => !s.manual);
    return { n: acts.indexOf(this.step) + 1, total: acts.length };
  }
  get finished() { return this.i >= this.steps.length - 1 && this.step.manual; }

  resetStep(now = null) {
    this.progress = 0;
    this.sum = 0;
    this.holdSince = null;
    this.lastMatch = null;
    this.complete = false;
    this.startedAt = now;
  }

  /** Перейти к следующему шагу (шаги, которые сейчас невозможны, пропускаются). */
  next(now = null) {
    if (this.i < this.steps.length - 1) this.i += 1;
    while (this.step.needsNodes && !this.hasNodes && this.i < this.steps.length - 1) this.i += 1;
    this.resetStep(now);
    return this.step;
  }

  skip(now = null) { return this.next(now); }

  /** Рука не видна дольше ms — пора подсказать про свет и расстояние. */
  handLost(now, ms = 3000) {
    if (this.step.manual) return false;
    const since = this.lastHandAt ?? this.startedAt;
    return since !== null && now - since > ms;
  }

  /** Принять событие от голограммы. Возвращает true, если шаг только что выполнен. */
  feed(evt, now) {
    if (this.startedAt === null) this.startedAt = now;
    if (evt.type === "frame") {
      this.lastKind = evt.kind;
      if (evt.kind !== "none") this.lastHandAt = now;
    }
    const s = this.step;
    if (s.manual || this.complete) return false;

    if (s.goal === "hold" && evt.type === "frame") {
      this.progress = this.hold(s.kinds.includes(evt.kind), now, s.ms);
    } else if (s.goal === "sum" && evt.type === s.event) {
      this.sum += Math.abs(evt.amount || 0);
      this.progress = Math.min(1, this.sum / s.need);
    } else if (s.goal === "event") {
      if (evt.type === s.event) {
        this.progress = 1;
        if (evt.id) this.selected = evt.id;
      } else if (s.holdKind && evt.type === "frame") {
        this.progress = Math.min(0.95, this.hold(evt.kind === s.holdKind, now, s.ms));
      } else if (s.progressEvent && evt.type === s.progressEvent) {
        // кольцо на узле и кольцо на кнопке — разные цели: учитываем только своё
        if (s.press === undefined || Boolean(evt.press) === s.press) this.progress = Math.min(0.95, evt.progress || 0);
      } else if (s.progressEvent && evt.type === "frame" && evt.kind !== "point") {
        this.progress = 0;
      }
    } else if (s.goal === "pose") {
      if (evt.type === "pose" && evt.kind === s.kind) this.progress = 1;
      else if (evt.type === "hold" && evt.kind === s.kind) this.progress = Math.min(0.95, evt.progress || 0);
      else if (evt.type === "frame" && evt.kind !== s.kind && evt.kind !== "none") this.progress = 0;
    }
    if (this.progress >= 1) {
      this.complete = true;
      return true;
    }
    return false;
  }

  hold(match, now, ms) {
    if (match) {
      this.lastMatch = now;
      if (this.holdSince === null) this.holdSince = now;
    } else if (this.lastMatch === null || now - this.lastMatch > this.graceMs) {
      this.holdSince = null;
    }
    return this.holdSince === null ? 0 : Math.min(1, (now - this.holdSince) / ms);
  }
}
