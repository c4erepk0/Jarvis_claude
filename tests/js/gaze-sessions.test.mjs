// Записи взгляда: маршрут /api/gaze ядра для iPhone (как jarvis/gaze.py), отчёт scripts/gaze_eval.mjs
// и главное — точность на калибровках владельца (tests/js/fixtures/gaze): улучшения проверяются на них.
//   Добавить свежие записи из хранилища: node scripts/gaze_eval.mjs --import <хранилище>/Jarvis/Gaze
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";

import { BLEND_KEYS, RAW_LANDMARKS, packFrame } from "../../jarvis/webapp/static/gaze.js";
import { Jarvis } from "../../jarvis/webapp/static/core/jarvis.js";
import { LocalStore } from "../../jarvis/webapp/static/core/vault.js";
import { BASELINE, FIXTURES, loadRecords, report } from "../../scripts/gaze_eval.mjs";
import { face, rng, runCalibration } from "./gaze-synthetic.mjs";

const CLOCK = () => new Date(2026, 10, 9, 9, 15, 30);

function usageRecord({ n = 20, irisBias = 0.003, seed = 3 } = {}) {
  const rand = rng(seed), w = 390, h = 844;
  const clicks = Array.from({ length: n }, (_, k) => {
    const x = 0.1 + ((k * 7) % 10) * 0.08, y = 0.15 + ((k * 3) % 8) * 0.09;
    const fc = face(x, y, { noise: 0.0004, rand, irisBias });
    return { t: k, target: { x: x * w, y: y * h, w: 40, h: 30, kind: "button" }, label: { x: x * w, y: y * h },
      pred: { x: 0, y: 0 }, errPx: 0, ...packFrame(fc.lm, fc.blend) };
  });
  return { kind: "jarvis-gaze-usage", version: 1, created: "2026-11-09T10:00:00Z", screen: { w, h },
    landmarks: RAW_LANDMARKS, blend: BLEND_KEYS, clicks };
}

test("ядро для iPhone пишет записи взгляда в хранилище, как сервер", async () => {
  const j = await new Jarvis({ title: "сэр", currency: "RUB" }, { store: new LocalStore("t", {}), clock: CLOCK,
    fetchImpl: async () => { throw new TypeError("offline"); } }).init();
  const session = runCalibration().cal.toSession();
  const r = await j.request("POST", "/api/gaze", session);
  assert.equal(r.path, "Jarvis/Gaze/sessions/2026-11-09-091530.json");
  assert.equal(JSON.parse(j.vault.read(r.path)).frames.length, session.frames.length);
  assert.equal((await j.request("POST", "/api/gaze", session)).path, "Jarvis/Gaze/sessions/2026-11-09-091530-2.json");
  assert.equal((await j.request("POST", "/api/gaze", usageRecord())).path, "Jarvis/Gaze/usage/2026-11-09-091530.json");
  await assert.rejects(j.request("POST", "/api/gaze", { kind: "jarvis-gaze-session", version: 1, frames: [] }),
    (e) => e.status === 400 && /пустая/.test(e.message));
  await assert.rejects(j.request("POST", "/api/gaze", { kind: "чужое" }), (e) => e.status === 400);
  assert.ok(!j.vault.graph().nodes.some((n) => n.id.includes("Gaze")));   // на голограмме записей нет
});

test("отчёт по записям: калибровки, нажатия, сравнение признаков", () => {
  const dir = mkdtempSync(join(tmpdir(), "gaze-"));
  mkdirSync(join(dir, "sessions")); mkdirSync(join(dir, "usage"));
  writeFileSync(join(dir, "sessions/2026-11-09-090000.json"), JSON.stringify(runCalibration({ mode: "big" }).cal.toSession()));
  writeFileSync(join(dir, "usage/2026-11-09-100000.json"), JSON.stringify(usageRecord()));
  writeFileSync(join(dir, "заметка.json"), "{}");                                  // посторонний файл — пропускается
  const records = loadRecords([dir]);
  assert.equal(records.length, 2);
  const rep = report(records, { lambdas: [0.3, 1] });
  assert.equal(rep.sessions.length, 1);
  const s = rep.sessions[0];
  assert.equal(s.points, 36);
  assert.ok(s.errorPx < 20 && s.looPx < 30, JSON.stringify(s));
  assert.deepEqual(Object.keys(s.byFeatures), ["радужки", "+голова", "все"]);
  assert.ok(Object.values(s.byLambda).every((e) => e.errorPx !== null));
  assert.equal(rep.usage.length, 1);
  assert.equal(rep.usage[0].clicks, 20);
  assert.ok(rep.usage[0].learnedErrorPx < rep.usage[0].errorPx, JSON.stringify(rep.usage[0]));
});

// ---------- калибровки владельца ----------
const files = (() => {
  try { return loadRecords([FIXTURES]); } catch { return []; }
})();
const base = (() => { try { return JSON.parse(readFileSync(BASELINE, "utf8")); } catch { return { sessions: {}, usage: {} }; } })();

test("калибровки владельца: точность взгляда не хуже записанной", { skip: files.length ? false
  : "записей нет — node scripts/gaze_eval.mjs --import <хранилище>/Jarvis/Gaze" }, () => {
  const rep = report(files);
  const worse = (now, was) => now !== null && was !== null && was !== undefined && now > was * 1.1 + 3;
  for (const s of rep.sessions) {
    const b = base.sessions[s.name];
    assert.ok(b, `нет baseline для ${s.name} — node scripts/gaze_eval.mjs --baseline`);
    assert.ok(!worse(s.errorPx, b.errorPx), `${s.name}: проверочные ${b.errorPx} → ${s.errorPx} px`);
    assert.ok(!worse(s.looPx, b.looPx), `${s.name}: по одной точке ${b.looPx} → ${s.looPx} px`);
  }
  for (const u of rep.usage) {
    const b = base.usage[u.name];
    assert.ok(b, `нет baseline для ${u.name}`);
    assert.ok(!worse(u.learnedErrorPx, b.learnedErrorPx), `${u.name}: нажатия ${b.learnedErrorPx} → ${u.learnedErrorPx} px`);
  }
});

test("в тестовых записях только калибровки и нажатия, без лишнего", () => {
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  let all = [];
  try { all = walk(FIXTURES); } catch { /* папки ещё нет */ }
  for (const f of all) {
    const rel = relative(FIXTURES, f);
    if (rel === "baseline.json" || rel === "README.md") continue;
    const d = JSON.parse(readFileSync(f, "utf8"));
    assert.ok(["jarvis-gaze-session", "jarvis-gaze-usage"].includes(d.kind), rel);
    assert.ok(!JSON.stringify(d).includes("data:image"), `${rel}: фото в записях не храним`);
  }
});
