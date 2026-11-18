"""Финансы в Obsidian: по файлу на месяц `Finance/2026-11.md` с таблицей операций.

| Дата | Сумма | Категория | Описание | Счёт |
|------|------:|-----------|----------|------|
| 2026-11-08 | -450 | Еда | Кофе | Карта |

Расход — со знаком минус, доход — без знака или с плюсом. Внутри суммы считаются в копейках.
Лимиты по категориям — в `Finance/Budget.md` (таблица «Категория | Лимит»).
"""
from __future__ import annotations

import calendar
import re
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from datetime import date

from . import ru
from .vault import Vault

CATEGORY_HINTS = {
    "Еда": ["еда", "продукт", "магазин", "пятёрочк", "пятерочк", "перекрёст", "перекрест", "вкусвилл", "ашан",
            "лавк", "самокат", "рынок"],
    "Кафе": ["кафе", "кофе", "ресторан", "обед", "ужин", "завтрак", "бар", "пицц", "суши", "шаурм", "доставк"],
    "Транспорт": ["такси", "метро", "бензин", "заправк", "автобус", "каршеринг", "парковк", "электричк",
                  "поезд", "транспорт"],
    "Подписки": ["подписк", "spotify", "netflix", "youtube", "icloud", "claude", "chatgpt", "яндекс плюс",
                 "apple", "telegram premium", "github"],
    "Связь": ["связь", "телефон", "интернет", "мобильн"],
    "Дом": ["квартир", "аренд", "коммунал", "жкх", "ремонт", "дом", "мебел"],
    "Здоровье": ["аптек", "врач", "здоров", "лекарств", "стоматолог", "анализ"],
    "Спорт": ["спорт", "зал", "фитнес", "тренир"],
    "Развлечения": ["кино", "игр", "концерт", "развлеч", "steam", "театр"],
    "Одежда": ["одежд", "обув", "кроссовк", "куртк"],
    "Образование": ["курс", "книг", "обучен", "учеб"],
    "Бизнес": ["ipastore", "сервер", "хостинг", "домен", "реклам", "vps", "сертификат apple"],
    "Подарки": ["подар"],
}
INCOME_HINTS = ["зарплат", "доход", "получил", "заработ", "перевели", "кэшбэк", "кешбэк", "продаж",
                "выплат", "аванс", "премия", "вернули", "пришло", "пришли"]
HEADER = ("| Дата | Сумма | Категория | Описание | Счёт |\n"
          "|------|------:|-----------|----------|------|\n")


@dataclass
class Entry:
    date: str
    amount: int          # копейки; < 0 — расход
    category: str
    note: str
    account: str
    path: str

    def as_dict(self) -> dict:
        return asdict(self)


def guess_category(text: str, income: bool = False) -> str:
    low = text.lower()
    if income:
        return "Бизнес" if "ipastore" in low else "Доход"
    for cat, hints in CATEGORY_HINTS.items():
        if any(h in low for h in hints):
            return cat
    return "Прочее"


def looks_like_income(text: str) -> bool:
    low = text.lower()
    return any(h in low for h in INCOME_HINTS)


def _cell(s: str) -> str:
    return s.replace("|", "/").replace("\n", " ").strip()


class Ledger:
    def __init__(self, vault: Vault, folder: str = "Finance", currency: str = "RUB"):
        self.vault = vault
        self.folder = folder.strip("/")
        self.currency = currency

    def month_path(self, month: str) -> str:
        return f"{self.folder}/{month}.md"

    def entries(self, month: str) -> list[Entry]:
        path = self.month_path(month)
        if not self.vault.exists(path):
            return []
        out: list[Entry] = []
        for line in self.vault.read(path).splitlines():
            if not line.strip().startswith("|"):
                continue
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if len(cells) < 2 or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", cells[0]):
                continue
            amount = ru.parse_money_cell(cells[1])
            if amount is None:
                continue
            cells += [""] * (5 - len(cells))
            out.append(Entry(cells[0], amount, cells[2] or "Прочее", cells[3], cells[4], path))
        return out

    def add(self, amount: int, category: str, note: str, day: date, account: str = "") -> Entry:
        if amount == 0:
            raise ValueError("сумма не может быть нулевой")
        month = day.strftime("%Y-%m")
        path = self.month_path(month)
        if not self.vault.exists(path):
            title = f"{ru.MONTHS_NOM[day.month - 1].capitalize()} {day.year}"
            head = (f"---\ntype: finance-ledger\nmonth: {month}\n---\n# Финансы — {title}\n\n" + HEADER)
            self.vault.write(path, head)
        rub = abs(amount) / 100
        value = f"{'-' if amount < 0 else '+'}{rub:.2f}".replace(".00", "")
        row = f"| {day.isoformat()} | {value} | {_cell(category)} | {_cell(note)} | {_cell(account)} |"
        text = self.vault.read(path)
        lines = text.rstrip("\n").splitlines()
        last_row = max((i for i, ln in enumerate(lines) if ln.strip().startswith("|")), default=None)
        if last_row is None:
            lines += ["", *HEADER.strip().splitlines(), row]
        else:
            lines.insert(last_row + 1, row)
        self.vault.write(path, "\n".join(lines) + "\n")
        return Entry(day.isoformat(), amount, category, note, account, path)

    def budgets(self) -> dict[str, int]:
        path = f"{self.folder}/Budget.md"
        if not self.vault.exists(path):
            return {}
        out: dict[str, int] = {}
        for line in self.vault.read(path).splitlines():
            cells = [c.strip() for c in line.strip().strip("|").split("|")] if line.strip().startswith("|") else []
            if len(cells) >= 2:
                value = ru.parse_money_cell(cells[1])
                if value is not None and cells[0] and not cells[0].startswith("-"):
                    out[cells[0]] = abs(value)
        return out

    def summary(self, month: str, ref: date | None = None) -> dict:
        items = self.entries(month)
        income = sum(e.amount for e in items if e.amount > 0)
        expense = -sum(e.amount for e in items if e.amount < 0)
        by_cat: dict[str, int] = {}
        for e in items:
            if e.amount < 0:
                by_cat[e.category] = by_cat.get(e.category, 0) - e.amount
        year, mon = map(int, month.split("-"))
        days_in_month = calendar.monthrange(year, mon)[1]
        if ref and ref.strftime("%Y-%m") == month:
            day_no = ref.day
        elif ref and ref.strftime("%Y-%m") < month:
            day_no = 0
        else:
            day_no = days_in_month
        daily = (expense // day_no) // 100 * 100 if day_no else 0
        forecast = daily * days_in_month if day_no else expense
        budgets = self.budgets()
        cats = []
        for cat in sorted(set(by_cat) | set(budgets), key=lambda c: -by_cat.get(c, 0)):
            spent, limit = by_cat.get(cat, 0), budgets.get(cat)
            cats.append({"category": cat, "spent": spent, "limit": limit,
                         "percent": round(spent * 100 / limit) if limit else None})
        total_limit = sum(budgets.values())
        return {
            "month": month, "currency": self.currency,
            "income": income, "expense": expense, "net": income - expense,
            "daily_average": daily, "forecast": forecast,
            "budget_total": total_limit or None,
            "budget_percent": round(expense * 100 / total_limit) if total_limit else None,
            "categories": cats,
            "recent": [e.as_dict() for e in sorted(items, key=lambda e: e.date, reverse=True)[:12]],
            "count": len(items),
        }

    def budget_alert(self, category: str, month: str) -> str | None:
        """Сообщение, если после траты категория перешла 80% или 100% лимита."""
        limit = self.budgets().get(category)
        if not limit:
            return None
        spent = -sum(e.amount for e in self.entries(month) if e.amount < 0 and e.category == category)
        pct = spent * 100 // limit
        if pct >= 100:
            return (f"Бюджет «{category}» исчерпан: {ru.money(spent, self.currency)} "
                    f"из {ru.money(limit, self.currency)} ({pct}%).")
        if pct >= 80:
            return f"Бюджет «{category}» израсходован на {pct}%: осталось {ru.money(limit - spent, self.currency)}."
        return None


def _shift_month(month: str, n: int) -> str:
    y, m = map(int, month.split("-"))
    k = y * 12 + (m - 1) + n
    return f"{k // 12:04d}-{k % 12 + 1:02d}"


def op_key(note: str) -> str:
    """Ключ для поиска повторяющихся операций: «Spotify 11/2026» и «spotify» — одно и то же."""
    low = re.sub(r"[\d.,:/#№-]+", " ", note.lower().replace("ё", "е"))
    return re.sub(r"\s+", " ", low).strip()


def pct(part: int, whole: int) -> int:
    """Процент с округлением половины вверх — одинаково в Python и JS (round() в Python — банковское)."""
    return (part * 200 + whole) // (2 * whole)


def _median(values: list[int]) -> int:
    v = sorted(values)
    return v[len(v) // 2] if v else 0


def analytics(ledger: "Ledger", ref: date, months: int = 6) -> dict:
    """Аналитика без модели: динамика по месяцам, категории к среднему, регулярные платежи, частые операции,
    выводы. Тот же расчёт — `analytics()` в core/finance.js (общий тест — tests/js/fixtures/finance.json)."""
    cur = ref.strftime("%Y-%m")
    months = max(2, min(24, months))
    span = [_shift_month(cur, -i) for i in range(months - 1, -1, -1)]
    by_month = {m: ledger.entries(m) for m in span}
    trend = []
    for m in span:
        items = by_month[m]
        inc = sum(e.amount for e in items if e.amount > 0)
        exp = -sum(e.amount for e in items if e.amount < 0)
        trend.append({"month": m, "income": inc, "expense": exp, "net": inc - exp, "count": len(items)})
    now = trend[-1]
    prev = [t for t in trend[-4:-1] if t["count"]]          # до трёх прошлых месяцев с данными
    avg_exp = sum(t["expense"] for t in prev) // len(prev) // 100 * 100 if prev else 0   # до рубля

    def cats(items: list[Entry]) -> dict[str, int]:
        out: dict[str, int] = defaultdict(int)
        for e in items:
            if e.amount < 0:
                out[e.category] -= e.amount
        return out

    this_cats = cats(by_month[cur])
    # таблица «категория × месяц» для 3D-карты расходов: шесть самых затратных категорий за весь срок
    per = {m: cats(by_month[m]) for m in span}
    totals: dict[str, int] = defaultdict(int)
    for m in span:
        for c, v in per[m].items():
            totals[c] += v
    top_cats = [c for c, _ in sorted(totals.items(), key=lambda kv: (-kv[1], kv[0]))[:6]]
    matrix = {"months": span, "categories": top_cats, "values": [[per[m].get(c, 0) for m in span] for c in top_cats]}
    prev_cats = [cats(by_month[t["month"]]) for t in prev]
    categories = []
    for c in sorted(set(this_cats) | {k for pc in prev_cats for k in pc}, key=lambda c: (-this_cats.get(c, 0), c)):
        avg = sum(pc.get(c, 0) for pc in prev_cats) // len(prev_cats) if prev_cats else 0
        spent = this_cats.get(c, 0)
        categories.append({"category": c, "spent": spent, "average": avg,
                           "change": pct(spent - avg, avg) if avg else None,
                           "share": pct(spent, now["expense"]) if now["expense"] else 0})

    # регулярные: та же операция (описание + категория) в двух и более месяцах из последних четырёх
    groups: dict[tuple[str, str], list[Entry]] = defaultdict(list)
    for m in span[-4:]:
        for e in by_month[m]:
            if e.amount < 0 and op_key(e.note):
                groups[(op_key(e.note), e.category)].append(e)
    recurring = []
    for (key, cat), items in groups.items():
        seen = sorted({e.date[:7] for e in items})
        if len(seen) < 2:
            continue
        last = max(items, key=lambda e: e.date)
        paid = cur in seen
        recurring.append({"note": last.note, "category": cat, "amount": _median([-e.amount for e in items]),
                          "months": len(seen), "last": last.date, "day": int(last.date[8:]), "paid": paid})
    recurring.sort(key=lambda r: (r["paid"], -r["amount"], r["note"]))
    pending = sum(r["amount"] for r in recurring if not r["paid"])

    # частые операции за последние 3 месяца — кнопки «в одно касание»
    counter: Counter = Counter()
    sample: dict[tuple[str, str, bool], list[int]] = defaultdict(list)
    notes: dict[tuple[str, str, bool], str] = {}
    for m in span[-3:]:
        for e in by_month[m]:
            k = (op_key(e.note) or e.category.lower(), e.category, e.amount > 0)
            counter[k] += 1
            sample[k].append(e.amount)
            notes[k] = e.note or e.category
    frequent = [{"note": notes[k], "category": k[1], "amount": _median(sample[k]), "count": n}
                for k, n in sorted(counter.items(), key=lambda kv: (-kv[1], *kv[0]))[:8] if n >= 2]

    days_in = calendar.monthrange(ref.year, ref.month)[1]
    forecast = (now["expense"] // ref.day) // 100 * 100 * days_in     # как в summary(): шаг — рубль в день
    insights: list[str] = []
    money = lambda k: ru.money(k, ledger.currency)  # noqa: E731
    if now["income"]:
        rate = pct(now["net"], now["income"])
        insights.append(f"Сбережения месяца: {rate}% дохода ({money(now['net'])})." if rate >= 0 else
                        f"Расходы превышают доходы на {money(-now['net'])}.")
    if avg_exp and forecast > avg_exp * 1.15:
        insights.append(f"Темп трат выше обычного: к концу месяца выйдет ~{money(forecast)} "
                        f"при среднем {money(avg_exp)}.")
    elif avg_exp and forecast < avg_exp * 0.85:
        insights.append(f"Тратите меньше обычного: прогноз {money(forecast)} при среднем {money(avg_exp)}.")
    for c in categories:
        if c["change"] is not None and c["change"] >= 30 and c["spent"] - c["average"] >= 100_000:
            insights.append(f"«{c['category']}»: {money(c['spent'])} — на {c['change']}% больше среднего.")
    if pending:
        n = sum(1 for r in recurring if not r["paid"])
        word = ru.plural(n, "регулярного платежа", "регулярных платежей", "регулярных платежей")
        insights.append(f"Ещё не было {n} {word} "
                        f"на {money(pending)}.")
    big = sorted((e for e in by_month[cur] if e.amount < 0), key=lambda e: e.amount)[:5]
    return {
        "month": cur, "currency": ledger.currency, "trend": trend,
        "average_expense": avg_exp, "forecast": forecast,
        "savings_rate": pct(now["net"], now["income"]) if now["income"] else None,
        "categories": categories, "recurring": recurring, "recurring_pending": pending,
        "frequent": frequent, "top": [e.as_dict() for e in big], "insights": insights[:6], "matrix": matrix,
    }
