import * as THREE from 'three';
import { EffectComposer } from '../vendor/three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/three/addons/postprocessing/OutputPass.js';

import { CONFIG } from './config.js';
import { clamp, damp, smoothstep, InertialSpring } from './utils.js';
import { Galaxy } from './galaxy.js';
import { Nebula, Starfield, Dust } from './backdrop.js';
import { BlackHole } from './blackhole.js';
import { Supernova } from './supernova.js';
import { FingerStars } from './fingers.js';
import { HandTracker, computeOpenness, computePinch, computePoint, palmMetrics } from './hands.js';
import { Hud } from './hud.js';

const params = new URLSearchParams(location.search);
const DEMO = params.get('demo') === '1';
const DEBUG = params.get('debug') === '1';
const REDUCED =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
CONFIG.reducedMotion = REDUCED;

const BASE_TILT = CONFIG.particles.tilt;
const canvas = document.getElementById('scene');
const video = document.getElementById('camVideo');
const hud = new Hud();

const S = {
  mode: 'standby', // standby | hand | pointer | demo
  phase: 'standby', // standby | tracking | collapse | supernova
  started: false,
  paused: false,
  startedAt: 0,
  time: 0,
  fps: 0,
  booted: false,
  bootMs: 0,
  lastFrameAt: 0,
  dpr: 0,
  count: 0,
  isMobile: false,

  // 兼容旧接口 / HUD 用（= 主手）
  openness: 1,
  collapse: 0,
  spin: CONFIG.particles.spin,
  scale: CONFIG.demo.scale,
  flash: 0,
  burst: 0,

  hands: [],
  handCount: 0,
  hintedDual: false,
  hintedSolo: false,
  tracking: false,
  handVisible: false,
  handScreen: null,
  handAnchorScreen: null,
  fingerWorld: null,
  lastHandAt: -1e9,

  pointer: {
    down: false,
    ndc: { x: 0, y: 0 },
    targetNdc: { x: 0, y: 0 },
    hasPos: false,
  },

  syntheticHands: null,
  syntheticLandmarks: null,
  manual: null,
  cameraError: null,
};

let renderer;
let camera;
let scene;
let composer;
let bloomPass;
let nebula;
let starfield;
let dust;
let fingers;
let tracker;

const springCfg = CONFIG.hand.spring;

/* ------------------------------------------------------------------ */
/* 一只手 = 一团星系                                                    */
/* ------------------------------------------------------------------ */
class Slot {
  constructor(index, variant) {
    this.index = index;
    this.galaxy = new Galaxy(renderer, variant);
    this.galaxy.group.visible = false;
    scene.add(this.galaxy.group);

    this.blackhole = new BlackHole();
    this.galaxy.group.add(this.blackhole.group);

    this.supernova = new Supernova(scene);
    this.supernova.group.visible = false;

    this.anchorX = new InertialSpring(0, springCfg.k, springCfg.damping);
    this.anchorY = new InertialSpring(-0.45, springCfg.k, springCfg.damping);
    this.scale = new InertialSpring(CONFIG.demo.scale, springCfg.k, springCfg.damping);
    this.tiltX = new InertialSpring(BASE_TILT, springCfg.k, springCfg.damping);
    this.tiltY = new InertialSpring(0, springCfg.k, springCfg.damping);
    this.tiltZ = new InertialSpring(0, springCfg.k, springCfg.damping);

    this.active = false;
    this.fade = 0;
    this.collapse = 0;
    this.openness = 1;
    this.pinch = 1;
    this.pinchOn = false;
    this.point = false;
    this.fistSeen = false;
    this.supernovaAt = -1e9;
    this.lastSeen = -1e9;
    this.rawX = 0;
    this.rawY = 0;
    this.velX = 0;
    this.velY = 0;
    this.hasRaw = false;
    this.lens = 0;
    this.ax = 0;
    this.ay = -0.45;
    this.sc = CONFIG.demo.scale;
    this.screen = null;
    this.anchorScreen = null;
    this.fingerWorld = Array.from({ length: 5 }, () => new THREE.Vector3());
    this.fingerActive = false;
  }

  resetTargets() {
    this.anchorX.target = 0;
    this.anchorY.target = ndcWorld(0, CONFIG.demo.anchor.y).y;
    this.scale.target = CONFIG.demo.scale;
    this.tiltX.target = BASE_TILT;
    this.tiltY.target = 0;
    this.tiltZ.target = 0;
  }

  step(dt) {
    // 自适应刚度：慢速保持柔软，快速追得更紧（不被弹性拖出"橡皮筋"感）
    const speed = Math.hypot(this.velX, this.velY);
    const boost = clamp(speed / CONFIG.hand.spring.speedRef, 0, 1) * CONFIG.hand.spring.kBoost;
    this.anchorX.k = CONFIG.hand.spring.k + boost;
    this.anchorY.k = this.anchorX.k;

    this.ax = this.anchorX.step(dt);
    this.ay = this.anchorY.step(dt);
    this.sc = this.scale.step(dt);
    this.tiltX.step(dt);
    this.tiltY.step(dt);
    this.tiltZ.step(dt);
  }
}

const slots = [];

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */
function init() {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: CONFIG.renderer.antialias,
    powerPreference: 'high-performance',
    alpha: false,
    stencil: false,
  });
  if (!renderer.capabilities.isWebGL2) {
    throw new Error('需要 WebGL2 支持（Chrome / Edge / Safari 16+）');
  }
  const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.renderer.dprMax);
  S.dpr = +dpr.toFixed(2);
  S.count = CONFIG.particles.count;
  S.isMobile = !!CONFIG.isMobile;
  renderer.setPixelRatio(dpr);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(CONFIG.renderer.clear, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = CONFIG.renderer.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(CONFIG.renderer.clear);

  camera = new THREE.PerspectiveCamera(
    CONFIG.renderer.fov,
    window.innerWidth / window.innerHeight,
    CONFIG.renderer.near,
    CONFIG.renderer.far
  );
  camera.position.set(0, 0, CONFIG.renderer.cameraZ);

  composer = new EffectComposer(renderer);
  composer.setPixelRatio(dpr);
  composer.setSize(window.innerWidth, window.innerHeight);
  composer.addPass(new RenderPass(scene, camera));

  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    CONFIG.bloom.strength,
    CONFIG.bloom.radius,
    CONFIG.bloom.threshold
  );
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  nebula = new Nebula(scene, renderer, camera);
  starfield = new Starfield(scene, renderer);
  dust = new Dust(scene, renderer);

  slots.push(new Slot(0, 0));
  slots.push(new Slot(1, 1));

  fingers = new FingerStars(scene, CONFIG.hand.fingerFilter);
  tracker = new HandTracker(video);

  bindUi();
  bindInput();
  resize();

  hud.updateStats(S.spin, 1, slots[0].galaxy.count, dpr);
  hud.setState('STANDBY', 'standby');
  hud.showGate(!DEMO);
  hud.setDebug(DEBUG);

  if (DEMO) startDemo();

  S.startedAt = performance.now();
  warmUp();
  requestAnimationFrame(frame);

  // 首屏后立刻预载模型：面板上有进度条，点「开启掌心」直接进
  if (S.mode === 'standby' && CONFIG.hand.preload !== false) {
    setTimeout(() => {
      if (S.started || S.mode !== 'standby') return;
      let last = -1;
      tracker?.preload?.((p) => {
        const pct = Math.round(p * 100);
        if (pct - last >= 1 || p < 0) {
          last = pct;
          hud.setPreload(p);
        }
      });
    }, 400);
  }
}

/** 预热：把星系 / 冲击波 / 指尖星的材质都编译一遍，爆发时不掉帧。 */
function warmUp() {
  const saved = slots.map((s) => ({
    gv: s.galaxy.group.visible,
    sv: s.supernova.group.visible,
    alpha: s.galaxy.uniforms.uAlpha.value,
  }));
  const pts = new Array(10).fill(null).map(() => new THREE.Vector3(0, 0, 0));
  try {
    for (const s of slots) {
      s.galaxy.group.visible = true;
      s.galaxy.uniforms.uAlpha.value = 1;
      s.supernova.group.visible = true;
      s.supernova.uniforms.uProgress.value = 0.4;
      s.supernova.uniforms.uFlash.value = 0.2;
      s.supernova.ring.scale.setScalar(2);
    }
    fingers.update(pts, 0, 1, { suck: 0, eject: 0, center: null, point: [true, true] }, [true, true]);
    renderer.compile(scene, camera);
    composer.render();
  } catch (err) {
    console.warn('warmup failed', err);
  } finally {
    slots.forEach((s, i) => {
      s.galaxy.group.visible = saved[i].gv;
      s.galaxy.uniforms.uAlpha.value = saved[i].alpha;
      s.supernova.group.visible = saved[i].sv;
      s.supernova.uniforms.uProgress.value = 0;
      s.supernova.uniforms.uFlash.value = 0;
    });
    fingers.reset();
  }
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/** 开摄像头（面板按钮与自测脚本共用）。 */
async function startCamera() {
  hud.setHint('正在打开摄像头 · CAMERA…');
  const slowHint = setTimeout(() => {
    hud.setHint('首次要下载手部模型（约 20 秒），之后浏览器缓存，秒开');
  }, 6000);
  try {
    // 面板上已经在预载就复用进度；没有就现在开始（start() 会等它）
    if (!tracker.running && CONFIG.hand.preload !== false) {
      tracker.preload((p) => {
        hud.setPreload(p);
        if (p > 0) hud.setHint(`正在下载手部模型 ${Math.round(p * 100)}% · 首次约 20 秒`);
      });
    }
    await tracker.start({
      // 摄像头一通就报一声，但面板留到识别器就绪再关（初始化期间主线程忙，提前关＝看到卡住）
      onCamera: () => {
        hud.setCameraLabel('CAMERA · 加载中', true);
        hud.setHint('摄像头已开 · 正在初始化识别器…');
      },
    });
    S.mode = 'hand';
    S.started = true;
    hud.setCameraLabel('CAMERA LIVE', true);
    hud.setDelegate(`${tracker.delegate} · LOCAL`);
    hud.showGate(false);
    hud.setHint('双手各托一团 · 握拳坍缩 · 捏合透镜 · 指向留星轨');
    return true;
  } catch (err) {
    console.error(err);
    S.cameraError = err?.message || String(err);
    S.mode = 'pointer';
    S.started = true;
    hud.setCameraLabel('CAMERA OFFLINE', false);
    hud.setHint('摄像头不可用 · POINTER MODE');
    hud.showGate(false);
    return false;
  } finally {
    clearTimeout(slowHint);
  }
}

/* ------------------------------------------------------------------ */
function bindUi() {
  const btnCamera = document.getElementById('btnCamera');
  const btnPointer = document.getElementById('btnPointer');

  btnCamera?.addEventListener('click', async () => {
    btnCamera.disabled = true;
    btnCamera.classList.add('loading');
    try {
      await startCamera();
    } finally {
      btnCamera.disabled = false;
      btnCamera.classList.remove('loading');
    }
  });

  btnPointer?.addEventListener('click', () => {
    S.mode = 'pointer';
    S.started = true;
    hud.setCameraLabel('POINTER MODE', false);
    hud.showGate(false);
    hud.setHint('按住 = 坍缩 · 松开 = 爆发 · ← ↑ ↓ → 移动');
  });

  document.getElementById('gate')?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hud.showGate(false);
  });
}

function bindInput() {
  const el = document.getElementById('stage');

  el.addEventListener('pointerdown', (e) => {
    if (S.mode === 'hand' || S.mode === 'demo') return;
    if (!S.started) return;
    S.pointer.down = true;
    S.pointer.hasPos = true;
    updatePointerNdc(e);
  });

  window.addEventListener('pointerup', () => {
    if (S.mode !== 'pointer' || !S.pointer.down) return;
    S.pointer.down = false;
    const burst = CONFIG.pointer.burstOnRelease && S.collapse > 0.2 && triggerSupernova(0);
    if (!burst) S.phase = 'tracking';
  });

  window.addEventListener('pointermove', (e) => {
    if (S.mode !== 'pointer') return;
    S.pointer.hasPos = true;
    updatePointerNdc(e);
  });

  window.addEventListener('keydown', (e) => {
    if (S.mode !== 'pointer') return;
    if (e.code === 'Space') {
      e.preventDefault();
      S.pointer.down = true;
    }
    const step = 0.05;
    if (e.key === 'ArrowLeft') S.pointer.targetNdc.x = clamp(S.pointer.targetNdc.x - step, -0.85, 0.85);
    if (e.key === 'ArrowRight') S.pointer.targetNdc.x = clamp(S.pointer.targetNdc.x + step, -0.85, 0.85);
    if (e.key === 'ArrowUp') S.pointer.targetNdc.y = clamp(S.pointer.targetNdc.y + step, -0.85, 0.85);
    if (e.key === 'ArrowDown') S.pointer.targetNdc.y = clamp(S.pointer.targetNdc.y - step, -0.85, 0.85);
    if (e.key === 'Escape' && S.started) hud.showGate(true);
  });

  window.addEventListener('keyup', (e) => {
    if (S.mode !== 'pointer') return;
    if (e.code === 'Space' && S.pointer.down) {
      S.pointer.down = false;
      const burst = CONFIG.pointer.burstOnRelease && S.collapse > 0.2 && triggerSupernova(0);
      if (!burst) S.phase = 'tracking';
    }
  });

  document.addEventListener('visibilitychange', () => {
    S.paused = document.hidden;
    if (!S.paused) {
      S.lastFrameAt = performance.now();
      requestAnimationFrame(frame);
    }
  });

  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 220));
}

function updatePointerNdc(e) {
  S.pointer.targetNdc.x = clamp((e.clientX / window.innerWidth) * 2 - 1, -0.92, 0.92);
  S.pointer.targetNdc.y = clamp(1 - (e.clientY / window.innerHeight) * 2, -0.92, 0.92);
}

function resize() {
  if (!renderer) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.renderer.dprMax);

  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();

  composer.setPixelRatio(dpr);
  composer.setSize(w, h);
  bloomPass.setSize(w, h);

  nebula?.resize();
  if (starfield) starfield.uniforms.uPixelRatio.value = dpr;
  if (dust) dust.uniforms.uPixelRatio.value = dpr;
  for (const slot of slots) slot.galaxy.uniforms.uPixelRatio.value = dpr;

  hud.resize();
}

/* ------------------------------------------------------------------ */
/* 坐标映射（不分配对象）                                                */
/* ------------------------------------------------------------------ */
function halfExtents() {
  const h = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * CONFIG.renderer.cameraZ;
  return { x: (h * camera.aspect) / 2, y: h / 2 };
}

function ndcWorld(nx, ny) {
  const half = halfExtents();
  return { x: nx * half.x, y: ny * half.y };
}

/* ------------------------------------------------------------------ */
/* 手势 → 手部数据                                                      */
/* ------------------------------------------------------------------ */
/** 把一只手的 landmark 转成世界坐标与手势（每帧调用，不分配）。 */
function readHand(lm) {
  const half = halfExtents();
  const pm = palmMetrics(lm);
  const openness = computeOpenness(lm) ?? 1;
  const pinch = computePinch(lm);
  const point = computePoint(lm);

  // 镜像：画面与自己的手同向
  const nx = clamp(1 - pm.anchor.x * 2, -0.84, 0.84);
  const ny = clamp(1 - pm.anchor.y * 2, -0.84, 0.84);
  const wx = nx * half.x * CONFIG.hand.exaggeration;
  const wy = ny * half.y * CONFIG.hand.exaggeration;

  const p1x = (1 - lm[5].x * 2) * half.x;
  const p1y = (1 - lm[5].y * 2) * half.y;
  const p2x = (1 - lm[17].x * 2) * half.x;
  const p2y = (1 - lm[17].y * 2) * half.y;
  const palmWorld = Math.hypot(p1x - p2x, p1y - p2y);

  const palmFactor = clamp(palmWorld / 1.25, 0.55, 1.9);
  const depthFactor = clamp(1 - lm[9].z * 1.8, 0.85, 1.5);
  const rawScale = CONFIG.demo.scale * palmFactor * depthFactor * CONFIG.hand.sizeBoost * 0.85;
  const targetScale = clamp(
    rawScale,
    CONFIG.demo.scale * CONFIG.hand.sizeRange[0],
    CONFIG.demo.scale * CONFIG.hand.sizeRange[1]
  );

  const roll = Math.atan2(p2y - p1y, p2x - p1x);

  return {
    lm,
    openness,
    pinch,
    point,
    wx,
    wy,
    scale: targetScale,
    roll: clamp(roll, -CONFIG.hand.tiltMax, CONFIG.hand.tiltMax),
    tiltX: clamp(BASE_TILT + pm.pitch * 0.35, 0.22, 1.3),
    tiltY: clamp(pm.yaw * 0.5, -CONFIG.hand.tiltMax * 0.7, CONFIG.hand.tiltMax * 0.7),
    half,
  };
}

function collectHands(now) {
  if (S.syntheticHands) return S.syntheticHands.map(readHand);
  if (S.syntheticLandmarks) return [readHand(S.syntheticLandmarks)];
  if (S.mode !== 'hand' || !tracker?.running) return [];
  const list = tracker.hands(now); // 主线程模式下这里会真正跑一次识别
  if (!list.length) return [];
  if (now - tracker.lastSeen > CONFIG.hand.lostTimeoutMs) return [];
  return list.map((h) => readHand(h.landmarks));
}

/* ------------------------------------------------------------------ */
/* 坍缩曲线（每只手独立）                                                */
/* ------------------------------------------------------------------ */
function moveCollapse(slot, dt, target) {
  if (target > slot.collapse) {
    const speed = (1 / (CONFIG.gesture.collapseMs / 1000)) * (0.22 + 2.1 * slot.collapse);
    slot.collapse = Math.min(target, slot.collapse + speed * dt);
  } else if (target < slot.collapse) {
    const speed = (1 / (CONFIG.gesture.releaseMs / 1000)) * (0.3 + 2.2 * (1 - slot.collapse));
    slot.collapse = Math.max(target, slot.collapse - speed * dt);
  }
}

let lastMergeAt = -1e9;

function triggerSupernova(index = 0, power = 1) {
  const slot = slots[index];
  if (!S.started || !slot) return false;
  const now = performance.now();
  if (now - slot.supernovaAt < CONFIG.gesture.supernovaCooldownMs) return false;
  slot.supernovaAt = now;
  slot.supernova.trigger(power);
  S.burstMaxDt = 0;
  S.phase = 'supernova';
  hud.setState('SUPERNOVA', 'supernova');
  return true;
}

/* ------------------------------------------------------------------ */
/* 每帧更新                                                            */
/* ------------------------------------------------------------------ */
function updateSlots(dt, now) {
  const hands = S.mode === 'hand' || S.syntheticHands || S.syntheticLandmarks ? collectHands(now) : [];
  S.hands = hands;
  S.handCount = hands.length;

  const half = halfExtents();
  const limitX = half.x * 0.92;
  const dual = hands.length > 1;

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const h = hands[i];

    if (!h) {
      slot.active = false;
      slot.fingerActive = false;
      slot.fade = damp(slot.fade, 0, 7, dt);
      if (slot.fade < 0.02) {
        slot.collapse = 0;
        slot.lens = 0;
        slot.pinchOn = false;
        slot.resetTargets();
      }
      continue;
    }

    slot.active = true;
    slot.lastSeen = now;
    slot.fingerActive = true;
    slot.screen = landmarksToScreen(h.lm);
    slot.anchorScreen = handScreenMid(h.lm);

    // 位置：弹簧 + 速度外推（抵消识别延迟）
    if (!slot.hasRaw) {
      slot.rawX = h.wx;
      slot.rawY = h.wy;
      slot.hasRaw = true;
      slot.anchorX.reset(h.wx);
      slot.anchorY.reset(h.wy);
    }
    const vx = clamp((h.wx - slot.rawX) / Math.max(dt, 0.001), -40, 40);
    const vy = clamp((h.wy - slot.rawY) / Math.max(dt, 0.001), -40, 40);
    slot.velX = damp(slot.velX, vx, 16, dt);
    slot.velY = damp(slot.velY, vy, 16, dt);
    slot.rawX = h.wx;
    slot.rawY = h.wy;

    const lead = CONFIG.hand.prediction;
    const px = clamp(slot.velX * lead, -CONFIG.hand.predictionMax, CONFIG.hand.predictionMax);
    const py = clamp(slot.velY * lead, -CONFIG.hand.predictionMax, CONFIG.hand.predictionMax);

    slot.anchorX.target = clamp(h.wx + px, -limitX, limitX);
    slot.anchorY.target = clamp(h.wy + py, -half.y * 0.92, half.y * 0.92);
    slot.scale.target = h.scale * (dual ? CONFIG.hand.dualScale : 1);
    slot.tiltX.target = h.tiltX;
    slot.tiltY.target = h.tiltY;
    slot.tiltZ.target = h.roll;

    slot.openness = damp(
      slot.openness,
      h.point ? Math.max(h.openness, CONFIG.gesture.open + 0.08) : h.openness,
      CONFIG.gesture.opennessLerp,
      dt
    );

    // 捏合（带滞回）：拇指 + 食指靠近，且手掌不是握拳 → 引力透镜
    const wantPinch = h.pinch < CONFIG.gesture.pinchOn && h.openness > 0.5;
    if (!slot.pinchOn && wantPinch) slot.pinchOn = true;
    else if (slot.pinchOn && (h.pinch > CONFIG.gesture.pinchOff || h.openness <= 0.45)) slot.pinchOn = false;
    slot.lens = damp(slot.lens, slot.pinchOn ? CONFIG.gesture.pinchLens : 0, 9, dt);

    let target = 1 - smoothstep(CONFIG.gesture.fist, CONFIG.gesture.open, slot.openness);
    if (slot.pinchOn) target = Math.max(target, CONFIG.gesture.pinchCollapse);
    moveCollapse(slot, dt, target);

    // 指尖世界坐标（复用向量）
    const tips = [4, 8, 12, 16, 20];
    for (let k = 0; k < 5; k++) {
      const p = h.lm[tips[k]];
      slot.fingerWorld[k].set((1 - p.x * 2) * half.x, (1 - p.y * 2) * half.y, 0);
    }

    slot.point = h.point;

    // 握拳 → 张开 = 超新星（捏合释放是小脉冲）
    if (h.openness < CONFIG.gesture.fist) slot.fistSeen = true;
    if (
      slot.fistSeen &&
      h.openness > CONFIG.gesture.open &&
      slot.collapse > 0.2 &&
      now - slot.supernovaAt > CONFIG.gesture.supernovaCooldownMs
    ) {
      slot.fistSeen = false;
      triggerSupernova(i, 1);
    }

    slot.fade = damp(slot.fade, 1, 9, dt);
  }

  // 双手靠近 → 合并爆发
  if (hands.length === 2) {
    const a = slots[0];
    const b = slots[1];
    const d = Math.hypot(a.anchorX.value - b.anchorX.value, a.anchorY.value - b.anchorY.value);
    if (
      d < CONFIG.hand.mergeDist &&
      now - lastMergeAt > CONFIG.hand.mergeCooldownMs &&
      now - Math.max(a.supernovaAt, b.supernovaAt) > 1200
    ) {
      lastMergeAt = now;
      a.supernovaAt = b.supernovaAt = now;
      a.supernova.trigger(1.25);
      b.supernova.trigger(1.25);
      S.phase = 'supernova';
      S.mergeFlashes = 2;
      hud.setState('MERGE', 'supernova');
    }
  }

  // HUD / 兼容字段
  const primary = slots[0];
  S.collapse = primary.collapse;
  S.openness = primary.openness;
  S.tracking = hands.length > 0;
  S.handVisible = hands.length > 0;
  S.handScreen = hands[0] ? primary.screen : null;
  S.handAnchorScreen = hands[0] ? primary.anchorScreen : null;
  S.fingerWorld = hands[0] ? primary.fingerWorld : null;

  if (S.handCount === 0 && S.mode === 'hand' && now - Math.max(primary.lastSeen, slots[1].lastSeen) > CONFIG.hand.lostTimeoutMs) {
    if (S.phase !== 'supernova') {
      S.phase = 'standby';
      hud.setState('STANDBY', 'standby');
    }
  }

  if (!slots.some((s) => s.supernova.active) && (S.phase === 'supernova' || S.phase === 'merge')) {
    S.phase = hands.length ? 'tracking' : 'standby';
  }

  if (hands.length && S.phase !== 'supernova') {
    const collapsing = hands.some((h, i) => slots[i].collapse > 0.4);
    S.phase = collapsing ? 'collapse' : 'tracking';
    hud.setState(collapsing ? 'COLLAPSE' : hands.length > 1 ? 'DUAL' : 'STABLE', collapsing ? 'collapse' : 'stable');
  }
}

function updatePointer(dt) {
  S.pointer.ndc.x = damp(S.pointer.ndc.x, S.pointer.targetNdc.x, 6, dt);
  S.pointer.ndc.y = damp(S.pointer.ndc.y, S.pointer.targetNdc.y, 6, dt);
  const world = ndcWorld(S.pointer.ndc.x, S.pointer.ndc.y);

  const slot = slots[0];
  slot.active = true;
  slot.fingerActive = false;
  slot.fade = damp(slot.fade, 1, 9, dt);
  slot.anchorX.target = world.x;
  slot.anchorY.target = world.y;
  slot.scale.target = CONFIG.demo.scale;
  slot.tiltX.target = BASE_TILT + S.pointer.ndc.y * 0.16;
  slot.tiltY.target = -S.pointer.ndc.x * 0.2;
  slot.tiltZ.target = S.pointer.ndc.x * 0.12;
  slot.pinchOn = false;
  slot.lens = 0;

  S.openness = damp(S.openness, S.pointer.down ? 0 : 1, 7, dt);
  moveCollapse(slot, dt, S.pointer.down ? 1 : 0);
  slot.openness = S.openness;
  S.collapse = slot.collapse;

  slots[1].fade = damp(slots[1].fade, 0, 7, dt);
  slots[1].active = false;

  if (!slot.supernova.active) {
    S.phase = S.pointer.down && slot.collapse > 0.3 ? 'collapse' : 'tracking';
    hud.setState(S.phase === 'collapse' ? 'COLLAPSE' : 'STABLE', S.phase === 'collapse' ? 'collapse' : 'stable');
  }
}

/* ------------------------------------------------------------------ */
/* Demo 循环                                                           */
/* ------------------------------------------------------------------ */
const demo = { t: 0, phase: 'open' };

function startDemo() {
  S.mode = 'demo';
  S.started = true;
  hud.showGate(false);
  hud.setCameraLabel('DEMO LOOP', false);
  hud.setHint('DEMO · 托起 → 握拳 → 爆发（循环）');
  const slot = slots[0];
  const a = ndcWorld(CONFIG.demo.anchor.x, CONFIG.demo.anchor.y);
  slot.anchorX.reset(a.x);
  slot.anchorY.reset(a.y);
  slot.scale.reset(CONFIG.demo.scale);
  slot.tiltX.reset(BASE_TILT);
  slot.fade = 1;
  slot.active = true;
  slot.galaxy.group.visible = true;
  hud.setState('STABLE', 'stable');
}

function updateDemo(dt, now) {
  demo.t += dt;
  const d = CONFIG.demo;
  const a = ndcWorld(d.anchor.x, d.anchor.y);
  const slot = slots[0];

  slot.active = true;
  slot.fingerActive = false;
  slot.fade = damp(slot.fade, 1, 9, dt);
  slot.anchorX.target = a.x;
  slot.anchorY.target = a.y;
  slot.scale.target = d.scale;
  slot.tiltX.target = BASE_TILT + Math.sin(demo.t * 0.12) * 0.06;
  slot.tiltY.target = Math.sin(demo.t * 0.09) * 0.1;
  slot.tiltZ.target = Math.sin(demo.t * 0.07) * 0.08;
  slots[1].fade = damp(slots[1].fade, 0, 7, dt);

  if (demo.phase === 'open') {
    S.phase = 'tracking';
    slot.openness = damp(slot.openness, 1, 3.0, dt);
    moveCollapse(slot, dt, 0);
    if (demo.t * 1000 > d.openMs) {
      demo.phase = 'close';
      demo.t = 0;
    }
  } else if (demo.phase === 'close') {
    S.phase = 'collapse';
    slot.openness = damp(slot.openness, 0.04, 3.4, dt);
    moveCollapse(slot, dt, 1);
    if (demo.t * 1000 > d.closeMs && slot.collapse > 0.85) {
      demo.phase = 'fist';
      demo.t = 0;
    }
  } else if (demo.phase === 'fist') {
    S.phase = 'collapse';
    slot.openness = damp(slot.openness, 0.02, 4, dt);
    moveCollapse(slot, dt, 1);
    if (demo.t * 1000 > d.fistHoldMs) {
      demo.phase = 'burst';
      demo.t = 0;
      triggerSupernova(0, 1);
    }
  } else if (demo.phase === 'burst') {
    slot.openness = damp(slot.openness, 1, 5.5, dt);
    moveCollapse(slot, dt, 0);
    if (demo.t * 1000 > d.burstHoldMs) {
      demo.phase = 'relax';
      demo.t = 0;
    }
  } else if (demo.phase === 'relax') {
    S.phase = 'tracking';
    slot.openness = damp(slot.openness, 1, 2.4, dt);
    moveCollapse(slot, dt, 0);
    if (demo.t * 1000 > d.relaxMs) {
      demo.phase = 'open';
      demo.t = 0;
    }
  }

  S.collapse = slot.collapse;
  S.openness = slot.openness;
  if (!slot.supernova.active) {
    hud.setState(slot.collapse > 0.4 ? 'COLLAPSE' : 'STABLE', slot.collapse > 0.4 ? 'collapse' : 'stable');
  }
}

/* ------------------------------------------------------------------ */
/* 主循环                                                              */
/* ------------------------------------------------------------------ */
function frame(now) {
  if (S.paused) return;
  requestAnimationFrame(frame);

  const dt = Math.min((now - (S.lastFrameAt || now)) / 1000, 0.05);
  S.lastFrameAt = now;
  S.time += dt;
  if (S.burstMaxDt != null && slots.some((s) => s.supernova.active)) {
    S.burstMaxDt = Math.max(S.burstMaxDt, dt);
  }

  if (!S.started) {
    const slot = slots[0];
    slot.active = true;
    slot.fade = damp(slot.fade, 1, 6, dt);
    slot.anchorX.target = 0;
    slot.anchorY.target = ndcWorld(0, CONFIG.demo.anchor.y).y;
    slot.scale.target = CONFIG.demo.scale;
    slot.tiltX.target = BASE_TILT;
    slot.tiltY.target = Math.sin(S.time * 0.05) * 0.14;
    slot.tiltZ.target = Math.sin(S.time * 0.04) * 0.12;
  } else if (S.mode === 'demo') {
    updateDemo(dt, now);
  } else if (S.mode === 'pointer') {
    updatePointer(dt);
  } else {
    updateSlots(dt, now);
  }

  for (const slot of slots) slot.step(dt);

  const primary = slots[0];
  const sc = primary.sc;
  S.scale = sc;

  let flash = 0;
  let burst = 0;
  for (const slot of slots) {
    const sn = slot.supernova.update(dt, S.time);
    slot.values = sn;
    flash = Math.max(flash, sn.flash);
    burst = Math.max(burst, sn.burst);
  }
  S.flash = REDUCED ? flash * 0.5 : flash;
  S.burst = REDUCED ? burst * 0.7 : burst;

  if (!slots.some((s) => s.supernova.active) && S.phase === 'supernova') S.phase = 'tracking';

  const breathe =
    1 + CONFIG.particles.breatheAmp * Math.sin(S.time * CONFIG.particles.breatheHz * Math.PI * 2);
  S.spin = CONFIG.particles.spin * breathe * (1 + S.collapse * CONFIG.particles.spinCollapse);
  if (REDUCED) S.spin *= 0.45;

  // 手动姿态（调试 / 截图）：冻结主手
  if (S.manual) {
    const slot = slots[0];
    slot.collapse = S.manual.collapse ?? 0;
    slot.openness = 1 - slot.collapse;
    slot.fade = 1;
    slot.active = true;
    S.collapse = slot.collapse;
    S.openness = slot.openness;
    S.flash = S.manual.flash ?? 0;
    S.burst = S.manual.burst ?? 0;
    S.spin = S.manual.spin ?? CONFIG.particles.spin;
    S.scale = S.manual.scale ?? CONFIG.demo.scale;
    const mw = ndcWorld(S.manual.x ?? 0, S.manual.y ?? CONFIG.demo.anchor.y);
    slot.anchorX.reset(mw.x);
    slot.anchorY.reset(mw.y);
    slot.scale.reset(S.scale);
    slot.galaxy.group.position.set(mw.x, mw.y, 0);
    slot.galaxy.group.rotation.set(S.manual.tilt ?? BASE_TILT, S.manual.yaw ?? 0, S.manual.roll ?? 0);
    slot.galaxy.uniforms.uScale.value = S.scale;
    slot.values = slot.values || slot.supernova.values;
    if (S.manual.ring != null) {
      slot.supernova.group.visible = true;
      slot.supernova.ring.scale.setScalar(0.4 + S.manual.ring * CONFIG.supernova.shockRadius);
      slot.supernova.uniforms.uProgress.value = S.manual.ring;
      slot.supernova.uniforms.uFlash.value = S.flash;
      slot.supernova.uniforms.uTime.value = S.time;
    } else if (!slot.supernova.active) {
      slot.supernova.group.visible = false;
    }
  }

  if (!S.booted) {
    S.booted = true;
    S.bootMs = Math.round(performance.now());
  }

  hud.flash(S.flash * CONFIG.supernova.flashOpacity);

  let drawnParticles = 0;
  const handsOpen = S.hands.length;

  for (const slot of slots) {
    const g = slot.galaxy;
    const visible = slot.fade > 0.01;
    g.group.visible = visible;
    if (!visible) continue;
    drawnParticles += g.count;

    g.uniforms.uScale.value = slot.sc;
    if (!S.manual || slot.index !== 0) {
      g.group.position.set(slot.ax, slot.ay, 0);
      g.group.rotation.set(slot.tiltX.value, slot.tiltY.value, slot.tiltZ.value);
    }
    g.uniforms.uAlpha.value = slot.fade;
    g.diskUniforms.uAlpha.value = slot.fade;
    g.glowMat.opacity *= slot.fade;

    g.update(
      S.time,
      S.spin,
      slot.collapse,
      1 - slot.collapse,
      (slot.values?.burst ?? 0) * CONFIG.supernova.burstKick,
      (slot.values?.flash ?? 0) * 0.4
    );
    g.uniforms.uTint.value.copy(slot.values?.tint || WHITE);

    slot.blackhole.update(S.time, slot.collapse, slot.values?.flash ?? 0, slot.sc, slot.lens);

    slot.supernova.group.position.set(slot.ax, slot.ay, 0);
    if (S.manual && slot.index === 0) {
      const mw = ndcWorld(S.manual.x ?? 0, S.manual.y ?? CONFIG.demo.anchor.y);
      slot.supernova.group.position.set(mw.x, mw.y, 0);
    }
  }

  nebula.update(S.time, S.collapse, S.flash * 0.6);
  starfield.update(S.time, S.flash * 0.4);
  dust.update(S.time, S.collapse);

  // 指尖星：左手 5 + 右手 5
  const fingerPoints = FINGER_POINTS;
  const fingerActive = [slots[0].fade > 0.05, slots[1].fade > 0.05];
  for (let i = 0; i < 5; i++) fingerPoints[i] = fingerActive[0] ? slots[0].fingerWorld[i] : null;
  for (let i = 0; i < 5; i++) fingerPoints[5 + i] = fingerActive[1] ? slots[1].fingerWorld[i] : null;

  const fxSlot = slots[0].supernova.active ? slots[0] : slots[1].supernova.active ? slots[1] : null;
  let fx = null;
  if (fxSlot) {
    const t = fxSlot.supernova.t;
    const suck = smoothstep(0, 0.14, t) * (1 - smoothstep(0.16, 0.32, t));
    const eject = smoothstep(0.28, 1.0, t) * (1 - smoothstep(1.6, 2.3, t));
    if (suck > 0.002 || eject > 0.002) {
      fx = {
        suck,
        eject,
        center: { x: fxSlot.ax, y: fxSlot.ay },
        point: [slots[0].point, slots[1].point],
      };
    }
  }
  if (!fx) fx = { suck: 0, eject: 0, center: null, point: [slots[0].point, slots[1].point] };
  fingers.update(fingerPoints, S.time, 1, fx, fingerActive);

  // 镜头：几乎静止，只有极轻的呼吸
  shakeAmp = damp(shakeAmp, S.burst * 0.03, 5, dt);
  if (!REDUCED && shakeAmp > 0.0003) {
    shake.set((Math.random() - 0.5) * shakeAmp, (Math.random() - 0.5) * shakeAmp, 0);
  } else {
    shake.set(0, 0, 0);
  }
  const ax = primary.ax;
  const ay = primary.ay;
  const parallaxX = REDUCED ? 0 : clamp(ax * 0.02, -0.1, 0.1);
  const parallaxY = REDUCED ? 0 : clamp(ay * 0.018, -0.09, 0.09);
  camera.position.set(shake.x + parallaxX, parallaxY + shake.y, CONFIG.renderer.cameraZ);
  camera.lookAt(0, 0, 0);

  bloomPass.strength =
    CONFIG.bloom.strength + S.flash * CONFIG.bloom.supernovaBoost + S.collapse * 0.06;
  renderer.toneMappingExposure = CONFIG.renderer.exposure + S.flash * 0.22;

  composer.render();

  const handsForHud = [];
  for (const slot of slots) {
    if (slot.fade > 0.05 && slot.screen) {
      handsForHud.push({ screen: slot.screen, anchor: slot.anchorScreen, pinch: slot.pinchOn });
    }
  }
  hud.drawOverlay(handsForHud, S.collapse);
  hud.updateStats(S.spin, 1 + S.collapse * 2.4 + S.burst * 1.2, drawnParticles || primary.galaxy.count, renderer.getPixelRatio());

  hud.tickFps(now, dt);
  hud.updateDebug(S.fps, tracker?.latencyMs || 0, S.mode, S.handAnchorScreen, now, S.handCount);
  lastFpsFrames++;
  if (now - lastFpsAt > 500) {
    S.fps = (lastFpsFrames * 1000) / (now - lastFpsAt);
    lastFpsFrames = 0;
    lastFpsAt = now;
  }

  // 双手提示只出现一次
  if (handsOpen === 2 && !S.hintedDual) {
    S.hintedDual = true;
    hud.setHint('双手同时张合 · 靠近掌心 → 合并爆发 · 捏合 → 引力透镜');
  } else if (handsOpen < 2 && !S.hintedSolo) {
    S.hintedSolo = true;
    hud.setHint('摊开 → 星云 · 握拳 → 坍缩 · 张开 → 超新星 · 捏合 → 透镜');
  }
}

const WHITE = new THREE.Color(1, 1, 1);
const FINGER_POINTS = new Array(10).fill(null);
let shakeAmp = 0;
let shake = new THREE.Vector3();
let lastFpsFrames = 0;
let lastFpsAt = 0;

/* ------------------------------------------------------------------ */
/* 手势坐标 → 屏幕像素（HUD 线框）                                       */
/* ------------------------------------------------------------------ */
function landmarksToScreen(lm) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return lm.map((p) => ({ x: (1 - p.x) * w, y: p.y * h }));
}

function handScreenMid(lm) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return { x: (1 - (lm[0].x + lm[9].x) / 2) * w, y: ((lm[0].y + lm[9].y) / 2) * h };
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */
try {
  init();
} catch (err) {
  console.error(err);
  const gate = document.getElementById('gate');
  const card = gate?.querySelector('.gate-card');
  if (card) {
    const p = document.createElement('p');
    p.className = 'gate-error';
    p.textContent = '无法启动 WebGL2：' + err.message;
    card.appendChild(p);
  }
}

/* 调试 / 自测接口（不参与界面） */
window.PALM_COSMOS = {
  config: CONFIG,
  state: S,
  demo,
  hud,
  slots: () => slots,
  scene: () => scene,
  renderer: () => renderer,
  composer: () => composer,
  bloom: () => bloomPass,
  galaxy: () => slots[0].galaxy,
  galaxyB: () => slots[1].galaxy,
  blackhole: () => slots[0].blackhole,
  supernova: () => slots[0].supernova,
  supernovaB: () => slots[1].supernova,
  nebula: () => nebula,
  tracker: () => tracker,
  startDemo,
  startCamera,
  triggerSupernova: (power = 1) => triggerSupernova(0, power),
  triggerSupernovaB: (power = 1) => triggerSupernova(1, power),
  setOpenness: (v) => {
    S.openness = v;
    S.collapse = 1 - v;
    slots[0].openness = v;
    slots[0].collapse = 1 - v;
  },
  setSyntheticLandmarks: (lm) => {
    S.syntheticLandmarks = lm;
    S.syntheticHands = lm ? [lm] : null;
    if (lm) S.started = true;
  },
  setSyntheticHands: (arr) => {
    S.syntheticHands = arr && arr.length ? arr : null;
    S.syntheticLandmarks = S.syntheticHands ? S.syntheticHands[0] : null;
    if (S.syntheticHands) S.started = true;
  },
  setMode: (m) => {
    S.mode = m;
    S.started = true;
    hud.showGate(false);
  },
  setPose: (pose) => {
    S.manual = pose || null;
    S.started = true;
    hud.showGate(false);
  },
  gestures: (lm) => ({
    openness: computeOpenness(lm),
    pinch: computePinch(lm),
    point: computePoint(lm),
    ext: [8, 12, 16, 20].map((t) => {
      const wrist = lm[0];
      const palm = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) + 0.0001;
      return {
        tip: +(Math.hypot(lm[t].x - wrist.x, lm[t].y - wrist.y) / palm).toFixed(2),
        pip: +(Math.hypot(lm[t - 2].x - wrist.x, lm[t - 2].y - wrist.y) / palm).toFixed(2),
      };
    }),
  }),
  stats: () => ({
    fps: S.fps,
    mode: S.mode,
    phase: S.phase,
    collapse: S.collapse,
    openness: S.openness,
    scale: S.scale,
    hands: S.handCount,
    bootMs: S.bootMs,
    particles: slots[0].galaxy.count,
    renderer: renderer?.getContext()?.getParameter(renderer.getContext().VERSION),
    bloom: bloomPass?.strength,
  }),
};