#!/usr/bin/env bash
# Быстрый запуск Jarvis на Linux/macOS: venv, зависимости, .env, старт.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Нужен Python 3.11+ (https://www.python.org/downloads/)"; exit 1
fi
if [ ! -d .venv ]; then
  echo "→ Создаю виртуальное окружение…"
  python3 -m venv .venv
fi
echo "→ Ставлю зависимости…"
.venv/bin/python -m pip install -q --upgrade pip
.venv/bin/python -m pip install -q -r requirements.txt
if [ ! -f .env ]; then
  cp .env.example .env
  echo "→ Создан .env — при желании добавьте ANTHROPIC_API_KEY, GITHUB_TOKEN и VAULT_PATH."
fi
echo "→ J.A.R.V.I.S. запускается: http://localhost:${JARVIS_PORT:-8765}"
exec .venv/bin/python -m jarvis
