/**
 * handskeleton.js — 手部骨架叠层（Canvas 2D，零依赖，不 import three.js）。
 *
 * 画的是「识别器眼里的那只手」：MediaPipe 21 点连线 + 关节小点 + 4↔8 捏合环。
 * 风格延续暗夜温室：细线、小点、微弱珊瑚 / 月白发光；没有彩虹、没有粗霓虹、
 * 没有 Debug 绿线。颜色只从 theme.js 的 COLOR 里取。
 *
 * 单位：内部一律用「CSS 像素」（构造函数里按 dpr 给 ctx 设 transform），
 * 所以线宽 / 半径在任何屏幕上读数一致；屏幕像素由 project() 换算，这里不猜映射。
 *
 * 亮度预算：所有发光层共享一个 gain，保证「单只手、任一帧、同一点」叠加等效
 * 不透明度 ≤ LIGHT_BUDGET（0.7），不会糊成白团。gain 每帧由常量算一次。
 *
 * 分配策略：21 点坐标 / 有效性 / 拖尾全部是构造期预分配的 TypedArray；
 * 颜色是模块加载期预生成的 rgb() 字符串；render() 里不 new、不拼字符串。
 */

import { COLOR } from './theme.js';

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/* ══════════════════════════════════════════════════════════════════════
 * 一、骨骼拓扑（MediaPipe HAND_CONNECTIONS 的 21 段）
 * 扁平 Int8Array：render 里只读下标，不解构、不产生临时数组。
 * ══════════════════════════════════════════════════════════════════════ */

const LINK_COUNT = 21;
const LINKS = new Int8Array([
  0, 1, 1, 2, 2, 3, 3, 4, // 拇指
  0, 5, 5, 6, 6, 7, 7, 8, // 食指
  5, 9, 9, 10, 10, 11, 11, 12, // 中指
  9, 13, 13, 14, 14, 15, 15, 16, // 无名指
  13, 17, 17, 18, 18, 19, 19, 20, // 小指
  0, 17, // 掌侧
]);

/** 每段骨的权重：越靠指尖越大（亮度 + 那一点点加粗都从它来） */
const LINK_GAIN = new Float32Array([
  0.86, 0.94, 1.04, 1.14, // 拇指 0-1-2-3-4
  0.84, 0.92, 1.02, 1.18, // 食指（指尖是主角）
  0.82, 0.9, 1.0, 1.1, // 中指
  0.8, 0.88, 0.98, 1.08, // 无名指
  0.76, 0.84, 0.94, 1.02, // 小指
  0.66, // 0-17 掌侧（最暗，压住手掌的"框"感）
]);

/* ══════════════════════════════════════════════════════════════════════
 * 二、样式常量（全部 CSS px / 0–1 系数）
 * ══════════════════════════════════════════════════════════════════════ */

export const SKELETON_STYLE = Object.freeze({
  // 骨骼线：细，指尖略粗，握拳再粗一丁点 → 1.0–1.54 CSS px
  boneW: 1.0,
  boneWTip: 0.34, // 指尖相对腕部的加粗量
  fistW: 0.2, // 握拳额外加粗
  boneA: 0.24, // 主线基础不透明度（乘 link 亮度系数 0.72–1.0）
  linkAFloor: 0.72,
  linkASpan: 0.28,
  // 关节小点（直径 1.56–2.48 CSS px）
  dotR: 0.78, // 普通关节半径
  dotRTip: 0.95, // 其余指尖
  dotRAccent: 1.15, // 腕 0 / 拇指尖 4 / 食指尖 8
  dotA: 0.22,
  dotAAccent: 0.34,
  // 微光（lighter 一层，压得很低）
  glowW: 5.2,
  glowA: 0.05,
  glowHaloR: 5.4,
  glowHaloBoost: 1.3, // 三个强调点的软光比线略强
  glowGlowMul: 0.42, // 捏合环的微光相对环实线的倍数
  // 待机（held：手已离开画面，位置是旧值）
  heldA: 0.35,
  // 捏合环
  ringW: 1.15,
  ringAFar: 0.1,
  ringANear: 0.26,
  ringR: [9, 32], // 捏住 → 9px，张开 → 32px（再按手的大小缩一点）
  ringPalmRef: 300, // 手越大环越大：palmPx / 300，夹到 0.8–1.7
  ringSizeClamp: [0.8, 1.7],
  pinchRatioNear: 0.18, // |4-8| / |0-9| ≤ 0.18 → 完全捏住
  pinchRatioFar: 0.85, // ≥ 0.85 → 完全张开
  ringGoldA: 0.22, // 捏紧时环心那一点暖金
  // 拖尾（指尖 8 的极短历史）
  trailN: 7,
  trailA: 0.09,
  trailR: [1.5, 0.5],
  trailJump: 140, // 位置跳变（换手 / 重捕）→ 拖尾断开
  // 亮度预算：单只手同一点的最坏叠加上限
  budget: 0.7,
});

const RAMP_STEPS = 24; // fist 0→1 的色阶数（24 阶肉眼看不出台阶）
const RING_OVERLAP = 0.5; // 环只可能擦过关节点的边缘，预算里按一半计入
/** 抓花外圈的颜色（月白，比骨架的线更暗一档，别抢主体） */
const GRAB_RING_COLOR = 'rgb(184, 198, 255)';
const TRAIL_N = SKELETON_STYLE.trailN;
const TRAIL_JUMP_SQ = SKELETON_STYLE.trailJump * SKELETON_STYLE.trailJump;
const TRAIL_MIN_MOVE_SQ = 0.36; // 指尖移动 < 0.6px 就不记新点

/* ══════════════════════════════════════════════════════════════════════
 * 三、颜色：模块加载期一次性生成 rgb() 字符串
 *   render 里只按下标取字符串 + 用 globalAlpha 做连续的淡入淡出，
 *   避免每帧拼 rgba() 字符串（既省 GC 也省 parse）。
 * ══════════════════════════════════════════════════════════════════════ */

const hexToRgb = (hex) => {
  const h = String(hex).replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const cssRgb = (r, g, b) => `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;

function ramp(fromHex, toHex, steps) {
  const a = hexToRgb(fromHex);
  const b = hexToRgb(toHex);
  const out = new Array(steps);
  for (let i = 0; i < steps; i += 1) {
    const t = steps > 1 ? i / (steps - 1) : 0;
    out[i] = cssRgb(lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t));
  }
  return Object.freeze(out);
}

/** 张开 → 月白；握拳 → 珊瑚粉（theme.js 的 moon / coral） */
const BONE_RAMP = ramp(COLOR.moon, COLOR.coral, RAMP_STEPS);
/** 关节 / 强调点：比线更白（core），握拳同样偏珊瑚 */
const DOT_RAMP = ramp(COLOR.core, COLOR.coral, RAMP_STEPS);
/** 捏合环：张开是冷月白淡环，捏住是暖白亮环 */
const RING_RAMP = ramp(COLOR.moon, COLOR.core, RAMP_STEPS);
/** 捏紧瞬间的那一下暖金点（theme.js 的 gold，用量极少） */
const GOLD = cssRgb(...hexToRgb(COLOR.gold));

/* ══════════════════════════════════════════════════════════════════════
 * 四、每只手的预分配状态
 * ══════════════════════════════════════════════════════════════════════ */

/** 21 点的 CSS 坐标（x,y 交叉存放）+ 有效性 + 指尖拖尾环形缓冲 */
function newSlot() {
  return {
    xy: new Float32Array(42),
    ok: new Uint8Array(21),
    trail: new Float32Array(TRAIL_N * 2),
    trailHead: 0,
    trailN: 0,
    lastX: 0,
    lastY: 0,
    primed: false,
  };
}

/** render 的第三参缺省值（避免每帧 ?? {}） */
const NO_FRAME = Object.freeze({});

/* ══════════════════════════════════════════════════════════════════════
 * 五、类
 * ══════════════════════════════════════════════════════════════════════ */

export class HandSkeleton {
  /**
   * @param {HTMLCanvasElement} canvas 已 position:fixed / pointer-events:none 的 2D 画布
   * @param {{maxHands?:number, glow?:boolean, trail?:boolean}} opts
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas || null;
    this.ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d', { alpha: true }) : null;
    const o = opts || {};
    this.maxHands = Math.max(1, Math.min(2, o.maxHands ?? 2));
    this.glowEnabled = o.glow !== false;
    this.trailEnabled = o.trail !== false;

    this.cssW = 0;
    this.cssH = 0;
    this.dpr = 1;

    // 每只手一套数组，构造期分配好，render 只覆盖写
    this.slots = [];
    for (let i = 0; i < this.maxHands; i += 1) this.slots.push(newSlot());

    /** 只读诊断：本帧画了几只手 / 预算 gain / 最坏叠加峰值 */
    this.stats = { hands: 0, gain: 1, peak: 0 };
  }

  /**
   * 视口尺寸变化 / dpr 变化时调用（内部记住两者，并按 dpr 设内部像素尺寸）。
   * @param {number} cssW CSS 宽
   * @param {number} cssH CSS 高
   * @param {number} dpr  devicePixelRatio
   */
  resize(cssW, cssH, dpr = 1) {
    const w = Math.max(1, Math.round(Number.isFinite(cssW) && cssW > 0 ? cssW : 1));
    const h = Math.max(1, Math.round(Number.isFinite(cssH) && cssH > 0 ? cssH : 1));
    const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    this.cssW = w;
    this.cssH = h;
    this.dpr = d;
    if (this.canvas) {
      const pw = Math.max(1, Math.round(w * d));
      const ph = Math.max(1, Math.round(h * d));
      if (this.canvas.width !== pw) this.canvas.width = pw;
      if (this.canvas.height !== ph) this.canvas.height = ph;
    }
    if (this.ctx) this.ctx.setTransform(d, 0, 0, d, 0, 0);
    return this;
  }

  /** 清空整块画布（按设备像素清，resize 没同步时也不会留残影） */
  clear() {
    const ctx = this.ctx;
    if (!ctx || !this.canvas) return this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.stats.hands = 0;
    return this;
  }

  /**
   * 每帧调用。
   * @param {Array<{tip:{x:number,y:number}, palm:{x:number,y:number}, fist:number, held:boolean,
   *   landmarks:Array<{x:number,y:number,z?:number}>}>} hands 舞台逻辑坐标（1080×1920，已镜像）
   * @param {{project:(p:{x:number,y:number})=>{x:number,y:number}, time?:number, opacity?:number}} frame
   */
  render(hands, frame = NO_FRAME) {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return this;

    const f = frame || NO_FRAME;
    const project = f.project;
    const time = Number.isFinite(f.time) ? f.time : 0;
    const opacity = Number.isFinite(f.opacity) ? clamp01(f.opacity) : 1;
    const grabRing = f.grabRing || null;

    // 安全退出：没手 / 没映射 / 整体透明 → 清空
    if (
      (!Array.isArray(hands) || hands.length === 0) &&
      !grabRing
    ) {
      this.clear();
      return this;
    }
    if (typeof project !== 'function') {
      this.clear();
      return this;
    }
    if (opacity <= 0.002) {
      this.clear();
      return this;
    }
    if (!Array.isArray(hands)) hands = [];

    const dpr = this.dpr || 1;

    // ── 清帧 + 通用状态（线宽/颜色每段再改，lineCap/Join 不变）──────
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // ── 亮度预算：同一点最坏叠加 ≤ 0.7 ─────────────────────────────
    // 关节处 2–3 条骨线本来就互相压着，所以骨线按 3 层合算；
    // 微光 / 强调点 / 环（实线+微光+捏紧金点）/ 拖尾 再叠上去，
    // 用「1-∏(1-a)」估等效不透明度，超过 0.7 就让 gain 整体压回去。
    const st = SKELETON_STYLE;
    const glowMax = Math.max(st.glowA, st.glowA * st.glowHaloBoost);
    const boneStack = 1 - Math.pow(1 - st.boneA, 3);
    const ringMax = (st.ringANear * (1 + st.glowGlowMul) + st.ringGoldA) * RING_OVERLAP;
    const peak = 1 - (1 - glowMax) * (1 - boneStack) * (1 - st.dotAAccent) * (1 - ringMax) * (1 - st.trailA);
    const gain = Math.min(1, st.budget / peak);

    let drawn = 0;
    const n = Math.min(hands.length, this.slots.length);
    for (let hi = 0; hi < n; hi += 1) {
      const hand = hands[hi];
      if (!hand) continue;
      const lms = hand.landmarks;
      if (!lms || lms.length < 21) continue;

      const slot = this.slots[hi];
      // ── 投影：一律走调用方的 project（舞台坐标 → CSS 像素）──────
      let valid = 0;
      for (let i = 0; i < 21; i += 1) {
        const lm = lms[i];
        if (!lm) {
          slot.ok[i] = 0;
          continue;
        }
        const p = project(lm);
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
          slot.ok[i] = 0;
          continue;
        }
        slot.xy[i * 2] = p.x;
        slot.xy[i * 2 + 1] = p.y;
        slot.ok[i] = 1;
        valid += 1;
      }
      if (valid < 2) continue;

      this.drawHand(ctx, hand, slot, hi, time, opacity, gain);
      drawn += 1;
    }

    this.stats.hands = drawn;
    this.stats.gain = gain;
    this.stats.peak = peak * gain;

    // ── 抓住一朵时的外圈：虚线圆 + 一个跟着转角走的刻度 ─────────────
    if (grabRing) this.drawGrabRing(ctx, grabRing, time, opacity);
    return this;
  }

  /** 抓花的外圈指示（圆心 = 花心屏幕坐标；spin = 当前三轴角度） */
  drawGrabRing(ctx, ring, time, opacity) {
    const { x, y, r } = ring;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(r > 4)) return;
    const spin = ring.spin || { yaw: 0, pitch: 0, roll: 0 };
    const a = 0.42 * opacity;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.strokeStyle = GRAB_RING_COLOR;
    ctx.lineWidth = 1.15;
    ctx.setLineDash([5, 7]);
    ctx.lineDashOffset = -((time * 9) % 12);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // 刻度：跟着 yaw 转，给「这朵到底转到哪一面」一个参照
    ctx.globalAlpha = a * 1.7;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    const ang = -Math.PI / 2 + (spin.yaw || 0);
    ctx.moveTo(x + Math.cos(ang) * (r + 4), y + Math.sin(ang) * (r + 4));
    ctx.lineTo(x + Math.cos(ang) * (r + 15), y + Math.sin(ang) * (r + 15));
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 画一只手（内部方法；参数都是原语，不建对象）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} hand 调用方的手对象
   * @param {object} slot 预分配的点数组
   * @param {number} hi 第几只
   * @param {number} time 秒
   * @param {number} opacity 调用方整体不透明度
   * @param {number} gain 亮度预算系数
   */
  drawHand(ctx, hand, slot, hi, time, opacity, gain) {
    const S = SKELETON_STYLE;
    const fist = Number.isFinite(hand.fist) ? clamp01(hand.fist) : 0;
    const held = hand.held === true;
    const rampIdx = Math.round(fist * (RAMP_STEPS - 1));
    const boneColor = BONE_RAMP[rampIdx];
    const dotColor = DOT_RAMP[rampIdx];
    const ringColor = RING_RAMP[rampIdx];

    // 呼吸：极轻的正弦，只动微光与环半径（主体线不抖）
    const breath = 1 + 0.035 * Math.sin(time * 1.9 + hi * 1.7);
    // 待机（held）：整体降到 ~35%，并且不连线、只在弦上打点
    const handA = (held ? S.heldA : 1) * gain;
    const baseA = opacity * handA;

    // ── 指尖拖尾（lighter，压在骨线下面）───────────────────────────
    // 整条拖尾只 fill 一次：同一条路径内的重叠是并集，不会因为手指停在原地
    // 把 7 个点叠成白团（强度靠半径衰减表达）。
    this.updateTrail(slot);
    if (this.trailEnabled && !held && slot.trailN > 1) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = dotColor;
      ctx.globalAlpha = clamp01(baseA * S.trailA);
      ctx.beginPath();
      for (let k = 0; k < slot.trailN; k += 1) {
        const idx = (slot.trailHead - 1 - k + TRAIL_N * 2) % TRAIL_N;
        const fade = 1 - k / TRAIL_N;
        const r = lerp(S.trailR[1], S.trailR[0], fade);
        const x = slot.trail[idx * 2];
        const y = slot.trail[idx * 2 + 1];
        ctx.moveTo(x + r, y);
        ctx.arc(x, y, r, 0, TAU);
      }
      ctx.fill();
    }

    // ── 微光层（lighter）：宽而淡的一层，让线"发亮"而不是"发白"──
    if (this.glowEnabled) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = boneColor;
      ctx.fillStyle = dotColor;
      ctx.lineWidth = S.glowW * (1 + fist * 0.12);
      ctx.globalAlpha = clamp01(baseA * S.glowA * breath * (held ? 0.4 : 1));
      ctx.beginPath();
      for (let li = 0; li < LINK_COUNT; li += 1) {
        const a = LINKS[li * 2];
        const b = LINKS[li * 2 + 1];
        if (!slot.ok[a] || !slot.ok[b]) continue;
        ctx.moveTo(slot.xy[a * 2], slot.xy[a * 2 + 1]);
        ctx.lineTo(slot.xy[b * 2], slot.xy[b * 2 + 1]);
      }
      ctx.stroke();
      // 三个强调点（腕 0 / 拇指尖 4 / 食指尖 8）各加一小团软光
      if (!held) {
        ctx.globalAlpha = clamp01(baseA * S.glowA * S.glowHaloBoost * breath);
        ctx.beginPath();
        for (let ai = 0; ai < 3; ai += 1) {
          const i = ai === 0 ? 0 : ai === 1 ? 4 : 8;
          if (!slot.ok[i]) continue;
          const x = slot.xy[i * 2];
          const y = slot.xy[i * 2 + 1];
          ctx.moveTo(x + S.glowHaloR, y);
          ctx.arc(x, y, S.glowHaloR, 0, TAU);
        }
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // ── 骨骼线（主体）──────────────────────────────────────────────
    ctx.strokeStyle = boneColor;
    ctx.fillStyle = boneColor;
    for (let li = 0; li < LINK_COUNT; li += 1) {
      const a = LINKS[li * 2];
      const b = LINKS[li * 2 + 1];
      if (!slot.ok[a] || !slot.ok[b]) continue;
      const ax = slot.xy[a * 2];
      const ay = slot.xy[a * 2 + 1];
      const bx = slot.xy[b * 2];
      const by = slot.xy[b * 2 + 1];
      // 越靠指尖越亮 / 略粗（link 权重 → 0–1）
      const t = (LINK_GAIN[li] - 0.66) / (1.18 - 0.66);
      const linkA = S.linkAFloor + S.linkASpan * t;
      ctx.globalAlpha = clamp01(baseA * S.boneA * linkA);

      if (held) {
        // 待机虚线感：不画连续线，沿弦打 3 个小点
        ctx.beginPath();
        for (let k = 1; k <= 3; k += 1) {
          const s = k * 0.25;
          const x = ax + (bx - ax) * s;
          const y = ay + (by - ay) * s;
          ctx.moveTo(x + 0.7, y);
          ctx.arc(x, y, 0.7, 0, TAU);
        }
        ctx.fill();
      } else {
        ctx.lineWidth = S.boneW + S.boneWTip * t + S.fistW * fist;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
    }

    // ── 关节小点：普通一组 + 强调一组（0 / 4 / 8）──────────────────
    const fistDot = 1 + fist * 0.08;
    ctx.fillStyle = dotColor;
    ctx.globalAlpha = clamp01(baseA * S.dotA);
    ctx.beginPath();
    for (let i = 0; i < 21; i += 1) {
      if (!slot.ok[i] || i === 0 || i === 4 || i === 8) continue;
      const r = (i === 12 || i === 16 || i === 20 ? S.dotRTip : S.dotR) * fistDot;
      const x = slot.xy[i * 2];
      const y = slot.xy[i * 2 + 1];
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, TAU);
    }
    ctx.fill();

    ctx.globalAlpha = clamp01(baseA * S.dotAAccent);
    ctx.beginPath();
    for (let ai = 0; ai < 3; ai += 1) {
      const i = ai === 0 ? 0 : ai === 1 ? 4 : 8;
      if (!slot.ok[i]) continue;
      const r = S.dotRAccent * fistDot;
      const x = slot.xy[i * 2];
      const y = slot.xy[i * 2 + 1];
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, TAU);
    }
    ctx.fill();

    // ── 捏合环（4 ↔ 8）：半径 / 亮度随两点距离变化 ─────────────────
    if (!slot.ok[4] || !slot.ok[8]) return;
    const tx = slot.xy[8]; // 4
    const ty = slot.xy[9];
    const ix = slot.xy[16]; // 8
    const iy = slot.xy[17];
    const d48 = Math.hypot(ix - tx, iy - ty);
    // 掌宽（0↔9）当尺度基准 → 远近、手大手小都不影响捏合判定
    let palmPx = d48 * 2;
    if (slot.ok[0] && slot.ok[9]) {
      const px = slot.xy[18] - slot.xy[0]; // 9 - 0
      const py = slot.xy[19] - slot.xy[1];
      const d = Math.hypot(px, py);
      if (d > 1) palmPx = d;
    }
    const ratio = palmPx > 1 ? d48 / palmPx : 1;
    const pinch = clamp01((S.pinchRatioFar - ratio) / (S.pinchRatioFar - S.pinchRatioNear));
    const hs = clamp(palmPx / S.ringPalmRef, S.ringSizeClamp[0], S.ringSizeClamp[1]);
    const r = lerp(S.ringR[1], S.ringR[0], pinch) * hs;
    const cx = (tx + ix) / 2;
    const cy = (ty + iy) / 2;
    const ringA = lerp(S.ringAFar, S.ringANear, pinch);

    ctx.strokeStyle = ringColor;
    // 环的微光（lighter）
    if (this.glowEnabled) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = clamp01(baseA * ringA * S.glowGlowMul * breath);
      ctx.lineWidth = S.ringW * 3.2;
      ctx.beginPath();
      ctx.arc(cx, cy, r * (1 + 0.02 * Math.sin(time * 3.1)), 0, TAU);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
    }
    // 环的实线（细）
    ctx.globalAlpha = clamp01(baseA * ringA);
    ctx.lineWidth = S.ringW;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.stroke();

    // 捏紧：环心一点暖金（很轻，只是"咔"一下）
    if (pinch > 0.55) {
      const k = (pinch - 0.55) / 0.45;
      ctx.fillStyle = GOLD;
      ctx.globalAlpha = clamp01(baseA * S.ringGoldA * k);
      ctx.beginPath();
      ctx.arc(cx, cy, lerp(0.9, 1.7, k), 0, TAU);
      ctx.fill();
    }
  }

  /** 指尖（8）拖尾环形缓冲：就地写，零分配 */
  updateTrail(slot) {
    if (!slot.ok[16]) {
      slot.primed = false;
      slot.trailN = 0;
      return;
    }
    const tx = slot.xy[16];
    const ty = slot.xy[17];
    if (!slot.primed) {
      slot.primed = true;
      slot.lastX = tx;
      slot.lastY = ty;
      slot.trailN = 0;
      slot.trailHead = 0;
      return;
    }
    const dx = tx - slot.lastX;
    const dy = ty - slot.lastY;
    const moved2 = dx * dx + dy * dy;
    if (moved2 > TRAIL_JUMP_SQ) {
      // 位置跳变（换手 / 重捕）：断开，不连出一条横跨画面的线
      slot.trailN = 0;
      slot.trailHead = 0;
    }
    slot.lastX = tx;
    slot.lastY = ty;
    // 手指基本不动时不必往里塞重复点
    if (moved2 < TRAIL_MIN_MOVE_SQ && slot.trailN > 0) return;
    const h2 = slot.trailHead * 2;
    slot.trail[h2] = tx;
    slot.trail[h2 + 1] = ty;
    slot.trailHead = (slot.trailHead + 1) % TRAIL_N;
    if (slot.trailN < TRAIL_N) slot.trailN += 1;
  }
}

export default HandSkeleton;