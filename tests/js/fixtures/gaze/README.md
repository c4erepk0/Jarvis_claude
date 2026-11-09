# Калибровки взгляда владельца — образец точности

Сами записи (точки глаз и лица по кадрам) лежат в хранилище владельца — `Jarvis/Gaze/sessions` и
`Jarvis/Gaze/usage` — и в этот репозиторий (он публичный) не попадают. Здесь только `baseline.json` — цифры
точности на них; `tests/js/gaze-sessions.test.mjs` не даёт их ухудшить, когда записи рядом
(`$JARVIS_GAZE_DIR` или клон `../jarvis-vault`), иначе пропускается.

```bash
node scripts/gaze_eval.mjs                     # отчёт по записям владельца
node scripts/gaze_eval.mjs --lambda 0.3,1,3    # сравнить регуляризацию
node scripts/gaze_eval.mjs --baseline          # принять текущую точность за образец — только если стало лучше
```
