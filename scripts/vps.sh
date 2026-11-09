#!/usr/bin/env bash
# J.A.R.V.I.S. на своём VPS (Ubuntu 24.04 или Debian 12): служба systemd + Caddy (HTTPS получает сам).
#
#   bash vps.sh install   — установить; повторный запуск безопасен (настройки и память сохраняются)
#   bash vps.sh update    — скачать новую версию и перезапустить
#   bash vps.sh status    — работает ли, адрес, код входа, последние строки журнала
#   bash vps.sh logs      — журнал в реальном времени (выход — Ctrl+C)
#   bash vps.sh check     — какие внешние сервисы доступны с этого сервера
#
# Запускать от root. Вопросы можно не задавать — переменные окружения: GITHUB_TOKEN, VAULT_GIT,
# ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_ID, JARVIS_DOMAIN (свой домен вместо <ip>.sslip.io),
# JARVIS_REF (ветка, по умолчанию main). Подробно — docs/hosting.md.
set -euo pipefail

APP_DIR=${JARVIS_DIR:-/opt/jarvis}
APP_USER=${JARVIS_USER:-jarvis}
REPO=${JARVIS_REPO:-https://github.com/c4erepk0/Jarvis_claude.git}
PORT=${JARVIS_PORT:-8765}
CADDY_DIR=${JARVIS_CADDY_DIR:-/etc/caddy}
UNIT_FILE=${JARVIS_UNIT_FILE:-/etc/systemd/system/jarvis.service}
HTTPS_WAIT=${JARVIS_HTTPS_WAIT:-90}
ENV_FILE="$APP_DIR/.env"
SITE_FILE="$CADDY_DIR/sites/jarvis.caddy"
export DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1

say() { printf '%s\n' "$*"; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }

# ---------- помощники (проверяются в tests/test_vps.py) ----------

# Адрес без покупки домена: 203.0.113.7 → 203-0-113-7.sslip.io (на него выдаётся сертификат Let's Encrypt).
sslip_domain() { printf '%s.sslip.io\n' "${1//./-}"; }

# Записать KEY=VALUE в .env: заменить строку, если есть, иначе дописать. Значение — как есть (токены с / & и т.п.).
set_env() {
  local file=$1 key=$2 value=$3
  touch "$file"
  KEY=$key VALUE=$value awk '
    $0 ~ "^" ENVIRON["KEY"] "=" { if (!done) print ENVIRON["KEY"] "=" ENVIRON["VALUE"]; done = 1; next }
    { print }
    END { if (!done) print ENVIRON["KEY"] "=" ENVIRON["VALUE"] }' "$file" > "$file.tmp"
  cat "$file.tmp" > "$file"   # cat, а не mv — сохраняются владелец и права (600)
  rm -f "$file.tmp"
}

get_env() { [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | tail -n 1 || true; }

render_unit() {
  cat <<EOF
# J.A.R.V.I.S. — создано scripts/vps.sh
[Unit]
Description=J.A.R.V.I.S. — личный ассистент
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/.venv/bin/python -m jarvis
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
}

render_caddy() {
  cat <<EOF
# J.A.R.V.I.S. — создано scripts/vps.sh. Сертификат HTTPS Caddy получает и продлевает сам.
$1 {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
}

site_domain() { [ -f "$SITE_FILE" ] && awk '$2 == "{" { print $1; exit }' "$SITE_FILE" || true; }

has_tty() { (exec </dev/tty) 2>/dev/null; }

# ask VAR "Вопрос" [secret] — спросить, только если переменная ещё пуста и есть терминал
ask() {
  local var=$1 prompt=$2 secret=${3:-} answer=""
  [ -z "${!var:-}" ] || return 0
  has_tty || return 0
  if [ -n "$secret" ]; then read -rsp "$prompt" answer </dev/tty; echo; else read -rp "$prompt" answer </dev/tty; fi
  printf -v "$var" '%s' "$answer"
}

as_app() { runuser -u "$APP_USER" -- env HOME="$APP_DIR" "$@"; }

# git от root по чужому (jarvis) репозиторию — только чтение версии; safe.directory снимает запрет git
git_root() { git -c safe.directory="$APP_DIR" -C "$APP_DIR" "$@"; }

git_app() {
  local -a auth=()
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    # токен — только в заголовке этой команды, в .git/config он не попадает
    auth=(-c "http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')")
  fi
  as_app git "${auth[@]}" "$@"
}

public_ip() {
  local ip
  ip=$(curl -4 -fsS --max-time 6 https://api.ipify.org 2>/dev/null || true)
  [ -n "$ip" ] || ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }')
  printf '%s\n' "$ip"
}

# ---------- шаги установки ----------

need_root() { [ "$(id -u)" -eq 0 ] || die "Запустите от root: sudo bash $0 $*"; }

check_os() {
  [ -n "${JARVIS_ALLOW_ANY_OS:-}" ] && return 0
  # shellcheck disable=SC1091
  . /etc/os-release
  case "$ID:${VERSION_ID%%.*}" in
    ubuntu:2[4-9]|ubuntu:[3-9]?|debian:1[2-9]) ;;
    *) die "Нужна Ubuntu 24.04 или Debian 12 (сейчас: ${PRETTY_NAME:-$ID $VERSION_ID}). Переустановите ОС в панели хостинга." ;;
  esac
}

install_packages() {
  say "📦 Ставлю пакеты: python3, git, caddy…"
  apt-get update -qq
  apt-get install -y -qq python3 python3-venv git curl ca-certificates caddy >/dev/null
  python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' || die "Нужен Python 3.11+, а в системе $(python3 --version)."
}

ensure_swap() {
  local mem_mb
  mem_mb=$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo)
  if [ "$mem_mb" -lt 1500 ] && [ -z "$(swapon --show --noheadings 2>/dev/null)" ] && [ ! -f /swapfile ]; then
    say "💾 Памяти ${mem_mb} МБ — добавляю файл подкачки 1 ГБ (на случай пиков)…"
    fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile \
      && echo '/swapfile none swap sw 0 0' >> /etc/fstab || say "   ⚠️  не вышло — не страшно, продолжаю."
  fi
}

ensure_user() {
  id -u "$APP_USER" >/dev/null 2>&1 \
    || useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
  mkdir -p "$APP_DIR"
  chown "$APP_USER:$APP_USER" "$APP_DIR"
}

fetch_code() {
  local ref=$1
  if [ -d "$APP_DIR/.git" ]; then
    say "⬇️  Обновляю код ($ref)…"
    git_app -C "$APP_DIR" fetch -q origin "$ref" || die "Не удалось скачать $ref — проверьте GITHUB_TOKEN в $ENV_FILE."
    # на сервере код не правят руками: приводим к версии из GitHub (.env, data/, vault/ не трогаются)
    as_app git -C "$APP_DIR" checkout -q --force -B "$ref" FETCH_HEAD
  else
    say "⬇️  Скачиваю Jarvis ($ref)…"
    [ -z "$(ls -A "$APP_DIR")" ] || die "$APP_DIR не пуста и это не установка Jarvis — уберите её или задайте JARVIS_DIR."
    git_app clone -q --branch "$ref" "$REPO" "$APP_DIR" \
      || die "Не удалось скачать $REPO. Репозиторий приватный — нужен GITHUB_TOKEN с правом Contents: read."
  fi
}

install_python() {
  say "🐍 Ставлю зависимости Python…"
  [ -x "$APP_DIR/.venv/bin/python" ] || as_app python3 -m venv "$APP_DIR/.venv"
  as_app "$APP_DIR/.venv/bin/pip" install -q --upgrade pip
  as_app "$APP_DIR/.venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"
}

configure_env() {
  if [ ! -f "$ENV_FILE" ]; then
    cp "$APP_DIR/.env.example" "$ENV_FILE"
  fi
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  # наружу смотрит только Caddy (HTTPS); сам Jarvis слушает лишь этот сервер
  set_env "$ENV_FILE" JARVIS_HOST 127.0.0.1
  set_env "$ENV_FILE" JARVIS_PORT "$PORT"
  [ -n "$(get_env "$ENV_FILE" JARVIS_ACCESS_CODE)" ] \
    || set_env "$ENV_FILE" JARVIS_ACCESS_CODE "$(python3 -c 'import secrets; print(secrets.token_urlsafe(9))')"
  set_env "$ENV_FILE" GITHUB_TOKEN "$GITHUB_TOKEN"

  [ -n "$(get_env "$ENV_FILE" VAULT_GIT)" ] || {
    ask VAULT_GIT "Репозиторий памяти Obsidian [Enter — c4erepk0/jarvis-vault, «-» — без него]: "
    VAULT_GIT=${VAULT_GIT:-c4erepk0/jarvis-vault}
    [ "$VAULT_GIT" = "-" ] || set_env "$ENV_FILE" VAULT_GIT "$VAULT_GIT"
  }
  [ -n "$(get_env "$ENV_FILE" ANTHROPIC_API_KEY)" ] || {
    ask ANTHROPIC_API_KEY "Ключ Claude API (Enter — пропустить, Jarvis будет работать на командах): " secret
    [ -z "${ANTHROPIC_API_KEY:-}" ] || set_env "$ENV_FILE" ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
  }
  [ -n "$(get_env "$ENV_FILE" TELEGRAM_BOT_TOKEN)" ] || {
    ask TELEGRAM_BOT_TOKEN "Токен Telegram-бота для оповещений (Enter — пропустить): " secret
    if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
      ask TELEGRAM_OWNER_ID "Ваш Telegram ID (число, узнать — у @userinfobot): "
      set_env "$ENV_FILE" TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN"
      set_env "$ENV_FILE" TELEGRAM_OWNER_ID "${TELEGRAM_OWNER_ID:-}"
    fi
  }
}

install_service() {
  say "⚙️  Служба jarvis (перезапускается сама при сбое и после перезагрузки)…"
  render_unit > "$UNIT_FILE"
  systemctl daemon-reload
  systemctl enable -q jarvis
  systemctl restart jarvis
}

configure_caddy() {
  local domain=$1 main="$CADDY_DIR/Caddyfile"
  say "🔒 HTTPS: https://$domain …"
  mkdir -p "$CADDY_DIR/sites"
  render_caddy "$domain" > "$SITE_FILE"
  # стоковый Caddyfile пакета (страница-заглушка на :80) заменяем; свой — не трогаем, только подключаем сайт
  if [ ! -f "$main" ] || grep -q '^:80' "$main"; then
    printf '# Сайты — в %s/sites/*.caddy\nimport %s/sites/*.caddy\n' "$CADDY_DIR" "$CADDY_DIR" > "$main"
  elif ! grep -qF "import $CADDY_DIR/sites/" "$main"; then
    printf '\nimport %s/sites/*.caddy\n' "$CADDY_DIR" >> "$main"
  fi
  caddy validate --config "$main" --adapter caddyfile >/dev/null 2>&1 \
    || die "Caddy не принял настройки: caddy validate --config $main"
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
    ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw allow 443/udp >/dev/null
  fi
  systemctl enable -q caddy
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
}

wait_local() {
  for _ in $(seq 1 40); do
    curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && return 0
    sleep 1
  done
  journalctl -u jarvis -n 30 --no-pager 2>/dev/null || true
  die "Jarvis не запустился — строки журнала выше. Настройки: nano $ENV_FILE, затем: systemctl restart jarvis"
}

wait_https() {
  local url=$1
  for _ in $(seq 1 "$HTTPS_WAIT"); do
    curl -fsS --max-time 4 "$url/healthz" 2>/dev/null | grep -q '"jarvis"' && return 0
    sleep 1
  done
  return 1
}

check_net() {
  say "🌐 Доступ с этого сервера:"
  local name url code hint
  while IFS='|' read -r name url hint; do
    code=$(curl -s -o /dev/null --max-time 8 -w '%{http_code}' "$url" 2>/dev/null || true)
    if [ -n "$code" ] && [ "$code" != "000" ]; then say "   ✓ $name"; else say "   ✗ $name — $hint"; fi
  done <<'EOF'
GitHub (код, память, проекты)|https://api.github.com|без него не скачать код и не синхронизировать память
Telegram (оповещения)|https://api.telegram.org|оповещения — через GitHub Actions: docs/hosting.md, раздел 6
Голос edge-tts|https://speech.platform.bing.com|поставьте TTS_ENGINE=browser в .env — будет говорить голос iPhone
Погода (open-meteo)|https://api.open-meteo.com/v1/forecast?latitude=55.75&longitude=37.62&current=temperature_2m|в брифинге не будет погоды
Курсы ЦБ|https://www.cbr-xml-daily.ru/daily_json.js|в брифинге не будет курсов
EOF
}

banner() {
  local url=$1 code bar
  code=$(get_env "$ENV_FILE" JARVIS_ACCESS_CODE)
  bar="══════════════════════════════════════════════════════════"
  say ""
  say "$bar"
  say "  J.A.R.V.I.S. на сервере:  $url"
  say "  Код входа:                $code"
  say "  В Safari: открыть ссылку → код → «Поделиться» → «На экран Домой»."
  say "  Ссылка постоянная, телефон и терминал можно выключать."
  say "  Настройки: nano $ENV_FILE  →  systemctl restart jarvis"
  say "  Обновить:  bash $APP_DIR/scripts/vps.sh update"
  say "$bar"
}

# ---------- команды ----------

cmd_install() {
  need_root install
  check_os
  local existing_ref="" domain ip
  [ -d "$APP_DIR/.git" ] && existing_ref=$(git_root rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  local ref=${JARVIS_REF:-${existing_ref:-main}}
  GITHUB_TOKEN=${GITHUB_TOKEN:-$(get_env "$ENV_FILE" GITHUB_TOKEN)}
  ask GITHUB_TOKEN "Токен GitHub (тот же, что в .env на телефоне; ввод скрыт): " secret
  [ -n "${GITHUB_TOKEN:-}" ] || die "Без токена GitHub не скачать приватный репозиторий."

  install_packages
  ensure_swap
  ensure_user
  fetch_code "$ref"
  install_python
  configure_env
  install_service
  wait_local

  domain=${JARVIS_DOMAIN:-$(site_domain)}
  if [ -z "$domain" ]; then
    ip=$(public_ip)
    [ -n "$ip" ] || die "Не удалось узнать внешний IP сервера — задайте адрес: JARVIS_DOMAIN=jarvis.example.ru bash $0 install"
    domain=$(sslip_domain "$ip")
  fi
  configure_caddy "$domain"
  say "⏳ Жду сертификат HTTPS (обычно до минуты)…"
  if wait_https "https://$domain"; then
    banner "https://$domain"
  else
    banner "https://$domain"
    say "⚠️  Пока не открывается по HTTPS. Частые причины:"
    say "   • в панели хостинга закрыты порты 80 и 443 (файрвол / группа безопасности) — откройте их;"
    say "   • сертификат ещё выдаётся — подождите пару минут и откройте ссылку снова;"
    say "   • подробности: journalctl -u caddy -n 50 --no-pager"
  fi
  check_net
}

cmd_update() {
  need_root update
  [ -d "$APP_DIR/.git" ] || die "Jarvis не установлен в $APP_DIR — сначала: bash $0 install"
  GITHUB_TOKEN=${GITHUB_TOKEN:-$(get_env "$ENV_FILE" GITHUB_TOKEN)}
  local ref=${JARVIS_REF:-$(git_root rev-parse --abbrev-ref HEAD)}
  fetch_code "$ref"
  install_python
  [ ! -f "$UNIT_FILE" ] || render_unit > "$UNIT_FILE"
  systemctl daemon-reload
  systemctl restart jarvis
  wait_local
  say "✓ Обновлено: $(git_root log -1 --format='%h %s')"
}

cmd_status() {
  local domain
  domain=$(site_domain)
  say "Служба jarvis: $(systemctl is-active jarvis 2>/dev/null || true) · caddy: $(systemctl is-active caddy 2>/dev/null || true)"
  [ -z "$domain" ] || say "Адрес: https://$domain   Код входа: $(get_env "$ENV_FILE" JARVIS_ACCESS_CODE)"
  [ ! -d "$APP_DIR/.git" ] || say "Версия: $(git_root log -1 --format='%h %s (%cr)' 2>/dev/null || true)"
  journalctl -u jarvis -n 15 --no-pager 2>/dev/null || true
}

case "${1:-install}" in
  install) cmd_install ;;
  update) cmd_update ;;
  status) cmd_status ;;
  logs) exec journalctl -u jarvis -f ;;
  check) check_net ;;
  # для тестов
  _sslip) sslip_domain "$2" ;;
  _set-env) set_env "$2" "$3" "$4" ;;
  _get-env) get_env "$2" "$3" ;;
  _render-unit) render_unit ;;
  _render-caddy) render_caddy "$2" ;;
  -h|--help|help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "Неизвестная команда «$1». Есть: install, update, status, logs, check." ;;
esac
