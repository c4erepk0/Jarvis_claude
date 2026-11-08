"""Проекты: заметки `Projects/*.md` + живой статус (GitHub, CI, health, метрики) + работа над кодом.

Заметка проекта начинается с полей:

    ---
    type: project
    repo: c4erepk0/IPAStore        # GitHub — CI, задачи, PR, деплой
    path: ~/IPAStore               # локальная копия — для запуска Claude Code на этой машине
    tag: ipastore                  # задачи с #ipastore относятся к проекту
    health: https://…/health       # проверка «живой ли сервис»
    stats_url: https://…/api/jarvis/stats
    stats_token_env: IPASTORE_JARVIS_TOKEN
    deploy_workflow: deploy.yml
    ---

Работа над проектом («Джарвис, поручи IPAStore …») — два режима:
- `github`: Jarvis создаёт задачу в репозитории с упоминанием @claude — её берёт workflow
  claude-code-action (в IPAStore он уже настроен) и открывает PR;
- `local`: Jarvis запускает Claude Code (`claude -p`) в папке проекта на этом компьютере
  и транслирует ход работы на дашборд.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Callable

import aiohttp

from .github import GitHub, GitHubError
from .vault import Vault, parse_frontmatter

log = logging.getLogger("jarvis.projects")
Emit = Callable[[str, dict], Awaitable[None]]


def _s(meta: dict, key: str) -> str:
    v = meta.get(key)
    if v is None or v == [] or v is False:
        return ""
    return str(v).strip()


@dataclass
class Project:
    name: str
    note: str
    status: str = "active"
    repo: str = ""
    path: str = ""
    tag: str = ""
    health: str = ""
    stats_url: str = ""
    stats_token_env: str = ""
    deploy_workflow: str = ""
    url: str = ""
    description: str = ""

    def as_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items()}


@dataclass
class Job:
    id: str
    project: str
    prompt: str
    mode: str
    status: str = "running"         # running | done | error | cancelled
    started: float = field(default_factory=time.time)
    finished: float | None = None
    output: list[str] = field(default_factory=list)
    result: str = ""
    cost_usd: float | None = None
    url: str = ""
    proc: Any = None

    def as_dict(self) -> dict:
        return {"id": self.id, "project": self.project, "prompt": self.prompt, "mode": self.mode,
                "status": self.status, "started": self.started, "finished": self.finished,
                "output": self.output[-60:], "result": self.result, "cost_usd": self.cost_usd, "url": self.url}


class Projects:
    def __init__(self, vault: Vault, folder: str, github: GitHub, *, claude_bin: str = "claude",
                 permission_mode: str = "acceptEdits", allowed_tools: str = ""):
        self.vault = vault
        self.folder = folder.strip("/")
        self.github = github
        self.claude_bin = claude_bin
        self.permission_mode = permission_mode
        self.allowed_tools = allowed_tools
        self.jobs: dict[str, Job] = {}
        self._health_cache: dict[str, tuple[float, dict]] = {}
        self._http: aiohttp.ClientSession | None = None

    async def close(self) -> None:
        for job in self.jobs.values():
            if job.proc and job.proc.returncode is None:
                job.proc.kill()
        if self._http and not self._http.closed:
            await self._http.close()

    async def http(self) -> aiohttp.ClientSession:
        if self._http is None or self._http.closed:
            self._http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10), trust_env=True)
        return self._http

    # ---------- заметки ----------
    def list(self) -> list[Project]:
        out = []
        for rel in self.vault.list_files(self.folder):
            try:
                meta, body = parse_frontmatter(self.vault.read(rel))
            except OSError:
                continue
            if meta.get("type") not in ("project", None) or (not meta and "/" in rel[len(self.folder) + 1:]):
                continue
            name = Path(rel).stem
            desc = next((ln.strip() for ln in body.splitlines()
                         if ln.strip() and not ln.startswith(("#", "-", "|", ">"))), "")
            out.append(Project(
                name=name, note=rel, status=_s(meta, "status") or "active", repo=_s(meta, "repo"),
                path=_s(meta, "path"), tag=(_s(meta, "tag") or name).lower(), health=_s(meta, "health"),
                stats_url=_s(meta, "stats_url"), stats_token_env=_s(meta, "stats_token_env"),
                deploy_workflow=_s(meta, "deploy_workflow"), url=_s(meta, "url"), description=desc[:200],
            ))
        return out

    def get(self, name: str) -> Project | None:
        key = name.lower().strip()
        projects = self.list()
        exact = next((p for p in projects if p.name.lower() == key or p.tag == key), None)
        if exact:
            return exact
        return next((p for p in projects if key and (key in p.name.lower() or p.name.lower() in key)), None)

    def log(self, project: Project, text: str, when: datetime) -> None:
        self.vault.append_to_section(project.note, "Журнал", f"- {when:%Y-%m-%d %H:%M} {text}")

    # ---------- статус ----------
    async def check_health(self, project: Project) -> dict | None:
        if not project.health:
            return None
        hit = self._health_cache.get(project.health)
        if hit and time.monotonic() - hit[0] < 30:
            return hit[1]
        t0 = time.monotonic()
        try:
            s = await self.http()
            async with s.get(project.health) as r:
                res = {"ok": 200 <= r.status < 300, "status": r.status,
                       "latency_ms": round((time.monotonic() - t0) * 1000)}
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            res = {"ok": False, "status": None, "error": type(e).__name__, "latency_ms": None}
        self._health_cache[project.health] = (time.monotonic(), res)
        return res

    async def fetch_stats(self, project: Project) -> dict | None:
        if not project.stats_url:
            return None
        token = os.getenv(project.stats_token_env, "") if project.stats_token_env else ""
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            s = await self.http()
            async with s.get(project.stats_url, headers=headers) as r:
                if r.status != 200:
                    return {"error": f"HTTP {r.status}"}
                data = await r.json(content_type=None)
                return data if isinstance(data, dict) else {"error": "неожиданный ответ"}
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as e:
            return {"error": type(e).__name__}

    async def status(self, project: Project) -> dict:
        out: dict[str, Any] = {**project.as_dict()}
        gh_coro = self.github.repo_status(project.repo) if project.repo else asyncio.sleep(0, None)
        gh, health, stats = await asyncio.gather(gh_coro, self.check_health(project), self.fetch_stats(project),
                                                 return_exceptions=True)
        if isinstance(gh, GitHubError):
            out["github_error"] = ("нет доступа — задайте GITHUB_TOKEN" if gh.status in (401, 403, 404)
                                   else str(gh))
        elif isinstance(gh, Exception):
            out["github_error"] = f"GitHub недоступен: {type(gh).__name__}"
        elif gh:
            out["github"] = gh
        out["health"] = health if not isinstance(health, Exception) else {"ok": False, "error": str(health)}
        out["stats"] = stats if not isinstance(stats, Exception) else None
        out["jobs"] = [j.as_dict() for j in self.jobs.values() if j.project == project.name][-3:]
        return out

    async def status_all(self) -> list[dict]:
        return list(await asyncio.gather(*(self.status(p) for p in self.list())))

    # ---------- работа над проектом ----------
    async def delegate_github(self, project: Project, task: str, when: datetime) -> dict:
        if not project.repo:
            raise ValueError(f"у проекта {project.name} не указан repo")
        title = task.strip().splitlines()[0][:90]
        body = (f"{task.strip()}\n\n---\n@claude возьми эту задачу: следуй CLAUDE.md, прогони проверки и "
                f"открой PR с описанием на русском.\n\n_Поручено через Jarvis {when:%Y-%m-%d %H:%M}._")
        issue = await self.github.create_issue(project.repo, title, body)
        self.log(project, f"Поручено @claude: [#{issue['number']} {title}]({issue['url']})", when)
        return issue

    async def deploy(self, project: Project, when: datetime) -> dict:
        if not (project.repo and project.deploy_workflow):
            raise ValueError(f"у проекта {project.name} не настроен deploy_workflow")
        await self.github.dispatch_workflow(project.repo, project.deploy_workflow)
        self.log(project, f"Запущен деплой ({project.deploy_workflow})", when)
        url = f"https://github.com/{project.repo}/actions/workflows/{project.deploy_workflow}"
        return {"ok": True, "url": url}

    def can_run_local(self, project: Project) -> str | None:
        """Причина, по которой локальный запуск невозможен, или None."""
        if not project.path:
            return f"у проекта {project.name} не указан path (папка с кодом)"
        if not Path(project.path).expanduser().is_dir():
            return f"папка {project.path} не найдена на этом компьютере"
        if not shutil.which(self.claude_bin):
            return "Claude Code не установлен (npm i -g @anthropic-ai/claude-code) или не найден CLAUDE_CODE_BIN"
        return None

    def local_command(self, prompt: str) -> list[str]:
        cmd = [self.claude_bin, "-p", prompt, "--output-format", "stream-json", "--verbose",
               "--permission-mode", self.permission_mode]
        if self.allowed_tools:
            cmd += ["--allowedTools", self.allowed_tools]
        return cmd

    async def start_local(self, project: Project, task: str, when: datetime, emit: Emit) -> Job:
        reason = self.can_run_local(project)
        if reason:
            raise ValueError(reason)
        slug = re.sub(r"[^a-z0-9]+", "-", task.lower())[:30].strip("-") or "task"
        prompt = (f"Задача от владельца проекта (через Jarvis): {task.strip()}\n\n"
                  f"Сначала создай ветку jarvis/{slug}-{when:%m%d%H%M}. Выполни задачу, следуя CLAUDE.md, "
                  f"прогони проверки проекта и сделай коммит. Не делай push. В конце — короткий отчёт на русском.")
        job = Job(id=uuid.uuid4().hex[:8], project=project.name, prompt=task.strip(), mode="local")
        self.jobs[job.id] = job
        proc = await asyncio.create_subprocess_exec(
            *self.local_command(prompt), cwd=str(Path(project.path).expanduser()),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, stdin=asyncio.subprocess.DEVNULL,
        )
        job.proc = proc
        self.log(project, f"Claude Code (локально) начал: {task.strip()[:120]}", when)
        asyncio.create_task(self._pump(job, project, emit))
        return job

    async def _pump(self, job: Job, project: Project, emit: Emit) -> None:
        proc = job.proc
        assert proc and proc.stdout
        try:
            async for raw in proc.stdout:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                text = self._describe_event(line, job)
                if text:
                    job.output.append(text)
                    await emit("workshop", {"job": job.id, "project": job.project, "text": text})
            await proc.wait()
            err = (await proc.stderr.read()).decode("utf-8", "replace")[-800:] if proc.stderr else ""
            if job.status == "running":
                job.status = "done" if proc.returncode == 0 else "error"
            if job.status == "error" and not job.result:
                job.result = err.strip() or f"код выхода {proc.returncode}"
        except Exception as e:  # noqa: BLE001
            job.status, job.result = "error", str(e)
        job.finished = time.time()
        when = datetime.now()
        try:
            self.log(project, f"Claude Code: {job.status} — {job.result[:200]}", when)
        except Exception:  # noqa: BLE001
            log.exception("не удалось записать журнал проекта")
        await emit("job", job.as_dict())

    @staticmethod
    def _describe_event(line: str, job: Job) -> str:
        try:
            ev = json.loads(line)
        except ValueError:
            return line[:300]
        kind = ev.get("type")
        if kind == "assistant":
            parts = []
            for block in (ev.get("message") or {}).get("content") or []:
                if block.get("type") == "text" and block.get("text", "").strip():
                    parts.append(block["text"].strip())
                elif block.get("type") == "tool_use":
                    inp = block.get("input") or {}
                    target = inp.get("file_path") or inp.get("command") or inp.get("pattern") or ""
                    parts.append(f"⚙ {block.get('name')} {str(target)[:120]}".strip())
            return "\n".join(parts)[:600]
        if kind == "result":
            job.result = str(ev.get("result") or "")[:4000]
            job.cost_usd = ev.get("total_cost_usd")
            job.status = "error" if ev.get("is_error") else "done"
            return "✓ Готово" if job.status == "done" else "✗ Ошибка"
        return ""

    def cancel(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job or job.status != "running" or not job.proc:
            return False
        job.status = "cancelled"
        job.proc.terminate()
        return True
