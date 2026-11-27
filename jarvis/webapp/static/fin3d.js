// 3D-карта расходов: столбики «категория × месяц» (three.js). Вращать — мышью или пальцем, колёсико — масштаб,
// наведение — сумма. Столбики вырастают при открытии. Данные — analytics.matrix, раскладка — barGrid (fin-charts.js).
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js";
import { barGrid, money, monthShort } from "./fin-charts.js?v=30";
import { easeOutCubic, reduced } from "./motion.js?v=30";

const COLORS = [0xff453a, 0x4cd990, 0xffb347, 0x8fa8ff, 0xd58cff, 0x5fd3e6];

export class Finance3D {
  constructor(host, matrix, { currency = "RUB" } = {}) {
    this.host = host;
    this.currency = currency;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    host.append(this.renderer.domElement);
    this.tip = document.createElement("div");
    this.tip.className = "f3d-tip hidden";
    host.append(this.tip);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(4, 8, 6);
    this.scene.add(sun);
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.view = { rx: 0.62, ry: -0.6, dist: 11 };
    this.target = { ...this.view };
    this.build(matrix);
    this.bind();
    this.t0 = performance.now();
    this.resize = this.resize.bind(this);
    addEventListener("resize", this.resize);
    this.resize();
    this.running = true;
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  build(matrix) {
    const { bars, width, depth } = barGrid(matrix);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(width + 1.2, depth + 1.2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.035 }));
    floor.rotation.x = -Math.PI / 2;
    this.group.add(floor);
    const grid = new THREE.GridHelper(Math.max(width, depth) + 1.2, Math.round((Math.max(width, depth) + 1.2) / 1.4), 0x3a3132, 0x2a2324);
    grid.position.y = 0.001;
    this.group.add(grid);
    const geo = new THREE.BoxGeometry(0.9, 1, 0.9);
    geo.translate(0, 0.5, 0);                 // растёт от пола
    this.bars = bars.map((b) => {
      const mat = new THREE.MeshStandardMaterial({ color: COLORS[b.ci % COLORS.length], roughness: 0.45, metalness: 0.1,
        transparent: true, opacity: b.value ? 0.92 : 0.12 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(b.x, 0, b.z);
      mesh.scale.y = 0.001;
      mesh.userData = b;
      this.group.add(mesh);
      return mesh;
    });
    this.labels = [
      ...[...new Set(bars.map((b) => b.month))].map((m) => ({ text: monthShort(m), pos: new THREE.Vector3(bars.find((b) => b.month === m).x, 0, depth / 2 + 0.6) })),
      ...[...new Set(bars.map((b) => b.category))].map((c) => ({ text: c, pos: new THREE.Vector3(-width / 2 - 0.5, 0, bars.find((b) => b.category === c).z), right: true })),
    ].map((l) => {
      const el = document.createElement("span");
      el.className = `f3d-lbl${l.right ? " r" : ""}`;
      el.textContent = l.text;
      this.host.append(el);
      return { ...l, el };
    });
    this.height = 4.2;
  }

  bind() {
    const el = this.renderer.domElement;
    let drag = null;
    this.ray = new THREE.Raycaster();
    this.mouse = new THREE.Vector2(-9, -9);
    el.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId); });
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.hoverAt = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (!drag) return;
      this.target.ry += (e.clientX - drag.x) * 0.008;
      this.target.rx = Math.max(0.15, Math.min(1.35, this.target.rx + (e.clientY - drag.y) * 0.006));
      drag = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener("pointerup", () => { drag = null; });
    el.addEventListener("pointerleave", () => { this.mouse.set(-9, -9); });
    el.addEventListener("wheel", (e) => { e.preventDefault(); this.target.dist = Math.max(7, Math.min(24, this.target.dist + e.deltaY * 0.01)); }, { passive: false });
  }

  resize() {
    const w = this.host.clientWidth || 600, h = this.host.clientHeight || 360;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  loop(now) {
    if (!this.running) return;
    const grow = reduced() ? 1 : easeOutCubic((now - this.t0) / 1100);
    this.bars.forEach((m, i) => {
      const delay = reduced() ? 0 : (m.userData.mi * 0.06 + m.userData.ci * 0.04);
      const g = reduced() ? 1 : easeOutCubic((now - this.t0) / 900 - delay);
      m.scale.y = Math.max(0.001, m.userData.h * this.height * Math.min(grow, g < 0 ? 0 : g));
    });
    for (const k of ["rx", "ry", "dist"]) this.view[k] += (this.target[k] - this.view[k]) * 0.1;
    if (!this.dragging && !reduced()) this.target.ry += 0.0012;
    const { rx, ry, dist } = this.view;
    this.camera.position.set(Math.sin(ry) * Math.cos(rx) * dist, Math.sin(rx) * dist, Math.cos(ry) * Math.cos(rx) * dist);
    this.camera.lookAt(0, 1.2, 0);
    // наведение — сумма в подсказке, столбик подсвечивается
    this.ray.setFromCamera(this.mouse, this.camera);
    const hit = this.ray.intersectObjects(this.bars)[0]?.object;
    this.bars.forEach((m) => m.material.emissive?.setHex(m === hit ? 0x333333 : 0x000000));
    if (hit && this.hoverAt) {
      const b = hit.userData;
      this.tip.textContent = `${b.category} · ${monthShort(b.month)}: ${money(b.value, this.currency)}`;
      this.tip.style.transform = `translate(${this.hoverAt.x + 12}px, ${this.hoverAt.y - 10}px)`;
      this.tip.classList.remove("hidden");
    } else this.tip.classList.add("hidden");
    this.renderer.render(this.scene, this.camera);
    const w = this.host.clientWidth, h = this.host.clientHeight, v = new THREE.Vector3();
    this.group.updateMatrixWorld();
    for (const l of this.labels) {
      v.copy(l.pos).applyMatrix4(this.group.matrixWorld).project(this.camera);
      l.el.style.transform = `translate(${(v.x * 0.5 + 0.5) * w}px, ${(-v.y * 0.5 + 0.5) * h}px) translate(${l.right ? "-100%" : "-50%"}, -50%)`;
    }
    requestAnimationFrame(this.loop);
  }

  destroy() {
    this.running = false;
    removeEventListener("resize", this.resize);
    this.renderer.dispose();
    this.host.innerHTML = "";
  }
}
