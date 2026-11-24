"""Приложение «Настройки и диагностика»: настройки из интерфейса (без утечки секретов), свои токены, SSH-серверы,
обновление с GitHub (git fetch + ff-only) и раздел только для владельца."""
import asyncio
import json
import os
import shutil
import subprocess

import pytest
from aiohttp.test_utils import TestClient, TestServer

from jarvis.settings import Settings, apply_saved_env, mask
from jarvis.updater import Updater, UpdateError
from jarvis.web import build_app

from .conftest import make_jarvis


def test_settings_store_and_mask(tmp_path, monkeypatch):
    s = Settings(tmp_path)
    assert mask("sk-ant-api03-abcdef1234") == "sk-…1234" and mask("abc") == "•••" and mask("") == ""
    monkeypatch.setenv("TELEGRAM_OWNER_ID", "777")
    s.set_known("TELEGRAM_BOT_TOKEN", "123456:SECRET-TOKEN-xyz")
    with pytest.raises(ValueError):
        s.set_known("PATH", "/tmp")                                   # только известные
    with pytest.raises(ValueError):
        s.set_known("TELEGRAM_BOT_TOKEN", "a\nb")
    s.set_custom("openweather_key", "ow-secret-9876", "погода")
    for bad in ("LD_PRELOAD", "PYTHONPATH", "JARVIS_SECRET", "ANTHROPIC_API_KEY", "1BAD", "ру"):
        with pytest.raises(ValueError):
            s.set_custom(bad, "x")
    s.ssh_upsert({"name": "VPS", "host": "203.0.113.7", "user": "root", "password": "ssh-pass-1"})
    with pytest.raises(ValueError):
        s.ssh_upsert({"host": "bad host; rm -rf"})
    with pytest.raises(ValueError):
        s.ssh_upsert({"host": "1.2.3.4", "key": "не ключ"})
    pub = s.public()
    raw = json.dumps(pub, ensure_ascii=False)
    for secret in ("SECRET-TOKEN", "ow-secret", "ssh-pass-1"):
        assert secret not in raw                                      # секреты наружу не уходят
    tg = next(k for k in pub["known"] if k["name"] == "TELEGRAM_BOT_TOKEN")
    assert tg["set"] and tg["source"] == "ui" and tg["preview"] == "123…-xyz"
    owner = next(k for k in pub["known"] if k["name"] == "TELEGRAM_OWNER_ID")
    assert owner["value"] == "777" and owner["source"] == "env"     # несекретное — видно, из .env
    assert pub["custom"] == [{"name": "OPENWEATHER_KEY", "note": "погода", "preview": "ow-…9876", "set": True}]
    assert pub["ssh"][0]["has_password"] and "password" not in pub["ssh"][0] and pub["restart_needed"]
    sid = pub["ssh"][0]["id"]
    s.ssh_upsert({"id": sid, "host": "203.0.113.7", "password": ""})  # пустой пароль — не менять
    assert s.ssh_get(sid)["password"] == "ssh-pass-1"
    assert oct((tmp_path / "settings.json").stat().st_mode & 0o777) == "0o600"
    # при запуске — в окружение поверх .env
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "из .env")             # тест вернёт окружение как было
    monkeypatch.setenv("OPENWEATHER_KEY", "")
    assert set(apply_saved_env(tmp_path)) == {"TELEGRAM_BOT_TOKEN", "OPENWEATHER_KEY"}
    assert os.environ["TELEGRAM_BOT_TOKEN"] == "123456:SECRET-TOKEN-xyz"
    assert os.environ["OPENWEATHER_KEY"] == "ow-secret-9876"
    s.set_known("TELEGRAM_BOT_TOKEN", None)
    s.set_custom("OPENWEATHER_KEY", remove=True)
    s.ssh_remove(sid)
    assert Settings(tmp_path).public()["ssh"] == [] and not Settings(tmp_path).data["env"]
    assert s.set_update(auto=True, hours=999)["hours"] == 168


def _git(cwd, *args):
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *args], cwd=cwd, check=True,
                   capture_output=True)


@pytest.mark.skipif(not shutil.which("git"), reason="нет git")
def test_updater_fast_forward(tmp_path):
    origin, local = tmp_path / "origin", tmp_path / "local"
    origin.mkdir()
    _git(origin, "init", "-q", "-b", "main")
    (origin / "a.txt").write_text("1")
    _git(origin, "add", ".")
    _git(origin, "commit", "-qm", "первая версия")
    _git(tmp_path, "clone", "-q", str(origin), str(local))

    async def run():
        up = Updater(local)
        st = await up.status()
        assert st["git"] and st["branch"] == "main" and st["subject"] == "первая версия" and st["dirty"] == 0
        assert (await up.check())["behind"] == 0
        assert (await up.apply()) == {"updated": False, "reason": "уже последняя версия"}
        (origin / "a.txt").write_text("2")
        _git(origin, "commit", "-qam", "новая функция")
        info = await up.check()
        assert info["behind"] == 1 and info["commits"][0]["subject"] == "новая функция"
        (local / "a.txt").write_text("локальная правка")
        with pytest.raises(UpdateError):
            await up.apply()                                          # свои правки не затираем
        _git(local, "checkout", "a.txt")
        res = await up.apply()
        assert res["updated"] and not res["deps"] and (local / "a.txt").read_text() == "2"
        assert not Updater(tmp_path / "нет").available
    asyncio.run(run())


def test_system_api_owner_only(tmp_path):
    async def run():
        j = make_jarvis(tmp_path)
        served = []

        async def ssh_server(reader, writer):
            served.append(1)
            writer.write(b"SSH-2.0-OpenSSH_9.6\r\n")
            await writer.drain()
            writer.close()
        server = await asyncio.start_server(ssh_server, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        async with TestClient(TestServer(build_app(j))) as c:
            await c.post("/api/setup", json={"mode": "password", "password": "корень-123"})
            r = await (await c.get("/api/system")).json()
            assert r["diag"]["ram"] and {s["id"] for s in r["services"]} >= {"brain", "telegram", "sync"}
            assert "known" in r["settings"] and "version" in r
            r = await c.post("/api/system/settings",
                             json={"action": "known", "name": "TELEGRAM_BOT_TOKEN", "value": "1:top-secret-token"})
            body = await r.json()
            assert r.status == 200 and body["restart_needed"] and "top-secret" not in json.dumps(body)
            r = await c.post("/api/system/settings", json={"action": "custom", "name": "PATH", "value": "x"})
            assert r.status == 400
            ssh = {"action": "save", "name": "Тест", "host": "127.0.0.1", "port": port, "user": "atom", "password": "p"}
            r = await c.post("/api/system/ssh", json=ssh)
            sid = (await r.json())["ssh"][0]["id"]
            chk = await (await c.post("/api/system/ssh", json={"action": "check", "id": sid})).json()
            assert chk["ok"] and chk["banner"].startswith("SSH-2.0") and served
            assert (await c.post("/api/system/restart")).status == 400   # в тестах перезапускать нечем
            r = await c.post("/api/system/update", json={"action": "auto", "auto": True, "hours": 12})
            assert (await r.json())["update"] == {"auto": True, "hours": 12, "branch": ""}
            # оператору раздел закрыт
            ov = await (await c.post("/api/admin/operators", json={"name": "Анна"})).json()
            token = ov["token"]
        async with TestClient(TestServer(build_app(j))) as op:
            await op.post("/api/invite/accept", json={"token": token, "password": "анна-пароль"})
            for path in ("/api/system",):
                assert (await op.get(path)).status == 403
            assert (await op.post("/api/system/restart")).status == 403
        server.close()
        await j.close()
    asyncio.run(run())


def test_brain_setting_and_old_custom_token(tmp_path, monkeypatch):
    s = Settings(tmp_path)
    with pytest.raises(ValueError):
        s.set_known("JARVIS_LLM", "deepseak")                         # опечатку не сохраняем — она бы сбила мозг
    s.set_known("JARVIS_LLM", "DeepSeek")
    assert s.data["env"]["JARVIS_LLM"] == "deepseek"
    # ключ, сохранённый раньше «своим токеном», после обновления становится настройкой и не теряется
    raw = json.loads((tmp_path / "settings.json").read_text())
    raw["custom"] = [{"name": "DEEPSEEK_API_KEY", "value": "sk-ds-old", "note": ""},
                     {"name": "OPENWEATHER_KEY", "value": "ow", "note": ""}]
    (tmp_path / "settings.json").write_text(json.dumps(raw))
    for name in ("DEEPSEEK_API_KEY", "JARVIS_LLM", "OPENWEATHER_KEY"):
        monkeypatch.setenv(name, "")          # чтобы monkeypatch вернул окружение после теста
        monkeypatch.delenv(name)
    assert "DEEPSEEK_API_KEY" in apply_saved_env(tmp_path)
    assert os.environ["DEEPSEEK_API_KEY"] == "sk-ds-old" and os.environ["OPENWEATHER_KEY"] == "ow"
    pub = Settings(tmp_path).public()
    ds = next(k for k in pub["known"] if k["name"] == "DEEPSEEK_API_KEY")
    assert ds["set"] and ds["source"] == "ui" and "sk-ds-old" not in json.dumps(pub)
    assert [c["name"] for c in pub["custom"]] == ["OPENWEATHER_KEY"]


def test_bad_ui_setting_starts_without_it(tmp_path, monkeypatch):
    from jarvis.__main__ import load_config_safely

    for name in ("NEWS_INTERVAL", "USER_NAME"):
        monkeypatch.setenv(name, "")
        monkeypatch.delenv(name)
    monkeypatch.setenv("JARVIS_DATA_DIR", str(tmp_path))
    s = Settings(tmp_path)
    s.set_known("NEWS_INTERVAL", "десять")                            # int() не разберёт — раньше Atom падал
    s.set_known("USER_NAME", "Тест")
    cfg, error = load_config_safely(tmp_path)
    assert error and cfg.news_interval == 10 and cfg.user_name != "Тест"
    assert os.getenv("NEWS_INTERVAL") is None                         # окружение — как до настроек
    s.set_known("NEWS_INTERVAL", "15")
    cfg, error = load_config_safely(tmp_path)
    assert error == "" and cfg.news_interval == 15 and cfg.user_name == "Тест"
