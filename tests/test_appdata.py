"""Общие данные приложений каталога («Ценники»): версии, резервные копии, права владельца и операторов,
рассылка изменений (событие «appdata») только тем, у кого есть доступ."""
import asyncio
import json

import pytest
from aiohttp.test_utils import TestClient, TestServer

from jarvis.appdata import MAX_BYTES, AppData, AppDataError
from jarvis.web import build_app

from .conftest import make_jarvis

APP = "Apps/Ценники.md"


def test_store_versions_and_backups(tmp_path):
    s = AppData(tmp_path)
    assert s.get(APP) == {"app": APP, "data": None, "rev": 0, "updated": None, "by": ""}
    for i in range(1, 8):
        rec = s.set(APP, {"tags": [{"id": str(i)}]}, "Владелец" if i % 2 else "Анна")
        assert rec["rev"] == i
    got = s.get(APP)
    assert got["rev"] == 7 and got["data"] == {"tags": [{"id": "7"}]} and got["by"] == "Владелец"
    hist = s.history(APP)
    assert [h["rev"] for h in hist] == [6, 5, 4, 3, 2]                 # пять прошлых версий, свежие первыми
    back = s.restore(APP, 2, "Владелец")                                # вернуть rev 5
    assert back["rev"] == 8 and s.get(APP)["data"] == {"tags": [{"id": "5"}]}
    with pytest.raises(AppDataError):
        s.restore(APP, 9, "Владелец")
    with pytest.raises(AppDataError):
        s.set(APP, "строка", "Владелец")
    with pytest.raises(AppDataError):
        s.set(APP, {"big": "x" * (MAX_BYTES + 1)}, "Владелец")
    assert s.key(APP) != s.key("Apps/Другое.md")
    assert oct((tmp_path / "appdata" / f"{s.key(APP)}.json").stat().st_mode & 0o777) == "0o600"


def test_api_owner_operator_and_live_updates(tmp_path):
    async def run():
        j = make_jarvis(tmp_path)
        j.vault.write(APP, "---\ntype: app\nurl: https://c4erepk0.github.io/cenniki/\n---\n# Ценники\n")
        j.vault.write("Apps/Секрет.md", "---\ntype: app\n---\n# Секрет\n")
        events = []

        class WS:
            def __init__(self, filt=None):
                self.atom_filter = filt

            async def send_str(self, payload):
                events.append((self, json.loads(payload)))
        async with TestClient(TestServer(build_app(j))) as c:
            await c.post("/api/setup", json={"mode": "password", "password": "корень-123"})
            new_op = {"name": "Анна", "apps": [{"id": APP, "level": "use"}]}
            ov = await (await c.post("/api/admin/operators", json=new_op)).json()
            token, op_id = ov["token"], ov["created"]["id"]
            r = await (await c.get(f"/api/appdata?app={APP}")).json()
            assert r["rev"] == 0 and r["data"] is None
            r = await c.put("/api/appdata", json={"app": APP, "data": {"tags": [{"name": "Хлеб", "price": "55"}]},
                                                  "client": "dash1"})
            assert (await r.json())["rev"] == 1
            assert (await c.put("/api/appdata", json={"app": "Нет/такого.md", "data": {}})).status == 403
            assert (await c.put("/api/appdata", json={"app": APP, "data": "не объект"})).status == 400
        async with TestClient(TestServer(build_app(j))) as op:
            await op.post("/api/invite/accept", json={"token": token, "password": "анна-пароль"})
            r = await (await op.get(f"/api/op/appdata?app={APP}")).json()
            assert r["data"]["tags"][0]["name"] == "Хлеб" and r["by"] == "Владелец"
            assert (await op.get("/api/op/appdata?app=Apps/Секрет.md")).status == 403   # доступа не давали
            assert (await op.get(f"/api/appdata?app={APP}")).status == 403               # раздел владельца
            # оператор правит — владелец получает событие, чужой оператор — нет
            owner_ws, op_ws, other_ws = WS(), WS(lambda e: e["type"] == "appdata" and e["data"]["app"] == APP), \
                WS(lambda e: False)
            j.hub.clients.update({owner_ws, op_ws, other_ws})
            r = await op.put("/api/op/appdata", json={"app": APP, "data": {"tags": [{"name": "Хлеб", "price": "60"}]},
                                                      "client": "op1"})
            assert (await r.json())["rev"] == 2
            got = [(w, e) for w, e in events if e["type"] == "appdata"]
            assert {id(w) for w, _ in got} == {id(owner_ws), id(op_ws)}
            assert got[0][1]["data"] == {"app": APP, "rev": 2, "by": "Анна", "client": "op1"}
            r = await op.post("/api/op/appdata", json={"app": APP, "action": "restore", "n": 1})
            assert r.status == 403                                                       # откат — только владелец
            # отняли доступ — данные закрыты сразу
            j.operators.update(op_id, apps=[])
            assert (await op.get(f"/api/op/appdata?app={APP}")).status == 403
        await j.close()
    asyncio.run(run())
