/**
 * poses.js — 姿态分类器（纯逻辑，零依赖，不 import three）。
 *
 * 输入：hands.js `activeHands()` 里的一只手 —— 关键是 `hand.landmarks`，
 * 21 个 **舞台逻辑像素** 点（1080×1920，y 向下）。已由 `landmarksToStage` 做过
 * `x*1080`（并镜像 `1-x`）/ `y*1920` 换算，**不是** 0–1 归一化坐标。
 *
 * 所有判定只用「两点距离 / 掌心尺寸」，因此：
 *   · 离摄像头远近（整体尺寸 ×0.45 / ×1.8）不影响结果；
 *   · 左右手镜像（x → 1080-x）不影响结果（本模块完全不看 handedness）；
 *   · 手在画面里旋转不影响结果（距离对旋转不变，掌心中心随手腕旋转）。
 *
 * 阈值来自实测（见 tools/test-poses.mjs 打印的范围表）：
 *   夹具 OPEN  pinch≈0.80  nExt=5     夹具 PINCH pinch≈0.12  nExt=1
 *   夹具 POINT pinch≈0.57  nExt=2     夹具 FIST  pinch≈0.25  nExt=0
 * 握拳的拇指尖本来就落在食指尖附近（≈0.25 掌长），所以 pinch 必须同时要求食指伸直，
 * 否则「握拳」会被判成「捏」——这条是硬要求，测试里有专门的回归用例。
 *
 * 坐标索引同 MediaPipe / hands.js 的 LM 表（这里重新写一份，保持本模块独立）。
 */

/** MediaPipe 21 点索引（与 hands.js 的 LM 一致，此处独立定义以免引入依赖） */
const L = Object.freeze({
  WRIST: 0,
  THUMB_MCP: 2,
  THUMB_PIP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_TIP: 20,
});

export const POSE = Object.freeze({
  OPEN: 'open',
  POINT: 'point',
  PINCH: 'pinch',
  FIST: 'fist',
  OK: 'ok', // v4.2：拇指食指成环、其余三指伸展 → 画面圆环
  VICTORY: 'v', // v4.2：食指中指伸展（耶 / 叶）→ 画面叶子
  OTHER: 'other',
});

/**
 * 判定常数。都是「除以 palmSize 之后」的无量纲量，可以按实测安全地调。
 * 每个值后面写的是夹具实测余量（详见测试里的范围表）。
 */
export const TUNING = Object.freeze({
  // 四指伸直：指尖到腕距离 / PIP 到腕距离 ≥ 此值。
  // 夹具：伸直 1.243–1.278 / 弯曲 0.847–0.886 → 1.05 两侧各留 ≥0.16。
  EXT_RATIO: 1.05,
  // 拇指伸直：拇指尖到「腕→中指 MCP 这条掌轴」的垂距 / palmSize ≥ 此值。
  // 拇指链太短（「指尖/关节离腕」比值在所有姿态里都≈1.25–1.34，零区分度），
  // 而且拇指是**横向**合拢的：伸直 = 甩到掌轴侧面，握拳 = 压回掌轴上方。
  // 夹具实测 lateral：OPEN 0.507 / POINT 0.248 / FIST 0.094；把拳头的拇指尖人为
  // 按到食指尖/PIP/DIP/中指 PIP 上也只有 0.020–0.135 → 0.22 偏向「不算伸直」，
  // 这样「握拳被判成别的东西」的风险最小（nExt==0 是 FIST 的唯一定义）。
  THUMB_LATERAL: 0.22,
  // 捏住：拇指尖↔食指尖 / palmSize < 此值（且食指必须伸直）。
  // 夹具 PINCH 0.117 / FIST 0.248 → 0.22 两边各留 ~47% / ~13%。
  PINCH_ON: 0.22,
  // OPEN 的下限：nExt ≥ 4 且 pinchRatio ≥ 此值（和 PINCH 之间留死区，避免边界抖动）。
  OPEN_PINCH_MIN: 0.28,
  // POINT 的下限：只有食指伸直，且 pinchRatio ≥ 此值。
  POINT_PINCH_MIN: 0.3,
  // spread 映射区间：五指「指尖到掌心」归一化半径均值 0.5 → 0，1.25 → 1。
  // 夹具实测：FIST 0.557 / POINT 0.729 / PINCH 0.836 / OPEN 1.049。
  SPREAD_MIN: 0.5,
  SPREAD_MAX: 1.25,
});

const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 点到直线 (a→b) 的垂距 */
function lineDistance(p, a, b) {
  const len = dist2(a, b);
  if (!(len > 1e-6)) return 0;
  return Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len;
}

/** 四指：[指尖, PIP] */
const FINGER_JOINTS = Object.freeze([
  [L.INDEX_TIP, L.INDEX_PIP],
  [L.MIDDLE_TIP, L.MIDDLE_PIP],
  [L.RING_TIP, L.RING_PIP],
  [L.PINKY_TIP, L.PINKY_PIP],
]);

/** 五个指尖（拇指在前，与 ext[] 顺序一致） */
const TIPS = Object.freeze([L.THUMB_TIP, L.INDEX_TIP, L.MIDDLE_TIP, L.RING_TIP, L.PINKY_TIP]);

/**
 * 掌心尺寸：腕 → 中指 MCP 的 2D 距离（逻辑像素）。所有距离都用它归一化。
 * @param {Array<{x:number,y:number}>} landmarks 舞台像素坐标
 * @returns {number} 0 表示数据不可用
 */
export function palmSize(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 21) return 0;
  const a = landmarks[L.WRIST];
  const b = landmarks[L.MIDDLE_MCP];
  if (!a || !b) return 0;
  const d = dist2(a, b);
  return Number.isFinite(d) ? d : 0;
}

/** 用到的点：腕、拇指尖、食指 MCP/PIP/尖、中指 MCP/PIP/尖、无名指 MCP/PIP/尖、小指 MCP/PIP/尖 */
const NEEDED = Object.freeze([0, 4, 5, 6, 8, 9, 10, 12, 13, 14, 16, 17, 18, 20]);

const pointOk = (p) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

/** 退化输出：字段齐全，UI 不用做空判断 */
function degraded(size = 0) {
  return {
    pose: POSE.OTHER,
    nExt: 0,
    ext: [false, false, false, false, false],
    pinch: false,
    pinchRatio: Infinity,
    palm: { x: 0, y: 0 },
    size,
    angle: 0,
    spread: 0,
  };
}

/**
 * 分类一只手的姿态。
 * @param {{landmarks?:Array<{x:number,y:number,z?:number}>, handedness?:string}} hand
 *   hand.landmarks 必须是舞台像素（见 hands.js landmarksToStage）。handedness 不参与判定。
 * @returns {{
 *   pose: string,            // POSE 之一
 *   nExt: number,            // 伸直的手指根数 0..5（含拇指，顺序 拇指/食/中/无名/小指）
 *   ext: boolean[],          // 5 项：拇指、食指、中指、无名指、小指
 *   pinch: boolean,          // 拇指尖↔食指尖算「捏住」（已排除握拳）
 *   pinchRatio: number,      // 拇指尖↔食指尖 / palmSize（没数据 → Infinity）
 *   palm: {x:number,y:number}, // 掌心中点 = (腕 + 中指 MCP)/2
 *   size: number,            // palmSize
 *   angle: number,           // 手掌朝向：食指 MCP → 小指 MCP 的 atan2（弧度，舞台坐标 y 向下）
 *   spread: number,          // 五指张开程度 0..1
 * }}
 */
export function classifyPose(hand) {
  const landmarks = hand && hand.landmarks;
  if (!Array.isArray(landmarks) || landmarks.length < 21) return degraded();
  // 稀疏数组 / 缺点 / 坐标是 NaN：宁可给 OTHER，也不要抛异常或输出 NaN
  for (const i of NEEDED) {
    if (!pointOk(landmarks[i])) return degraded();
  }

  const wrist = landmarks[L.WRIST];
  const midMcp = landmarks[L.MIDDLE_MCP];
  const size = palmSize(landmarks);
  // 掌心尺寸为 0 / NaN（21 点全重合、坐标坏了）→ 一切比值都没意义
  if (!(size > 1e-6)) return degraded(0);

  const palm = { x: (wrist.x + midMcp.x) / 2, y: (wrist.y + midMcp.y) / 2 };

  // ── 每根手指是否伸直 ────────────────────────────────────────
  const ext = [false, false, false, false, false];
  // 拇指：指尖离开掌轴多远（拇指是横向合拢的，见 TUNING.THUMB_LATERAL）
  ext[0] = lineDistance(landmarks[L.THUMB_TIP], wrist, midMcp) / size >= TUNING.THUMB_LATERAL;
  // 四指：指尖-腕 / PIP-腕（伸直时指尖一定比 PIP 更远；卷回掌心时反过来）
  for (let i = 0; i < FINGER_JOINTS.length; i += 1) {
    const [tipIdx, pipIdx] = FINGER_JOINTS[i];
    const tip = landmarks[tipIdx];
    const pip = landmarks[pipIdx];
    if (!tip || !pip) continue;
    const pipReach = dist2(pip, wrist);
    if (!(pipReach > 1e-6)) continue;
    ext[i + 1] = dist2(tip, wrist) / pipReach >= TUNING.EXT_RATIO;
  }
  const nExt = ext.reduce((n, e) => n + (e ? 1 : 0), 0);

  // ── 捏住 ───────────────────────────────────────────────────
  const pinchRatio = dist2(landmarks[L.THUMB_TIP], landmarks[L.INDEX_TIP]) / size;
  // 关键：要求食指伸直。握拳时拇指尖也会贴近卷回来的食指尖（夹具 0.248，
  // 真手更近），只比值小就判捏 = 握拳必误判成捏。食指伸直与否才是分界线。
  const pinch = pinchRatio < TUNING.PINCH_ON && ext[1];

  // ── 姿态 ──────────────────────────────────────────────────
  // v4.2 新增两种「能出图案」的手势，判定放在 pinch 之前：
  //   OK  = 拇指尖贴食指尖（pinchRatio 小）且中指/无名/小指都伸展 → 环
  //   V   = 食指+中指伸展、无名+小指收起 → 耶 / 叶
  const ringFingers = ext[2] && ext[3] && ext[4];
  const okRing = pinchRatio < TUNING.PINCH_ON && ringFingers;
  const victory = ext[1] && ext[2] && !ext[3] && !ext[4];

  let pose = POSE.OTHER;
  if (nExt === 0) {
    pose = POSE.FIST;
  } else if (okRing) {
    pose = POSE.OK;
  } else if (pinch) {
    pose = POSE.PINCH;
  } else if (victory) {
    pose = POSE.VICTORY;
  } else if (nExt >= 4 && pinchRatio >= TUNING.OPEN_PINCH_MIN) {
    pose = POSE.OPEN;
  } else if (ext[1] && !ext[2] && !ext[3] && !ext[4] && pinchRatio >= TUNING.POINT_PINCH_MIN) {
    pose = POSE.POINT;
  }

  // ── 朝向 / 张开度 ───────────────────────────────────────────
  const angle = Math.atan2(
    landmarks[L.PINKY_MCP].y - landmarks[L.INDEX_MCP].y,
    landmarks[L.PINKY_MCP].x - landmarks[L.INDEX_MCP].x,
  );

  let radiusSum = 0;
  for (const t of TIPS) radiusSum += dist2(landmarks[t], palm) / size;
  const meanRadius = radiusSum / TIPS.length;
  const spread = clamp01((meanRadius - TUNING.SPREAD_MIN) / (TUNING.SPREAD_MAX - TUNING.SPREAD_MIN));

  return { pose, nExt, ext, pinch, pinchRatio, palm, size, angle, spread };
}

export default { POSE, TUNING, palmSize, classifyPose };