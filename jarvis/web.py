"""Веб-сервер: дашборд (HUD), REST API и WebSocket для обновлений в реальном времени."""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
import time
from pathlib import Path

from aiohttp import WSMsgType, web

from .finance import guess_category
from .operators import APP_LEVELS, BUILTIN_APPS, OWNER_KEY, PERMS
from .core import Jarvis
from .gaze import save_record as save_gaze_record
from .updater import UpdateError
from .vault import VaultConflict, VaultError, content_version

log = logging.getLogger("jarvis.web")
WEBAPP = Path(__file__).parent / "webapp"
COOKIE = "jarvis_session"
SESSION_DAYS = 30
PUBLIC = {"/api/login", "/api/session", "/healthz", "/api/setup", "/api/invite", "/api/invite/accept",
          "/api/op-login"}
# оператору открыт только его раздел /api/op/… и служебное (свои устройства — /api/sessions)
OPERATOR_PATHS = {"/api/session", "/api/logout", "/ws", "/api/sessions"}
MAX_IMAGE = 8 * 2**20
# карта (map.js): подложки OpenFreeMap / CARTO / Esri, поиск Photon и Nominatim, маршруты OSRM, «Рядом» — Overpass
MAP_HOSTS = ("https://tiles.openfreemap.org https://basemaps.cartocdn.com https://*.basemaps.cartocdn.com "
             "https://server.arcgisonline.com https://photon.komoot.io https://nominatim.openstreetmap.org "
             "https://routing.openstreetmap.de https://overpass-api.de")
CSP = ("default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'; "
       "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; "
       "font-src 'self' https://fonts.gstatic.com; "
       f"img-src 'self' data: blob: {MAP_HOSTS}; media-src 'self' blob: data:; "
       f"connect-src 'self' ws: wss: https://cdn.jsdelivr.net https://storage.googleapis.com {MAP_HOSTS}; "
       "worker-src 'self' blob:; frame-src 'self' https: http://localhost:* http://127.0.0.1:*; "
       "frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
# frame-src: приложения из каталога («Ценники» и др.) открываются внутри Atom (app-viewer.js); http — только
# localhost, для разработки своих приложений

JARVIS_KEY = web.AppKey("jarvis", Jarvis)
WHO = web.RequestKey("who", dict)          # кто пришёл: владелец или оператор (ставит middleware)


class Auth:
    """Вход. Роли: владелец (корень) и операторы.

    Владелец входит кодом JARVIS_ACCESS_CODE или паролем, заданным при первом запуске (data/operators.json),
    оператор — по ссылке-приглашению. Сессия — подписанная cookie «роль.кто.версия.срок.подпись»
    (старая «срок.подпись» — владелец). Отключили оператора — версия меняется, его сессии перестают работать.
    """

    def __init__(self, code: str, secret: bytes, operators=None):
        self.code = code
        self.secret = secret
        self.ops = operators
        self.attempts: dict[str, list[float]] = {}

    @property
    def enabled(self) -> bool:
        return bool(self.code) or bool(self.ops and self.ops.owner_mode == "password")

    @property
    def setup_needed(self) -> bool:
        """Первый запуск: ни кода в .env, ни выбора «владелец с паролем / без пароля»."""
        return not self.code and bool(self.ops) and not self.ops.owner_mode

    def _sign(self, payload: str) -> str:
        return hmac.new(self.secret, payload.encode(), hashlib.sha256).hexdigest()

    def make(self, role: str = "owner", sub: str = "-", sid: str = "-") -> str:
        """Сессия: «роль.кто.устройство.срок.подпись». Устройство (sid) — запись в data/operators.json:
        её можно завершить, и cookie на том устройстве перестанет работать."""
        exp = str(int(time.time()) + SESSION_DAYS * 86400)
        payload = f"{role}.{sub}.{sid}.{exp}"
        return f"{payload}.{self._sign(payload)}"

    def parse_cookie(self, value: str | None) -> dict | None:
        if not value:
            return None
        parts = value.split(".")
        if len(parts) == 2:                                   # старый формат: владелец
            exp, sig = parts
            ok = hmac.compare_digest(sig, self._sign(exp)) if exp.isdigit() else False
            if not (ok and int(exp) > time.time()):
                return None
            if self.ops and not self.ops.session_valid(OWNER_KEY, "-"):
                return None
            return {"role": "owner", "sid": "-"}
        if len(parts) != 5:
            return None
        role, sub, sid, exp, sig = parts
        if not exp.isdigit() or int(exp) <= time.time():
            return None
        if not hmac.compare_digest(sig, self._sign(".".join(parts[:4]))):
            return None
        if role == "owner":
            if self.ops and not self.ops.session_valid(OWNER_KEY, sid):
                return None                                    # устройство завершено
            return {"role": "owner", "sid": sid}
        if role == "op" and self.ops and self.ops.session_valid(sub, sid):
            return {"role": "operator", "op": self.ops.get(sub), "sid": sid}
        return None

    def valid_cookie(self, value: str | None) -> bool:
        who = self.parse_cookie(value)
        return bool(who and who["role"] == "owner")

    def check_code(self, code: str) -> bool:
        if self.code and hmac.compare_digest(code.encode(), self.code.encode()):
            return True
        return bool(self.ops and self.ops.check_owner_password(code))

    def who(self, request: web.Request) -> dict | None:
        """Кто пришёл: {"role": "owner"} | {"role": "operator", "op": {...}} | None."""
        cookie = self.parse_cookie(request.cookies.get(COOKIE))
        if cookie:
            return cookie
        header = request.headers.get("Authorization", "")
        if header.startswith("Bearer ") and self.check_code(header[7:].strip()):
            return {"role": "owner"}
        if not self.enabled:
            return {"role": "owner"}
        return None

    def allowed(self, request: web.Request) -> bool:
        who = self.who(request)
        return bool(who and who["role"] == "owner")

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
    auth = Auth(cfg.access_code, cfg.session_secret(), jarvis.operators)

    @web.middleware
    async def security(request: web.Request, handler):
        path = request.path
        if (path.startswith("/api/") or path == "/ws") and path not in PUBLIC:
            who = auth.who(request)
            if not who:
                return web.json_response({"error": "нужен вход", "login": True}, status=401)
            if who["role"] == "operator":
                if not (path.startswith("/api/op/") or path in OPERATOR_PATHS):
                    return web.json_response({"error": "у оператора нет доступа к этому разделу"}, status=403)
            if who.get("sid") and who["sid"] not in ("-", "0"):
                holder = OWNER_KEY if who["role"] == "owner" else who["op"]["id"]
                jarvis.operators.touch_session(holder, who["sid"], client_ip(request))
            request[WHO] = who
        if request.method in ("POST", "PUT", "DELETE") and path.startswith("/api/") and auth.enabled:
            if not same_origin(request):
                return web.json_response({"error": "чужой источник запроса"}, status=403)
        try:
            resp = await handler(request)
        except (ValueError, VaultError) as e:
            resp = web.json_response({"error": str(e)}, status=400)
        except PermissionError as e:
            resp = web.json_response({"error": str(e)}, status=403)
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
        who = auth.who(request)
        out = {"auth": auth.enabled, "logged_in": bool(who and who["role"] == "owner"),
               "role": who["role"] if who else None, "setup": auth.setup_needed,
               "owner_mode": jarvis.operators.owner_mode or ("code" if cfg.access_code else "")}
        if who and who["role"] == "operator":
            op = who["op"]
            out.update(logged_in=True, operator=jarvis.operators.public(op))
        return ok(out)

    def with_cookie(request, resp, value: str):
        secure = request.secure or request.headers.get("X-Forwarded-Proto") == "https" \
            or '"https"' in request.headers.get("Cf-Visitor", "")
        resp.set_cookie(COOKIE, value, max_age=SESSION_DAYS * 86400, httponly=True, samesite="Strict",
                        secure=secure, path="/")
        return resp

    async def login(request):
        if not auth.throttle(client_ip(request)):
            return ok({"error": "слишком много попыток, подождите 5 минут"}, 429)
        data = await body(request)
        # код часто копируют из терминала вместе с пробелом или переводом строки в конце
        if auth.enabled and not auth.check_code(str(data.get("code", "")).strip()):
            await asyncio.sleep(0.7)
            return ok({"error": "неверный код"}, 403)
        return with_cookie(request, ok(), owner_cookie(request))

    def owner_cookie(request) -> str:
        sid = jarvis.operators.new_session(OWNER_KEY, request.headers.get("User-Agent", ""), client_ip(request))
        return auth.make("owner", "-", sid)

    def op_cookie(request, op) -> str:
        sid = jarvis.operators.new_session(op["id"], request.headers.get("User-Agent", ""), client_ip(request))
        return auth.make("op", op["id"], sid)

    async def op_login(request):
        """Вход оператора по имени и паролю (пароль он задал, приняв приглашение)."""
        if not auth.throttle(client_ip(request)):
            return ok({"error": "слишком много попыток, подождите 5 минут"}, 429)
        d = await body(request)
        op = jarvis.operators.login(str(d.get("name") or ""), str(d.get("password") or ""))
        if not op:
            await asyncio.sleep(0.7)
            return ok({"error": "неверное имя или пароль"}, 403)
        await j.log(f"Оператор {op['name']} вошёл", journal=False)
        return with_cookie(request, ok({"role": "operator", "operator": jarvis.operators.public(op)}),
                           op_cookie(request, op))

    async def setup(request):
        """Первый запуск: «Я владелец» — с паролем или без (один человек, локально)."""
        if not auth.setup_needed:
            return ok({"error": "уже настроено"}, 409)
        if request.method == "POST" and auth.enabled is False and not same_origin(request):
            return ok({"error": "чужой источник запроса"}, 403)
        data = await body(request)
        if data.get("mode") == "password":
            jarvis.operators.set_owner_password(str(data.get("password") or ""))
        else:
            jarvis.operators.set_open()
        await j.log("Первый запуск: владелец " + ("задал пароль" if data.get("mode") == "password" else "без пароля"))
        return with_cookie(request, ok({"role": "owner"}), owner_cookie(request))

    async def invite_info(request):
        if not auth.throttle(client_ip(request)):
            return ok({"error": "слишком много попыток, подождите 5 минут"}, 429)
        info = jarvis.operators.invite_info(request.query.get("token", ""))
        return ok(info) if info else ok({"error": "приглашение недействительно или устарело"}, 404)

    async def invite_accept(request):
        if not auth.throttle(client_ip(request)):
            return ok({"error": "слишком много попыток, подождите 5 минут"}, 429)
        data = await body(request)
        token = str(data.get("token") or "").strip()
        m = re.search(r"invite=([\w-]+)", token)              # вставили всю ссылку — достанем код
        op = jarvis.operators.accept(m.group(1) if m else token, str(data.get("password") or ""))
        await j.log(f"Оператор {op['name']} принял приглашение")
        await j.hub.emit("operators", {"id": op["id"]}, log_it=False)
        return with_cookie(request, ok({"role": "operator", "operator": jarvis.operators.public(op)}),
                           op_cookie(request, op))

    async def logout(request):
        who = auth.who(request)                               # выйти — значит и завершить сессию этого устройства
        if who and who.get("sid") and who["sid"] not in ("-", "0"):
            jarvis.operators.revoke(OWNER_KEY if who["role"] == "owner" else who["op"]["id"], who["sid"])
        resp = ok()
        resp.del_cookie(COOKIE, path="/")
        return resp

    async def sessions(request):
        """Мои устройства (владелец или оператор): список; завершить одно или все, кроме этого."""
        who = request[WHO]
        holder = OWNER_KEY if who["role"] == "owner" else who["op"]["id"]
        if request.method == "POST":
            d = await body(request)
            if d.get("action") == "others":
                n = jarvis.operators.revoke_others(holder, keep=who.get("sid", ""))
                await j.log(f"Выход на других устройствах: {n}", journal=False)
            elif d.get("action") == "revoke":
                if str(d.get("sid")) == who.get("sid"):
                    raise ValueError("это устройство — нажмите «Выйти»")
                if not jarvis.operators.revoke(holder, str(d.get("sid") or "")):
                    raise ValueError("сессия не найдена — возможно, уже завершена")
            else:
                raise ValueError("неизвестное действие")
        return ok({"sessions": jarvis.operators.sessions(holder, who.get("sid", "")),
                   "auth": auth.enabled})

    # ---------- данные ----------
    async def state(request):
        return ok(await j.state(with_projects=request.query.get("projects") == "1"))

    async def command(request):
        data = await body(request)
        reply = await j.handle(str(data.get("text", ""))[:4000], source=str(data.get("source") or "dashboard"),
                               client=str(data.get("client") or "") or None, note=str(data.get("note") or "") or None)
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
        note = str(d.get("note") or "")
        category = str(d.get("category") or "") or guess_category(note, income=amount > 0)
        return ok(await j.act_money(amount, category, note, d.get("date") or None))

    async def finance_analytics(request):
        try:
            months = int(request.query.get("months") or 6)
        except ValueError:
            months = 6
        return ok(j.act_finance_analytics(months))

    async def assets_get(request):
        return ok(await j.act_assets(record=request.query.get("record", "1") != "0"))

    async def assets_add(request):
        d = await body(request)
        return ok(await j.act_asset_add(str(d.get("action") or "asset"), d))

    # ---------- операторы: раздел владельца ----------
    def owner_only(request):
        if request.get(WHO, {}).get("role") != "owner":
            raise web.HTTPForbidden(text="только для владельца")

    def ops_overview():
        ops = jarvis.operators.list()
        for op in ops:
            op["unread"] = jarvis.operators.unread(op["id"], "owner")
        apps = [{"id": k, "name": v, "icon": "🗺", "kind": "builtin"} for k, v in BUILTIN_APPS.items()]
        apps += [{"id": a["note"], "name": a["name"], "icon": a["icon"], "kind": a["kind"]}
                 for a in j.act_apps()["apps"]]
        return {"operators": ops, "perms": PERMS, "can_invite": auth.enabled, "apps": apps, "app_levels": APP_LEVELS,
                "projects": [{"name": p.name, "status": p.status} for p in j.projects.list()],
                "owner_mode": jarvis.operators.owner_mode or ("code" if cfg.access_code else "")}

    async def admin_ops(request):
        owner_only(request)
        if request.method == "GET":
            return ok(ops_overview())
        d = await body(request)
        if not auth.enabled:
            raise ValueError("сначала задайте пароль владельца — без него оператор мог бы стать владельцем")
        op, token = jarvis.operators.create(str(d.get("name") or ""), d.get("perms"), str(d.get("note") or ""),
                                            d.get("projects"), d.get("apps"), d.get("notes"))
        await j.log(f"Приглашён оператор {op['name']}")
        return ok({**ops_overview(), "created": op, "token": token})

    async def admin_op(request):
        owner_only(request)
        op_id, d = request.match_info["id"], await body(request)
        action = str(d.get("action") or "update")
        try:
            if action == "invite":
                return ok({**ops_overview(), "token": jarvis.operators.reinvite(op_id)})
            if action == "delete":
                name = jarvis.operators.get(op_id)["name"] if jarvis.operators.get(op_id) else ""
                jarvis.operators.delete(op_id)
                await j.log(f"Оператор {name} удалён (переписка осталась в хранилище)")
            elif action == "logout":
                jarvis.operators.logout_all(op_id)
            elif action == "sessions":
                return ok({"sessions": jarvis.operators.sessions(op_id)})
            elif action == "revoke":
                jarvis.operators.revoke(op_id, str(d.get("sid") or ""))
                return ok({**ops_overview(), "sessions": jarvis.operators.sessions(op_id)})
            else:
                jarvis.operators.update(op_id, name=d.get("name"), perms=d.get("perms"), active=d.get("active"),
                                        note=d.get("note"), projects=d.get("projects"), apps=d.get("apps"),
                                        notes=d.get("notes"))
        except KeyError as e:
            raise ValueError(str(e).strip("'")) from None
        await j.hub.emit("operators", {"id": op_id}, log_it=False)
        return ok(ops_overview())

    async def admin_password(request):
        owner_only(request)
        d = await body(request)
        jarvis.operators.set_owner_password(str(d.get("password") or ""))
        await j.log("Пароль владельца изменён")
        return with_cookie(request, ok(ops_overview()), owner_cookie(request))

    async def admin_chat(request):
        owner_only(request)
        op_id = request.match_info["id"]
        if not jarvis.operators.get(op_id):
            raise ValueError("нет такого оператора")
        if request.method == "POST":
            d = await body(request)
            await j.act_chat(op_id, "owner", str(d.get("text") or ""))
        msgs = jarvis.operators.messages(op_id)
        if msgs:
            jarvis.operators.mark_read(op_id, "owner", msgs[-1]["n"])
        return ok({"messages": msgs})

    async def admin_assign(request):
        owner_only(request)
        d = await body(request)
        return ok(await j.act_assign(str(d.get("kind") or "task"), d))

    async def meetings_get(request):
        owner_only(request)
        op_id = request.query.get("operator")
        slug = jarvis.operators.get(op_id)["slug"] if op_id and jarvis.operators.get(op_id) else None
        return ok(j.act_meetings(slug))

    # ---------- раздел оператора /api/op/… ----------
    def me(request) -> dict:
        who = request.get(WHO) or {}
        if who.get("role") != "operator":
            raise web.HTTPForbidden(text="раздел оператора")
        return who["op"]

    async def op_me(request):
        op = me(request)
        if request.method == "POST":                              # сменить свой пароль
            d = await body(request)
            jarvis.operators.set_password(op["id"], str(d.get("old") or ""), str(d.get("new") or ""))
        return ok({"operator": jarvis.operators.public(op), "perms": PERMS, "title": cfg.user_title,
                   "unread": jarvis.operators.unread(op["id"], "operator"), "today": j.today().isoformat()})

    async def op_tasks(request):
        op = me(request)
        if request.method == "POST":                              # личная задача — в свой список
            d = await body(request)
            return ok(await j.op_add_task(op, str(d.get("text") or ""), d.get("due") or None,
                                          str(d.get("project") or "") or None))
        return ok(j.operator_tasks(op, request.query.get("view", "all")))

    async def op_task_status(request):
        op = me(request)
        task_id, d = request.match_info["id"], await body(request)
        status = str(d.get("status") or "done")
        if status not in ("todo", "done", "doing", "cancelled"):
            raise ValueError("неизвестный статус")
        try:
            task = j.op_set_status(op, task_id, status)
        except KeyError as e:
            raise ValueError(str(e).strip("'")) from None
        if not task.path.startswith(jarvis.operators.folder(op) + "/"):
            await j.log(f"{op['name']}: {'выполнено' if status == 'done' else status} — {task.text}")
        await j.changed("tasks")
        return ok(task.as_dict())

    async def op_meetings(request):
        op = me(request)
        return ok(j.act_meetings(None if "meetings_all" in op.get("perms", []) else op["slug"]))

    async def op_chat(request):
        op = me(request)
        if request.method == "POST":
            d = await body(request)
            await j.act_chat(op["id"], "operator", str(d.get("text") or ""))
        msgs = jarvis.operators.messages(op["id"])
        if msgs:
            jarvis.operators.mark_read(op["id"], "operator", msgs[-1]["n"])
        return ok({"messages": msgs})

    async def op_projects(request):
        op = me(request)
        return ok({"projects": j.op_projects(op), "can_add": "tasks_assign" in op.get("perms", [])})  # только общие

    async def op_apps(request):
        return ok({"apps": j.op_apps(me(request))})

    async def op_notes(request):
        op = me(request)
        return ok({"notes": j.op_notes(op), "folder": jarvis.operators.folder(op), "shared": j.op_shared_notes(op)})

    async def op_note(request):
        """Заметка оператора: GET ?path, PUT {path, content, base} — правка с версией, POST {title} — новая,
        POST {action: trash, path} — в корзину. Личные — внутри Команда/<Имя>/; доверенные владельцем — читать
        (и править, если разрешено); новые и корзина — только в своей папке."""
        op = me(request)
        if request.method == "GET":
            rel = j.op_access(op, request.query.get("path", ""))
            text = jarvis.vault.read(rel)
            own = rel.startswith(jarvis.operators.folder(op) + "/")
            return ok({"path": rel, "title": jarvis.vault.title_of(rel), "content": text,
                       "version": content_version(text), "own": own, "editable": own or bool(j.op_trusted(op, rel))})
        d = await body(request)
        if request.method == "PUT":
            rel = j.op_access(op, str(d.get("path") or ""), write=True)
            current = jarvis.vault.read(rel) if jarvis.vault.exists(rel) else ""
            if d.get("base") and content_version(current) != d["base"]:
                return ok({"error": "заметку изменили на другом устройстве — обновите", "content": current,
                           "version": content_version(current)}, 409)
            content = str(d.get("content") or "")
            jarvis.vault.write(rel, content if content.endswith("\n") else content + "\n")
            if not rel.startswith(jarvis.operators.folder(op) + "/"):
                await j.log(f"{op['name']} изменил(а) заметку «{jarvis.vault.title_of(rel)}»")
                await j.changed("notes")
            return ok({"path": rel, "version": content_version(jarvis.vault.read(rel))})
        if d.get("action") == "trash":
            rel = j.op_path(op, str(d.get("path") or ""))
            jarvis.notes.trash(rel)
            return ok({"notes": j.op_notes(op)})
        title = re.sub(r"[\\/|#\[\]:*?\"<>]+", " ", str(d.get("title") or "")).strip()[:80]
        if not title:
            raise ValueError("назовите заметку")
        rel = j.op_path(op, f"{jarvis.operators.folder(op)}/{title}.md")
        if jarvis.vault.exists(rel):
            raise ValueError("такая заметка уже есть")
        jarvis.vault.write(rel, f"# {title}\n\n")
        return ok({"path": rel, "notes": j.op_notes(op)})

    async def places_get(_):
        return ok({"places": j.places.list()})

    async def places_set(request):
        d = await body(request)
        try:
            return ok(await j.act_place(str(d.get("action") or "add"), d))
        except (TypeError, KeyError):
            raise ValueError("нужны name, lat и lon") from None

    async def apps_get(_):
        return ok(j.act_apps())

    async def apps_set(request):
        d = await body(request)
        return ok(await j.act_app_catalog(str(d.get("name") or ""), d.get("on", True) is not False))

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
        elif action == "update":
            return ok(await j.act_project_update(name, str(d.get("key") or "status"), str(d.get("value") or "")))
        elif action == "task":
            return ok(await j.act_add_task(str(d.get("text", "")), d.get("due") or None, d.get("priority") or None,
                                           name, to_note=True))
        else:
            raise ValueError("неизвестное действие")
        await j.hub.emit("pending", {"id": item.id, "state": "new", "item": item.as_dict()}, log_it=False)
        return ok({"confirm": item.as_dict()})

    async def project_create(request):
        d = await body(request)
        return ok(await j.act_project_create(str(d.get("name", "")), str(d.get("description") or ""),
                                             str(d.get("repo") or ""), str(d.get("tag") or ""),
                                             str(d.get("status") or "active")))

    async def project_get(request):
        return ok(j.act_project_overview(request.match_info["name"]))

    async def synthesis_get(_):
        loop = asyncio.get_running_loop()
        return ok(await loop.run_in_executor(None, j.act_synthesis))

    async def synthesis_create(request):
        d = await body(request)
        return ok(await j.act_synthesis_create(str(d.get("name", "")).strip() or _required("name"),
                                               str(d.get("status") or "idea")))

    # ---------- менеджер заметок ----------
    async def files_get(_):
        loop = asyncio.get_running_loop()
        return ok(await loop.run_in_executor(None, j.act_files))

    async def files_action(request):
        d, action = await body(request), request.match_info["action"]
        if action == "new":
            content = d.get("content")
            return ok(await j.act_create_note(str(d.get("path", "")), str(d.get("template") or "") or None,
                                              None if content is None else str(content)))
        if action == "folder":
            return ok(await j.act_mkdir(str(d.get("path", ""))))
        if action == "move":
            return ok(await j.act_move_note(str(d.get("from", "")), str(d.get("to", ""))))
        if action == "trash":
            return ok(await j.act_trash_note(str(d.get("path", ""))))
        raise ValueError("неизвестное действие")

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
        return ok(j.act_read_note(request.query.get("path", "")))

    async def note_save(request):
        """PUT — правка (base — версия, с которой начали править), POST — новая заметка."""
        d = await body(request)
        base = str(d.get("base") or "") or None if request.method == "PUT" else None
        if request.method == "PUT" and not base:
            raise ValueError("не указана версия заметки (base)")
        try:
            return ok(await j.act_save_note(str(d.get("path", "")), str(d.get("content", "")), base))
        except VaultConflict as e:
            current = None if e.current is None else {"content": e.current, "version": content_version(e.current)}
            return ok({"error": str(e), "conflict": True, "current": current}, 409)

    async def gaze_save(request):
        """Запись калибровки взгляда или журнала нажатий — в хранилище (Jarvis/Gaze/…), для анализа."""
        data = await body(request)
        return ok({"path": save_gaze_record(j.vault, cfg.jarvis_dir, data, j.now())})

    async def graph(_):
        loop = asyncio.get_running_loop()
        return ok(await loop.run_in_executor(None, j.vault.graph))

    async def diag(_):
        return ok(j.diagnostics())

    # ---------- приложение «Настройки и диагностика» (только владелец) ----------
    async def system_get(request):
        owner_only(request)
        return ok(await j.act_system())

    async def system_settings(request):
        owner_only(request)
        d = await body(request)
        action = str(d.get("action") or "known")
        if action == "known":
            j.settings.set_known(str(d.get("name") or ""), None if d.get("clear") else d.get("value"))
            await j.log(f"Настройка {d.get('name')} {'сброшена' if d.get('clear') else 'изменена'}", journal=False)
        elif action == "custom":
            j.settings.set_custom(str(d.get("name") or ""), d.get("value"), str(d.get("note") or ""),
                                  remove=bool(d.get("remove")))
            await j.log(f"Свой токен {str(d.get('name') or '').upper()} {'удалён' if d.get('remove') else 'сохранён'}",
                        journal=False)
        else:
            raise ValueError("неизвестное действие")
        return ok(j.settings.public())

    async def system_ssh(request):
        owner_only(request)
        d = await body(request)
        action = str(d.get("action") or "save")
        if action == "check":
            return ok(await j.act_ssh_check(str(d.get("id") or "")))
        if action == "remove":
            j.settings.ssh_remove(str(d.get("id") or ""))
        elif action == "save":
            saved = j.settings.ssh_upsert(d)
            await j.log(f"SSH-сервер «{saved['name']}» сохранён", journal=False)
        else:
            raise ValueError("неизвестное действие")
        return ok(j.settings.public())

    async def system_update(request):
        owner_only(request)
        d = await body(request)
        action = str(d.get("action") or "check")
        try:
            if action == "check":
                return ok(await j.updater.check())
            if action == "auto":
                u = j.settings.set_update(d.get("auto"), d.get("hours"), d.get("branch"))
                j.updater.branch = u.get("branch", "")
                await j.log(f"Автообновление {'включено' if u['auto'] else 'выключено'}", journal=False)
                return ok({"update": u})
        except UpdateError as e:
            raise ValueError(str(e)) from None
        if action == "apply":                            # обновление — только с подтверждения владельца
            if not j.updater.available:
                raise ValueError("Atom запущен не из клона git-репозитория — обновите вручную")
            item = j.ask_confirm("update", "Обновить Atom с GitHub и перезапустить", {})
            await j.hub.emit("pending", {"id": item.id, "state": "new", "item": item.as_dict()}, log_it=False)
            return ok({"confirm": item.as_dict()})
        raise ValueError("неизвестное действие")

    async def system_restart(request):
        owner_only(request)
        if not j.request_restart(delay=0.8):
            raise ValueError("перезапуск недоступен в этом режиме запуска")
        await j.log("Перезапуск Atom по команде владельца", journal=False)
        return ok({"restarting": True})

    # ---------- приложение «Глобус»: новости, сигналы, тактика (только владелец) ----------
    async def news_get(request):
        owner_only(request)
        try:
            since = float(request.query.get("since") or 0)
        except ValueError:
            since = 0
        if not j.news.items and j.cfg.news_enabled and not j.news.lock.locked():
            await j.act_news_poll()                     # первый запуск — не ждать фонового опроса
        return ok(await j.act_news(since))

    async def news_refresh(request):
        owner_only(request)
        fresh = await j.act_news_poll()
        return ok({"new": len(fresh), **(await j.act_news())})

    async def news_brief(request):
        owner_only(request)
        d = await body(request)
        return ok((await j.act_news_brief(str(d.get("id") or "") or None)).as_dict())

    # ---------- общие данные приложений каталога (appdata.py) ----------
    async def appdata_common(request, op):
        if request.method == "GET":
            return ok(j.act_appdata_get(request.query.get("app", ""), op))
        d = await body(request)
        app = str(d.get("app") or "")
        if d.get("action") == "restore":
            if op is not None:
                raise PermissionError("вернуть прошлую версию может только владелец")
            j.act_appdata_get(app)
            rec = j.appdata.restore(app, d.get("n"), "Владелец")
            await j.hub.emit("appdata", {"app": app, "rev": rec["rev"], "by": rec["by"], "client": ""}, log_it=False)
            return ok(rec)
        if d.get("action") == "history":
            j.act_appdata_get(app, op)
            return ok({"history": j.appdata.history(app)})
        return ok(await j.act_appdata_set(app, d.get("data"), op, str(d.get("client") or "")))

    async def appdata(request):
        owner_only(request)
        return await appdata_common(request, None)

    async def op_appdata(request):
        return await appdata_common(request, me(request))

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
        if j.brain.backend != "claude":
            return ok({"error": "Анализ фото пока работает только с Claude API (ANTHROPIC_API_KEY)."}, 503)
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
        who = request.get(WHO) or {}
        if who.get("role") == "operator":
            op_id = who["op"]["id"]

            def allow(event: dict) -> bool:
                d = event.get("data") or {}
                if event["type"] == "chat":
                    return d.get("op") == op_id
                if event["type"] == "refresh":
                    return d.get("what") in ("tasks", "all")
                if event["type"] == "appdata":                 # общие данные приложений, к которым есть доступ
                    fresh = jarvis.operators.get(op_id) or {}
                    return any(a["id"] == d.get("app") for a in fresh.get("apps", []))
                return event["type"] == "operators" and d.get("id") == op_id
            ws.atom_filter = allow
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
                if data.get("type") == "command" and who.get("role") != "operator":
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
    r.add_get("/api/finance/analytics", finance_analytics)
    r.add_get("/api/finance/assets", assets_get)
    r.add_post("/api/finance/assets", assets_add)
    r.add_post("/api/setup", setup)
    r.add_get("/api/invite", invite_info)
    r.add_post("/api/invite/accept", invite_accept)
    r.add_route("*", "/api/admin/operators", admin_ops)
    r.add_post("/api/admin/operators/{id}", admin_op)
    r.add_post("/api/admin/password", admin_password)
    r.add_route("*", "/api/admin/chat/{id}", admin_chat)
    r.add_post("/api/admin/assign", admin_assign)
    r.add_get("/api/meetings", meetings_get)
    r.add_route("*", "/api/op/me", op_me)
    r.add_route("*", "/api/op/tasks", op_tasks)
    r.add_post("/api/op/tasks/{id:.+}/status", op_task_status)
    r.add_get("/api/op/meetings", op_meetings)
    r.add_route("*", "/api/op/chat", op_chat)
    r.add_get("/api/op/projects", op_projects)
    r.add_get("/api/op/notes", op_notes)
    r.add_get("/api/op/apps", op_apps)
    r.add_route("*", "/api/op/appdata", op_appdata)
    r.add_route("*", "/api/appdata", appdata)
    r.add_route("*", "/api/op/note", op_note)
    r.add_post("/api/op-login", op_login)
    r.add_route("*", "/api/sessions", sessions)
    r.add_get("/api/places", places_get)
    r.add_post("/api/places", places_set)
    r.add_get("/api/apps", apps_get)
    r.add_post("/api/apps", apps_set)
    r.add_get("/api/projects", projects_get)
    r.add_post("/api/projects", project_create)
    r.add_get("/api/projects/{name}", project_get)
    r.add_post("/api/projects/{name}/{action}", project_action)
    r.add_get("/api/synthesis", synthesis_get)
    r.add_post("/api/synthesis", synthesis_create)
    r.add_get("/api/files", files_get)
    r.add_post("/api/files/{action}", files_action)
    r.add_get("/api/jobs/{id}", job_get)
    r.add_post("/api/jobs/{id}/cancel", job_cancel)
    r.add_post("/api/confirm/{id}", confirm)
    r.add_post("/api/cancel/{id}", cancel)
    r.add_get("/api/memory", memory_get)
    r.add_post("/api/memory", memory_add)
    r.add_get("/api/note", note_get)
    r.add_put("/api/note", note_save)
    r.add_post("/api/note", note_save)
    r.add_get("/api/graph", graph)
    r.add_post("/api/gaze", gaze_save)
    r.add_get("/api/diagnostics", diag)
    r.add_get("/api/news", news_get)
    r.add_post("/api/news/refresh", news_refresh)
    r.add_post("/api/news/brief", news_brief)
    r.add_get("/api/system", system_get)
    r.add_post("/api/system/settings", system_settings)
    r.add_post("/api/system/ssh", system_ssh)
    r.add_post("/api/system/update", system_update)
    r.add_post("/api/system/restart", system_restart)
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
