"""Минимальный клиент GitHub REST API (aiohttp) — статус проектов, задачи для @claude, деплой."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import aiohttp

log = logging.getLogger("jarvis.github")


class GitHubError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(f"GitHub {status}: {message}")
        self.status = status


class GitHub:
    def __init__(self, token: str = "", base_url: str = "https://api.github.com", cache_ttl: float = 60):
        self.token = token
        self.base = base_url.rstrip("/")
        self.cache_ttl = cache_ttl
        self._cache: dict[str, tuple[float, Any]] = {}
        self._session: aiohttp.ClientSession | None = None

    async def session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
                       "User-Agent": "jarvis-dashboard"}
            if self.token:
                headers["Authorization"] = f"Bearer {self.token}"
            self._session = aiohttp.ClientSession(headers=headers, timeout=aiohttp.ClientTimeout(total=20),
                                                  trust_env=True)
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def request(self, method: str, path: str, *, json: dict | None = None,
                      params: dict | None = None, cache: bool = False) -> Any:
        key = f"{path}?{sorted((params or {}).items())}"
        if cache and method == "GET":
            hit = self._cache.get(key)
            if hit and time.monotonic() - hit[0] < self.cache_ttl:
                return hit[1]
        s = await self.session()
        async with s.request(method, self.base + path, json=json, params=params) as r:
            if r.status == 204:
                data: Any = None
            else:
                data = await r.json(content_type=None) if r.content_length != 0 else None
            if r.status >= 400:
                msg = data.get("message") if isinstance(data, dict) else str(data)
                raise GitHubError(r.status, msg or r.reason or "ошибка")
        if cache and method == "GET":
            self._cache[key] = (time.monotonic(), data)
        return data

    def invalidate(self, repo: str) -> None:
        for k in [k for k in self._cache if k.startswith(f"/repos/{repo}")]:
            self._cache.pop(k, None)

    # ---------- чтение ----------
    async def repo_status(self, repo: str) -> dict:
        info = await self.request("GET", f"/repos/{repo}", cache=True)
        branch = info.get("default_branch", "main")
        commits, runs, pulls, issues = await asyncio.gather(
            self.request("GET", f"/repos/{repo}/commits", params={"sha": branch, "per_page": 1}, cache=True),
            self.request("GET", f"/repos/{repo}/actions/runs", params={"branch": branch, "per_page": 30},
                         cache=True),
            self.request("GET", f"/repos/{repo}/pulls", params={"state": "open", "per_page": 10}, cache=True),
            self.request("GET", f"/repos/{repo}/issues", params={"state": "open", "per_page": 20}, cache=True),
            return_exceptions=True,
        )
        out: dict[str, Any] = {
            "repo": repo, "url": info.get("html_url"), "branch": branch, "private": info.get("private"),
            "pushed_at": info.get("pushed_at"), "stars": info.get("stargazers_count", 0),
        }
        if isinstance(commits, list) and commits:
            c = commits[0]
            out["last_commit"] = {
                "sha": c.get("sha", "")[:7],
                "message": (c.get("commit", {}).get("message") or "").splitlines()[0][:120],
                "author": (c.get("commit", {}).get("author") or {}).get("name"),
                "date": (c.get("commit", {}).get("author") or {}).get("date"),
                "url": c.get("html_url"),
            }
        if isinstance(runs, dict):
            ci = self._ci_from_runs(runs.get("workflow_runs") or [])
            if ci:
                out["ci"] = ci
        if isinstance(pulls, list):
            out["pulls"] = [{"number": p["number"], "title": p["title"], "draft": p.get("draft", False),
                             "url": p.get("html_url"), "user": (p.get("user") or {}).get("login")} for p in pulls]
        if isinstance(issues, list):
            only_issues = [i for i in issues if "pull_request" not in i]
            out["issues"] = [{"number": i["number"], "title": i["title"], "url": i.get("html_url"),
                              "labels": [lb.get("name") for lb in i.get("labels", [])]} for i in only_issues]
        return out

    @staticmethod
    def _ci_from_runs(runs: list[dict]) -> dict | None:
        """Последний запуск «главного» workflow (CI, если есть), иначе самый свежий."""
        if not runs:
            return None
        meaningful = [r for r in runs if r.get("conclusion") not in ("skipped", "neutral")] or runs
        preferred = [r for r in meaningful if (r.get("name") or "").lower() in ("ci", "tests", "test", "build")]
        run = (preferred or meaningful)[0]
        return {"id": run.get("id"), "name": run.get("name"), "status": run.get("status"),
                "conclusion": run.get("conclusion"), "url": run.get("html_url"),
                "event": run.get("event"), "created_at": run.get("created_at"),
                "title": run.get("display_title")}

    # ---------- действия ----------
    async def create_issue(self, repo: str, title: str, body: str, labels: list[str] | None = None) -> dict:
        payload: dict[str, Any] = {"title": title, "body": body}
        if labels:
            payload["labels"] = labels
        data = await self.request("POST", f"/repos/{repo}/issues", json=payload)
        self.invalidate(repo)
        return {"number": data.get("number"), "url": data.get("html_url"), "title": data.get("title")}

    async def dispatch_workflow(self, repo: str, workflow: str, ref: str | None = None,
                                inputs: dict | None = None) -> None:
        if not ref:
            info = await self.request("GET", f"/repos/{repo}", cache=True)
            ref = info.get("default_branch", "main")
        payload: dict[str, Any] = {"ref": ref}
        if inputs:
            payload["inputs"] = inputs
        await self.request("POST", f"/repos/{repo}/actions/workflows/{workflow}/dispatches", json=payload)
        self.invalidate(repo)
