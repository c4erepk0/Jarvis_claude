# Jarvis — контекст для разработки

Этот файл читают Claude Code и `@claude` в GitHub. При заметных изменениях — обновляйте.

## Что это
Личный ассистент владельца (@c4erepk0): голос + HUD-дашборд в духе фильма «Железный человек»,
память в хранилище Obsidian (markdown), проекты (IPAStore и др.), задачи, финансы.
Интерфейс, тексты, комментарии, README и описания PR — **на русском**.

## Стек
Python 3.11+ · aiohttp (веб + WebSocket) · anthropic SDK (Claude) · edge-tts · psutil.
Без ORM и баз: **всё состояние — файлы в хранилище Obsidian** (+ `data/` для служебного).
Фронтенд — ES-модули без сборки (`jarvis/webapp/`), Three.js/MediaPipe — с CDN, только для голограммы.

## Структура
- `jarvis/__main__.py` — запуск, засев пустого хранилища из `vault-template/`.
- `jarvis/config.py` — настройки из `.env`. Новая настройка → `config.py` + `.env.example` + README.
- `jarvis/core.py` — класс `Jarvis`: все действия `act_*`, очередь подтверждений, `handle()` — главный вход.
- `jarvis/intents.py` — локальный разбор русских команд; `jarvis/ru.py` — даты, суммы, склонения.
- `jarvis/brain.py` — Claude: инструменты, append-only история, `fallbacks="default"`, отказ (`refusal`).
- `jarvis/llm.py` — тот же мозг на GigaChat / YandexGPT (`JARVIS_LLM`): перевод формата функций, OAuth GigaChat,
  сертификат Минцифры (`jarvis/certs/`) — только для запросов GigaChat. Тест — `tests/test_llm.py`, инструкция —
  `docs/brain.md`. В JS-ядро для iPhone не перенесено намеренно: из браузера к этим API не обратиться.
- `jarvis/protocols.py` — протоколы (встроенные + `Jarvis/Protocols.md`).
- `jarvis/vault.py` — безопасные пути, атомарная запись, frontmatter, поиск, граф, наблюдение за изменениями.
- `jarvis/tasks.py` (формат Obsidian Tasks) · `jarvis/finance.py` (таблицы по месяцам, копейки) · `jarvis/memory.py`.
- `jarvis/projects.py` + `jarvis/github.py` — статус, задачи для @claude, локальный Claude Code, деплой.
- `jarvis/web.py` — REST + WebSocket + вход; `jarvis/hub.py` — шина событий; `jarvis/watchers.py` — фоновые датчики.
- `jarvis/voice.py` (TTS), `jarvis/telegram.py`, `jarvis/briefing.py` (погода, курсы), `jarvis/diagnostics.py`.
- `jarvis/webapp/` — `index.html`, `static/{app,reactor,voice,hologram}.js`, `app.css`, `sw.js`.
- `static/note-panel.js` — заметка в голограмме: просмотр, правка, новая, [[ссылки]], галочки задач; рендер —
  `static/markdown.js` (сначала экранирование, тест — `tests/js/markdown.test.mjs`). Сохранение — с версией
  (`content_version` / `contentVersion`, одинаковые в Python и JS): PUT /api/note с `base`, при чужой правке — 409.
  Голограмма: `highlight`, `focus`, `setInset`; событие `open_note` открывает заметку на всех дашбордах.
- `static/gestures.js` — распознавание жестов по точкам руки MediaPipe (указка, щипок, ладонь, ✌, 👍, ✊), эталонные
  позы и `GestureTracker` (удержание позы, взмах ладонью); `static/gesture-coach.js` — шаги обучения жестам
  (без DOM, тест — `tests/js/gestures.test.mjs`; `TRAINING_VERSION` — обученным раньше показываются только новые шаги);
  `static/gesture-tutorial.js` — окно обучения. `static/note-gestures.js` — что делает жест с заметкой в каждом режиме
  панели (`noteAction`), история для взмаха (`Trail`), диктовка строки (`insertDictation`); без DOM, тест — там же.
  Голограмма сообщает распознанное через `holo.gestureListeners` (`frame`, `rotate`, `zoom`, `reset`, `dwell`, `select`,
  `press`, `hold`, `pose`, `swipe`, `scroll`, `command`), а действие жеста спрашивает у панели (`gestureAction`).
  Палец «нажимает» элементы `AIR_TARGETS` в `hologram.js` (кнопки, задачи и ссылки заметки, всё с `data-air`).
  В жестах нет `confirm()`: он останавливает камеру — опасное подтверждается повтором жеста.
  Пороги распознавания — **в долях размера руки** (`handSize`), не кадра. Меняете их — проверяйте на реальных руках:
  `tests/js/fixtures/hands-hagrid.json` (точки MediaPipe на кадрах HaGRID, тест «реальные руки»); нарисованные
  эталоны проходят почти при любых порогах. Распознанное видно на окошке камеры («вижу: …»); жест, которому сейчас
  нечего делать, показывает подсказку (`noteHint`), а не молчит.
- `static/gaze.js` — управление взглядом без DOM (тест — `tests/js/gaze.test.mjs`): `gazeFeatures` (v3, `FEATURE_VERSION`) —
  **только глаза**: x — радужки, eyeLook, поворот лица; y — радужки, eyeLook, открытость глаз, blink/wide, наклон лица
  (`SPLIT`, модель по осям — `SplitModel`). Положение головы (матрица MediaPipe) в признаки не входит: на калибровках
  владельца оно коррелировало с точкой экрана по-разному в каждой сессии, и модель «ломалась» в новой (300–500 px).
  Сдвиг сессии и позы убирают **привязка** (`Calibration` mode `anchor`, 3 точки → `AdaptiveGaze.anchor`) и
  **поправка по каждому щипку** (`AdaptiveGaze.learn`, `LIVE_ALPHA` = 0,6 — подобрано на записях). Темп калибровки:
  замер только когда взгляд устоялся (`settleMs`…`settleMaxMs`, `STEADY`). `headPose` — для подсказки «поза другая».
  `OneEuro2D` (сглаживание), `pickTarget` (магнит к целям). `static/gaze-calibration.js` — окно калибровки и привязки;
  модель хранится в localStorage (`jarvis.gaze_model`), при включении взгляда — привязка.
  В голограмме: `startGaze` / `stopGaze` / `setGazeModel`, цели магнита — `AIR_TARGETS` и узлы графа вне панелей;
  нажатие — событие `tap` от `GestureTracker` (короткий щипок, сдвиг < `DRAG`); сам взгляд ничего не нажимает.
  Курсор — там, куда смотрят; магнит (`pickTarget`, сила `MAGNET_LEVELS`, по умолчанию слабый) только выбирает цель.
  **Записи взгляда**: калибровки (`Calibration.toSession`) и журнал нажатий — «сырые» точки глаз и лица
  (`packFrame`, без фото) → `POST /api/gaze` (`jarvis/gaze.py`, то же в `core/jarvis.js`) → `Jarvis/Gaze/{sessions,usage}`.
  Анализ — `scripts/gaze_eval.mjs` (признаки пересчитываются из сырых точек; «в работе» — проверочные точки как поток
  нажатий с поправкой). **Записи владельца — в его хранилище**, не в этом (публичном) репозитории: тест
  `gaze-sessions.test.mjs` читает их из `$JARVIS_GAZE_DIR` или клона `../jarvis-vault`, образец точности — цифры —
  `tests/js/fixtures/gaze/baseline.json`. Меняете признаки или модель — сравните отчёт до и после, обновите baseline
  (`--baseline`), только если стало лучше.
- `jarvis/webapp/static/core/*.js` — **ядро для режима «только iPhone»**: порт Python-ядра (ru, vault,
  tasks, finance, memory, intents, brain, projects, protocols, jarvis). Отвечает на те же `/api/…`, что сервер.
  Память — `GitHubStore` (приватный репозиторий с хранилищем, кэш блобов по sha), Claude — официальный
  JS SDK с CDN (`dangerouslyAllowBrowser`, ключ только на устройстве). `static/standalone.js` — настройки,
  выбор склада, засев хранилища. **Меняете логику или формат заметок в Python — меняйте и здесь** (и наоборот).
- `jarvis/cron.py` + `.github/workflows/jarvis-cron.yml` — оповещения в Telegram без сервера (раз в 15 мин).
- `jarvis/gitsync.py` — хранилище в GitHub-репозитории для сервера (`VAULT_GIT`): clone, слияние `*.md merge=union`,
  push; токен — только в заголовке команды, не в .git/config.
- `jarvis/tunnel.py` — `python -m jarvis --tunnel` / `bash start.sh --tunnel`: Cloudflare Quick Tunnel →
  localhost.run → pinggy; код входа создаётся сам. За туннелем Origin сверяется и с `X-Forwarded-Host`.
- `scripts/vps.sh` — установка на VPS (Ubuntu 24.04 / Debian 12): systemd-служба `jarvis`, Caddy с HTTPS
  на `<ip>.sslip.io`, `install|update|status|logs|check`; тест — `tests/test_vps.py`, инструкция — `docs/hosting.md`.
- `.github/workflows/pages.yml` — публикация дашборда для iPhone на GitHub Pages.
- `static/vault-template.json` — генерируется `scripts/build_template.py` из `vault-template/` (CI проверяет).
  **При изменении css/js поднимайте `?v=N` в `index.html`, `app.js` и `sw.js` (CACHE)**.
- `vault-template/` — стартовое хранилище. `sync/` и `docs/sync.md` — LiveSync (CouchDB + мост) и Syncthing.

## Правила
- Работа — в ветках и через PR в `main`; CI зелёный (`make check`).
- Каждая новая функция — с тестом: Python — `tests/`, ядро для iPhone — `tests/js/*.test.mjs`
  (`node --test`; фейковые Claude и GitHub — в `tests/js/jarvis.test.mjs`).
- Деньги — в копейках (int). Даты в заметках — ISO `YYYY-MM-DD`.
- Писать в хранилище только через `Vault` (проверка путей, атомарная запись). Не ломать формат заметок:
  их правит человек в Obsidian.
- Внешние/необратимые действия — только через `ask_confirm()` (подтверждение владельца).
- История разговора с Claude только дописывается; системный промпт и набор инструментов неизменны в
  пределах разговора (кэш и preserved thinking). Время и служебное — в начало сообщения пользователя.
- Не коммитить `.env`, `data/`, `vault/`, `sync/livesync/config.json`.
- Зависимости — точные версии в `requirements.txt`.

## Команды
```bash
make dev / make test / make lint / make check / make run
python -m pytest tests/test_commands.py -q   # один набор
node --test tests/js/*.test.mjs              # ядро для iPhone
```
