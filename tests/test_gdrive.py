"""«Диск ядра»: коннектор Google Drive, анонимность выдачи и права оператора."""
import json

import pytest
from aiohttp.test_utils import TestClient, TestServer

from jarvis.gdrive import FILES_URL, TOKEN_URL, Drive, DriveConfig, DriveError, render_note, safe_name
from jarvis.operators import Operators
from jarvis.vault import Vault
from jarvis.web import build_app

from .conftest import make_jarvis

DOC = "application/vnd.google-apps.document"


def drive(**kw) -> Drive:
    cfg = DriveConfig(client_id="cid", client_secret="csecret", refresh_token="refresh", **kw)
    return Drive(cfg)


class FakeTransport:
    """Ответы Google без сети. Запоминает запросы, чтобы проверять параметры."""

    def __init__(self, files=None, meta=None, body="", token_status=200, file_status=200):
        self.files = files or []
        self.meta = meta or {"id": "file-1", "name": "Договор", "mimeType": DOC}
        self.body = body
        self.token_status = token_status
        self.file_status = file_status
        self.calls = []

    async def __call__(self, method, url, params, data, headers):
        self.calls.append({"method": method, "url": url, "params": params or {}, "data": data or {},
                           "headers": headers})
        if url == TOKEN_URL:
            if self.token_status != 200:
                return (self.token_status, json.dumps({"error": {"message": "invalid_grant"}}).encode(),
                        "application/json")
            return 200, json.dumps({"access_token": "tok", "expires_in": 3600}).encode(), "application/json"
        if url.endswith("/export") or (params or {}).get("alt") == "media":
            return self.file_status, self.body.encode(), "text/markdown"
        if url.startswith(FILES_URL + "/"):
            if self.file_status != 200:
                return self.file_status, json.dumps({"error": {"message": "not found"}}).encode(), "application/json"
            return 200, json.dumps(self.meta).encode(), "application/json"
        return 200, json.dumps({"files": self.files}).encode(), "application/json"


def test_not_configured_tells_what_is_missing():
    import asyncio
    empty = Drive(DriveConfig())
    st = empty.status()                                   # status безопасен: ни сети, ни исключений
    assert st["ready"] is False
    assert st["missing"] == ["GDRIVE_CLIENT_ID", "GDRIVE_CLIENT_SECRET", "GDRIVE_REFRESH_TOKEN"]
    with pytest.raises(DriveError, match="GDRIVE_CLIENT_ID"):
        asyncio.run(empty.list())
    off = Drive(DriveConfig(enabled=False))
    assert off.status()["ready"] is False
    with pytest.raises(DriveError, match="выключен"):
        asyncio.run(off.list())


async def _list_flow(**kw) -> tuple[list[dict], FakeTransport]:
    raw = [{"id": "f1", "name": "Договор аренды", "mimeType": DOC, "size": "2048",
            "modifiedTime": "2026-11-20T10:00:00.000Z",
            "owners": [{"emailAddress": "owner@example.com", "displayName": "Владелец"}],
            "permissions": [{"id": "anyone", "type": "anyone"}], "webViewLink": "https://drive.google.com/x",
            "parents": ["secret-folder"], "md5Checksum": "abc"},
           {"id": "f2", "name": "Заметки.txt", "mimeType": "text/plain", "size": "10",
            "modifiedTime": "2026-11-19T09:00:00.000Z"}]
    t = FakeTransport(files=raw)
    d = Drive(DriveConfig(client_id="cid", client_secret="cs", refresh_token="rt", **kw), transport=t)
    files = await d.list("договор")
    return files, t


def test_list_returns_only_safe_fields():
    import asyncio
    files, t = asyncio.run(_list_flow())
    assert [f["id"] for f in files] == ["f1", "f2"]
    assert set(files[0]) == {"id", "name", "mime", "kind", "size", "size_label", "modified"}
    dumped = json.dumps(files, ensure_ascii=False)
    for secret_word in ("owner@example.com", "owners", "permissions", "webViewLink", "parents", "md5Checksum"):
        assert secret_word not in dumped
    assert files[0]["kind"] == "doc" and files[0]["size_label"] == "2 КБ"
    # папки и корзина исключены, поиск по имени и папка-ограничение попали в запрос
    q = t.calls[-1]["params"]["q"]
    assert "trashed = false" in q and "mimeType != 'application/vnd.google-apps.folder'" in q
    assert "name contains 'договор'" in q
    files2, t2 = asyncio.run(_list_flow(folder_id="Folder_123"))
    assert "'Folder_123' in parents" in t2.calls[-1]["params"]["q"]


def test_list_rejects_weird_folder_id():
    t = FakeTransport()
    d = Drive(DriveConfig(client_id="cid", client_secret="cs", refresh_token="rt"), transport=t)
    import asyncio
    with pytest.raises(DriveError, match="папки"):
        asyncio.run(d.list(folder="../../etc"))


def test_content_document_and_text():
    import asyncio
    t = FakeTransport(meta={"id": "file-1", "name": "Договор", "mimeType": DOC}, body="# Договор\n\nТекст")
    d = Drive(DriveConfig(client_id="cid", client_secret="cs", refresh_token="rt"), transport=t)
    data = asyncio.run(d.content("file-1"))
    assert data["text"] == "# Договор\n\nТекст" and data["name"] == "Договор"
    assert any(c["url"].endswith("/export") for c in t.calls)
    assert all(c["headers"].get("Authorization") == "Bearer tok" for c in t.calls if c["url"] != TOKEN_URL)

    t2 = FakeTransport(meta={"id": "file-2", "name": "Заметки", "mimeType": "text/plain"}, body="просто текст")
    d2 = Drive(DriveConfig(client_id="cid", client_secret="cs", refresh_token="rt"), transport=t2)
    assert asyncio.run(d2.content("file-2"))["text"] == "просто текст"
    assert any(c["params"].get("alt") == "media" for c in t2.calls)


def test_content_limits_and_unsupported():
    import asyncio
    big = FakeTransport(meta={"id": "file-1", "name": "Скан", "mimeType": "application/pdf", "size": "10"})
    d = Drive(DriveConfig(client_id="cid", client_secret="cs", refresh_token="rt"), transport=big)
    with pytest.raises(DriveError, match="документ Google"):
        asyncio.run(d.content("file-1"))

    huge = FakeTransport(meta={"id": "file-1", "name": "Большой", "mimeType": DOC, "size": str(9 * 1024 * 1024)})
    d2 = Drive(DriveConfig(client_id="cid", client_secret="cs", refresh_token="rt", max_mb=4), transport=huge)
    with pytest.raises(DriveError, match="больше 4 МБ"):
        asyncio.run(d2.content("file-1"))


def test_bad_token_and_bad_id():
    import asyncio
    t = FakeTransport(token_status=401)
    d = Drive(DriveConfig(client_id="cid", client_secret="cs", refresh_token="rt"), transport=t)
    with pytest.raises(DriveError, match="не принял токен"):
        asyncio.run(d.list())
    t2 = FakeTransport()
    d2 = Drive(DriveConfig(client_id="cid", client_secret="cs", refresh_token="rt"), transport=t2)
    with pytest.raises(DriveError, match="идентификатор файла"):
        asyncio.run(d2.content("../../etc/passwd"))
    assert t2.calls == []                                # кривой id до Google не дошёл


def test_render_note_has_no_account():
    text = render_note("Договор аренды.md", "Условия", "2026-11-28")
    assert text.startswith("---\ntype: drive\nsource: Диск ядра\nimported: 2026-11-28\n---")
    assert "# Договор аренды" in text and "Условия" in text
    assert "@" not in text
    assert safe_name('Отчёт/2026 "итог".md') == "Отчёт 2026 итог"
    assert render_note("Пусто", "", "2026-11-28").endswith("Пустой документ.\n")


def test_operator_grants_are_validated(tmp_path):
    ops = Operators(tmp_path / "data", Vault(tmp_path / "v"))
    op, _ = ops.create("Анна", drive=[
        {"id": "file-1", "name": "Договор", "level": "view"},
        {"id": "file-1", "name": "Договор (дубль)", "level": "copy"},      # повтор — последний побеждает
        {"id": "file-2", "name": "Смета", "level": "copy"},
        {"id": "file-3", "name": "Плохой уровень", "level": "admin"},
        {"id": "../etc", "name": "Кривой id", "level": "view"},
        "file-4",
    ])
    got = {g["id"]: g for g in ops.public(op)["drive"]}
    assert set(got) == {"file-1", "file-2", "file-4"}
    assert got["file-1"]["level"] == "copy" and got["file-4"]["level"] == "view"
    assert op["drive"] == ops.public(op)["drive"]
    # ни одного лишнего поля: только id, имя, уровень
    assert all(set(g) == {"id", "name", "level"} for g in op["drive"])


class FakeDrive:
    """Коннектор без сети: отдаёт заранее заданный текст."""

    ready = True

    def __init__(self):
        self.asked = []

    def status(self):
        return {"ready": True, "enabled": True, "missing": [], "levels": {}}

    async def content(self, file_id):
        self.asked.append(file_id)
        return {"id": file_id, "name": "Договор аренды", "text": "Условия: 100 000 ₽", "mime": "text/plain"}


def test_core_operator_access_and_copy(tmp_path):
    import asyncio

    async def run():
        j = make_jarvis(tmp_path, drive=FakeDrive())
        op, _ = j.operators.create("Анна", drive=[{"id": "file-1", "name": "Договор", "level": "view"},
                                                  {"id": "file-2", "name": "Смета", "level": "copy"}])
        op = j.operators.get(op["id"])
        assert [f["id"] for f in j.op_drive(op)] == ["file-1", "file-2"]
        assert j.op_drive(op)[0]["level_label"] == "Просмотр"
        assert "Владелец" not in json.dumps(j.op_drive(op), ensure_ascii=False)

        with pytest.raises(PermissionError):
            await j.op_drive_content(op, "чужой-файл")
        view = await j.op_drive_content(op, "file-1")
        assert view["text"].startswith("Условия") and view["can_save"] is False
        with pytest.raises(PermissionError):
            await j.op_drive_save(op, "file-1")            # уровень «просмотр» — копию нельзя

        saved = await j.op_drive_save(op, "file-2")
        assert saved["path"] == f"{j.operators.folder(op)}/Диск/Договор аренды.md"
        note = j.vault.read(saved["path"])
        assert note.startswith("---\ntype: drive\nsource: Диск ядра") and "Условия" in note
        again = await j.op_drive_save(op, "file-2")        # вторая копия — новым именем
        assert again["path"].endswith("Договор аренды (2).md")
        assert any(n["path"] == saved["path"] for n in j.op_notes(op))

    asyncio.run(run())


def test_web_api_owner_and_operator(tmp_path):
    import asyncio

    class WebDrive(FakeDrive):
        async def list(self, query="", folder="", limit=100):
            return [{"id": "file-1", "name": "Договор аренды", "mime": "text/plain", "kind": "text",
                     "size": 12, "size_label": "12 Б", "modified": "2026-11-20T10:00:00"}]

    async def run():
        j = make_jarvis(tmp_path, drive=WebDrive())
        async with TestClient(TestServer(build_app(j))) as c:
            await c.post("/api/setup", json={"mode": "password", "password": "корень-123"})
            r = await (await c.get("/api/gdrive")).json()
            assert r["ready"] is True and [f["id"] for f in r["files"]] == ["file-1"]
            created = await (await c.post("/api/admin/operators", json={
                "name": "Анна", "drive": [{"id": "file-1", "name": "Договор аренды", "level": "copy"}]})).json()
            op_id, token = created["created"]["id"], created["token"]
            assert created["operators"][0]["drive"][0]["id"] == "file-1"

        async with TestClient(TestServer(build_app(j))) as op:
            await op.post("/api/invite/accept", json={"token": token, "password": "пароль-анны"})
            files = await (await op.get("/api/op/drive")).json()
            assert [f["id"] for f in files["files"]] == ["file-1"]
            assert (await op.get("/api/op/drive/чужой")).status == 403
            got = await (await op.get("/api/op/drive/file-1")).json()
            assert got["text"].startswith("Условия") and got["can_save"] is True
            # оператору закрыт раздел владельца
            assert (await op.get("/api/gdrive")).status == 403
            assert (await op.post(f"/api/admin/operators/{op_id}", json={"action": "delete"})).status == 403

    asyncio.run(run())
