/**
 * hands.js — 从 21 个 landmark 到「一只手」的状态。
 *
 * 纯计算，不碰 DOM / WebGL，所以 node 里跑单元测试时可以用假 landmark 序列
 * 直接驱动完整链路（landmark → 指尖 → One Euro → 弹簧 → 引擎）。
 *
 * 每帧重算：指尖 = 8/12 中点，掌心 = 0/5/9/13/17 的重心。
 * 镜像：landmark.x 映射到舞台时做 1-x（手右移 → 画面右移），y 不翻转。
 */

import { STAGE, SMOOTH, FIST } from './config.js';

export const LM = Object.freeze({
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
});

/** 画骨架用（13 条骨线） */
export const HAND_CONNECTIONS = Object.freeze([
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
]);

const TAU = Math.PI * 2;
const alphaFor = (cutoff, dt) => {
  const te = 1 / TAU / Math.max(cutoff, 1e-4);
  return 1 / (1 + te / Math.max(dt, 1e-4));
};

/** One Euro 滤波器（minCutoff / beta / dCutoff 固定，不加大平滑） */
export class OneEuroFilter {
  constructor({ minCutoff = 1.2, beta = 0.02, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset(value = null) {
    this.xPrev = value;
    this.dxPrev = 0;
    this.yPrev = value;
    return this;
  }

  filter(x, dt = 1 / 60) {
    if (this.xPrev === null) {
      this.reset(x);
      return x;
    }
    const dtc = Math.max(1e-4, dt);
    const dx = (x - this.xPrev) / dtc;
    const aD = alphaFor(this.dCutoff, dtc);
    this.dxPrev += aD * (dx - this.dxPrev);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxPrev);
    const a = alphaFor(cutoff, dtc);
    this.yPrev += a * (x - this.yPrev);
    this.xPrev = x;
    return this.yPrev;
  }
}

/** 二维弹簧跟随（k=0.10 / 阻尼 0.88，按 60Hz 子步算，跟刷新率无关） */
export class Spring2D {
  constructor({ k = 0.1, damp = 0.88 } = {}) {
    this.k = k;
    this.damp = damp;
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.acc = 0;
    this.primed = false;
  }

  snap(x, y) {
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.primed = true;
    return this;
  }

  step(tx, ty, dt = 1 / 60) {
    if (!this.primed) return this.snap(tx, ty);
    this.acc += Math.max(0, Math.min(dt, 0.1));
    const h = 1 / 60;
    let steps = Math.min(6, Math.floor(this.acc / h));
    while (steps-- > 0) {
      this.acc -= h;
      this.vx = (this.vx + (tx - this.x) * this.k) * this.damp;
      this.vy = (this.vy + (ty - this.y) * this.k) * this.damp;
      this.x += this.vx;
      this.y += this.vy;
    }
    if (!Number.isFinite(this.x) || !Number.isFinite(this.y)) this.snap(tx, ty);
    return this;
  }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * 握拳判定：四指「伸得最直的那一根」的指尖-腕距离 / 掌宽。
 * 取最大比值 → 只要还有一根手指伸着就不算握拳（指点不会被误判成握拳）；
 * 与手的大小、旋转都无关。
 */
export function fistScore(landmarks) {
  if (!landmarks || landmarks.length < 21) return 0;
  const wrist = landmarks[LM.WRIST];
  const palm = landmarks[LM.MIDDLE_MCP];
  const palmSize = dist2(wrist, palm) || 1e-5;
  const tips = [LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP, LM.PINKY_TIP];
  let maxRatio = 0;
  for (const i of tips) {
    const r = dist2(wrist, landmarks[i]) / palmSize;
    if (r > maxRatio) maxRatio = r;
  }
  // 张开 ≈1.6–1.8，握紧 ≈0.95–1.15
  return clamp01((1.5 - maxRatio) / 0.5);
}

const emptyHand = () => ({
  slot: -1,
  present: false,
  held: false,
  detectedThisFrame: false,
  tip: { x: 0, y: 0, z: 0 },
  palm: { x: 0, y: 0, z: 0 },
  fist: false,
  fistScore: 0,
  handedness: '',
  score: 0,
  landmarks: null,
  worldLandmarks: null,
  lastSeenAt: 0,
});

/**
 * 一只手：landmark（归一化图像）→ 舞台逻辑像素。
 * @param {Array<{x:number,y:number,z:number}>} landmarks
 */
export function landmarksToStage(landmarks) {
  return landmarks.map((p) => ({
    x: (1 - p.x) * STAGE.w, // 镜像
    y: p.y * STAGE.h,
    z: p.z || 0,
  }));
}

export class HandTracker {
  /**
   * @param {{smooth?:typeof SMOOTH, fist?:typeof FIST}} opts
   */
  constructor({ smooth = SMOOTH, fist = FIST } = {}) {
    this.smooth = smooth;
    this.fistCfg = fist;
    this.reset();
  }

  reset() {
    this.slots = [0, 1].map(() => {
      const s = emptyHand();
      s.filtersX = new OneEuroFilter(this.smooth.oneEuro);
      s.filtersY = new OneEuroFilter(this.smooth.oneEuro);
      s.palmFX = new OneEuroFilter(this.smooth.oneEuro);
      s.palmFY = new OneEuroFilter(this.smooth.oneEuro);
      s.spring = new Spring2D(this.smooth.spring);
      s.palmSpring = new Spring2D(this.smooth.spring);
      s.rawImg = null;
      s.lastRawAt = 0;
      s.reacquireFrom = null;
      s.reacquireAt = 0;
      s.fistSmooth = 0;
      s.usedBy = null;
      return s;
    });
    this.lastSeenAt = 0;
    this.lastResultAt = 0;
    this.detectCount = 0;
  }

  /**
   * 吃一帧 HandLandmarkerResult。
   * @param {{landmarks?:Array, worldLandmarks?:Array, handedness?:Array, handednesses?:Array}} result
   * @param {number} now 毫秒
   */
  ingest(result, now = 0) {
    if (!result || !Array.isArray(result.landmarks) || result.landmarks.length === 0) {
      return this;
    }
    this.lastResultAt = now;
    const limit = Math.min(2, result.landmarks.length);
    const detected = [];
    for (let i = 0; i < limit; i += 1) {
      const img = result.landmarks[i];
      if (!img || img.length < 21) continue;
      const stage = landmarksToStage(img);
      const tipImg = img[LM.INDEX_TIP] && img[LM.MIDDLE_TIP]
        ? { x: (img[LM.INDEX_TIP].x + img[LM.MIDDLE_TIP].x) / 2, y: (img[LM.INDEX_TIP].y + img[LM.MIDDLE_TIP].y) / 2 }
        : { x: img[0].x, y: img[0].y };
      detected.push({
        index: i,
        img,
        stage,
        tipImg,
        world: (result.worldLandmarks && result.worldLandmarks[i]) || null,
        handedness:
          (result.handedness && result.handedness[i] && result.handedness[i][0] && result.handedness[i][0].categoryName) ||
          (result.handednesses && result.handednesses[i] && result.handednesses[i][0] &&
            result.handednesses[i][0].categoryName) ||
          '',
        score:
          (result.handedness && result.handedness[i] && result.handedness[i][0] && result.handedness[i][0].score) ||
          (result.handednesses && result.handednesses[i] && result.handednesses[i][0] &&
            result.handednesses[i][0].score) ||
          1,
      });
    }
    if (!detected.length) {
      for (const s of this.slots) {
        if (s.present) s.held = true;
      }
      return this;
    }
    for (const s of this.slots) s.detectedThisFrame = false;

    // 手 → 槽位：离上一帧图像位置最近者优先，剩下的进空槽
    const free = new Set([0, 1]);
    const pairs = [];
    for (const d of detected) {
      for (const slot of [0, 1]) {
        const s = this.slots[slot];
        if (!s.present || !s.rawImg) continue;
        pairs.push({ d, slot, cost: Math.hypot(d.tipImg.x - s.rawImg.x, d.tipImg.y - s.rawImg.y) });
      }
    }
    pairs.sort((a, b) => a.cost - b.cost);
    const takenD = new Set();
    const takenS = new Set();
    for (const p of pairs) {
      if (takenD.has(p.d) || takenS.has(p.slot)) continue;
      takenD.add(p.d);
      takenS.add(p.slot);
      this.applyDetection(p.slot, p.d, now);
      free.delete(p.slot);
    }
    for (const d of detected) {
      if (takenD.has(d)) continue;
      const slot = [...free][0];
      if (slot === undefined) break;
      free.delete(slot);
      this.applyDetection(slot, d, now);
      takenD.add(d);
    }

    // 本帧没被匹配到的槽位 → 失联保持（位置冻结，1.2s 内算「手还在」）
    for (const s of this.slots) {
      if (s.present) s.held = !s.detectedThisFrame;
    }

    this.lastSeenAt = now;
    this.detectCount += 1;
    return this;
  }

  applyDetection(slotIndex, det, now) {
    const s = this.slots[slotIndex];
    const wasPresent = s.present;
    const hadTip = s.rawImg !== null;
    const wasStale = !wasPresent || s.held;
    const dtRaw = s.lastRawAt ? Math.max(1 / 240, Math.min(0.2, (now - s.lastRawAt) / 1000)) : 1 / 60;
    s.lastRawAt = now;
    s.rawImg = det.tipImg;
    s.landmarks = det.stage;
    s.worldLandmarks = det.world;
    s.handedness = det.handedness;
    s.score = det.score;

    const tip = {
      x: (det.stage[LM.INDEX_TIP].x + det.stage[LM.MIDDLE_TIP].x) / 2,
      y: (det.stage[LM.INDEX_TIP].y + det.stage[LM.MIDDLE_TIP].y) / 2,
      z: ((det.stage[LM.INDEX_TIP].z || 0) + (det.stage[LM.MIDDLE_TIP].z || 0)) / 2,
    };
    const palmPts = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP].map((i) => det.stage[i]);
    const palm = {
      x: palmPts.reduce((a, p) => a + p.x, 0) / palmPts.length,
      y: palmPts.reduce((a, p) => a + p.y, 0) / palmPts.length,
      z: palmPts.reduce((a, p) => a + p.z, 0) / palmPts.length,
    };

    if (wasStale) {
      // 重新出现：滤波器直接播种，位置由 0.2s 重捕插值接管（不瞬移）
      s.filtersX.reset(tip.x);
      s.filtersY.reset(tip.y);
      s.palmFX.reset(palm.x);
      s.palmFY.reset(palm.y);
      if (hadTip) {
        s.reacquireFrom = { x: s.tip.x, y: s.tip.y, palmX: s.palm.x, palmY: s.palm.y };
        s.reacquireAt = now;
        s.spring.snap(s.tip.x, s.tip.y);
        s.palmSpring.snap(s.palm.x, s.palm.y);
      } else {
        // 第一次看见这只手：直接落到位，不从角落里飘过来
        s.reacquireFrom = null;
        s.tip = { x: tip.x, y: tip.y, z: tip.z };
        s.palm = { x: palm.x, y: palm.y, z: 0 };
        s.spring.snap(tip.x, tip.y);
        s.palmSpring.snap(palm.x, palm.y);
      }
      s.present = true;
    }

    s.tipFiltered = {
      x: s.filtersX.filter(tip.x, dtRaw),
      y: s.filtersY.filter(tip.y, dtRaw),
      z: tip.z,
    };
    s.palmFiltered = {
      x: s.palmFX.filter(palm.x, dtRaw),
      y: s.palmFY.filter(palm.y, dtRaw),
    };
    // 握拳分数：EMA + 滞回
    const raw = fistScore(det.img);
    s.fistSmooth = s.fistSmooth + (raw - s.fistSmooth) * 0.38;
    if (s.fistSmooth >= this.fistCfg.scoreOn) s.fist = true;
    else if (s.fistSmooth <= this.fistCfg.scoreOff) s.fist = false;

    s.present = true;
    s.held = false;
    s.detectedThisFrame = true;
    s.lastSeenAt = now;
  }

  /**
   * 每帧推进（弹簧 / 丢失保持）。
   * @param {number} now 毫秒
   * @param {number} frameDt 秒
   */
  update(now, frameDt = 1 / 60) {
    for (const s of this.slots) {
      if (!s.present || !s.tipFiltered) continue;
      // 100ms 没检测到 → 进入「失联保持」（位置冻结）
      if (!s.held && now - s.lastSeenAt > 100) s.held = true;
      // 丢失超过 1.2s → 回静候
      if (now - s.lastSeenAt > this.smooth.lostHold * 1000) {
        s.present = false;
        s.held = false;
        s.fist = false;
        continue;
      }
      s.spring.step(s.tipFiltered.x, s.tipFiltered.y, frameDt);
      s.palmSpring.step(s.palmFiltered.x, s.palmFiltered.y, frameDt);

      let x = s.spring.x;
      let y = s.spring.y;
      let px = s.palmSpring.x;
      let py = s.palmSpring.y;
      if (s.reacquireFrom) {
        // 0.2s 内从「消失时的位置」插值到当前指尖（不瞬移、也不拖太久）
        const t = Math.min(1, Math.max(0, (now - s.reacquireAt) / (this.smooth.reacquire * 1000)));
        const e = 1 - Math.pow(1 - t, 3);
        x = s.reacquireFrom.x + (s.tipFiltered.x - s.reacquireFrom.x) * e;
        y = s.reacquireFrom.y + (s.tipFiltered.y - s.reacquireFrom.y) * e;
        px = s.reacquireFrom.palmX + (s.palmFiltered.x - s.reacquireFrom.palmX) * e;
        py = s.reacquireFrom.palmY + (s.palmFiltered.y - s.reacquireFrom.palmY) * e;
        s.spring.snap(x, y);
        s.palmSpring.snap(px, py);
        if (t >= 1) s.reacquireFrom = null;
      }
      s.tip = { x, y, z: s.tipFiltered.z || 0 };
      s.palm = { x: px, y: py, z: 0 };
    }
  }

  /** 当前参与交互的手（含 1.2s 缓冲内的「失联保持」手） */
  activeHands() {
    const out = [];
    for (let i = 0; i < this.slots.length; i += 1) {
      const s = this.slots[i];
      if (!s.present) continue;
      out.push({
        slot: i,
        present: true,
        held: s.held,
        tip: { ...s.tip },
        palm: { ...s.palm },
        fist: s.fist,
        fistScore: s.fistSmooth,
        handedness: s.handedness,
        score: s.score,
        landmarks: s.landmarks,
        worldLandmarks: s.worldLandmarks,
        lastSeenAt: s.lastSeenAt,
      });
    }
    return out;
  }

  /** 刚检测到（非失联保持）的手数 */
  liveHandCount(now) {
    return this.activeHands().filter((h) => !h.held || now - h.lastSeenAt < 16).length;
  }
}

export default HandTracker;