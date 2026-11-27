#!/bin/sh
# Рабочая среда Atom одной командой: .venv, зависимости, .env, проверка.
#
#   bash scripts/bootstrap.sh              полный путь (рекомендуется)
#   bash scripts/bootstrap.sh --no-test    без проверочного прогона тестов
#   PYTHON=/usr/local/bin/python3.12 bash scripts/bootstrap.sh
#
# Скрипт идемпотентен: можно запускать сколько угодно раз, уже сделанное пропускается.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
PYTHON=${PYTHON:-python3}
VENV="$ROOT/.venv"
RUN_TESTS=1

for arg in "$@"; do
    case "$arg" in
        --no-test) RUN_TESTS=0 ;;
        -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Неизвестный аргумент: $arg (см. --help)" >&2; exit 2 ;;
    esac
done

say() { printf '%s\n' "$*"; }
fail() { printf 'Ошибка: %s\n' "$*" >&2; exit 1; }

say "Atom · подготовка рабочей среды в $ROOT"

# --- 1. Python 3.11+ ---
command -v "$PYTHON" >/dev/null 2>&1 || fail "не найден $PYTHON. Поставьте Python 3.11+ или задайте PYTHON=путь/к/python3"
"$PYTHON" - <<'PY' || exit 1
import sys
if sys.version_info < (3, 11):
    sys.exit(f"Ошибка: нужен Python 3.11+, а найден {sys.version.split()[0]}")
print(f"Python {sys.version.split()[0]} — подходит")
PY

# --- 2. venv ---
if [ -x "$VENV/bin/python" ]; then
    say ".venv уже есть"
elif [ -x "$VENV/Scripts/python.exe" ]; then
    say ".venv уже есть (Windows)"
else
    say "Создаю .venv…"
    "$PYTHON" -m venv "$VENV" || fail "не удалось создать .venv (в Debian/Ubuntu нужен пакет python3-venv)"
fi
if [ -x "$VENV/bin/python" ]; then
    VPY="$VENV/bin/python"
else
    VPY="$VENV/Scripts/python.exe"
fi

# --- 3. зависимости ---
say "Ставлю зависимости (requirements-dev.txt)…"
"$VPY" -m pip install -q --upgrade pip
"$VPY" -m pip install -q -r requirements-dev.txt || fail "зависимости не встали — см. вывод pip выше"

# --- 4. .env ---
if [ -f .env ]; then
    say ".env на месте"
else
    cp .env.example .env
    say "Создан .env из .env.example — впишите ключ мозга (ANTHROPIC_API_KEY или DEEPSEEK_API_KEY) и остальное по желанию"
fi

# --- 5. проверка среды ---
if [ "$RUN_TESTS" = "1" ]; then
    say "Проверяю среду коротким прогоном тестов…"
    if ! "$VPY" -m pytest -q tests/test_commands.py tests/test_operators.py; then
        fail "тесты не прошли. Частая причина на macOS/Linux — нет make; ниже полный прогон: $VPY -m pytest -q"
    fi
    if command -v node >/dev/null 2>&1; then
        node --test tests/js/*.test.mjs >/dev/null 2>&1 && say "ядро для iPhone: тесты прошли" \
            || say "ядро для iPhone: тесты не прошли — проверьте node --test tests/js/*.test.mjs"
    else
        say "node не найден: тесты ядра для iPhone пропущены (нужен Node 20+)"
    fi
fi

say ""
say "Готово. Дальше:"
say "  make run    — запустить Atom на http://127.0.0.1:8765"
say "  make check  — lint + test + audit (как в CI)"
say "  make help   — все команды"
say "Карта проекта — CLAUDE.md, правила ветвей — CONTRIBUTING.md."
