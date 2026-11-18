"""Финансы: аналитика по месяцам, регулярные платежи, активы с котировками, долги, история капитала.

Вход и ответ Python лежат в tests/js/fixtures/finance.json — ядро для iPhone (core/finance.js, core/assets.js)
обязано ответить так же. Поменяли правила — пересоздайте: `REGEN_FIXTURES=1 python -m pytest tests/test_assets.py`.
"""
from __future__ import annotations

import asyncio
import json
import os
from datetime import date
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer

from jarvis.assets import Portfolio, Quotes, moex_price, parse_debt_amount, property_value
from jarvis.finance import Ledger, analytics, op_key
from jarvis.projects import Projects
from jarvis.vault import Vault
from jarvis.web import build_app

from .conftest import make_jarvis

FIXTURE = Path(__file__).parent / "js" / "fixtures" / "finance.json"
TODAY = date(2026, 11, 18)
HEAD = "| Дата | Сумма | Категория | Описание | Счёт |\n|------|------:|-----------|----------|------|\n"


def month(m: str, rows: list[tuple]) -> str:
    return (f"---\ntype: finance-ledger\nmonth: {m}\n---\n# Финансы\n\n" + HEAD
            + "".join(f"| {d} | {a} | {c} | {n} |  |\n" for d, a, c, n in rows))


FILES = {
    "Finance/2026-08.md": month("2026-08", [("2026-08-05", "+60000", "Доход", "Зарплата"),
                                            ("2026-08-07", "-399", "Подписки", "Spotify 08/2026"),
                                            ("2026-08-10", "-12000", "Еда", "Продукты"),
                                            ("2026-08-15", "-2500", "Кафе", "Кофе")]),
    "Finance/2026-09.md": month("2026-09", [("2026-09-05", "+60000", "Доход", "Зарплата"),
                                            ("2026-09-07", "-399", "Подписки", "Spotify 09/2026"),
                                            ("2026-09-11", "-11000", "Еда", "Продукты"),
                                            ("2026-09-20", "-1500", "Связь", "Интернет")]),
    "Finance/2026-10.md": month("2026-10", [("2026-10-05", "+62000", "Доход", "Зарплата"),
                                            ("2026-10-07", "-399", "Подписки", "Spotify 10/2026"),
                                            ("2026-10-12", "-13000", "Еда", "Продукты"),
                                            ("2026-10-20", "-1500", "Связь", "Интернет"),
                                            ("2026-10-22", "-3000", "Кафе", "Кофе")]),
    "Finance/2026-11.md": month("2026-11", [("2026-11-05", "+62000", "Доход", "Зарплата"),
                                            ("2026-11-09", "-14000", "Еда", "Продукты"),
                                            ("2026-11-10", "-9000", "Кафе", "Кофе"),
                                            ("2026-11-12", "-42", "Транспорт", "Метро"),
                                            ("2026-11-13", "-42", "Транспорт", "Метро")]),
    "Finance/Assets.md": (
        "---\ntype: finance-assets\n---\n# Активы и долги\n\n## Активы\n"
        "| Актив | Вид | Количество | Цена покупки | Тикер | Дата покупки | Оценка |\n"
        "|-------|-----|-----------:|-------------:|-------|--------------|-------:|\n"
        "| Сбербанк | акция | 10 | 280 | SBER | 2026-03-01 | |\n"
        "| Bitcoin | крипто | 0,01 | 6 000 000 | BTC | | |\n"
        "| ОФЗ 26238 | облигация | 5 | 610 | SU26238RMFS4 | | |\n"
        "| Доллары | валюта | 300 | 90 | USD | | |\n"
        "| Подушка | деньги | 1 | 50 000 | | | |\n"
        "| iPhone 15 | техника | 1 | 90 000 | | 2024-09-20 | |\n"
        "| Квартира | недвижимость | 1 | 8 000 000 | | 2026-11-18 | 9 000 000 |\n"
        "| Акции без котировки | акция | 2 | 100 | NOPE | | |\n\n"
        "## Долги\n| Кому | Сумма | Срок | Заметка |\n|------|------:|------|---------|\n"
        "| Паше | 10 000 | 2026-12-01 | за ремонт |\n"),
    "Projects/Отдать долг Ване.md": ("---\ntype: project\nstatus: active\ntag: отдать-долг-ване, финансы, долг\n---\n"
                                     "# Отдать долг Ване\n\nОтдать 165 000₽\n"),
    "Projects/Военный билет.md": ("---\ntype: project\nstatus: active\ntag: военный-билет, финансы\n---\n"
                                  "# Военный билет\n\nНакопить 200 000 и договориться\n"),
    "Projects/Старый долг.md": ("---\ntype: project\nstatus: done\ntag: долг\n---\n# Старый долг\n\nОтдать 5 000\n"),
}
QUOTES = {"stock:SBER": [31050, 1.25], "crypto:BTC": [850000000, -2.1], "bond:SU26238RMFS4": [60250, None],
          "fx:USD": [8150, 0.3]}


def build(tmp: Path) -> tuple[Ledger, Portfolio]:
    vault = Vault(tmp / "vault")
    for rel, text in FILES.items():
        vault.write(rel, text)
    projects = Projects(vault, "Projects", None)
    return Ledger(vault), Portfolio(vault, "Finance", "RUB", projects)


def compute(tmp: Path) -> dict:
    ledger, port = build(tmp)
    assets, debts = port.read()
    quotes = {k: tuple(v) for k, v in QUOTES.items()}
    return {"analytics": analytics(ledger, TODAY, 6),
            "assets": port.valuate(assets, debts, quotes, TODAY)}


def test_shared_fixture(tmp_path):
    got = json.loads(json.dumps(compute(tmp_path), ensure_ascii=False))
    if os.environ.get("REGEN_FIXTURES"):
        FIXTURE.write_text(json.dumps({"today": TODAY.isoformat(), "files": FILES, "quotes": QUOTES, "expected": got},
                                      ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    assert got == json.loads(FIXTURE.read_text(encoding="utf-8"))["expected"]


def test_analytics(tmp_path):
    ledger, _ = build(tmp_path)
    a = analytics(ledger, TODAY, 6)
    assert [t["month"] for t in a["trend"]] == ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"]
    nov = a["trend"][-1]
    assert nov["income"] == 6_200_000 and nov["expense"] == 2_308_400
    assert a["average_expense"] == 1_523_200
    cafe = next(c for c in a["categories"] if c["category"] == "Кафе")
    assert cafe["average"] == (250_000 + 0 + 300_000) // 3 and cafe["change"] > 30
    # Spotify — каждый месяц, в ноябре ещё не было; интернет — дважды, тоже не оплачен
    spotify = next(r for r in a["recurring"] if r["category"] == "Подписки")
    assert spotify["paid"] is False and spotify["amount"] == 39_900 and spotify["months"] == 3
    assert any(r["note"] == "Продукты" and r["paid"] for r in a["recurring"])
    assert a["recurring_pending"] == 39_900 + 150_000
    assert a["frequent"][0]["note"] in ("Зарплата", "Продукты")
    assert any(f["note"] == "Метро" and f["amount"] == -4200 for f in a["frequent"])
    assert any("Кафе" in s for s in a["insights"]) and any("регулярн" in s for s in a["insights"])
    assert a["savings_rate"] == 63
    m = a["matrix"]                                   # 3D-карта: категория × месяц
    assert m["categories"][0] == "Еда" and len(m["values"][0]) == 6 and m["values"][0][-1] == 1_400_000


def test_op_key():
    assert op_key("Spotify 11/2026") == op_key("spotify") == "spotify"
    assert op_key("Ёлка №2") == "елка"


def test_assets_valuation(tmp_path):
    r = compute(tmp_path)["assets"]
    by = {i["name"]: i for i in r["items"]}
    sber = by["Сбербанк"]
    assert sber["value"] == 310_500 and sber["source"] == "рынок" and sber["change"] == 1.25
    assert by["Bitcoin"]["value"] == 8_500_000 and by["Bitcoin"]["cost"] == 6_000_000
    assert by["ОФЗ 26238"]["value"] == 301_250
    assert by["Подушка"]["value"] == 5_000_000 and by["Подушка"]["source"] == "по сумме"
    assert by["Квартира"]["value"] == 900_000_000 and by["Квартира"]["source"] == "вручную"
    assert by["Акции без котировки"]["source"] == "нет котировки" and by["Акции без котировки"]["value"] == 20_000
    iphone = by["iPhone 15"]
    assert iphone["source"] == "по виду актива" and 4_500_000 < iphone["value"] < 5_200_000
    names = {d["name"]: d for d in r["debts"]}
    assert set(names) == {"Паше", "Отдать долг Ване"}         # военный билет — не долг, закрытый — не считается
    assert names["Отдать долг Ване"]["amount"] == 16_500_000
    assert r["debt"] == 17_500_000 and r["net_worth"] == r["total"] - r["debt"]
    assert r["by_kind"][0]["kind"] == "realty" and sum(k["value"] for k in r["by_kind"]) == r["total"]


def test_property_and_debt_amount():
    assert property_value("tech", 100_000, "2010-01-01", TODAY) == 10_000            # не ниже 10% цены
    assert property_value("realty", 100_000, "", TODAY) == 100_000
    assert parse_debt_amount("Отдать 50 000 в декабре") == 5_000_000
    assert parse_debt_amount("Вернуть 2 тыс до 4 декабря") == 200_000
    assert parse_debt_amount("Договориться") is None


def test_moex_price():
    d = {"marketdata": {"columns": ["SECID", "BOARDID", "LAST", "MARKETPRICE", "LASTTOPREVPRICE"],
                        "data": [["SBER", "SMAL", None, None, None], ["SBER", "TQBR", 310.5, 310.1, 1.25]]},
         "securities": {"columns": ["SECID", "BOARDID", "FACEVALUE", "PREVPRICE"], "data": [["SBER", "TQBR", 3, 306]]}}
    assert moex_price(d, "stock") == (31050, 1.25)
    bond = {"marketdata": {"columns": ["BOARDID", "LAST"], "data": [["TQOB", 60.25]]},
            "securities": {"columns": ["BOARDID", "FACEVALUE"], "data": [["TQOB", 1000]]}}
    assert moex_price(bond, "bond") == (60250, None)
    assert moex_price({"marketdata": {"columns": ["LAST"], "data": []}}, "stock") == (None, None)


def test_quotes_cache_and_offline():
    asyncio.run(_quotes())


async def _quotes():
    calls = []

    async def fake(url, params):
        calls.append(url)
        if "coingecko" in url:
            return {"bitcoin": {"rub": 8_500_000.0, "rub_24h_change": -2.1}}
        if "cbr" in url:
            return {"Valute": {"USD": {"Nominal": 1, "Value": 81.5, "Previous": 81.0}}}
        raise OSError("нет сети")

    q = Quotes(fake)
    assets = [{"kind": "crypto", "ticker": "BTC"}, {"kind": "fx", "ticker": "USD"}, {"kind": "stock", "ticker": "SBER"}]
    got = await q.get(assets)
    assert got["crypto:BTC"] == (850_000_000, -2.1) and got["fx:USD"][0] == 8150
    assert "stock:SBER" not in got                     # Мосбиржа недоступна — без котировки, без исключения
    n = len(calls)
    await q.get(assets[:2])
    assert len(calls) == n                             # из кэша


def test_record_and_add(tmp_path):
    ledger, port = build(tmp_path)
    assets, debts = port.read()
    rep = port.valuate(assets, debts, {}, TODAY)
    hist = port.record(TODAY, rep)
    assert hist[-1]["date"] == "2026-11-18" and hist[-1]["net_worth"] == rep["net_worth"]
    port.add_debt("Данилу", 5_000_000, "2026-12-04")
    rep2 = port.valuate(*port.read(), {}, TODAY)
    hist = port.record(TODAY, rep2)
    assert len(hist) == 1 and hist[0]["debt"] == rep["debt"] + 5_000_000      # строка дня заменена
    text = port.vault.read("Finance/Capital.md")
    assert text.count("| 2026-11-18 |") == 1
    port.add_asset("Яндекс", "акция", 2.5, 400_000, "ydex", "2026-11-18")
    a, _ = port.read()
    assert any(x["name"] == "Яндекс" and x["qty"] == 2.5 and x["ticker"] == "YDEX" for x in a)
    assert "| Яндекс | акция | 2,5 | 4000 | YDEX | 2026-11-18 |  |" in port.vault.read(port.path)


def test_add_into_empty_vault(tmp_path):
    vault = Vault(tmp_path / "v")
    port = Portfolio(vault)
    port.add_asset("Ноутбук", "техника", 1, 15_000_000)
    port.add_debt("Банку", 1_000_000)
    a, d = port.read()
    assert a[0]["name"] == "Ноутбук" and d[0]["name"] == "Банку"


def test_api_and_intents(tmp_path):
    async def run():
        j = make_jarvis(tmp_path)
        for rel, text in FILES.items():
            j.vault.write(rel, text)
        j.today = lambda: TODAY  # type: ignore[method-assign]
        async with TestClient(TestServer(build_app(j))) as c:
            a = await (await c.get("/api/finance/analytics?months=4")).json()
            assert len(a["trend"]) == 4 and a["recurring"]
            r = await (await c.get("/api/finance/assets")).json()
            assert r["debt"] == 17_500_000 and r["history"][-1]["date"] == "2026-11-18"
            assert r["items"][0]["name"] == "Квартира"
            res = await c.post("/api/finance/assets", json={"action": "asset", "name": "Золото",
                                                            "kind": "имущество", "qty": "1", "buy": "100000"})
            assert res.status == 200
            res = await c.post("/api/finance/assets", json={"action": "debt", "name": "Данилу", "amount": "50 000"})
            assert (await res.json())["amount"] == 5_000_000
            res = await c.post("/api/finance/assets", json={"action": "asset", "name": "x", "buy": "abc"})
            assert res.status == 400
            res = await c.post("/api/apps", json={"name": "Отдать долг Ване"})
            assert [a["name"] for a in (await res.json())["apps"]] == ["Отдать долг Ване"]
            apps = await (await c.get("/api/apps")).json()
            assert apps["apps"][0]["kind"] == "project"
        reply = await j.handle("какой у меня капитал")
        assert "чистый капитал" in reply.text
        reply = await j.handle("проанализируй мои расходы")
        assert "регулярн" in reply.text or "Сбережения" in reply.text
        await j.close()
    asyncio.run(run())


def test_apps_catalog(tmp_path):
    from jarvis.apps import catalog, set_in_catalog
    ledger, port = build(tmp_path)
    vault, projects = port.vault, port.projects
    vault.write("Apps/Таймер.md",
                "---\ntype: app\nurl: https://timer.example\nicon: ⏱\n---\n# Таймер\n\nПомидорный таймер.\n")
    c = catalog(vault, projects)
    assert [a["name"] for a in c["apps"]] == ["Таймер"]
    assert c["apps"][0]["description"] == "Помидорный таймер." and c["apps"][0]["icon"] == "⏱"
    assert "Отдать долг Ване" in c["available"]
    c = set_in_catalog(vault, projects, "Военный билет", True)
    assert {a["name"] for a in c["apps"]} == {"Таймер", "Военный билет"}
    assert "catalog: true" in vault.read("Projects/Военный билет.md")
    assert "Военный билет" not in c["available"]
    c = set_in_catalog(vault, projects, "Военный билет", False)
    assert [a["name"] for a in c["apps"]] == ["Таймер"]
    with pytest.raises(ValueError):
        set_in_catalog(vault, projects, "нет такого", True)
