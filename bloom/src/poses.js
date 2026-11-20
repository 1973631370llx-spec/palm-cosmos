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
 * v7 手语词汇表。
 *
 * 为什么只收这些：手语真正的难点在「运动轨迹 + 位置 + 表情」，摄像头只给 21 个点，
 * 动态词（谢谢=拇指点两下、你好/再见=挥手）靠单帧认不准，误触发比认不出更难受。
 * 所以这里只收**手形本身就唯一**的静态词 —— 世界通用的那批「手指字母 / 数字 / 表情手势」，
 * 每个词指头的伸缩模式都不一样，几何上互斥，认错概率极低：
 *
 *   👍 好   …… 只有拇指伸直（ASL 的 10 / 中文手语「好」「对」）
 *   🤟 爱   …… 拇指+食指+小指（ILY，国际通用「我爱你」）
 *   🤙 呼叫 …… 拇指+小指（ASL 的 Y / 打电话）
 *   ✌️ 二   …… 食指+中指（V / 胜利 / 数字 2）
 *   三      …… 食指+中指+无名指（ASL 的 W / 数字 3）
 *   👌 可以 …… 拇指食指成环 + 其余三指伸展（OK）
 *   ☝️ 你   …… 只有食指（指点 / 数字 1）
 *   🖐 停   …… 五指全开（手掌 / 数字 5）
 *   ✊ 收   …… 握拳（数字 0 / 收拢）
 *   L 半    …… 拇指+食指成直角（ASL 字母 L）
 *
 * name 是屏幕上给人看的词，hint 是「怎么比」。场景按 id 挂动作。
 */
export const SIGN = Object.freeze({
  THUMB_UP: 'thumbUp',
  ILY: 'ily',
  SHAKA: 'shaka',
  V: 'v',
  THREE: 'three',
  OK: 'ok',
  POINT: 'point',
  OPEN: 'open',
  FIST: 'fist',
});

/** 屏幕文案：icon 用 emoji（手机上自带字形，不依赖字体图标） */
export const SIGN_VOCAB = Object.freeze({
  [SIGN.THUMB_UP]: { icon: '👍', name: '好', hint: '只竖大拇指' },
  [SIGN.ILY]: { icon: '🤟', name: '爱你', hint: '拇指+食指+小指' },
  [SIGN.SHAKA]: { icon: '🤙', name: '呼叫', hint: '拇指+小指' },
  [SIGN.V]: { icon: '✌️', name: '二', hint: '食指+中指' },
  [SIGN.THREE]: { icon: '🖖', name: '三', hint: '食中无名三指' },
  [SIGN.OK]: { icon: '👌', name: '可以', hint: '拇指食指成环' },
  [SIGN.POINT]: { icon: '☝️', name: '一', hint: '只伸食指' },
  [SIGN.OPEN]: { icon: '🖐', name: '停', hint: '五指张开' },
  [SIGN.FIST]: { icon: '✊', name: '收', hint: '握拳' },
  [SIGN.L]: { icon: 'ℒ', name: 'L', hint: '拇指食指成直角' },
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
    sign: null,
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
 *   pose: string,            // POSE 之一\n *   sign: string|null,       // SIGN 之一（手语词），认不出为 null
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

  // ── 手语词（v7）────────────────────────────────────────────
  // 只认「手指伸缩模式唯一」的静态手形，因此判定就是查表 + 两条附加几何约束：
  //   ① 拇指伸直与否已由 ext[0] 给出（靠掌轴侧向距离，握拳时必为 false）；
  //   ② 「L」和「捏」都只有拇指+食指伸展，用 pinchRatio 分开：
  //      成环时两指尖几乎重合（<0.22），成直角时张开（>0.35）。
  const t = ext[0];
  const i = ext[1];
  const m = ext[2];
  const r = ext[3];
  const p = ext[4];
  let sign = null;
  // 捏合是「动作」不是「词」：捏住时不给 sign，免得场景把捏当成点按以外的词
  if (pinch) sign = null;
  else if (okRing) sign = SIGN.OK;
  else if (t && !i && !m && !r && !p) sign = SIGN.THUMB_UP;
  else if (t && i && !m && !r && p) sign = SIGN.ILY;
  else if (t && !i && !m && !r && p) sign = SIGN.SHAKA;
  else if (!t && i && m && !r && !p) sign = SIGN.V;
  else if (!t && i && m && r && !p) sign = SIGN.THREE;
  // ☝️ 不收「拇指必须收着」这条：真人指点时拇指多半半开着，收着这条会让「一」认不出来。
  // 单独的食指已经在前面排除了捏合（pinch 提前返回），所以放宽不会跟别的词撞。
  else if (i && !m && !r && !p) sign = SIGN.POINT;
  else if (nExt === 5) sign = SIGN.OPEN;
  else if (nExt === 0) sign = SIGN.FIST;

  // ── 朝向 / 张开度 ───────────────────────────────────────────
  const angle = Math.atan2(
    landmarks[L.PINKY_MCP].y - landmarks[L.INDEX_MCP].y,
    landmarks[L.PINKY_MCP].x - landmarks[L.INDEX_MCP].x,
  );

  let radiusSum = 0;
  for (const t of TIPS) radiusSum += dist2(landmarks[t], palm) / size;
  const meanRadius = radiusSum / TIPS.length;
  const spread = clamp01((meanRadius - TUNING.SPREAD_MIN) / (TUNING.SPREAD_MAX - TUNING.SPREAD_MIN));

  return { pose, sign, nExt, ext, pinch, pinchRatio, palm, size, angle, spread };
}

/**
 * v7 手语「稳定保持」判定器（平台和花的场景共用一套，免得两边手感不一样）。
 *
 * 一只手比出同一个词、稳定保持 `hold` 秒才算「比出来了」，然后回调一次。
 * · 为什么要 hold：从张开手换成任何手形，中间必然经过一堆过渡手形
 *   （收手指的过程中会短暂像「三」、像「L」），单帧触发会乱开特效。
 * · 为什么 0.4 秒：比手语停住一个手形的自然时长就是 0.3–0.6 秒。
 * · 一直比着同一个词不重复触发；手形消失后重新计，所以同一个词可以连着用。
 */
export function createSignTracker(onSign, { hold = 0.4 } = {}) {
  // 用**墙上时间**而不是累加 dt：低帧率设备（手机省电模式、SwiftShader 软渲染）
  // 每帧 dt 会被引擎夹到上限，累加 dt 会让 0.4 秒变成 1.2 秒，
  // 人就以为「比了没反应」。这里只关心「同一个手形在真实时间里持续了多久」。
  const clock = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  let now = null;
  let since = 0;
  let fired = null;
  let missingSince = 0;
  return {
    update(dt, hands) {
      let sign = null;
      let slot = 0;
      for (const h of hands || []) {
        const s = h && h.pose && h.pose.sign;
        if (s) {
          sign = s;
          slot = h.slot || 0;
          break;
        }
      }
      const t = clock();
      if (!sign) {
        now = null;
        since = 0;
        // 手形消失超过 0.25 秒才「重新上膛」：真松手能再比一次，
        // 而识别单帧抖动不会让同一个词连触两次（0.25 秒短于人的反应，长于一帧抖动）。
        if (!missingSince) missingSince = t;
        if (t - missingSince > 250) fired = null;
        return null;
      }
      missingSince = 0;
      if (sign !== now) {
        now = sign;
        since = t;
      }
      if (t - since < hold * 1000 || fired === sign) return null;
      fired = sign;
      if (onSign) onSign(sign, slot);
      return sign;
    },
    /** 正在比、还没到 hold 的词（HUD 可以显示「再稳一下…」） */
    peek() {
      const held = now ? Math.max(0, (clock() - since) / 1000) : 0;
      return { sign: now, held };
    },
    reset() {
      now = null;
      since = 0;
      fired = null;
      missingSince = 0;
    },
  };
}

export default { POSE, SIGN, SIGN_VOCAB, TUNING, palmSize, classifyPose };