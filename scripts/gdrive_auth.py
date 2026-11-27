#!/usr/bin/env python3
"""Получить GDRIVE_REFRESH_TOKEN для Atom — шаг 5 в docs/drive.md.

Запускать на компьютере (не на сервере): скрипт поднимает локальный адрес http://127.0.0.1:<порт>/,
открывает страницу согласия Google и ловит код возврата. Токен печатается в терминал — это секрет,
кладите его только в .env.

    GDRIVE_CLIENT_ID=... GDRIVE_CLIENT_SECRET=... python3 scripts/gdrive_auth.py
    python3 scripts/gdrive_auth.py --write          # вписать токен в .env рядом
    python3 scripts/gdrive_auth.py --can-upload     # право drive: загрузка файлов и папки

По умолчанию право одно — drive.readonly: только читать. С --can-upload выдаётся drive, иначе Atom
не сможет загружать файлы в чужие папки (анонимность при этом прежняя: сервер отдаёт только id/имя/вид).
"""
from __future__ import annotations

import argparse
import http.server
import json
import os
import re
import secrets
import socketserver
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPE_READ = "https://www.googleapis.com/auth/drive.readonly"
SCOPE_FULL = "https://www.googleapis.com/auth/drive"
ROOT = Path(__file__).resolve().parent.parent
STATE = secrets.token_urlsafe(16)


class Catcher(http.server.BaseHTTPRequestHandler):
    """Ловит ?code=… на локальном адресе и показывает человеку «можно закрывать»."""

    code = ""
    error = ""

    def do_GET(self):                                      # noqa: N802 — имя из http.server
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        if "error" in params:
            Catcher.error = params["error"][0]
        elif params.get("state", [""])[0] != STATE:
            Catcher.error = "state не совпал — запрос не от Google"
        else:
            Catcher.code = params.get("code", [""])[0]
        ok = bool(Catcher.code)
        text = ("<h2>Готово</h2><p>Вернитесь в терминал — приложение можно закрыть.</p>" if ok
                else f"<h2>Не получилось</h2><p>{Catcher.error or 'нет кода'}</p>")
        body = f"<!doctype html><meta charset='utf-8'><body style='font:16px system-ui;padding:2rem'>{text}</body>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body.encode("utf-8"))

    def log_message(self, *args):                          # noqa: D102 — тишина в терминале
        pass


def exchange(client_id: str, client_secret: str, code: str, redirect: str) -> dict:
    data = urllib.parse.urlencode({"client_id": client_id, "client_secret": client_secret, "code": code,
                                   "grant_type": "authorization_code", "redirect_uri": redirect}).encode()
    req = urllib.request.Request(TOKEN_URL, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:                    # type: ignore[attr-defined]
        raise SystemExit(f"Google отказал в обмене кода ({e.code}): {e.read().decode('utf-8', 'replace')[:300]}")


def save(path: Path, refresh: str) -> None:
    """Вписать токен в .env, сохранив остальные строки."""
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    line = f"GDRIVE_REFRESH_TOKEN={refresh}"
    if re.search(r"^GDRIVE_REFRESH_TOKEN=.*$", text, flags=re.M):
        text = re.sub(r"^GDRIVE_REFRESH_TOKEN=.*$", line, text, flags=re.M)
    else:
        text = text.rstrip("\n") + "\n" + line + "\n"
    path.write_text(text, encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass


def main() -> int:
    ap = argparse.ArgumentParser(description="refresh-токен Google Drive для Atom")
    ap.add_argument("--port", type=int, default=8767)
    ap.add_argument("--write", action="store_true", help="вписать токен в .env")
    ap.add_argument("--can-upload", action="store_true", help="право drive: загрузка файлов и создание папок")
    args = ap.parse_args()

    client_id = (os.getenv("GDRIVE_CLIENT_ID") or "").strip()
    client_secret = (os.getenv("GDRIVE_CLIENT_SECRET") or "").strip()
    if not client_id or not client_secret:
        print("Нужны GDRIVE_CLIENT_ID и GDRIVE_CLIENT_SECRET (шаги 1–4 в docs/drive.md).", file=sys.stderr)
        return 2

    redirect = f"http://127.0.0.1:{args.port}/"
    url = AUTH_URL + "?" + urllib.parse.urlencode({
        "client_id": client_id, "redirect_uri": redirect, "response_type": "code",
        "scope": SCOPE_FULL if args.can_upload else SCOPE_READ, "access_type": "offline",
        "prompt": "consent", "state": STATE})
    print("Откройте ссылку и разрешите доступ только на чтение:\n\n" + url + "\n")
    try:
        webbrowser.open(url)
    except Exception:                                      # noqa: BLE001 — браузер не обязателен
        pass

    class Server(socketserver.TCPServer):
        allow_reuse_address = True

    with Server(("127.0.0.1", args.port), Catcher) as srv:
        srv.timeout = 300
        srv.handle_request()
    if not Catcher.code:
        print(f"Код не получен: {Catcher.error or 'истекло время'}", file=sys.stderr)
        return 1

    tokens = exchange(client_id, client_secret, Catcher.code, redirect)
    refresh = str(tokens.get("refresh_token") or "")
    if not refresh:
        print("Google не выдал refresh_token. Удалите доступ приложения в аккаунте Google "
              "и повторите.", file=sys.stderr)
        return 1
    print("\nGDRIVE_REFRESH_TOKEN=" + refresh)
    if args.write:
        save(ROOT / ".env", refresh)
        print("\nЗаписано в .env — перезапустите Atom.")
    else:
        print("\nВставьте строку в .env (не в код и не в заметки) и перезапустите Atom.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
