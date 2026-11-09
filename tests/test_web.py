"""Веб-сервер: вход по коду, API, WebSocket-обновления при правке заметки «на телефоне», безопасность."""
import asyncio

from aiohttp.test_utils import TestClient, TestServer

from jarvis.web import build_app

from .conftest import make_jarvis


def test_auth_and_api(tmp_path):
    async def run():
        j = make_jarvis(tmp_path, access_code="4815162342", secret="s" * 32)
        async with TestClient(TestServer(build_app(j))) as c:
            assert (await c.get("/healthz")).status == 200
            r = await c.get("/")
            assert r.status == 200 and "J.A.R.V.I.S." in await r.text()
            assert "Content-Security-Policy" in r.headers
            assert (await c.get("/static/app.js")).status == 200
            assert (await c.get("/api/state")).status == 401
            assert (await c.post("/api/login", json={"code": "nope"})).status == 403
            # Bearer-токен для скриптов
            r = await c.get("/api/state", headers={"Authorization": "Bearer 4815162342"})
            assert r.status == 200
            r = await c.post("/api/login", json={"code": " 4815162342\n"})   # скопирован из терминала
            assert r.status == 200 and "jarvis_session" in r.cookies
            state = await (await c.get("/api/state")).json()
            assert state["title"] == "сэр" and state["llm"] is False and state["protocols"]

            r = await c.post("/api/command", json={"text": "добавь задачу проверить API завтра"})
            reply = await r.json()
            assert reply["kind"] == "ok" and reply["speech"]
            tasks = await (await c.get("/api/tasks?view=all")).json()
            tid = next(t["id"] for t in tasks if t["text"] == "проверить API")
            r = await c.post(f"/api/tasks/{tid}/status", json={"status": "done"})
            assert (await r.json())["status"] == "done"

            r = await c.post("/api/finance", json={"amount": "-990", "category": "Подписки", "note": "Claude"})
            assert (await r.json())["amount"] == -99000
            fin = await (await c.get("/api/finance")).json()
            assert fin["expense"] == 99000

            # путь вне хранилища не читается
            assert (await c.get("/api/note", params={"path": "../secret.key"})).status == 400
            assert (await c.get("/api/note", params={"path": "Home.md"})).status == 200
            hits = await (await c.get("/api/memory", params={"q": "оферта"})).json()
            assert hits["hits"]
            graph = await (await c.get("/api/graph")).json()
            assert len(graph["nodes"]) >= 8
            # чужой Origin не может отправлять команды даже с cookie
            r = await c.post("/api/command", json={"text": "задачи"}, headers={"Origin": "https://evil.example"})
            assert r.status == 403
            # голос в режиме браузера — сервер звук не отдаёт
            assert (await c.post("/api/tts", json={"text": "Добрый вечер"})).status == 204
            r = await c.post("/api/projects/IPAStore/delegate", json={"task": "добавить экспорт", "mode": "github"})
            pid = (await r.json())["confirm"]["id"]
            assert (await (await c.post(f"/api/cancel/{pid}", json={})).json())["text"] == "Отменено."
            r = await c.post("/api/scan", data={"hint": "x"})
            assert r.status == 503
        await j.close()
    asyncio.run(run())


def test_no_code_on_localhost_is_open(tmp_path):
    async def run():
        j = make_jarvis(tmp_path)
        async with TestClient(TestServer(build_app(j))) as c:
            s = await (await c.get("/api/session")).json()
            assert s == {"auth": False, "logged_in": True}
            assert (await c.get("/api/state")).status == 200
        await j.close()
    asyncio.run(run())


def test_websocket_live_sync(tmp_path):
    """Заметку изменили в Obsidian на другом устройстве → дашборд получает событие сразу."""
    async def run():
        from jarvis.watchers import Watchers
        j = make_jarvis(tmp_path, watch_interval=0.3)
        w = Watchers(j)
        j.vault.subscribe(w.on_vault_change)
        watch = asyncio.create_task(j.vault.watch(0.3))
        async with TestClient(TestServer(build_app(j))) as c:
            ws = await c.ws_connect("/ws")
            hello = await ws.receive_json()
            assert hello["type"] == "hello"
            await asyncio.sleep(0.5)
            inbox = j.vault.root / "Tasks" / "Inbox.md"
            inbox.write_text(inbox.read_text(encoding="utf-8") + "- [ ] с телефона 📅 2026-11-09\n", encoding="utf-8")
            kinds = []
            for _ in range(5):
                msg = await asyncio.wait_for(ws.receive_json(), timeout=3)
                kinds.append(msg["type"])
                if msg["type"] == "vault":
                    assert "Tasks/Inbox.md" in msg["data"]["paths"]
                if "refresh" in kinds and "vault" in kinds:
                    break
            assert "vault" in kinds and "refresh" in kinds
            # команда через WebSocket → ответ приходит всем
            await ws.send_json({"type": "command", "text": "который час", "client": "abc"})
            for _ in range(5):
                msg = await asyncio.wait_for(ws.receive_json(), timeout=3)
                if msg["type"] == "reply":
                    assert msg["data"]["text"].startswith("Сейчас") and msg["data"]["client"] == "abc"
                    break
            else:
                raise AssertionError("нет ответа по WebSocket")
            await ws.close()
        watch.cancel()
        await j.close()
    asyncio.run(run())


def test_login_throttle_is_per_visitor_behind_proxy(tmp_path):
    """За Caddy все запросы приходят с 127.0.0.1: перебор с чужого адреса не должен блокировать владельца."""
    async def run():
        j = make_jarvis(tmp_path, access_code="4815162342", secret="s" * 32)
        async with TestClient(TestServer(build_app(j))) as c:
            evil = {"X-Forwarded-For": "203.0.113.66"}
            codes = [(await c.post("/api/login", json={"code": "nope"}, headers=evil)).status for _ in range(9)]
            assert codes[-1] == 429
            r = await c.post("/api/login", json={"code": "4815162342"}, headers={"X-Forwarded-For": "198.51.100.7"})
            assert r.status == 200
        await j.close()
    asyncio.run(run())
