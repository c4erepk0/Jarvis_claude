"""Бесплатный HTTPS-туннель — чтобы Jarvis, запущенный в терминале (на сервере, в облаке или в
Linux-приложении на iPhone), открывался в Safari по обычной https-ссылке. Без регистрации:
сначала Cloudflare Quick Tunnel (cloudflared скачивается сам), если не вышло — localhost.run,
затем pinggy (оба через ssh). HTTPS нужен ещё и для микрофона в Safari.
"""
from __future__ import annotations

import asyncio
import logging
import os
import platform
import re
import shutil
import stat
import tarfile
import urllib.request
from pathlib import Path

log = logging.getLogger("jarvis.tunnel")
CF_BASE = "https://github.com/cloudflare/cloudflared/releases/latest/download/"
PATTERNS = {
    "cloudflare": re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com"),
    "localhostrun": re.compile(r"https://[a-z0-9-]+\.lhr\.life"),
    "pinggy": re.compile(r"https://[a-z0-9.-]+\.free\.pinggy\.(?:link|online|net)"),
}
# служебные адреса из вывода туннелей (admin.localhost.run, dashboard.pinggy.io…) — не наш сайт
SERVICE_HOSTS = {"admin", "api", "dashboard", "www", "docs", "app"}
SSH_OPTS = ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "ServerAliveInterval=30",
            "-o", "ExitOnForwardFailure=yes", "-T"]
ORDER = ("cloudflare", "localhostrun", "pinggy")


def cloudflared_asset(system: str | None = None, machine: str | None = None) -> tuple[str, str]:
    system = system or platform.system()
    machine = (machine or platform.machine()).lower()
    if system == "Windows":
        return "cloudflared-windows-amd64.exe", "cloudflared.exe"
    if system == "Darwin":
        return ("cloudflared-darwin-arm64.tgz" if machine in ("arm64", "aarch64") else "cloudflared-darwin-amd64.tgz",
                "cloudflared")
    if machine in ("arm64", "aarch64"):
        return "cloudflared-linux-arm64", "cloudflared"
    if machine.startswith("arm"):
        return "cloudflared-linux-arm", "cloudflared"
    if machine in ("i386", "i686", "x86"):
        return "cloudflared-linux-386", "cloudflared"
    return "cloudflared-linux-amd64", "cloudflared"


def ensure_cloudflared(tools: Path) -> str:
    found = shutil.which("cloudflared")
    if found:
        return found
    asset, local = cloudflared_asset()
    path = tools / local
    if path.exists():
        return str(path)
    tools.mkdir(parents=True, exist_ok=True)
    print(f"⬇️  Скачиваю cloudflared ({asset})…", flush=True)
    tmp = tools / asset
    urllib.request.urlretrieve(CF_BASE + asset, tmp)  # noqa: S310 — фиксированный адрес релизов Cloudflare
    if asset.endswith(".tgz"):
        with tarfile.open(tmp) as tar:
            member = next(m for m in tar.getmembers() if m.name.endswith("cloudflared"))
            member.name = local
            tar.extract(member, tools)
        tmp.unlink()
    else:
        os.replace(tmp, path)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return str(path)


def find_url(line: str, name: str) -> str | None:
    for m in PATTERNS[name].finditer(line):
        if m.group(0).split("://", 1)[1].split(".", 1)[0] not in SERVICE_HOSTS:
            return m.group(0)
    return None


def command(name: str, port: int, tools: Path) -> list[str]:
    if name == "cloudflare":
        return [ensure_cloudflared(tools), "tunnel", "--no-autoupdate", "--protocol", "http2",
                "--url", f"http://127.0.0.1:{port}"]
    if name == "localhostrun":
        return ["ssh", *SSH_OPTS, "-R", f"80:127.0.0.1:{port}", "nokey@localhost.run"]
    if name == "pinggy":
        return ["ssh", *SSH_OPTS, "-p", "443", "-R", f"0:127.0.0.1:{port}", "a.pinggy.io"]
    raise ValueError(f"неизвестный туннель {name}")


class Tunnel:
    def __init__(self, port: int, tools: Path, order: tuple[str, ...] = ORDER, timeout: float = 60):
        self.port, self.tools, self.order, self.timeout = port, Path(tools), order, timeout
        self.proc: asyncio.subprocess.Process | None = None
        self.url: str | None = None
        self.name: str | None = None
        self._drain: asyncio.Task | None = None

    async def start(self) -> str | None:
        loop = asyncio.get_running_loop()
        for name in self.order:
            print(f"🌐 Поднимаю туннель: {name}…", flush=True)
            try:
                cmd = await loop.run_in_executor(None, command, name, self.port, self.tools)
                proc = await asyncio.create_subprocess_exec(
                    *cmd, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT)
            except (OSError, ValueError) as e:
                print(f"   ⚠️  {name} недоступен: {e}", flush=True)
                continue
            url = await self._wait_url(proc, name)
            if url:
                self.proc, self.url, self.name = proc, url, name
                self._drain = asyncio.create_task(self._pump(proc))
                return url
            if proc.returncode is None:
                proc.terminate()
            print(f"   ❌ {name} не поднялся.", flush=True)
        return None

    async def _wait_url(self, proc, name: str) -> str | None:
        url = None
        ready = name != "cloudflare"
        log_path = self.tools / "tunnel.log"
        self.tools.mkdir(parents=True, exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as logf:
            async def read():
                nonlocal url, ready
                while True:
                    raw = await proc.stdout.readline()
                    if not raw:
                        return
                    line = raw.decode("utf-8", "replace")
                    logf.write(line)
                    url = url or find_url(line, name)
                    if "Registered tunnel connection" in line:
                        ready = True
                    if url and ready:
                        return
            try:
                await asyncio.wait_for(read(), self.timeout)
            except asyncio.TimeoutError:
                return None
        return url if url and ready else None

    async def _pump(self, proc) -> None:
        with open(self.tools / "tunnel.log", "a", encoding="utf-8") as logf:
            while proc.stdout and (raw := await proc.stdout.readline()):
                logf.write(raw.decode("utf-8", "replace"))
                logf.flush()

    @property
    def alive(self) -> bool:
        return bool(self.proc and self.proc.returncode is None)

    async def stop(self) -> None:
        if self.proc and self.proc.returncode is None:
            self.proc.terminate()
            try:
                await asyncio.wait_for(self.proc.wait(), 5)
            except asyncio.TimeoutError:
                self.proc.kill()
        if self._drain:
            self._drain.cancel()
