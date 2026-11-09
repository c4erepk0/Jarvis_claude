// Логика первоначального обучения жестам (без DOM — проверяется в node --test).
// Голограмма присылает события: { type: "frame", kind } на каждый кадр камеры, { type: "rotate", amount },
// { type: "zoom", amount }, { type: "reset" }, { type: "dwell", progress }, { type: "select", id }.
// Шаг засчитывается только когда жест действительно распознан камерой.

export const STEPS = [
  {
    id: "intro", manual: true, pose: "intro", title: "Перед началом",
    text: "Поставьте iPhone вертикально на опору экраном к себе и отойдите на 40–60 см. Свет — спереди, не из-за спины. "
      + "Камера работает только в этом браузере: кадры никуда не отправляются.",
    speech: "Начнём калибровку жестов, сэр. Поставьте телефон на опору и отойдите на полметра.",
  },
  {
    id: "hand", goal: "hold", kinds: ["hand", "point", "pinch", "pinch2", "palm"], ms: 800, pose: "palm",
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
    id: "select", goal: "event", event: "select", progressEvent: "dwell", pose: "point", anim: "target", needsNodes: true,
    title: "Открыть заметку",
    text: "Наведите палец на светящийся узел и задержите, пока кольцо курсора не замкнётся. После обучения так открываются заметки.",
    speech: "Наведите палец на любую заметку и задержите.", praise: "Цель захвачена.",
  },
  {
    id: "done", manual: true, pose: "done", title: "Готово, сэр",
    text: "☝ указка — курсор\n🤏 щипок и движение — вращать\n🤏🤏 две руки — масштаб\n✋ ладонь 1 с — сброс вида\n"
      + "◎ палец на узле 1 с — открыть заметку\nПовторить обучение — кнопка «?» вверху.",
    speech: "Калибровка завершена. Жесты в вашем распоряжении, сэр.",
  },
];

export class GestureCoach {
  constructor(steps = STEPS, { graceMs = 300, hasNodes = true } = {}) {
    this.steps = steps;
    this.graceMs = graceMs;   // MediaPipe иногда теряет руку на кадр-другой — не сбрасываем удержание
    this.hasNodes = hasNodes;
    this.i = 0;
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
    const acts = this.steps.filter((s) => !s.manual);
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
        this.progress = Math.min(0.95, evt.progress || 0);
      } else if (s.progressEvent && evt.type === "frame" && evt.kind !== "point") {
        this.progress = 0;
      }
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
