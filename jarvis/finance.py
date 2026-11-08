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
