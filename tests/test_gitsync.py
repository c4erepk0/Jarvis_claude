"""Хранилище в GitHub-репозитории для серверного Jarvis + запуск с туннелем."""
import asyncio
import subprocess
from pathlib import Path

from aiohttp.test_utils import TestClient, TestServer

from jarvis.__main__ import ensure_access_code, parse_args
from jarvis.config import _vault_git
from jarvis.gitsync import GitSync
from jarvis.tunnel import cloudflared_asset, find_url
from jarvis.web import build_app

from .conftest import make_config, make_jarvis

GIT = ["git", "-c", "user.name=Phone", "-c", "user.email=phone@example.com", "-c", "init.defaultBranch=main"]


def sh(*args, cwd=None):
    return subprocess.run([*GIT, *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


def phone_clone(remote: Path, where: Path) -> Path:
    """Obsidian Git на iPhone: своя копия репозитория."""
    sh("clone", "-q", str(remote), str(where))
    return where


def test_clone_sync_and_union_merge(tmp_path):
    async def run():
        remote = tmp_path / "remote.git"
        sh("init", "-q", "--bare", str(remote))
        phone = tmp_path / "phone"
        sh("clone", "-q", str(remote), str(phone))
        (phone / "Tasks").mkdir()
        (phone / "Tasks" / "Inbox.md").write_text("# Входящие задачи\n\n- [ ] с телефона\n", encoding="utf-8")
        sh("add", "-A", cwd=phone)
        sh("commit", "-q", "-m", "init", cwd=phone)
        sh("push", "-q", "origin", "HEAD:main", cwd=phone)

        vault = tmp_path / "vault"
        gs = GitSync(vault, str(remote), token="")
        note = await gs.prepare()
        assert "скачано" in note and (vault / "Tasks" / "Inbox.md").exists()
        assert gs.branch == "main" and (vault / ".gitattributes").read_text().startswith("*.md merge=union")

        # Jarvis записал задачу → она уходит в репозиторий
        j = make_jarvis(tmp_path / "j", seed=False, vault_path=vault)
        await j.handle("добавь задачу от Jarvis завтра")
        await gs.sync()
        sh("pull", "-q", "--no-rebase", cwd=phone)
        assert "от Jarvis" in (phone / "Tasks" / "Inbox.md").read_text(encoding="utf-8")

        # одновременно: телефон и Jarvis дописали один и тот же файл — сохраняются обе строки
        inbox = phone / "Tasks" / "Inbox.md"
        inbox.write_text(inbox.read_text(encoding="utf-8") + "- [ ] ещё с телефона\n", encoding="utf-8")
        sh("commit", "-q", "-am", "phone", cwd=phone)
        sh("push", "-q", "origin", "HEAD:main", cwd=phone)
        await j.handle("добавь задачу ещё от Jarvis")
        changed = await gs.sync()
        assert "Tasks/Inbox.md" in changed
        text = (vault / "Tasks" / "Inbox.md").read_text(encoding="utf-8")
        assert "ещё с телефона" in text and "ещё от Jarvis" in text and "<<<<" not in text
        sh("pull", "-q", "--no-rebase", cwd=phone)
        assert "ещё от Jarvis" in inbox.read_text(encoding="utf-8")
        assert await gs.sync() == []
        await j.close()
    asyncio.run(run())


def test_local_vault_moves_into_empty_repo(tmp_path):
    async def run():
        remote = tmp_path / "empty.git"
        sh("init", "-q", "--bare", str(remote))
        vault = tmp_path / "vault"
        (vault / "Jarvis").mkdir(parents=True)
        (vault / "Jarvis" / "Memory.md").write_text("# Память\n\n- 2026-11-09 — люблю эспрессо\n", encoding="utf-8")
        gs = GitSync(vault, str(remote))
        assert "пуст" in await gs.prepare()
        await gs.sync()
        phone = phone_clone(remote, tmp_path / "phone")
        assert "эспрессо" in (phone / "Jarvis" / "Memory.md").read_text(encoding="utf-8")
        assert not list(tmp_path.glob("vault.local-*")), "временная копия не должна оставаться"
    asyncio.run(run())


def test_token_goes_to_header_not_config(tmp_path):
    gs = GitSync(tmp_path / "v", "https://github.com/c4erepk0/jarvis-vault.git", token="ghp_secret")
    auth = gs._auth()
    assert auth[0] == "-c" and auth[1].startswith("http.extraHeader=Authorization: Basic ")
    assert "ghp_secret" not in auth[1]
    assert GitSync(tmp_path / "v", "/local/path.git", token="x")._auth() == []
    assert _vault_git("c4erepk0/jarvis-vault") == "https://github.com/c4erepk0/jarvis-vault.git"
    assert _vault_git("https://github.com/c4erepk0/jarvis-vault.git") == "https://github.com/c4erepk0/jarvis-vault.git"


def test_tunnel_helpers(tmp_path):
    assert find_url("+--- https://quiet-river-1234.trycloudflare.com ---+", "cloudflare") == \
        "https://quiet-river-1234.trycloudflare.com"
    assert find_url("see https://admin.localhost.run/ and https://abc123.lhr.life", "localhostrun") == \
        "https://abc123.lhr.life"
    assert cloudflared_asset("Linux", "aarch64") == ("cloudflared-linux-arm64", "cloudflared")
    assert cloudflared_asset("Linux", "x86_64") == ("cloudflared-linux-amd64", "cloudflared")
    assert parse_args(["--tunnel"]).tunnel == "auto" and parse_args([]).tunnel is None

    env = tmp_path / ".env"
    cfg, created = ensure_access_code(make_config(tmp_path), env)
    assert created and len(cfg.access_code) >= 10 and f"JARVIS_ACCESS_CODE={cfg.access_code}" in env.read_text()
    cfg2, created2 = ensure_access_code(cfg, env)
    assert not created2 and cfg2.access_code == cfg.access_code


def test_requests_through_tunnel_pass_origin_check(tmp_path):
    async def run():
        j = make_jarvis(tmp_path, access_code="code-1234567", secret="s" * 32)
        async with TestClient(TestServer(build_app(j))) as c:
            h = {"Authorization": "Bearer code-1234567"}
            # Cloudflare передаёт внутренний Host, а настоящий адрес — в X-Forwarded-Host
            r = await c.post("/api/command", json={"text": "который час"}, headers={
                **h, "Origin": "https://quiet-river-1234.trycloudflare.com",
                "X-Forwarded-Host": "quiet-river-1234.trycloudflare.com"})
            assert r.status == 200
            r = await c.post("/api/command", json={"text": "который час"},
                             headers={**h, "Origin": "https://evil.example"})
            assert r.status == 403
            r = await c.post("/api/login", json={"code": "code-1234567"}, headers={"X-Forwarded-Proto": "https"})
            assert "Secure" in r.headers.get("Set-Cookie", "")
        await j.close()
    asyncio.run(run())


def test_tunnel_process_handling(tmp_path, monkeypatch):
    """Поддельный cloudflared печатает то же, что настоящий: адрес и «Registered tunnel connection»."""
    fake = tmp_path / "bin" / "cloudflared"
    fake.parent.mkdir()
    fake.write_text("#!/bin/sh\necho 'INF Requesting new quick Tunnel on trycloudflare.com...'\n"
                    "echo '|  https://quiet-river-1234.trycloudflare.com  |'\n"
                    "echo 'INF Registered tunnel connection connIndex=0'\nexec sleep 30\n")
    fake.chmod(0o755)
    monkeypatch.setenv("PATH", f"{fake.parent}:{__import__('os').environ['PATH']}")

    async def run():
        from jarvis.tunnel import Tunnel
        t = Tunnel(8765, tmp_path / "tools", ("cloudflare",), timeout=10)
        url = await t.start()
        assert url == "https://quiet-river-1234.trycloudflare.com" and t.alive
        await t.stop()
        assert not t.alive
        assert "Registered tunnel connection" in (tmp_path / "tools" / "tunnel.log").read_text()
    asyncio.run(run())


def test_tunnel_failure_reason_and_watchdog(tmp_path, monkeypatch, capsys):
    """Туннель умер после выдачи адреса (как «no tunnel» у localhost.run) — сторож поднимает новый
    и сообщает ссылку; при отказе видна причина из вывода туннеля."""
    import os
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    counter = tmp_path / "n"
    fake = bin_dir / "cloudflared"
    # первый запуск — сразу умирает после адреса, второй — живёт
    fake.write_text(f"#!/bin/sh\nn=$(cat {counter} 2>/dev/null || echo 0); n=$((n+1)); echo $n > {counter}\n"
                    "echo \"|  https://river-$n.trycloudflare.com  |\"\n"
                    "echo 'INF Registered tunnel connection connIndex=0'\n"
                    "[ $n -eq 1 ] && exit 0\nexec sleep 30\n")
    fake.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}:{os.environ['PATH']}")

    async def run():
        from jarvis.tunnel import Tunnel
        t = Tunnel(8765, tmp_path / "tools", ("cloudflare",), timeout=10)
        assert await t.start() == "https://river-1.trycloudflare.com"
        await asyncio.sleep(0.3)
        assert not t.alive
        got = []

        async def on_url(u):
            got.append(u)
        watch = asyncio.create_task(t.watch(on_url, interval=0.05))
        for _ in range(100):
            if got:
                break
            await asyncio.sleep(0.05)
        watch.cancel()
        assert got == ["https://river-2.trycloudflare.com"] and t.alive
        await t.stop()

        broken = bin_dir / "cloudflared"
        broken.write_text("#!/bin/sh\necho 'ERR failed to request quick Tunnel: 429 Too Many Requests'\nexit 1\n")
        t2 = Tunnel(8765, tmp_path / "tools", ("cloudflare",), timeout=5)
        assert await t2.start() is None
    asyncio.run(run())
    assert "429 Too Many Requests" in capsys.readouterr().out


def test_tunnel_banner():
    from jarvis.__main__ import banner
    text = banner("https://abc.lhr.life", "code123", again=True)
    assert "https://abc.lhr.life" in text and "code123" in text and "сменилась" in text
