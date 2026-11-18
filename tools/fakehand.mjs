/**
 * fakehand.js — 合成手（假 landmark），给测试和降级模式用。
 *
 * 几何模型：掌 + 五指骨链，按 pose 施加「弯指 / 张指 / 拇指外展」，
 * 再旋转、缩放、平移到归一化图像坐标。与 gestures.js 完全独立实现，
 * 所以拿它来测手势规则是有意义的（不是自己验自己）。
 */

const D2R = Math.PI / 180;

// 局部坐标：x 向右，y 向上，腕为原点；掌宽 |mcp5 - mcp17| ≈ 0.51
const BASE = [
  [0.0, 0.0],                                               // 0 wrist
  [0.27, 0.16], [0.42, 0.33], [0.51, 0.50], [0.57, 0.66],   // 1-4 thumb (CMC/MCP/IP/TIP)
  [0.24, 0.63], [0.25, 0.87], [0.25, 1.00], [0.25, 1.10],   // 5-8 index
  [0.07, 0.66], [0.07, 0.94], [0.07, 1.07], [0.07, 1.17],   // 9-12 middle
  [-0.11, 0.63], [-0.11, 0.88], [-0.11, 1.00], [-0.11, 1.10], // 13-16 ring
  [-0.27, 0.56], [-0.29, 0.75], [-0.30, 0.85], [-0.31, 0.93], // 17-20 pinky
];

const CHAINS = {
  thumb: [1, 2, 3, 4],
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};

const LEN = {};
for (const [name, chain] of Object.entries(CHAINS)) {
  LEN[name] = [];
  for (let i = 1; i < chain.length; i += 1) {
    const a = BASE[chain[i - 1]], b = BASE[chain[i]];
    LEN[name].push(Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
}

const PALM = [0.0, 0.52];

/** 每个手型：curl（0 伸 / 1 弯到底），spread（食指↔中指张开），thumbOut（拇指外展）。 */
export const POSE_SPECS = Object.freeze({
  EAGLE: { curl: [0, 0, 0, 0, 0], spread: 0.55, thumbOut: 1.0 },
  WOLF: { curl: [0.5, 0, 0, 1, 1], spread: 0.0, thumbOut: 0.3 },
  RABBIT: { curl: [0.5, 0, 0, 1, 1], spread: 1.0, thumbOut: 0.35 },
  DEER: { curl: [0, 0, 1, 1, 1], spread: 0.25, thumbOut: 1.0 },
  FIST: { curl: [1, 1, 1, 1, 1], spread: 0, thumbOut: 0.0 },
  OPEN: { curl: [0, 0, 0, 0, 0], spread: 0.2, thumbOut: 1.0 },
  POINT: { curl: [0, 0, 1, 1, 1], spread: 0, thumbOut: 0.9 },
});

const norm = (v) => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};

function rotate(v, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
}

/** 把方向 dir 朝 target 转最多 theta 弧度。 */
function rotateToward(dir, target, theta) {
  if (theta <= 0) return dir;
  const a0 = Math.atan2(dir[1], dir[0]);
  const a1 = Math.atan2(target[1], target[0]);
  let d = a1 - a0;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  const step = Math.min(Math.abs(d), theta) * Math.sign(d);
  return rotate(dir, step);
}

const toward = (from, to) => norm([to[0] - from[0], to[1] - from[1]]);

/**
 * 生成一副手。
 * @param {string|object} pose POSE_SPECS 里的名字，或自定义 spec
 * @param {{aspect?:number, scale?:number, center?:{x:number,y:number}, rotation?:number, wrist?:[number,number]}} opts
 * @returns {Array<{x:number,y:number,z:number}>} 21 点归一化图像坐标
 */
export function makeHand(pose = 'EAGLE', opts = {}) {
  const spec = typeof pose === 'string' ? POSE_SPECS[pose] || POSE_SPECS.EAGLE : pose;
  const aspect = opts.aspect || 1;
  // scale：1 米制单位（掌宽 0.51）对应的归一化高度
  const scale = opts.scale ?? 0.5;
  const center = opts.center || { x: 0.5, y: 0.86 };
  const rot = (opts.rotation ?? 0) * D2R;

  const pts = BASE.map(([x, y]) => [x, y]);

  // ── 拇指：整条链绕 CMC 外展 / 内收 ──
  {
    const chain = CHAINS.thumb;
    const base = pts[chain[0]];
    const palmDir = toward(base, PALM);
    const baseDir = toward(pts[chain[0]], pts[chain[1]]);
    let dir = rotateToward(baseDir, palmDir, (1 - spec.thumbOut) * 1.45);
    dir = rotateToward(dir, palmDir, (spec.curl[0] ?? 0) * 0.45);
    for (let i = 1; i < chain.length; i += 1) {
      const prev = pts[chain[i - 1]];
      const len = LEN.thumb[i - 1] * (1 - 0.1 * (spec.curl[0] ?? 0));
      pts[chain[i]] = [prev[0] + dir[0] * len, prev[1] + dir[1] * len];
      if (i >= 2) {
        dir = rotateToward(dir, toward(prev, PALM), (spec.curl[0] ?? 0) * 0.6);
      }
    }
  }

  // ── 四指：张开角 + 逐节朝掌心弯 ──
  const names = ['index', 'middle', 'ring', 'pinky'];
  names.forEach((name, fi) => {
    const chain = CHAINS[name];
    const curl = spec.curl[fi + 1] ?? 0;
    const spreadRad = (name === 'index' ? -1 : name === 'middle' ? 1 : 0) * spec.spread * 18 * D2R;
    const baseDir = rotate(toward(pts[chain[0]], pts[chain[1]]), spreadRad);
    let dir = baseDir;
    for (let i = 1; i < chain.length; i += 1) {
      const prev = pts[chain[i - 1]];
      if (i > 1) dir = rotateToward(dir, toward(prev, PALM), curl * 1.15);
      const len = LEN[name][i - 1] * (1 - 0.13 * curl);
      pts[chain[i]] = [prev[0] + dir[0] * len, prev[1] + dir[1] * len];
    }
  });

  // ── 放到图像坐标：旋转 → 缩放 → y 翻转 → 平移到 center（x 回到归一化要除以 aspect） ──
  const cos = Math.cos(rot), sin = Math.sin(rot);
  return pts.map(([x, y]) => {
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    return {
      x: (center.x * aspect + rx * scale) / aspect,
      y: center.y - ry * scale,
      z: 0,
    };
  });
}

export default makeHand;