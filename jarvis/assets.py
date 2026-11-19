"""Активы и долги в Obsidian: `Finance/Assets.md` — две таблицы, «Активы» и «Долги».

| Актив | Вид | Количество | Цена покупки | Тикер | Дата покупки | Оценка |
|-------|-----|-----------:|-------------:|-------|--------------|-------:|
| Сбербанк | акция | 10 | 280 | SBER | 2026-03-01 | |
| Bitcoin | крипто | 0,01 | 6 000 000 | BTC | | |
| iPhone 15 | техника | 1 | 90 000 | | 2024-09-20 | |

Цены — за единицу. Оценка сама: акции, фонды и облигации — Мосбиржа (ISS), крипта — CoinGecko, валюта — ЦБ,
имущество — по виду актива (`PROPERTY`: техника дешевеет, недвижимость дорожает). Своя цена — в колонке «Оценка».
Долги — таблица «Кому | Сумма | Срок | Заметка» и проекты с тегом `долг` (сумма — из описания: «Отдать 165 000₽»).
История капитала — `Finance/Capital.md` (строка в день). Порт для iPhone — `core/assets.js`, расчёт совпадает.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from datetime import date
from typing import Any, Awaitable, Callable

import aiohttp

from . import ru
from .finance import pct
from .vault import Vault

log = logging.getLogger("jarvis.assets")

KINDS = {   # вид → (подпись, слова в колонке «Вид»)
    "stock": ("Акции", ["акци", "stock", "share"]),
    "fund": ("Фонды", ["фонд", "etf", "бпиф", "пиф"]),
    "bond": ("Облигации", ["облиг", "bond", "офз"]),
    "crypto": ("Крипта", ["крипт", "crypto", "coin", "токен"]),
    "fx": ("Валюта", ["валют", "fx", "currency"]),
    "cash": ("Деньги", ["деньг", "налич", "вклад", "депозит", "счёт", "счет", "cash", "накоплен"]),
    "realty": ("Недвижимость", ["недвиж", "квартир", "дом", "земл", "дач", "гараж"]),
    "car": ("Транспорт", ["авто", "машин", "мото", "транспорт"]),
    "tech": ("Техника", ["техник", "электрон", "телефон", "ноутбук", "компьютер", "гаджет"]),
    "other": ("Имущество", []),
}
MARKET = ("stock", "fund", "bond", "crypto", "fx")
# имущество без своей оценки: % в год и нижняя граница от цены покупки (в процентах)
PROPERTY = {"realty": (5, 100), "car": (-12, 25), "tech": (-25, 10), "other": (-10, 20)}
CRYPTO_IDS = {"BTC": "bitcoin", "ETH": "ethereum", "USDT": "tether", "USDC": "usd-coin", "TON": "the-open-network",
              "SOL": "solana", "BNB": "binancecoin", "XRP": "ripple", "DOGE": "dogecoin", "TRX": "tron",
              "ADA": "cardano", "LTC": "litecoin", "DOT": "polkadot", "NOT": "notcoin", "AVAX": "avalanche-2",
              "PAXG": "pax-gold", "XAUT": "tether-gold"}
ASSET_COLS = {"name": ["актив", "название", "имущество"], "kind": ["вид", "тип"],
              "qty": ["количество", "кол-во", "штук"], "buy": ["цена покупки", "куплено", "цена", "стоимость покупки"],
              "ticker": ["тикер", "код"], "date": ["дата"], "price": ["оценка", "цена сейчас"]}
DEBT_COLS = {"name": ["кому", "долг", "кредитор"], "amount": ["сумма", "остаток"], "due": ["срок"],
             "note": ["заметка", "описание", "комментарий"]}
TEMPLATE = """---
type: finance-assets
---
# Активы и долги

Цены — за единицу. Оценка обновляется сама: акции, фонды и облигации — Мосбиржа (тикер: SBER, TMOS, SU26238RMFS4),
крипта — CoinGecko (BTC, ETH, TON), валюта — ЦБ (USD, EUR, CNY). Имущество оценивается по виду: техника дешевеет
~25% в год, авто ~12%, недвижимость дорожает ~5%. Своя цена — в колонке «Оценка».
Виды: акция, фонд, облигация, крипто, валюта, деньги, недвижимость, авто, техника, имущество.

## Активы
| Актив | Вид | Количество | Цена покупки | Тикер | Дата покупки | Оценка |
|-------|-----|-----------:|-------------:|-------|--------------|-------:|

## Долги
| Кому | Сумма | Срок | Заметка |
|------|------:|------|---------|
"""
CAPITAL_HEAD = ("---\ntype: finance-capital\n---\n# Капитал — история\n\n"
                "Строка в день: активы, долги и чистый капитал. "
                "Пишет Atom, когда открывают «Активы».\n\n| Дата | Активы | Долги | Капитал |\n"
                "|------|-------:|------:|--------:|\n")


def kind_of(text: str) -> str:
    low = text.lower().strip()
    if low in KINDS:
        return low
    for k, (_, words) in KINDS.items():
        if any(w in low for w in words):
            return k
    return "other"


def parse_qty(cell: str) -> float | None:
    s = re.sub(r"[\s ]", "", cell).replace(",", ".")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def rub_cell(kop: int) -> str:
    """Копейки → ячейка таблицы: 125000, 1250.5, -300."""
    v = f"{abs(kop) / 100:.2f}".rstrip("0").rstrip(".")
    return ("-" if kop < 0 else "") + v


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _map(header: list[str], names: dict[str, list[str]]) -> dict[str, int]:
    out: dict[str, int] = {}
    for i, h in enumerate(header):
        low = h.lower()
        for key, words in names.items():
            if key not in out and any(low.startswith(w) for w in words):
                out[key] = i
                break
    return out


def tables(text: str) -> list[tuple[list[str], list[list[str]], int]]:
    """Таблицы markdown: (шапка, строки, номер последней строки таблицы)."""
    out = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        sep = i + 1 < len(lines) and re.fullmatch(r"\|?[\s:|-]+\|?", lines[i + 1].strip())
        if lines[i].strip().startswith("|") and sep:
            head = _cells(lines[i])
            rows, j = [], i + 2
            while j < len(lines) and lines[j].strip().startswith("|"):
                rows.append(_cells(lines[j]))
                j += 1
            out.append((head, rows, j - 1))
            i = j
        else:
            i += 1
    return out


def _years(since: str, today: date) -> float:
    try:
        d = date.fromisoformat(since)
    except ValueError:
        return 0.0
    return max(0.0, (today - d).days / 365.25)


def property_value(kind: str, buy: int, since: str, today: date) -> int:
    rate, floor = PROPERTY.get(kind, PROPERTY["other"])
    years = _years(since, today)
    value = int(buy * (1 + rate / 100) ** years / 100 + 0.5) * 100      # до рубля
    return max(value, buy * floor // 100 // 100 * 100) if rate < 0 else value


DEBT_AMOUNT = re.compile(r"(\d[\d\s\u00a0]*(?:[.,]\d{1,2})?)\s*(тыс\b\.?|к\b)?")


def parse_debt_amount(text: str) -> int | None:
    """«Отдать 165 000₽», «Отдать долг 100 000₽», «Отдать 50 000 в декабре» → копейки; без суммы — None."""
    for m in DEBT_AMOUNT.finditer(text):
        try:
            value = float(re.sub(r"[\s\u00a0]", "", m.group(1)).replace(",", "."))
        except ValueError:
            continue
        if m.group(2):
            value *= 1000
        if value >= 100:          # «в 2 этапа», «4 декабря» — не сумма
            return int(round(value * 100))
    return None


class Portfolio:
    def __init__(self, vault: Vault, folder: str = "Finance", currency: str = "RUB", projects=None):
        self.vault = vault
        self.folder = folder.strip("/")
        self.currency = currency
        self.projects = projects          # Projects — долги из проектов с тегом «долг»

    @property
    def path(self) -> str:
        return f"{self.folder}/Assets.md"

    @property
    def capital_path(self) -> str:
        return f"{self.folder}/Capital.md"

    def exists(self) -> bool:
        return self.vault.exists(self.path)

    def init(self) -> str:
        if not self.exists():
            self.vault.write(self.path, TEMPLATE)
        return self.path

    # ---------- чтение ----------
    def read(self) -> tuple[list[dict], list[dict]]:
        assets: list[dict] = []
        debts: list[dict] = []
        if self.exists():
            for head, rows, _ in tables(self.vault.read(self.path)):
                a, d = _map(head, ASSET_COLS), _map(head, DEBT_COLS)
                if "name" in a and ("buy" in a or "qty" in a) and "amount" not in d:
                    for r in rows:
                        r += [""] * (len(head) - len(r))
                        get = lambda k: r[a[k]].strip() if k in a else ""  # noqa: E731
                        name = get("name")
                        if not name or set(name) <= {"-", ":"}:
                            continue
                        qty = parse_qty(get("qty"))
                        assets.append({"name": name, "kind": kind_of(get("kind")), "qty": 1.0 if qty is None else qty,
                                       "buy": abs(ru.parse_money_cell(get("buy")) or 0),
                                       "ticker": get("ticker").upper(), "date": get("date"),
                                       "price": ru.parse_money_cell(get("price")) if get("price") else None})
                elif "name" in d and "amount" in d:
                    for r in rows:
                        r += [""] * (len(head) - len(r))
                        amount = ru.parse_money_cell(r[d["amount"]])
                        if not r[d["name"]] or amount is None:
                            continue
                        debts.append({"name": r[d["name"]], "amount": abs(amount),
                                      "due": r[d["due"]] if "due" in d else "",
                                      "note": r[d["note"]] if "note" in d else "", "source": self.path})
        debts += self.project_debts({x["name"].lower() for x in debts})
        return assets, debts

    def project_debts(self, known: set[str]) -> list[dict]:
        if not self.projects:
            return []
        out = []
        for p in self.projects.list():
            tags = {t.strip().lstrip("#") for t in re.split(r"[,\s]+", p.tag) if t.strip()}
            if "долг" not in tags or p.status == "done" or p.name.lower() in known:
                continue
            amount = parse_debt_amount(p.description)
            if amount:
                out.append({"name": p.name, "amount": amount, "due": "", "note": p.description, "source": p.note})
        return out

    # ---------- оценка ----------
    def valuate(self, assets: list[dict], debts: list[dict], quotes: dict[str, tuple[int | None, float | None]],
                today: date) -> dict:
        items = []
        for a in assets:
            qty, buy = a["qty"], a["buy"]
            cost = int(round(buy * qty))
            change = None
            if a["price"] is not None:
                price, source = abs(a["price"]), "вручную"
            elif a["kind"] == "cash":
                price, source = buy, "по сумме"
            elif a["kind"] in MARKET and a["ticker"]:
                price, change = quotes.get(f"{a['kind']}:{a['ticker']}", (None, None))
                source = "рынок" if price is not None else "нет котировки"
                price = buy if price is None else price
            elif a["kind"] in MARKET:
                price, source = buy, "без тикера"
            else:
                price, source = property_value(a["kind"], buy, a["date"], today), "по виду актива"
            value = int(round(price * qty))
            items.append({**a, "kind_label": KINDS[a["kind"]][0], "cost": cost, "unit": price, "value": value,
                          "pnl": value - cost, "pnl_pct": pct(value - cost, cost) if cost else None,
                          "change": change, "source": source})
        total = sum(i["value"] for i in items)
        cost = sum(i["cost"] for i in items)
        debt = sum(d["amount"] for d in debts)
        kinds: dict[str, int] = {}
        for i in items:
            kinds[i["kind"]] = kinds.get(i["kind"], 0) + i["value"]
        by_kind = [{"kind": k, "label": KINDS[k][0], "value": v, "share": pct(v, total) if total else 0}
                   for k, v in sorted(kinds.items(), key=lambda kv: (-kv[1], kv[0]))]
        return {"currency": self.currency, "exists": self.exists(), "path": self.path,
                "items": sorted(items, key=lambda i: (-i["value"], i["name"])), "debts": debts,
                "total": total, "cost": cost, "pnl": total - cost, "pnl_pct": pct(total - cost, cost) if cost else None,
                "debt": debt, "net_worth": total - debt, "by_kind": by_kind}

    # ---------- история капитала ----------
    def history(self) -> list[dict]:
        if not self.vault.exists(self.capital_path):
            return []
        out = []
        for head, rows, _ in tables(self.vault.read(self.capital_path)):
            for r in rows:
                if len(r) >= 4 and re.fullmatch(r"\d{4}-\d{2}-\d{2}", r[0]):
                    vals = [ru.parse_money_cell(c) for c in r[1:4]]
                    if None not in vals:
                        out.append({"date": r[0], "total": vals[0], "debt": vals[1], "net_worth": vals[2]})
        return sorted(out, key=lambda h: h["date"])

    def record(self, today: date, report: dict) -> list[dict]:
        """Строка за сегодня в Capital.md (заменяется, если уже есть). Пустой портфель не пишется."""
        hist = self.history()
        if not report["items"] and not report["debts"]:
            return hist
        row = {"date": today.isoformat(), "total": report["total"], "debt": report["debt"],
               "net_worth": report["net_worth"]}
        if hist and hist[-1] == row:
            return hist
        line = f"| {row['date']} | {rub_cell(row['total'])} | {rub_cell(row['debt'])} | {rub_cell(row['net_worth'])} |"
        text = self.vault.read(self.capital_path) if self.vault.exists(self.capital_path) else CAPITAL_HEAD
        lines = text.rstrip("\n").splitlines()
        rows = [i for i, ln in enumerate(lines) if ln.strip().startswith("|")]
        same = next((i for i in rows if ln_date(lines[i]) == row["date"]), None)
        if same is not None:
            lines[same] = line
        elif rows:
            lines.insert(rows[-1] + 1, line)
        else:
            lines += ["", "| Дата | Активы | Долги | Капитал |", "|------|-------:|------:|--------:|", line]
        self.vault.write(self.capital_path, "\n".join(lines) + "\n")
        return [h for h in hist if h["date"] != row["date"]] + [row]

    # ---------- запись строк ----------
    def add_asset(self, name: str, kind: str, qty: float, buy: int, ticker: str = "", day: str = "",
                  price: int | None = None) -> dict:
        if not name.strip():
            raise ValueError("не указано название актива")
        qty_s = (f"{qty:.8f}".rstrip("0").rstrip(".") if qty else "1").replace(".", ",")
        cells = [name, kind or "имущество", qty_s, rub_cell(buy), ticker.upper(), day,
                 rub_cell(price) if price is not None else ""]
        self._insert("asset", "| " + " | ".join(_clean(c) for c in cells) + " |")
        return {"name": name, "kind": kind_of(kind), "qty": qty or 1, "buy": buy, "ticker": ticker.upper()}

    def add_debt(self, name: str, amount: int, due: str = "", note: str = "") -> dict:
        if not name.strip() or not amount:
            raise ValueError("нужны «кому» и сумма")
        cells = [name, rub_cell(abs(amount)), due, note]
        self._insert("debt", "| " + " | ".join(_clean(c) for c in cells) + " |")
        return {"name": name, "amount": abs(amount), "due": due, "note": note}

    def _insert(self, which: str, row: str) -> None:
        self.init()
        text = self.vault.read(self.path)
        for head, _, last in tables(text):
            a, d = _map(head, ASSET_COLS), _map(head, DEBT_COLS)
            is_debt = "name" in d and "amount" in d
            if (which == "debt") == is_debt and (is_debt or "name" in a):
                lines = text.splitlines()
                lines.insert(last + 1, row)
                self.vault.write(self.path, "\n".join(lines) + "\n")
                return
        head = (["## Долги", "| Кому | Сумма | Срок | Заметка |", "|------|------:|------|---------|"]
                if which == "debt" else
                ["## Активы", "| Актив | Вид | Количество | Цена покупки | Тикер | Дата покупки | Оценка |",
                 "|-------|-----|-----------:|-------------:|-------|--------------|-------:|"])
        self.vault.write(self.path, text.rstrip("\n") + "\n\n" + "\n".join(head + [row]) + "\n")


def ln_date(line: str) -> str:
    c = _cells(line)
    return c[0] if c else ""


def _clean(s: Any) -> str:
    return str(s).replace("|", "/").replace("\n", " ").strip()


# ---------- котировки ----------
FetchJson = Callable[[str, dict], Awaitable[Any]]


class Quotes:
    """Котировки без ключей: Мосбиржа ISS, CoinGecko, ЦБ РФ. Кэш 10 минут; недоступно — None, не исключение."""
    MOEX = "https://iss.moex.com/iss/engines/stock/markets/{market}/securities/{ticker}.json"
    COINGECKO = "https://api.coingecko.com/api/v3/simple/price"
    CBR = "https://www.cbr-xml-daily.ru/daily_json.js"

    def __init__(self, fetch_json: FetchJson | None = None, ttl: float = 600):
        self._fetch = fetch_json
        self._session: aiohttp.ClientSession | None = None
        self._cache: dict[str, tuple[float, tuple[int | None, float | None]]] = {}
        self.ttl = ttl

    async def fetch_json(self, url: str, params: dict) -> Any:
        if self._fetch:
            return await self._fetch(url, params)
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=8), trust_env=True,
                                                  headers={"User-Agent": "atom-dashboard"})
        async with self._session.get(url, params=params) as r:
            r.raise_for_status()
            return await r.json(content_type=None)

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def get(self, assets: list[dict]) -> dict[str, tuple[int | None, float | None]]:
        want = sorted({f"{a['kind']}:{a['ticker']}" for a in assets if a["kind"] in MARKET and a["ticker"]})
        now = time.monotonic()
        out = {k: self._cache[k][1] for k in want if k in self._cache and now - self._cache[k][0] < self.ttl}
        todo = [k for k in want if k not in out]
        if not todo:
            return out
        jobs = [self._moex(k) for k in todo if k.split(":")[0] in ("stock", "fund", "bond")]
        crypto = [k for k in todo if k.startswith("crypto:")]
        if crypto:
            jobs.append(self._crypto(crypto))
        if any(k.startswith("fx:") for k in todo):
            jobs.append(self._fx([k for k in todo if k.startswith("fx:")]))
        for res in await asyncio.gather(*jobs, return_exceptions=True):
            if isinstance(res, BaseException):
                log.info("котировки недоступны: %s", res)
                continue
            for k, v in res.items():
                self._cache[k] = (now, v)
                out[k] = v
        return out

    async def _moex(self, key: str) -> dict:
        kind, ticker = key.split(":", 1)
        market = "bonds" if kind == "bond" else "shares"
        d = await self.fetch_json(self.MOEX.format(market=market, ticker=ticker),
                                  {"iss.meta": "off", "iss.only": "securities,marketdata",
                                   "securities.columns": "SECID,BOARDID,FACEVALUE,PREVPRICE",
                                   "marketdata.columns": "SECID,BOARDID,LAST,MARKETPRICE,LASTTOPREVPRICE"})
        return {key: moex_price(d, kind)}

    async def _crypto(self, keys: list[str]) -> dict:
        ids = {k: CRYPTO_IDS.get(k.split(":", 1)[1], k.split(":", 1)[1].lower()) for k in keys}
        d = await self.fetch_json(self.COINGECKO, {"ids": ",".join(sorted(set(ids.values()))),
                                                   "vs_currencies": "rub", "include_24hr_change": "true"})
        out = {}
        for k, cid in ids.items():
            row = d.get(cid) or {}
            price = row.get("rub")
            ch = row.get("rub_24h_change")
            out[k] = (int(round(price * 100)) if price is not None else None,
                      round(ch, 2) if ch is not None else None)
        return out

    async def _fx(self, keys: list[str]) -> dict:
        d = await self.fetch_json(self.CBR, {})
        out = {}
        for k in keys:
            v = d.get("Valute", {}).get(k.split(":", 1)[1])
            if not v:
                out[k] = (None, None)
                continue
            nominal = v.get("Nominal", 1) or 1
            out[k] = (int(round(v["Value"] / nominal * 100)),
                      round((v["Value"] - v["Previous"]) * 100 / v["Previous"], 2) if v.get("Previous") else None)
        return out


def moex_price(d: dict, kind: str) -> tuple[int | None, float | None]:
    """Ответ ISS → (цена за бумагу в копейках, изменение за день в %). Облигации — % от номинала."""
    def rows(block: str) -> list[dict]:
        b = d.get(block) or {}
        return [dict(zip(b.get("columns", []), r)) for r in b.get("data", [])]

    md = rows("marketdata")
    sec = rows("securities")
    pick = next((r for r in md if r.get("LAST")), None) or next((r for r in md if r.get("MARKETPRICE")), None)
    price = (pick or {}).get("LAST") or (pick or {}).get("MARKETPRICE")
    board = (pick or {}).get("BOARDID")
    if price is None:
        s = next((r for r in sec if r.get("PREVPRICE")), None)
        price, board = (s or {}).get("PREVPRICE"), (s or {}).get("BOARDID")
    if price is None:
        return None, None
    change = (pick or {}).get("LASTTOPREVPRICE")
    if kind == "bond":
        s = next((r for r in sec if r.get("BOARDID") == board and r.get("FACEVALUE")), None) or \
            next((r for r in sec if r.get("FACEVALUE")), None)
        if not s:
            return None, None
        price = price * s["FACEVALUE"] / 100
    return int(round(price * 100)), round(change, 2) if change is not None else None
