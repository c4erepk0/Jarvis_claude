# Atom — контекст для разработки

Этот файл читают Claude Code и `@claude` в GitHub. При заметных изменениях — обновляйте.

## Что это
Личный ассистент владельца (@c4erepk0) — **Atom** (бывший Jarvis): голос + дашборд (тёплый графит с красным
акцентом; спокойный стиль без «HUD-клише» — без сканлайнов, неона и уголков-прицелов, шрифт Manrope, заголовки обычным
регистром), память в хранилище Obsidian (markdown), проекты (IPAStore и др.), задачи, финансы.
Интерфейс, тексты, комментарии, README и описания PR — **на русском**.
Внутренние имена после ребрендинга прежние (пакет `jarvis`, `JARVIS_*`, класс `Jarvis`, папка `Jarvis/` в хранилище) —
ради совместимости с установками; в текстах для человека — «Atom» / «Атом».

## Стек
Python 3.11+ · aiohttp (веб + WebSocket) · anthropic SDK (Claude) · edge-tts · psutil.
Без ORM и баз: **всё состояние — файлы в хранилище Obsidian** (+ `data/` для служебного).
Фронтенд — ES-модули без сборки (`jarvis/webapp/`); с CDN — Three.js (голограмма, ядро, 3D-графики), MediaPipe (жесты, взгляд), MapLibre GL (карта).

## Структура
- `jarvis/__main__.py` — запуск, засев пустого хранилища из `vault-template/`.
- `jarvis/config.py` — настройки из `.env`. Новая настройка → `config.py` + `.env.example` + README.
- `jarvis/core.py` — класс `Jarvis`: все действия `act_*`, очередь подтверждений, `handle()` — главный вход.
- `jarvis/intents.py` — локальный разбор русских команд; `jarvis/ru.py` — даты, суммы, склонения.
- `jarvis/brain.py` — Claude: инструменты, append-only история, `fallbacks="default"`, отказ (`refusal`).
- `jarvis/llm.py` — тот же мозг на GigaChat / YandexGPT / DeepSeek (`JARVIS_LLM`; незнакомое имя не роняет запуск): перевод формата функций, OAuth GigaChat,
  сертификат Минцифры (`jarvis/certs/`) — только для запросов GigaChat. Тест — `tests/test_llm.py`, инструкция —
  `docs/brain.md`. В JS-ядро для iPhone не перенесено намеренно: из браузера к этим API не обратиться.
- `jarvis/models.py` — **выбор модели**: каталог по провайдерам, список подключённых (`Config.llm_ready`), подписи;
  `Brain.select` меняет модель без перезапуска (новый разговор с резюме), выбор — `data/settings.json` `brain`,
  ошибка ключа — `Brain.health`. `GET/POST /api/brain`, состояние — `backend`/`model_label`. Кнопка под строкой
  команды — `static/brain-picker.js` (без DOM — `groupOptions`/`buttonView`, тест — `tests/js/brain-picker.test.mjs`);
  JS-ядро — `core/models.js` (только Claude). У Haiku — без `fallbacks` и поиска. Тест — `tests/test_models.py`.
- `jarvis/protocols.py` — протоколы (встроенные + `Jarvis/Protocols.md`).
- `jarvis/vault.py` — безопасные пути, атомарная запись, frontmatter, поиск, граф, наблюдение за изменениями.
- `jarvis/tasks.py` (формат Obsidian Tasks) · `jarvis/finance.py` (таблицы по месяцам, копейки; `analytics()` —
  динамика, категории к среднему, регулярные платежи, частые операции, выводы) · `jarvis/memory.py`.
- `jarvis/assets.py` — активы и долги (`Finance/Assets.md`), котировки без ключей (`Quotes`: Мосбиржа ISS, CoinGecko,
  ЦБ; в тестах — фейк из `conftest.py`), оценка имущества по виду (`PROPERTY`), долги из проектов с тегом `долг`,
  история капитала (`Finance/Capital.md`). `GET /api/finance/analytics`, `GET/POST /api/finance/assets`, интенты
  `finance_analytics`, `assets_report`, инструменты Claude с теми же именами. JS — `core/finance.js` (`analytics`),
  `core/assets.js`; ответ обязан совпадать с Python: общий `tests/js/fixtures/finance.json`
  (`REGEN_FIXTURES=1 python -m pytest tests/test_assets.py`). Окно — `static/finance.js`, графики — `static/fin-charts.js`.
- `jarvis/apps.py` — каталог приложений: проекты с `catalog: true` и заметки `type: app` (`url`, `icon`, `repo`);
  `GET/POST /api/apps`, JS — `core/apps.js`. **MK·II: карта, финансы, хранилище, граф, команда и настройки — встроенные
  приложения каталога**, не панели главной: окно `static/apps-window.js` (#aw, кнопка ⊞ и вкладка «Приложения» нижней
  навигации), список и поиск без DOM — `static/apps-catalog.js` (`BUILTIN`, `launcherItems`; тест —
  `tests/js/apps-catalog.test.mjs`), своё https-приложение открывается внутри Atom — `static/app-viewer.js` (#av,
  iframe; CSP `frame-src https:`, для разработки — http://localhost). На главной — три колонки: задачи, ядро, проекты.
  **Мост с приложением** — `static/app-bridge.js` (postMessage, протокол `atom-app/1`, принимается только от окна
  приложения и с его origin; тест — `tests/js/app-bridge.test.mjs`): `download` — готовый файл, Atom показывает своё
  окно «Файл готов» (во встроенной странице iPhone не даёт скачать и вызвать «Поделиться»); `store:set` / `store` —
  **общие данные приложения** (`jarvis/appdata.py`: `data/appdata/<sha1>.json`, 5 прошлых версий, до 12 МБ, кто
  последний — тот прав) у владельца (`/api/appdata`) и операторов с доступом к приложению (`/api/op/appdata`);
  изменения — событие WS `appdata` (оператору — только по своим приложениям). Тест — `tests/test_appdata.py`.
  Со стороны приложения мост встроен в «Ценники» (`c4erepk0/cenniki`, раздел «Atom» в `index.html`).
- **Настройки и диагностика** — `jarvis/settings.py` (`data/settings.json`, права 600: известные ключи `KNOWN`, свои
  токены, SSH-серверы, автообновление; `apply_saved_env()` в `__main__` до `load_config` — значения из интерфейса
  главнее `.env`, вступают в силу после перезапуска; не подошли — запуск без них, `safe_mode` в `/api/system`; секреты наружу — только `mask()`), `jarvis/updater.py`
  (`git fetch` + `merge --ff-only`, `pip install` при смене requirements.txt, отказ при локальных правках; ручное
  обновление — через `ask_confirm("update")`, авто — `Jarvis.auto_update_loop`), перезапуск — `request_restart()` →
  `os.execv` в `__main__`. API — `/api/system`, `/api/system/{settings,ssh,update,restart}` (только владелец).
  Окно — `static/system.js` (#sysw, ⚙). Тест — `tests/test_system.py`.
- **Глобус** — анализатор новостей и тактический инвестор (приложение каталога, `server: true`): `jarvis/news.py` —
  ленты RSS/Atom без ключей (`DEFAULT_FEEDS`: BBC, Al Jazeera, РИА, ТАСС, Интерфакс; свои — `NEWS_FEEDS`) и сейсмика
  USGS; разбор без модели — место (`PLACES_RAW`: основы слов ru+en, «=слово» — точное, фраза важнее слова), вид
  (`CATEGORY_WORDS`), влияние на рынки (`MARKET_RULES`: группы основ + исключения), явный прогноз (`FORECAST`);
  экономический маркер = прогноз + рынок, такие сигналы пишутся в `Jarvis/News/Сигналы.md`. `pressure`/`tactics` —
  давление на рынки (`MARKETS`, затухание 12 ч, окно 48 ч) и позиции владельца (`exposure` по Finance/Assets.md);
  «не инвестиционная рекомендация». `NewsDesk` — кэш `data/news.json`; опрос — `Watchers.news_tick` (`NEWS_INTERVAL`),
  новые маркеры — событие WS `news`, сильный прогноз по вашим активам — `alert` (`NEWS_ALERTS`). API — `GET /api/news`,
  `POST /api/news/{refresh,brief}` (разбор — через `brain.ask`), интент `news` («что на рынках», «открой глобус»).
  Окно — `static/globe.js` (#gw, Canvas 2D: земля из частиц, шипы-маркеры, дуги к биржам, лента/тактика/рынки),
  геометрия без DOM — `static/globe-geo.js` (контуры суши `LAND`/`HOLES`, `spherePoints`, `project`, `arc`, `pick`).
  Тесты — `tests/test_news.py`, `tests/js/globe.test.mjs`. В JS-ядро для iPhone не перенесено намеренно (CORS лент).
- **Карта и навигация** — `static/map.js` (окно `#mw`, приложение «Карта» в каталоге, событие `open_map`): MapLibre GL
  4.7.1 с CDN (UMD + CSS), открывается на текущем месте (геолокация; без неё — последний вид или `WORLD`), без привязки
  к городу; подложки OpenFreeMap / CARTO dark / Esri, 3D-здания (свой слой `atom-3d`, если в стиле нет `building-3d`),
  поиск Photon (рядом с центром карты), «Что здесь?» Nominatim, маршруты OSRM (routing.openstreetmap.de:
  авто/пешком/велосипед, альтернативы, шаги), навигация по GPS с голосом и перестроением (симуляции нет), «Рядом»
  (Overpass), линейка, «поделиться»; `places: false` — без сохранённых мест (кабинет оператора). Без ключей; хосты —
  `MAP_HOSTS` в CSP `web.py`.
  Логика без DOM — `static/geo.js` (тест — `tests/js/geo.test.mjs`). Места — `jarvis/places.py` (`Jarvis/Places.md`),
  `GET/POST /api/places`, JS — `core/places.js`; голос — интент `map` (`map_intent` / `mapIntent`), тест — `tests/test_places.py`.
- **Операторы** — `jarvis/operators.py`: владелец (корень) и операторы-люди. Учётки, хэши паролей и приглашений,
  сессии — `data/operators.json` (не в хранилище: оно синхронизируется), переписка — `Jarvis/Chat/<Имя>.md`, личная папка
  оператора — `Команда/<Имя>/` (заметки и `Задачи.md`; личные задачи операторов не попадают в списки владельца —
  `TaskBook(skip=…"Команда/")`, у оператора — `TaskBook(only=…)`). Вход (`Auth` в `web.py`): cookie
  «роль.кто.устройство.срок.подпись» — устройство (sid) — запись в `sessions`, её можно завершить (`/api/sessions`,
  владелец — и чужие: `/api/admin/operators/{id}` `sessions`/`revoke`); старая «срок.подпись» — владелец до «выйти везде».
  Первый запуск (`/api/setup`), приглашение по одноразовой ссылке `/?invite=…` — оператор задаёт пароль
  (`/api/invite/accept`), дальше входит по имени и паролю (`/api/op-login`). Оператору сервер открывает только
  `/api/op/…` (+ `/api/session`, `/api/logout`, `/api/sessions`, `/ws`), события WebSocket — только его
  (`ws.atom_filter` в `hub.py`); права — `PERMS` (все задачи, все встречи, задачи в общие проекты), проекты — только
  общие (`projects`), **приложения** — `apps` [{id: путь заметки приложения | `builtin:map`, level: use|manage}]
  (`/api/op/apps`; manage — правка заметки приложения и задачи его проекта), **доверенные заметки** — `notes`
  [{path: заметка или папка, edit}] (`Jarvis.op_access` / `op_trusted`, `/api/op/notes` → `shared`, правка через
  `/api/op/note` с версией; новые и корзина — только в своей папке). Без пароля владельца приглашать нельзя. Раздел владельца —
  `/api/admin/…`, окно «Команда» `static/team-admin.js` (вкладка «Доступ»: права, проекты, приложения, доверенные заметки); кабинет оператора — `static/operator-app.js`; без DOM —
  `static/team.js`. Только сервер (в JS-ядре для iPhone операторов нет намеренно). Тесты — `tests/test_operators.py`,
  `tests/js/team.test.mjs`.
- **«Диск ядра»** — `jarvis/gdrive.py`: Google Drive только на чтение (refresh-токен, право `drive.readonly`).
  Список файлов без папок, документы Google — экспорт в markdown, текстовые — как есть; наружу уходят только
  `id/имя/вид/размер/дата` — ни владельцев файла, ни почты аккаунта, ни путей (белый список в `Drive._item`).
  Владелец отмечает файлы оператору: «Команда» → «Доступ» → «Диск ядра» (`drive: [{id, name, level: view|copy}]`
  в `operators.py`); оператор видит их вкладкой «Диск», «копия» кладёт заметку в `Команда/<Имя>/Диск/`.
  API — `GET /api/gdrive` (владелец), `GET/POST /api/op/drive[/{id}]` (оператор); окна `team-admin.js`,
  `operator-app.js`. Настройки — `GDRIVE_*` (`config.py`, `.env.example`), инструкция — `docs/drive.md`,
  тест — `tests/test_gdrive.py`. Только сервер: в JS-ядре для iPhone Диска нет.
- **Встречи и поручения** — `jarvis/meetings.py` (+ `core/meetings.js`): обычные задачи Obsidian Tasks, встреча —
  тег `#встреча`, время `🕒 15:00`, место `📍 …`; поручение — тег `#оператор/<имя>`. Отметить «состоялась» — выполнить
  задачу. `GET /api/meetings`, `POST /api/admin/assign`, интент `meetings` («встречи на завтра»), панель «Встречи».
- `jarvis/notes.py` — менеджер заметок: индекс хранилища (`/api/files`), теги, обратные ссылки, шаблоны
  (`Templates/`), перенос/переименование с правкой `[[ссылок]]`, корзина `.trash/` (как в Obsidian); то же —
  `core/notes.js`. Тест — `tests/test_files.py` и `tests/js/files.test.mjs`.
- `jarvis/synthesis.py` — умный синтез проектов без модели: по индексу (`Notes.index()` — теги, `links`, папки, `type`)
  какие заметки относятся к проектам и что похоже на неоформленный проект (type: project, тег, папка, узел ссылок);
  `highlight` — подсветка в дереве (`markSynthesis` в `file-tree.js`), графе и вкладке «СИНТЕЗ» `files.js`.
  `GET/POST /api/synthesis`, интент `synthesis`, инструмент Claude `projects_synthesis`. JS — `core/synthesis.js`;
  ответ обязан совпадать с Python: общий `tests/js/fixtures/synthesis.json` (пересоздайте его при смене правил).
  Тесты — `tests/test_synthesis.py`, `tests/js/synthesis.test.mjs`.
- `jarvis/projects.py` + `jarvis/github.py` — статус, задачи для @claude, локальный Claude Code, деплой; создание
  проекта, поля (`set_frontmatter_field` — правит одну строку frontmatter), страница проекта (`overview`: задачи по тегу,
  в заметке и папке `Projects/<Проект>/`, прогресс, заметки, журнал). Заметки в папке проекта — не проекты.
- `jarvis/web.py` — REST + WebSocket + вход; `jarvis/hub.py` — шина событий; `jarvis/watchers.py` — фоновые датчики.
- `jarvis/voice.py` (TTS), `jarvis/telegram.py`, `jarvis/briefing.py` (погода, курсы), `jarvis/diagnostics.py`.
- `jarvis/webapp/` — `index.html`, `static/{app,reactor,voice,hologram}.js`, `app.css`, `sw.js`. Ядро — сфера из частиц
  (`static/particle-sphere.js`, three.js с CDN; точки и «настроения» — `static/sphere-points.js`, тест —
  `tests/js/sphere-points.test.mjs`); `reactor.js` (класс `Reactor` — имя прежнее) рисует дуги показателей и, если WebGL
  или CDN недоступны, плоскую сферу. Граф памяти: размер точки по связям, перетаскивание точек с запоминанием
  (`static/graph-pins.js`, localStorage `jarvis.holo_pins`, тест — `tests/js/graph-pins.test.mjs`), раскрытие из центра,
  огоньки по нитям выбранной заметки. Движение — `static/motion.js` (докручивание чисел `countTo`, появление `stagger`;
  тест — `tests/js/motion.test.mjs`), CSS-анимации в конце `app.css`; всё выключается при «уменьшить движение».
  3D-карта расходов — `static/fin3d.js` (вкладка «Категории», данные — `analytics.matrix`, раскладка — `barGrid`).
- `static/files.js` — окно «Хранилище» (менеджер заметок и проектов): обзор (статистика, недавние, хабы, заметки без
  связей, несозданные заметки из [[ссылок]] — `vaultStats`), дерево, избранное (`fm.fav`), теги, недавние, поиск,
  сортировка (`sortFiles`), список/карточки, выбор нескольких (переместить, в корзину, в избранное), заметка дня,
  страница проекта, перетаскивание; заметку показывает та же `NotePanel` (`extraActions`/`onAction`/`onTag`/`templates`). Логика без DOM —
  `static/file-tree.js` (тест — `tests/js/files.test.mjs`). Диалоги — свои, не `prompt()`/`confirm()`.
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
  **Взгляд и щипок синхронно** — `GazeSync`: щипок нажимает последнюю устойчивую фиксацию за 450 мс до него
  («поздний щипок»: глаза уже ушли), а если взгляд ещё ехал — первую фиксацию после («ранний»); время — кадра камеры.
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
