"""«Обмен файлами»: пути, квоты, права операторов и API — без сети и без облака."""
import pytest
from aiohttp import FormData
from aiohttp.test_utils import TestClient, TestServer

from jarvis.fileshare import FileShare, ShareError, clean_name
from jarvis.operators import Operators
from jarvis.vault import Vault
from jarvis.web import build_app

from .conftest import make_jarvis


def share(tmp_path, **kw) -> FileShare:
    return FileShare(tmp_path / "exchange", **{"max_mb": 1, "quota_mb": 2, **kw})


def test_names_and_paths_are_safe(tmp_path):
    fs = share(tmp_path)
    assert clean_name('Отчёт/2026 "итог".pdf') == "Отчёт 2026 итог.pdf"
    assert len(clean_name("я" * 300)) == 120
    assert clean_name("..") == ""
    assert clean_name("  .  ") == ""

    for bad in ("../секрет", "a/../../b", "/etc/passwd", ".скрытая", "a/" + "b/" * 7):
        with pytest.raises(ShareError):
            fs.resolve(bad)
    assert fs.resolve("Договоры/2026.pdf") == fs.root / "Договоры/2026.pdf"
    assert fs.resolve("", allow_root=True) == fs.root


def test_list_mkdir_upload_read_delete(tmp_path):
    fs = share(tmp_path)
    fs.mkdir("Договоры")
    fs.mkdir("Фото")
    fs.save("договор.pdf", b"%PDF-1.4", "application/pdf", "Договоры")
    fs.save("фото.jpg", b"\xff\xd8\xff", "image/jpeg", "Фото")
    fs.save("ещё.pdf", b"%PDF", "application/pdf", "Договоры")

    root = fs.list()
    assert [i["name"] for i in root] == ["Договоры", "Фото"]          # папки первыми
    assert root[0]["kind"] == "folder" and root[0]["size"] is None

    items = fs.list("Договоры")
    assert [i["name"] for i in items] == ["договор.pdf", "ещё.pdf"]
    assert items[0]["kind"] == "pdf" and items[0]["size_label"] == "8 Б"

    data, mime, name = fs.read("Договоры/договор.pdf")
    assert data == b"%PDF-1.4" and mime == "application/pdf" and name == "договор.pdf"

    # одинаковое имя не перезаписывает чужой файл
    fs.save("договор.pdf", b"new", "application/pdf", "Договоры")
    assert [i["name"] for i in fs.list("Договоры")] == ["договор (2).pdf", "договор.pdf", "ещё.pdf"]

    fs.delete("Договоры/договор.pdf")
    assert "договор.pdf" not in [i["name"] for i in fs.list("Договоры")]
    fs.delete("Договоры/договор (2).pdf")
    fs.delete("Договоры/ещё.pdf")
    fs.delete("Договоры")
    assert [i["name"] for i in fs.list()] == ["Фото"]
    with pytest.raises(ShareError, match="не пуста"):
        fs.delete("Фото")


def test_quota_and_size_limits(tmp_path):
    fs = share(tmp_path, max_mb=1, quota_mb=2)
    big = b"x" * (1024 * 1024 + 10)
    with pytest.raises(ShareError, match="больше 1.0 МБ"):
        fs.save("большой.bin", big)
    with pytest.raises(ShareError, match="пустой"):
        fs.save("пусто.txt", b"")
    assert fs.save("a.bin", b"x" * (1024 * 1024))["name"] == "a.bin"
    assert fs.save("b.bin", b"x" * (1024 * 1024))["name"] == "b.bin"     # ровно квота — ещё можно
    with pytest.raises(ShareError, match="не хватает места"):
        fs.save("c.bin", b"x")
    usage = fs.usage()
    assert usage["count"] == 2 and usage["bytes"] == 2 * 1024 * 1024 and usage["percent"] == 100


def test_hidden_and_outside_are_invisible(tmp_path):
    fs = share(tmp_path)
    fs.save("видно.txt", b"ok")
    (fs.root / ".скрытый").write_text("секрет")
    (fs.root / "внутри").mkdir()
    (fs.root / "внутри" / ".тоже").write_text("x")
    assert [i["name"] for i in fs.list()] == ["внутри", "видно.txt"]        # скрытые не показываем
    with pytest.raises(ShareError):
        fs.resolve(".скрытый")


def test_contains_limits_to_granted_folder(tmp_path):
    fs = share(tmp_path)
    fs.mkdir("Договоры")
    fs.mkdir("2026", "Договоры")
    fs.save("файл.txt", b"x", "text/plain", "Договоры/2026")
    assert fs.contains("Договоры", ["Договоры"])
    assert fs.contains("Договоры/2026/файл.txt", ["Договоры"])
    assert not fs.contains("Договоры-старые/x", ["Договоры"])      # не префикс по строкам
    assert not fs.contains("Фото", ["Договоры"])
    assert not fs.contains("../etc", ["Договоры"])


def test_operator_grants_validated(tmp_path):
    ops = Operators(tmp_path / "data", Vault(tmp_path / "v"))
    op, _ = ops.create("Анна", files=[
        {"path": "Договоры", "name": "Договоры", "level": "view"},
        {"path": "Договоры", "name": "Договоры", "level": "upload"},       # повтор — последний побеждает
        {"path": "Фото/2026", "level": "upload"},
        {"path": "../секрет", "level": "view"},                            # нельзя
        {"path": ".скрытая", "level": "view"},                             # нельзя
        {"path": "Пусто", "level": "admin"},                               # уровня нет
        {"path": "/абс/путь", "level": "view"},                            # нормализуется в абс/путь
    ])
    got = {g["path"]: g for g in ops.public(op)["files"]}
    assert set(got) == {"Договоры", "Фото/2026", "абс/путь"}
    assert got["Договоры"]["level"] == "upload"
    assert got["Фото/2026"]["name"] == "2026"
    assert all(set(g) == {"path", "name", "level"} for g in got.values())


def test_core_owner_and_operator_flow(tmp_path):
    import asyncio

    async def run():
        j = make_jarvis(tmp_path)
        assert (tmp_path / "data" / "exchange").is_dir()

        folder = (await j.exchange_mkdir("Договоры"))["folder"]
        await j.exchange_upload("аренда.pdf", b"%PDF-1.4", "application/pdf", folder["id"])
        assert j.exchange_browse()["files"][0]["name"] == "Договоры"
        assert j.exchange_browse("Договоры")["files"][0]["name"] == "аренда.pdf"

        op, _ = j.operators.create("Анна", files=[{"path": "Договоры", "name": "Договоры", "level": "view"}])
        op = j.operators.get(op["id"])
        roots = j.op_exchange_browse(op)
        assert [f["name"] for f in roots["files"]] == ["Договоры"]
        inside = j.op_exchange_browse(op, "Договоры")
        assert inside["can_upload"] is False and inside["files"][0]["name"] == "аренда.pdf"
        data, _, _ = j.op_exchange_read(op, "Договоры/аренда.pdf")
        assert data == b"%PDF-1.4"

        with pytest.raises(PermissionError):
            j.op_exchange_browse(op, "чужое")
        with pytest.raises(PermissionError):
            j.op_exchange_read(op, "../секрет")
        with pytest.raises(PermissionError):
            await j.op_exchange_upload(op, "Договоры", "мой.pdf", b"x", "application/pdf")

        # владелец дал загрузку — можно
        j.exchange_share(op["id"], "Договоры", "Договоры", "upload")
        assert j.op_exchange_browse(op, "Договоры")["can_upload"] is True
        got = await j.op_exchange_upload(op, "Договоры", "мой.pdf", b"x", "application/pdf")
        assert got["file"]["name"] == "мой.pdf"

        # отдельная папка оператору не выдана, пока её не открыли
        await j.exchange_mkdir("Личное")
        with pytest.raises(PermissionError):
            j.op_exchange_browse(op, "Личное")

        j.exchange_share(op["id"], "Договоры", "Договоры", "")
        assert j.op_files(j.operators.get(op["id"])) == []
        assert (await j.exchange_delete("Договоры/аренда.pdf"))["deleted"] is True

    asyncio.run(run())


def test_web_exchange_owner_and_operator(tmp_path):
    import asyncio

    async def run():
        j = make_jarvis(tmp_path)
        async with TestClient(TestServer(build_app(j))) as c:
            await c.post("/api/setup", json={"mode": "password", "password": "корень-123"})
            mk = await (await c.post("/api/exchange/mkdir", json={"name": "Договоры", "parent": ""})).json()
            assert mk["folder"]["name"] == "Договоры"

            form = FormData()
            form.add_field("file", b"%PDF-1.4", filename="аренда.pdf", content_type="application/pdf")
            form.add_field("folder", "Договоры")
            up = await (await c.post("/api/exchange/upload", data=form)).json()
            assert up["file"]["name"] == "аренда.pdf"

            listing = await (await c.get("/api/exchange?folder=Договоры")).json()
            assert [f["name"] for f in listing["files"]] == ["аренда.pdf"]
            raw = await c.get("/api/exchange/raw/Договоры/аренда.pdf")
            assert raw.status == 200 and await raw.read() == b"%PDF-1.4"
            assert "attachment" in raw.headers["Content-Disposition"]

            created = await (await c.post("/api/admin/operators", json={"name": "Анна"})).json()
            op_id, token = created["created"]["id"], created["token"]
            shared = await (await c.post("/api/exchange/share", json={
                "op": op_id, "path": "Договоры", "name": "Договоры", "level": "upload"})).json()
            assert shared["operators"][0]["files"][0]["level"] == "upload"
            assert (await c.post("/api/exchange/share", json={
                "op": op_id, "path": "../секрет", "level": "view"})).status == 400
            assert (await c.post("/api/exchange/share", json={
                "op": "нет-такого", "path": "Договоры", "level": "view"})).status == 400

        async with TestClient(TestServer(build_app(j))) as op:
            await op.post("/api/invite/accept", json={"token": token, "password": "пароль-анны"})
            roots = await (await op.get("/api/op/exchange")).json()
            assert [f["name"] for f in roots["files"]] == ["Договоры"]
            inside = await (await op.get("/api/op/exchange/list?folder=Договоры")).json()
            assert inside["can_upload"] is True
            got = await op.get("/api/op/exchange/raw/Договоры/аренда.pdf")
            assert got.status == 200 and await got.read() == b"%PDF-1.4"
            assert (await op.get("/api/op/exchange/raw/..%2F..%2Fetc%2Fpasswd")).status in (400, 403)

            form = FormData()
            form.add_field("file", b"hello", filename="ответ.txt", content_type="text/plain")
            form.add_field("folder", "Договоры")
            assert (await op.post("/api/op/exchange/upload", data=form)).status == 200

    asyncio.run(run())
