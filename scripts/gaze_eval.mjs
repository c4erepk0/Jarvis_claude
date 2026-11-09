#!/usr/bin/env node
// Анализ записанных калибровок взгляда и журнала нажатий (Jarvis/Gaze в хранилище).
//
//   node scripts/gaze_eval.mjs [файлы или папки…]     отчёт; по умолчанию — tests/js/fixtures/gaze
//   node scripts/gaze_eval.mjs --import <…/Jarvis/Gaze> скопировать новые записи в тесты и пересчитать baseline
//   node scripts/gaze_eval.mjs --baseline               пересчитать tests/js/fixtures/gaze/baseline.json
//   node scripts/gaze_eval.mjs --lambda 0.3,1,3 --json  сравнить регуляризацию; отчёт в JSON
//
// Признаки пересчитываются из «сырых» точек текущей eyeFeatures: улучшили её — запустите отчёт и сравните
// с baseline. Тест tests/js/gaze-sessions.test.mjs не даст ухудшить точность на записанных калибровках.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateSession, evaluateUsage, eyeFeatures } from "../jarvis/webapp/static/gaze.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const FIXTURES = join(ROOT, "tests/js/fixtures/gaze");
export const BASELINE = join(FIXTURES, "baseline.json");

// Наборы признаков для сравнения: что даёт каждая группа (номера — порядок в eyeFeatures).
export const FEATURE_SETS = {
  "радужки": [0, 1, 2, 3],
  "+голова": [0, 1, 2, 3, 4, 5, 6, 7, 8],
  "все": null,
};
const pick = (idx) => (idx ? (lm, b) => { const f = eyeFeatures(lm, b); return f && idx.map((i) => f[i]); } : eyeFeatures);

/** Все записи из файлов и папок (рекурсивно): { name, path, data }. */
export function loadRecords(paths) {
  const out = [];
  const walk = (p) => {
    if (!existsSync(p)) return;
    if (statSync(p).isDirectory()) { readdirSync(p).sort().forEach((n) => walk(join(p, n))); return; }
    if (!p.endsWith(".json") || basename(p) === "baseline.json") return;
    try {
      const data = JSON.parse(readFileSync(p, "utf8"));
      if (data.kind === "jarvis-gaze-session" || data.kind === "jarvis-gaze-usage") out.push({ name: relative(FIXTURES, p).startsWith("..") ? basename(p) : relative(FIXTURES, p), path: p, data });
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
    const byFeatures = Object.fromEntries(Object.entries(FEATURE_SETS).map(([k, idx]) => [k, evaluateSession(d, { features: pick(idx) }).errorPx]));
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
    sessions: Object.fromEntries(sessions.map((s) => [s.name, { errorPx: s.errorPx, looPx: s.looPx }])),
    usage: Object.fromEntries(usage.map((u) => [u.name, { errorPx: u.errorPx, learnedErrorPx: u.learnedErrorPx }])),
  };
}

function print({ sessions, usage }, lambdas) {
  if (!sessions.length && !usage.length) {
    console.log("Записей нет. Скопируйте их из хранилища: node scripts/gaze_eval.mjs --import <хранилище>/Jarvis/Gaze");
    return;
  }
  for (const s of sessions) {
    console.log(`\n▸ ${s.name} — ${s.mode}, ${s.screen}, ${s.device}`);
    console.log(`  кадров ${s.frames}, точек ${s.points}; в приложении ${s.appErrorPx} px`);
    console.log(`  проверочные точки: ${s.errorPx} px · по одной точке на проверку: ${s.looPx} px · дрожание: ${s.jitterPx} px`);
    if (lambdas.length > 1) console.log(`  λ: ${lambdas.map((l) => `${l} → ${s.byLambda[l].errorPx}/${s.byLambda[l].looPx}`).join(" · ")}`);
    console.log(`  признаки: ${Object.entries(s.byFeatures).map(([k, v]) => `${k} ${v}`).join(" · ")} px`);
    const worst = [...s.perPoint].sort((a, b) => b.err - a.err).slice(0, 3);
    if (worst.length) console.log(`  хуже всего: ${worst.map((p) => `(${p.x}, ${p.y}) ${p.err} px`).join(", ")}`);
  }
  for (const u of usage) {
    console.log(`\n▸ ${u.name} — нажатий ${u.clicks} (калибровка ${u.session})`);
    console.log(`  промах взгляда: ${u.errorPx} px · с доучиванием на нажатиях: ${u.learnedErrorPx} px`);
  }
}

function main(argv) {
  const args = [...argv];
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  const value = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
  const asJson = flag("--json");
  const writeBaseline = flag("--baseline");
  const lambdas = (value("--lambda") || "1").split(",").map(Number).filter((v) => v > 0);
  const from = value("--import");
  if (from) {
    mkdirSync(FIXTURES, { recursive: true });
    let n = 0;
    for (const r of loadRecords([from])) {
      const dst = join(FIXTURES, r.data.kind === "jarvis-gaze-usage" ? "usage" : "sessions", basename(r.path));
      if (existsSync(dst)) continue;
      mkdirSync(join(dst, ".."), { recursive: true });
      copyFileSync(r.path, dst);
      n += 1;
    }
    console.log(`Скопировано записей: ${n} → ${relative(ROOT, FIXTURES)}`);
  }
  const records = loadRecords(args.length ? args : [FIXTURES]);
  if (from || writeBaseline) {
    writeFileSync(BASELINE, `${JSON.stringify(baseline(loadRecords([FIXTURES])), null, 2)}\n`);
    console.log(`baseline: ${relative(ROOT, BASELINE)}`);
  }
  const rep = report(records, { lambdas });
  if (asJson) console.log(JSON.stringify(rep, null, 2)); else print(rep, lambdas);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
