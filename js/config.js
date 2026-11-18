/* PALM COSMOS — 玩法与性能参数（视觉常量见 src/theme.js）。
 * 纯静态，无构建。修改后刷新即可。
 */
import { THEME } from '../src/theme.js';

const IS_MOBILE =
  typeof matchMedia === 'function' &&
  (matchMedia('(hover: none)').matches || innerWidth < 760);

const PARAMS = (() => {
  if (typeof location === 'undefined') return new URLSearchParams();
  return new URLSearchParams(location.search);
})();

const IS_LOCAL =
  typeof location === 'undefined' ||
  ['127.0.0.1', 'localhost', '::1', '[::1]', ''].includes(location.hostname) ||
  location.protocol === 'file:';

/* 默认用本地 vendor/（离线可用、国内网络也稳）；?cdn=1 切到 CDN 公共库（首次加载更快）。 */
const USE_CDN = PARAMS.get('cdn') === '1';

// QA：?count=8000 强制粒子数（1000–16000）
const FORCED_COUNT = (() => {
  if (typeof location === 'undefined') return 0;
  const n = Number(new URLSearchParams(location.search).get('count'));
  return Number.isFinite(n) && n >= 1000 ? Math.min(16000, Math.round(n)) : 0;
})();

export const CONFIG = {
  seed: 20261118,
  isMobile: IS_MOBILE,

  renderer: {
    dprMax: IS_MOBILE ? 1.25 : 1.5,
    antialias: true,
    exposure: THEME.light.exposure,
    clear: THEME.hex.ink,
    fov: 46,
    cameraZ: 9,
    near: 0.1,
    far: 120,
  },

  particles: {
    count: FORCED_COUNT || (IS_MOBILE ? 7000 : 12000),
    fallbackCount: 8000,
    radius: 1.55,
    thickness: 0.2,
    tilt: 0.98,
    spin: THEME.motion.spin,
    breatheHz: THEME.motion.breatheHz,
    breatheAmp: THEME.motion.breatheAmp,
    spinCollapse: 7.0,
    pointScale: 34.0,
    colors: {
      core: THEME.hex.paper,
      indigo: THEME.hex.indigo,
      deep: THEME.hex.deep,
      cyan: THEME.hex.cyan,
      magenta: THEME.hex.magenta,
    },
  },

  starfield: { count: 1600, radius: 34, size: 1.25 },
  dust: { count: 700, size: 1.0, spread: 9 },

  nebula: {
    z: -8.5,
    intensity: 0.5,
    centerY: -0.52,
    colorA: THEME.hex.indigo,
    colorB: THEME.hex.deep,
    colorC: THEME.hex.magenta,
    colorD: THEME.hex.cyan,
    core: THEME.hex.paper,
    drift: 0.03,
  },

  blackhole: {
    horizon: THEME.light.horizon,
    ringScale: 1.0,
    spin: 0.9,
    lensColorA: 0xe9f7ff,
    lensColorB: THEME.hex.cyan,
  },

  bloom: { ...THEME.light.bloom, supernovaBoost: THEME.light.supernovaBloom },

  hand: {
    // 跟随弹簧：k=0.12 / 阻尼 0.85（按 60Hz 步长归一化）；快速移动时刚度自动上调
    spring: { k: 0.12, damping: 0.85, kBoost: 0.22, speedRef: 9 },
    fingerFilter: { minCutoff: 1.2, beta: 0.02, dCutoff: 1.0 },
    // 1:1 跟随 + 轻微夸张
    exaggeration: 1.15,
    sizeBoost: 1.2,
    sizeRange: [0.8, 2.0],
    palmWidthFactor: 1.62,
    depthFactor: 2.4,
    lostTimeoutMs: 800,     // 丢失后保持最后姿态 0.8s
    regainMs: 200,          // 重新出现 0.2s 内插值跟上
    prediction: 0.045,      // 速度外推提前量（秒）：抵消识别延迟，快速移动更跟手
    predictionMax: 0.35,    // 外推上限（世界单位）
    skeleton: true,
    video: { width: 640, height: 360 },
    workerDelegate: 'CPU',  // Worker 内识别用的 delegate（CPU：不占主线程）
    useWorker: true,        // GPU 不可用时把 CPU 识别挪到 Worker
    watchdogMs: 2500,       // Worker 首帧无响应 → 切回主线程
    // 资源地址：本机用 vendor/（完全离线），公网分享自动走 CDN（快 5–10 倍）
    useCdn: USE_CDN,
    cdnWasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm',
    cdnModel:
      'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
    preload: false,         // 预载字节（CDN 够快时不需要）
    // 双手
    dualScale: 0.74,        // 双手时每团星系的缩放
    mergeDist: 0.80,        // 两掌心靠近到该距离 → 合并爆发
    mergeCooldownMs: 3000,
  },

  gesture: {
    open: 0.62,
    fist: 0.24,
    collapseMs: THEME.motion.collapseMs,
    releaseMs: THEME.motion.releaseMs,
    opennessLerp: 12.0,
    supernovaCooldownMs: 2000,
    // 捏合：拇指尖 4 ↔ 食指尖 8，距离 / 掌心宽度
    pinchOn: 0.30,          // 小于它开始引力透镜
    pinchOff: 0.40,         // 大于它退出
    pinchCollapse: 0.66,    // 捏合时的收缩程度（不到视界）
    pinchLens: 1.0,         // 额外的透镜环强度
    pointBoost: true,       // 单指 → 指尖星变亮变长
  },

  supernova: {
    duration: (THEME.motion.shockMs + THEME.motion.afterglowMs) / 1000,
    shockMs: THEME.motion.shockMs,
    flashMs: THEME.motion.flashMs,
    flashOpacity: 0.7,
    shockRadius: 6.4,
    burstKick: 1.0,
  },

  demo: {
    anchor: { x: 0.01, y: THEME.composition.palmY },
    scale: THEME.composition.galaxyScale,
    openMs: 2600,
    closeMs: 1300,
    fistHoldMs: 450,
    burstHoldMs: 1200,
    relaxMs: 2200,
  },

  pointer: {
    spring: { k: 0.12, damping: 0.85 },
    burstOnRelease: true,
  },

  hud: { stateIntervalMs: 90 },

  reducedMotion: false,
};

export { PALETTE } from '../src/theme.js';