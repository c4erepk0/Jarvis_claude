"""Проекты: статус из GitHub (фейковый сервер), задача для @claude и деплой — только после подтверждения."""
import asyncio

from aiohttp import web
from aiohttp.test_utils import TestServer

from jarvis.core import project_line
from jarvis.github import GitHub

from .conftest import make_jarvis


def fake_github():
    calls = []

    async def repo(request):
        return web.json_response({"html_url": "https://github.com/c4erepk0/IPAStore", "default_branch": "main",
                                  "private": True, "pushed_at": "2026-11-08T20:00:00Z", "stargazers_count": 1})

    async def commits(request):
        return web.json_response([{"sha": "426291abcdef", "html_url": "u", "commit": {
            "message": "Merge pull request #3\n\nподробности", "author": {"name": "Dima", "date": "2026-11-08"}}}])

    async def runs(request):
        return web.json_response({"workflow_runs": [
            {"id": 9, "name": "Deploy", "status": "completed", "conclusion": "skipped"},
            {"id": 8, "name": "CI", "status": "completed", "conclusion": "failure", "html_url": "r8",
             "display_title": "Сломанный тест"},
        ]})

    async def pulls(request):
        return web.json_response([{"number": 4, "title": "Новая фича", "draft": False, "html_url": "p4",
                                   "user": {"login": "claude"}}])

    async def issues(request):
        if request.method == "POST":
            body = await request.json()
            calls.append(("issue", body, request.headers.get("Authorization")))
            return web.json_response({"number": 12, "html_url": "https://github.com/x/12", "title": body["title"]},
                                     status=201)
        return web.json_response([{"number": 9, "title": "Шаблоны", "html_url": "i9", "labels": []},
                                  {"number": 4, "title": "PR", "pull_request": {}}])

    async def dispatch(request):
        calls.append(("dispatch", request.match_info["wf"], await request.json()))
        return web.Response(status=204)

    app = web.Application()
    base = "/repos/c4erepk0/IPAStore"
    app.router.add_get(base, repo)
    app.router.add_get(base + "/commits", commits)
    app.router.add_get(base + "/actions/runs", runs)
    app.router.add_get(base + "/pulls", pulls)
    app.router.add_route("*", base + "/issues", issues)
    app.router.add_post(base + "/actions/workflows/{wf}/dispatches", dispatch)
    return app, calls


def test_status_delegate_deploy(tmp_path):
    async def run():
        app, calls = fake_github()
        server = TestServer(app)
        await server.start_server()
        gh = GitHub("ghp_test", base_url=str(server.make_url("")).rstrip("/"))
        j = make_jarvis(tmp_path, github=gh)

        [st] = await j.act_project_status("IPAStore")
        gh_st = st["github"]
        assert gh_st["ci"]["name"] == "CI" and gh_st["ci"]["conclusion"] == "failure", "skipped-запуски не считаются"
        assert gh_st["last_commit"]["message"] == "Merge pull request #3"
        assert [i["number"] for i in gh_st["issues"]] == [9], "PR не должны попадать в задачи"
        assert "сборка упала" in project_line(st) and "PR открыто 1" in project_line(st)

        r = await j.handle("поручи IPAStore: добавить экспорт статистики в CSV")
        assert r.confirm and not calls, "до подтверждения на GitHub ничего не уходит"
        r = await j.handle("подтверждаю")
        assert r.kind == "ok" and "#12" in r.text
        kind, body, auth = calls[0]
        assert kind == "issue" and "@claude" in body["body"] and body["title"].startswith("добавить экспорт")
        assert auth == "Bearer ghp_test"
        assert "Поручено @claude" in j.vault.read("Projects/IPAStore.md")
        assert "Поручено" in j.brain.notes[-1] or "подтвердил" in j.brain.notes[-1]

        r = await j.handle("задеплой IPAStore")
        assert r.confirm["kind"] == "deploy"
        r = await j.confirm(r.confirm["id"])
        assert calls[-1] == ("dispatch", "deploy.yml", {"ref": "main"})

        # «Вечеринка»: статус всех проектов + деплой всего, что умеет деплоиться — с подтверждением
        r = await j.handle("протокол вечеринка")
        assert r.confirm and r.confirm["params"]["projects"] == ["IPAStore"]

        # датчик CI: новый упавший запуск → тревога (первый раз только запоминаем)
        from jarvis.watchers import Watchers
        w = Watchers(j)
        j.github._cache.clear()
        await w.projects_tick()
        assert not [e for e in j.hub.events if e["type"] == "alert" and "провалилась" in e["data"]["text"]]
        w.ci_seen["IPAStore"] = (7, "success")
        await w.projects_tick()
        assert [e for e in j.hub.events if e["type"] == "alert" and "провалилась" in e["data"]["text"]]

        await j.close()
        await server.close()
    asyncio.run(run())


def test_ipastore_metrics_in_status_line():
    stats = {"users": 120, "new_users_24h": 7, "stars_24h": 500, "open_reports": 1, "pending_devs": 1,
             "pending_apps": 0}
    st = {"name": "IPAStore", "health": {"ok": True}, "stats": stats}
    line = project_line(st)
    assert "сервис в сети" in line and "пользователей 120" in line and "новых за сутки 7" in line
    assert "звёзд за сутки 500" in line and "ждут модерации 2" in line


def test_local_claude_code_command(tmp_path):
    j = make_jarvis(tmp_path)
    cmd = j.projects.local_command("сделай X")
    assert cmd[:3] == ["definitely-not-installed-claude", "-p", "сделай X"]
    assert "--permission-mode" in cmd and "acceptEdits" in cmd and "--allowedTools" in cmd
    proj = j.projects.get("ipastore")
    assert proj and proj.repo == "c4erepk0/IPAStore" and proj.deploy_workflow == "deploy.yml"
    assert j.projects.can_run_local(proj)  # папки и claude нет — объясняет почему
