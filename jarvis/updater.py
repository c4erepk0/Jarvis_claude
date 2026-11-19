"""Обновления Atom с GitHub — приложение «Настройки и диагностика».

Atom установлен клоном репозитория (scripts/vps.sh, start.sh): обновление — это `git fetch` и перемотка вперёд
(`merge --ff-only`) на свежий коммит той же ветки, а если поменялся requirements.txt — ещё и `pip install`.
После обновления Atom перезапускается (в той же службе systemd — тем же процессом, os.execv).

Ручное обновление владелец подтверждает (ask_confirm), автоматическое он включает сам в настройках: тогда Atom
раз в N часов проверяет ветку и обновляется, если есть новое. Локальные правки в коде не затираются — обновление
откажется и скажет почему. Токен GitHub (для приватного форка) передаётся заголовком, как в gitsync.py.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import shutil
import sys
import time
from pathlib import Path

log = logging.getLogger("jarvis.update")
ROOT = Path(__file__).resolve().parent.parent


class UpdateError(RuntimeError):
    pass


class Updater:
    def __init__(self, root: Path = ROOT, token: str = "", branch: str = ""):
        self.root = Path(root)
        self.token = token.strip()
        self.branch = branch.strip()
        self.last_check: dict | None = None
        self.busy = False

    @property
    def available(self) -> bool:
        return (self.root / ".git").exists() and bool(shutil.which("git"))

    def _auth(self, remote: str) -> list[str]:
        if not self.token or not remote.startswith("https://github.com/"):
            return []
        basic = base64.b64encode(f"x-access-token:{self.token}".encode()).decode()
        return ["-c", f"http.extraHeader=Authorization: Basic {basic}"]

    async def git(self, *args: str, check: bool = True, auth: str = "", timeout: float = 120) -> str:
        proc = await asyncio.create_subprocess_exec(
            "git", *self._auth(auth), *args, cwd=str(self.root), stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT, env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"})
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise UpdateError(f"git {args[0]}: нет ответа за {int(timeout)} с") from None
        text = out.decode("utf-8", "replace").strip()
        if self.token:
            text = text.replace(self.token, "***")
        if check and proc.returncode != 0:
            raise UpdateError(text or f"git {args[0]}: ошибка {proc.returncode}")
        return text

    async def current_branch(self) -> str:
        if self.branch:
            return self.branch
        return await self.git("rev-parse", "--abbrev-ref", "HEAD")

    async def status(self) -> dict:
        """Какая версия запущена: ветка, коммит, когда."""
        if not self.available:
            return {"git": False, "reason": "Atom запущен не из клона git-репозитория — обновляйте вручную"}
        line = await self.git("log", "-1", "--format=%h%x1f%s%x1f%cI")
        sha, subject, when = (line.split("\x1f") + ["", "", ""])[:3]
        dirty = [ln for ln in (await self.git("status", "--porcelain", "--untracked-files=no")).splitlines() if ln]
        return {"git": True, "branch": await self.current_branch(), "commit": sha, "subject": subject, "date": when,
                "dirty": len(dirty), "last_check": self.last_check}

    async def check(self) -> dict:
        """Есть ли новое на GitHub: сколько коммитов и какие."""
        if not self.available:
            raise UpdateError("Atom запущен не из клона git-репозитория")
        branch = await self.current_branch()
        remote = await self.git("remote", "get-url", "origin", check=False)
        await self.git("fetch", "--quiet", "origin", branch, auth=remote)
        behind = int(await self.git("rev-list", "--count", "HEAD..FETCH_HEAD") or 0)
        ahead = int(await self.git("rev-list", "--count", "FETCH_HEAD..HEAD") or 0)
        commits = []
        if behind:
            for ln in (await self.git("log", "--format=%h%x1f%s%x1f%cI", "-n", "15", "HEAD..FETCH_HEAD")).splitlines():
                sha, subject, when = (ln.split("\x1f") + ["", "", ""])[:3]
                commits.append({"commit": sha, "subject": subject, "date": when})
        self.last_check = {"at": int(time.time()), "branch": branch, "behind": behind, "ahead": ahead,
                           "commits": commits, "remote": await self.git("rev-parse", "--short", "FETCH_HEAD")}
        return self.last_check

    async def apply(self) -> dict:
        """Перемотать на свежий коммит. Возвращает {updated, from, to, deps}; перезапуск — за вызывающим."""
        if self.busy:
            raise UpdateError("обновление уже идёт")
        self.busy = True
        try:
            info = await self.check()
            if not info["behind"]:
                return {"updated": False, "reason": "уже последняя версия"}
            if (await self.status())["dirty"]:
                raise UpdateError("в коде Atom есть локальные правки — обновите вручную (git stash / git pull)")
            if info["ahead"]:
                raise UpdateError("в этой копии есть свои коммиты, которых нет на GitHub — обновите вручную")
            old = await self.git("rev-parse", "--short", "HEAD")
            changed = (await self.git("diff", "--name-only", "HEAD", "FETCH_HEAD")).splitlines()
            await self.git("merge", "--ff-only", "--quiet", "FETCH_HEAD")
            deps = "requirements.txt" in changed
            if deps:
                await self.pip_install()
            new = await self.git("rev-parse", "--short", "HEAD")
            log.info("Atom обновлён: %s → %s", old, new)
            return {"updated": True, "from": old, "to": new, "deps": deps, "commits": info["commits"]}
        finally:
            self.busy = False

    async def pip_install(self) -> None:
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "pip", "install", "-q", "-r", str(self.root / "requirements.txt"),
            cwd=str(self.root), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), 900)
        except asyncio.TimeoutError:
            proc.kill()
            raise UpdateError("pip install: нет ответа за 15 минут") from None
        if proc.returncode != 0:
            raise UpdateError("не удалось поставить зависимости:\n" + out.decode("utf-8", "replace")[-1500:])


def restart_argv() -> list[str]:
    """Чем перезапуститься: тот же интерпретатор, `-m jarvis` и те же флаги (--tunnel…)."""
    return [sys.executable, "-m", "jarvis", *sys.argv[1:]]
