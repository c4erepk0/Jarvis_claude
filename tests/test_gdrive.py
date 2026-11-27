"""«Диск ядра»: коннектор Google Drive, анонимность выдачи и права оператора."""
import json

import pytest
from aiohttp import FormData
from aiohttp.test_utils import TestClient, TestServer

from jarvis.gdrive import FILES_URL, TOKEN_URL, UPLOAD_URL, Drive, DriveConfig, DriveError, render_note, safe_name
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
        if url.startswith(UPLOAD_URL):
            return 200, json.dumps({"id": "up-1", "name": "Загружено", "mimeType": "image/jpeg",
                                    "size": "10"}).encode(), "application/json"
        if method == "POST" and url == FILES_URL:
            return 200, json.dumps({"id": "new-f", "name": "Новая папка",
                                    "mimeType": "application/vnd.google-apps.folder"}).encode(), "application/json"
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
    # ни одного лишнего поля: только id, имя, вид и уровень
    assert all(set(g) == {"id", "name", "kind", "level"} for g in op["drive"])


class FakeDrive:
    """Коннектор без сети: отдаёт заданный текст и запоминает загрузки."""

    ready = True

    def __init__(self):
        from types import SimpleNamespace
        self.asked, self.uploaded = [], []
        self.cfg = SimpleNamespace(ready=True, can_write=True, write=True, max_mb=4, folder_id="")

    def status(self):
        return {"ready": True, "enabled": True, "missing": [], "levels": {}, "can_write": True}

    async def content(self, file_id):
        self.asked.append(file_id)
        return {"id": file_id, "name": "Договор аренды", "text": "Условия: 100 000 ₽", "mime": "text/plain"}

    async def is_within(self, file_id, roots, depth=8):
        # «child-of-<папка>-…» — вложенный файл; всё остальное — снаружи
        return any(file_id.startswith(f"child-of-{r}") for r in roots)

    async def meta(self, file_id):
        return {"id": file_id, "name": "Папка", "mimeType": "application/vnd.google-apps.folder", "parents": []}

    async def list(self, query="", folder="", limit=100, folders=False):
        return [{"id": f"file-{folder}", "name": "Файл", "mime": "text/plain", "kind": "text",
                 "size": 3, "size_label": "3 Б", "modified": "2026-11-20T10:00:00"}]

    async def create_folder(self, name, parent=""):
        return {"id": "new-folder", "name": name, "mime": "application/vnd.google-apps.folder",
                "kind": "folder", "size": None, "size_label": "", "modified": ""}

    async def upload(self, name, data, mime, parent=""):
        self.uploaded.append({"name": name, "parent": parent, "size": len(data), "mime": mime})
        return {"id": "uploaded-1", "name": name, "mime": mime, "kind": "text", "size": len(data), "size_label": ""}


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
        async def list(self, query="", folder="", limit=100, folders=False):
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


def test_folders_listing_create_and_upload_body():
    import asyncio
    t = FakeTransport(files=[{"id": "fold-1", "name": "Обмен", "mimeType": "application/vnd.google-apps.folder"}])
    d = Drive(DriveConfig(client_id="cid", client_secret="cs", refresh_token="rt", write=True), transport=t)
    files = asyncio.run(d.list(folders=True))
    assert files[0]["kind"] == "folder" and files[0]["size"] is None
    assert "mimeType !=" not in t.calls[-1]["params"]["q"]      # папки показываем

    folder = asyncio.run(d.create_folder("Обмен", "root-1"))
    assert folder["kind"] == "folder" and folder["id"] == "new-f"
    body = json.loads(t.calls[-1]["data"].decode())
    assert body["parents"] == ["root-1"] and body["mimeType"].endswith("folder")

    item = asyncio.run(d.upload("Отчёт.jpg", b"\xff\xd8data", "image/jpeg", parent="fold-1"))
    assert item["id"] == "up-1"
    call = t.calls[-1]
    assert call["url"].startswith(UPLOAD_URL) and call["params"]["uploadType"] == "multipart"
    assert "multipart/related; boundary=" in call["headers"]["Content-Type"]
    assert "Отчёт.jpg".encode() in call["data"] and b"image/jpeg" in call["data"]


def test_upload_and_mkdir_need_write():
    import asyncio
    read_only = Drive(DriveConfig(client_id="cid", client_secret="cs", refresh_token="rt"))
    with pytest.raises(DriveError, match="только для чтения"):
        asyncio.run(read_only.upload("a.txt", b"x", "text/plain"))
    with pytest.raises(DriveError, match="только для чтения"):
        asyncio.run(read_only.create_folder("Папка"))
    assert read_only.status()["can_write"] is False


class TreeTransport:
    """Ответы на files.get с цепочкой родителей — для проверки is_within."""

    def __init__(self, tree):
        self.tree = tree
        self.calls = []

    async def __call__(self, method, url, params, data, headers):
        if url == TOKEN_URL:
            return 200, json.dumps({"access_token": "tok", "expires_in": 3600}).encode(), "application/json"
        fid = url.rsplit("/", 1)[-1]
        return 200, json.dumps({"id": fid, "parents": self.tree.get(fid, [])}).encode(), "application/json"


def test_is_within_walks_parents():
    import asyncio
    t = TreeTransport({"child": ["root"], "grand": ["child"], "stranger": ["other"]})
    d = Drive(DriveConfig(client_id="cid", client_secret="cs", refresh_token="rt"), transport=t)
    assert asyncio.run(d.is_within("root", ["root"]))
    assert asyncio.run(d.is_within("child", ["root"]))
    assert asyncio.run(d.is_within("grand", ["root"]))
    assert not asyncio.run(d.is_within("stranger", ["root"]))
    assert not asyncio.run(d.is_within("grand", []))


def test_folder_grant_levels_validated(tmp_path):
    ops = Operators(tmp_path / "data", Vault(tmp_path / "v"))
    op, _ = ops.create("Борис", drive=[
        {"id": "fold-1", "name": "Обмен", "kind": "folder", "level": "upload"},
        {"id": "fold-2", "name": "Только смотреть", "kind": "folder", "level": "view"},
        {"id": "fold-3", "name": "Папка с копией", "kind": "folder", "level": "copy"},   # нельзя
        {"id": "file-1", "name": "Файл", "kind": "file", "level": "upload"},             # нельзя
        {"id": "file-2", "name": "Файл с копией", "kind": "file", "level": "copy"},
    ])
    got = {g["id"]: g["level"] for g in ops.public(op)["drive"]}
    assert got == {"fold-1": "upload", "fold-2": "view", "file-2": "copy"}


def test_core_folder_grants_and_uploads(tmp_path):
    import asyncio

    async def run():
        j = make_jarvis(tmp_path, drive=FakeDrive())
        op, _ = j.operators.create("Анна", drive=[
            {"id": "folder-1", "name": "Обмен", "kind": "folder", "level": "upload"},
            {"id": "folder-2", "name": "Только смотреть", "kind": "folder", "level": "view"}])
        op = j.operators.get(op["id"])
        roots = await j.op_drive_list(op)
        assert [f["kind"] for f in roots["files"]] == ["folder", "folder"]

        inside = await j.op_drive_list(op, "child-of-folder-1")
        assert inside["can_upload"] is True and inside["folder"]["name"] == "Папка"
        read_only = await j.op_drive_list(op, "child-of-folder-2")
        assert read_only["can_upload"] is False
        with pytest.raises(PermissionError):
            await j.op_drive_list(op, "чужое")                     # снаружи выданных папок

        with pytest.raises(PermissionError):
            await j.op_drive_upload(op, "child-of-folder-2", "фото.jpg", b"x", "image/jpeg")
        got = await j.op_drive_upload(op, "child-of-folder-1", "фото.jpg", b"x", "image/jpeg")
        assert got["file"]["name"] == "фото.jpg"

        await j.drive_share(op["id"], {"id": "folder-3", "name": "Новая", "kind": "folder"}, "upload")
        assert {g["id"] for g in j.operators.get(op["id"])["drive"]} == {"folder-1", "folder-2", "folder-3"}
        with pytest.raises(ValueError):
            await j.drive_share(op["id"], {"id": "file-9", "name": "ф", "kind": "file"}, "upload")
        await j.drive_share(op["id"], {"id": "folder-3", "name": "Новая", "kind": "folder"}, "")
        assert "folder-3" not in {g["id"] for g in j.operators.get(op["id"])["drive"]}

    asyncio.run(run())


def test_web_drive_app_owner_and_operator(tmp_path):
    import asyncio

    class AppDrive(FakeDrive):
        async def list(self, query="", folder="", limit=100, folders=False):
            return [{"id": "folder-1", "name": "Обмен", "mime": "application/vnd.google-apps.folder",
                     "kind": "folder", "size": None, "size_label": "", "modified": ""}]

    async def run():
        j = make_jarvis(tmp_path, drive=AppDrive())
        async with TestClient(TestServer(build_app(j))) as c:
            await c.post("/api/setup", json={"mode": "password", "password": "корень-123"})
            got = await (await c.get("/api/drive")).json()
            assert got["files"][0]["kind"] == "folder" and got["can_write"] is True
            mk = await (await c.post("/api/drive/mkdir", json={"name": "Обмен", "parent": ""})).json()
            assert mk["folder"]["id"] == "new-folder" and mk["folder"]["name"] == "Обмен"
            form = FormData()
            form.add_field("file", b"\xff\xd8", filename="фото.jpg", content_type="image/jpeg")
            form.add_field("folder", "folder-1")
            up = await c.post("/api/drive/upload", data=form)
            assert up.status == 200 and (await up.json())["file"]["name"] == "фото.jpg"
            created = await (await c.post("/api/admin/operators", json={"name": "Анна"})).json()
            op_id, token = created["created"]["id"], created["token"]
            shared = await (await c.post("/api/drive/share", json={
                "op": op_id, "id": "folder-1", "name": "Обмен", "kind": "folder", "level": "upload"})).json()
            assert shared["operators"][0]["drive"][0]["level"] == "upload"

        async with TestClient(TestServer(build_app(j))) as op:
            await op.post("/api/invite/accept", json={"token": token, "password": "пароль-анны"})
            roots = await (await op.get("/api/op/drive/list")).json()
            assert roots["files"][0]["id"] == "folder-1"
            form = FormData()
            form.add_field("file", b"data", filename="заметка.txt", content_type="text/plain")
            form.add_field("folder", "child-of-folder-1")
            r = await op.post("/api/op/drive/upload", data=form)
            assert r.status == 200 and (await r.json())["file"]["name"] == "заметка.txt"
            # в чужую папку — отказ
            form2 = FormData()
            form2.add_field("file", b"data", filename="x.txt", content_type="text/plain")
            form2.add_field("folder", "чужое")
            assert (await op.post("/api/op/drive/upload", data=form2)).status == 403

    asyncio.run(run())
