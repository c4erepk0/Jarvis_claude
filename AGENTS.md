# AGENTS.md — вход в проект за пять минут

Этот файл читают агенты (Claude Code, `@claude`, Cursor, Codex) и люди, которые впервые открыли репозиторий.
Задача — дать контекст и поднять рабочую среду одной командой, без чтения 34 КБ README.

Правила веток и PR — [CONTRIBUTING.md](CONTRIBUTING.md). Полная карта модулей — [CLAUDE.md](CLAUDE.md).

## Если есть 30 секунд

- **Atom** (внутри кода — `jarvis`) — личный ассистент владельца: голос, дашборд, память в Obsidian, проекты,
  задачи, финансы, операторы. Язык интерфейса, текстов и PR — **русский**.
- **Состояние — только файлы**: markdown в хранилище Obsidian (`vault/`) и `data/` для служебного. Базы и ORM нет.
- **Два режима**: сервер на Python (aiohttp) и «только iPhone» — порт ядра на JS в
  `jarvis/webapp/static/core/`. Меняете правила в Python — меняйте и там (и наоборот).
- **Всё новое** — ветка + PR в `main`, CI (`make check`) зелёный. `main` = выпущенное состояние.
- **Секреты** — только `.env` (и `data/settings.json` для настроек из интерфейса). В заметки, код и тесты их не кладут.

## Поднять среду

```bash
git clone https://github.com/c4erepk0/Jarvis_claude && cd Jarvis_claude
bash scripts/bootstrap.sh          # .venv, зависимости, .env, проверка
```

Скрипт идемпотентен: повторный запуск ничего не ломает. Что делает:

1. проверяет Python ≥ 3.11 и что есть `venv`;
2. создаёт `.venv` и ставит `requirements-dev.txt` (точные версии, как в CI);
3. если `.env` нет — копирует `.env.example` и напоминает, что ключи нужно вписать самому;
4. гоняет короткий набор тестов, чтобы убедиться, что среда живая;
5. печатает, что делать дальше.

Дальше:

```bash
make run            # запустить Atom на http://127.0.0.1:8765
make check          # lint + test + audit — то же, что CI
make test           # pytest + node --test (ядро для iPhone)
make help           # все команды
```

Без `make` (например, на Windows без Git Bash): `.venv/bin/python -m pytest -q` и
`.venv/Scripts/python.exe -m pytest -q` соответственно.

`.env` нужен только чтобы запускать: для тестов и линта он не требуется. Минимум для живого Atom —
ключ одного мозга (`ANTHROPIC_API_KEY` или `DEEPSEEK_API_KEY`), остальное по желанию, см. `.env.example`.

### Платформы

| Где | Как | Что учесть |
|---|---|---|
| macOS / Linux | `bash scripts/bootstrap.sh` | основной путь; `start.command` / `start.sh` поднимают сервер |
| Windows | Git Bash или WSL, затем тот же скрипт | `start.bat` для запуска; пути с пробелами — в кавычках |
| Docker | `docker compose up` | профили синхронизации — `docs/sync.md` |
| VPS | `bash scripts/vps.sh install` | Ubuntu 24.04 / Debian 12, systemd + Caddy, `docs/hosting.md` |
| iPhone (без сервера) | ничего ставить не нужно | режим «только iPhone»: статика на GitHub Pages, `docs/iphone.md` |
| iOS-песочница агента | `python3` есть, `venv` есть | `aiohttp` не собирается: нет компилятора. Полный `pytest` там не идёт — проверяйте `py_compile`, `flake8`, `node --test` и полагайтесь на CI |

## Проверки

| Команда | Что проверяет |
|---|---|
| `make lint` | flake8 (Python) + shellcheck (`start.sh`, `start.command`, `scripts/vps.sh`) |
| `make test` | pytest (`tests/`) + `node --test tests/js/*.test.mjs` |
| `make audit` | `pip-audit` по `requirements.txt` |
| `make check` | всё вместе — ровно то, что требует CI |

Один набор: `.venv/bin/python -m pytest tests/test_operators.py -q`.
Тесты не ходят в сеть: фейковые Claude, GitHub, котировки и погода — в `tests/conftest.py`.

## Правила, за которые PR вернут

- **Тест к каждой новой функции.** Python — `tests/`, ядро для iPhone — `tests/js/*.test.mjs`.
- **Паритет Python ↔ JS-ядро.** Логика и формат заметок в `jarvis/*.py` и
  `jarvis/webapp/static/core/*.js` должны совпадать; фикстуры (`tests/js/fixtures/`) пересобираются,
  если правила поменялись.
- **`?v=N` при правке css/js — во всех импортах.** Один номер во всех `?v=` внутри `jarvis/webapp/`
  и `V` в `sw.js`; сверяет `tests/js/assets-version.test.mjs`. Поднять только у входа (`app.js`) недостаточно:
  модули по старому URL останутся в кэше браузера, и изменение увидят наполовину.
- **Новая настройка — три места:** `jarvis/config.py`, `.env.example`, README.
- **Деньги — в копейках (int), даты — ISO `YYYY-MM-DD`.**
- **Писать в хранилище только через `Vault`** (`jarvis/vault.py`): проверка путей, атомарная запись.
  Формат заметок не ломать — их правит человек в Obsidian.
- **Внешние и необратимые действия** (деплой, отправка, удаление) — через `ask_confirm()`.
- **Секреты — наружу** только маской (`settings.mask()`), токены в логи не пишем.

## Карта

```
jarvis/                  сервер: core.py — действия, web.py — API, brain/llm — модели
  webapp/static/          фронтенд без сборки; core/ — порт ядра для iPhone
  vault.py notes.py       хранилище и заметки; tasks.py finance.py — форматы
  operators.py            операторы, права, приглашения
  gdrive.py               коннектор Google Drive (см. docs/drive.md)
docs/                    iphone, hosting, sync, brain, branches, drive
vault-template/          стартовое хранилище (генерируется в static/vault-template.json)
tests/                   pytest; tests/js — node --test
scripts/                 bootstrap, vps, gaze_eval, build_template, livesync_config
.github/workflows/       CI, Pages, cron, @claude
```

## Куда положить свою правку

| Задача | Файлы |
|---|---|
| Новая голосовая команда | `jarvis/intents.py` (+ `core/intents.js`), тест в `tests/test_commands.py` |
| Новое действие Atom | `act_*` в `jarvis/core.py`, маршрут в `jarvis/web.py`, тест |
| Новая настройка | `jarvis/config.py` → `.env.example` → README |
| Новый экран / окно | `webapp/static/<окно>.js` + `app.js` + `app.css` + `?v=N` |
| Работа с внешним сервисом | отдельный модуль `jarvis/<сервис>.py` с внедряемым транспортом, чтобы тесты шли без сети |
| Права оператора | `jarvis/operators.py` (валидация) + `core.py` (доступ) + `web.py` (API) + `team-admin.js` (панель) |

## Грабли

- **Не путать имена.** Пакет `jarvis`, переменные `JARVIS_*`, класс `Jarvis`, папка `Jarvis/` в хранилище —
  так исторически, ради совместимости. В текстах для человека — «Atom» / «Атом».
- **`CLAUDE.md` — тоже документация.** Меняли структуру заметно — обновите строку в карте, иначе следующий
  агент будет искать модуль, которого уже нет.
- **Не запускайте `make dev` на iOS-песочнице**: `aiohttp` требует компилятор. Там достаточно `python3`.
- **В iOS-песочнице не гоняйте весь `pytest` разом** (особенно `tests/test_web.py`): процесс приложения может
  не выдержать нагрузки и упасть вместе с ходом работы. Проверяйте точечно — `pytest tests/test_gdrive.py -q` —
  а полный набор оставьте CI: он и есть арбитр.
- **`git rebase` в этой истории не используется**: ветка подтягивает `main` через `merge`.
