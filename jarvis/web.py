"""Веб-сервер: дашборд (HUD), REST API и WebSocket для обновлений в реальном времени."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import time
from pathlib import Path

from aiohttp import WSMsgType, web

from .core import Jarvis
from .vault import VaultError

log = logging.getLogger("jarvis.web")
WEBAPP = Path(__file__).parent / "webapp"
COOKIE = "jarvis_session"
SESSION_DAYS = 30
PUBLIC = {"/api/login", "/api/session", "/healthz"}
MAX_IMAGE = 8 * 2**20
CSP = ("default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'; "
       "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; "
       "img-src 'self' data: blob:; media-src 'self' blob: data:; "
       "connect-src 'self' ws: wss: https://cdn.jsdelivr.net https://storage.googleapis.com; "
       "worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")

JARVIS_KEY = web.AppKey("jarvis", Jarvis)


class Auth:
    def __init__(self, code: str, secret: bytes):
        self.code = code
        self.secret = secret
        self.attempts: dict[str, list[float]] = {}

    @property
    def enabled(self) -> bool:
        return bool(self.code)

    def make(self) -> str:
        exp = str(int(time.time()) + SESSION_DAYS * 86400)
        sig = hmac.new(self.secret, exp.encode(), hashlib.sha256).hexdigest()
        return f"{exp}.{sig}"

    def valid_cookie(self, value: str | None) -> bool:
        if not value or "." not in value:
            return False
        exp, sig = value.split(".", 1)
        good = hmac.new(self.secret, exp.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(sig, good) and exp.isdigit() and int(exp) > time.time()

    def check_code(self, code: str) -> bool:
        return bool(self.code) and hmac.compare_digest(code.encode(), self.code.encode())

    def allowed(self, request: web.Request) -> bool:
        if not self.enabled:
            return True
        if self.valid_cookie(request.cookies.get(COOKIE)):
            return True
        header = request.headers.get("Authorization", "")
        return header.startswith("Bearer ") and self.check_code(header[7:].strip())

    def throttle(self, ip: str) -> bool:
        now = time.time()
        recent = [t for t in self.attempts.get(ip, []) if now - t < 300]
        self.attempts[ip] = recent
        if len(recent) >= 8:
            return False
        recent.append(now)
        return True


def build_app(jarvis: Jarvis) -> web.Application:
    cfg = jarvis.cfg
    auth = Auth(cfg.access_code, cfg.session_secret())

    @web.middleware
    async def security(request: web.Request, handler):
        path = request.path
        if (path.startswith("/api/") or path == "/ws") and path not in PUBLIC and not auth.allowed(request):
            return web.json_response({"error": "нужен вход", "login": True}, status=401)
        if request.method in ("POST", "PUT", "DELETE") and path.startswith("/api/") and auth.enabled:
            if not same_origin(request):
                return web.json_response({"error": "чужой источник запроса"}, status=403)
        try:
            resp = await handler(request)
        except (ValueError, VaultError) as e:
            resp = web.json_response({"error": str(e)}, status=400)
        except FileNotFoundError as e:
            resp = web.json_response({"error": f"не найдено: {e}"}, status=404)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        return resp

    app = web.Application(middlewares=[security], client_max_size=MAX_IMAGE + 2**20)
    app[JARVIS_KEY] = jarvis
    j = jarvis

    async def body(request: web.Request) -> dict:
        try:
            data = await request.json()
        except (ValueError, json.JSONDecodeError):
            raise ValueError("ожидался JSON")
        if not isinstance(data, dict):
            raise ValueError("ожидался JSON-объект")
        return data

    def ok(data=None, status: int = 200) -> web.Response:
        return web.json_response(data if data is not None else {"ok": True}, status=status,
                                 dumps=lambda x: json.dumps(x, ensure_ascii=False, default=str))

    # ---------- страницы ----------
    async def index(_):
        return web.FileResponse(WEBAPP / "index.html", headers={
            "Cache-Control": "no-cache", "Content-Security-Policy": CSP, "X-Frame-Options": "DENY",
            "Permissions-Policy": "microphone=(self), camera=(self)"})

    async def service_worker(_):
        return web.FileResponse(WEBAPP / "sw.js", headers={"Cache-Control": "no-cache",
                                                           "Content-Type": "text/javascript"})

    async def manifest(_):
        return web.FileResponse(WEBAPP / "manifest.webmanifest",
                                headers={"Content-Type": "application/manifest+json"})

    async def healthz(_):
        return ok({"ok": True, "name": "jarvis"})

    # ---------- вход ----------
    async def session(request):
        return ok({"auth": auth.enabled, "logged_in": auth.allowed(request)})

    async def login(request):
        if not auth.throttle(client_ip(request)):
            return ok({"error": "слишком много попыток, подождите 5 минут"}, 429)
        data = await body(request)
        # код часто копируют из терминала вместе с пробелом или переводом строки в конце
        if auth.enabled and not auth.check_code(str(data.get("code", "")).strip()):
            await asyncio.sleep(0.7)
            return ok({"error": "неверный код"}, 403)
        resp = ok()
        secure = request.secure or request.headers.get("X-Forwarded-Proto") == "https" \
            or '"https"' in request.headers.get("Cf-Visitor", "")
        resp.set_cookie(COOKIE, auth.make(), max_age=SESSION_DAYS * 86400, httponly=True, samesite="Strict",
                        secure=secure, path="/")
        return resp

    async def logout(_):
        resp = ok()
        resp.del_cookie(COOKIE, path="/")
        return resp

    # ---------- данные ----------
    async def state(request):
        return ok(await j.state(with_projects=request.query.get("projects") == "1"))

    async def command(request):
        data = await body(request)
        reply = await j.handle(str(data.get("text", ""))[:4000], source=str(data.get("source") or "dashboard"),
                               client=str(data.get("client") or "") or None)
        return ok(reply.as_dict())

    async def tasks_get(request):
        return ok(j.act_list_tasks(request.query.get("view", "today"), request.query.get("project") or None))

    async def tasks_add(request):
        d = await body(request)
        return ok(await j.act_add_task(str(d.get("text", "")), d.get("due") or None, d.get("priority") or None,
                                       d.get("project") or None))

    async def task_status(request):
        d = await body(request)
        status = str(d.get("status", "done"))
        if status not in ("todo", "doing", "done", "cancelled"):
            raise ValueError("неизвестный статус")
        if status == "done":
            return ok(await j.act_complete_task(request.match_info["id"]))
        try:
            task = j.tasks.set_status(request.match_info["id"], status, j.today())
        except KeyError as e:
            raise ValueError(str(e)) from e
        await j.changed("tasks")
        return ok(task.as_dict())

    async def finance_get(request):
        return ok(j.act_finance_report(request.query.get("month") or None))

    async def finance_add(request):
        d = await body(request)
        try:
            amount = int(round(float(str(d.get("amount", "0")).replace(",", ".")) * 100))
        except ValueError:
            raise ValueError("сумма должна быть числом")
        return ok(await j.act_money(amount, str(d.get("category") or "Прочее"), str(d.get("note") or ""),
                                    d.get("date") or None))

    async def projects_get(_):
        return ok(await j.act_project_status())

    async def project_action(request):
        name, action = request.match_info["name"], request.match_info["action"]
        d = await body(request) if request.can_read_body else {}
        if action == "delegate":
            item = j.act_delegate(name, str(d.get("task", "")).strip() or _required("task"),
                                  str(d.get("mode") or "github"))
        elif action == "deploy":
            item = j.act_deploy(name)
        else:
            raise ValueError("неизвестное действие")
        await j.hub.emit("pending", {"id": item.id, "state": "new", "item": item.as_dict()}, log_it=False)
        return ok({"confirm": item.as_dict()})

    async def job_get(request):
        job = j.projects.jobs.get(request.match_info["id"])
        if not job:
            raise FileNotFoundError("задача мастерской")
        return ok(job.as_dict())

    async def job_cancel(request):
        return ok({"ok": j.projects.cancel(request.match_info["id"])})

    async def confirm(request):
        return ok((await j.confirm(request.match_info["id"])).as_dict())

    async def cancel(request):
        return ok((await j.cancel(request.match_info["id"])).as_dict())

    async def memory_get(request):
        q = request.query.get("q", "").strip()
        if q:
            return ok({"hits": j.act_search(q, 12)})
        return ok({"facts": j.memory.facts(), "profile": j.memory.profile()})

    async def memory_add(request):
        d = await body(request)
        return ok(await j.act_remember(str(d.get("fact", ""))))

    async def note_get(request):
        path = request.query.get("path", "")
        text = j.vault.read(path)
        return ok({"path": path, "content": text[:200_000]})

    async def graph(_):
        loop = asyncio.get_running_loop()
        return ok(await loop.run_in_executor(None, j.vault.graph))

    async def diag(_):
        return ok(j.diagnostics())

    async def weather(_):
        w, rates = await asyncio.gather(j.briefing.weather(), j.briefing.rates())
        return ok({"weather": w, "rates": rates})

    async def tts(request):
        d = await body(request)
        audio = await j.voice.synthesize(str(d.get("text", ""))[:2000])
        if not audio:
            return web.Response(status=204)
        return web.Response(body=audio[0], content_type=audio[1], headers={"Cache-Control": "private, max-age=86400"})

    async def voice_set(request):
        d = await body(request)
        if "muted" in d:
            j.voice.muted = bool(d["muted"])
            await j.hub.emit("voice", {"muted": j.voice.muted}, log_it=False)
        return ok({"muted": j.voice.muted})

    async def reminder_cancel(request):
        res = j.reminders.cancel(request.match_info["id"])
        await j.changed("reminders")
        return ok({"ok": res})

    async def scan(request):
        if not j.brain.available:
            return ok({"error": "Анализ фото работает с ключом Claude API (ANTHROPIC_API_KEY)."}, 503)
        reader = await request.multipart()
        image, mime, hint = None, "", ""
        async for part in reader:
            if part.name == "image":
                mime = part.headers.get("Content-Type", "")
                if mime not in ("image/jpeg", "image/png", "image/webp", "image/gif"):
                    raise ValueError("поддерживаются JPEG, PNG, WebP, GIF")
                image = await part.read(decode=False)
                if len(image) > MAX_IMAGE:
                    raise ValueError("фото больше 8 МБ")
            elif part.name == "hint":
                hint = (await part.text())[:500]
        if not image:
            raise ValueError("нет изображения")
        reply = await j.brain.analyze_image(image, mime, hint)
        await j.hub.emit("reply", {**reply.as_dict(), "request": "📷 анализ фото", "via": "camera"}, log_it=False)
        return ok(reply.as_dict())

    async def ws_handler(request):
        if auth.enabled:
            if not same_origin(request):
                raise web.HTTPForbidden()
        ws = web.WebSocketResponse(heartbeat=25)
        await ws.prepare(request)
        j.hub.clients.add(ws)
        await ws.send_json({"type": "hello", "data": {"clients": len(j.hub.clients)}, "ts": time.time()})
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(msg.data)
                except ValueError:
                    continue
                if data.get("type") == "command":
                    asyncio.create_task(j.handle(str(data.get("text", ""))[:4000], source="dashboard",
                                                 client=str(data.get("client") or "") or None))
                elif data.get("type") == "ping":
                    await ws.send_json({"type": "pong", "ts": time.time()})
        finally:
            j.hub.clients.discard(ws)
        return ws

    r = app.router
    r.add_get("/", index)
    r.add_get("/sw.js", service_worker)
    r.add_get("/manifest.webmanifest", manifest)
    r.add_get("/healthz", healthz)
    r.add_static("/static/", WEBAPP / "static", append_version=False)
    r.add_get("/api/session", session)
    r.add_post("/api/login", login)
    r.add_post("/api/logout", logout)
    r.add_get("/api/state", state)
    r.add_post("/api/command", command)
    r.add_get("/api/tasks", tasks_get)
    r.add_post("/api/tasks", tasks_add)
    r.add_post("/api/tasks/{id:.+}/status", task_status)
    r.add_get("/api/finance", finance_get)
    r.add_post("/api/finance", finance_add)
    r.add_get("/api/projects", projects_get)
    r.add_post("/api/projects/{name}/{action}", project_action)
    r.add_get("/api/jobs/{id}", job_get)
    r.add_post("/api/jobs/{id}/cancel", job_cancel)
    r.add_post("/api/confirm/{id}", confirm)
    r.add_post("/api/cancel/{id}", cancel)
    r.add_get("/api/memory", memory_get)
    r.add_post("/api/memory", memory_add)
    r.add_get("/api/note", note_get)
    r.add_get("/api/graph", graph)
    r.add_get("/api/diagnostics", diag)
    r.add_get("/api/weather", weather)
    r.add_post("/api/tts", tts)
    r.add_post("/api/voice", voice_set)
    r.add_post("/api/reminders/{id}/cancel", reminder_cancel)
    r.add_post("/api/scan", scan)
    r.add_get("/ws", ws_handler)
    return app


def client_ip(request: web.Request) -> str:
    """Адрес посетителя. За Caddy или туннелем (запрос пришёл с этого же сервера) настоящий адрес —
    в X-Forwarded-For, иначе лимит попыток входа был бы общим для всех и чужой перебор блокировал бы владельца."""
    remote = request.remote or "?"
    if remote in ("127.0.0.1", "::1"):
        forwarded = request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
        if forwarded:
            return forwarded
    return remote


def same_origin(request: web.Request) -> bool:
    """Запрос с нашей же страницы? За туннелем (Cloudflare, localhost.run) Host бывает внутренним —
    тогда сверяемся с X-Forwarded-Host."""
    origin = request.headers.get("Origin")
    if not origin:
        return True
    host = origin.split("://", 1)[-1]
    return host in {request.host, request.headers.get("X-Forwarded-Host", "")}


def _required(name: str):
    raise ValueError(f"не указано поле {name}")
