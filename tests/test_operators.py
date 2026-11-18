"""Операторы: первый запуск, приглашение по ссылке, права, чат, поручения и встречи, что видит оператор."""
import asyncio
import json
from datetime import datetime

import pytest
from aiohttp.test_utils import TestClient, TestServer

from jarvis.meetings import as_meeting, meeting_text, meetings
from jarvis.operators import OWNER_KEY, Operators, device_name, slug
from jarvis.vault import Vault
from jarvis.web import build_app

from .conftest import make_jarvis

NOW = datetime(2026, 11, 19, 10, 5)


def test_registry_invite_password_sessions(tmp_path):
    ops = Operators(tmp_path / "data", Vault(tmp_path / "v"))
    assert ops.owner_mode == ""
    op, token = ops.create("Иван Петров", ["tasks_all", "нет-такого"], projects=["Сайт", " Сайт ", "CheckUp"])
    assert op["slug"] == "иван-петров" and op["tag"] == "оператор/иван-петров"
    assert op["perms"] == ["tasks_all"] and op["status"] == "invited" and op["projects"] == ["CheckUp", "Сайт"]
    assert op["folder"] == "Команда/Иван Петров"
    with pytest.raises(ValueError):
        ops.create("иван петров")                                 # тот же человек дважды
    assert ops.invite_info(token) == {"name": "Иван Петров", "has_password": False}
    assert ops.invite_info("чужой") is None
    with pytest.raises(ValueError):
        ops.accept(token, "123")                                  # пароль слишком короткий
    joined = ops.accept(token, "пароль-ивана")
    assert ops.public(joined)["status"] == "active" and ops.public(joined)["has_password"]
    with pytest.raises(ValueError):
        ops.accept(token, "пароль-ивана")                         # ссылка одноразовая
    raw = (tmp_path / "data" / "operators.json").read_text()
    assert token not in raw and "пароль-ивана" not in raw        # только хэши
    # вход по имени и паролю — с любого устройства, у каждого — своя сессия
    assert ops.login("ИВАН ПЕТРОВ", "пароль-ивана")["id"] == op["id"]
    assert ops.login("Иван Петров", "не тот") is None
    phone = ops.new_session(op["id"], "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1", "10.0.0.2")
    laptop = ops.new_session(op["id"], "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36", "10.0.0.3")
    devices = ops.sessions(op["id"], current=laptop)
    assert [d["device"] for d in devices] == ["Chrome · Windows", "Safari · iPhone"] and devices[0]["current"]
    assert ops.revoke(op["id"], phone) and not ops.session_valid(op["id"], phone)
    assert ops.session_valid(op["id"], laptop)
    ops.new_session(op["id"], "", "")
    assert ops.revoke_others(op["id"], keep=laptop) == 1 and ops.session_valid(op["id"], laptop)
    ops.update(op["id"], active=False)
    assert not ops.session_valid(op["id"], laptop)                # отключили — вышел везде
    assert ops.login("Иван Петров", "пароль-ивана") is None
    assert ops.list()[0]["status"] == "disabled"
    ops.update(op["id"], active=True, perms=["meetings_all"], name="Иван", projects=[])
    assert ops.list()[0]["perms"] == ["meetings_all"] and ops.list()[0]["slug"] == "иван"
    ops.set_password(op["id"], "пароль-ивана", "новый-пароль")
    with pytest.raises(ValueError):
        ops.set_password(op["id"], "пароль-ивана", "ещё-один")
    # новая ссылка — войти, если забыл пароль: пароль можно не менять
    t2 = ops.reinvite(op["id"])
    assert ops.invite_info(t2)["has_password"] is True
    ops.accept(t2)
    assert ops.login("Иван", "новый-пароль")
    again = Operators(tmp_path / "data", Vault(tmp_path / "v"))   # перезагрузка из файла
    assert again.list()[0]["name"] == "Иван"
    again.delete(op["id"])
    assert again.list() == []
    assert slug("  Ёлкина Анна ") == "елкина-анна"
    assert device_name("python-requests/2.31") == "Скрипт · API"


def test_owner_sessions(tmp_path):
    ops = Operators(tmp_path / "d", Vault(tmp_path / "v"))
    a = ops.new_session(OWNER_KEY, "Mozilla/5.0 (Macintosh; Intel Mac OS X 14) Safari/605", "1.1.1.1")
    b = ops.new_session(OWNER_KEY, "", "")
    assert ops.session_valid(OWNER_KEY, "-")                      # вход до учёта устройств — пока работает
    assert {s["sid"] for s in ops.sessions(OWNER_KEY, current="-")} == {a, b, "-"}
    ops.revoke_others(OWNER_KEY, keep=a)
    assert ops.session_valid(OWNER_KEY, a) and not ops.session_valid(OWNER_KEY, b)
    assert not ops.session_valid(OWNER_KEY, "-")                  # «выйти везде» закрывает и старые входы


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
        j.projects.create("Сайт студии", NOW, description="Лендинг и запись", tag="сайт")
        j.projects.create("Секретный", NOW, description="Только владелец", tag="секрет")
        async with TestClient(TestServer(build_app(j))) as c:
            # первый запуск: «Я владелец» с паролем
            s = await (await c.get("/api/session")).json()
            assert s["setup"] is True and s["role"] == "owner"
            r = await c.post("/api/setup", json={"mode": "password", "password": "корень-123"})
            assert r.status == 200
            assert (await c.post("/api/setup", json={"mode": "open"})).status == 409   # второй раз — нельзя
            s = await (await c.get("/api/session")).json()
            assert s["auth"] is True and s["role"] == "owner" and s["setup"] is False
            # приглашение с общим проектом
            r = await c.post("/api/admin/operators", json={"name": "Анна", "projects": ["Сайт студии"]})
            data = await r.json()
            token, op_id = data["token"], data["created"]["id"]
            assert data["operators"][0]["status"] == "invited" and data["operators"][0]["projects"] == ["Сайт студии"]
            assert {p["name"] for p in data["projects"]} >= {"Сайт студии", "Секретный"}
            # поручения: задача и встреча Анне, задача — не ей, задача общего проекта
            body = {"kind": "task", "text": "Позвонить в банк", "operator": op_id, "due": "2026-11-20"}
            t_anna = await (await c.post("/api/admin/assign", json=body)).json()
            assert "#оператор/анна" in j.vault.read("Tasks/Inbox.md")
            await c.post("/api/admin/assign", json={"kind": "meeting", "title": "Встреча с юристом", "time": "15:00",
                                                    "place": "Офис", "due": "2026-11-21", "operator": op_id})
            t_other = await (await c.post("/api/admin/assign", json={"kind": "task", "text": "Личное"})).json()
            t_site = await (await c.post("/api/tasks", json={"text": "Сверстать форму #сайт"})).json()
            assert (await c.post("/api/admin/chat/" + op_id, json={"text": "Анна, посмотрите задачи"})).status == 200
            mt = await (await c.get("/api/meetings")).json()
            assert mt["upcoming"][0]["title"] == "Встреча с юристом" and mt["upcoming"][0]["place"] == "Офис"
            # мои устройства владельца: это — текущее
            dev = await (await c.get("/api/sessions")).json()
            assert dev["sessions"][0]["current"] is True

        # оператор — с другого устройства: принимает приглашение и задаёт пароль
        async with TestClient(TestServer(build_app(j))) as op_client:
            assert (await op_client.get("/api/state")).status == 401
            info = await (await op_client.get(f"/api/invite?token={token}")).json()
            assert info == {"name": "Анна", "has_password": False}
            r = await op_client.post("/api/invite/accept", json={"token": f"https://atom.example/?invite={token}"})
            assert r.status == 400                                     # без пароля нельзя
            r = await op_client.post("/api/invite/accept", json={"token": f"https://atom.example/?invite={token}",
                                                                 "password": "анна-пароль"})
            assert r.status == 200
            s = await (await op_client.get("/api/session")).json()
            assert s["role"] == "operator" and s["operator"]["name"] == "Анна" and s["logged_in"] is True
            # закрытые разделы
            for path in ("/api/state", "/api/finance", "/api/memory", "/api/admin/operators", "/api/files",
                         "/api/projects", "/api/note?path=Tasks/Inbox.md"):
                assert (await op_client.get(path)).status == 403, path
            assert (await op_client.post("/api/command", json={"text": "сколько я потратил"})).status == 403
            # порученное + свой список
            r = await op_client.post("/api/op/tasks", json={"text": "Купить картридж", "due": "2026-11-22"})
            mine = await r.json()
            assert mine["path"] == "Команда/Анна/Задачи.md"
            tasks = await (await op_client.get("/api/op/tasks")).json()
            assert [t["text"] for t in tasks["assigned"]] == ["Позвонить в банк"]
            assert [t["text"] for t in tasks["personal"]] == ["Купить картридж"]
            # личные задачи оператора не попадают в списки владельца
            assert "Купить картридж" not in [t.text for t in j.tasks.all()]
            meet = await (await op_client.get("/api/op/meetings")).json()
            assert meet["upcoming"][0]["time"] == "15:00"
            # отмечает своё, задачи общего проекта; чужое — нельзя
            r = await op_client.post(f"/api/op/tasks/{t_other['id']}/status", json={"status": "done"})
            assert r.status == 403
            for tid in (t_anna["id"], meet["upcoming"][0]["id"], mine["id"], t_site["id"]):
                r = await op_client.post(f"/api/op/tasks/{tid}/status", json={"status": "done"})
                assert r.status == 200, tid
            # только общие проекты — с их задачами и прогрессом
            pr = (await (await op_client.get("/api/op/projects")).json())["projects"]
            assert [p["name"] for p in pr] == ["Сайт студии"] and pr[0]["progress"]["done"] == 1
            # личные заметки — только в своей папке
            r = await op_client.post("/api/op/note", json={"title": "Звонки"})
            note = await r.json()
            assert note["path"] == "Команда/Анна/Звонки.md"
            got = await (await op_client.get("/api/op/note?path=" + note["path"])).json()
            r = await op_client.put("/api/op/note", json={"path": note["path"], "content": "# Звонки\n\nБанк — ок",
                                                          "base": got["version"]})
            assert r.status == 200
            r = await op_client.put("/api/op/note", json={"path": note["path"], "content": "x", "base": got["version"]})
            assert r.status == 409                                     # правка поверх чужой — конфликт
            for bad in ("Tasks/Inbox.md", "Команда/Анна/../../Finance/2026-11.md", "Команда/Иван/x.md"):
                assert (await op_client.get("/api/op/note?path=" + bad)).status in (400, 403), bad
            notes = (await (await op_client.get("/api/op/notes")).json())["notes"]
            assert [n["title"] for n in notes] == ["Задачи", "Звонки"]
            r = await op_client.post("/api/op/note", json={"action": "trash", "path": note["path"]})
            assert [n["title"] for n in (await r.json())["notes"]] == ["Задачи"]
            # чат
            chat = await (await op_client.get("/api/op/chat")).json()
            assert chat["messages"][0]["text"] == "Анна, посмотрите задачи"
            await op_client.post("/api/op/chat", json={"text": "Готово, банк — сделано"})
            me = await (await op_client.get("/api/op/me")).json()
            assert me["unread"] == 0 and me["operator"]["has_password"]
            # смена своего пароля
            r = await op_client.post("/api/op/me", json={"old": "анна-пароль", "new": "анна-пароль-2"})
            assert r.status == 200
        assert j.operators.unread(op_id, "owner") == 1
        assert "**Анна**: Готово, банк — сделано" in j.vault.read("Jarvis/Chat/Анна.md")

        # второе устройство оператора: вход по имени и паролю; первое завершаем отсюда
        async with TestClient(TestServer(build_app(j))) as phone:
            assert (await phone.post("/api/op-login", json={"name": "анна", "password": "не тот"})).status == 403
            r = await phone.post("/api/op-login", json={"name": "анна", "password": "анна-пароль-2"},
                                 headers={"User-Agent": "Mozilla/5.0 (iPhone) Safari/604.1"})
            assert r.status == 200
            dev = (await (await phone.get("/api/sessions")).json())["sessions"]
            assert len(dev) == 2 and dev[0]["current"] and dev[0]["device"] == "Safari · iPhone"
            other = dev[1]["sid"]
            assert (await phone.post("/api/sessions", json={"action": "revoke", "sid": dev[0]["sid"]})).status == 400
            r = await phone.post("/api/sessions", json={"action": "others"})
            assert len((await r.json())["sessions"]) == 1
            assert not j.operators.session_valid(op_id, other)
            assert (await phone.get("/api/op/me")).status == 200
            await phone.post("/api/logout")
            assert (await phone.get("/api/op/me")).status == 401        # «Выйти» завершает и сессию на сервере

        # владелец: устройства оператора, отключение
        async with TestClient(TestServer(build_app(j))) as c2:
            assert (await c2.post("/api/login", json={"code": "корень-123"})).status == 200
            ov = await (await c2.get("/api/admin/operators")).json()
            assert ov["operators"][0]["unread"] == 1
            async with TestClient(TestServer(build_app(j))) as laptop:      # оператор вошёл с ноутбука
                r = await laptop.post("/api/op-login", json={"name": "анна", "password": "анна-пароль-2"})
                assert r.status == 200
            sid_list = (await (await c2.post(f"/api/admin/operators/{op_id}", json={"action": "sessions"})).json())
            assert len(sid_list["sessions"]) == 1
            sid = sid_list["sessions"][0]["sid"]
            await c2.post(f"/api/admin/operators/{op_id}", json={"action": "revoke", "sid": sid})
            assert j.operators.sessions(op_id) == []
            await c2.post(f"/api/admin/operators/{op_id}", json={"action": "update", "active": False})
            assert (await c2.post("/api/op-login", json={"name": "анна", "password": "анна-пароль-2"})).status == 403
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
