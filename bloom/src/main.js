/**
 * main.js — 舞台、循环、输入源（摄像头 / 指针 / 演示）、HUD、调试。
 *
 * 数据流：camera.js 出 landmark → hands.js 出「手」→ interaction.js 出事件
 * → flower.js / backdrop.js 出画面 → HUD 200ms 去抖更新。
 *
 * 无摄像头时同一套引擎由指针/演示驱动，视觉完全可体验（不是另一套假逻辑）。
 */

import * as THREE from 'three';
import { EffectComposer } from '../vendor/three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/three/addons/postprocessing/OutputPass.js';

import {
  STAGE,
  CAMERA,
  HUD as HUDCFG,
  EXPOSURE,
  PARALLAX,
  BLOOM,
  SWEEP,
  DUET,
  FIST,
  PROXIMITY,
  PINCH,
  SWIPE,
  GRAB,
  FLOWER_ANCHORS,
  DEMO,
  STATE,
} from './config.js';
import { POST, TRAIL, COLOR, VIEW, SEASONS, SEASON_HOLD, ORACLE_LINES, ORACLE_TPL, FLOWER_TINT } from './theme.js';
import { HeartBurst } from './heart.js';
import { QualityGovernor, TIERS } from './perf.js';
import { HandTracker, HAND_CONNECTIONS } from './hands.js';
import { InteractionEngine, detectPinch, SwipeTracker } from './interaction.js';
import { classifyPose, createSignTracker, POSE, SIGN_VOCAB } from './poses.js';
import { Flora } from './flower.js';
import { HandSkeleton } from './handskeleton.js';
import { Backdrop } from './backdrop.js';
import { PlatformHost, PLATFORMS, platformMeta } from './platform.js';
import * as CAM from './camera.js';

/* v4：手势标签（画在掌心旁边的那行小字） */
const POSE_LABEL = Object.freeze({
  open: 'OPEN 张开',
  point: 'POINT 指',
  pinch: 'PINCH 捏',
  fist: 'FIST 握拳',
  ok: 'OK 圆',
  v: 'V 叶',
  other: 'HAND',
});

const params = new URLSearchParams(location.search);
const FLAG_DEBUG = params.has('debug');
const FLAG_DEMO = params.has('demo');
const FLAG_POINTER = params.has('pointer');
const FLAG_FAKE = params.has('fake');
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const el = {
  app: document.getElementById('app'),
  canvas: document.getElementById('stage'),
  debugCanvas: document.getElementById('debug'),
  handCanvas: document.getElementById('hand-skel'),
  video: document.getElementById('cam'),
  hud: document.getElementById('hud'),
  gate: document.getElementById('gate'),
  start: document.getElementById('btn-start'),
  pointer: document.getElementById('btn-pointer'),
  skip: document.getElementById('btn-skip'),
  progress: document.getElementById('gate-progress'),
  progressFill: document.getElementById('progress-fill'),
  progressLabel: document.getElementById('progress-label'),
  progressHint: document.getElementById('progress-hint'),
  gateMsg: document.getElementById('gate-msg'),
  liveLine: document.getElementById('live-line'),
  liveLabel: document.getElementById('live-label'),
  modelLine: document.getElementById('model-line'),
  bloomLabel: document.getElementById('bloom-label'),
  modeNote: document.getElementById('mode-note'),
  statGesture: document.getElementById('stat-gesture'),
  statPet: document.getElementById('stat-pet'),
  hint: document.getElementById('hint'),
  duet: document.getElementById('duet-flash'),
  pointerBar: document.getElementById('pointer-bar'),
  btnDual: document.getElementById('btn-dual'),
  btnCamera: document.getElementById('btn-camera'),
  toast: document.getElementById('toast'),
  dbgPanel: document.getElementById('debug-panel'),
  /* 玩法注释 */
  coach: document.getElementById('coach'),
  coachK: document.getElementById('coach-k'),
  coachT: document.getElementById('coach-t'),
  howto: document.getElementById('howto'),
  howtoBtn: document.getElementById('btn-howto'),
  howtoClose: document.getElementById('btn-howto-close'),
  howtoOk: document.getElementById('btn-howto-ok'),
  gateHowto: document.getElementById('btn-gate-howto'),
  stepList: document.getElementById('step-list'),
  sweepTrack: document.getElementById('sweep-track'),
  sweepLabel: document.getElementById('sweep-label'),
  /* v4.3 手势回执 */
  poseHud: document.getElementById('pose-hud'),
  poseName: document.getElementById('pose-name'),
  poseDots: [...document.querySelectorAll('#pose-dots i')],
  /* v5 交互平台 */
  dock: document.getElementById('dock'),
  dockBtn: document.getElementById('btn-dock'),
  dockLabel: document.getElementById('dock-label'),
  platGuide: document.getElementById('plat-guide'),
  guideTitle: document.getElementById('guide-title'),
  guideList: document.getElementById('guide-list'),
  guideX: document.getElementById('guide-x'),
  guideSigns: document.getElementById('guide-signs'),
  guideSignList: document.getElementById('guide-sign-list'),
  signToast: document.getElementById('sign-toast'),
  dolly: document.getElementById('dolly'),
  dollyRing: document.getElementById('dolly-ring'),
  dollyDot: document.getElementById('dolly-dot'),
  dollyTip: document.getElementById('dolly-tip'),
  dockList: document.getElementById('dock-list'),
  dockTray: document.getElementById('dock-tray'),
  dockStatus: document.getElementById('dock-status'),
  dockStatusText: document.getElementById('dock-status-text'),
  dockStatusBar: document.getElementById('dock-status-bar'),
  btnView: document.getElementById('btn-view'),
  /* v4：季节 / 花语卡 / 比心 */
  veil: document.getElementById('veil'),
  seasonLine: document.getElementById('season-line'),
  seasonLabel: document.getElementById('season-label'),
  seasonBar: document.getElementById('season-bar'),
  oracle: document.getElementById('oracle'),
  oracleSeason: document.getElementById('oracle-season'),
  oracleWord: document.getElementById('oracle-word'),
  oraclePoem: document.getElementById('oracle-poem'),
  oracleFlower: document.getElementById('oracle-flower'),
  oracleDate: document.getElementById('oracle-date'),
  oracleClose: document.getElementById('btn-oracle-close'),
};

const state = {
  cameraLive: false,
  pointerMode: false,
  demo: FLAG_DEMO,
  fake: false,
  fakeFeed: null,
  frameIndex: 0,
  events: [],
  delegate: '—',
  latency: 0,
  luma: 0.2,
  fps: 60,
  qualityTier: 0,
  particles: TIERS[0].particles,
  lastSeenAt: null,
  lastSnapshot: null,
  hidden: false,
  gateVisible: true,
  slowModel: false,
};

/* ── three 舞台 ─────────────────────────────────────────── */
let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas: el.canvas,
    antialias: false,
    alpha: false,
    powerPreference: 'high-performance',
  });
} catch (err) {
  fatal('需要 WebGL2 才能播放：请用新版 Chrome / Edge 打开。');
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, TIERS[0].dpr));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x060509, 1);

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-STAGE.w / 2, STAGE.w / 2, STAGE.h / 2, -STAGE.h / 2, 1, 2200);
camera.position.set(0, 0, 620);

const view = { w: STAGE.w, h: STAGE.h, cover: { w: STAGE.w, h: STAGE.h } };

const backdrop = new Backdrop(scene);
const skeleton = el.handCanvas ? new HandSkeleton(el.handCanvas, { maxHands: 2 }) : null;
const flora = new Flora({ scene });
flora.setPxScale(1);

/* v5：把花的场景整包收进 bloomRoot，切场景时一次 visible 就换干净 */
const bloomRoot = new THREE.Group();
bloomRoot.name = 'platform:bloom';
while (scene.children.length) bloomRoot.add(scene.children[0]);
scene.add(bloomRoot);

const platformHost = new PlatformHost({
  THREE,
  sceneRef: scene,
  stage: STAGE,
  quality: 'high',
  dpr: Math.min(window.devicePixelRatio || 1, 2),
});
// 认出手语就闪一下提示（花的场景自己也会调，这里只管独立场景）
platformHost.onSign = (sign) => {
  state.lastSign = sign;
  showSignToast(sign);
};

const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  REDUCED ? POST.bloomStrength * 0.7 : POST.bloomStrength,
  POST.bloomRadius,
  POST.bloomThreshold,
);
composer.addPass(renderPass);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

/**
 * 两张泛光档：花的场景几乎全黑，阈值 0.09 让花瓣也发茸；
 * 3D 场景有大片中间调（舱壁、雪地、树影），同一个阈值会把整屏糊成一团雾——
 * 所以切到平台场景时把阈值抬到 0.42、强度压到 0.34，只让真正的亮点发光。
 */
function applyBloomProfile(isBloom) {
  bloomPass.threshold = isBloom ? POST.bloomThreshold : 0.42;
  bloomPass.strength = isBloom ? (REDUCED ? POST.bloomStrength * 0.7 : POST.bloomStrength) : 0.34;
  bloomPass.radius = isBloom ? POST.bloomRadius : 0.4;
}

function fatal(message) {
  el.gate.hidden = false;
  el.gate.classList.remove('closing');
  el.gateMsg.hidden = false;
  el.gateMsg.textContent = message;
  el.gate.style.background = '#060509';
}

/* 指尖拖尾微光（0.15s） */
class TipGlow {
  constructor(sceneRef) {
    const n = TRAIL.samples * 2;
    this.n = TRAIL.samples;
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 3);
    this.alpha = new Float32Array(n);
    this.size = new Float32Array(n);
    for (let h = 0; h < 2; h += 1) {
      for (let i = 0; i < TRAIL.samples; i += 1) {
        const k = h * TRAIL.samples + i;
        this.size[k] = 0;
        this.alpha[k] = 0;
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.uniforms = {
      uPxScale: { value: 1 },
      uColor: { value: new THREE.Color(COLOR.honey) },
      uOpacity: { value: 1 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        attribute float aSize;
        uniform float uPxScale;
        varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(aSize * uPxScale, 1.0, 40.0);
          vA = aAlpha;
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
          float a = pow(1.0 - d, 2.1);
          gl_FragColor = vec4(uColor, a * vA * uOpacity);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    sceneRef.add(this.points);
    this.history = [[], []];
  }

  update(hands, now, pxScale) {
    this.uniforms.uPxScale.value = pxScale;
    const cutoff = now - TRAIL.seconds * 1000;
    for (let h = 0; h < 2; h += 1) {
      const hist = this.history[h];
      const hand = hands[h];
      if (hand) {
        hist.push({ t: now, x: hand.tip.x, y: hand.tip.y, z: hand.tip.z || 0 });
        while (hist.length && hist[0].t < cutoff) hist.shift();
      } else {
        hist.length = 0;
      }
      // 取最近 N 个点，按时间衰减
      const take = Math.min(this.n, hist.length);
      for (let i = 0; i < this.n; i += 1) {
        const k = h * this.n + i;
        if (i < take) {
          const sample = hist[hist.length - 1 - i];
          const age = Math.min(1, (now - sample.t) / (TRAIL.seconds * 1000));
          this.pos[k * 3] = sample.x - STAGE.w / 2;
          this.pos[k * 3 + 1] = STAGE.h / 2 - sample.y;
          this.pos[k * 3 + 2] = 12;
          const depth = Math.max(0.7, Math.min(1.3, 1 - sample.z * 2));
          this.size[k] = (TRAIL.size[0] + (TRAIL.size[1] - TRAIL.size[0]) * (1 - i / this.n)) * depth;
          this.alpha[k] = TRAIL.alpha * Math.pow(1 - age, 1.8) * (1 - i / (this.n * 1.2));
        } else {
          this.alpha[k] = 0;
          this.size[k] = 0;
        }
      }
    }
    this.points.geometry.getAttribute('position').needsUpdate = true;
    this.points.geometry.getAttribute('aAlpha').needsUpdate = true;
    this.points.geometry.getAttribute('aSize').needsUpdate = true;
  }
}

const tipGlow = new TipGlow(scene);
// 指尖拖尾属于「花的场景」：挪进 bloomRoot，换场景时一起消失
for (const child of [...scene.children]) {
  if (child !== bloomRoot) bloomRoot.add(child);
}

/* ── 引擎 / 追踪 ───────────────────────────────────────── */
const tracker = new HandTracker();
const engine = new InteractionEngine();

/* ── 输入源 ─────────────────────────────────────────────── */

/* v4：指针对照模式的「虚拟手」也补一套 21 点骨架，
   这样没有摄像头时画面里同样有一只手跟着走（不再只有看不见的判定点）。
   坐标是「掌长 = 1」的规范手型，落地时按 S 缩放、按 8 号点对齐指尖。 */
/* 规范手型（掌长 = 1，指尖朝 -y）：0 腕 / 1-4 拇指 / 5-8 食指 / 9-12 中指 / 13-16 无名 / 17-20 小指 */
const VIRTUAL_PTS = (() => {
  const p = (x, y) => ({ x, y });
  return [
    p(0, 0), // 0 腕
    p(-0.42, -0.22), p(-0.62, -0.42), p(-0.78, -0.55), p(-0.9, -0.62), // 拇指 1-4
    p(-0.32, -0.95), p(-0.36, -1.28), p(-0.38, -1.55), p(-0.4, -1.78), // 食指 5-8
    p(0, -1.0), p(0, -1.36), p(0, -1.62), p(0, -1.86), // 中指 9-12
    p(0.3, -0.95), p(0.33, -1.28), p(0.35, -1.55), p(0.36, -1.78), // 无名 13-16
    p(0.58, -0.86), p(0.63, -1.1), p(0.66, -1.32), p(0.67, -1.52), // 小指 17-20
  ];
})();

/** 握拳时每条手指往自己的 MCP 收回：1-4 收向 2，5-8 收向 5，以此类推 */
const VIRTUAL_BASE = [2, 2, 2, 2, 2, 5, 5, 5, 5, 9, 9, 9, 9, 13, 13, 13, 13, 17, 17, 17, 17];
const virtualBuf = [
  Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 })),
  Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 })),
];

function syntheticLandmarks(tip, fist, slot) {
  const S = 150; // 掌长（px）
  const buf = virtualBuf[slot === 1 ? 1 : 0];
  const wx = tip.x - VIRTUAL_PTS[8].x * S;
  const wy = tip.y - VIRTUAL_PTS[8].y * S;
  const curl = fist ? 0.92 : 0;
  for (let i = 0; i < 21; i += 1) {
    const base = VIRTUAL_PTS[i];
    let lx = base.x;
    let ly = base.y;
    if (curl > 0 && i >= 1) {
      const mcp = VIRTUAL_PTS[VIRTUAL_BASE[i]];
      lx += (mcp.x - lx) * curl;
      ly += (mcp.y - ly) * curl;
    }
    const o = buf[i];
    o.x = wx + lx * S;
    o.y = wy + ly * S;
    o.z = 0;
  }
  return buf;
}

function makeVirtualHand({ slot, tip, fist = false, score = 0.97, palmOffset = 78 }) {
  return {
    slot,
    present: true,
    held: false,
    tip: { x: tip.x, y: tip.y, z: 0 },
    palm: { x: tip.x, y: tip.y + palmOffset, z: 0 },
    fist,
    fistScore: fist ? 1 : 0,
    handedness: '',
    score,
    // v4：虚拟手也带 21 点，骨架叠层能画出来
    landmarks: syntheticLandmarks(tip, fist, slot),
    worldLandmarks: null,
    lastSeenAt: 0,
  };
}

/** 屏幕坐标 → 舞台逻辑像素 */
function screenToStage(clientX, clientY) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const s = h / view.cover.h;
  const cy = view.cover.cy || 0;
  return { x: (clientX - w / 2) / s + STAGE.w / 2, y: (clientY - h / 2) / s + STAGE.h / 2 - cy };
}

function stageToScreen(x, y) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const s = h / view.cover.h;
  const cy = view.cover.cy || 0;
  return { x: w / 2 + (x - STAGE.w / 2) * s, y: h / 2 + (y - STAGE.h / 2 + cy) * s };
}

class PointerSource {
  constructor() {
    this.active = false;
    this.tip = { x: STAGE.w * 0.5, y: STAGE.h * 0.94 };
    this.inside = false;
    this.down = false;
    this.downAt = 0;
    this.fist = false;
    this.dual = false;
    this.dualTip = { x: STAGE.w * 0.84, y: STAGE.h * 0.55 };
    this.draggingDual = false;
    this.tap = null;
    this.lastSeenAt = null;
    this._bind();
  }

  setActive(on) {
    this.active = on;
    this.lastSeenAt = on ? performance.now() : null;
  }

  setDual(on) {
    this.dual = on;
  }

  _bind() {
    const move = (e) => {
      if (!this.active) return;
      const p = screenToStage(e.clientX, e.clientY);
      if (this.draggingDual) this.dualTip = p;
      else this.tip = p;
      this.inside = true;
      this.lastSeenAt = performance.now();
    };
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      if (e.target && e.target.closest && e.target.closest('button')) return;
      const p = screenToStage(e.clientX, e.clientY);
      this.inside = true;
      this.down = true;
      this.downAt = performance.now();
      this.fist = false;
      this.lastSeenAt = performance.now();
      // 抓住第二根虚拟手指
      if (this.dual && Math.hypot(p.x - this.dualTip.x, p.y - this.dualTip.y) < 150) {
        this.draggingDual = true;
      } else {
        this.tip = p;
      }
    });
    window.addEventListener('pointerup', () => {
      if (!this.active) return;
      this.down = false;
      this.draggingDual = false;
      this.fist = false;
      this.lastSeenAt = performance.now();
    });
    window.addEventListener('pointerleave', () => {
      this.inside = false;
    });
    window.addEventListener('pointercancel', () => {
      this.down = false;
      this.fist = false;
      this.draggingDual = false;
    });
  }

  /** 每帧产出手（按住 0.35s → 握拳；轻点 → 通过停留判定累积） */
  tick(now) {
    if (!this.active || !this.inside) return [];
    if (this.down && now - this.downAt > 350) this.fist = true;
    if (!this.down) this.fist = false;
    const hands = [makeVirtualHand({ slot: 0, tip: this.tip, fist: this.fist })];
    if (this.dual) hands.push(makeVirtualHand({ slot: 1, tip: this.dualTip, fist: false }));
    this.lastSeenAt = now;
    return hands;
  }
}

class DemoSource {
  constructor() {
    this.active = false;
    this.stepIdx = 0;
    this.lt = 0;
    this.waiting = true;
    this.fired = false;
    this.lastSeenAt = null;
  }

  reset() {
    this.stepIdx = 0;
    this.lt = 0;
    this.waiting = true;
    this.fired = false;
    this.lastSeenAt = null;
  }

  _script(kind, lt) {
    const W = STAGE.w;
    const H = STAGE.h;
    const lerpP = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    const away = { x: W * 0.5, y: H * 1.02 };
    const f = [
      { x: 0.22 * W, y: 0.56 * H },
      { x: 0.5 * W, y: 0.48 * H },
      { x: 0.78 * W, y: 0.6 * H },
    ];

    if (kind === 'tap') {
      // 接近 → 停 0.5s（住够 0.15s）→ 退开 → 下一朵
      const seq = [
        { from: 1.0, to: 2.2, at: f[0] },
        { from: 2.49, to: 3.69, at: f[1] },
        { from: 4.19, to: 5.39, at: f[2] },
      ];
      let pos = away;
      for (const s of seq) {
        if (lt < s.from) {
          // 往这朵靠近
          const rel = Math.max(0, Math.min(1, (lt - (s.from - 0.7)) / 0.7));
          if (rel > 0) pos = lerpP(away, s.at, ease(rel));
          break;
        }
        if (lt <= s.to) {
          pos = s.at;
          break;
        }
        const rel2 = Math.min(1, (lt - s.to) / 0.45);
        pos = lerpP(s.at, away, ease(rel2));
        if (rel2 < 1) break;
        pos = away;
      }
      return [makeVirtualHand({ slot: 0, tip: pos })];
    }

    if (kind === 'fist') {
      const spot = { x: W * 0.5, y: H * 0.2 };
      if (lt < 0.9) {
        return [makeVirtualHand({ slot: 0, tip: lerpP(away, spot, ease(lt / 0.9)) })];
      }
      if (lt < 2.4) return [makeVirtualHand({ slot: 0, tip: spot, fist: true })];
      if (lt < 3.2) return [makeVirtualHand({ slot: 0, tip: lerpP(spot, away, ease((lt - 2.4) / 0.8)) })];
      return [makeVirtualHand({ slot: 0, tip: away })];
    }

    if (kind === 'sweep') {
      const y = 0.545;
      if (lt < 1.1) {
        return [makeVirtualHand({ slot: 0, tip: { x: W * 0.02, y: H * y } })];
      }
      if (lt < 2.35) {
        const t = ease((lt - 1.1) / 1.25);
        return [makeVirtualHand({ slot: 0, tip: { x: W * (0.02 + t * 0.96), y: H * (y + Math.sin(t * Math.PI) * 0.008) } })];
      }
      return [makeVirtualHand({ slot: 0, tip: { x: W * 0.02, y: H * (y - 0.2) } })];
    }

    // duet
    const left = { x: W * 0.14, y: H * 0.55 };
    const right = { x: W * 0.86, y: H * 0.55 };
    if (lt < 0.9) {
      const t = ease(lt / 0.9);
      return [
        makeVirtualHand({ slot: 0, tip: lerpP({ x: W * 0.02, y: H * 1.02 }, left, t) }),
        makeVirtualHand({ slot: 1, tip: lerpP({ x: W * 0.98, y: H * 1.02 }, right, t) }),
      ];
    }
    if (lt < 6.6) {
      return [
        makeVirtualHand({ slot: 0, tip: left }),
        makeVirtualHand({ slot: 1, tip: right }),
      ];
    }
    const t = ease(Math.min(1, (lt - 6.6) / 0.9));
    return [
      makeVirtualHand({ slot: 0, tip: lerpP(left, { x: W * 0.02, y: H * 1.02 }, t) }),
      makeVirtualHand({ slot: 1, tip: lerpP(right, { x: W * 0.98, y: H * 1.02 }, t) }),
    ];
  }

  tick(dt, snap) {
    if (!this.active) return [];
    const idle = snap.state !== STATE.LOCKED && snap.state !== STATE.RESET && snap.pet === 0;
    if (this.waiting) {
      if (!idle) return [];
      this.waiting = false;
      if (this.fired) {
        this.stepIdx = (this.stepIdx + 1) % DEMO.segments.length;
        this.fired = false;
      }
      this.lt = 0;
    }
    this.lt += dt;
    const seg = DEMO.segments[this.stepIdx];
    const hands = this._script(seg.kind, this.lt);
    if (this.lt > 1.2) {
      if (snap.state === STATE.LOCKED) this.fired = true;
      if (seg.kind === 'tap' && snap.pet >= 3) this.fired = true;
      if (seg.kind === 'fist' && snap.state === STATE.RESET) this.fired = true;
    }
    if (this.lt >= seg.dur || this.fired) this.waiting = true;
    this.lastSeenAt = hands.length ? performance.now() : null;
    return hands;
  }
}

const pointerSource = new PointerSource();
const demoSource = new DemoSource();

/* ── 视差 ───────────────────────────────────────────────── */
const parallax = { x: 0, y: 0, tx: 0, ty: 0 };

/* ── HUD（200ms 去抖） ──────────────────────────────────── */
const hudState = { timer: 0, queued: null, lastAt: 0 };
function queueHud(snap) {
  hudState.queued = snap;
  const now = performance.now();
  const wait = HUDCFG.debounce * 1000 - (now - hudState.lastAt);
  if (wait <= 0) {
    hudState.lastAt = now;
    applyHud(snap);
    hudState.queued = null;
    return;
  }
  if (hudState.timer) return;
  hudState.timer = setTimeout(() => {
    hudState.timer = 0;
    hudState.lastAt = performance.now();
    if (hudState.queued) applyHud(hudState.queued);
    hudState.queued = null;
  }, wait);
}
function applyHud(snap) {
  if (!snap) return;
  const petLabel = `BLOOM 0${snap.pet}`;
  if (el.bloomLabel.textContent !== petLabel) el.bloomLabel.textContent = petLabel;
  const gesture = `${Math.round(snap.quality * 100)}%`;
  if (el.statGesture.textContent !== gesture) el.statGesture.textContent = gesture;
  if (el.statPet.textContent !== String(snap.pet)) el.statPet.textContent = String(snap.pet);
  if (el.hint.textContent !== snap.hint) el.hint.textContent = snap.hint;
  el.duet.classList.toggle('show', !!snap.duetFlash);
}
function setLive(label, pointer) {
  el.liveLabel.textContent = label;
  el.liveLine.classList.toggle('is-pointer', !!pointer);
}

let toastTimer = 0;
function toast(text, ms = 3600) {
  el.toast.textContent = text;
  el.toast.hidden = false;
  requestAnimationFrame(() => el.toast.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.toast.classList.remove('show');
    setTimeout(() => {
      el.toast.hidden = true;
    }, 400);
  }, ms);
}

/* ── 尺寸 ───────────────────────────────────────────────── */
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, TIERS[0].dpr);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  composer.setPixelRatio(dpr);
  composer.setSize(w, h);
  bloomPass.setSize(w, h);

  const stageAspect = STAGE.w / STAGE.h;
  const aspect = w / h;
  // v2：画面是一横条花带，宽屏上不能再"整幅缩小居中"（那样花只占窗口十几分之一）。
  // 竖屏/接近 9:16 → 按宽度铺满；宽屏 → 收紧纵向取景（最多收到 VIEW.minH），把花放大。
  const minH = STAGE.h * VIEW.minH;
  let vw;
  let vh;
  if (aspect <= stageAspect) {
    vw = STAGE.w;
    vh = STAGE.w / aspect;
  } else {
    vh = Math.max(minH, STAGE.w / aspect);
    vw = vh * aspect;
  }
  // 纵向取景中心放到花带中心（不是画布正中），宽屏收窄时才不会把花切掉
  const cy = (0.5 - VIEW.centerY) * STAGE.h; // 世界坐标（y 向上）
  camera.left = -vw / 2;
  camera.right = vw / 2;
  camera.top = cy + vh / 2;
  camera.bottom = cy - vh / 2;
  camera.updateProjectionMatrix();
  view.cover = { w: vw, h: vh, cy };
  backdrop.setViewport(vw, vh);
  if (skeleton) skeleton.resize(w, h, dpr);
  const pxScale = (h * dpr) / vh;
  flora.setPxScale(pxScale);
  tipGlow.uniforms.uPxScale.value = pxScale;

  const dbg = el.debugCanvas;
  dbg.width = Math.round(w * dpr);
  dbg.height = Math.round(h * dpr);
  dbg.style.width = `${w}px`;
  dbg.style.height = `${h}px`;
}
window.addEventListener('resize', resize);

/* ── 摄像头启动 ─────────────────────────────────────────── */
let landmarker = null;
let frameLoop = null;
let brightness = null;
let videoTexture = null;
let currentStream = null;
let camStarting = false;

function setProgress(p, label, hint = '') {
  el.progress.hidden = false;
  el.progressFill.style.width = `${Math.round(p * 100)}%`;
  el.progressLabel.textContent = label;
  el.progressHint.textContent = hint;
}

function showGateMessage(text) {
  el.gateMsg.hidden = false;
  el.gateMsg.textContent = text;
}

function closeGate() {
  state.gateVisible = false;
  el.gate.classList.add('closing');
  el.hud.hidden = false;
  tutorial.syncSteps();
  tutorial.coach(COACH.start[0], COACH.start[1], 7000);
  // v5：场景坞默认收着，得告诉人它在哪 —— 只说一次，别打扰回访的人
  try {
    if (!localStorage.getItem('bloom.dock.hinted')) {
      localStorage.setItem('bloom.dock.hinted', '1');
      setTimeout(() => {
        if (plat.id === 'bloom' && el.dockList && el.dockList.hidden) {
          toast('场景坞：点「场景」换个世界（宇宙 / 圣诞树 / 空间站）', 4600);
        }
      }, 3200);
    }
  } catch (err) {
    /* localStorage 被禁用就算了，不弹 */
  }
  setTimeout(() => {
    el.gate.hidden = true;
  }, 750);
}

async function startCameraFlow() {
  if (camStarting) return;
  camStarting = true;
  el.start.disabled = true;
  el.pointer.disabled = true;
  el.gateMsg.hidden = true;
  setProgress(0.01, '正在打开摄像头…');
  state.slowModel = false;
  const slowTimer = setTimeout(() => {
    state.slowModel = true;
    el.skip.hidden = false;
    el.progressHint.textContent = '网络慢的话可以先看无摄像头版';
  }, CAMERA.slowModelMs);

  try {
    const { stream } = await CAM.openCamera(el.video);
    currentStream = stream;
    watchStream(stream);

    videoTexture = new THREE.VideoTexture(el.video);
    videoTexture.minFilter = THREE.LinearFilter;
    videoTexture.magFilter = THREE.LinearFilter;
    videoTexture.generateMipmaps = false;
    backdrop.setVideoTexture(videoTexture);
    const setAspect = () => {
      if (el.video.videoWidth) backdrop.setVideoAspect(el.video.videoWidth / el.video.videoHeight);
    };
    setAspect();
    el.video.addEventListener('loadedmetadata', setAspect);

    setProgress(0.03, '加载手势模型 0%', 'wasm / 模型都在本地，可离线');
    await CAM.preloadAssets({
      onProgress: (p) => setProgress(0.03 + p * 0.52, `加载手势模型 ${Math.round(p * 52)}%`, 'wasm / 模型都在本地，可离线'),
    });
    landmarker = await CAM.createLandmarker({
      onProgress: (p) => setProgress(0.56 + p * 0.44, `初始化识别器 ${Math.round(56 + p * 44)}%`),
      onDelegate: (d) => {
        state.delegate = d;
      },
    });

    frameLoop = CAM.createFrameLoop({
      video: el.video,
      landmarker,
      onResult: (result, stats) => {
        if (!result) return;
        tracker.ingest(result, performance.now());
        state.latency = stats.latencyMs;
      },
      onError: (err) => console.warn('[bloom] detect error', err && err.message),
    });
    frameLoop.start();
    brightness = CAM.createBrightnessProbe(el.video);

    state.cameraLive = true;
    state.pointerMode = false;
    setLive('CAMERA LIVE', false);
    el.pointerBar.hidden = true;
    el.modeNote.textContent = '手距镜头 40–80cm · 手掌完整入镜';
    closeGate();
    clearTimeout(slowTimer);
    el.skip.hidden = true;
    flora.setOpacity(1);
    state.lastSeenAt = null;
  } catch (err) {
    clearTimeout(slowTimer);
    console.warn('[bloom] camera flow failed:', err && err.message);
    const reason =
      err && err.code === 'insecure'
        ? '现在是 http 地址，浏览器不给用摄像头 —— 换成 https 打开才有手势；先按指针模式玩，效果一样。'
        : err && err.code === 'denied'
          ? '摄像头权限被拒绝 —— 已切到指针模式，全部效果照样能玩。'
          : err && err.code === 'unsupported'
            ? '这个浏览器不支持摄像头 —— 已切到指针模式。'
            : '摄像头或模型没起来 —— 已切到指针模式，点「无摄像头体验」随时重试。';
    showGateMessage(reason);
    enterPointerMode(reason);
  } finally {
    camStarting = false;
    el.start.disabled = false;
    el.pointer.disabled = false;
  }
}

function watchStream(stream) {
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  track.addEventListener('ended', () => {
    if (!state.cameraLive || state.hidden) return;
    handleDisconnect();
  });
}

let retried = false;
async function handleDisconnect() {
  if (!retried) {
    retried = true;
    toast('摄像头断开了，正在重连…');
    try {
      if (frameLoop) frameLoop.stop();
      if (currentStream) currentStream.getTracks().forEach((t) => t.stop());
      const { stream } = await CAM.openCamera(el.video);
      currentStream = stream;
      watchStream(stream);
      if (videoTexture) videoTexture.needsUpdate = true;
      if (!frameLoop) {
        frameLoop = CAM.createFrameLoop({ video: el.video, landmarker, onResult: (r, s) => {
          if (!r) return;
          tracker.ingest(r, performance.now());
          state.latency = s.latencyMs;
        } });
      }
      frameLoop.start();
      toast('已重新连上');
      return;
    } catch {
      /* fallthrough */
    }
  }
  state.cameraLive = false;
  enterPointerMode('摄像头断开了 —— 已切到指针模式。');
}

/* ── 降级：指针模式 ─────────────────────────────────────── */
function enterPointerMode(reason) {
  state.cameraLive = false;
  state.pointerMode = true;
  pointerSource.setActive(true);
  el.pointerBar.hidden = false;
  el.hud.hidden = false;
  setLive('POINTER MODE', true);
  el.modeNote.textContent = '指针 = 指尖 · 拖拽可横抚';
  if (state.gateVisible) closeGate();
  if (reason) toast(reason, 5200);
  flora.setOpacity(1);
}

/* ── 事件 → 画面 ────────────────────────────────────────── */
function applyEvents(events, now) {
  for (const ev of events) {
    // 抓住一朵在转着看的时候，别让"摸/横抚/双端"同时抢画面
    if (grab.on && (ev.type === 'open' || ev.type === 'sweep' || ev.type === 'duet')) continue;
    switch (ev.type) {
      case 'open':
        flora.openFlower(ev.flower, { now });
        prox.hold(ev.flower, now);
        tutorial.mark('tap');
        break;
      case 'sweep': {
        const stagger = ev.stagger || SWEEP.stagger;
        ev.order.forEach((fi, k) => {
          flora.openFlower(fi, { now, delay: stagger * k });
          prox.hold(fi, now);
        });
        flora.sweepFilament({ now, dir: ev.dir, dur: 0.9 });
        tutorial.mark('sweep');
        break;
      }
      case 'duet':
        // v2：中间那朵不再爆成花粉，改成"被两只手带着慢慢开"
        flora.duetSlow({ now, lag: 0.55, slow: 2.0 });
        flora.duetFilaments({ now, dur: 1.15 });
        for (let i = 0; i < 3; i += 1) prox.hold(i, now, 0.55 + 2.0 + 1.5);
        tutorial.mark('duet');
        break;
      case 'fist':
        if (grab.on) endGrab('握拳 · 放下花');
        tutorial.mark('fist');
        break;
      case 'close':
        flora.closeAll({ now, order: ev.order, stagger: (ev.stagger || 0) / 1000 });
        for (let i = 0; i < 3; i += 1) prox.hold(i, now, BLOOM.closeDur);
        if (ev.by === 'fist' || ev.reason === 'fist') tutorial.mark('fist');
        break;
      case 'state':
        break;
      default:
        break;
    }
  }
}

/* ══════════════════════════════════════════════════════════
   玩法注释：画面里的八步 + 顶部教练条 + 随时可叫的卡片
   ══════════════════════════════════════════════════════════ */

const STEPS = ['near', 'tap', 'sweep', 'duet', 'pinch', 'grab', 'swipe', 'fist', 'oracle', 'season', 'heart', 'motif'];

/** 每个动作做完之后，提示下一个 */
const COACH = {
  start: ['起步', '把手放进画面，靠近花苞——它会自己慢慢开'],
  near: ['02 / 12', '张开手停在花上 0.1 秒就抓住了：左右上下移动，360° 转着看它'],
  tap: ['03 / 12', '手掌从左到右抚过整枝（不碰花、横着挥一下也算），三朵依次开'],
  sweep: ['04 / 12', '两只手各压住一端，中间那朵会自己慢慢开'],
  duet: ['05 / 12', '拇指和食指捏一下（在花上），释放它'],
  pinch: ['06 / 12', '花开着的时候再捏一下，会浮出今日花语'],
  grab: ['07 / 12', '手离开花带，张开手掌左右一划——换一种花'],
  swipe: ['08 / 12', '手不在花上时握拳，整枝合拢'],
  fist: ['09 / 12', '抓住一朵别动，右上角环满 2 秒——换季'],
  oracle: ['10 / 12', '两只手同时捏一下，比个心试试'],
  season: ['11 / 12', '比个 OK 出圆环、比个耶出一片叶子（上面这几种都会了）'],
  heart: ['12 / 12', '比个 OK 出圆环、比个耶出一片叶子'],
  motif: ['全部学会', '十二个动作都会了 · 点右下角 ? 随时回看'],
};

const tutorial = {
  done: new Set(),
  coachTimer: 0,
  nextKey: 'start',

  mark(step) {
    if (!STEPS.includes(step) || this.done.has(step)) return;
    this.done.add(step);
    const idx = STEPS.indexOf(step);
    const next = STEPS[idx + 1] || null;
    this.nextKey = next || 'fist';
    // 先定好「下一步是哪个」再刷高亮，否则 .now 永远差一步
    this.syncSteps();
    const line = next ? COACH[next] : COACH.fist;
    this.coach(line[0], line[1], 6000, step);
  },

  syncSteps() {
    if (!el.stepList) return;
    const lis = el.stepList.querySelectorAll('li');
    lis.forEach((li) => {
      const k = li.dataset.k;
      li.classList.toggle('done', this.done.has(k));
      li.classList.toggle('now', k === this.nextKey && !this.done.has(k));
    });
  },

  coach(kicker, text, ms = 4200) {
    if (!el.coach) return;
    el.coachK.textContent = kicker;
    el.coachT.textContent = text;
    el.coach.hidden = false;
    el.coach.classList.add('on');
    clearTimeout(this.coachTimer);
    if (ms > 0) {
      this.coachTimer = setTimeout(() => el.coach.classList.remove('on'), ms);
    } else {
      el.coach.classList.add('on');
    }
  },

  hideCoach() {
    clearTimeout(this.coachTimer);
    if (el.coach) el.coach.classList.remove('on');
  },

  show() {
    if (!el.howto) return;
    el.howto.hidden = false;
    // 强制一次样式计算再上 .on，避免「同帧加 class 导致过渡不触发」
    void el.howto.offsetWidth;
    el.howto.classList.add('on');
    // 说明卡打开时把场景坞收起来：两层都贴在右下角，同时出现会互相压住
    if (el.dock) el.dock.hidden = true;
    this.hideCoach();
    try {
      localStorage.setItem('bloom.howto.seen', '1');
    } catch (_) {
      /* 隐私模式下忽略 */
    }
  },

  hide() {
    if (!el.howto) return;
    el.howto.classList.remove('on');
    if (el.dock) el.dock.hidden = false;
    setTimeout(() => {
      if (!el.howto.classList.contains('on')) el.howto.hidden = true;
    }, 320);
  },

  isOpen() {
    return !!el.howto && !el.howto.hidden;
  },
};

if (el.howtoBtn) el.howtoBtn.addEventListener('click', () => tutorial.show());
if (el.gateHowto) el.gateHowto.addEventListener('click', () => tutorial.show());
if (el.howtoClose) el.howtoClose.addEventListener('click', () => tutorial.hide());
if (el.howtoOk) el.howtoOk.addEventListener('click', () => tutorial.hide());
if (el.howto) {
  el.howto.addEventListener('click', (e) => {
    if (e.target === el.howto) tutorial.hide();
  });
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && tutorial.isOpen()) tutorial.hide();
  if (e.key === 'Escape' && state.oracleOpen) closeOracle();
  if ((e.key === '?' || e.key === '/' || e.key === 'h') && !e.metaKey && !e.ctrlKey) {
    tutorial.isOpen() ? tutorial.hide() : tutorial.show();
  }
});

/* v4：花语卡可以点关闭 / 点背景收起 */
if (el.oracleClose) el.oracleClose.addEventListener('click', () => closeOracle());
if (el.oracle) {
  el.oracle.addEventListener('click', (e) => {
    if (e.target === el.oracle) closeOracle();
  });
}

/* ── 主循环 ─────────────────────────────────────────────── */
let rafId = null;
let lastNow = performance.now();
let fpsWindow = { frames: 0, elapsed: 0, value: 60 };


let lastDebugAt = 0;

function currentHands(now, dt, snap) {
  if (state.fake && state.fakeFeed) {
    // 测试通道：假 landmark 走与摄像头完全相同的追踪/平滑链路
    tracker.ingest({ landmarks: state.fakeFeed }, now);
    return tracker.activeHands();
  }
  if (state.demo) return demoSource.tick(dt, snap || { state: STATE.STANDBY, pet: 0 });
  if (state.cameraLive) return tracker.activeHands();
  if (state.pointerMode) return pointerSource.tick(now);
  return [];
}

/* ══════════════════════════════════════════════════════════
   v5：交互平台（场景坞 / 视角切换 / 场景自己的按钮）
   ══════════════════════════════════════════════════════════ */

const plat = {
  id: 'bloom',
  view: 'third',
  busy: false,
  actionsSig: '',
  frame: {
    t: 0,
    now: 0,
    hands: [],
    pointer: { on: false, x: 0, y: 0 },
    firstPerson: false,
  },
  proxies: [], // 复用的手代理对象（每帧只改字段，不 new）
  still: new Map(), // slot → { x, y, sec }
  fistHold: 0,
};

/** 舞台坐标的手 → 场景需要的精简格式（复用对象） */
function platformHands(hands, dt) {
  const out = plat.proxies;
  out.length = 0;
  for (const h of hands) {
    const slot = h.slot;
    let p = out.find((q) => q.slot === slot);
    if (!p) {
      p = { slot, tip: { x: 0, y: 0 }, palm: { x: 0, y: 0 }, pinch: { on: false }, pose: null, still: 0 };
      out.push(p);
    }
    p.tip.x = h.tip.x;
    p.tip.y = h.tip.y;
    p.palm.x = h.palm ? h.palm.x : h.tip.x;
    p.palm.y = h.palm ? h.palm.y : h.tip.y;
    p.pinch.on = !!(h.pose && h.pose.pinch);
    p.pose = h.pose || null;
    // 静止时长：给场景做「悬停」判定（抖动 12px 内算没动）
    const prev = plat.still.get(slot);
    if (prev) {
      const d = Math.hypot(h.tip.x - prev.x, h.tip.y - prev.y);
      prev.x = h.tip.x;
      prev.y = h.tip.y;
      prev.sec = d < 14 ? prev.sec + dt : 0;
      p.still = prev.sec;
    } else {
      plat.still.set(slot, { x: h.tip.x, y: h.tip.y, sec: 0 });
      p.still = 0;
    }
  }
  for (const slot of [...plat.still.keys()]) {
    if (!hands.some((h) => h.slot === slot)) plat.still.delete(slot);
  }
  return out;
}

/** 双手同时握拳 0.6 秒 = 叫出场景坞（手势里只留这一个「万能键」） */
function platformFistMenu(hands, dt) {
  const fists = hands.filter((h) => h.pose && h.pose.pose === 'fist').length;
  if (fists >= 2) {
    plat.fistHold += dt;
    if (plat.fistHold > 0.6) {
      plat.fistHold = -1.2; // 触发后进入冷却，握拳不放也不会连开
      el.dockList.hidden = !el.dockList.hidden;
      toast(el.dockList.hidden ? '场景坞收起' : '换个场景 · 点一张卡', 1800);
    }
  } else if (plat.fistHold > 0) {
    plat.fistHold = Math.max(0, plat.fistHold - dt * 2);
  } else if (plat.fistHold < 0) {
    plat.fistHold = Math.min(0, plat.fistHold + dt);
  }
}

function syncDockCards() {
  if (!el.dockList) return;
  for (const card of el.dockList.querySelectorAll('.dock-card')) {
    card.classList.toggle('is-on', card.dataset.p === plat.id);
    card.setAttribute('aria-current', card.dataset.p === plat.id ? 'true' : 'false');
  }
  const meta = platformMeta(plat.id);
  if (el.dockLabel && meta) el.dockLabel.textContent = meta.label;
}

/** 场景坞里的按钮：视角 + 场景自己的 actions() */
function syncDockTray() {
  if (!el.dockTray) return;
  const acts = plat.id === 'bloom' ? [] : platformHost.actions();
  const showView = plat.id !== 'bloom' && !!platformHost.host;
  const sig = `${plat.id}|${showView}|${acts.map((a) => a.label).join(',')}`;
  if (sig !== plat.actionsSig) {
    plat.actionsSig = sig;
    // 先清掉旧的 action 按钮，保留 btnView
    for (const b of [...el.dockTray.querySelectorAll('.dock-act')]) b.remove();
    for (const a of acts) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dock-btn dock-act';
      btn.dataset.a = a.id;
      btn.textContent = a.label;
      if (a.hint) btn.title = a.hint;
      btn.addEventListener('click', () => {
        platformHost.action(a.id);
        syncDockTray();
      });
      el.dockTray.appendChild(btn);
    }
  }
  if (el.btnView) {
    el.btnView.hidden = !showView;
    el.btnView.textContent = plat.view === 'first' ? '第一视角' : '第三视角';
  }
  el.dockTray.hidden = !showView && acts.length === 0;
}

async function setPlatform(id, opts = {}) {
  if (!platformMeta(id) || plat.busy) return plat.id;
  if (id === plat.id && !opts.force) return plat.id;
  plat.busy = true;
  const real = await platformHost.activate(id, { firstPerson: opts.firstPerson });
  plat.busy = false;
  if (real !== id) {
    toast('这个场景还没装好，先留在原地', 2200);
    return plat.id;
  }
  plat.id = real;
  plat.view = 'third';
  // 花的引擎有自己的 LOCKED / 冷却状态：进了别的场景要清干净，
  // 否则它会拦掉横挥、双端这类事件（场景里的手势就再也不响应了）
  if (real !== 'bloom') {
    engine.hardReset();
    flora.closeAll({ now: performance.now(), order: [2, 1, 0], stagger: 0.06 });
    prox.heat[0] = prox.heat[1] = prox.heat[2] = 0;
  }
  bloomRoot.visible = real === 'bloom';
  state.platform = real;
  // 花的场景有自己的一套 HUD 提示，换场景时收起来免得打架
  const isBloom = real === 'bloom';
  el.stepList.hidden = !isBloom;
  el.sweepTrack.hidden = !isBloom;
  el.seasonLine.hidden = !isBloom;
  el.hint.hidden = !isBloom;
  renderPass.camera = isBloom ? camera : platformHost.camera() || camera;
  applyBloomProfile(isBloom);
  syncDockCards();
  syncDockTray();
  syncDolly();
  const meta = platformMeta(real);
  if (meta && !opts.silent) toast(`${meta.label} · ${meta.hint}`, 2600);
  // v6：进任何场景，先把「怎么玩」摊在屏幕上（8 秒或点一下收起）
  showGuide(real);
  if (skeleton) el.handCanvas.classList.add('is-on');
  return real;
}

/* v6：场景玩法卡 —— 「进场景第一眼就知道能干什么」 */
let guideTimer = 0;
function showGuide(id, { sticky = false } = {}) {
  if (!el.platGuide || !el.guideList) return;
  const items = platformHost.howto();
  const meta = platformMeta(id);
  if (!items.length || !meta) {
    el.platGuide.hidden = true;
    return;
  }
  el.guideTitle.textContent = meta.label;
  el.guideList.innerHTML = '';
  for (const line of items) {
    const li = document.createElement('li');
    li.textContent = line;
    el.guideList.appendChild(li);
  }
  // 手语栏：这个词在当前场景干什么，一句一行
  const signs = platformHost.signs ? platformHost.signs() : [];
  if (el.guideSigns && el.guideSignList) {
    el.guideSignList.innerHTML = '';
    for (const row of signs) {
      const word = SIGN_VOCAB[row.sign];
      if (!word) continue;
      const li = document.createElement('li');
      const icon = document.createElement('span');
      icon.className = 'sign-icon';
      icon.textContent = word.icon;
      const label = document.createElement('b');
      label.textContent = word.name;
      const eff = document.createElement('span');
      eff.className = 'sign-eff';
      eff.textContent = row.effect;
      li.append(icon, label, eff);
      el.guideSignList.appendChild(li);
    }
    el.guideSigns.hidden = signs.length === 0;
  }
  el.platGuide.hidden = false;
  el.platGuide.classList.add('is-on');
  clearTimeout(guideTimer);
  // 花的场景 12 秒（新人第一屏要读得完），其它场景 8 秒
  if (!sticky) guideTimer = setTimeout(hideGuide, id === 'bloom' ? 12000 : 8000);
}

function hideGuide() {
  clearTimeout(guideTimer);
  if (!el.platGuide) return;
  el.platGuide.classList.remove('is-on');
  el.platGuide.hidden = true;
}

/* v6：推拉圆盘 —— 手指按住往上抹 = 前进，往下抹 = 后退，松开回中间。
   桌面用鼠标拖动同一套逻辑；手势另有「手停在圆盘附近」的分支（platformTick 里）。 */
function bindDolly() {
  if (!el.dollyRing) return;
  let active = false;
  let startY = 0;
  const setDot = (v) => {
    if (el.dollyDot) el.dollyDot.style.transform = `translateY(${(-v * 30).toFixed(1)}px)`;
    platformHost.input.dolly = v;
    if (el.dollyTip) {
      el.dollyTip.textContent = v > 0.15 ? '前进中…' : v < -0.15 ? '后退中…' : '按住往上抹 前进';
    }
  };
  const onMove = (e) => {
    if (!active) return;
    const dy = (e.clientY - startY) / 60; // 往上 60px = 满速前进
    setDot(Math.max(-1, Math.min(1, -dy)));
    e.preventDefault();
  };
  const onUp = () => {
    if (!active) return;
    active = false;
    setDot(0);
  };
  el.dollyRing.addEventListener('pointerdown', (e) => {
    active = true;
    startY = e.clientY;
    el.dollyRing.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  el.dollyRing.addEventListener('pointermove', onMove);
  el.dollyRing.addEventListener('pointerup', onUp);
  el.dollyRing.addEventListener('pointercancel', onUp);
  window.addEventListener('pointerup', onUp);
}

function syncDolly() {
  if (!el.dolly) return;
  // 花有自己的玩法，不需要走位；其他场景都给它一个圆盘
  const need = plat.id !== 'bloom';
  el.dolly.hidden = !need;
  if (!need) platformHost.input.dolly = 0;
}

function platformTick(dt, now, hands, events) {
  platformFistMenu(hands, dt);
  const frame = plat.frame;
  frame.t = now / 1000;
  frame.now = now;
  frame.hands = platformHands(hands, dt);
  frame.pointer.on = state.pointerMode;
  frame.pointer.x = pointerSource.tip.x;
  frame.pointer.y = pointerSource.tip.y;
  frame.firstPerson = plat.view === 'first';
  if (events && events.length) {
    for (const ev of events) platformHost.gesture(ev);
  }
  platformHost.update(dt, frame);

  const cam = platformHost.camera();
  renderPass.camera = cam || camera;
  renderer.toneMappingExposure = 1; // 花的场景会按开花数抬曝光，换场景要归 1
  composer.render();
  samplePixels();

  syncDockTray();
  const hud = platformHost.hud();
  if (el.dockStatus) {
    el.dockStatus.hidden = !hud;
    if (hud) {
      el.dockStatusText.textContent = hud.status || '';
      el.dockStatusBar.style.width = `${Math.round((hud.value || 0) * 100)}%`;
    }
  }
}

function platformSwitchAction(id) {
  const r = platformHost.action(id);
  syncDockTray();
  return r;
}

function bindDock() {
  if (!el.dockList) return;
  // v6：所有尺寸都摊开四张卡 —— 手机上原来要再点一下「场景」才看得到，等于没有入口
  el.dockList.hidden = false;
  if (el.dockBtn) el.dockBtn.setAttribute('aria-expanded', 'true');
  for (const card of el.dockList.querySelectorAll('.dock-card')) {
    card.addEventListener('click', () => {
      // 点的是当前场景 = 「我忘了怎么玩」：把玩法卡再摊一次，
      // 否则卡 8 秒收起来之后，人就再也找不到它了（这是 v6 最大的隐形坑）。
      if (card.dataset.p === plat.id) {
        showGuide(plat.id, { sticky: true });
        return;
      }
      setPlatform(card.dataset.p);
    });
  }
  if (el.dockBtn) {
    el.dockBtn.addEventListener('click', () => {
      el.dockList.hidden = !el.dockList.hidden;
      el.dockBtn.setAttribute('aria-expanded', el.dockList.hidden ? 'false' : 'true');
    });
  }
  if (el.btnView) {
    el.btnView.addEventListener('click', () => {
      const v = platformHost.toggleView();
      if (v) {
        plat.view = v;
        syncDockTray();
        toast(v === 'first' ? '第一视角 · 手就是操作杆' : '第三视角 · 在外面看它', 2000);
      }
    });
  }
  window.addEventListener('keydown', (e) => {
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    const idx = '1234'.indexOf(e.key);
    if (idx >= 0 && PLATFORMS[idx]) {
      setPlatform(PLATFORMS[idx].id);
      return;
    }
    if (e.key === 'v' || e.key === 'V') {
      const v = platformHost.toggleView();
      if (v) {
        plat.view = v;
        syncDockTray();
      }
    }
  });
}

/** 自检：等下一帧渲染完，把画布读回来算平均亮度 / 亮点占比（CDP 截图算不出来时用它） */
let pixelReq = null;

/* ══════════════════════════════════════════════════════════
   v4.3：手势回执 —— 「现在到底识别成什么」
   ══════════════════════════════════════════════════════════ */

/** 每只手的姿态稳定器：新的原始读数要连续 3 帧一致才认，避免抖动 */
const poseStable = new Map(); // slot → { raw, n, pose }
const POSE_HOLD_FRAMES = 3;

function stabilizePose(hand) {
  const slot = hand.slot || 0;
  const raw = hand.pose ? hand.pose.pose : null;
  let st = poseStable.get(slot);
  if (!st) {
    st = { raw: null, n: 0, pose: raw };
    poseStable.set(slot, st);
  }
  if (raw === st.raw) {
    st.n += 1;
  } else {
    st.raw = raw;
    st.n = 1;
  }
  // 握拳/捏合这种「瞬时动作」放行得快一点（2 帧），其余 3 帧
  const need = raw === 'fist' || raw === 'pinch' ? 2 : POSE_HOLD_FRAMES;
  if (st.n >= need && st.pose !== raw) st.pose = raw;
  hand.poseStable = st.pose;
  return st.pose;
}

/** 把「当前手势 + 哪几根手指立着」写进 HUD（DOM 只在需要时改） */
const hudPose = { name: '', fingers: '', t: 0 };
/* ── v7 手语：花的场景没有独立 api，所以它自己留一个追踪器 ──────────
   动作直接走底下的函数（openAll / fireHeart 那些是 window.__bloom 上的方法，
   在这里既不存在也会撞 TDZ，所以单拎出来三小只）。 */
function bloomOpenAll(now = performance.now()) {
  // 连续接近层会立刻把它们压回去，所以先占住时间窗（和 __bloom.openAll 同一套）
  for (let i = 0; i < 3; i += 1) {
    prox.hold(i, now, 30);
    flora.openFlower(i, { now });
  }
}

function bloomCloseAll(now = performance.now()) {
  for (let i = 0; i < 3; i += 1) prox.hold(i, now, 30);
  flora.closeAll({ now, order: [0, 1, 2], stagger: 0 });
}

function bloomMotif(shape) {
  const def = Object.values(POSEMOTIF).find((d) => d.shape === shape) || POSEMOTIF.ok;
  heartFx.play({ x: STAGE.w * 0.5, y: STAGE.h * 0.45, color: def.color, scale: 0.95, shape });
  state.motifCount = (state.motifCount || 0) + 1;
  state.lastMotif = shape;
  toast(def.toast, 2200);
}

const signTracker = createSignTracker((sign) => {
  if (plat.id !== 'bloom') return; // 切到别的场景时，手语由那个场景自己接
  {
    if (sign === 'thumbUp') bloomOpenAll();
    else if (sign === 'ily') tryHeart(performance.now());
    else if (sign === 'v') bloomMotif('leaf');
    else if (sign === 'ok') bloomCloseAll();
  }
  state.lastSign = sign;
  state.lastSignAt = performance.now();
  showSignToast(sign);
});

/** 屏幕下方一闪而过的「识别到：🤟 爱你」提示 */
function showSignToast(sign) {
  const word = SIGN_VOCAB[sign];
  if (!word || !el.signToast) return;
  // 只提示「这个场景真的会响应的词」：张开手掌是人的休息姿势，
  // 要是也弹一条「🖐 停」，人会以为随便摊手就在操作什么。
  const list = (platformMeta(plat.id)?.signs || []).map((r) => r.sign);
  if (!list.includes(sign)) return;
  el.signToast.textContent = word.icon + ' ' + word.name;
  el.signToast.hidden = false;
  el.signToast.classList.remove('is-in');
  void el.signToast.offsetWidth; // 强制重排，让同一个词连着比也能重播动画
  el.signToast.classList.add('is-in');
  clearTimeout(showSignToast.t);
  showSignToast.t = setTimeout(() => {
    el.signToast.classList.remove('is-in');
    setTimeout(() => {
      if (!el.signToast.classList.contains('is-in')) el.signToast.hidden = true;
    }, 260);
  }, 1400);
}

function updatePoseHud(hands, now) {
  const box = el.poseHud;
  if (!box) return;
  const h = hands[0];
  const live = !!h && !!(state.cameraLive || state.fake || state.demo || state.pointerMode);
  if (!live) {
    if (hudPose.name !== '') {
      hudPose.name = '';
      box.classList.remove('is-on');
      el.poseName.textContent = '没有手 · 举起一只手试试';
      for (const d of el.poseDots) d.classList.remove('is-up');
    }
    return;
  }
  const pose = h.poseStable || (h.pose && h.pose.pose) || null;
  const name = POSE_LABEL[pose] || '识别中';
  const ext = (h.pose && h.pose.ext) || null;
  const bits = ext ? ext.map((v, i) => (v ? '1' : '0')).join('') : '';
  if (name === hudPose.name && bits === hudPose.fingers && now - hudPose.t < 240) return;
  hudPose.name = name;
  hudPose.fingers = bits;
  hudPose.t = now;
  box.classList.add('is-on');
  el.poseName.textContent = name;
  for (let i = 0; i < el.poseDots.length; i += 1) {
    el.poseDots[i].classList.toggle('is-up', !!(ext && ext[i]));
  }
}
function samplePixels() {
  if (!pixelReq) return;
  const gl = renderer.getContext();
  const w = renderer.domElement.width;
  const h = renderer.domElement.height;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let sum = 0;
  let bright = 0;
  const n = w * h;
  for (let i = 0; i < n; i += 1) {
    const l = buf[i * 4] * 0.3 + buf[i * 4 + 1] * 0.59 + buf[i * 4 + 2] * 0.11;
    sum += l;
    if (l > 40) bright += 1;
  }
  const done = pixelReq;
  pixelReq = null;
  done({ w, h, mean: +(sum / n).toFixed(1), bright: +(bright / n).toFixed(3) });
}

/** 场景骨架渲染（花的场景和平台场景共用这一份，避免两处走样） */
function renderSkeleton(hands, now) {
  if (!skeleton) return;
  const showSkel =
    (hands.length > 0 && (state.cameraLive || state.fake || state.demo || state.pointerMode)) || grab.on;
  if (showSkel && !el.handCanvas.classList.contains('is-on')) el.handCanvas.classList.add('is-on');
  else if (!showSkel && el.handCanvas.classList.contains('is-on')) el.handCanvas.classList.remove('is-on');
  try {
    state.skelHands = hands.length;
    state.skelLm = hands[0] && hands[0].landmarks ? hands[0].landmarks.length : -1;
    state.skelT = now;
    let ring = null;
    if (grab.on && grab.f >= 0) {
      const a = FLOWER_ANCHORS[grab.f];
      const rad = 288 * (a.scale || 1);
      const sp = stageToScreen(a.x, a.y);
      const edge = stageToScreen(a.x + rad, a.y);
      const spin = flora.spinOf(grab.f);
      ring = { x: sp.x, y: sp.y, r: Math.max(20, Math.abs(edge.x - sp.x) * 1.1), spin };
    }
    skeleton.render(hands, {
      project: (p) => stageToScreen(p.x, p.y),
      time: now / 1000,
      opacity: REDUCED ? 0.7 : 1,
      grabRing: ring,
      labels: hands.map((h) => POSE_LABEL[h.poseStable || (h.pose && h.pose.pose)] || ''),
      // v4.3：哪几根手指伸直，骨线就按「伸=暖 / 蜷=冷」上色
      fingers: hands.map((h) => (h.pose && h.pose.ext) || null),
    });
  } catch (e) {
    if (!state.skelError) {
      state.skelError = String((e && e.stack) || e);
      console.error('[skeleton]', state.skelError);
    }
  }
}

/* 场景坞初始化（放在这里而不是文件顶部：plat / syncDockCards 都是 const，先声明后用） */
bindDock();
syncDockCards();
bindDolly();
if (el.guideX) el.guideX.addEventListener('click', hideGuide);

function tick(now) {
  rafId = requestAnimationFrame(tick);
  const dt = Math.min(0.05, Math.max(0.0001, (now - lastNow) / 1000));
  lastNow = now;

  // fps
  fpsWindow.frames += 1;
  fpsWindow.elapsed += dt;
  if (fpsWindow.elapsed >= 0.5) {
    fpsWindow.value = fpsWindow.frames / fpsWindow.elapsed;
    state.fps = fpsWindow.value;
    fpsWindow.frames = 0;
    fpsWindow.elapsed = 0;
  }
  // v3：档位只看帧时（governor 内部自己攒窗口 / 防抖 / 每分钟限次）
  governor.sample(dt * 1000);

  tracker.update(now, dt);

  const prevSnap = state.lastSnapshot;
  const hands = currentHands(now, dt, prevSnap);
  let lastSeenAt = null;
  if (state.cameraLive || (state.fake && state.fakeFeed)) lastSeenAt = tracker.lastSeenAt || null;
  else if (state.pointerMode) lastSeenAt = pointerSource.lastSeenAt || null;
  else if (state.demo) lastSeenAt = demoSource.lastSeenAt || null;
  if (!state.cameraLive) state.latency = dt * 1000;

  const snap = engine.frame({
    hands,
    now,
    dt,
    lastSeenAt,
    cameraLive: state.cameraLive || state.fake,
  });
  if (snap.events.length) {
    applyEvents(snap.events, now);
    for (const ev of snap.events) state.events.push({ ...ev, t: now });
    if (state.events.length > 240) state.events.splice(0, state.events.length - 240);
  }
  state.lastSnapshot = snap;

  /* ── v3：先给每只手算姿态（张开 / 竖指 / 捏 / 握拳），后面几个手势都靠它 ── */
  state.lastHands = hands;
  for (const h of hands) {
    try {
      h.pose = classifyPose(h);
    } catch (_) {
      h.pose = null;
    }
    stabilizePose(h);
  }
  updatePoseHud(hands, now);
  if (plat.id === 'bloom') signTracker.update(dt, hands);

  /* ── v2：靠近就慢慢开 + 第三朵被带着开 ───────────────── */
  updateProximity(hands, now, dt, snap);

  /* ── v3：张开手抓住一朵 → 360° 转着看（优先级最高） ──── */
  updateGrab(hands, now, dt);

  /* ── v3：捏一下 = 释放 ──────────────────────────────── */
  updatePinch(hands, now);

  /* ── v4.2：OK / 耶 手势出图案 ────────────────────────── */
  updatePoseMotif(hands, now);

  /* ── v5：切到别的场景时，花的整套逻辑让位 ──────────────── */
  if (plat.id !== 'bloom') {
    platformTick(dt, now, hands, snap.events);
    renderSkeleton(hands, now);
    state.frameIndex += 1;
    if (sampleReqs.length) flushSamples();
    if (FLAG_DEBUG && now - lastDebugAt > 120) {
      drawDebug(now, hands, snap);
      lastDebugAt = now;
    }
    return;
  }
  renderPass.camera = camera;

  /* ── v4：四季流转（抓住不放 → 换季） ──────────────────── */
  updateSeason(dt);

  /* ── v3：张开手在花带外横滑 = 换一种花 ──────────────── */
  updateSwipe(hands, now);

  /* ── 横抚进度反馈（只画不给） ────────────────────────── */
  updateSweepFeedback();

  // 画面
  flora.update(dt, { now, exposure: Math.min(EXPOSURE.max, snap.pet * EXPOSURE.perBloom) });
  if (brightness) {
    state.luma = brightness.sample(now);
    if (state.luma < CAMERA.lowLightLuma) el.modeNote.textContent = '光线不足，手势可能不稳';
    else el.modeNote.textContent = '手距镜头 40–80cm · 手掌完整入镜';
  }
  backdrop.update({ time: now / 1000, exposure: 1 + Math.min(EXPOSURE.max, snap.pet * EXPOSURE.perBloom) });
  renderer.toneMappingExposure = 1 + Math.min(EXPOSURE.max, snap.pet * EXPOSURE.perBloom);

  // 视差：掌心 x → ±8px，y → ±4px，弹簧跟随
  let palm = null;
  if (hands.length) palm = hands[0].palm;
  if (palm && !REDUCED) {
    parallax.tx = (palm.x / STAGE.w - 0.5) * 2 * PARALLAX.ampX;
    parallax.ty = -((palm.y / STAGE.h - 0.5) * 2 * PARALLAX.ampY);
  } else {
    parallax.tx = 0;
    parallax.ty = 0;
  }
  parallax.x += (parallax.tx - parallax.x) * Math.min(1, dt * 6);
  parallax.y += (parallax.ty - parallax.y) * Math.min(1, dt * 6);
  camera.position.x = parallax.x;
  camera.position.y = parallax.y;

  tipGlow.update(hands, now, tipGlow.uniforms.uPxScale.value);
  tipGlow.uniforms.uOpacity.value = REDUCED ? 0.7 : 1;

  queueHud(snap);
  composer.render();
  samplePixels();

  renderSkeleton(hands, now);

  state.frameIndex += 1;
  if (sampleReqs.length) flushSamples();

  if (FLAG_DEBUG && now - lastDebugAt > 120) {
    drawDebug(now, hands, snap);
    lastDebugAt = now;
  }
}

/* ══════════════════════════════════════════════════════════
   v2 三件事：靠近慢开 / 捏一下释放 / 横滑换花 / 3D 看一朵
   ══════════════════════════════════════════════════════════ */

const prox = {
  heat: [0, 0, 0],
  cascade: [0, 0, 0],
  holdUntil: [0, 0, 0],
  // 记录每次「离散触发」占用的时间，连续层在这段时间里让位
  hold(f, now, sec = PROXIMITY.hold) {
    this.holdUntil[f] = Math.max(this.holdUntil[f], now + sec * 1000);
  },
};

/** 手到花心的距离 → 0..1 接近度（按 1080 宽归一化，和触发半径同一套度量） */
function proximityOf(tip, anchor) {
  const d = Math.hypot((tip.x - anchor.x) / STAGE.w, (tip.y - anchor.y) / STAGE.w);
  const t = (PROXIMITY.far - d) / (PROXIMITY.far - PROXIMITY.near);
  return Math.max(0, Math.min(1, t));
}

function updateProximity(hands, now, dt, snap) {
  const anchors = FLOWER_ANCHORS;
  const live = hands.filter((h) => !h.held);
  for (let f = 0; f < 3; f += 1) {
    let h = 0;
    for (const hand of live) h = Math.max(h, proximityOf(hand.tip, anchors[f]));
    prox.heat[f] += (h - prox.heat[f]) * Math.min(1, dt * 7);
  }
  // 两只手分别压住两朵 → 第三朵被带着慢慢开（不是瞬间绽放）
  let hot = 0;
  for (let f = 0; f < 3; f += 1) if (prox.heat[f] > PROXIMITY.hotAt) hot += 1;
  for (let f = 0; f < 3; f += 1) {
    const driven = hot >= 2 && prox.heat[f] <= PROXIMITY.hotAt;
    if (driven) prox.cascade[f] = Math.min(1, prox.cascade[f] + dt * PROXIMITY.trickle);
    else prox.cascade[f] = Math.max(0, prox.cascade[f] - dt * PROXIMITY.trickleDecay);
    if (now < prox.holdUntil[f]) continue; // 离散触发期间不插手
    const target = Math.max(prox.heat[f], prox.cascade[f]);
    flora.setBloom(f, target, { up: PROXIMITY.up, down: PROXIMITY.down });
  }
  // 靠近就开也算学会了第一步
  if (prox.heat[0] > 0.4 || prox.heat[1] > 0.4 || prox.heat[2] > 0.4) tutorial.mark('near');
}

const pinch = { prev: {}, since: new Map(), lastAt: new Map(), armed: new Map() };

function updatePinch(hands, now) {
  // 握拳时拇指尖也贴着食指 → 不能当成捏合，先把握拳的手剔掉
  // v3：优先用姿态分类（open/point/pinch/fist 分得清），拿不到才回落到 fistScore 比值
  const pinchable = hands.filter((h) => {
    if (h.held) return false;
    if (h.pose) return h.pose.pose !== 'fist';
    return (h.fist || 0) < 0.4;
  });
  const found = detectPinch(pinchable, PINCH, pinch.prev);
  state.pinchFound = found;
  state.pinchSince = [...pinch.since.entries()];

  // v4 比心：两只手同时捏（不要求靠近花）→ 心形光点
  const pinchingNow = found.filter((p) => p.on);
  if (pinchingNow.length >= 2) tryHeart(now);

  const seen = new Set();
  for (const p of found) {
    seen.add(p.slot);
    const hand = pinchable.find((h) => h.slot === p.slot);
    // 姿态分类说"这不是捏"（比如张开手/竖食指）→ 不算
    const poseOk = !hand || !hand.pose || hand.pose.pose === 'pinch' || hand.pose.pose === 'other';
    if (p.on) {
      if (!pinch.since.has(p.slot)) pinch.since.set(p.slot, now);
    } else {
      pinch.since.delete(p.slot);
      // 松开才重新上膛：捏着不放不会连发（否则花语卡会被自己开开关关）
      pinch.armed.set(p.slot, true);
    }
    if (!pinch.armed.has(p.slot)) pinch.armed.set(p.slot, true);
    // 捏住满 dwell 才认一次（松开才能再捏）
    if (p.on && poseOk && pinch.armed.get(p.slot) && pinch.since.has(p.slot) && now - pinch.since.get(p.slot) >= PINCH.dwell * 1000) {
      pinch.armed.set(p.slot, false);
      pinch.since.delete(p.slot);
      const f = nearestFlower(p.tip, PINCH.radius);
      if (f >= 0 && !grab.on) {
        pinch.lastAt.set(f, now);
        // v4：花已经开着 → 弹出花语卡；还是花苞 → 原来的「释放开花」
        if (flora.bloomOf(f) > 0.55) {
          toggleOracle(f);
          prox.hold(f, now);
          tutorial.mark('oracle');
        } else {
          flora.release(f, { now });
          prox.hold(f, now);
          tutorial.mark('pinch');
          toast(`释放 · 第 ${f + 1} 朵`);
        }
      } else if (f < 0 && state.oracleOpen) {
        // 花语卡开着的时候，随手捏一下 = 收起
        closeOracle();
      }
    }
    pinch.prev[p.slot] = p.on;
  }
  for (const slot of Object.keys(pinch.prev)) {
    if (!seen.has(Number(slot))) {
      pinch.prev[slot] = false;
      // 手整个离开画面也算松开：重新上膛，回来再捏还能触发
      pinch.armed.set(Number(slot), true);
    }
  }
}

function nearestFlower(hand, radiusMetric) {
  // 触点取「掌心 / 指尖 里更近的那个」：手掌比手指远，只按掌心判会永远够不到
  const cands = [];
  if (hand && typeof hand.x === 'number' && typeof hand.y === 'number') cands.push(hand); // 直接传了一个点
  if (hand && hand.pose && hand.pose.palm) cands.push(hand.pose.palm);
  if (hand && hand.tip) cands.push(hand.tip);
  if (hand && hand.pose && hand.pose.tip) cands.push(hand.pose.tip);
  if (!cands.length) return -1;
  let best = -1;
  let bestD = Infinity;
  for (let f = 0; f < 3; f += 1) {
    const a = FLOWER_ANCHORS[f];
    const r = radiusMetric * (a.scale || 1); // 大朵花的可触范围也跟着放大
    for (const p of cands) {
      const d = Math.hypot((p.x - a.x) / STAGE.w, (p.y - a.y) / STAGE.w);
      if (d <= r && d < bestD) {
        bestD = d;
        best = f;
      }
    }
  }
  return best;
}

const swipe = new SwipeTracker();

function updateSwipe(hands, now) {
  if (grab.on) return; // 抓着花时不做换花
  for (const h of hands) {
    if (h.held) continue;
    // v3：必须是「张开手掌」才算横滑——捏着/握拳/一根手指都不算，免得误触发
    if (h.pose && h.pose.nExt < SWIPE.minExt) {
      swipe.push(h.slot, null, now); // 断掉轨迹，别用旧点凑位移
      continue;
    }
    const hit = swipe.push(h.slot, h.tip, now);
    if (!hit) continue;
    const next = flora.setVariant(flora.variant + hit.dir);
    el.modelLine.textContent = `MODEL 0${next + 1}`;
    tutorial.mark('swipe');
    toast(`换一种花 · MODEL 0${next + 1}`);
  }
}

/* ── v3：张开手抓住一朵 → 360° 转着看 ───────────────────── */
const grab = {
  on: false,
  f: -1,
  slot: -1,
  since: 0,
  pos0: { x: 0, y: 0 },
  angle0: 0,
  yaw0: 0,
  pitch0: 0,
  roll0: 0,
  camT: 0,
  lostAt: 0,
  lastPose: 'open',
  probe: null,
};

function startGrab(hand, f, now) {
  const a = FLOWER_ANCHORS[f];
  const p = hand.pose.palm;
  const spin = flora.spinOf(f);
  grab.on = true;
  grab.f = f;
  grab.slot = hand.slot;
  grab.since = now;
  grab.pos0 = { x: p.x, y: p.y };
  grab.angle0 = hand.pose.angle || 0;
  grab.yaw0 = spin.yaw;
  grab.pitch0 = spin.pitch;
  grab.roll0 = spin.roll;
  grab.lostAt = 0;
  // 抓住 = 这朵开到底，其它朵保持
  flora.openFlower(f, { now });
  prox.hold(f, now, 90);
  el.modelLine.textContent = `MODEL 0${flora.variant + 1} · 第 ${f + 1} 朵 · 观察中`;
  tutorial.mark('grab');
  toast(`抓住第 ${f + 1} 朵 · 手左右/上下移动转它 · 握拳放下`, 3600);
  void a;
}

/* ══════════════════════════════════════════════════════════
   v4 三个玩法：四季流转 / 花语卡 / 比心彩蛋
   设计原则：全部复用已有手势（抓住、捏合），不新增要学的新动作。
   ══════════════════════════════════════════════════════════ */

const season = {
  index: 0,
  hold: 0, // 抓住不动的累计秒数
  bar: 0, // HUD 进度（0–1，带一点回落）
};

const heartFx = new HeartBurst(typeof document !== 'undefined' ? el.app : null);
let heartLastAt = -1e9;
const motifLastAt = new Map(); // 'ok' / 'v' → 上次出图的时间（限流）

/** 开局把季节设成第 0 季（春），并写进 HUD */
function initSeason() {
  const s = SEASONS[0];
  season.index = 0;
  flora.setTint(s.tint, { immediate: true });
  state.season = 0;
  if (el.veil) {
    el.veil.style.background = s.veil;
    el.veil.style.opacity = '1';
  }
  if (el.seasonLabel) el.seasonLabel.textContent = s.label;
  if (el.seasonLine) el.seasonLine.hidden = false;
  if (el.seasonBar) el.seasonBar.style.width = '0%';
  if (el.oracleSeason) el.oracleSeason.textContent = s.en;
}

/** 换季：颜色乘数 + 色雾 + HUD 文案，全部走渐变 */
function setSeason(i, { announce = true } = {}) {
  season.index = ((i % SEASONS.length) + SEASONS.length) % SEASONS.length;
  const s = SEASONS[season.index];
  flora.setTint(s.tint);
  state.season = season.index;
  if (el.veil) el.veil.style.background = s.veil;
  if (el.seasonLabel) el.seasonLabel.textContent = s.label;
  if (el.oracleSeason) el.oracleSeason.textContent = s.en;
  if (announce) toast(`${s.label} · ${s.line}`, 2800);
}

/** 每帧：抓住花不动就累计，满 SEASON_HOLD 秒进下一季；松手回落 */
function updateSeason(dt) {
  if (grab.on) {
    season.hold += dt;
    if (season.hold >= SEASON_HOLD) {
      season.hold = 0;
      setSeason(season.index + 1);
    }
  } else if (season.hold > 0) {
    season.hold = Math.max(0, season.hold - dt * 2.4);
  }
  const want = grab.on ? Math.min(1, season.hold / SEASON_HOLD) : 0;
  season.bar += (want - season.bar) * Math.min(1, dt * 10);
  if (el.seasonBar) el.seasonBar.style.width = `${(season.bar * 100).toFixed(1)}%`;
}

/* ── 花语卡 ─────────────────────────────────────────────── */

/** 同一天同一朵抽到同一条（不用随机，录屏重开也一样） */
function dayIndex() {
  const d = new Date();
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

function oracleEntry(flowerIndex) {
  const key = SEASONS[season.index].key;
  const lines = ORACLE_LINES[key] || ORACLE_LINES.spring;
  return lines[(dayIndex() + flowerIndex) % lines.length];
}

/** 花语卡卡面序号：每次开卡 +1，三种版式轮流用 */
let oracleTplSeq = -1;

function openOracle(flowerIndex) {
  if (!el.oracle) return;
  const entry = oracleEntry(flowerIndex);
  const s = SEASONS[season.index];
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  if (el.oracleWord) el.oracleWord.textContent = entry.word;
  if (el.oraclePoem) el.oraclePoem.textContent = entry.poem;
  if (el.oracleFlower) el.oracleFlower.textContent = `${entry.flower} · 第 ${flowerIndex + 1} 朵`;
  if (el.oracleDate) el.oracleDate.textContent = `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
  if (el.oracleSeason) el.oracleSeason.textContent = s.en;
  // v5：三种卡面轮着来（竖排印鉴 / 双栏 / 居中大字），同一句话不会每次都长得一样
  const card = el.oracle.querySelector('.oracle-card');
  if (card) {
    oracleTplSeq = (oracleTplSeq + 1) % ORACLE_TPL;
    card.dataset.tpl = String(oracleTplSeq);
    card.dataset.season = s.id || String(season.index);
  }
  el.oracle.hidden = false;
  el.oracle.setAttribute('aria-hidden', 'false');
  // 强制一次样式计算再上 class，避免「同帧加 class 过渡不触发」也避免闪一帧
  void el.oracle.offsetWidth;
  el.oracle.classList.add('is-open');
  state.oracleOpen = true;
  state.oracleFlower = flowerIndex;
}

function closeOracle({ silent = false } = {}) {
  if (!el.oracle || !state.oracleOpen) return;
  state.oracleOpen = false;
  el.oracle.classList.remove('is-open');
  el.oracle.setAttribute('aria-hidden', 'true');
  const hide = () => {
    if (!state.oracleOpen) el.oracle.hidden = true;
  };
  if (REDUCED) hide();
  else setTimeout(hide, 420);
  if (!silent) toast('花签收起', 1400);
}

function toggleOracle(flowerIndex) {
  if (state.oracleOpen) {
    closeOracle();
    return;
  }
  openOracle(flowerIndex);
}

/* ── 比心彩蛋 ───────────────────────────────────────────── */

/** 双手同时捏合 → 花心炸出一圈心形光点（8 秒内只放一次，免得抖） */
function tryHeart(now) {
  if (now - heartLastAt < 8000) return false;
  heartLastAt = now;
  const a = FLOWER_ANCHORS[1] || FLOWER_ANCHORS[0];
  heartFx.play({
    x: a.x,
    y: a.y * 0.92,
    color: SEASONS[season.index].key === 'winter' ? '#c9d6ff' : '#ffd2dc',
    scale: 1.2,
    shape: 'heart',
  });
  // 花心亮点 + 位置反馈
  flora.openFlower(1, { now });
  prox.hold(1, now, 1.6);
  toast('心意已收到 · 比心成功', 2600);
  state.heartCount = (state.heartCount || 0) + 1;
  tutorial.mark('heart');
  return true;
}

/* ── v4.2：OK / 耶 手势出图案（圆环 / 叶子） ───────────────── */

const POSEMOTIF = Object.freeze({
  ok: { shape: 'ring', color: '#ffe7bd', toast: '圆满 · 一圈都是好的', label: 'OK' },
  v: { shape: 'leaf', color: '#c9f1c4', toast: '生发 · 长出一片叶子', label: 'V' },
});
const POSE_MOTIF = Object.freeze({ hold: 0.3, cooldown: 2600 });
const poseWatch = new Map(); // slot → { pose, since, fired }

/**
 * 稳住 0.3 秒就把图案画在掌心上方；同一次「稳住」只放一次，
 * 手势变了才会重新计数，所以举着 OK 不会连发。
 */
function updatePoseMotif(hands, now) {
  const seen = new Set();
  for (const h of hands) {
    if (!h || h.held) continue;
    const key = h.pose && h.pose.pose;
    const def = POSEMOTIF[key];
    seen.add(h.slot);
    if (!def) {
      poseWatch.delete(h.slot);
      continue;
    }
    const prev = poseWatch.get(h.slot);
    if (!prev || prev.pose !== key) {
      poseWatch.set(h.slot, { pose: key, since: now, fired: false });
      continue;
    }
    if (prev.fired) continue;
    if (now - prev.since < POSE_MOTIF.hold * 1000) continue;
    if (now - (motifLastAt.get(key) || -1e9) < POSE_MOTIF.cooldown) {
      prev.fired = true;
      continue;
    }
    prev.fired = true;
    motifLastAt.set(key, now);
    const palm = (h.pose && h.pose.palm) || h.tip;
    heartFx.play({
      x: palm.x,
      y: palm.y - 40,
      color: def.color,
      scale: 0.95,
      shape: def.shape,
    });
    toast(def.toast, 2200);
    state.motifCount = (state.motifCount || 0) + 1;
    state.lastMotif = def.shape;
    tutorial.mark('motif');
  }
  for (const slot of [...poseWatch.keys()]) if (!seen.has(slot)) poseWatch.delete(slot);
}

function endGrab(reason) {
  if (!grab.on) return;
  const f = grab.f;
  grab.on = false;
  grab.slot = -1;
  grab.f = -1;
  // 松手后慢慢回正（2.6s），方便下一次动作
  flora.spinHome(f);
  el.modelLine.textContent = `MODEL 0${flora.variant + 1}`;
  if (reason) toast(reason, 1800);
}

function updateGrab(hands, now, dt) {
  // 镜头推近/退回
  const wantCam = grab.on ? 1 : 0;
  grab.camT += (wantCam - grab.camT) * Math.min(1, dt / Math.max(0.05, GRAB.zoomDur) * 1.6);

  if (!grab.on) {
    // 张开的手「停在」花上 dwell 秒 → 抓住（路过得够快就不抓，免得扫一下就粘住）
    for (const h of hands) {
      if (h.held || !h.pose || h.pose.pose !== 'open') continue;
      const f = nearestFlower(h, GRAB.on);
      if (f < 0) {
        grab.lostAt = 0;
        grab.probe = null;
        continue;
      }
      const p = h.pose.palm;
      if (!grab.probe) {
        grab.probe = { f, x: p.x, y: p.y, t: now };
        break;
      }
      const moved = Math.hypot(p.x - grab.probe.x, p.y - grab.probe.y) / STAGE.w;
      if (moved > 0.05 || grab.probe.f !== f) {
        // 手还在移动：把基准推着走，不累积停留时间
        grab.probe = { f, x: p.x, y: p.y, t: now };
        break;
      }
      if (now - grab.probe.t >= GRAB.dwell * 1000) startGrab(h, f, now);
      break;
    }
    if (!grab.on) grab.lostAt = 0;
    applyInspectCamera(dt);
    return;
  }

  const h = hands.find((x) => x.slot === grab.slot && !x.held);
  if (!h) {
    // 手掉了：等 0.6s，没回来就松
    if (!grab.lostAt) grab.lostAt = now;
    if (now - grab.lostAt > 600) endGrab('手离开了 · 放下花');
    applyInspectCamera(dt);
    return;
  }
  grab.lostAt = 0;
  const pose = h.pose || { palm: h.palm, tip: h.tip, angle: 0, pose: 'other' };
  if (pose.pose === 'fist' || pose.pose === 'pinch' || (h.fist || 0) > 0.6) {
    // 握拳 = 放下；捏合 = 想对那朵做动作，也放下（抓只认张开的手）
    endGrab(pose.pose === 'pinch' ? '捏合 · 放下花' : '握拳 · 放下花');
    applyInspectCamera(dt);
    return;
  }
  // 手走太远 → 松（用「相对抓起位置」的距离：转花时本来就要移动手）
  const palmNow = pose.palm || h.palm;
  const dist = Math.hypot((palmNow.x - grab.pos0.x) / STAGE.w, (palmNow.y - grab.pos0.y) / STAGE.w);
  if (dist > GRAB.off) {
    endGrab('手移开了 · 放下花');
    applyInspectCamera(dt);
    return;
  }

  // 手感：手左右 → 绕竖轴；手上下 → 俯仰；手掌自转 → 滚转
  const dx = (pose.palm.x - grab.pos0.x) / STAGE.w;
  const dy = (pose.palm.y - grab.pos0.y) / STAGE.w;
  const dAng = wrapPi((pose.angle || 0) - grab.angle0) * GRAB.angleGain;
  const cur = flora.spinOf(grab.f);
  const wantYaw = grab.yaw0 + dx * GRAB.yawGain;
  const wantPitch = grab.pitch0 + dy * GRAB.pitchGain;
  const wantRoll = grab.roll0 + dAng * GRAB.rollGain;
  // 限速，避免手抖把花甩飞
  const lim = GRAB.maxRate * dt;
  flora.setSpin(grab.f, {
    yaw: cur.yaw + clampAbs(wantYaw - cur.yaw, lim),
    pitch: cur.pitch + clampAbs(wantPitch - cur.pitch, lim),
    roll: cur.roll + clampAbs(wantRoll - cur.roll, lim),
  });
  applyInspectCamera(dt);
}

/** 手到花心的最近距离（掌心 / 指尖取小），按 1080 宽归一化 */
function contactDist(pose, anchor) {
  let best = Infinity;
  if (pose && pose.palm) best = Math.min(best, Math.hypot((pose.palm.x - anchor.x) / STAGE.w, (pose.palm.y - anchor.y) / STAGE.w));
  if (pose && pose.tip) best = Math.min(best, Math.hypot((pose.tip.x - anchor.x) / STAGE.w, (pose.tip.y - anchor.y) / STAGE.w));
  if (!Number.isFinite(best)) best = Math.hypot((pose.x - anchor.x) / STAGE.w, (pose.y - anchor.y) / STAGE.w);
  return best;
}

function wrapPi(a) {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

function clampAbs(v, lim) {
  return Math.max(-lim, Math.min(lim, v));
}

/* 抓花时的镜头：推近到那一朵（和旧的 gallery 共用同一套数学） */
function applyInspectCamera() {
  const t = grab.camT;
  if (t < 0.002) {
    camera.zoom = 1;
    camera.position.set(parallax.x, parallax.y, 100);
    camera.updateProjectionMatrix();
    return;
  }
  const f = Math.max(0, grab.f);
  const a = FLOWER_ANCHORS[f];
  const cy = view.cover.cy || 0;
  const tx = a.x - STAGE.w / 2;
  const ty = STAGE.h / 2 - a.y + cy;
  camera.zoom = 1 + (GRAB.zoom - 1) * t;
  camera.position.set(parallax.x * (1 - t) + tx * t, parallax.y * (1 - t) + ty * t, 100);
  camera.updateProjectionMatrix();
}

/* ── 横抚进度反馈：让"到底怎么才能触发"变成看得见的进度 ──── */
let sweepShownAt = 0;

function updateSweepFeedback() {
  if (!el.sweepTrack) return;
  const p = engine.sweepPreview ? engine.sweepPreview() : null;
  const show = !!p && p.progress > 0;
  const now = performance.now();
  if (show) sweepShownAt = now;
  const visible = show || now - sweepShownAt < 450;
  if (el.sweepTrack.hidden === visible) el.sweepTrack.hidden = !visible;
  el.sweepTrack.classList.toggle('on', visible);
  if (!visible) return;
  if (el.sweepLabel) el.sweepLabel.textContent = `横抚 ${p.progress}/${p.need}`;
  const dots = el.sweepTrack.querySelectorAll('i');
  dots.forEach((d, i) => d.classList.toggle('hit', !!(p && p.hit[i])));
}


/* ── v3：画质 governor（帧时驱动，掉到 <50fps 就降一档）────── */
const governor = new QualityGovernor({
  onTier: (tier, index) => {
    state.qualityTier = index;
    state.particles = tier.particles;
    applyTier(tier);
  },
});

function applyTier(tier) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, tier.dpr);
  state.dpr = dpr;
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  composer.setPixelRatio(dpr);
  composer.setSize(w, h);
  // bloom 的后处理分辨率单独缩：这是最贵的一步，缩它先省一大截
  bloomPass.setSize(Math.max(1, Math.round(w * tier.bloomScale)), Math.max(1, Math.round(h * tier.bloomScale)));
  flora.setBudget(tier.particles);
  if (typeof backdrop.setDetail === 'function') backdrop.setDetail(tier.backdropDetail);
}

/* ── 调试层 ─────────────────────────────────────────────── */
const dbg = {
  ctx: null,
  fps: document.getElementById('dbg-fps'),
  lat: document.getElementById('dbg-lat'),
  st: document.getElementById('dbg-state'),
  pet: document.getElementById('dbg-pet'),
  hands: document.getElementById('dbg-hands'),
  particles: document.getElementById('dbg-particles'),
  delegate: document.getElementById('dbg-delegate'),
  luma: document.getElementById('dbg-luma'),
};

/* ── 画面采样（e2e 用：确认不是黑屏、亮部占比） ───────── */
let sampleReqs = [];
function flushSamples() {
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const N = 24;
  const px = new Uint8Array(4);
  let sum = 0;
  let max = 0;
  let lit = 0;
  let n = 0;
  for (let iy = 0; iy < N; iy += 1) {
    for (let ix = 0; ix < N; ix += 1) {
      gl.readPixels(Math.floor(((ix + 0.5) / N) * w), Math.floor(((iy + 0.5) / N) * h), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const l = (px[0] * 0.2126 + px[1] * 0.7152 + px[2] * 0.0722) / 255;
      sum += l;
      if (l > max) max = l;
      if (l > 0.06) lit += 1;
      n += 1;
    }
  }
  const res = { mean: sum / n, max, lit: lit / n };
  for (const resolve of sampleReqs) resolve(res);
  sampleReqs = [];
}

function drawDebug(now, hands, snap) {
  const canvas = el.debugCanvas;
  if (!dbg.ctx) dbg.ctx = canvas.getContext('2d');
  const ctx = dbg.ctx;
  const dpr = Math.min(window.devicePixelRatio || 1, TIERS[0].dpr);
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const s = h / view.cover.h;

  // 三朵触发半径（enterR 实线 / exitR 虚线）
  for (let i = 0; i < 3; i += 1) {
    const c = flora.anchorWorld(i);
    const p = stageToScreen(c.x + STAGE.w / 2, STAGE.h / 2 - c.y);
    const enter = 0.09 * STAGE.w * s;
    const exit = 0.13 * STAGE.w * s;
    ctx.beginPath();
    ctx.arc(p.x, p.y, enter, 0, Math.PI * 2);
    ctx.strokeStyle = snap.open[i] ? 'rgba(255,241,230,0.55)' : 'rgba(184,198,255,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.setLineDash([3, 5]);
    ctx.arc(p.x, p.y, exit, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(184,198,255,0.16)';
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 双手骨架
  for (const hand of hands) {
    if (!hand.landmarks) continue;
    ctx.strokeStyle = hand.fist ? 'rgba(255,143,163,0.75)' : 'rgba(255,194,209,0.5)';
    ctx.lineWidth = 1;
    for (const [a, b] of HAND_CONNECTIONS) {
      const pa = hand.landmarks[a];
      const pb = hand.landmarks[b];
      if (!pa || !pb) continue;
      const p1 = stageToScreen(pa.x, pa.y);
      const p2 = stageToScreen(pb.x, pb.y);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
    for (const lm of hand.landmarks) {
      const p = stageToScreen(lm.x, lm.y);
      ctx.fillStyle = 'rgba(255,241,230,0.6)';
      ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    }
    const tip = stageToScreen(hand.tip.x, hand.tip.y);
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,241,230,0.9)';
    ctx.fill();
  }

  dbg.fps.textContent = state.fps.toFixed(0);
  dbg.lat.textContent = `${state.latency.toFixed(1)}ms`;
  dbg.st.textContent = snap.state;
  dbg.pet.textContent = `${snap.pet}/3`;
  dbg.hands.textContent = String(hands.length);
  dbg.particles.textContent = String(state.particles);
  dbg.delegate.textContent = state.delegate;
  dbg.luma.textContent = state.luma.toFixed(3);
  void now;
}

/* ── 演示 / 启动 ────────────────────────────────────────── */
function startDemo() {
  state.demo = true;
  el.gate.hidden = true;
  el.hud.hidden = false;
  tutorial.syncSteps();
  tutorial.coach('DEMO', '这是一遍自动演示：轻触 → 握拳 → 横抚 → 双端', 6000);
  el.pointerBar.hidden = true;
  el.debugCanvas.hidden = !FLAG_DEBUG;
  demoSource.active = true;
  setLive('DEMO LOOP', true);
  el.modeNote.textContent = '自动循环 · 轻触 / 握拳 / 横抚 / 双端';
  flora.setOpacity(1);
}

function startFake() {
  state.fake = true;
  el.gate.hidden = true;
  el.hud.hidden = false;
  el.pointerBar.hidden = true;
  setLive('TEST FEED', true);
  el.modeNote.textContent = '合成 landmark · 与摄像头同一链路';
  flora.setOpacity(1);
}

function boot() {
  resize();
  flora.setOpacity(0.62); // 开场门后面：三朵花苞在呼吸
  el.debugCanvas.hidden = !FLAG_DEBUG;
  if (FLAG_DEBUG) el.dbgPanel.hidden = false;

  el.start.addEventListener('click', () => {
    startCameraFlow();
  });
  el.pointer.addEventListener('click', () => {
    enterPointerMode('指针模式：指针就是指尖，按住 = 握拳收拢。');
  });
  el.skip.addEventListener('click', () => {
    enterPointerMode('先看无摄像头版。随时可以点「开启手势」再试摄像头。');
  });
  el.btnDual.addEventListener('click', () => {
    const on = !pointerSource.dual;
    pointerSource.setDual(on);
    el.btnDual.classList.toggle('on', on);
    el.btnDual.textContent = on ? '模拟双手 · 开' : '模拟双手';
  });
  el.btnCamera.addEventListener('click', () => {
    el.hud.hidden = true;
    el.pointerBar.hidden = true;
    el.gate.hidden = false;
    el.gate.classList.remove('closing');
    el.gate.style.background = '';
    state.gateVisible = true;
    pointerSource.setActive(false);
    state.pointerMode = false;
    startCameraFlow();
  });

  document.addEventListener('visibilitychange', () => {
    state.hidden = document.hidden;
    if (document.hidden) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
      if (frameLoop) frameLoop.stop();
      if (currentStream) currentStream.getAudioTracks().forEach(() => {});
    } else if (!rafId) {
      lastNow = performance.now();
      rafId = requestAnimationFrame(tick);
      if (frameLoop && state.cameraLive) frameLoop.start();
    }
  });

  if (FLAG_DEMO) {
    startDemo();
  } else if (FLAG_FAKE) {
    startFake();
  } else if (FLAG_POINTER) {
    enterPointerMode('');
  }

  // v4：开局落在春季，把色雾 / HUD / 颜色乘数都对齐
  initSeason();

  rafId = requestAnimationFrame(tick);

  // 测试 / 调试接口：把假 landmark 直接灌进同一条流水线
  window.__bloom = {
    version: '1.0.0',
    get ready() {
      return !state.gateVisible || state.demo || state.pointerMode || state.fake;
    },
    state,
    engine,
    tracker,
    flora,
    snapshot: () => state.lastSnapshot,
    events: () => (state.events || []).map((e) => ({ type: e.type, at: e.at, t: e.t })),
    clearEvents() {
      state.events.length = 0;
      return true;
    },
    variant: () => flora.variant,
    /* 自测直接读运行时状态（v2 的 e2e 就靠它，保持对象形态别改成函数） */
    get state() {
      return state;
    },
    hands: () => currentHands(performance.now(), 1 / 60, state.lastSnapshot),
    feed(landmarkSets) {
      state.fake = true;
      state.fakeFeed = landmarkSets && landmarkSets.length ? landmarkSets : null;
      return true;
    },
    clearFeed() {
      state.fakeFeed = null;
    },
    pushLandmarks(landmarks, now = performance.now()) {
      tracker.ingest({ landmarks, worldLandmarks: [], handedness: [] }, now);
      return tracker.activeHands();
    },
    clearTracking() {
      tracker.reset();
      if (engine.hardReset) engine.hardReset();
      state.lastSeenAt = null;
      return true;
    },
    sample() {
      return new Promise((resolve) => sampleReqs.push(resolve));
    },
    /* 调画面用：直接开/合、改 bloom 参数 */
    openAll(now = performance.now()) {
      // 连续接近层会立刻把它们压回去，所以先占住时间窗
      for (let i = 0; i < 3; i += 1) {
        prox.hold(i, now, 30);
        flora.openFlower(i, { now });
      }
      return true;
    },
    closeAll(now = performance.now()) {
      for (let i = 0; i < 3; i += 1) prox.hold(i, now, 30);
      flora.closeAll({ now, order: [0, 1, 2], stagger: 0 });
      return true;
    },
    setBloom(strength, radius, threshold) {
      bloomPass.strength = strength;
      bloomPass.radius = radius;
      bloomPass.threshold = threshold;
      return true;
    },
    bloom() {
      return { strength: bloomPass.strength, radius: bloomPass.radius, threshold: bloomPass.threshold };
    },
    theme() {
      return { post: POST, flora: { baseRadius: flora.baseRadius || null } };
    },
    /* v3：抓花观察 / 姿态 / 横抚进度，给自测用 */
    grab() {
      const s = grab.f >= 0 ? flora.spinOf(grab.f) : { yaw: 0, pitch: 0, roll: 0 };
      return {
        on: grab.on,
        f: grab.f,
        cam: +grab.camT.toFixed(3),
        spin: { yaw: +s.yaw.toFixed(3), pitch: +s.pitch.toFixed(3), roll: +s.roll.toFixed(3) },
      };
    },
    /* 兼容旧名字（v2 的 gallery = 现在的 grab） */
    gallery() {
      return this.grab();
    },
    poses() {
      const hs = state.lastHands || [];
      return hs.map((h) => (h.pose ? { slot: h.slot, pose: h.pose.pose, nExt: h.pose.nExt, pinch: +h.pose.pinchRatio.toFixed(3) } : null));
    },
    sweepPreview() {
      const p = engine.sweepPreview ? engine.sweepPreview() : null;
      return p ? { progress: p.progress, need: p.need, hit: p.hit } : null;
    },
    /* 画质档位：读 / 手动切换（自测和用户手选都用它） */
    quality() {
      const tier = TIERS[governor.index] || TIERS[0];
      return {
        ...governor.stats(),
        name: tier.name,
        dpr: state.dpr || tier.dpr,
        bloomScale: tier.bloomScale,
        particles: tier.particles,
        backdropDetail: tier.backdropDetail,
      };
    },
    setQuality(i) {
      const tier = governor.force(i);
      return { index: governor.index, tier: tier.name };
    },
    sweepBufDump() {
      const out = [];
      if (engine.sweepBuf) {
        for (const [slot, buf] of engine.sweepBuf) {
          out.push({ slot, n: buf.length, first: buf[0], last: buf[buf.length - 1] });
        }
      }
      return out;
    },
    /* v4：四季 / 花语卡 / 比心 —— 自测和手动验收都用这几个 */
    season() {
      return {
        index: season.index,
        key: SEASONS[season.index].key,
        label: SEASONS[season.index].label,
        hold: +season.hold.toFixed(2),
        bar: +season.bar.toFixed(3),
        tint: flora.uniforms.uTint.value.toArray().map((v) => +v.toFixed(3)),
        veil: el.veil ? el.veil.style.background.slice(0, 40) : '',
      };
    },
    setSeason(i) {
      setSeason(i, { announce: false });
      return this.season();
    },
    oracleOpen() {
      return !!(el.oracle && !el.oracle.hidden && el.oracle.classList.contains('is-open'));
    },
    /* 自检用：直接开卡（三种卡面轮换靠它验证） */
    oracleToggle(f = 0) {
      toggleOracle(f);
      const card = el.oracle && el.oracle.querySelector('.oracle-card');
      return card ? card.dataset.tpl : null;
    },
    oracleText() {
      if (!el.oracle) return null;
      return {
        open: this.oracleOpen(),
        word: el.oracleWord ? el.oracleWord.textContent : '',
        poem: el.oraclePoem ? el.oraclePoem.textContent : '',
        flower: el.oracleFlower ? el.oracleFlower.textContent : '',
        date: el.oracleDate ? el.oracleDate.textContent : '',
      };
    },
    openOracle,
    closeOracle,
    heart() {
      return { count: state.heartCount || 0, canvas: !!document.querySelector('.heart-fx') };
    },
    /** v4.2：OK / 耶 图案的状态与手动触发 */
    motif() {
      return {
        count: state.motifCount || 0,
        last: state.lastMotif || null,
        canvas: !!document.querySelector('.heart-fx'),
      };
    },
    fireMotif(shape = 'ring') {
      const def = Object.values(POSEMOTIF).find((d) => d.shape === shape) || POSEMOTIF.ok;
      heartFx.play({ x: STAGE.w * 0.5, y: STAGE.h * 0.45, color: def.color, scale: 0.95, shape });
      state.motifCount = (state.motifCount || 0) + 1;
      state.lastMotif = shape;
      return { shape, canvas: !!document.querySelector('.heart-fx') };
    },
    fireHeart() {
      tryHeart(performance.now());
      return this.heart();
    },
    /* ── v5：交互平台 ─────────────────────────────────── */
    setPlatform(id, opts = {}) {
      return setPlatform(id, opts);
    },
    platformInfo() {
      return {
        ...platformHost.info(),
        id: plat.id,
        view: plat.view,
        dockOpen: el.dockList ? !el.dockList.hidden : null,
        bloomVisible: bloomRoot.visible,
        actions: platformHost.actions().map((a) => a.id),
        hud: platformHost.hud(),
      };
    },
    /** 场景内部状态（手势有没有真的改变它），自检脚本读这个 */
    platformDebug() {
      return platformHost.info().debug || null;
    },
    platformAction(id) {
      return platformSwitchAction(id);
    },
    /** 自检用：把根场景交出去，方便在控制台里查场景树 / 亮度 */
    sceneRoot() {
      return scene;
    },
    /** 下一帧渲染完的整屏亮度（mean 0–255 / bright 0–1），用来量化「是不是太白」 */
    pixelStats() {
      return new Promise((resolve) => {
        pixelReq = resolve;
        setTimeout(() => {
          if (pixelReq === resolve) {
            pixelReq = null;
            resolve(null);
          }
        }, 1500);
      });
    },
    toggleView() {
      const v = platformHost.toggleView();
      if (v) plat.view = v;
      return v;
    },
    pinchDebug() {
      return {
        found: state.pinchFound || [],
        since: state.pinchSince || [],
        hands: (state.lastHands || []).map((h) => ({ slot: h.slot, held: h.held, fist: +(h.fistScore || 0).toFixed(2), pose: h.pose && h.pose.pose })),
      };
    },
    camera() {
      return { zoom: camera.zoom, x: camera.position.x, y: camera.position.y };
    },
    setVariant(k) {
      return flora.setVariant(k);
    },
    bloomPath() {
      return [0, 1, 2].map((i) => +flora.getBloom(i).toFixed(3));
    },
    heat() {
      return prox.heat.map((v) => +v.toFixed(3));
    },
    skelInfo() {
      if (!skeleton || !el.handCanvas) return null;
      const c = el.handCanvas;
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      let peak = 0;
      for (let i = 3; i < d.length; i += 4) {
        if (d[i] > 0) n += 1;
        if (d[i] > peak) peak = d[i];
      }
      return {
        n,
        peak,
        w: c.width,
        h: c.height,
        on: c.classList.contains('is-on'),
        err: state.skelError || null,
        hands: state.skelHands,
        lm: state.skelLm,
        skelT: state.skelT ? Math.round(performance.now() - state.skelT) : null,
        st: skeleton.stats ? { ...skeleton.stats } : null,
        dpr: skeleton.dpr,
        css: [skeleton.cssW, skeleton.cssH],
      };
    },
    enterGrab(f, slot = 0) {
      const hand = {
        slot,
        pose: { pose: 'open', palm: { x: FLOWER_ANCHORS[f].x, y: FLOWER_ANCHORS[f].y }, angle: 0, nExt: 5, pinchRatio: 0.8 },
      };
      startGrab(hand, f, performance.now());
      return true;
    },
    endGrab: (reason) => endGrab(reason),
    enterGallery(f) {
      return this.enterGrab(f);
    },
    exitGallery() {
      endGrab('测试退出');
      return true;
    },
    project: (p) => stageToScreen(p.x, p.y),
    view: () => ({ ...view.cover }),
    enterPointerMode,
    startDemo,
    startFake,
    startCameraFlow,
    setBudget(n) {
      flora.setBudget(n);
    },
    fps: () => state.fps,
    latency: () => state.latency,
    gateVisible: () => state.gateVisible,
    delegate: () => state.delegate,
    cameraLive: () => state.cameraLive,
  };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
