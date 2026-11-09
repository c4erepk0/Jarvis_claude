"""Локальный разбор команд на русском — работает мгновенно, бесплатно и без интернета.

Всё, что не распознано здесь, уходит в Claude (если подключён ключ API).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date

from . import ru
from .finance import guess_category, looks_like_income


TASK_ADD = (r"^(?:добавь|добавить|создай|создать|запиши|записать|заведи|поставь|новая|новую)\s+(?:мне\s+)?"
            r"(?:(?:ещё|еще)\s+)?(?:одну\s+)?((?:[а-яё-]+(?:ую|юю)\s+){0,2})(?:задачу|задача|дело|в задачи)"
            r"(?:[:,]?\s+(.+))?$")


def _nominative(word: str) -> str:
    """Прилагательное из винительного падежа в именительный: «тестовую» → «тестовая», «синюю» → «синяя»."""
    return (word[:-2] + ("яя" if word.lower().endswith("юю") else "ая")).lower()


@dataclass
class Intent:
    name: str
    args: dict = field(default_factory=dict)


PROTOCOL_ALIASES = {
    "утро": ["утро", "доброе утро", "брифинг", "утренний брифинг", "сводка", "доклад"],
    "фокус": ["фокус", "режим фокуса", "помодоро", "концентрация"],
    "итоги": ["итоги", "итоги дня", "вечерний отчёт", "вечерний отчет", "отчёт за день", "отчет за день"],
    "неделя": ["неделя", "итоги недели", "обзор недели", "недельный обзор"],
    "диагностика": ["диагностика", "диагностика систем", "статус систем", "проверка систем", "самодиагностика"],
    "чистый лист": ["чистый лист", "уборка", "очистка задач"],
    "вечеринка": ["вечеринка", "домашняя вечеринка", "все проекты", "выкатить всё", "выкатить все"],
    "тишина": ["тишина", "замолчи", "режим тишины", "без звука", "помолчи"],
    "голос": ["голос", "говори", "включи голос", "можешь говорить"],
}
PRIORITY_WORDS = {"high": ["срочно", "срочная", "важно", "важная", "приоритет", "горит"],
                  "low": ["когда-нибудь", "не срочно", "неважно", "потом"]}


def normalize(text: str, wake_word: str = "джарвис") -> str:
    t = text.strip()
    t = re.sub(rf"^\s*(?:эй,?\s+|ок,?\s+|окей,?\s+)?{re.escape(wake_word)}\w*[\s,.:!—-]*", "", t, flags=re.I)
    t = re.sub(r"\s+", " ", t).strip()
    return t.rstrip(" .!?")


def _project_hint(text: str, projects: list[str]) -> tuple[str | None, str]:
    low = text.lower()
    for name in sorted(projects, key=len, reverse=True):
        n = name.lower()
        for rx in (rf"\s*(?:для|в|по|проект[уа]?)\s+#?{re.escape(n)}\b", rf"\s*#{re.escape(n)}\b"):
            m = re.search(rx, low)
            if m:
                return name, (text[:m.start()] + text[m.end():]).strip()
    return None, text


def _priority(text: str) -> tuple[str | None, str]:
    low = text.lower()
    for prio, words in PRIORITY_WORDS.items():
        for w in words:
            m = re.search(rf"(?:^|[\s,]){re.escape(w)}(?:$|[\s,!.])", low)
            if m:
                cleaned = (text[:m.start()] + " " + text[m.end():]).strip(" ,")
                return prio, re.sub(r"\s{2,}", " ", cleaned)
    return None, text


def parse(text: str, ref: date, projects: list[str] | None = None, wake_word: str = "джарвис") -> Intent | None:
    projects = projects or []
    t = normalize(text, wake_word)
    low = t.lower()
    if not low:
        return Intent("greet")

    # --- подтверждение / отмена отложенного действия ---
    if re.fullmatch(r"(да,? )?(подтверждаю|подтвердить|подтверди|выполняй|выполнить|делай|давай|да|так точно|"
                    r"запускай|поехали)", low):
        return Intent("confirm")
    if re.fullmatch(r"(нет|отмена|отменить|отмени|не надо|стоп|стой|отбой)", low):
        return Intent("cancel")

    # --- протоколы ---
    m = re.match(r"^(?:запусти |активируй |включи )?протокол[а-я]*\s+[«\"']?(.+?)[»\"']?$", low)
    if m:
        return Intent("protocol", {"name": m.group(1).strip()})
    for proto, aliases in PROTOCOL_ALIASES.items():
        if low in aliases or any(low == f"режим {a}" for a in aliases):
            return Intent("protocol", {"name": proto})

    # --- время, погода, курс ---
    if re.search(r"(который час|сколько времени|какое сегодня число|какой сегодня день|какое число)", low):
        return Intent("time")
    if re.fullmatch(r"(какая )?погода( сегодня| на улице| за окном)?|что с погодой|прогноз( погоды)?", low):
        return Intent("weather")
    if re.search(r"\bкурс(ы)? (доллара|евро|валют|рубля)\b|^курс$", low):
        return Intent("currency")
    if re.fullmatch(r"(что ты умеешь|помощь|справка|команды|что ты можешь)", low):
        return Intent("help")
    if re.fullmatch(r"(привет|здравствуй|здравствуйте|ты тут|ты здесь|на связи|доброго времени суток)", low):
        return Intent("greet")

    # --- напоминание через N минут ---
    m = re.match(r"^напомни(?: мне)?(?: о том,? что| что| про| о)?\s+(.+)$", t, re.I)
    if m:
        body = m.group(1)
        delta, rest = ru.parse_duration(body)
        if delta:
            rest = re.sub(r"^(?:о том,? что|что|про|о|об)\s+", "", rest, flags=re.I)
            return Intent("reminder", {"text": rest or "напоминание", "seconds": int(delta.total_seconds())})
        due, rest = ru.parse_date(body, ref)
        rest = re.sub(r"^(?:о том,? что|что|про|о|об)\s+", "", rest, flags=re.I)
        proj, rest = _project_hint(rest, projects)
        return Intent("task_add", {"text": rest, "due": (due or ref).isoformat(), "project": proj,
                                   "priority": None})

    # --- задачи ---
    # «создай тестовую задачу», «добавь срочную задачу позвонить», «добавь задачу купить молоко завтра»
    m = re.match(TASK_ADD, t, re.I)
    m2 = None if m else re.match(r"^задача[:,]\s*(.+)$", t, re.I)
    if m or m2:
        adjs = [_nominative(w) for w in (m.group(1).split() if m else []) if w.lower() != "новую"]
        adj_prio = next((p for p, words in PRIORITY_WORDS.items() for w in adjs if w in words), None)
        adjs = [w for w in adjs if not any(w in words for words in PRIORITY_WORDS.values())]   # «срочную» — приоритет
        due, body = ru.parse_date((m.group(2) or "") if m else m2.group(1), ref)
        prio, body = _priority(body)
        prio = prio or adj_prio
        proj, body = _project_hint(body, projects)
        if not body.strip() and adjs:
            body = " ".join(adjs) + " задача"     # «создай тестовую задачу» → «тестовая задача»
        return Intent("task_add", {"text": body.strip(), "due": due.isoformat() if due else None,
                                   "priority": prio, "project": proj})
    m = re.match(r"^(?:отметь|закрой|заверши|я выполнил|выполнил|выполнила|я сделал|сделал|сделала|готово)"
                 r"(?: задачу| задача)?[:,]?\s+(.+?)(?: как)?(?: выполненн\w*| сделанн\w*)?$", t, re.I)
    if m and not re.match(r"^(?:отчёт|отчет)", m.group(1), re.I):
        return Intent("task_done", {"query": m.group(1).strip()})
    if re.search(r"\b(диагност|систем[аы]|сервер[а]?|нагрузк|процессор)", low) and \
            re.search(r"(как|статус|состояни|провер|покажи|диагност)", low):
        return Intent("protocol", {"name": "диагностика"})
    if re.search(r"\b(задач\w*|мои дела|дела на|планы|что у меня)\b", low) and \
            not re.search(r"\b(добав|созда|удал)", low):
        view = "today"
        if "просроч" in low:
            view = "overdue"
        elif "недел" in low:
            view = "week"
        elif "завтра" in low:
            view = "tomorrow"
        elif re.search(r"\b(все|всё|список)\b", low):
            view = "all"
        proj, _ = _project_hint(t, projects)
        if not proj:
            proj = next((p for p in projects if re.search(rf"\b{re.escape(p.lower())}\b", low)), None)
        return Intent("tasks_list", {"view": view, "project": proj})

    # --- финансы ---
    m = re.match(r"^(?:я\s+)?(потратил\w*|заплатил\w*|купил\w*|минус|расход|трата|оплатил\w*|отдал\w*)\s+(.+)$",
                 t, re.I)
    if m:
        amount, rest = ru.parse_amount(m.group(2))
        if amount:
            note = re.sub(r"^(?:на|за|в)\s+", "", rest, flags=re.I).strip() or m.group(1)
            note = re.sub(r"\s+(?:на|за)\s+", " ", note)
            note = re.sub(r"\s+(?:на|за|в)$", "", note).strip()
            return Intent("expense", {"amount": -abs(amount), "category": guess_category(note), "note": note})
    m = re.match(r"^(?:я\s+)?(получил\w*|заработал\w*|доход|пришл[оаи]|плюс|поступлени\w*|зачисли\w*)\s+(.+)$",
                 t, re.I)
    if m:
        amount, rest = ru.parse_amount(m.group(2))
        if amount:
            note = re.sub(r"^(?:от|за|с|из)\s+", "", rest, flags=re.I).strip() or "доход"
            return Intent("income", {"amount": abs(amount), "category": guess_category(note, income=True),
                                     "note": note})
    if re.search(r"(сколько (я )?(потратил|трачу|заработал)|финанс|бюджет|баланс|мои расходы|траты|расходы)", low):
        return Intent("finance_report", {"period": "today" if "сегодня" in low else "month"})

    # --- память ---
    m = re.match(r"^запомни[,:]?\s+(?:что\s+)?(.+)$", t, re.I)
    if m:
        return Intent("remember", {"fact": m.group(1).strip()})
    m = re.match(r"^забудь[,:]?\s+(?:что\s+|про\s+|о\s+)?(.+)$", t, re.I)
    if m:
        return Intent("forget", {"query": m.group(1).strip()})
    if re.fullmatch(r"что ты (знаешь|помнишь) обо мне|что ты обо мне знаешь", low):
        return Intent("recall", {"query": ""})
    # «открой заметку IPAStore», «покажи файл про оферту» — в голограмме
    m = re.match(r"^(?:открой|покажи|открыть|показать)\s+(?:мне\s+)?(?:заметку|файл|запись)\s+"
                 r"(?:про\s+|о\s+|об\s+)?(.+)$", t, re.I)
    if m:
        return Intent("note_open", {"query": m.group(1).strip()})
    m = re.match(r"^(?:найди|поищи|поиск)(?: в (?:заметках|памяти|obsidian|обсидиане))?[:,]?\s+(.+)$", t, re.I) or \
        re.match(r"^что ты (?:знаешь|помнишь) (?:о|об|про)\s+(.+)$", t, re.I)
    if m:
        return Intent("recall", {"query": m.group(1).strip()})
    m = re.match(r"^(?:заметка|запиши заметку|запиши в журнал|в журнал)[:,]?\s+(.+)$", t, re.I)
    if m:
        return Intent("note", {"text": m.group(1).strip()})

    # --- проекты ---
    m = re.match(r"^(?:поручи|передай|отдай)(?:\s+(?:claude|клоду|клод|клоуду))?(?:\s+(локально|на компьютере))?"
                 r"\s+(?:в\s+|проекту\s+|проект\s+|для\s+)?([\w.-]+)[:,]?\s+(.+)$", t, re.I)
    if m:
        proj = next((p for p in projects if p.lower() == m.group(2).lower()), m.group(2))
        task = m.group(3)
        mode = "local" if m.group(1) or re.search(r"\bлокально\b", task, re.I) else "github"
        task = re.sub(r"\s*\bлокально\b", "", task, flags=re.I).strip()
        return Intent("delegate", {"project": proj, "task": task, "mode": mode})
    m = re.match(r"^(?:задеплой|задеплоить|деплой|выкати|выкатить|разверни|обнови сервер)\s+(.+)$", t, re.I)
    if m:
        name = m.group(1).strip()
        proj = next((p for p in projects if p.lower() in name.lower()), name)
        return Intent("deploy", {"project": proj})
    if re.search(r"\b(статус|состояние|как дела у|что с|как там)\b", low):
        proj = next((p for p in projects if re.search(rf"\b{re.escape(p.lower())}\b", low)), None)
        if proj or re.search(r"проект|ci|сборк|github", low):
            return Intent("project_status", {"project": proj})
    return None


def detect_income(text: str) -> bool:
    return looks_like_income(text)
