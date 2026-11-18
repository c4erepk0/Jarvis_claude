"""Операторы: первый запуск, приглашение по ссылке, права, чат, поручения и встречи, что видит оператор."""
import asyncio
import json
from datetime import datetime

import pytest
from aiohttp.test_utils import TestClient, TestServer

from jarvis.meetings import as_meeting, meeting_text, meetings
from jarvis.operators import Operators, slug
from jarvis.vault import Vault
from jarvis.web import build_app

from .conftest import make_jarvis

NOW = datetime(2026, 11, 19, 10, 5)


def test_registry_invite_and_perms(tmp_path):
    ops = Operators(tmp_path / "data", Vault(tmp_path / "v"))
    assert ops.owner_mode == ""
    op, token = ops.create("Иван Петров", ["tasks_all", "нет-такого"])
    assert op["slug"] == "иван-петров" and op["tag"] == "оператор/иван-петров"
    assert op["perms"] == ["tasks_all"] and op["status"] == "invited"
    with pytest.raises(ValueError):
        ops.create("иван петров")                                 # тот же человек дважды
    assert ops.invite_info(token) == {"name": "Иван Петров"}
    assert ops.invite_info("чужой") is None
    joined = ops.accept(token)
    assert ops.public(joined)["status"] == "active"
    with pytest.raises(ValueError):
        ops.accept(token)                                         # ссылка одноразовая
    # в файле — только хэш приглашения, не сама ссылка
    raw = (tmp_path / "data" / "operators.json").read_text()
    assert token not in raw
    v = joined["version"]
    assert ops.session_ok(op["id"], v)
    ops.update(op["id"], active=False)
    assert ops.session_ok(op["id"], v) is None                    # отключили — сессия больше не работает
    assert ops.list()[0]["status"] == "disabled"
    ops.update(op["id"], active=True, perms=["projects"], name="Иван")
    assert ops.list()[0]["perms"] == ["projects"] and ops.list()[0]["slug"] == "иван"
    # перезагрузка из файла
    again = Operators(tmp_path / "data", Vault(tmp_path / "v"))
    assert again.list()[0]["name"] == "Иван"
    again.delete(op["id"])
    assert again.list() == []
    assert slug("  Ёлкина Анна ") == "елкина-анна"


def test_owner_password(tmp_path):
    ops = Operators(tmp_path / "d", Vault(tmp_path / "v"))
    with pytest.raises(ValueError):
        ops.set_owner_password("123")
    ops.set_owner_password("секрет-123")
    assert ops.owner_mode == "password"
    assert ops.check_owner_password("секрет-123") and not ops.check_owner_password("секрет")
    assert "секрет-123" not in (tmp_path / "d" / "operators.json").read_text()
    ops.set_open()
    assert ops.owner_mode == "open" and not ops.check_owner_password("секрет-123")


def test_chat_note_and_unread(tmp_path):
    vault = Vault(tmp_path / "v")
    ops = Operators(tmp_path / "d", vault)
    op, _ = ops.create("Анна")
    ops.post(op["id"], "owner", "Привет! Подготовь отчёт", NOW)
    ops.post(op["id"], "operator", "Сделаю.\nК вечеру пришлю", NOW)
    text = vault.read("Jarvis/Chat/Анна.md")
    assert "- 2026-11-19 10:05 · **Владелец**: Привет! Подготовь отчёт" in text
    assert "**Анна**: Сделаю.\n  К вечеру пришлю" in text
    msgs = ops.messages(op["id"])
    assert [m["from"] for m in msgs] == ["owner", "operator"]
    assert msgs[1]["text"] == "Сделаю.\nК вечеру пришлю"
    assert ops.unread(op["id"], "owner") == 1 and ops.unread(op["id"], "operator") == 0
    ops.mark_read(op["id"], "owner", 2)
    assert ops.unread(op["id"], "owner") == 0
    ops.update(op["id"], name="Анна С")                           # переименовали — переписка переехала
    assert vault.exists("Jarvis/Chat/Анна С.md") and len(ops.messages(op["id"])) == 2
    with pytest.raises(ValueError):
        ops.post(op["id"], "owner", "   ", NOW)


def test_meeting_format():
    t = meeting_text("Созвон с поставщиком", "9:30", "Zoom")
    assert t == "Созвон с поставщиком 🕒 09:30 📍 Zoom"
    with pytest.raises(ValueError):
        meeting_text("x", "утром")
    m = as_meeting({"id": "1", "text": t, "status": "todo", "due": "2026-11-20", "tags": ["встреча", "оператор/анна"]})
    assert (m["title"], m["time"], m["place"], m["assignees"]) == ("Созвон с поставщиком", "09:30", "Zoom", ["анна"])
    tasks = [
        {"id": "a", "text": "Б 🕒 15:00", "status": "todo", "due": "2026-11-19", "tags": ["встреча"]},
        {"id": "b", "text": "А 🕒 09:00", "status": "todo", "due": "2026-11-19", "tags": ["встреча", "оператор/анна"]},
        {"id": "c", "text": "Старая", "status": "done", "due": "2026-11-01", "done": "2026-11-01", "tags": ["встреча"]},
        {"id": "d", "text": "Не встреча", "status": "todo", "due": "2026-11-19", "tags": []},
    ]
    r = meetings(tasks, "2026-11-19")
    assert [m["id"] for m in r["upcoming"]] == ["b", "a"] and r["today"] == 2 and r["done"] == []
    assert [m["id"] for m in meetings(tasks, "2026-11-19", op_slug="анна")["upcoming"]] == ["b"]


def _cookie(resp) -> str:
    return resp.cookies["jarvis_session"].value


def test_full_flow(tmp_path):
    async def run():
        j = make_jarvis(tmp_path)
        async with TestClient(TestServer(build_app(j))) as c:
            # первый запуск: «Я владелец» с паролем
            s = await (await c.get("/api/session")).json()
            assert s["setup"] is True and s["role"] == "owner"
            r = await c.post("/api/setup", json={"mode": "password", "password": "корень-123"})
            assert r.status == 200
            assert (await c.post("/api/setup", json={"mode": "open"})).status == 409   # второй раз — нельзя
            s = await (await c.get("/api/session")).json()
            assert s["auth"] is True and s["role"] == "owner" and s["setup"] is False
            # приглашение
            r = await c.post("/api/admin/operators", json={"name": "Анна", "perms": ["add_tasks"]})
            data = await r.json()
            token, op_id = data["token"], data["created"]["id"]
            assert data["operators"][0]["status"] == "invited"
            # поручения: задача и встреча Анне, задача — не ей
            body = {"kind": "task", "text": "Позвонить в банк", "operator": op_id, "due": "2026-11-20"}
            t_anna = await (await c.post("/api/admin/assign", json=body)).json()
            assert "#оператор/анна" in j.vault.read("Tasks/Inbox.md")
            await c.post("/api/admin/assign", json={"kind": "meeting", "title": "Встреча с юристом", "time": "15:00",
                                                    "place": "Офис", "due": "2026-11-21", "operator": op_id})
            t_other = await (await c.post("/api/admin/assign", json={"kind": "task", "text": "Личное"})).json()
            assert (await c.post("/api/admin/chat/" + op_id, json={"text": "Анна, посмотрите задачи"})).status == 200
            mt = await (await c.get("/api/meetings")).json()
            assert mt["upcoming"][0]["title"] == "Встреча с юристом" and mt["upcoming"][0]["place"] == "Офис"

        # оператор — с другого устройства (новый клиент без cookie владельца)
        async with TestClient(TestServer(build_app(j))) as op_client:
            assert (await op_client.get("/api/state")).status == 401
            info = await (await op_client.get(f"/api/invite?token={token}")).json()
            assert info == {"name": "Анна"}
            r = await op_client.post("/api/invite/accept", json={"token": f"https://atom.example/?invite={token}"})
            assert r.status == 200
            s = await (await op_client.get("/api/session")).json()
            assert s["role"] == "operator" and s["operator"]["name"] == "Анна" and s["logged_in"] is True
            # закрытые разделы
            for path in ("/api/state", "/api/finance", "/api/memory", "/api/admin/operators", "/api/files"):
                assert (await op_client.get(path)).status == 403, path
            assert (await op_client.post("/api/command", json={"text": "сколько я потратил"})).status == 403
            # видит только порученное
            tasks = (await (await op_client.get("/api/op/tasks")).json())["tasks"]
            assert [t["text"] for t in tasks] == ["Позвонить в банк"]
            meet = await (await op_client.get("/api/op/meetings")).json()
            assert meet["upcoming"][0]["time"] == "15:00"
            # отмечает своё, чужое — нельзя
            r = await op_client.post(f"/api/op/tasks/{t_other['id']}/status", json={"status": "done"})
            assert r.status == 403
            r = await op_client.post(f"/api/op/tasks/{t_anna['id']}/status", json={"status": "done"})
            assert (await r.json())["status"] == "done"
            r = await op_client.post(f"/api/op/tasks/{meet['upcoming'][0]['id']}/status", json={"status": "done"})
            assert r.status == 200                                     # встреча состоялась
            # создаёт задачу себе, проекты без права — нельзя
            r = await op_client.post("/api/op/tasks", json={"text": "Купить картридж"})
            assert r.status == 200 and "оператор/анна" in (await r.json())["tags"]
            assert (await op_client.get("/api/op/projects")).status == 403
            # чат
            chat = await (await op_client.get("/api/op/chat")).json()
            assert chat["messages"][0]["text"] == "Анна, посмотрите задачи"
            await op_client.post("/api/op/chat", json={"text": "Готово, банк — сделано"})
            me = await (await op_client.get("/api/op/me")).json()
            assert me["unread"] == 0 and me["operator"]["perms"] == ["add_tasks"]
        assert j.operators.unread(op_id, "owner") == 1
        assert "**Анна**: Готово, банк — сделано" in j.vault.read("Jarvis/Chat/Анна.md")

        # владелец отключает оператора — его сессия больше не работает
        async with TestClient(TestServer(build_app(j))) as c2:
            assert (await c2.post("/api/login", json={"code": "корень-123"})).status == 200
            ov = await (await c2.get("/api/admin/operators")).json()
            assert ov["operators"][0]["unread"] == 1
            await c2.post(f"/api/admin/operators/{op_id}", json={"action": "update", "active": False})
            r = await c2.post(f"/api/admin/operators/{op_id}", json={"action": "invite"})
            assert (await r.json())["token"]
        op = j.operators.get(op_id)
        assert j.operators.session_ok(op_id, op["version"] - 1) is None
        await j.close()
    asyncio.run(run())


def test_open_mode_blocks_invites_and_ws_filter(tmp_path):
    async def run():
        j = make_jarvis(tmp_path)
        async with TestClient(TestServer(build_app(j))) as c:
            assert (await c.post("/api/setup", json={"mode": "open"})).status == 200
            r = await c.post("/api/admin/operators", json={"name": "Анна"})
            assert r.status == 400 and "пароль" in (await r.json())["error"]
        # фильтр событий для оператора: только его чат и задачи
        sent = []

        class WS:
            async def send_str(self, payload):
                sent.append(json.loads(payload))
        ws = WS()
        ws.atom_filter = lambda e: e["type"] == "chat" and e["data"]["op"] == "a1"
        j.hub.clients.add(ws)
        await j.hub.emit("log", {"text": "финансы владельца"})
        await j.hub.emit("chat", {"op": "b2", "message": {}})
        await j.hub.emit("chat", {"op": "a1", "message": {}})
        assert [e["data"]["op"] for e in sent] == ["a1"]
        await j.close()
    asyncio.run(run())


def test_meetings_voice(tmp_path):
    async def run():
        j = make_jarvis(tmp_path)
        tomorrow = j.today().fromordinal(j.today().toordinal() + 1).isoformat()
        assert "Встреч впереди нет" in (await j.handle("какие встречи")).text
        await j.act_assign("meeting", {"title": "Встреча с юристом", "time": "15:00", "due": tomorrow})
        assert (await j.handle("встречи на завтра")).text == "1 встреча на завтра: Встреча с юристом в 15:00."
        assert (await j.handle("какие встречи")).text == "1 встреча: Встреча с юристом в 15:00, завтра."
        await j.close()
    asyncio.run(run())
