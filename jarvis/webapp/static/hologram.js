// Голограмма памяти: 3D-граф заметок Obsidian (узлы — заметки, нити — [[ссылки]]).
// Управление мышью/пальцами или жестами рук перед камерой (MediaPipe Hand Landmarker):
//   щипок (большой + указательный) и движение — вращение; щипок двумя руками — масштаб;
//   указательный палец — курсор, задержка на узле 1 с — открыть заметку; раскрытая ладонь 1 с — сброс вида.
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js";

const VISION_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const HAND_MODEL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const PALETTE = [0x3ee8ff, 0x5dffb0, 0xffb347, 0xb48cff, 0xff6b9a, 0x7fd4ff, 0xe6ff6b, 0xff8f5a];

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

function layout(nodes, links) {
  const groups = [...new Set(nodes.map((n) => n.group))];
  const centers = new Map(groups.map((g, i) => {
    const phi = Math.acos(1 - (2 * (i + 0.5)) / groups.length), th = Math.PI * (1 + Math.sqrt(5)) * i;
    const r = groups.length > 1 ? 34 : 0;
    return [g, new THREE.Vector3(r * Math.sin(phi) * Math.cos(th), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(th))];
  }));
  const pos = nodes.map((n) => centers.get(n.group).clone().add(new THREE.Vector3().randomDirection().multiplyScalar(6 + Math.random() * 10)));
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const edges = links.map((l) => [index.get(l.source), index.get(l.target)]).filter(([a, b]) => a !== undefined && b !== undefined);
  for (let it = 0; it < 90; it++) {
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
  constructor(root, { onOpen, onStatus }) {
    this.root = root;
    this.onOpen = onOpen;
    this.onStatus = onStatus || (() => {});
    this.label = root.querySelector("#holo-label");
    this.tags = document.createElement("div");
    this.tags.className = "holo-tags";
    root.prepend(this.tags);
    this.tagEls = [];
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
    this.nodes = nodes;
    const { pos, edges, groups } = layout(nodes, links);
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
    const size = nodes.length < 50 ? 7 : nodes.length < 200 ? 5 : 4;
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ size, map: glowSprite(), vertexColors: true,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }));
    this.world.add(this.points);
    const lp = [];
    for (const [a, b] of edges) lp.push(pos[a].x, pos[a].y, pos[a].z, pos[b].x, pos[b].y, pos[b].z);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.Float32BufferAttribute(lp, 3));
    this.lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x3ee8ff, transparent: true, opacity: 0.22,
      blending: THREE.AdditiveBlending }));
    this.world.add(this.lines);
    this.positions = pos;
    this.tags.innerHTML = "";
    this.tagEls = nodes.length <= 80 ? nodes.map((n) => {
      const el = document.createElement("span");
      el.textContent = n.title;
      this.tags.append(el);
      return el;
    }) : [];
    if (nodes.length < 50) this.target.z = 90;
    this.onStatus(`${nodes.length} заметок · ${edges.length} связей`);
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
  async enableGestures(video, overlay) {
    if (this.hands) { this.disableGestures(); return false; }
    this.onStatus("загружаю модель рук…");
    const { FilesetResolver, HandLandmarker } = await import(VISION_URL);
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    this.landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL, delegate: "GPU" }, runningMode: "VIDEO", numHands: 2,
    });
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: 640, height: 480 } });
    video.srcObject = this.stream;
    await video.play();
    this.video = video;
    this.overlay = overlay;
    overlay.width = 320; overlay.height = 240;
    video.classList.remove("hidden"); overlay.classList.remove("hidden");
    this.hands = { last: -1, pinch: null, pinch2: null, palmSince: 0, dwell: null };
    this.onStatus("жесты включены: щипок — вращать, две руки — масштаб, палец — выбрать, ладонь — сброс");
    return true;
  }

  disableGestures() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null; this.hands = null;
    if (this.video) this.video.classList.add("hidden");
    if (this.overlay) this.overlay.classList.add("hidden");
  }

  trackHands(ts) {
    const v = this.video, h = this.hands;
    if (!v || v.readyState < 2 || v.currentTime === h.last) return;
    h.last = v.currentTime;
    const res = this.landmarker.detectForVideo(v, ts);
    const hands = res.landmarks || [];
    this.drawHands(hands);
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const pinching = (lm) => dist(lm[4], lm[8]) < 0.055;
    const extended = (lm, tip, pip) => lm[tip].y < lm[pip].y - 0.02;
    const openPalm = (lm) => [[8, 6], [12, 10], [16, 14], [20, 18]].every(([t, p]) => extended(lm, t, p)) && !pinching(lm);
    const pointing = (lm) => extended(lm, 8, 6) && !extended(lm, 12, 10) && !extended(lm, 16, 14) && !pinching(lm);

    if (hands.length === 2 && pinching(hands[0]) && pinching(hands[1])) {
      const d = dist(hands[0][9], hands[1][9]);
      if (h.pinch2 !== null) this.zoom((h.pinch2 - d) * 400);
      h.pinch2 = d; h.pinch = null;
      return;
    }
    h.pinch2 = null;
    const lm = hands[0];
    if (!lm) { h.pinch = null; h.palmSince = 0; h.dwell = null; return; }
    if (pinching(lm)) {
      const p = { x: 1 - lm[9].x, y: lm[9].y };
      if (h.pinch) this.rotate((p.x - h.pinch.x) * 6, (p.y - h.pinch.y) * 4);
      h.pinch = p; h.dwell = null;
      return;
    }
    h.pinch = null;
    if (openPalm(lm)) {
      h.palmSince = h.palmSince || ts;
      if (ts - h.palmSince > 1000) { this.reset(); h.palmSince = ts + 1500; }
      return;
    }
    h.palmSince = 0;
    if (pointing(lm)) {
      const x = (1 - lm[8].x) * innerWidth, y = lm[8].y * innerHeight;
      this.setMouse(x, y);
      const n = this.hovered();
      if (n) {
        if (!h.dwell || h.dwell.id !== n.id) h.dwell = { id: n.id, since: ts };
        else if (ts - h.dwell.since > 1000) { this.onOpen(n.id); h.dwell = { id: n.id, since: ts + 3000 }; }
      } else h.dwell = null;
    }
  }

  drawHands(hands) {
    const g = this.overlay.getContext("2d"), W = this.overlay.width, H = this.overlay.height;
    g.clearRect(0, 0, W, H);
    const bones = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
      [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
    g.strokeStyle = "rgba(62,232,255,.9)"; g.fillStyle = "#eaffff"; g.lineWidth = 2;
    for (const lm of hands) {
      for (const [a, b] of bones) { g.beginPath(); g.moveTo(lm[a].x * W, lm[a].y * H); g.lineTo(lm[b].x * W, lm[b].y * H); g.stroke(); }
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
