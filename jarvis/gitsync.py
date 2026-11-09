"""Хранилище Obsidian в GitHub-репозитории — для серверного Jarvis.

Тот же приватный репозиторий, что использует Obsidian на iPhone (плагин Obsidian Git) и Jarvis для
iPhone: при старте Jarvis скачивает хранилище (`git clone`), а потом каждые ~20 секунд забирает
правки с телефона и отправляет свои. Заметки сливаются построчно (`*.md merge=union`): задача,
дописанная на телефоне, и трата, записанная Jarvis в тот же файл, сохраняются обе.

Токен не пишется в .git/config — он передаётся каждой команде git через заголовок.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import shutil
import time
from pathlib import Path

log = logging.getLogger("jarvis.git")
ATTRIBUTES = "*.md merge=union\n*.txt merge=union\n"


class GitSyncError(RuntimeError):
    pass


class GitSync:
    def __init__(self, path: Path, remote: str, token: str = "", interval: float = 20):
        self.path = Path(path).expanduser()
        self.remote = remote.strip()
        self.token = token.strip()
        self.interval = max(5.0, interval)
        self.branch = "main"
        self.last_error: str | None = None
        self.last_sync: float | None = None

    # ---------- git ----------
    def _auth(self) -> list[str]:
        if not self.token or not self.remote.startswith("https://"):
            return []
        basic = base64.b64encode(f"x-access-token:{self.token}".encode()).decode()
        return ["-c", f"http.extraHeader=Authorization: Basic {basic}"]

    async def git(self, *args: str, cwd: Path | None = None, check: bool = True) -> tuple[int, str]:
        if not shutil.which("git"):
            raise GitSyncError("git не установлен (apt install git)")
        proc = await asyncio.create_subprocess_exec(
            "git", *self._auth(), *args, cwd=str(cwd or self.path),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"})
        out, _ = await proc.communicate()
        text = out.decode("utf-8", "replace").strip()
        if check and proc.returncode != 0:
            # не показываем токен даже случайно
            raise GitSyncError(text.replace(self.token, "***") if self.token else text)
        return proc.returncode, text

    async def _has_commits(self) -> bool:
        code, _ = await self.git("rev-parse", "--verify", "HEAD", check=False)
        return code == 0

    async def _remote_branch(self) -> str | None:
        code, out = await self.git("ls-remote", "--symref", "origin", "HEAD", check=False)
        for line in out.splitlines():
            if line.startswith("ref: refs/heads/"):
                return line.split("refs/heads/", 1)[1].split()[0]
        return None

    # ---------- подготовка ----------
    async def prepare(self) -> str:
        """Скачивает хранилище из репозитория. Возвращает, что сделано (для лога)."""
        if (self.path / ".git").is_dir():
            await self.git("remote", "set-url", "origin", self.remote, check=False)
            code, out = await self.git("symbolic-ref", "--short", "HEAD", check=False)
            if code == 0:
                self.branch = out
            note = "хранилище уже связано с репозиторием"
        else:
            backup = None
            if self.path.exists() and any(self.path.iterdir()):
                backup = self.path.with_name(f"{self.path.name}.local-{time.strftime('%Y%m%d-%H%M%S')}")
                self.path.rename(backup)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            await self.git("clone", "--quiet", self.remote, str(self.path), cwd=self.path.parent)
            if await self._has_commits():
                code, out = await self.git("symbolic-ref", "--short", "HEAD", check=False)
                self.branch = out if code == 0 else "main"
                note = f"хранилище скачано из {self.remote}"
                if backup:
                    note += f"; прежняя локальная папка сохранена как {backup.name}"
            else:
                # пустой репозиторий — переносим туда то, что было локально (или Jarvis засеет шаблон)
                await self.git("checkout", "-q", "-b", "main", check=False)
                self.branch = "main"
                if backup:
                    for item in backup.iterdir():
                        if item.name != ".git":
                            shutil.move(str(item), str(self.path / item.name))
                    backup.rmdir()
                note = "репозиторий пуст — хранилище будет отправлено в него"
        await self.git("config", "user.name", "Jarvis")
        await self.git("config", "user.email", "jarvis@users.noreply.github.com")
        await self.git("config", "pull.rebase", "false")
        attrs = self.path / ".gitattributes"
        if not attrs.exists():
            attrs.write_text(ATTRIBUTES, encoding="utf-8")
        return note

    # ---------- синхронизация ----------
    async def sync(self) -> list[str]:
        """Свои изменения → коммит; правки с телефона ← слияние; → push. Возвращает пришедшие файлы."""
        await self.git("add", "-A")
        code, _ = await self.git("diff", "--cached", "--quiet", check=False)
        if code == 1:
            _, names = await self.git("diff", "--cached", "--name-only")
            files = [n for n in names.splitlines() if n][:3]
            await self.git("commit", "-q", "-m", "Jarvis: " + ", ".join(files))
        changed: list[str] = []
        remote_branch = await self._remote_branch()
        if remote_branch:
            self.branch = remote_branch
            await self.git("fetch", "-q", "origin", remote_branch)
            target = f"origin/{remote_branch}"
            if not await self._has_commits():
                await self.git("reset", "-q", "--hard", target)
                _, files = await self.git("ls-files")
                changed = files.splitlines()
            else:
                _, before = await self.git("rev-parse", "HEAD")
                code, _ = await self.git("merge", "--no-edit", "-q", target, check=False)
                if code != 0:
                    # конфликт в не-markdown файле (заметки сливаются построчно): оставляем свою версию
                    await self.git("merge", "--abort", check=False)
                    await self.git("merge", "--no-edit", "-q", "-X", "ours", target)
                _, diff = await self.git("diff", "--name-only", before, "HEAD")
                changed = [d for d in diff.splitlines() if d]
        if await self._has_commits():
            code, ahead = await self.git("rev-list", "--count", f"origin/{self.branch}..HEAD", check=False)
            if code != 0 or ahead.strip() != "0":
                await self.git("push", "-q", "origin", f"HEAD:{self.branch}")
        self.last_sync = time.time()
        self.last_error = None
        return changed

    async def loop(self, on_change=None) -> None:
        while True:
            await asyncio.sleep(self.interval)
            try:
                changed = await self.sync()
                if changed and on_change:
                    await on_change(changed)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 — нет сети и т.п.: попробуем на следующем круге
                if str(e) != self.last_error:
                    log.warning("синхронизация хранилища с GitHub не удалась: %s", e)
                self.last_error = str(e)
