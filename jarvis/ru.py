"""Русский язык для Jarvis: даты («завтра», «в пятницу», «12 ноября»), суммы («1,5к»), склонения."""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа",
              "сентября", "октября", "ноября", "декабря"]
MONTHS_NOM = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август",
              "сентябрь", "октябрь", "ноябрь", "декабрь"]
WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"]
WEEKDAY_FORMS = {
    0: ("понедельник",), 1: ("вторник",), 2: ("среду", "среда"), 3: ("четверг",),
    4: ("пятницу", "пятница"), 5: ("субботу", "суббота"), 6: ("воскресенье",),
}
NUM_WORDS = {"один": 1, "одну": 1, "два": 2, "две": 2, "три": 3, "четыре": 4, "пять": 5, "шесть": 6,
             "семь": 7, "восемь": 8, "девять": 9, "десять": 10, "пятнадцать": 15, "двадцать": 20,
             "тридцать": 30, "сорок": 40, "полчаса": 30, "пару": 2, "несколько": 3}


def now(tz: str = "Europe/Moscow") -> datetime:
    try:
        return datetime.now(ZoneInfo(tz))
    except Exception:  # noqa: BLE001 — неизвестный пояс → локальное время
        return datetime.now().astimezone()


def today(tz: str = "Europe/Moscow") -> date:
    return now(tz).date()


def plural(n: int, one: str, few: str, many: str) -> str:
    n = abs(int(n))
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


def human_date(d: date, ref: date | None = None) -> str:
    ref = ref or date.today()
    delta = (d - ref).days
    if delta == 0:
        return "сегодня"
    if delta == 1:
        return "завтра"
    if delta == -1:
        return "вчера"
    if delta == 2:
        return "послезавтра"
    s = f"{d.day} {MONTHS_GEN[d.month - 1]}"
    return s if d.year == ref.year else f"{s} {d.year}"


def money(kopecks: int, currency: str = "RUB", signed: bool = False) -> str:
    sign = "−" if kopecks < 0 else ("+" if signed and kopecks > 0 else "")
    value = abs(kopecks)
    rub, kop = divmod(value, 100)
    whole = f"{rub:,}".replace(",", " ")
    sym = {"RUB": "₽", "USD": "$", "EUR": "€"}.get(currency, currency)
    return f"{sign}{whole}{f',{kop:02d}' if kop else ''} {sym}"


def money_spoken(kopecks: int) -> str:
    rub = abs(kopecks) // 100
    return f"{rub} {plural(rub, 'рубль', 'рубля', 'рублей')}"


# ---------- даты в свободной речи ----------

_DATE_PATTERNS = [
    r"\b(?:до |к |на )?сегодня(?:шн\w*)?\b",
    r"\b(?:до |к |на )?послезавтра\b",
    r"\b(?:до |к |на )?завтра\b",
    r"\bчерез (?:(\d+|\w+) )?(день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев)\b",
    r"\b(?:в|во|до|к|на) (?:следующ\w+ )?(понедельник|вторник|среду|среда|четверг|пятницу|пятница|"
    r"субботу|суббота|воскресенье)\b",
    r"\b(?:до |к |на )?(\d{1,2}) (" + "|".join(MONTHS_GEN) + r")(?: (\d{4}))?\b",
    r"\b(?:до |к |на )?(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\b",
    r"\b(\d{4})-(\d{2})-(\d{2})\b",
]


def _num(word: str | None) -> int:
    if not word:
        return 1
    if word.isdigit():
        return int(word)
    return NUM_WORDS.get(word.lower(), 1)


def parse_date(text: str, ref: date) -> tuple[date | None, str]:
    """Находит дату в тексте. Возвращает (дата, текст без упоминания даты)."""
    low = text.lower()
    for pattern in _DATE_PATTERNS:
        m = re.search(pattern, low)
        if not m:
            continue
        frag = m.group(0)
        d: date | None = None
        if "послезавтра" in frag:
            d = ref + timedelta(days=2)
        elif "завтра" in frag:
            d = ref + timedelta(days=1)
        elif "сегодня" in frag:
            d = ref
        elif frag.startswith("через"):
            n, unit = _num(m.group(1)), m.group(2)
            if unit.startswith("нед"):
                d = ref + timedelta(weeks=n)
            elif unit.startswith("месяц"):
                d = _add_months(ref, n)
            else:
                d = ref + timedelta(days=n)
        elif m.lastindex and any(m.group(1) in forms for forms in WEEKDAY_FORMS.values()):
            wd = next(k for k, forms in WEEKDAY_FORMS.items() if m.group(1) in forms)
            ahead = (wd - ref.weekday()) % 7 or 7
            d = ref + timedelta(days=ahead)
        elif "-" in frag and re.fullmatch(r"\d{4}-\d{2}-\d{2}", frag):
            d = _safe_date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        elif "." in frag:
            day, month = int(m.group(1)), int(m.group(2))
            year = int(m.group(3)) if m.group(3) else ref.year
            year = year + 2000 if year < 100 else year
            d = _safe_date(year, month, day)
            if d and not m.group(3) and d < ref:
                d = _safe_date(year + 1, month, day)
        else:
            day, month = int(m.group(1)), MONTHS_GEN.index(m.group(2)) + 1
            year = int(m.group(3)) if m.group(3) else ref.year
            d = _safe_date(year, month, day)
            if d and not m.group(3) and d < ref:
                d = _safe_date(year + 1, month, day)
        if d is None:
            continue
        cleaned = (text[:m.start()] + text[m.end():]).strip()
        return d, re.sub(r"\s{2,}", " ", cleaned).strip(" ,.")
    return None, text


def _safe_date(y: int, m: int, d: int) -> date | None:
    try:
        return date(y, m, d)
    except ValueError:
        return None


def _add_months(d: date, n: int) -> date:
    month = d.month - 1 + n
    year = d.year + month // 12
    month = month % 12 + 1
    for day in (d.day, 30, 29, 28):
        try:
            return date(year, month, day)
        except ValueError:
            continue
    return d


def parse_duration(text: str) -> tuple[timedelta | None, str]:
    """«через 20 минут», «через полчаса», «через 2 часа» → (длительность, остаток текста)."""
    low = text.lower()
    m = re.search(r"\bчерез (полчаса|час|(\d+|\w+) (минуту|минуты|минут|час|часа|часов|секунд|секунды))\b", low)
    if not m:
        return None, text
    if m.group(1) == "полчаса":
        td = timedelta(minutes=30)
    elif m.group(1) == "час":
        td = timedelta(hours=1)
    else:
        n, unit = _num(m.group(2)), m.group(3)
        td = timedelta(hours=n) if unit.startswith("час") else (
            timedelta(seconds=n) if unit.startswith("секунд") else timedelta(minutes=n))
    rest = (text[:m.start()] + text[m.end():]).strip()
    return td, re.sub(r"\s{2,}", " ", rest).strip(" ,.")


# ---------- суммы ----------

_AMOUNT = re.compile(
    r"(?<![\w.,])([+\-−]?\s?\d[\d\s ]*(?:[.,]\d{1,2})?)\s*(к|k|тыс\.?|тысяч[аи]?|косар\w*|т\.р\.?)?"
    r"\s*(?:₽|руб\w*|р\b|р\.)?",
    re.IGNORECASE,
)


def parse_amount(text: str) -> tuple[int | None, str]:
    """Первая сумма в тексте в копейках: «450», «1 200,50», «1,5к», «2 тыс» → (копейки, остаток)."""
    for m in _AMOUNT.finditer(text):
        raw = m.group(1)
        digits = re.sub(r"[\s ]", "", raw).replace("−", "-").replace(",", ".")
        if not re.search(r"\d", digits):
            continue
        try:
            value = float(digits)
        except ValueError:
            continue
        if m.group(2):
            value *= 1000
        rest = (text[:m.start()] + " " + text[m.end():]).strip()
        return int(round(value * 100)), re.sub(r"\s{2,}", " ", rest).strip(" ,.")
    return None, text


def parse_money_cell(cell: str) -> int | None:
    """Ячейка таблицы финансов → копейки. «-450», «+120 000», «−1 200,50»."""
    s = re.sub(r"[\s ₽$€]|руб\.?", "", cell.strip()).replace("−", "-").replace(",", ".")
    if not re.fullmatch(r"[+-]?\d+(?:\.\d{1,2})?", s):
        return None
    return int(round(float(s) * 100))


def greeting(hour: int) -> str:
    if 5 <= hour < 12:
        return "Доброе утро"
    if 12 <= hour < 18:
        return "Добрый день"
    if 18 <= hour < 23:
        return "Добрый вечер"
    return "Доброй ночи"
