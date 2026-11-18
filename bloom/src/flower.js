/**
 * flower.js — 一枝三朵：粒子花、藤蔓、光丝、双端爆花。
 *
 * 一个 BufferGeometry（9990 点 = 每朵 3000 ×3 + 花粉球）承载三朵花：
 *   aFlower 标记属于哪朵，uBloom3 / uHeat3 / uBurst3 三个 vec3 驱动它们。
 * 每朵分四层：花心（密）、花瓣（5–6 片 × 3 层）、轮廓（亮粒子描边）、花粉（慢速漂浮）。
 * 层与层之间在「花苞位 → 绽放位」的插值上错开 60–120ms。
 *
 * 所有变化都走插值（绽放 0.90s easeOutCubic / 合拢 2.50s easeInOutCubic），
 * 没有任何一帧直接赋值，杜绝瞬变。
 */

import * as THREE from 'three';
import { FLOWER_LAYOUT, BLOOM, EXPOSURE, STAGE } from './config.js';
import { COLOR, FLORA, FLOWER_TINT, TRAIL, BURST, BRANCH, srgbToLinear, hexToLinear, rgbToLinear } from './theme.js';

const TAU = Math.PI * 2;
const W = STAGE.w;
const H = STAGE.h;

const toWorld = (x, y) => [x - W / 2, H / 2 - y];

/** 确定性随机（同一份布局每次跑都一样，三帧法才不会飘） */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeInCubic = (t) => t * t * t;

const hexToRgb = hexToLinear; // shader 里吃的是线性光
const TINT_LIN = FLOWER_TINT.map((t) => ({
  petal: rgbToLinear(t.petal),
  edge: rgbToLinear(t.edge),
  core: rgbToLinear(t.core),
}));
const C_CORE = hexToRgb(COLOR.core);
const C_GOLD = hexToRgb(COLOR.gold);
const C_MOON = hexToRgb(COLOR.moon);
const C_CORAL = hexToRgb(COLOR.coral);
const C_SAKURA = hexToRgb(COLOR.sakura);
const C_HONEY = hexToRgb(COLOR.honey);

const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

const FLOWER_SPIN = [0.42, -0.24, 0.66];
const FLOWER_TILT_X = [-0.26, -0.14, -0.32];
const FLOWER_TILT_Y = [0.16, -0.12, 0.22];

/* ── 每朵的粒子构成 ─────────────────────────────────────── */
function buildFlowerPoints(f, rand) {
  const spec = FLOWER_LAYOUT[f];
  const R = FLORA.baseRadius * spec.scale;
  const tint = TINT_LIN[f];
  const petals = FLORA.petalCount[f];
  const out = { bud: [], bloom: [], color: [], size: [], alpha: [], layer: [] };

  const push = (bud, bloom, color, size, alpha, layer) => {
    out.bud.push(bud[0], -bud[1], bud[2]); // 舞台 y 向下 → 世界 y 向上
    out.bloom.push(bloom[0], -bloom[1], bloom[2]);
    out.color.push(color[0], color[1], color[2]);
    out.size.push(size);
    out.alpha.push(alpha);
    out.layer.push(layer);
  };

  const tilt = (x, y, z) => {
    const tx = FLOWER_TILT_X[f];
    const ty = FLOWER_TILT_Y[f];
    const y1 = y * Math.cos(tx) - z * Math.sin(tx);
    const z1 = y * Math.sin(tx) + z * Math.cos(tx);
    const x2 = x * Math.cos(ty) + z1 * Math.sin(ty);
    const z2 = -x * Math.sin(ty) + z1 * Math.cos(ty);
    return [x2, y1, z2];
  };

  // 花苞的局部坐标（相对花位锚点）
  const budPoint = () => {
    const h = 0.12 + 0.88 * Math.pow(rand(), 0.82);
    const rad = FLORA.budWidth * R * Math.pow(Math.sin(Math.PI * Math.min(1, h * 1.01)), 0.72) * (0.45 + 0.55 * rand());
    const ang = rand() * TAU;
    return [Math.cos(ang) * rad * 1.0, h * FLORA.budHeight * R - FLORA.budHeight * R * 0.42, Math.sin(ang) * rad * 0.78];
  };

  const petalHalfWidth = (u) => FLORA.petalWidth * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.78)), 0.62);

  const petalPoint = (u, v, layerIdx, petalIdx, edge = false) => {
    const scale = FLORA.petalLayers[layerIdx];
    const ang =
      FLOWER_SPIN[f] * 0.4 +
      (petalIdx * TAU) / petals +
      FLORA.petalLayerTwist[layerIdx] +
      v * petalHalfWidth(u) * 0.95;
    const r = u * R * 0.95 * scale;
    const x = Math.cos(ang) * r;
    const y = Math.sin(ang) * r;
    const curl = Math.pow(u, 1.6) * R * FLORA.petalOpenCurl * (0.45 + 0.55 * scale);
    const zBase = layerIdx === 0 ? 7 : layerIdx === 1 ? 1.5 : -5;
    return tilt(x, y, zBase + curl);
  };

  const core = Math.round(FLORA.mix.core * 3000);
  const outline = Math.round(FLORA.mix.outline * 3000);
  const pollen = Math.round(FLORA.mix.pollen * 3000);
  const haze = Math.round(FLORA.mix.haze * 3000);
  const petalN = 3000 - core - outline - pollen - haze;

  /* 花心：密、暖白 → 蜜金，带一点雄蕊丝 */
  for (let i = 0; i < core; i += 1) {
    const bud = budPoint();
    const stamen = i % 9 === 0; // 少量雄蕊：从中心射出的短线
    let r;
    let ang;
    let z;
    if (stamen) {
      ang = (i / core) * TAU * 6.4 + rand() * 0.2;
      r = R * (0.05 + rand() * 0.1);
      z = 10 + rand() * 6;
    } else {
      ang = rand() * TAU;
      r = R * FLORA.coreRadius * Math.sqrt(rand());
      z = (rand() - 0.5) * R * 0.1 + 6;
    }
    const bloom = tilt(Math.cos(ang) * r, Math.sin(ang) * r, z);
    const t = Math.min(1, r / (R * FLORA.coreRadius));
    const color = mix3(C_CORE, C_GOLD, Math.pow(t, 1.4) * 0.85);
    const size = lerp(FLORA.size.core[0], FLORA.size.core[1], Math.pow(rand(), 1.5)) * (stamen ? 1.25 : 1);
    push(bud, bloom, color, size, FLORA.alpha.core * (0.55 + 0.45 * rand()), 0);
  }

  /* 花瓣：每片 3 层 × 花瓣数，表面撒点 + 中脉 */
  for (let i = 0; i < petalN; i += 1) {
    const bud = budPoint();
    const layerIdx = i % 3;
    const petalIdx = Math.floor(rand() * petals);
    const vein = rand() < 0.45;
    const u = Math.pow(rand(), 0.72);
    let v;
    if (vein) {
      const veins = 5;
      const k = Math.floor(rand() * veins);
      v = (k / (veins - 1)) * 2 - 1;
      v = v * 0.82 + (rand() - 0.5) * 0.06;
    } else {
      v = (rand() * 2 - 1) * 0.96;
    }
    const bloom = petalPoint(u, v, layerIdx, petalIdx);
    const inner = 1 - layerIdx * 0.22;
    const edgeMix = Math.min(1, Math.abs(v) * 0.7 + u * 0.4);
    const color = mix3(mix3(tint.petal, tint.edge, edgeMix), C_HONEY, u * 0.25 * inner);
    const size = lerp(FLORA.size.petal[0], FLORA.size.petal[1], Math.pow(rand(), 1.4));
    push(bud, bloom, color, size, FLORA.alpha.petal * (0.5 + 0.5 * rand()) * inner, 1);
  }

  /* 轮廓：沿瓣缘的亮粒子（描边），少量冷月白 */
  for (let i = 0; i < outline; i += 1) {
    const bud = budPoint();
    const layerIdx = i % 3;
    const petalIdx = Math.floor(rand() * petals);
    const u = 0.12 + 0.88 * rand();
    const side = rand() < 0.5 ? -1 : 1;
    const v = side * (0.94 + (rand() - 0.5) * 0.1);
    const bloom = petalPoint(u, v, layerIdx, petalIdx, true);
    const moon = rand() < 0.085; // 冷月白 ≤10%
    const color = moon ? mix3(C_MOON, tint.edge, 0.35) : mix3(tint.edge, C_HONEY, 0.3 + rand() * 0.3);
    const size = lerp(FLORA.size.outline[0], FLORA.size.outline[1], Math.pow(rand(), 1.3));
    push(bud, bloom, color, size, FLORA.alpha.outline * (0.55 + 0.45 * rand()), 2);
  }

  /* 花粉：慢速漂浮的小点，绽开后散在花外 */
  for (let i = 0; i < pollen; i += 1) {
    const bud = budPoint();
    const ang = rand() * TAU;
    const rr = R * (FLORA.pollenShell * (0.62 + rand() * 0.62));
    const zz = (rand() - 0.5) * R * 0.35;
    const bloom = tilt(Math.cos(ang) * rr, Math.sin(ang) * rr, zz);
    const color = mix3(mix3(tint.edge, C_GOLD, 0.45), C_MOON, rand() * 0.08);
    const size = lerp(FLORA.size.pollen[0], FLORA.size.pollen[1], rand());
    push(bud, bloom, color, size, FLORA.alpha.pollen * (0.45 + 0.55 * rand()), 3);
  }

  /* 柔光：几团大而淡的光，给花「茸」的体积（不是把花糊掉） */
  for (let i = 0; i < haze; i += 1) {
    const bud = budPoint();
    const layerIdx = i % 3;
    const petalIdx = Math.floor(rand() * petals);
    const u = 0.25 + 0.75 * Math.pow(rand(), 0.6);
    const v = (rand() * 2 - 1) * 0.7;
    const bloom = petalPoint(u, v, layerIdx, petalIdx);
    const color = mix3(tint.petal, tint.core, 0.25 + rand() * 0.35);
    const size = lerp(FLORA.size.haze[0], FLORA.size.haze[1], rand());
    push(bud, bloom, color, size, FLORA.alpha.haze * (0.6 + 0.4 * rand()), 4);
  }

  return out;
}

/* ── 光丝（沿枝的一条亮线，扫过花瓣） ──────────────────── */
class Filament {
  constructor(scene) {
    const N = 56;
    const pos = new Float32Array(N * 3);
    const u = new Float32Array(N);
    for (let i = 0; i < N; i += 1) u[i] = i / (N - 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aU', new THREE.BufferAttribute(u, 1));
    this.uniforms = {
      uHead: { value: 0 },
      uAlpha: { value: 0 },
      uColor: { value: new THREE.Color(TRAIL.filamentColor) },
      uPxScale: { value: 1 },
      uWidth: { value: TRAIL.filamentWidth },
      uTail: { value: TRAIL.filamentTail },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute float aU;
        uniform float uHead, uAlpha, uPxScale, uWidth, uTail;
        varying float vA;
        void main() {
          float d = (aU - uHead);
          float band = exp(-pow(max(0.0, -d) / uTail, 2.0));
          float ahead = step(0.0, d);
          vA = uAlpha * band * (1.0 - ahead);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(uWidth * uPxScale * (0.55 + band * 1.5), 1.0, 30.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vA;
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          float d = length(q) * 2.0;
          if (d > 1.0) discard;
          float a = pow(1.0 - d, 2.0);
          gl_FragColor = vec4(uColor, a * vA);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    scene.add(this.points);
    this.active = false;
    this.t0 = 0;
    this.dur = 1;
    this.alpha = 0;
  }

  setPath(points) {
    const attr = this.points.geometry.getAttribute('position');
    for (let i = 0; i < attr.count; i += 1) {
      attr.setXYZ(i, points[i][0], points[i][1], points[i][2] ?? 6);
    }
    attr.needsUpdate = true;
  }

  play({ now, dur = 1, alpha = 0.9 }) {
    this.active = true;
    this.t0 = now;
    this.dur = dur;
    this.alpha = alpha;
    this.points.visible = true;
  }

  update(now, pxScale) {
    if (!this.active) return;
    const t = (now - this.t0) / (this.dur * 1000);
    if (t >= 1.25) {
      this.active = false;
      this.points.visible = false;
      return;
    }
    const p = clamp01(t);
    this.uniforms.uHead.value = easeInOutCubic(p) * 1.06 - 0.03;
    const fade = t <= 1 ? 1 : 1 - (t - 1) / 0.25;
    this.uniforms.uAlpha.value = this.alpha * fade;
    this.uniforms.uPxScale.value = pxScale;
  }
}

/* ── 双端爆花：白色冲击环 + 花粉球（0.5s 消散，不是火球） ── */
class BurstFx {
  constructor(scene, pxScaleRef) {
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    this.pxScaleRef = pxScaleRef;

    // 环
    this.ringUniforms = {
      uR: { value: 0 },
      uA: { value: 0 },
      uColor: { value: new THREE.Color(COLOR.core) },
    };
    const ringMat = new THREE.ShaderMaterial({
      uniforms: this.ringUniforms,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform float uR, uA;
        uniform vec3 uColor;
        varying vec2 vUv;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          float band = exp(-pow((d - uR) / 0.075, 2.0));
          float inner = smoothstep(uR, uR - 0.25, d) * 0.18;
          float a = (band + inner) * uA;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), ringMat);
    this.ring.frustumCulled = false;
    this.group.add(this.ring);

    // 花粉球
    const N = BURST.pollenCount;
    const rand = mulberry32(9173);
    const dirs = new Float32Array(N * 3);
    const seeds = new Float32Array(N);
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i += 1) {
      const th = rand() * TAU;
      const ph = Math.acos(2 * rand() - 1);
      const sx = Math.sin(ph) * Math.cos(th);
      const sy = Math.sin(ph) * Math.sin(th);
      const sz = Math.cos(ph) * 0.5;
      dirs[i * 3] = sx;
      dirs[i * 3 + 1] = sy;
      dirs[i * 3 + 2] = sz;
      seeds[i] = rand();
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aDir', new THREE.BufferAttribute(dirs, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    this.pollenUniforms = {
      uT: { value: 0 },
      uA: { value: 0 },
      uR: { value: 0 },
      uPxScale: { value: 1 },
      uColor: { value: new THREE.Color(COLOR.core) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.pollenUniforms,
      vertexShader: /* glsl */ `
        attribute vec3 aDir;
        attribute float aSeed;
        uniform float uT, uA, uR, uPxScale;
        varying float vA;
        void main() {
          vec3 p = aDir * uR * (0.35 + aSeed * 0.9);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp((1.1 + aSeed * 2.4) * uPxScale, 1.0, 24.0);
          vA = uA * (0.35 + aSeed * 0.65);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vA;
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          float d = length(q) * 2.0;
          if (d > 1.0) discard;
          float a = pow(1.0 - d, 2.2);
          gl_FragColor = vec4(uColor, a * vA);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.pollen = new THREE.Points(geo, mat);
    this.pollen.frustumCulled = false;
    this.group.add(this.pollen);

    this.active = false;
    this.t0 = 0;
    this.dur = BURST.dur;
  }

  play(center, now, radius) {
    this.active = true;
    this.t0 = now;
    this.center = center.clone();
    this.radius = radius;
    this.group.position.copy(center);
    this.group.visible = true;
  }

  update(now, pxScale) {
    if (!this.active) return;
    const t = (now - this.t0) / 1000;
    const p = clamp01(t / this.dur);
    const radius = this.radius;
    const expand = BURST.ringR0 + (BURST.ringR1 - BURST.ringR0) * easeOutCubic(p);
    this.ringUniforms.uR.value = expand;
    this.ringUniforms.uA.value = BURST.ringAlpha * Math.pow(1 - p, 1.6);
    this.ring.scale.setScalar(radius * 2.6);

    // 0–0.25s 向外炸开，0.25–0.85s 往回收（重组）
    const outT = clamp01(t / 0.25);
    const backT = clamp01((t - 0.25) / 0.6);
    const rr = lerp(BURST.pollenR[0], BURST.pollenR[1], easeOutCubic(outT)) * (1 - easeInCubic(backT) * 0.92);
    this.pollenUniforms.uR.value = radius * rr;
    this.pollenUniforms.uA.value = 0.9 * (1 - backT) * (0.4 + 0.6 * outT);
    this.pollenUniforms.uT.value = t;
    this.pollenUniforms.uPxScale.value = pxScale;
    if (t >= this.dur + 0.35) {
      this.active = false;
      this.group.visible = false;
    }
  }
}

/* ── 主类 ───────────────────────────────────────────────── */
export class Flora {
  constructor({ scene, theme } = {}) {
    this.scene = scene;
    this.theme = theme;
    this.pxScale = 1;
    this.time = 0;
    this.breathPhase = 0;
    this.opacity = 0;
    this.targetOpacity = 0;
    this.budget = 9000;
    this.exposureLevel = 0;

    this.flowers = FLOWER_LAYOUT.map((f) => ({
      id: f.id,
      scale: f.scale,
      center: new THREE.Vector3(...toWorld(f.x * W, f.y * H), 0),
      value: 0,
      anim: null, // {from,to,t0,dur,ease}
      heat: 0,
      heatT0: -1e9,
      burst: 0,
      burstT0: -1e9,
      burstDur: 0.25,
      // v2：连续驱动的目标与时间常数（null = 没在被连续驱动）
      target: null,
      tauUp: 0.85,
      tauDown: 1.6,
      delayUntil: 0,
    }));

    this.geometry = this._buildGeometry();

    // v2：外观变体 + 3D 转角（都平滑过渡，不瞬变）
    this.variant = 0;
    this.variantTarget = { twist: 0, size: 1 };
    this.orbitTarget = [0, 0, 0];
    this.orbitCur = [0, 0, 0];
    // v3：抓手转着看——每朵一个 (yaw, pitch, roll) 三轴自转状态
    this.spinTarget = [
      { yaw: 0, pitch: 0, roll: 0 },
      { yaw: 0, pitch: 0, roll: 0 },
      { yaw: 0, pitch: 0, roll: 0 },
    ];
    this.spinCur = [
      { yaw: 0, pitch: 0, roll: 0 },
      { yaw: 0, pitch: 0, roll: 0 },
      { yaw: 0, pitch: 0, roll: 0 },
    ];

    this.uniforms = {
      uCenter0: { value: this.flowers[0].center },
      uCenter1: { value: this.flowers[1].center },
      uCenter2: { value: this.flowers[2].center },
      uBloom3: { value: new THREE.Vector3(0, 0, 0) },
      uHeat3: { value: new THREE.Vector3(0, 0, 0) },
      uBurst3: { value: new THREE.Vector3(0, 0, 0) },
      uOrbit3: { value: new THREE.Vector3(0, 0, 0) },
      uTilt3: { value: new THREE.Vector3(0, 0, 0) },
      uRoll3: { value: new THREE.Vector3(0, 0, 0) },
      uTwist: { value: 0 },
      uRadius: { value: FLORA.baseRadius },
      uTime: { value: 0 },
      uBreath: { value: 1 },
      uExposure: { value: 1 },
      uPxScale: { value: 1 },
      uSizeMul: { value: 1 },
      uGlow: { value: 1 },
      uOpacity: { value: 0 },
    };
    this.points = new THREE.Points(this.geometry, this._makeMaterial());
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    this.scene.add(this.points);

    this._buildBranch();
    this.filaments = [new Filament(scene), new Filament(scene)];
    this.burstFx = new BurstFx(scene, this.pxScale);
    this._filamentSlots = 0;
  }

  _makeMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute vec3 aBud;
        attribute vec3 aBloom;
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        attribute float aFlower;
        attribute float aLayer;
        attribute float aDelay;
        attribute vec3 aSeed;

        uniform vec3 uCenter0, uCenter1, uCenter2;
        uniform vec3 uBloom3, uHeat3, uBurst3, uOrbit3, uTilt3, uRoll3;
        uniform float uTime, uBreath, uExposure, uPxScale, uSizeMul, uGlow, uOpacity, uTwist, uRadius;

        varying vec3 vColor;
        varying float vAlpha;

        float pick(vec3 v, float id) { return id < 0.5 ? v.x : (id < 1.5 ? v.y : v.z); }
        vec3 pick3(vec3 a, vec3 b, vec3 c, float id) { return id < 0.5 ? a : (id < 1.5 ? b : c); }
        float easeOutCubic(float t) { float u = 1.0 - t; return 1.0 - u * u * u; }

        void main() {
          float bloom = pick(uBloom3, aFlower);
          float heat = pick(uHeat3, aFlower);
          float burst = pick(uBurst3, aFlower);
          float orbit = pick(uOrbit3, aFlower);
          vec3 center = pick3(uCenter0, uCenter1, uCenter2, aFlower);

          float p = clamp((bloom - aDelay) / max(1.0 - aDelay, 0.001), 0.0, 1.0);
          float tp = easeOutCubic(p);

          vec3 bud = aBud * mix(uBreath, 1.0, tp);

          // 变体：整朵按半径线性扭一个角度（圆雕 → 旋瓣），读起来是"另一种花"
          vec3 rel = aBloom;
          if (abs(uTwist) > 0.0001) {
            float sw = uTwist * (length(rel.xy) / max(uRadius, 1.0));
            float cs = cos(sw);
            float sn = sin(sw);
            rel.xy = vec2(rel.x * cs - rel.y * sn, rel.x * sn + rel.y * cs);
          }
          // 3D 浏览：绕自身竖轴转（x/z 换轴，透视压缩感来自已有的深度明暗）
          if (abs(orbit) > 0.0001) {
            float co = cos(orbit);
            float so = sin(orbit);
            float ox = rel.x * co + rel.z * so;
            float oz = -rel.x * so + rel.z * co;
            rel = vec3(ox, rel.y, oz);
          }
          // v3：抓手转着看——再加俯仰（绕 X）与滚转（绕视线 Z），三轴合起来 360° 无死角
          float tilt = pick(uTilt3, aFlower);
          if (abs(tilt) > 0.0001) {
            float ct = cos(tilt);
            float st = sin(tilt);
            float ty = rel.y * ct - rel.z * st;
            float tz = rel.y * st + rel.z * ct;
            rel = vec3(rel.x, ty, tz);
          }
          float roll = pick(uRoll3, aFlower);
          if (abs(roll) > 0.0001) {
            float cr = cos(roll);
            float sr = sin(roll);
            float rx = rel.x * cr - rel.y * sr;
            float ry = rel.x * sr + rel.y * cr;
            rel = vec3(rx, ry, rel.z);
          }

          vec3 pos = mix(bud, rel, tp);

          // 花粉：慢速漂浮
          if (aLayer > 2.5 && aLayer < 3.5) {
            float s = aSeed.x * 6.2831;
            pos += vec3(sin(uTime * 0.55 + s), cos(uTime * 0.44 + s * 1.7), sin(uTime * 0.37 + s * 2.3)) *
                   (12.0 + aSeed.y * 24.0) * (0.35 + 0.65 * tp);
          }

          // 爆花：沿随机方向炸开，再由外层曲线收回
          if (burst > 0.0005) {
            vec3 dir = normalize(aSeed - 0.5 + vec3(0.0011, 0.0007, 0.0013));
            pos += dir * burst * (90.0 + aSeed.z * 300.0);
          }
          pos += center;

          float depth = clamp(rel.z / 150.0, -1.0, 1.0);
          // 花苞小、暗；绽放才长到全尺寸（否则 3000 粒子挤在小花苞里会烧成白点）
          float budMix = mix(0.4, 1.0, tp);
          float sz = aSize * uPxScale * uSizeMul * budMix * (1.0 + depth * 0.16) * (1.0 + heat * 0.22);
          gl_PointSize = clamp(sz, 1.0, 64.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);

          vColor = aColor * uGlow * (1.0 + heat * 0.7) * (1.0 + depth * 0.1) * uExposure;
          vAlpha = aAlpha * mix(0.24, 1.0, tp) * uOpacity;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          float d = length(q) * 2.0;
          if (d > 1.0) discard;
          float a = pow(1.0 - d, 2.35);
          gl_FragColor = vec4(vColor, a * vAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
  }

  _buildGeometry() {
    const rand = mulberry32(20241118);
    const per = [];
    for (let f = 0; f < 3; f += 1) per.push(buildFlowerPoints(f, rand));
    const perCount = per[0].size.length;
    const total = perCount * 3;
    const pos = new Float32Array(total * 3);
    const aBud = new Float32Array(total * 3);
    const aBloom = new Float32Array(total * 3);
    const aColor = new Float32Array(total * 3);
    const aSize = new Float32Array(total);
    const aAlpha = new Float32Array(total);
    const aFlower = new Float32Array(total);
    const aLayer = new Float32Array(total);
    const aDelay = new Float32Array(total);
    const aSeed = new Float32Array(total * 3);
    const delayOf = {
      0: FLORA.layerDelay.core / BLOOM.openDur,
      1: FLORA.layerDelay.petal / BLOOM.openDur,
      2: FLORA.layerDelay.outline / BLOOM.openDur,
      3: FLORA.layerDelay.pollen / BLOOM.openDur,
      4: FLORA.layerDelay.haze / BLOOM.openDur,
    };
    let k = 0;
    // 交叉排列：先按「每朵第 i 颗」，这样降画质时每朵同时掉点
    for (let i = 0; i < perCount; i += 1) {
      for (let f = 0; f < 3; f += 1) {
        const p = per[f];
        aBud[k * 3] = p.bud[i * 3];
        aBud[k * 3 + 1] = p.bud[i * 3 + 1];
        aBud[k * 3 + 2] = p.bud[i * 3 + 2];
        aBloom[k * 3] = p.bloom[i * 3];
        aBloom[k * 3 + 1] = p.bloom[i * 3 + 1];
        aBloom[k * 3 + 2] = p.bloom[i * 3 + 2];
        pos[k * 3] = aBud[k * 3];
        pos[k * 3 + 1] = aBud[k * 3 + 1];
        pos[k * 3 + 2] = aBud[k * 3 + 2];
        aColor[k * 3] = p.color[i * 3];
        aColor[k * 3 + 1] = p.color[i * 3 + 1];
        aColor[k * 3 + 2] = p.color[i * 3 + 2];
        aSize[k] = p.size[i];
        aAlpha[k] = p.alpha[i];
        aFlower[k] = f;
        aLayer[k] = p.layer[i];
        aDelay[k] = delayOf[p.layer[i]];
        aSeed[k * 3] = rand();
        aSeed[k * 3 + 1] = rand();
        aSeed[k * 3 + 2] = rand();
        k += 1;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aBud', new THREE.BufferAttribute(aBud, 3));
    geo.setAttribute('aBloom', new THREE.BufferAttribute(aBloom, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(aColor, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(aSize, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(aAlpha, 1));
    geo.setAttribute('aFlower', new THREE.BufferAttribute(aFlower, 1));
    geo.setAttribute('aLayer', new THREE.BufferAttribute(aLayer, 1));
    geo.setAttribute('aDelay', new THREE.BufferAttribute(aDelay, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 3));
    geo.setDrawRange(0, total);
    return geo;
  }

  /** 第 i 朵的花梗曲线：从枝上的点弯到花心下方，t → [stageX, stageY] */
  _stemCurve(i) {
    const spec = FLOWER_LAYOUT[i];
    const branchY = this._branchY || ((t) => lerp(0.588, 0.638, t) * H);
    const tBranch = (spec.x - 0.075) / 0.85;
    const baseX = spec.x * W;
    const baseY = branchY(tBranch) - 2;
    const tipX = baseX + (i === 1 ? 16 : i === 0 ? -12 : 10);
    const tipY = spec.y * H + FLORA.baseRadius * spec.scale * 0.34;
    const bow = i === 1 ? 26 : -14;
    return (t) => [lerp(baseX, tipX, t) + Math.sin(t * Math.PI) * bow, lerp(baseY, tipY, t)];
  }

  _buildBranch() {
    const sag = BRANCH.sag / H;
    const branchY = (t) => (lerp(0.588, 0.638, t) + Math.sin(Math.PI * t) * sag) * H;
    const pts = [];
    for (let i = 0; i <= 32; i += 1) {
      const t = i / 32;
      const [wx, wy] = toWorld(lerp(0.075, 0.925, t) * W, branchY(t));
      pts.push(new THREE.Vector3(wx, wy, 2));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({
      color: new THREE.Color(BRANCH.color),
      transparent: true,
      opacity: BRANCH.opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.branch = new THREE.Line(geo, mat);
    this.branch.frustumCulled = false;
    this.scene.add(this.branch);

    // 枝条 / 花梗用「光点」再画一遍：1px 的线在竖屏里太细，看不出是一枝
    const twigPts = [];
    const twigSize = [];
    const twigAlpha = [];
    const twigRand = mulberry32(90210);
    const pushTwig = (x, y, z, base, taper) => {
      twigPts.push(...toWorld(x + (twigRand() - 0.5) * 1.6, y + (twigRand() - 0.5) * 1.6), z);
      twigSize.push(lerp(BRANCH.dotSize[0], BRANCH.dotSize[1], twigRand()) * taper);
      twigAlpha.push(base * (0.55 + 0.45 * twigRand()));
    };
    for (let i = 0; i <= 640; i += 1) {
      const t = i / 640;
      const taper = 0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 1.05));
      pushTwig(lerp(0.075, 0.925, t) * W, branchY(t), 2, BRANCH.dotAlpha, taper);
    }
    for (let k = 0; k < 3; k += 1) {
      const stem = this._stemCurve(k);
      for (let i = 0; i <= 220; i += 1) {
        const t = i / 220;
        const p = stem(t);
        pushTwig(p[0], p[1], 1.5, BRANCH.stemDotAlpha, 0.8 + 0.2 * (1 - t));
      }
    }
    const twigGeo = new THREE.BufferGeometry();
    twigGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(twigPts), 3));
    twigGeo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(twigSize), 1));
    twigGeo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(twigAlpha), 1));
    this.twigMat = new THREE.ShaderMaterial({
      uniforms: {
        uPxScale: { value: this.pxScale || 1 },
        uColor: { value: new THREE.Color(BRANCH.color) },
        uOpacity: { value: 0 },
        uTime: { value: 0 },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aAlpha;
        uniform float uPxScale, uTime;
        varying float vA;
        void main() {
          vA = aAlpha * (0.86 + 0.14 * sin(uTime * 0.7 + position.x * 0.05));
          gl_PointSize = clamp(aSize * uPxScale, 1.0, 12.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vA;
        void main() {
          vec2 q = gl_PointCoord - 0.5;
          float d = length(q) * 2.0;
          if (d > 1.0) discard;
          gl_FragColor = vec4(uColor, pow(1.0 - d, 1.9) * vA * uOpacity);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.twigPoints = new THREE.Points(twigGeo, this.twigMat);
    this.twigPoints.frustumCulled = false;
    this.twigPoints.renderOrder = 2;
    this.scene.add(this.twigPoints);

    // 花梗：从枝上把三朵接住（短、略弯、比枝更暗一点）
    this._branchY = branchY;
    this.stems = [];
    for (let i = 0; i < 3; i += 1) {
      const curve = this._stemCurve(i);
      const linePts = [];
      for (let s = 0; s <= 16; s += 1) {
        const [x, y] = curve(s / 16);
        const [wx, wy] = toWorld(x, y);
        linePts.push(new THREE.Vector3(wx, wy, 1.5));
      }
      const sg = new THREE.BufferGeometry().setFromPoints(linePts);
      const sm = new THREE.LineBasicMaterial({
        color: new THREE.Color(BRANCH.color),
        transparent: true,
        opacity: BRANCH.stemOpacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const stem = new THREE.Line(sg, sm);
      stem.frustumCulled = false;
      this.scene.add(stem);
      this.stems.push(stem);
    }

    // 极细藤蔓：从枝上垂下的几根小卷须
    const rand = mulberry32(4242);
    this.branchTendrils = [];
    for (let k = 0; k < BRANCH.tendrils; k += 1) {
      const t = 0.1 + (k / BRANCH.tendrils) * 0.8 + rand() * 0.04;
      let px = lerp(0.075, 0.925, t) * W;
      let py = branchY(t) + 4;
      const len = 26 + rand() * 46;
      const dir = k % 2 === 0 ? 1 : -1;
      const linePts = [];
      for (let s = 0; s <= 10; s += 1) {
        px += Math.sin(s * 0.85 + k * 1.7) * 3.0 * dir + 0.5;
        py += len / 10;
        const [wx, wy] = toWorld(px, py);
        linePts.push(new THREE.Vector3(wx, wy, 1));
      }
      const lg = new THREE.BufferGeometry().setFromPoints(linePts);
      const lm = new THREE.LineBasicMaterial({
        color: new THREE.Color(BRANCH.color),
        transparent: true,
        opacity: BRANCH.tendrilOpacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const line = new THREE.Line(lg, lm);
      line.frustumCulled = false;
      this.scene.add(line);
      this.branchTendrils.push(line);
    }
  }

  /* ── 操作 ─────────────────────────────────────────────── */

  setPxScale(pxScale) {
    this.pxScale = pxScale;
    this.uniforms.uPxScale.value = pxScale;
    if (this.twigMat) this.twigMat.uniforms.uPxScale.value = pxScale;
  }

  setBudget(n) {
    this.budget = n;
    const per = Math.max(1200, Math.floor(n / 3));
    this.geometry.setDrawRange(0, Math.min(per * 3, this.geometry.getAttribute('position').count));
  }

  setOpacity(v) {
    this.targetOpacity = clamp01(v);
  }

  openFlower(i, { now, delay = 0, dur = BLOOM.openDur } = {}) {
    const f = this.flowers[i];
    if (!f) return;
    const start = now + delay * 1000;
    // 用连续逼近而不是 from/t0/dur：低帧率下固定时长动画会「跳一帧就到位」
    f.anim = null;
    f.target = 1;
    f.tauUp = dur;
    f.tauDown = BLOOM.closeDur;
    f.delayUntil = start;
    this._flashCore(i, start + dur * 1000 * 0.55);
  }

  closeFlower(i, { now, delay = 0, dur = BLOOM.closeDur } = {}) {
    const f = this.flowers[i];
    if (!f) return;
    f.anim = null;
    f.target = 0;
    f.tauUp = BLOOM.openDur;
    f.tauDown = dur;
    f.delayUntil = now + delay * 1000;
  }

  closeAll({ now, order = [0, 1, 2], stagger = 0 } = {}) {
    order.forEach((fi, k) => this.closeFlower(fi, { now, delay: stagger * k }));
  }

  /* ── v2：连续开合（手靠得越近，开得越多） ─────────────── */

  /** 当前绽放量 0..1 */
  getBloom(i) {
    const f = this.flowers[i];
    return f ? f.value : 0;
  }

  /**
   * 连续驱动一朵的绽放量（目标值 + 帧率无关的指数逼近）。
   * 用指数而不是 from/t0/dur：目标每帧都在变，重启动画会让它永远开不动。
   * up / down 是"到 95% 所需秒数"：张开 0.85s（看得见慢慢开），收回 1.6s（不能塌）。
   */
  setBloom(i, target, { up = 0.85, down = 1.6 } = {}) {
    const f = this.flowers[i];
    if (!f) return;
    f.target = clamp01(target);
    f.tauUp = up;
    f.tauDown = down;
    f.delayUntil = 0;
  }

  /* ── v2：外观变体（01 圆雕 / 02 旋瓣 / 03 垂瓣） ─────────── */

/**
 * 换一种"花的样子"。形状靠 shader 里的扭角 + 尺寸，不重建几何：
 * 0 圆雕（不扭，经典花瓣）/ 1 旋瓣（顺时针扭）/ 2 垂瓣（逆时针扭 + 小一点）
 */
setVariant(k, { now = 0 } = {}) {
  const idx = ((k % 3) + 3) % 3;
  this.variant = idx;
  this.variantTarget = {
    twist: [0, 0.62, -0.5][idx],
    size: [1.0, 1.07, 0.94][idx],
  };
  void now;
  return idx;
}

/** 3D 浏览：让第 i 朵绕自身竖轴转到 angle（弧度），内部平滑 */
setOrbit(i, angle) {
  if (i < 0 || i > 2) return;
  this.orbitTarget[i] = angle;
}

/**
 * v3：抓住一朵转着看——直接给绝对角度（弧度），内部平滑，跟手但不抖。
 * @param {number} i 花的序号
 * @param {{yaw?:number, pitch?:number, roll?:number}} spin
 */
setSpin(i, spin = {}) {
  if (i < 0 || i > 2 || !this.spinTarget[i]) return;
  const s = this.spinTarget[i];
  if (typeof spin.yaw === 'number') s.yaw = spin.yaw;
  if (typeof spin.pitch === 'number') s.pitch = Math.max(-1.35, Math.min(1.35, spin.pitch));
  if (typeof spin.roll === 'number') s.roll = spin.roll;
}

/** 当前这三轴的"目标"值（松手时用它算回正） */
spinOf(i) {
  return this.spinTarget[i] ? { ...this.spinTarget[i] } : { yaw: 0, pitch: 0, roll: 0 };
}

/** 让一朵花慢慢转回正面 */
spinHome(i) {
  this.setSpin(i, { yaw: 0, pitch: 0, roll: 0 });
}

/** 三朵都回正 */
spinHomeAll() {
  for (let i = 0; i < 3; i += 1) this.spinHome(i);
}

/** 捏一下「释放」：花开 + 花粉迸一下（不是爆炸，是松开一口气） */
  release(i, { now, burstR = 0.72 } = {}) {
    const f = this.flowers[i];
    if (!f) return;
    this.openFlower(i, { now, dur: BLOOM.openDur });
    this.burstFx.play(f.center, now, FLORA.baseRadius * f.scale * burstR);
    this._flashCore(i, now + 220);
  }

  _flashCore(i, atMs) {
    const f = this.flowers[i];
    f.heatT0 = atMs;
  }

  /** v2 双端：两端齐开，中间那朵**慢慢**张开（不再爆成花粉——用户要的是"带着开"） */
duetSlow({ now, openDur = BLOOM.openDur, lag = 0.55, slow = 2.0 } = {}) {
    this.openFlower(0, { now });
    this.openFlower(2, { now });
    const mid = this.flowers[1];
    mid.anim = null;
    mid.target = 1;
    mid.tauUp = slow;
    mid.tauDown = BLOOM.closeDur;
    mid.delayUntil = now + lag * 1000;
    this._flashCore(1, now + lag * 1000 + slow * 1000 * 0.5);
  }

  /** 双端：两端齐开 + 中间爆花 0.25s + 重组 0.60s + 绽放 0.90s */
  duet({ now, burst = 0.25, regroup = 0.6, bloom = 0.9 } = {}) {
    this.openFlower(0, { now });
    this.openFlower(2, { now });
    const mid = this.flowers[1];
    mid.anim = { from: mid.value, to: 0, t0: now, dur: burst, ease: 'in' };
    mid.burstT0 = now;
    mid.burstDur = burst;
    this.burstFx.play(mid.center, now, FLORA.baseRadius * mid.scale);
    mid.pendingOpen = { at: now + (burst + regroup) * 1000, dur: bloom * 1000 };
  }

  sweepFilament({ now, dir = 1, dur = 0.9 } = {}) {
    const fil = this.filaments[0];
    const pts = [];
    const yA = 0.588;
    const yB = 0.638;
    const sag = BRANCH.sag / H;
    for (let i = 0; i < 56; i += 1) {
      const t = dir > 0 ? i / 55 : 1 - i / 55;
      const x = lerp(0.08, 0.92, t) * W;
      const y = (lerp(yA, yB, t) + Math.sin(Math.PI * t) * sag) * H - 26;
      const [wx, wy] = toWorld(x, y);
      pts.push([wx, wy, 8]);
    }
    fil.setPath(pts);
    fil.play({ now, dur, alpha: 0.85 });
  }

  duetFilaments({ now, dur = 1.1 } = {}) {
    const mid = this.flowers[1].center;
    const ends = [this.flowers[0].center, this.flowers[2].center];
    this.filaments.forEach((fil, i) => {
      const from = ends[i];
      const pts = [];
      for (let k = 0; k < 56; k += 1) {
        const t = k / 55;
        const x = lerp(from.x, mid.x, t);
        const y = lerp(from.y, mid.y, t) - 18 * Math.sin(Math.PI * t);
        pts.push([x, y, 9]);
      }
      fil.setPath(pts);
      fil.play({ now, dur, alpha: 0.9 });
    });
  }

  /* ── 每帧 ─────────────────────────────────────────────── */

  update(dt, { now, exposure = 0 } = {}) {
    this.time += dt;
    this.breathPhase += dt;
    const breath = 1 + Math.sin((this.breathPhase / 1.2) * TAU) * 0.06; // 1.2s 周期 ±6%
    this.uniforms.uTime.value = this.time;
    this.uniforms.uBreath.value = breath;
    this.opacity += (this.targetOpacity - this.opacity) * Math.min(1, dt * 6);
    this.uniforms.uOpacity.value = this.opacity;
    if (this.twigMat) {
      this.twigMat.uniforms.uOpacity.value = this.opacity;
      this.twigMat.uniforms.uTime.value = this.time;
    }
    this.exposureLevel += (exposure - this.exposureLevel) * Math.min(1, dt * 4);
    this.uniforms.uExposure.value = 1 + this.exposureLevel;

    // 变体扭角 / 尺寸、3D 转角：都走同一条平滑，绝不瞬变
    const kf = Math.min(1, dt * 6);
    this.uniforms.uTwist.value += (this.variantTarget.twist - this.uniforms.uTwist.value) * kf;
    this.uniforms.uSizeMul.value += (this.variantTarget.size - this.uniforms.uSizeMul.value) * kf;
    const orbit3 = this.uniforms.uOrbit3.value;
    for (let i = 0; i < 3; i += 1) {
      this.orbitCur[i] += (this.orbitTarget[i] - this.orbitCur[i]) * Math.min(1, dt * 5);
      orbit3.setComponent(i, this.orbitCur[i]);
    }

    // 三轴自转（抓手转着看）：每轴单独平滑，抓住时跟手、松手后惯性由调用方衰减
    const tilt3 = this.uniforms.uTilt3.value;
    const roll3 = this.uniforms.uRoll3.value;
    const ks = Math.min(1, dt * 12);
    for (let i = 0; i < 3; i += 1) {
      const c = this.spinCur[i];
      const t = this.spinTarget[i];
      c.yaw += (t.yaw - c.yaw) * ks;
      c.pitch += (t.pitch - c.pitch) * ks;
      c.roll += (t.roll - c.roll) * ks;
      orbit3.setComponent(i, c.yaw + this.orbitCur[i]);
      tilt3.setComponent(i, c.pitch);
      roll3.setComponent(i, c.roll);
    }

    const bloom3 = this.uniforms.uBloom3.value;
    const heat3 = this.uniforms.uHeat3.value;
    const burst3 = this.uniforms.uBurst3.value;

    for (let i = 0; i < 3; i += 1) {
      const f = this.flowers[i];
      // 绽放 / 合拢
      if (f.anim) {
        const t = clamp01((now - f.anim.t0) / f.anim.dur);
        const e = f.anim.ease === 'out' ? easeOutCubic(t) : f.anim.ease === 'in' ? easeInCubic(t) : easeInOutCubic(t);
        f.value = lerp(f.anim.from, f.anim.to, e);
        if (t >= 1) f.anim = null;
      }
      // v2：连续逼近目标（帧率无关：每帧按 dt 走定比例，绝不瞬变）
      if (!f.anim && f.target != null && now >= (f.delayUntil || 0)) {
        const tau = Math.max(1e-3, (f.target > f.value ? f.tauUp : f.tauDown) / 3);
        const k = 1 - Math.exp(-dt / tau);
        f.value += (f.target - f.value) * k;
        if (Math.abs(f.target - f.value) < 0.002) f.value = f.target;
      }
      // 重组后绽放（duet 中间那朵）
      if (f.pendingOpen && now >= f.pendingOpen.at - 0.5) {
        f.anim = { from: f.value, to: 1, t0: f.pendingOpen.at, dur: f.pendingOpen.dur, ease: 'out' };
        f.pendingOpen = null;
      }
      // 花心闪光：绽放瞬间 +15%，0.4s 回落
      const flashT = (now - f.heatT0) / (FLORA.coreFlashDur * 1000);
      if (flashT >= 0 && flashT <= 1) {
        f.heat = FLORA.coreFlash * (1 - easeOutCubic(flashT));
      } else if (flashT > 1) {
        f.heat = 0;
      }
      // 爆花幅度：0.25s 内 0 → 1 → 0
      const bt = (now - f.burstT0) / 1000;
      if (bt >= 0 && bt <= f.burstDur) {
        const bt2 = bt / f.burstDur;
        f.burst = Math.sin(Math.PI * bt2) * 1.0;
      } else if (bt > f.burstDur) {
        f.burst = 0;
      }
      bloom3.setComponent(i, f.value);
      heat3.setComponent(i, f.heat);
      burst3.setComponent(i, f.burst);
    }

    for (const fil of this.filaments) fil.update(now, this.pxScale);
    this.burstFx.update(now, this.pxScale);
  }

  /** 调试：三朵的触发圆心（世界坐标） */
  anchorWorld(i) {
    return this.flowers[i].center;
  }
}

export default Flora;