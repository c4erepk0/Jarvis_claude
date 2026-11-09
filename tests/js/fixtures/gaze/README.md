# Калибровки взгляда владельца

Записи из хранилища (`Jarvis/Gaze/sessions` — калибровки, `Jarvis/Gaze/usage` — нажатия взглядом): точки глаз
и лица по кадрам, без фото. По ним `tests/js/gaze-sessions.test.mjs` проверяет, что точность взгляда не стала хуже,
а `scripts/gaze_eval.mjs` показывает, что даёт каждое изменение.

```bash
node scripts/gaze_eval.mjs --import <хранилище>/Jarvis/Gaze   # скопировать новые записи и пересчитать baseline
node scripts/gaze_eval.mjs                                     # отчёт по всем записям
node scripts/gaze_eval.mjs --lambda 0.3,1,3                    # сравнить регуляризацию
node scripts/gaze_eval.mjs --baseline                          # принять текущую точность за образец
```
