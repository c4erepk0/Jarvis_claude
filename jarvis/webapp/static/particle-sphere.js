// Сфера ядра из частиц (three.js): оболочка дышит и «волнуется» по шуму, от голоса по ней идёт волна,
// когда Atom думает — частицы закручиваются, вокруг медленно плывёт кольцо. Рисует на своём WebGL-холсте
// под 2D-холстом с дугами показателей (reactor.js). Нет WebGL или нет сети к CDN — reactor.js рисует сферу сам.
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js";
import { MOODS, blendMood, corePoints } from "./sphere-points.js?v=30";

const VS = `
uniform float uTime, uLevel, uNoise, uSwirl, uSize, uDist;
attribute float aSeed; attribute float aLayer;
varying float vAlpha; varying float vLight;
// 3D-шум Эшима/Густавсона (simplex) — сокращённая версия
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;} vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);} vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
 vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;
 vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
 i=mod289(i);vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
 float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
 vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
 vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
 vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
 vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
 vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
 return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}
void main(){
  vec3 p = position;
  if (aLayer < 1.5) {
    float n = snoise(p * 1.7 + vec3(0.0, uTime * 0.35, 0.0));
    float wave = sin(p.y * 9.0 - uTime * 7.0) * uLevel * 0.08;          // голос — волна по оболочке
    float k = aLayer > 0.5 ? 0.6 : 1.0;
    p *= 1.0 + (n * (uNoise + uLevel * 0.12) + wave) * k + uLevel * 0.06;
    float a = uSwirl * (p.y * 2.2 + uTime * 0.8) * 0.6;              // «думаю» — завихрение вокруг оси
    p = vec3(p.x * cos(a) - p.z * sin(a), p.y, p.x * sin(a) + p.z * cos(a));
    vLight = 0.55 + 0.45 * n;
  } else {
    float a = uTime * 0.25 + aSeed * 0.02;                            // кольцо медленно плывёт
    p = vec3(p.x * cos(a) - p.z * sin(a), p.y + sin(uTime + aSeed * 6.28) * 0.02, p.x * sin(a) + p.z * cos(a));
    vLight = 0.5;
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float front = clamp((mv.z + uDist) * 0.5 + 0.5, 0.0, 1.0);            // ближняя сторона ярче — виден объём
  float tw = 0.65 + 0.35 * sin(uTime * 2.0 + aSeed * 40.0);              // мерцание
  vAlpha = (aLayer > 1.5 ? 0.5 : aLayer > 0.5 ? 0.4 : 0.9) * tw * mix(0.28, 1.0, front);
  gl_PointSize = uSize * (aLayer > 0.5 ? 0.8 : 1.0) * (1.0 + uLevel * 0.5) / -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const FS = `
uniform vec3 uColor; uniform float uGlow;
varying float vAlpha; varying float vLight;
void main(){
  float r = length(gl_PointCoord - 0.5);
  if (r > 0.5) discard;
  float s = smoothstep(0.5, 0.0, r);
  vec3 c = mix(uColor, vec3(1.0, 0.93, 0.9), vLight * 0.45 * s);
  gl_FragColor = vec4(c, s * vAlpha * uGlow);
}`;

export class ParticleSphere {
  constructor(host) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: "low-power" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.canvas = this.renderer.domElement;
    this.canvas.className = "core-gl";
    host.prepend(this.canvas);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 50);
    this.camera.position.set(0, 0.4, 5.6);
    this.camera.lookAt(0, 0, 0);
    const pts = corePoints();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pts.positions, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(pts.seeds, 1));
    g.setAttribute("aLayer", new THREE.BufferAttribute(pts.layers, 1));
    this.uniforms = { uTime: { value: 0 }, uLevel: { value: 0 }, uNoise: { value: 0.06 }, uSwirl: { value: 0 },
      uSize: { value: 40 }, uDist: { value: 5.6 }, uColor: { value: new THREE.Color(1, 0.27, 0.23) }, uGlow: { value: 0.8 } };
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: this.uniforms,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.points.rotation.z = 0.18;
    this.scene.add(this.points);
    this.mood = { ...MOODS.idle };
    this.resize();
  }

  resize() {
    const r = this.host.getBoundingClientRect();
    const s = Math.max(120, Math.min(r.width, r.height) || 360);
    this.renderer.setSize(s, s, false);
    this.uniforms.uSize.value = s * 0.085 * this.renderer.getPixelRatio();
  }

  /** Кадр: t — время ядра, level 0..1 — громкость, state — idle/listening/…, color — [r, g, b] 0..255. */
  render({ t, dt, level, state, color }) {
    this.mood = blendMood(this.mood, MOODS[state] || MOODS.idle, Math.min(1, dt * 3));
    const u = this.uniforms;
    u.uTime.value = t;
    u.uLevel.value = level;
    u.uNoise.value = this.mood.noise;
    u.uSwirl.value = this.mood.swirl;
    u.uGlow.value = this.mood.glow;
    u.uColor.value.setRGB(color[0] / 255, color[1] / 255, color[2] / 255);
    this.points.rotation.y += dt * 0.12 * (0.5 + this.mood.speed);
    this.renderer.render(this.scene, this.camera);
  }

  destroy() { this.renderer.dispose(); this.canvas.remove(); }
}
