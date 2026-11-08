# Синхронизация Obsidian в реальном времени — бесплатно

Память Jarvis — обычная папка с markdown-заметками (хранилище Obsidian). Jarvis следит за ней
каждые 1,5 секунды и сразу обновляет все открытые дашборды через WebSocket. Остаётся доставить
эту папку на ваши устройства. Платный Obsidian Sync не нужен — вот бесплатные варианты.

| Вариант | Реальное время | iPhone | ПК / Mac | Android | Нужен сервер |
|---|---|---|---|---|---|
| **Self-hosted LiveSync** (рекомендуется) | да, секунды | да | да | да | да (CouchDB, в `docker compose`) |
| Syncthing | да, секунды | нет бесплатного клиента | да | да | нет (P2P) |
| iCloud Drive | почти (до минуты) | да | Mac, Windows | нет | нет |
| Git (плагин Obsidian Git) | нет, раз в N минут | да | да | да | GitHub |

## 1. Self-hosted LiveSync (iPhone + ПК + сервер)

Схема: **Obsidian на iPhone/ПК ⇄ CouchDB ⇄ мост livesync-bridge ⇄ папка `vault/` ⇄ Jarvis ⇄ дашборды.**
Плагин Obsidian [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) бесплатный и
открытый, работает на iOS. Мост [livesync-bridge](https://github.com/vrtmrz/livesync-bridge) — от того же
автора; он держит папку хранилища Jarvis и базу CouchDB в синхроне в обе стороны.

### На сервере (там же, где Jarvis)

```bash
cp .env.example .env
# в .env: JARVIS_ACCESS_CODE, COUCHDB_PASSWORD (длинный случайный), при желании LIVESYNC_PASSPHRASE
make livesync-config            # создаст sync/livesync/config.json для моста
docker compose --profile livesync up -d
```

`sync/couchdb/local.ini` уже содержит настройки, которые требует плагин: обязательный вход, CORS для
`app://obsidian.md` и `capacitor://localhost` (iPhone), большие документы. База (`LIVESYNC_DB`, по
умолчанию `jarvis`) создаётся плагином при первой настройке.

### HTTPS для телефона

iPhone подключается к CouchDB только по HTTPS. Бесплатные способы:

- **Tailscale** (проще всего, ничего не открывается в интернет): установите Tailscale на сервер и iPhone,
  затем на сервере:
  ```bash
  tailscale serve --bg --https=443  http://127.0.0.1:8765   # дашборд Jarvis
  tailscale serve --bg --https=8443 http://127.0.0.1:5984   # CouchDB для LiveSync
  ```
  Адреса: `https://<имя-сервера>.<ваш-tailnet>.ts.net` и `…ts.net:8443`.
- **Cloudflare Tunnel** — если нужен публичный адрес на своём домене без VPN на телефоне.

### В Obsidian

1. На компьютере: Настройки → Сторонние плагины → найти **Self-hosted LiveSync** → установить, включить.
2. Мастер настройки → «Настроить вручную»: URI `https://…ts.net:8443`, пользователь `COUCHDB_USER`,
   пароль `COUCHDB_PASSWORD`, база `jarvis`. Если задали `LIVESYNC_PASSPHRASE` — включите сквозное
   шифрование с тем же паролем (и `LIVESYNC_OBFUSCATE=1`, если включили «Obfuscate paths»).
3. Режим синхронизации — **LiveSync**. Нажмите «Проверить» — плагин сам поправит настройки базы.
4. Скопируйте **Setup URI** (Команды → «Copy setup URI») и откройте его на iPhone в Obsidian —
   плагин настроится сам.

Готово: заметка, поправленная на iPhone, появляется на дашборде Jarvis через пару секунд, а задача,
добавленная голосом, — в Obsidian на телефоне.

> Важно: мост и все устройства должны использовать одинаковые настройки чувствительности имён к регистру
> и нормализации путей. Если что-то не синхронизируется — смотрите `docker compose logs livesync-bridge`
> и раздел «Path identity compatibility» в README моста.

## 2. Syncthing (ПК, Mac, Android, сервер)

```bash
docker compose --profile syncthing up -d
ssh -L 8384:127.0.0.1:8384 сервер      # веб-интерфейс Syncthing: http://localhost:8384
```
В интерфейсе добавьте папку `/var/syncthing/vault` и подключите свои устройства (на них — Syncthing
или Syncthing-Fork для Android). Синхронизация прямая, без облака, за секунды.

## 3. iCloud Drive (Mac + iPhone, без сервера)

Если Jarvis работает на Mac: создайте хранилище в Obsidian на iPhone в iCloud, а в `.env` укажите
```
VAULT_PATH=~/Library/Mobile Documents/iCloud~md~obsidian/Documents/<Имя хранилища>
```

## 4. Git

Плагин Obsidian Git с автокоммитом раз в минуту и закрытый репозиторий на GitHub. Не реальное время,
зато история версий. На сервере Jarvis — `git pull` по cron.
