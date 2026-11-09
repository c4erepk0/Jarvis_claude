// Локальный разбор команд на русском — мгновенно, бесплатно, без интернета. Порт jarvis/intents.py.
import { parseAmount, parseDate, parseDuration } from "./ru.js";
import { guessCategory } from "./finance.js";

const L = "(?<![\\p{L}\\p{N}_])", R = "(?![\\p{L}\\p{N}_])";
const rx = (s, f = "iu") => new RegExp(s.replace(/\\b<|\\b>/g, (m) => (m === "\\b<" ? L : R)), f);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const PROTOCOL_ALIASES = {
  "утро": ["утро", "доброе утро", "брифинг", "утренний брифинг", "сводка", "доклад"],
  "фокус": ["фокус", "режим фокуса", "помодоро", "концентрация"],
  "итоги": ["итоги", "итоги дня", "вечерний отчёт", "вечерний отчет", "отчёт за день", "отчет за день"],
  "неделя": ["неделя", "итоги недели", "обзор недели", "недельный обзор"],
  "диагностика": ["диагностика", "диагностика систем", "статус систем", "проверка систем", "самодиагностика"],
  "чистый лист": ["чистый лист", "уборка", "очистка задач"],
  "вечеринка": ["вечеринка", "домашняя вечеринка", "все проекты", "выкатить всё", "выкатить все"],
  "тишина": ["тишина", "замолчи", "режим тишины", "без звука", "помолчи"],
  "голос": ["голос", "говори", "включи голос", "можешь говорить"],
};
const PRIORITY_WORDS = { high: ["срочно", "срочная", "важно", "важная", "приоритет", "горит"],
  low: ["когда-нибудь", "не срочно", "неважно", "потом"] };

export function normalize(text, wake = "джарвис") {
  let t = text.trim().replace(rx(`^\\s*(?:эй,?\\s+|ок,?\\s+|окей,?\\s+)?${esc(wake)}[\\p{L}]*[\\s,.:!—-]*`), "");
  t = t.replace(/\s+/g, " ").trim();
  return t.replace(/[ .!?]+$/, "");
}

function projectHint(text, projects) {
  const low = text.toLowerCase();
  for (const name of [...projects].sort((a, b) => b.length - a.length)) {
    const n = esc(name.toLowerCase());
    for (const p of [`\\s*(?:для|в|по|проект[уа]?)\\s+#?${n}\\b>`, `\\s*#${n}\\b>`]) {
      const m = rx(p).exec(low);
      if (m) return [name, (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim()];
    }
  }
  return [null, text];
}

function priorityOf(text) {
  const low = text.toLowerCase();
  for (const [prio, words] of Object.entries(PRIORITY_WORDS)) {
    for (const w of words) {
      const m = new RegExp(`(?:^|[\\s,])${esc(w)}(?:$|[\\s,!.])`, "u").exec(low);
      if (m) return [prio, (text.slice(0, m.index) + " " + text.slice(m.index + m[0].length)).replace(/^[ ,]+|[ ,]+$/g, "").replace(/\s{2,}/g, " ")];
    }
  }
  return [null, text];
}

const TASK_ADD = "^(?:добавь|добавить|создай|создать|запиши|записать|заведи|поставь|новая|новую)\\s+(?:мне\\s+)?"
  + "(?:(?:ещё|еще)\\s+)?(?:одну\\s+)?((?:[а-яё-]+(?:ую|юю)\\s+){0,2})(?:задачу|задача|дело|в задачи)(?:[:,]?\\s+(.+))?$";
// прилагательное из винительного падежа в именительный: «тестовую» → «тестовая», «синюю» → «синяя»
const nominative = (w) => (w.slice(0, -2) + (w.toLowerCase().endsWith("юю") ? "яя" : "ая")).toLowerCase();

const stripLead = (s) => s.replace(rx("^(?:о том,? что|что|про|о|об)\\s+"), "");

export function parse(text, ref, projects = [], wake = "джарвис") {
  const t = normalize(text, wake);
  const low = t.toLowerCase();
  if (!low) return { name: "greet", args: {} };

  if (rx("^(да,? )?(подтверждаю|подтвердить|подтверди|выполняй|выполнить|делай|давай|да|так точно|запускай|поехали)$").test(low)) return { name: "confirm", args: {} };
  if (rx("^(нет|отмена|отменить|отмени|не надо|стоп|стой|отбой)$").test(low)) return { name: "cancel", args: {} };

  let m = rx("^(?:запусти |активируй |включи )?протокол[а-яё]*\\s+[«\"']?(.+?)[»\"']?$").exec(low);
  if (m) return { name: "protocol", args: { name: m[1].trim() } };
  for (const [proto, aliases] of Object.entries(PROTOCOL_ALIASES)) {
    if (aliases.includes(low) || aliases.some((a) => low === `режим ${a}`)) return { name: "protocol", args: { name: proto } };
  }

  if (rx("(который час|сколько времени|какое сегодня число|какой сегодня день|какое число)").test(low)) return { name: "time", args: {} };
  if (rx("^((какая )?погода( сегодня| на улице| за окном)?|что с погодой|прогноз( погоды)?)$").test(low)) return { name: "weather", args: {} };
  if (rx("\\b<курс(ы)? (доллара|евро|валют|рубля)\\b>|^курс$").test(low)) return { name: "currency", args: {} };
  if (rx("^(что ты умеешь|помощь|справка|команды|что ты можешь)$").test(low)) return { name: "help", args: {} };
  if (rx("^(привет|здравствуй|здравствуйте|ты тут|ты здесь|на связи|доброго времени суток)$").test(low)) return { name: "greet", args: {} };

  m = rx("^напомни(?: мне)?(?: о том,? что| что| про| о)?\\s+(.+)$").exec(t);
  if (m) {
    const body = m[1];
    const [seconds, rest] = parseDuration(body);
    if (seconds) return { name: "reminder", args: { text: stripLead(rest) || "напоминание", seconds } };
    const [due, rest2] = parseDate(body, ref);
    const [proj, rest3] = projectHint(stripLead(rest2), projects);
    return { name: "task_add", args: { text: rest3, due: due || ref, project: proj, priority: null } };
  }

  // «создай тестовую задачу», «добавь срочную задачу позвонить», «добавь задачу купить молоко завтра»
  m = rx(TASK_ADD).exec(t);
  const m2 = m ? null : rx("^задача[:,]\\s*(.+)$").exec(t);
  if (m || m2) {
    let adjs = (m ? m[1].split(/\s+/) : []).filter((w) => w && w.toLowerCase() !== "новую").map(nominative);
    const isPrio = (w) => Object.values(PRIORITY_WORDS).some((words) => words.includes(w));
    const adjPrio = Object.entries(PRIORITY_WORDS).find(([, words]) => adjs.some((w) => words.includes(w)))?.[0] || null;
    adjs = adjs.filter((w) => !isPrio(w));   // «срочную» — это приоритет, а не текст
    let [due, body] = parseDate(m ? (m[2] || "") : m2[1], ref);
    let prio;
    [prio, body] = priorityOf(body);
    let proj;
    [proj, body] = projectHint(body, projects);
    if (!body.trim() && adjs.length) body = `${adjs.join(" ")} задача`;   // «тестовую» → «тестовая задача»
    return { name: "task_add", args: { text: body.trim(), due, priority: prio || adjPrio, project: proj } };
  }
  m = rx("^(?:отметь|закрой|заверши|я выполнил|выполнил|выполнила|я сделал|сделал|сделала|готово)(?: задачу| задача)?[:,]?\\s+(.+?)(?: как)?(?: выполненн[а-яё]*| сделанн[а-яё]*)?$").exec(t);
  if (m && !rx("^(?:отчёт|отчет)").test(m[1])) return { name: "task_done", args: { query: m[1].trim() } };

  if (rx("\\b<(диагност|систем[аы]|сервер[а]?|нагрузк|процессор)").test(low) && rx("(как|статус|состояни|провер|покажи|диагност)").test(low)) {
    return { name: "protocol", args: { name: "диагностика" } };
  }
  if (rx("\\b<(задач[а-яё]*|мои дела|дела на|планы|что у меня)\\b>").test(low) && !rx("\\b<(добав|созда|удал)").test(low)) {
    let view = "today";
    if (low.includes("просроч")) view = "overdue";
    else if (low.includes("недел")) view = "week";
    else if (low.includes("завтра")) view = "tomorrow";
    else if (rx("\\b<(все|всё|список)\\b>").test(low)) view = "all";
    let [proj] = projectHint(t, projects);
    if (!proj) proj = projects.find((p) => rx(`\\b<${esc(p.toLowerCase())}\\b>`).test(low)) || null;
    return { name: "tasks_list", args: { view, project: proj } };
  }

  m = rx("^(?:я\\s+)?(потратил[а-яё]*|заплатил[а-яё]*|купил[а-яё]*|минус|расход|трата|оплатил[а-яё]*|отдал[а-яё]*)\\s+(.+)$").exec(t);
  if (m) {
    const [amount, rest] = parseAmount(m[2]);
    if (amount) {
      let note = rest.replace(rx("^(?:на|за|в)\\s+"), "").trim() || m[1];
      note = note.replace(rx("\\s+(?:на|за)\\s+"), " ").replace(rx("\\s+(?:на|за|в)$"), "").trim();
      return { name: "expense", args: { amount: -Math.abs(amount), category: guessCategory(note), note } };
    }
  }
  m = rx("^(?:я\\s+)?(получил[а-яё]*|заработал[а-яё]*|доход|пришл[оаи]|плюс|поступлени[а-яё]*|зачисли[а-яё]*)\\s+(.+)$").exec(t);
  if (m) {
    const [amount, rest] = parseAmount(m[2]);
    if (amount) {
      const note = rest.replace(rx("^(?:от|за|с|из)\\s+"), "").trim() || "доход";
      return { name: "income", args: { amount: Math.abs(amount), category: guessCategory(note, true), note } };
    }
  }
  if (rx("(сколько (я )?(потратил|трачу|заработал)|финанс|бюджет|баланс|мои расходы|траты|расходы)").test(low)) {
    return { name: "finance_report", args: { period: low.includes("сегодня") ? "today" : "month" } };
  }

  m = rx("^запомни[,:]?\\s+(?:что\\s+)?(.+)$").exec(t);
  if (m) return { name: "remember", args: { fact: m[1].trim() } };
  m = rx("^забудь[,:]?\\s+(?:что\\s+|про\\s+|о\\s+)?(.+)$").exec(t);
  if (m) return { name: "forget", args: { query: m[1].trim() } };
  if (rx("^(что ты (знаешь|помнишь) обо мне|что ты обо мне знаешь)$").test(low)) return { name: "recall", args: { query: "" } };
  m = rx("^(?:найди|поищи|поиск)(?: в (?:заметках|памяти|obsidian|обсидиане))?[:,]?\\s+(.+)$").exec(t)
    || rx("^что ты (?:знаешь|помнишь) (?:о|об|про)\\s+(.+)$").exec(t);
  if (m) return { name: "recall", args: { query: m[1].trim() } };
  m = rx("^(?:заметка|запиши заметку|запиши в журнал|в журнал)[:,]?\\s+(.+)$").exec(t);
  if (m) return { name: "note", args: { text: m[1].trim() } };

  m = rx("^(?:поручи|передай|отдай)(?:\\s+(?:claude|клоду|клод|клоуду))?(?:\\s+(локально|на компьютере))?\\s+(?:в\\s+|проекту\\s+|проект\\s+|для\\s+)?([\\p{L}\\p{N}_.-]+)[:,]?\\s+(.+)$").exec(t);
  if (m) {
    const proj = projects.find((p) => p.toLowerCase() === m[2].toLowerCase()) || m[2];
    const mode = m[1] || rx("\\b<локально\\b>").test(m[3]) ? "local" : "github";
    return { name: "delegate", args: { project: proj, task: m[3].replace(rx("\\s*\\b<локально\\b>"), "").trim(), mode } };
  }
  m = rx("^(?:задеплой|задеплоить|деплой|выкати|выкатить|разверни|обнови сервер)\\s+(.+)$").exec(t);
  if (m) {
    const name = m[1].trim();
    return { name: "deploy", args: { project: projects.find((p) => name.toLowerCase().includes(p.toLowerCase())) || name } };
  }
  if (rx("\\b<(статус|состояние|как дела у|что с|как там)\\b>").test(low)) {
    const proj = projects.find((p) => rx(`\\b<${esc(p.toLowerCase())}\\b>`).test(low)) || null;
    if (proj || rx("проект|ci|сборк|github").test(low)) return { name: "project_status", args: { project: proj } };
  }
  return null;
}
