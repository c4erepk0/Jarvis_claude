// Голограмма памяти: 3D-граф заметок Obsidian (узлы — заметки, нити — [[ссылки]]).
// Открытая заметка подсвечивается вместе со связями, граф поворачивается к ней (focus), вид сдвигается,
// чтобы узел не прятался под панелью заметки (setInset).
// Управление мышью/пальцами или жестами рук перед камерой (MediaPipe Hand Landmarker):
//   щипок (большой + указательный) и движение — вращение, над заметкой — прокрутка текста; щипок двумя руками — масштаб;
//   указательный палец — курсор: задержка 1 с на узле — открыть заметку, на кнопке, галочке задачи или [[ссылке]]
//   в заметке — нажать; раскрытая ладонь 1 с — сброс вида; взмах ладонью — повернуть граф (или листать заметки).
//   Позы ✊ ✌ 👍 голограмма передаёт наружу (gestureAction): что они сделают, решает панель заметки.
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js";
import { BONES, GESTURE_ICON, GestureTracker, classify } from "./gestures.js?v=8";

const VISION_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const HAND_MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const EDGE = [0x3e / 255, 0xe8 / 255, 0xff / 255];   // цвет нитей-связей
const PALETTE = [0x3ee8ff, 0x5dffb0, 0xffb347, 0xb48cff, 0xff6b9a, 0x7fd4ff, 0xe6ff6b, 0xff8f5a];
const DWELL_MS = 1000;                // задержка пальца, чтобы открыть узел или нажать кнопку
// что можно «нажать» пальцем в воздухе: кнопки, галочки задач и [[ссылки]] заметки, кнопки с data-air
const AIR_TARGETS = ".np button:not([disabled]), .np a.md-link, .np li.md-task, [data-air]:not([disabled])";
const OVER_UI = ".np, .gt, .holo-ui";  // над панелями палец не выбирает узлы графа за ними
const SCROLLABLE = ".np-body, .np-editor, .np-conflict";

function glowSprite() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.25, "rgba(255,255,255,.85)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function layout(nodes, links, prev = new Map()) {
  const groups = [...new Set(nodes.map((n) => n.group))];
  const centers = new Map(groups.map((g, i) => {
    const phi = Math.acos(1 - (2 * (i + 0.5)) / groups.length), th = Math.PI * (1 + Math.sqrt(5)) * i;
    const r = groups.length > 1 ? 34 : 0;
    return [g, new THREE.Vector3(r * Math.sin(phi) * Math.cos(th), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(th))];
  }));
  // известные узлы остаются на своих местах — после правки или новой заметки граф не «разлетается»
  const pos = nodes.map((n) => (prev.get(n.id)?.clone()
    || centers.get(n.group).clone().add(new THREE.Vector3().randomDirection().multiplyScalar(6 + Math.random() * 10))));
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const edges = links.map((l) => [index.get(l.source), index.get(l.target)]).filter(([a, b]) => a !== undefined && b !== undefined);
  const rounds = nodes.every((n) => prev.has(n.id)) ? 0 : prev.size ? 30 : 90;
  for (let it = 0; it < rounds; it++) {
    const f = pos.map(() => new THREE.Vector3());
    for (let i = 0; i < pos.length; i++) {
      for (let k = 0; k < 24; k++) {
        const j = (Math.random() * pos.length) | 0;
        if (j === i) continue;
        const d = pos[i].clone().sub(pos[j]);
        const len = Math.max(1, d.length());
        f[i].add(d.multiplyScalar(30 / (len * len * len)));
      }
      f[i].add(centers.get(nodes[i].group).clone().sub(pos[i]).multiplyScalar(0.01));
    }
    for (const [a, b] of edges) {
      const d = pos[b].clone().sub(pos[a]).multiplyScalar(0.02);
      f[a].add(d); f[b].sub(d);
    }
    pos.forEach((p, i) => p.add(f[i].clampLength(0, 2)));
  }
  return { pos, edges, groups };
}

export class Hologram {
  /** onOpen(id) — открыть заметку; onStatus(text); gestureAction(name) → { label, run } | null — действие жеста
   *  с открытой заметкой (name: fist | thumb | victory | palm | swipe-left | swipe-right). */
  constructor(root, { onOpen, onStatus, gestureAction }) {
    this.root = root;
    this.onOpen = onOpen;
    this.onStatus = onStatus || (() => {});
    this.gestureAction = gestureAction || (() => null);
    this.label = root.querySelector("#holo-label");
    this.tags = document.createElement("div");
    this.tags.className = "holo-tags";
    root.prepend(this.tags);
    this.tagEls = [];
    this.cursor = document.createElement("div");
    this.cursor.className = "holo-cursor hidden";
    root.append(this.cursor);
    this.badge = document.createElement("div");   // какой жест держится и что он сделает
    this.badge.className = "holo-gesture hidden";
    this.badge.setAttribute("aria-live", "polite");
    root.append(this.badge);
    this.gestureListeners = new Set();   // обучение жестам слушает, что распознано
    this.suppressOpen = false;           // во время обучения жесты не открывают, не правят и не закрывают заметки
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.domElement.className = "three";
    root.prepend(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x02121c, 0.006);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 2000);
    this.camera.position.set(0, 8, 120);
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.decor();
    this.marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSprite(), color: 0xffffff, transparent: true,
      opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.marker.visible = false;
    this.world.add(this.marker);
    this.ray = new THREE.Raycaster();
    this.ray.params.Points.threshold = 2.2;
    this.mouse = new THREE.Vector2(-9, -9);
    this.spin = 0.0016;
    this.target = { rx: 0.15, ry: 0, z: 120 };
    this.bindPointer();
    this.resize = this.resize.bind(this);
    window.addEventListener("resize", this.resize);
    this.resize();
    this.running = true;
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  decor() {
    const ring = (r, y, op) => {
      const g = new THREE.RingGeometry(r, r + 0.25, 128);
      const m = new THREE.MeshBasicMaterial({ color: 0x3ee8ff, transparent: true, opacity: op, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(g, m);
      mesh.rotation.x = Math.PI / 2;
      mesh.position.y = y;
      this.scene.add(mesh);
      return mesh;
    };
    this.rings = [ring(58, -48, 0.35), ring(48, -48.5, 0.2), ring(66, -49, 0.12)];
    const sphere = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(62, 2)),
      new THREE.LineBasicMaterial({ color: 0x3ee8ff, transparent: true, opacity: 0.05 }));
    this.world.add(sphere);
    const beams = new THREE.BufferGeometry();
    const pts = [];
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      pts.push(Math.cos(a) * 58, -48, Math.sin(a) * 58, Math.cos(a) * 40, 40, Math.sin(a) * 40);
    }
    beams.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    this.scene.add(new THREE.LineSegments(beams, new THREE.LineBasicMaterial({ color: 0x3ee8ff, transparent: true, opacity: 0.025 })));
  }

  setData({ nodes, links }) {
    if (this.points) { this.world.remove(this.points); this.world.remove(this.lines); }
    const prev = new Map((this.nodes || []).map((n, i) => [n.id, this.positions[i]]));
    this.nodes = nodes;
    const { pos, edges, groups } = layout(nodes, links, prev);
    this.byId = new Map(nodes.map((n, i) => [n.id, i]));
    this.neighbors = new Map(nodes.map((n) => [n.id, new Set()]));
    for (const [a, b] of edges) { this.neighbors.get(nodes[a].id).add(nodes[b].id); this.neighbors.get(nodes[b].id).add(nodes[a].id); }
    this.edges = edges;
    const colors = [], positions = [], sizes = [];
    nodes.forEach((n, i) => {
      const col = new THREE.Color(PALETTE[groups.indexOf(n.group) % PALETTE.length]);
      colors.push(col.r, col.g, col.b);
      positions.push(pos[i].x, pos[i].y, pos[i].z);
      sizes.push(n.type === "project" ? 7 : 3 + Math.min(4, Math.log10(1 + n.size)));
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    this.baseColors = Float32Array.from(colors);
    const size = nodes.length < 50 ? 7 : nodes.length < 200 ? 5 : 4;
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size, map: glowSprite(), vertexColors: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }));
    this.world.add(this.points);
    const lp = [], lc = [];
    for (const [a, b] of edges) lp.push(pos[a].x, pos[a].y, pos[a].z, pos[b].x, pos[b].y, pos[b].z);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.Float32BufferAttribute(lp, 3));
    for (let k = 0; k < edges.length * 2; k++) lc.push(...EDGE.map((c) => c * 0.55));
    lg.setAttribute("color", new THREE.Float32BufferAttribute(lc, 3));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending, depthWrite: false }));
    this.world.add(this.lines);
    this.positions = pos;
    this.tags.innerHTML = "";
    this.tagEls = nodes.length <= 80 ? nodes.map((n) => {
      const el = document.createElement("span");
      el.textContent = n.title;
      this.tags.append(el);
      return el;
    }) : [];
    if (nodes.length < 50 && !prev.size) this.target.z = 90;
    this.highlight(this.selected && this.byId.has(this.selected) ? this.selected : null);
    this.onStatus(`${nodes.length} заметок · ${edges.length} связей`);
  }

  /** Подсветить заметку и её связи (остальное приглушается); null — снять подсветку. */
  highlight(id) {
    this.selected = id && this.byId?.has(id) ? id : null;
    if (!this.points) return;
    const i0 = this.selected ? this.byId.get(this.selected) : -1;
    const near = this.selected ? this.neighbors.get(this.selected) : null;
    const col = this.points.geometry.attributes.color;
    this.nodes.forEach((n, i) => {
      const k = !near || i === i0 || near.has(n.id) ? 1 : 0.16;
      for (let c = 0; c < 3; c++) col.array[i * 3 + c] = i === i0 ? 1 : this.baseColors[i * 3 + c] * k;
    });
    col.needsUpdate = true;
    const lc = this.lines.geometry.attributes.color;
    this.edges.forEach(([a, b], e) => {
      const k = !near ? 0.55 : a === i0 || b === i0 ? 1.4 : 0.08;
      for (let v = 0; v < 6; v++) lc.array[e * 6 + v] = EDGE[v % 3] * k;
    });
    lc.needsUpdate = true;
    this.tagEls.forEach((el, i) => {
      el.classList.toggle("sel", i === i0);
      el.classList.toggle("dim", Boolean(near) && i !== i0 && !near.has(this.nodes[i].id));
    });
    this.marker.visible = i0 >= 0;
    if (i0 >= 0) this.marker.position.copy(this.positions[i0]);
  }

  /** Плавно повернуть граф так, чтобы заметка оказалась впереди, по центру. */
  focus(id) {
    const i = this.byId?.get(id);
    if (i === undefined) return;
    const p = this.positions[i];
    let ry = Math.atan2(-p.x, p.z);                         // после поворота по Y узел — на оси Z
    const z1 = -p.x * Math.sin(ry) + p.z * Math.cos(ry);
    ry += Math.round((this.world.rotation.y - ry) / (2 * Math.PI)) * 2 * Math.PI;   // ближайший путь, без «пропеллера»
    const rx = Math.max(-1.2, Math.min(1.2, Math.atan2(p.y, z1)));
    this.target = { rx, ry, z: Math.max(70, Math.min(160, z1 + 45)) };
    this.spin = 0;
  }

  /** Часть экрана занята панелью заметки — центр вида сдвигается в свободную часть. */
  setInset({ right = 0, bottom = 0 } = {}) {
    this.inset = { right, bottom };
    this.resize();
  }

  bindPointer() {
    const el = this.renderer.domElement;
    let drag = null, pinch = null, moved = 0;
    el.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY }; moved = 0; el.setPointerCapture(e.pointerId); });
    el.addEventListener("pointermove", (e) => {
      this.setMouse(e.clientX, e.clientY);
      if (!drag || pinch) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      moved += Math.abs(dx) + Math.abs(dy);
      this.rotate(dx * 0.006, dy * 0.004);
      drag = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener("pointerup", () => { if (drag && moved < 6) this.openHovered(); drag = null; });
    el.addEventListener("wheel", (e) => { e.preventDefault(); this.zoom(e.deltaY * 0.08); }, { passive: false });
    el.addEventListener("touchstart", (e) => { if (e.touches.length === 2) pinch = this.touchDist(e); }, { passive: true });
    el.addEventListener("touchmove", (e) => {
      if (e.touches.length === 2 && pinch) { const d = this.touchDist(e); this.zoom((pinch - d) * 0.4); pinch = d; }
    }, { passive: true });
    el.addEventListener("touchend", () => { pinch = null; });
  }

  touchDist(e) { const [a, b] = e.touches; return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
  setMouse(x, y) { this.mouse.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1); this.hoverAt = { x, y }; }
  rotate(dy, dx) { this.target.ry += dy; this.target.rx = Math.max(-1.2, Math.min(1.2, this.target.rx + dx)); this.spin = 0; }
  zoom(d) { this.target.z = Math.max(30, Math.min(260, this.target.z + d)); }
  reset() { this.target = { rx: 0.15, ry: 0, z: 120 }; this.spin = 0.0016; }

  hovered() {
    if (!this.points) return null;
    this.ray.setFromCamera(this.mouse, this.camera);
    const hit = this.ray.intersectObject(this.points)[0];
    return hit ? this.nodes[hit.index] : null;
  }

  openHovered() { const n = this.hovered(); if (n) this.onOpen(n.id); }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    const { right = 0, bottom = 0 } = this.inset || {};
    if (right || bottom) this.camera.setViewOffset(w, h, right / 2, bottom / 2, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  loop(ts) {
    if (!this.running) return;
    this.target.ry += this.spin;
    this.world.rotation.y += (this.target.ry - this.world.rotation.y) * 0.08;
    this.world.rotation.x += (this.target.rx - this.world.rotation.x) * 0.08;
    this.camera.position.z += (this.target.z - this.camera.position.z) * 0.08;
    this.camera.lookAt(0, 0, 0);
    this.rings.forEach((r, i) => { r.rotation.z = ts * 0.0001 * (i % 2 ? -1 : 1); });
    if (this.marker.visible) this.marker.scale.setScalar(7 + Math.sin(ts / 260) * 1.2);
    const n = this.hovered();
    if (n && this.hoverAt) {
      this.label.textContent = n.title;
      this.label.style.left = `${this.hoverAt.x}px`;
      this.label.style.top = `${this.hoverAt.y}px`;
      this.label.classList.remove("hidden");
    } else this.label.classList.add("hidden");
    if (this.hands) this.trackHands(ts);
    this.renderer.render(this.scene, this.camera);
    if (this.tagEls.length) {
      this.world.updateMatrixWorld();
      const v = new THREE.Vector3();
      this.tagEls.forEach((el, i) => {
        v.copy(this.positions[i]).applyMatrix4(this.world.matrixWorld).project(this.camera);
        const x = (v.x * 0.5 + 0.5) * innerWidth, y = (-v.y * 0.5 + 0.5) * innerHeight;
        el.style.transform = `translate(${x + 8}px, ${y - 6}px)`;
        el.style.opacity = v.z < 1 ? String(Math.max(0.25, 1 - (v.z - 0.95) * 12)) : "0";
      });
    }
    requestAnimationFrame(this.loop);
  }

  // ---------- жесты ----------
  /** Кнопка «Жесты»: включить или выключить. */
  async enableGestures(video, overlay) {
    if (this.hands) { this.disableGestures(); return false; }
    await this.startGestures(video, overlay);
    return true;
  }

  /** Включить камеру и распознавание рук (если уже включено — ничего не делает). */
  async startGestures(video, overlay) {
    if (this.hands) return;
    this.onStatus("загружаю модель рук…");
    if (!this.landmarker) {
      const { FilesetResolver, HandLandmarker } = await import(VISION_URL);
      const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: HAND_MODEL, delegate: "GPU" }, runningMode: "VIDEO", numHands: 2,
      });
    }
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: 640, height: 480 } });
    video.srcObject = this.stream;
    await video.play();
    this.video = video;
    this.overlay = overlay;
    overlay.width = 320; overlay.height = 240;
    video.classList.remove("hidden"); overlay.classList.remove("hidden");
    this.hands = { last: -1, pinch: null, pinch2: null, dwell: null, lock: null, badgeAt: 0 };
    this.tracker = new GestureTracker();
    this.onStatus("жесты включены: ☝ палец 1 с — открыть или нажать, 🤏 — вращать, ✋ — сброс, ✌ — править, 👍 — сохранить, ✊ — закрыть");
  }

  emitGesture(evt) { this.gestureListeners.forEach((fn) => fn(evt)); }

  disableGestures() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null; this.hands = null;
    this.cursor.classList.add("hidden");
    this.badge.classList.add("hidden");
    if (this.video) this.video.classList.add("hidden");
    if (this.overlay) this.overlay.classList.add("hidden");
  }

  /** Что сделает жест прямо сейчас: сначала спрашиваем панель заметки, иначе — действия самой голограммы. */
  action(name) {
    const ext = this.suppressOpen ? null : this.gestureAction(name);
    if (ext) return ext;
    switch (name) {
      case "palm": return { label: "сброс вида", run: () => { this.reset(); this.emitGesture({ type: "reset" }); } };
      case "swipe-left": return { label: "повернуть граф", run: () => this.rotate(-0.9, 0) };
      case "swipe-right": return { label: "повернуть граф", run: () => this.rotate(0.9, 0) };
      default: return null;
    }
  }

  trackHands(ts) {
    const v = this.video, h = this.hands;
    if (!v || v.readyState < 2 || v.currentTime === h.last) return;
    h.last = v.currentTime;
    const res = this.landmarker.detectForVideo(v, ts);
    const hands = res.landmarks || [];
    this.drawHands(hands);
    const g = classify(hands);
    this.emitGesture({ type: "frame", kind: g.kind, hands: g.hands });
    for (const e of this.tracker.update(g, ts)) this.onTracked(e, ts);
    if (ts - h.badgeAt > 300 && !this.badge.classList.contains("done")) this.badge.classList.add("hidden");
    if (g.kind !== "point" && g.kind !== "pinch") this.cursor.classList.add("hidden");
    if (g.kind !== "point" && g.kind !== "hand") h.dwell = null;   // «рука» на кадр — палец просто дрогнул
    // руку перестроили (не просто потеряли на кадр) — то же место можно нажать снова
    if (!["point", "hand", "none"].includes(g.kind)) h.lock = null;

    if (g.kind === "pinch2") {
      if (h.pinch2 !== null) {
        const amount = (h.pinch2 - g.d) * 400;
        this.zoom(amount);
        this.emitGesture({ type: "zoom", amount });
      }
      h.pinch2 = g.d; h.pinch = null;
      return;
    }
    h.pinch2 = null;
    if (g.kind === "pinch") { this.pinchMove(g); return; }
    h.pinch = null;
    if (g.kind === "point") this.pointAt(g, ts);
  }

  /** Удержание позы и взмахи от GestureTracker. */
  onTracked(e, ts) {
    this.emitGesture(e);
    if (e.type === "hold") {
      const a = e.progress >= 0.15 ? this.action(e.kind) : null;   // мимолётные позы не мельтешат
      if (a) this.showBadge(e.kind, a.label, e.progress, ts);
      return;
    }
    const name = e.type === "swipe" ? `swipe-${e.dir}` : e.kind;
    const a = this.action(name);
    if (!a) return;
    a.run();
    this.showBadge(name, a.label, 1, ts, true);
    this.emitGesture({ type: "command", gesture: name, label: a.label });
  }

  showBadge(name, label, progress, ts, done = false) {
    const b = this.badge;
    const arrow = name === "swipe-left" ? " ←" : name === "swipe-right" ? " →" : "";
    b.innerHTML = `<b>${GESTURE_ICON[name] || "•"}${arrow}</b><span>${done ? "✓ " : ""}${label}</span><i></i>`;
    b.style.setProperty("--p", String(progress));
    b.classList.remove("hidden");
    b.classList.toggle("done", done);
    if (this.hands) this.hands.badgeAt = ts;
    clearTimeout(this.badgeTimer);
    if (done) this.badgeTimer = setTimeout(() => b.classList.remove("done"), 900);
  }

  /** Щипок: над текстом заметки — прокрутка («взял и потянул»), в остальном месте — вращение графа. */
  pinchMove(g) {
    const h = this.hands;
    const x = g.x * innerWidth, y = g.y * innerHeight;
    if (!h.pinch) {
      const el = document.elementFromPoint(x, y);
      h.pinch = { x: g.x, y: g.y, scroll: el?.closest(SCROLLABLE) || null };
    } else if (h.pinch.scroll) {
      const amount = (h.pinch.y - g.y) * innerHeight * 1.6;
      h.pinch.scroll.scrollTop += amount;
      this.emitGesture({ type: "scroll", amount });
    } else {
      const dy = (g.x - h.pinch.x) * 6, dx = (g.y - h.pinch.y) * 4;
      this.rotate(dy, dx);
      this.emitGesture({ type: "rotate", amount: Math.abs(dy) + Math.abs(dx) });
    }
    h.pinch.x = g.x; h.pinch.y = g.y;
    h.dwell = null;
    this.cursor.style.transform = `translate(${x}px, ${y}px)`;
    this.cursor.style.setProperty("--p", "0");
    this.cursor.classList.add("grab");
    this.cursor.classList.remove("hidden", "on");
  }

  /** Указка: курсор; задержка на узле — открыть заметку, на кнопке/галочке/ссылке — нажать. */
  pointAt(g, ts) {
    const h = this.hands;
    const x = g.x * innerWidth, y = g.y * innerHeight;
    const el = document.elementFromPoint(x, y);
    let target = null, node = null;
    if (el?.closest(OVER_UI)) {
      this.mouse.set(-9, -9); this.hoverAt = null;
      target = el.closest(AIR_TARGETS);
      if (target && this.suppressOpen && !target.closest(".gt")) target = null;   // в обучении — только его кнопки
    } else {
      this.setMouse(x, y);
      node = this.hovered();
    }
    // после нажатия ждём, пока палец уйдёт: иначе на месте нажатой кнопки сработает следующая
    if (h.lock && Math.hypot(x - h.lock.x, y - h.lock.y) > 48) h.lock = null;
    const id = target || node?.id || null;
    let progress = 0;
    if (id && !h.lock) {
      if (!h.dwell || h.dwell.id !== id) h.dwell = { id, since: ts };
      progress = Math.max(0, Math.min(1, (ts - h.dwell.since) / DWELL_MS));
      if (progress >= 1) {
        h.dwell = null;
        h.lock = { x, y };
        if (target) {
          this.emitGesture({ type: "press", label: target.textContent.trim().slice(0, 40) });
          target.click();
        } else {
          if (!this.suppressOpen) this.onOpen(node.id);
          this.emitGesture({ type: "select", id: node.id });
        }
      }
      this.emitGesture({ type: "dwell", progress, id: node?.id || null, press: Boolean(target) });
    } else h.dwell = null;
    this.cursor.style.transform = `translate(${x}px, ${y}px)`;
    this.cursor.style.setProperty("--p", String(progress));
    this.cursor.classList.toggle("on", Boolean(id) && !h.lock);
    this.cursor.classList.remove("hidden", "grab");
  }

  drawHands(hands) {
    const g = this.overlay.getContext("2d"), W = this.overlay.width, H = this.overlay.height;
    g.clearRect(0, 0, W, H);
    g.strokeStyle = "rgba(62,232,255,.9)"; g.fillStyle = "#eaffff"; g.lineWidth = 2;
    for (const lm of hands) {
      for (const [a, b] of BONES) { g.beginPath(); g.moveTo(lm[a].x * W, lm[a].y * H); g.lineTo(lm[b].x * W, lm[b].y * H); g.stroke(); }
      for (const p of lm) { g.beginPath(); g.arc(p.x * W, p.y * H, 2.5, 0, Math.PI * 2); g.fill(); }
    }
  }

  destroy() {
    this.running = false;
    this.disableGestures();
    window.removeEventListener("resize", this.resize);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
