"""Приложение «Глобус»: разбор новостей (место, вид, рынки, прогноз), ленты RSS/Atom и USGS, давление на рынки,
тактика по активам владельца, сигналы в хранилище, API и голос."""
import asyncio
import json
import time
from datetime import datetime, timezone

import pytest
from aiohttp.test_utils import TestClient, TestServer

from jarvis.news import (QUAKES, NewsDesk, analyze, decay, exposure, locate, parse_feed, parse_quakes, pressure,
                         pressure_label, signal_line, tactics)
from jarvis.web import build_app

from .conftest import make_jarvis

NOW = 1_800_000_000.0


def a(title, summary="", ts=NOW):
    return analyze({"id": title[:12], "title": title, "summary": summary, "ts": ts, "source": "t", "link": ""})


@pytest.mark.parametrize("title, place", [
    ("Хуситы атаковали танкер в Красном море", "Йемен"),          # раньше в заголовке — раньше место
    ("Танкер атакован в Красном море", "Красное море"),
    ("Президент Индии посетил Москву", "Индия"),
    ("Индивидуальный подход к налогам", None),                     # «инди…» — не Индия
    ("Поставки газа в Европу прекращены", "Европа"),               # «газа» — не сектор Газа
    ("Israel strikes Gaza", "Израиль"),
    ("U.S. imposes new tariffs on Chinese chips", "США"),
    ("Землетрясение у берегов Японии", "Япония"),
    ("В Нигерии прошли выборы", "Нигерия"),                        # не Нигер
    ("South Korea and North Korea talks", "Южная Корея"),          # фраза важнее слова
])
def test_locate(title, place):
    got = locate(title)
    assert (got["name"] if got else None) == place


def test_analyze_markets_and_forecast():
    opec = a("ОПЕК+ планирует сократить добычу нефти в начале следующего года")
    assert opec["kind"] == "energy" and opec["economic"] and opec["marker"] == "economic"
    assert opec["markets"][0]["market"] == "oil" and opec["markets"][0]["dir"] == 1
    attack = a("Хуситы атаковали танкер в Красном море")
    assert attack["kind"] == "conflict" and not attack["economic"]           # факт, а не прогноз
    assert {m["market"] for m in attack["markets"]} == {"oil", "gas"}
    cbr = a("ЦБ России может повысить ключевую ставку до 18%")
    assert {m["market"]: m["dir"] for m in cbr["markets"]} == {"rub": 1, "moex": -1}   # не ставки ФРС
    fed = a("Fed expected to cut rates in December")
    assert fed["economic"] and {m["market"]: m["dir"] for m in fed["markets"]}["us"] == 1
    stall = a("Israel strikes Gaza as ceasefire talks stall")
    assert "moex" not in {m["market"] for m in stall["markets"]}             # сорванное перемирие — не деэскалация
    sanctions = a("European Union agrees new sanctions on Russia")
    assert sanctions["place"]["name"] == "Евросоюз" and {"moex", "rub"} <= {m["market"] for m in sanctions["markets"]}
    plain = a("В Париже открылась выставка")
    assert plain["markets"] == [] and not plain["economic"] and plain["severity"] < .4
    dead = a("Крупнейшее наводнение: погибли 120 человек")
    assert dead["kind"] == "disaster" and dead["severity"] >= .8


RSS = """<?xml version="1.0"?><rss version="2.0"><channel><title>Мир сегодня</title>
<item><title>ОПЕК+ ожидает сократить добычу</title><link>https://news.example/1</link>
<description>&lt;p&gt;Решение &amp;amp; прогноз&lt;/p&gt;</description>
<pubDate>Fri, 15 Jan 2027 08:00:00 GMT</pubDate></item>
<item><title>  </title></item>
<item><title>Без даты</title><link>javascript:alert(1)</link></item>
</channel></rss>"""
ATOM = """<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom feed</title>
<entry><title>Bitcoin ETF approved</title><link href="https://x.example/a"/><updated>2027-01-15T07:00:00Z</updated>
<summary>Crypto</summary></entry></feed>"""
QUAKE = {"features": [{"id": "us7000abc",
                       "properties": {"mag": 6.8, "place": "20 km E of Hualien, Taiwan", "time": NOW * 1000,
                                      "url": "https://usgs.example/q", "tsunami": 1},
                       "geometry": {"coordinates": [121.6, 23.9, 12.0]}},
                      {"properties": {"mag": None}, "geometry": {"coordinates": [0, 0]}}]}


def test_parse_feeds_and_quakes():
    rss = parse_feed(RSS, "https://news.example/rss", now=NOW)
    assert [i["title"] for i in rss] == ["ОПЕК+ ожидает сократить добычу", "Без даты"]
    assert rss[0]["summary"] == "Решение & прогноз" and rss[0]["source"] == "Мир сегодня"
    assert rss[0]["ts"] == datetime(2027, 1, 15, 8, tzinfo=timezone.utc).timestamp() and rss[1]["ts"] == NOW
    assert rss[1]["link"] == ""                                              # не http — ссылку не берём
    atom = parse_feed(ATOM, now=NOW)
    assert atom[0]["link"] == "https://x.example/a" and atom[0]["source"] == "Atom feed"
    q = parse_quakes(QUAKE)
    assert len(q) == 1 and q[0]["place"]["lat"] == 23.9 and "цунами" in q[0]["summary"]
    item = analyze(q[0])
    assert item["kind"] == "quake" and item["severity"] >= .8 and item["markets"][0]["market"] == "chips"


def test_pressure_tactics_and_exposure():
    items = [a("ОПЕК+ планирует сократить добычу нефти", ts=NOW - 600),
             a("Хуситы атаковали танкер в Красном море", ts=NOW - 3600),
             a("Новые санкции против России", ts=NOW - 7200),
             a("Старое: ОПЕК+ сократит добычу", ts=NOW - 72 * 3600)]                # старше 48 часов — не в счёт
    pr = pressure(items, NOW)
    assert pr["oil"]["pressure"] > .55 and pr["oil"]["label"] == "сильное давление вверх"
    assert pr["oil"]["signals"] == 3 and pr["moex"]["pressure"] < 0
    assert decay(12) == .5 and pressure_label(0) == "нейтрально"
    assert exposure({"kind": "stock", "ticker": "LKOH"}) == [("oil", 1), ("moex", 1)]
    assert exposure({"kind": "fx", "ticker": "USD"}) == [("rub", -1)]
    assert exposure({"kind": "stock", "ticker": "PLZL", "name": "Полюс"}) == [("gold", 1)]
    assert exposure({"kind": "realty"}) == []
    t = tactics(items, [{"name": "Лукойл", "kind": "stock", "ticker": "LKOH"},
                        {"name": "Сбер", "kind": "stock", "ticker": "SBER"},
                        {"name": "Квартира", "kind": "realty"}], NOW)
    pos = {p["ticker"]: p for p in t["positions"]}
    assert set(pos) == {"LKOH", "SBER"} and pos["SBER"]["stance"] == "встречный ветер"
    assert pos["LKOH"]["score"] > pos["SBER"]["score"]
    oil = next(i for i in t["ideas"] if i["market"] == "oil")
    assert oil["yours"] == ["LKOH"] and oil["action"].startswith("держать")
    assert "не инвестиционная рекомендация" in t["disclaimer"]


def test_desk_poll_dedupe_and_persist(tmp_path):
    calls = []

    async def fetch(url):
        calls.append(url)
        if url == QUAKES:
            return json.dumps(QUAKE).encode()
        if "broken" in url:
            raise OSError("нет связи")
        stamp = time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(NOW - 60))
        return RSS.replace("Fri, 15 Jan 2027 08:00:00 GMT", stamp).encode()

    async def run():
        desk = NewsDesk(tmp_path, ["https://news.example/rss", "https://broken.example/rss"], fetch=fetch)
        fresh = await desk.poll(now=NOW)
        assert {i["title"] for i in fresh} == {
            "ОПЕК+ ожидает сократить добычу", "Без даты", "Землетрясение M6.8 — 20 km E of Hualien, Taiwan"}
        assert await desk.poll(now=NOW + 60) == []                          # уже видели — не повторяем
        src = {s["url"]: s for s in desk.sources()}
        assert src["https://broken.example/rss"]["ok"] is False and src[QUAKES]["ok"] is True
        again = NewsDesk(tmp_path, fetch=fetch)
        assert len(again.list()) == 3 and again.updated == NOW + 60
        assert again.list(since=NOW + 1) == []
    asyncio.run(run())


def test_signal_line():
    it = a("ОПЕК+ планирует сократить добычу | нефти")
    it.update(source="РИА", link="https://ria.example/1")
    line = signal_line(it, datetime(2027, 1, 15, 9, 30))
    assert line.startswith("| 2027-01-15 09:30 | Нефть ↑ | ОПЕК+ планирует сократить добычу / нефти")
    assert line.endswith("| 75% | [РИА](https://ria.example/1) |")


def test_jarvis_news_api_signals_and_voice(tmp_path):
    async def fetch(url):
        if url == QUAKES:
            return b'{"features": []}'
        stamp = time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(time.time() - 120))
        return f"""<rss><channel><title>Лента</title>
<item><title>ОПЕК+ планирует сократить добычу нефти</title><link>https://n.example/1</link>
<pubDate>{stamp}</pubDate></item>
<item><title>В Париже открылась выставка</title><link>https://n.example/2</link><pubDate>{stamp}</pubDate></item>
</channel></rss>""".encode()

    async def run():
        j = make_jarvis(tmp_path)
        j.news._fetch = fetch
        j.vault.write("Finance/Assets.md", "# Активы\n\n| Актив | Вид | Тикер | Количество | Цена покупки |\n"
                                           "|---|---|---|---|---|\n| Лукойл | акции | LKOH | 10 | 7000 |\n")
        sent = []
        j.notifiers.append(lambda text, level: asyncio.sleep(0, sent.append(text)))
        events = []

        class WS:
            async def send_str(self, payload):
                events.append(json.loads(payload))
        j.hub.clients.add(WS())
        async with TestClient(TestServer(build_app(j))) as c:
            await c.post("/api/setup", json={"mode": "password", "password": "корень-123"})
            r = await (await c.get("/api/news")).json()                       # первый запрос сам опрашивает ленты
            titles = [i["title"] for i in r["items"]]
            assert "ОПЕК+ планирует сократить добычу нефти" in titles and r["markets"]["oil"]["hub"]
            assert r["tactics"]["positions"][0]["ticker"] == "LKOH" and r["enabled"] is True
            signals = j.vault.read("Jarvis/News/Сигналы.md")
            assert "type: signals" in signals and "| Нефть ↑ | ОПЕК+ планирует сократить добычу нефти" in signals
            assert "выставка" not in signals                                   # не экономический — не пишем
            assert any(e["type"] == "news" and e["data"]["count"] == 2 for e in events)
            assert sent and "Нефть ↑" in sent[0]                               # у владельца Лукойл — оповещение
            r = await (await c.post("/api/news/refresh")).json()
            assert r["new"] == 0
            b = await (await c.post("/api/news/brief", json={})).json()
            assert b["kind"] == "warn" and "мозг" in b["text"]                  # без ключа — честно говорим
            reply = (await j.handle("что на рынках")).text
            assert "Нефть" in reply and "давление вверх" in reply
            reply = await j.handle("открой глобус")
            assert reply.data["open_globe"] is True and any(e["type"] == "open_globe" for e in events)
        await j.close()
    asyncio.run(run())
