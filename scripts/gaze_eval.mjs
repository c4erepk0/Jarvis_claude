#!/usr/bin/env node
// Анализ записанных калибровок взгляда и журнала нажатий (Jarvis/Gaze в хранилище).
//
//   node scripts/gaze_eval.mjs [файлы или папки…]     отчёт; по умолчанию — записи владельца (GAZE_DIRS ниже)
//   node scripts/gaze_eval.mjs --baseline               принять текущую точность за образец (tests/js/fixtures/gaze/baseline.json)
//   node scripts/gaze_eval.mjs --lambda 0.3,1,3 --json  сравнить регуляризацию; отчёт в JSON
//
// Записи владельца — точки его лица, а репозиторий Jarvis публичный: сами записи сюда не кладём, только цифры
// точности (baseline.json). Читаем их из хранилища: $JARVIS_GAZE_DIR или клон ../jarvis-vault/Jarvis/Gaze рядом
// с репозиторием (или tests/js/fixtures/gaze, если владелец сам решит положить их туда).
// Признаки пересчитываются из «сырых» точек текущей gazeFeatures: улучшили её — запустите отчёт и сравните
// с baseline. Тест tests/js/gaze-sessions.test.mjs не даст ухудшить точность на калибровках владельца.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateSession, evaluateUsage, eyeFeatures, gazeFeatures } from "../jarvis/webapp/static/gaze.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const FIXTURES = join(ROOT, "tests/js/fixtures/gaze");
export const BASELINE = join(FIXTURES, "baseline.json");
/** Где искать записи владельца, по порядку: переменная окружения, клон хранилища рядом, папка тестов. */
export const GAZE_DIRS = [process.env.JARVIS_GAZE_DIR, join(ROOT, "../jarvis-vault/Jarvis/Gaze"), FIXTURES].filter(Boolean);

// Признаки для сравнения: нынешние (только глаза) и прежние (eyeFeatures — с положением лица в кадре).
const subset = (idx) => (lm, b) => { const f = eyeFeatures(lm, b); return f && idx.map((i) => f[i]); };
export const FEATURE_SETS = {
  "глаза (v3)": gazeFeatures,
  "прежние 17": eyeFeatures,
  "прежние без головы": subset([0, 1, 2, 3, 9, 10, 11, 12, 13, 14, 15, 16]),
};

/** Все записи из файлов и папок (рекурсивно): { name, path, data }. */
export function loadRecords(paths) {
  const out = [];
  const walk = (p) => {
    if (!existsSync(p)) return;
    if (statSync(p).isDirectory()) { readdirSync(p).sort().forEach((n) => walk(join(p, n))); return; }
    if (!p.endsWith(".json") || basename(p) === "baseline.json") return;
    try {
      const data = JSON.parse(readFileSync(p, "utf8"));
      if (data.kind === "jarvis-gaze-session" || data.kind === "jarvis-gaze-usage") out.push({ name: basename(p), path: p, data });
    } catch { /* не запись взгляда */ }
  };
  paths.forEach(walk);
  return out;
}

/** Нажатия сверяем с последней калибровкой до них (имена файлов — время записи). */
export function pairUsage(records) {
  const sessions = records.filter((r) => r.data.kind === "jarvis-gaze-session").sort((a, b) => basename(a.path).localeCompare(basename(b.path)));
  return records.filter((r) => r.data.kind === "jarvis-gaze-usage").map((u) => ({
    usage: u, session: [...sessions].reverse().find((s) => basename(s.path) <= basename(u.path)) || sessions.at(-1) || null,
  })).filter((p) => p.session);
}

export function report(records, { lambdas = [1] } = {}) {
  const sessions = records.filter((r) => r.data.kind === "jarvis-gaze-session").map((r) => {
    const d = r.data;
    const byLambda = Object.fromEntries(lambdas.map((l) => [l, evaluateSession(d, { lambda: l })]));
    const byFeatures = Object.fromEntries(Object.entries(FEATURE_SETS).map(([k, feat]) => {
      const e = evaluateSession(d, { features: feat });
      return [k, `${e.errorPx}/${e.livePx}`];
    }));
    return { name: r.name, mode: d.mode, device: d.device || "", screen: `${d.screen.w}×${d.screen.h}`, created: d.created,
      appErrorPx: d.result?.errorPx ?? null, ...byLambda[lambdas[0]], byLambda, byFeatures };
  });
  const usage = pairUsage(records).map(({ usage: u, session: s }) => ({
    name: u.name, session: s.name, ...evaluateUsage(s.data, u.data),
    learnedErrorPx: evaluateUsage(s.data, u.data, { learn: true }).errorPx,
  }));
  return { sessions, usage };
}

export function baseline(records) {
  const { sessions, usage } = report(records);
  return {
    note: "Точность взгляда на записанных калибровках (px); tests/js/gaze-sessions.test.mjs не даёт её ухудшить. "
      + "Пересчитать: node scripts/gaze_eval.mjs --baseline",
    sessions: Object.fromEntries(sessions.map((s) => [s.name, { errorPx: s.errorPx, looPx: s.looPx, livePx: s.livePx }])),
    usage: Object.fromEntries(usage.map((u) => [u.name, { errorPx: u.errorPx, learnedErrorPx: u.learnedErrorPx }])),
  };
}

function print({ sessions, usage }, lambdas) {
  if (!sessions.length && !usage.length) {
    console.log("Записей нет: укажите папку Jarvis/Gaze хранилища (JARVIS_GAZE_DIR) или склонируйте его в ../jarvis-vault");
    return;
  }
  for (const s of sessions) {
    console.log(`\n▸ ${s.name} — ${s.mode}, ${s.screen}, ${s.device}`);
    console.log(`  кадров ${s.frames}, точек ${s.points}; в приложении ${s.appErrorPx} px`);
    console.log(`  проверочные точки: ${s.errorPx} px · в работе (с поправкой по нажатиям): ${s.livePx} px · по одной точке на проверку: ${s.looPx} px · дрожание: ${s.jitterPx} px`);
    if (lambdas.length > 1) console.log(`  λ: ${lambdas.map((l) => `${l} → ${s.byLambda[l].errorPx}/${s.byLambda[l].looPx}`).join(" · ")}`);
    console.log(`  признаки (проверочные / в работе): ${Object.entries(s.byFeatures).map(([k, v]) => `${k} ${v}`).join(" · ")} px`);
    const worst = [...s.perPoint].sort((a, b) => b.err - a.err).slice(0, 3);
    if (worst.length) console.log(`  хуже всего: ${worst.map((p) => `(${p.x}, ${p.y}) ${p.err} px`).join(", ")}`);
  }
  for (const u of usage) {
    console.log(`\n▸ ${u.name} — нажатий ${u.clicks} (калибровка ${u.session})`);
    console.log(`  промах взгляда: ${u.errorPx} px · с поправкой по нажатиям: ${u.learnedErrorPx} px`);
  }
}

function main(argv) {
  const args = [...argv];
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  const value = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
  const asJson = flag("--json");
  const writeBaseline = flag("--baseline");
  const lambdas = (value("--lambda") || "1").split(",").map(Number).filter((v) => v > 0);
  const dirs = args.length ? args : [GAZE_DIRS.find((d) => existsSync(d)) || FIXTURES];
  const records = loadRecords(dirs);
  if (writeBaseline) {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(BASELINE, `${JSON.stringify(baseline(records), null, 2)}\n`);
    console.log(`baseline: ${relative(ROOT, BASELINE)} (записи: ${dirs.join(", ")})`);
  }
  const rep = report(records, { lambdas });
  if (asJson) console.log(JSON.stringify(rep, null, 2)); else print(rep, lambdas);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
