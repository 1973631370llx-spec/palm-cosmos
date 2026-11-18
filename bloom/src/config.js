/**
 * config.js — 行为参数（硬性指标）。
 * 审美参数在 src/theme.js。
 *
 * 坐标约定
 * ─────────
 * 舞台是 1080×1920 的「逻辑画布」，所有几何都以逻辑像素写。
 * 花位 / 阈值以 (nx, ny) 给出：nx ∈ [0,1] 占满宽，ny ∈ [0,1] 占满高。
 * 所有**距离**按 1080 宽归一化（题面硬性要求）：
 *   metricX = px / 1080，metricY = py / 1080
 * 所以 enterR = 0.09 就是半径 0.09×1080 = 97.2px 的圆，
 * 横向「穿过三朵 x 容差 ±0.10」也直接落在 nx 上（0.10×1080 = 108px）。
 */

export const STAGE = Object.freeze({ w: 1080, h: 1920 });

/** 归一化距离（按 1080 宽）→ 逻辑像素 */
export const distToPx = (n) => n * STAGE.w;
/** 逻辑像素 → 按 1080 宽归一化的度量坐标 */
export const pxToMetric = (px) => px / STAGE.w;
/** (nx, ny) → 逻辑像素 */
export const toStage = (nx, ny) => ({ x: nx * STAGE.w, y: ny * STAGE.h });

/* ── 花位（v2：放大花朵后拉开纵向错落，避免三朵糊成一团） ───────── */
export const FLOWER_LAYOUT = Object.freeze([
  Object.freeze({ id: 0, x: 0.22, y: 0.56, scale: 0.9 }),
  Object.freeze({ id: 1, x: 0.5, y: 0.48, scale: 1.1 }),
  Object.freeze({ id: 2, x: 0.78, y: 0.6, scale: 0.85 }),
]);

/** 花位锚点（逻辑像素） */
export const FLOWER_ANCHORS = Object.freeze(
  FLOWER_LAYOUT.map((f) => Object.freeze({ x: f.x * STAGE.w, y: f.y * STAGE.h, scale: f.scale })),
);

/* ── 摄像头采集 / 识别 ───────────────────────────────────── */
export const CAMERA = Object.freeze({
  constraints: {
    video: {
      // 都是 ideal（软约束）：硬性 min/精确值在部分设备（含虚拟摄像头）会直接 OverconstrainedError
      facingMode: { ideal: 'user' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 60 },
    },
    audio: false,
  },
  // 权限/设备失败 → 2s 内进入指针模式
  fallbackDelayMs: 2000,
  // 中途设备断开：自动重试 1 次
  disconnectRetries: 1,
  // 模型加载：>12s 显示「先看无摄像头版」
  slowModelMs: 12000,
  // 环境光：平均亮度低于此值给提示（不中断体验）
  lowLightLuma: 0.06,
  brightProbeIntervalMs: 400,
});

export const HANDS = Object.freeze({
  numHands: 2,
  minHandDetectionConfidence: 0.5,
  minHandPresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
  delegate: 'GPU', // 失败自动回退 'CPU'
  delegateFallback: 'CPU',
});

/* ── 平滑（固定，不许加大） ───────────────────────────────── */
export const SMOOTH = Object.freeze({
  oneEuro: { minCutoff: 1.2, beta: 0.02, dCutoff: 1.0 },
  spring: { k: 0.1, damp: 0.88 },
  // 跟踪丢失：保持最后状态 1.2s；重新出现 0.2s 内插值跟上
  lostHold: 1.2,
  reacquire: 0.2,
  // 掌心 z → 光晕/景深微调
  zRange: 0.12,
});

/* ── 轻触累积 ─────────────────────────────────────────────── */
export const TOUCH = Object.freeze({
  enterR: 0.09, // 进入触发（归一化距离）
  exitR: 0.13, // 离开滞回
  dwell: 0.15, // 有效触摸停留
  cooldown: 0.4, // 计数冷却（且必须离开触发区）
  gapRadius: 0.09, // 距最近锚点 >0.09 即「两朵之间」，不触发
});

/* ── 绽放 / 合拢 / 保持 ──────────────────────────────────── */
export const BLOOM = Object.freeze({
  openDur: 0.9, // easeOutCubic
  closeDur: 2.5, // easeInOutCubic
  handLostBeforeClose: 1.2, // 手离开 1.2s 后才开始合拢
  closeStagger: 0.4, // 后开先合，逐朵回拢间隔
  fullHold: 4.0, // 满 3 朵保持 4s 后一起合拢归零
  fullResetDur: 0.35, // RESET 状态显示时长
});

/* ── 横抚整枝 ─────────────────────────────────────────────── */
export const SWEEP = Object.freeze({
  window: 2.4, // 时间窗 2.4s（慢慢抚也算数；掉帧的手机也来得及）
  minDistance: 0.3, // 横向位移 ≥0.30（nx）——原来 0.5 太长，很多人划不到
  monotonicTol: 0.14, // 方向单调容差（手会抖，允许小幅逆行）
  passTolX: 0.1, // 依次穿过三朵 x 容差 ±0.10
  yBand: 0.26, // y 在 ±0.26 带内（按 1080 宽归一化 ≈281px）——「大概齐平」就算，不用卡到像素
  minCross: 2, // 三朵里穿到 2 朵就触发（第 3 朵会被接近层带开）
  stagger: 0.14, // 三朵间隔 0.14s 依序开
  hold: 4.0,
  cooldown: 1.2,
});

/* ── v3：张开手抓住一朵 = 360° 转着看 ──────────────────────── */
export const GRAB = Object.freeze({
  on: 0.22, // 掌心/指尖进到这个距离（按 1080 宽归一化）→ 可抓
  off: 0.6, // 抓住后手可以移动多远（相对抓起位置）→ 超过就松爪
  dwell: 0.18, // 张开手「停在」花上多久算抓住（还要基本不动，见 main.js updateGrab）
  zoom: 1.32, // 抓住时镜头推近
  zoomDur: 0.45, // 推近用时（秒）
  yawGain: 5.2, // 手左右移动 → 绕竖轴转（弧度 / 归一化位移）
  pitchGain: 3.6, // 手上下移动 → 绕横轴转
  rollGain: 2.2, // 手掌自身转动 → 绕视线轴滚
  angleGain: 1.0, // 手掌朝向角变化的放大
  inertia: 0.9, // 松手后的惯性衰减（每帧）
  maxRate: 9.0, // 角速度上限（弧度/秒），防止甩飞
  easeBack: 2.6, // 退出后回正用时（秒）
});

/* ── 双手双端 ─────────────────────────────────────────────── */
export const DUET = Object.freeze({
  sideSplit: 1 / 3, // 左 1/3 / 右 1/3
  yMin: 0.35, // 指尖 y ∈ [0.35, 0.75]（ny 画面高）
  yMax: 0.75,
  sustain: 0.3, // 持续 0.30s 触发
  burst: 0.25, // 中间爆花
  regroup: 0.6, // 重组
  bloom: 0.9, // 绽放
  hold: 5.0,
  cooldown: 3.0,
});

/* ── 握拳收拢 ─────────────────────────────────────────────── */
export const FIST = Object.freeze({
  sustain: 0.25, // 持续 0.25s
  clearAll: 0.15, // 掌心距所有花 >0.15
  touchMute: 1.0, // 触发后 1s 内忽略轻触
  scoreOn: 0.55, // 握拳判定（滞回上沿）
  scoreOff: 0.42, // 松开（滞回下沿）
});

/* ── v2：靠近就慢慢开（连续绽放，不是"点到才开"） ────────── */
export const PROXIMITY = Object.freeze({
  near: 0.3, // 手进到这个距离（按 1080 宽归一化）→ 目标开满
  far: 0.62, // 退到这个距离 → 目标 0
  up: 0.85, // 张开用时（秒）—— 要看得见"慢慢张开"，不能一帧到位
  down: 1.6, // 收回用时（秒）—— 不能塌
  // 两只手分别靠近两朵时，第三朵被"带"着慢慢开
  trickle: 0.55, // 每秒涨多少（≈1.8s 开到满）
  trickleDecay: 0.8, // 不再满足条件时每秒退多少
  hotAt: 0.55, // 这一朵的接近度超过多少算"手在它上面"
  hold: 2.2, // 离散触发（摸/横抚/双端）后，连续层让位多少秒
});

/* ── v2：捏一下 = 释放（拇指+食指） ──────────────────────── */
export const PINCH = Object.freeze({
  on: 0.22, // 捏住判定（拇指尖↔食指尖 / 掌长）：真捏住≈0.05–0.2，放松≈0.6–0.9，握拳≈0.3–0.4
  off: 0.4, // 松开判定（滞回）
  dwell: 0.1, // 捏住要持续多久才算数
  radius: 0.26, // 生效范围：捏的位置离花心多近
  indexReach: 1.15, // 食指尖到手腕 / 掌长（握拳会缩到 ~1.1 以下）→ 再排一次握拳
  hold: 2.6,
});

/* ── v3：横滑 = 换一种花（必须张开手、离花带够远） ─────────── */
export const SWIPE = Object.freeze({
  minDist: 0.22, // 横向位移（按 1080 宽归一化）
  window: 0.7, // 时间窗（秒）
  bandGap: 0.28, // 手必须离开花带这么远才算"滑屏幕"（否则是横抚整枝）
  cooldown: 0.9,
  minExt: 3, // 至少 3 根手指伸着才算「手掌横滑」，捏着/握拳不算
});

/* ── 互斥优先级 ───────────────────────────────────────────── */
export const PRIORITY = Object.freeze(['fist', 'duet', 'sweep', 'touch']);

/* ── 视差 / 曝光 / 质量 ──────────────────────────────────── */
export const PARALLAX = Object.freeze({ ampX: 8, ampY: 4, k: 0.08, damp: 0.86 }); // 逻辑像素

export const EXPOSURE = Object.freeze({ perBloom: 0.03, max: 0.09 });

export const QUALITY = Object.freeze({
  tiers: [9000, 6000, 4500],
  perFlower: 3000,
  fpsLow: 50,
  fpsLowDur: 2.0, // 连续 2s 才降
  fpsVeryLow: 45,
  duetPeak: 12000,
  dprMax: 1.5,
});

/* ── HUD / 状态 ──────────────────────────────────────────── */
export const HUD = Object.freeze({
  debounce: 0.2, // 200ms 去抖
  stateFade: 0.32, // 状态过渡 ≥0.2s
});

/* ── 演示 / 调试 ─────────────────────────────────────────── */
export const DEMO = Object.freeze({
  // 每段 6–8s：轻触三下 → 握拳合拢 → 横抚 → 双端
  segments: [
    { kind: 'tap', dur: 7.2 },
    { kind: 'fist', dur: 6.4 },
    { kind: 'sweep', dur: 7.0 },
    { kind: 'duet', dur: 7.8 },
  ],
});

/* 状态名（F. 状态机） */
export const STATE = Object.freeze({
  STANDBY: 'STANDBY',
  CAMERA_LIVE: 'CAMERA_LIVE',
  PETTING: 'PETTING',
  LOCKED: 'LOCKED',
  RESET: 'RESET',
});

export const CONFIG = Object.freeze({
  STAGE,
  FLOWER_LAYOUT,
  FLOWER_ANCHORS,
  CAMERA,
  HANDS,
  SMOOTH,
  TOUCH,
  BLOOM,
  SWEEP,
  DUET,
  FIST,
  PROXIMITY,
  PINCH,
  SWIPE,
  GRAB,
  PRIORITY,
  PARALLAX,
  EXPOSURE,
  QUALITY,
  HUD,
  DEMO,
  STATE,
});

export default CONFIG;