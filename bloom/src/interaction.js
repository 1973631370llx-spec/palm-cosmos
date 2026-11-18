/**
 * interaction.js — 交互状态机（纯逻辑，不碰 DOM / WebGL）。
 *
 * 输入：每帧的手（舞台逻辑像素）+ 时间；输出：事件 + 快照。
 * 优先级：握拳 > 双端 > 横抚 > 轻触；同一帧只放行一种触发（互斥）。
 *
 * 单位：位置是逻辑像素（1080×1920）；距离一律换成「按 1080 宽归一化」的
 * 度量坐标再比较（x/1080、y/1080），所以 enterR=0.09 ≈ 97px 圆。
 */

import { STAGE, TOUCH, BLOOM, SWEEP, DUET, FIST, STATE, FLOWER_ANCHORS, PINCH, SWIPE } from './config.js';

const S = 1000;

const toMetric = (p) => ({ x: p.x / STAGE.w, y: p.y / STAGE.w });
const ANCHORS_M = FLOWER_ANCHORS.map((a) => ({ x: a.x / STAGE.w, y: a.y / STAGE.w, scale: a.scale, xNorm: a.x / STAGE.w }));

/** 横抚检测（纯函数，单元测试可直接调） */
export function detectSweep(samples, cfg = SWEEP, anchors = ANCHORS_M) {
  if (!Array.isArray(samples) || samples.length < 3) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (last.t - first.t > cfg.window * S) return null;
  const dx = last.x - first.x;
  if (Math.abs(dx) < cfg.minDistance) return null;
  const dir = dx > 0 ? 1 : -1;

  // 方向单调：相对「已到达的极值」不许逆行超过容差
  let extreme = first.x;
  for (const p of samples) {
    if ((p.x - extreme) * dir < -cfg.monotonicTol) return null;
    if ((p.x - extreme) * dir > 0) extreme = p.x;
  }

  // 依次穿过花心 x：用「线段跨过锚点」判定（低帧率 / 手快也不会跳过），y 在带内
  const pass = [null, null, null];
  for (let k = 1; k < samples.length; k += 1) {
    const a = samples[k - 1];
    const b = samples[k];
    const lo = Math.min(a.x, b.x);
    const hi = Math.max(a.x, b.x);
    for (let i = 0; i < anchors.length && i < 3; i += 1) {
      if (pass[i] !== null) continue;
      if (anchors[i].x < lo || anchors[i].x > hi) continue;
      const f = hi - lo < 1e-6 ? 0 : (anchors[i].x - a.x) / (b.x - a.x);
      const yAt = a.y + (b.y - a.y) * f;
      if (Math.abs(yAt - anchors[i].y) > cfg.yBand) continue;
      pass[i] = b.t;
    }
  }

  // v3：穿到 minCross 朵就算（默认 2）——三朵全穿过太难，很多人划不到
  const need = Math.max(1, Math.min(3, cfg.minCross || 3));
  const hit = [0, 1, 2].filter((i) => pass[i] !== null);
  if (hit.length < need) {
    return {
      dir,
      order: null,
      span: extreme - first.x,
      passedAt: pass,
      hit,
      progress: hit.length,
      need,
    };
  }

  // 按时间排序后必须与方向一致（向右抚 = 依次 0→1→2）
  const sorted = [...hit].sort((a, b) => (dir > 0 ? a - b : b - a));
  for (let k = 1; k < sorted.length; k += 1) {
    if (pass[sorted[k]] <= pass[sorted[k - 1]]) return null;
  }
  // 全开：先开穿过的，剩下的补在后面（保持方向感）
  const rest = [0, 1, 2].filter((i) => !sorted.includes(i));
  const order = [...sorted, ...(dir > 0 ? rest : rest.reverse())];
  return { dir, order, span: extreme - first.x, passedAt: pass, hit, progress: hit.length, need };
}

/**
 * 横抚进度（只给画面反馈用，不触发任何东西）：
 * 返回 { dir, hit:[bool×3], progress, need }，让 HUD 画三个小点
 */
export function sweepProgress(samples, cfg = SWEEP, anchors = ANCHORS_M) {
  if (!Array.isArray(samples) || samples.length < 2) {
    return { dir: 0, hit: [false, false, false], progress: 0, need: cfg.minCross || 3 };
  }
  const res = detectSweep(samples, cfg, anchors);
  if (res && res.hit) {
    return {
      dir: res.dir,
      hit: [res.passedAt[0] !== null, res.passedAt[1] !== null, res.passedAt[2] !== null],
      progress: res.progress,
      need: res.need,
    };
  }
  // 还没达成：逐点扫一遍当前缓冲区（不看单调性，只报"已经擦过哪几朵"）
  const hit = [false, false, false];
  const last = samples[samples.length - 1];
  const dir = last.x - samples[0].x >= 0 ? 1 : -1;
  for (let k = 1; k < samples.length; k += 1) {
    const a = samples[k - 1];
    const b = samples[k];
    const lo = Math.min(a.x, b.x);
    const hi = Math.max(a.x, b.x);
    for (let i = 0; i < 3; i += 1) {
      if (hit[i]) continue;
      if (anchors[i].x < lo || anchors[i].x > hi) continue;
      const f = hi - lo < 1e-6 ? 0 : (anchors[i].x - a.x) / (b.x - a.x);
      const yAt = a.y + (b.y - a.y) * f;
      if (Math.abs(yAt - anchors[i].y) <= cfg.yBand) hit[i] = true;
    }
  }
  return { dir, hit, progress: hit.filter(Boolean).length, need: cfg.minCross || 3 };
}

/* ── v2 新增：捏合释放 / 手掌横滑换花 ────────────────────── */

/**
 * 捏合检测（纯函数）。拇指尖(4) 与食指尖(8) 的距离相对掌长(0↔9)，
 * 比值小 = 捏住。返回每只手的 {slot, ratio, tip}。
 */
export function detectPinch(hands, cfg = PINCH, prev = null) {
  const out = [];
  for (const h of hands || []) {
    const lm = h.landmarks || h.stage;
    if (!lm || lm.length < 21) continue;
    const thumb = lm[4];
    const index = lm[8];
    const wrist = lm[0];
    const mcp = lm[9];
    const palm = Math.hypot(mcp.x - wrist.x, mcp.y - wrist.y) || 1e-5;
    const gap = Math.hypot(index.x - thumb.x, index.y - thumb.y);
    const ratio = gap / palm;
    // 食指尖必须还伸在外面（握拳时它会卷回掌心）——用它把「握拳」和「捏」分开
    const reach = Math.hypot(index.x - wrist.x, index.y - wrist.y) / palm;
    const was = prev && prev[h.slot];
    const closed = ratio < (was ? cfg.off : cfg.on);
    const extended = reach >= (cfg.indexReach || 1.05);
    out.push({
      slot: h.slot,
      ratio,
      reach,
      on: closed && extended,
      tip: { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 },
    });
  }
  return out;
}

/**
 * 横滑检测（纯函数，按 slot 维护短期轨迹）。
 * 和「横抚整枝」区分：只有手**离开花带**（离最近花的 y 够远）时的横滑才算换花，
 * 免得同一条手势既开花又切模型。
 */
export class SwipeTracker {
  constructor(cfg = SWIPE, anchors = ANCHORS_M) {
    this.cfg = cfg;
    this.anchors = anchors;
    this.trail = new Map(); // slot → [{t,x,y}]
    this.lastFireAt = -1e9;
    this.fireX = new Map(); // slot → 上次判定时的 x（归一化），回来才重新武装
  }

  reset() {
    this.trail.clear();
    this.fireX.clear();
    this.lastFireAt = -1e9;
  }

  /** 手在花带里？在带里就不当横滑 */
  _inBand(p) {
    const m = toMetric(p);
    return this.anchors.some((a) => Math.abs(m.y - a.y) < this.cfg.bandGap + 0.1);
  }

  /** 喂一帧，返回 {dir, dist} 或 null */
  push(slot, tip, now) {
    const cfg = this.cfg;
    const t = now / 1000;
    let buf = this.trail.get(slot);
    if (!buf) {
      buf = [];
      this.trail.set(slot, buf);
    }
    // tip 为 null = 调用方要「断掉这条轨迹」（手换了姿势 / 拿走了）
    if (!tip || !Number.isFinite(tip.x) || !Number.isFinite(tip.y)) {
      buf.length = 0;
      this.fireX.delete(slot);
      return null;
    }
    buf.push({ t, x: tip.x / STAGE.w, y: tip.y / STAGE.w });
    while (buf.length && t - buf[0].t > cfg.window) buf.shift();
    if (buf.length < 3) return null;
    if (t - this.lastFireAt < cfg.cooldown) return null;
    // 一次拖动只算一次：手要先回到刚才判定点附近（或者换个方向）才重新武装
    const fired = this.fireX.get(slot);
    if (fired != null && Math.abs(tip.x / STAGE.w - fired) < cfg.minDist * 0.5) return null;
    const first = buf[0];
    const last = buf[buf.length - 1];
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    if (Math.abs(dx) < cfg.minDist) return null;
    if (Math.abs(dy) > Math.abs(dx) * 0.7) return null; // 竖着划不算
    if (this._inBand(tip)) return null; // 花带里的横滑留给「横抚整枝」
    // 单调性：中途不能大幅回头
    const dir = dx > 0 ? 1 : -1;
    let extreme = first.x;
    for (const p of buf) {
      if ((p.x - extreme) * dir < -0.06) return null;
      if ((p.x - extreme) * dir > 0) extreme = p.x;
    }
    this.lastFireAt = t;
    this.fireX.set(slot, last.x);
    buf.length = 0;
    return { dir, dist: Math.abs(dx) };
  }
}

export class InteractionEngine {
  constructor(opts = {}) {
    this.cfg = {
      touch: opts.touch || TOUCH,
      bloom: opts.bloom || BLOOM,
      sweep: opts.sweep || SWEEP,
      duet: opts.duet || DUET,
      fist: opts.fist || FIST,
      anchors: opts.anchors ? opts.anchors.map((a) => ({ x: a.x / STAGE.w, y: a.y / STAGE.w })) : ANCHORS_M,
    };
    this.reset();
  }

  reset() {
    this.mode = STATE.STANDBY;
    this.open = [false, false, false];
    this.openOrder = [];
    this.pet = 0;
    this.lock = { kind: null, until: 0 };
    this.resetUntil = 0;
    this.lastTouchCountAt = -1e9;
    this.cooldown = { sweepUntil: 0, duetUntil: 0 };
    this.fistMuteUntil = -1e9;
    this.touches = new Map(); // slot → { inside, since, counted }
    this.sweepBuf = new Map(); // slot → [{t,x,y}]
    this.fistSince = new Map(); // slot → t
    this.duetSince = null;
    this.duetFlashUntil = 0;
    this.quality = 0.95;
    this.events = [];
    this.hint = '';
    this.absentSince = null;
    this._lastSeen = null;
    this._now = 0;
    this.lastSeenAt = null;
  }

  /* ── 对外 ─────────────────────────────────────────────── */

  /**
   * 彻底清空引擎状态（换场景 / 自测分段时用）
   * 注意：光清 tracker 不够——sweepBuf / touches / 冷却都在这儿。
   */
  hardReset() {
    this.reset();
    if (this.swipe) {
      this.swipe.trail.clear();
      this.swipe.fireX.clear();
      this.swipe.lastFireAt = -1e9;
    }
    this.events.length = 0;
    return this;
  }

  /**
   * @param {{hands?:Array, now?:number, dt?:number, lastSeenAt?:number|null, cameraLive?:boolean}} input
   */
  frame(input = {}) {
    const t = input.now || 0;
    this._now = t;
    const hands = Array.isArray(input.hands) ? input.hands : [];
    const cameraLive = !!input.cameraLive;
    const events = [];
    this.events = events;
    this.lastSeenAt = input.lastSeenAt;

    // 手是否在画面里（含 1.2s 缓冲内的失联保持）
    const anyHand = hands.length > 0;

    /* 1. 计时器 */
    if (this.mode === STATE.RESET && t >= this.resetUntil) {
      this._setState(cameraLive ? STATE.CAMERA_LIVE : STATE.STANDBY, events);
    }
    if (this.lock.kind && t >= this.lock.until) {
      this._closeAll(t, 'hold-end', events);
    }

    /* 2. 手离开 → 非锁定状态逐朵回拢（从「最后一次真正看见手」算 1.2s） */
    if (typeof input.lastSeenAt === 'number') this._lastSeen = input.lastSeenAt;
    else if (anyHand) this._lastSeen = t;
    const absentMs = this._lastSeen === null ? Infinity : Math.max(0, t - this._lastSeen);
    if (
      absentMs >= this.cfg.bloom.handLostBeforeClose * S &&
      this.mode === STATE.PETTING &&
      !this.lock.kind
    ) {
      this._closeOrdered(t, 'hand-away', events);
    }

    /* 3. 优先级链：握拳 > 双端 > 横抚 > 轻触（互斥） */
    let fired = false;
    fired = this._tryFist(hands, t, events);
    if (!fired && this.mode !== STATE.LOCKED) {
      fired = this._tryDuet(hands, t, cameraLive, events);
      if (!fired) fired = this._trySweep(hands, t, events);
      if (!fired) fired = this._tryTouch(hands, t, events);
    }
    if (!fired) {
      this._decayTransients(hands, t);
    }

    /* 4. 状态名 */
    if (this.mode !== STATE.LOCKED && this.mode !== STATE.RESET) {
      if (this.pet > 0) this._setState(STATE.PETTING, events);
      else this._setState(cameraLive ? STATE.CAMERA_LIVE : STATE.STANDBY, events);
    }

    /* 5. 姿态质量（HUD 用，平滑） */
    let q = this.quality;
    if (anyHand) {
      const target = hands.reduce((m, h) => Math.max(m, h.score || 0.9), 0);
      q += (target - q) * 0.12;
    } else {
      q += (0.9 - q) * 0.05;
    }
    this.quality = Math.min(0.999, Math.max(0, q));

    this._updateHint(t);

    return {
      events,
      state: this.mode,
      pet: this.pet,
      open: this.open.slice(),
      openOrder: this.openOrder.slice(),
      lock: { ...this.lock },
      hint: this.hint,
      quality: this.quality,
      duetFlash: t < this.duetFlashUntil,
      absentMs,
      handCount: hands.length,
    };
  }

  /* ── 各手势 ───────────────────────────────────────────── */

  _tryFist(hands, t, events) {
    const cfg = this.cfg.fist;
    let best = null;
    for (const h of hands) {
      if (h.held) {
        this.fistSince.delete(h.slot);
        continue;
      }
      const clear = this._clearOfFlowers(h);
      const isFist = h.fist && clear;
      if (!isFist) {
        this.fistSince.delete(h.slot);
        continue;
      }
      if (!this.fistSince.has(h.slot)) this.fistSince.set(h.slot, t);
      const held = t - this.fistSince.get(h.slot);
      if (held >= cfg.sustain * S) best = { h, held };
    }
    if (!best) return false;
    // 全体合拢，PET 归零；1s 内忽略轻触
    this.fistMuteUntil = t + cfg.touchMute * S;
    this.lock = { kind: null, until: 0 };
    this.duetSince = null;
    this.fistSince.clear();
    this._closeAll(t, 'fist', events);
    events.push({ type: 'fist', slot: best.h.slot, at: t });
    return true;
  }

  /**
   * 手心（和指尖）都不能压在任何一朵花上 —— 否则「握着花握拳」会误收拢。
   * 传 hand 或单个点都行。
   */
  _clearOfFlowers(hand) {
    const pts = hand && hand.palm ? [hand.palm, hand.tip].filter(Boolean) : [hand];
    return this.cfg.anchors.every((a) =>
      pts.every((pt) => {
        const p = toMetric(pt);
        return Math.hypot(p.x - a.x, p.y - a.y) > this.cfg.fist.clearAll;
      }),
    );
  }

  _tryDuet(hands, t, cameraLive, events) {
    const cfg = this.cfg.duet;
    if (t < this.cooldown.duetUntil || t < this.fistMuteUntil) {
      this.duetSince = null;
      return false;
    }
    const live = hands.filter((h) => !h.held);
    if (live.length < 2) {
      this.duetSince = null;
      return false;
    }
    const inEnd = (h, side) => {
      const nx = h.tip.x / STAGE.w;
      const ny = h.tip.y / STAGE.h;
      const okX = side === 'L' ? nx <= cfg.sideSplit : nx >= 1 - cfg.sideSplit;
      return okX && ny >= cfg.yMin && ny <= cfg.yMax;
    };
    let pair = null;
    for (let i = 0; i < live.length && !pair; i += 1) {
      for (let j = 0; j < live.length; j += 1) {
        if (i === j) continue;
        if (inEnd(live[i], 'L') && inEnd(live[j], 'R')) {
          pair = [live[i], live[j]];
          break;
        }
      }
    }
    if (!pair) {
      this.duetSince = null;
      return false;
    }
    if (this.duetSince === null) this.duetSince = t;
    if (t - this.duetSince < cfg.sustain * S) return false;

    // 触发 DUET
    this.duetSince = null;
    this.cooldown.duetUntil = t + cfg.cooldown * S;
    this.open = [true, true, true];
    this.openOrder = [0, 1, 2];
    this.pet = 3;
    const seqMs = (cfg.burst + cfg.regroup + cfg.bloom) * S;
    this.lock = { kind: 'duet', until: t + seqMs + cfg.hold * S };
    this._setState(STATE.LOCKED, events);
    this.duetFlashUntil = t + 1500;
    events.push({
      type: 'duet',
      order: [0, 2],
      mid: 1,
      burst: cfg.burst,
      regroup: cfg.regroup,
      bloom: cfg.bloom,
      hold: cfg.hold,
      at: t,
      cameraLive,
    });
    return true;
  }

  _trySweep(hands, t, events) {
    const cfg = this.cfg.sweep;
    if (t < this.cooldown.sweepUntil || t < this.fistMuteUntil) return false;
    let hit = null;
    let hitSlot = -1;
    for (const h of hands) {
      if (h.held) continue;
      const buf = this.sweepBuf.get(h.slot) || [];
      const m = toMetric(h.tip);
      buf.push({ t, x: m.x, y: m.y });
      while (buf.length && t - buf[0].t > cfg.window * S) buf.shift();
      this.sweepBuf.set(h.slot, buf);
      if (!hit) {
        const res = detectSweep(buf, cfg, this.cfg.anchors);
        if (res && res.order) {
          hit = res;
          hitSlot = h.slot;
        }
      }
    }
    // 清理不再出现的槽：留 1.2s 宽限（和「手丢了多久算丢」一致）。
    // 掉一两帧就把缓存清掉，会让「慢慢抚」永远攒不满两次穿过——手机上特别明显
    if (!this.sweepSeen) this.sweepSeen = new Map();
    for (const h of hands) if (!h.held) this.sweepSeen.set(h.slot, t);
    for (const slot of [...this.sweepBuf.keys()]) {
      const seenAt = this.sweepSeen.get(slot) || 0;
      if (!(seenAt > 0) || t - seenAt > 1200) {
        this.sweepBuf.delete(slot);
        this.sweepSeen.delete(slot);
      }
    }
    if (!hit) return false;

    this.cooldown.sweepUntil = t + cfg.cooldown * S;
    this.open = [true, true, true];
    this.openOrder = hit.order.slice();
    this.pet = 3;
    this.lock = {
      kind: 'sweep',
      until: t + (this.cfg.bloom.openDur + cfg.stagger * 2) * S + cfg.hold * S,
    };
    this._setState(STATE.LOCKED, events);
    events.push({
      type: 'sweep',
      order: hit.order,
      dir: hit.dir,
      stagger: cfg.stagger,
      slot: hitSlot,
      at: t,
    });
    return true;
  }

  _tryTouch(hands, t, events) {
    const cfg = this.cfg.touch;
    // 清理消失的手的触点状态
    for (const slot of [...this.touches.keys()]) {
      if (!hands.some((h) => h.slot === slot)) this.touches.delete(slot);
    }
    for (const h of hands) {
      if (h.held) continue;
      // 正在横向抚过去 → 这一下算「抚」不算「摸」（只推迟计数，不动滞回状态）
      const transit = this._inTransit(h.slot, t);
      const m = toMetric(h.tip);
      const dTo = (i) => Math.hypot(m.x - this.cfg.anchors[i].x, m.y - this.cfg.anchors[i].y);
      let nearest = 0;
      let nearestD = dTo(0);
      for (let i = 1; i < 3; i += 1) {
        const d = dTo(i);
        if (d < nearestD) {
          nearestD = d;
          nearest = i;
        }
      }
      let st = this.touches.get(h.slot);
      if (!st) {
        st = { inside: null, since: 0, counted: false };
        this.touches.set(h.slot, st);
      }
      // 滞回：进入 enterR 才算「贴上」，离开 exitR 才算「走开」
      if (st.inside !== null && dTo(st.inside) > cfg.exitR) {
        st.inside = null;
        st.counted = false;
      }
      if (st.inside === null && nearestD <= cfg.enterR) {
        st.inside = nearest;
        st.since = t;
        st.counted = false;
      }
      if (st.inside === null) continue;
      if (
        !st.counted &&
        !transit &&
        dTo(st.inside) <= cfg.enterR &&
        t - st.since >= cfg.dwell * S &&
        t - this.lastTouchCountAt >= cfg.cooldown * S &&
        t >= this.fistMuteUntil
      ) {
        st.counted = true;
        this.lastTouchCountAt = t;
        const target = this._pickTarget(st.inside);
        if (target >= 0) {
          this.open[target] = true;
          this.openOrder = this.openOrder.filter((x) => x !== target).concat(target);
          this.pet = this.open.filter(Boolean).length;
          events.push({ type: 'open', flower: target, reason: 'touch', touched: st.inside, at: t });
          if (this.pet >= 3) {
            this.lock = {
              kind: 'full',
              until: t + this.cfg.bloom.openDur * S + this.cfg.bloom.fullHold * S,
            };
            this._setState(STATE.LOCKED, events);
          }
          return true; // 互斥：一帧只放行一个触发
        }
      }
    }
    return false;
  }

  _pickTarget(touched) {
    if (!this.open[touched]) return touched;
    for (let i = 0; i < 3; i += 1) if (!this.open[i]) return i; // 左→右第一朵未开的
    return -1;
  }

  /** 横抚进度快照（给 HUD 画三个点，纯反馈、不改状态） */
  sweepPreview() {
    let best = { dir: 0, hit: [false, false, false], progress: 0, need: this.cfg.sweep.minCross || 3 };
    for (const [, buf] of this.sweepBuf) {
      if (!buf || buf.length < 2) continue;
      const p = sweepProgress(buf, this.cfg.sweep, this.cfg.anchors);
      if (p.progress > best.progress) best = p;
    }
    return best;
  }

  /** 是否正「横向抚过去」（把「抚」和「摸」分开：抚不算累积） */
  _inTransit(slot, t) {
    const buf = this.sweepBuf.get(slot);
    if (!buf || buf.length < 3) return false;
    const last = buf[buf.length - 1];
    if (t - last.t > 120) return false; // 手已经停下
    let p100 = null;
    let p250 = null;
    for (let i = buf.length - 1; i >= 0; i -= 1) {
      const age = t - buf[i].t;
      if (age > 320) break;
      if (!p100 && age >= 90) p100 = buf[i];
      if (!p250 && age >= 240) p250 = buf[i];
    }
    if (!p100) return false;
    const d1 = Math.abs(last.x - p100.x);
    const d2 = p250 ? Math.abs(last.x - p250.x) : 0;
    // 最近 0.1s 走了 ≥45px，或最近 0.25s 走了 ≥173px → 正在横向抚
    return d1 >= 0.045 || d2 >= 0.16;
  }

  /* ── 收拢 ─────────────────────────────────────────────── */

  _closeAll(t, reason, events) {
    const order = [0, 1, 2];
    this.open = [false, false, false];
    this.pet = 0;
    this.openOrder = [];
    this.lock = { kind: null, until: 0 };
    this._setState(STATE.RESET, events);
    this.resetUntil = t + this.cfg.bloom.closeDur * S + 120;
    events.push({ type: 'close', order, stagger: 0, reason, at: t });
  }

  _closeOrdered(t, reason, events) {
    const order = this.openOrder.length
      ? this.openOrder.filter((i) => this.open[i]).slice().reverse() // 后开先合
      : [2, 1, 0];
    const stagger = this.cfg.bloom.closeStagger * S;
    this.open = [false, false, false];
    this.pet = 0;
    this.openOrder = [];
    this.lock = { kind: null, until: 0 };
    this._setState(STATE.RESET, events);
    this.resetUntil = t + this.cfg.bloom.closeDur * S + stagger * Math.max(0, order.length - 1) + 120;
    events.push({ type: 'close', order, stagger, reason, at: t });
  }

  _decayTransients(hands, t) {
    // 手势计时器在没有触发时自然衰减
    if (this.duetSince !== null && t - this.duetSince > 1500) this.duetSince = null;
    for (const [slot, since] of [...this.fistSince.entries()]) {
      if (t - since > 1500) this.fistSince.delete(slot);
      if (!hands.some((h) => h.slot === slot)) this.fistSince.delete(slot);
    }
  }

  _setState(next, events) {
    if (this.mode === next) return;
    this.mode = next;
    events.push({ type: 'state', state: next, at: this._now });
  }

  _updateHint(t) {
    if (this.mode === STATE.LOCKED) {
      if (this.lock.kind === 'duet') this.hint = '双手摸住两端';
      else if (this.lock.kind === 'sweep') this.hint = '横着抚过去';
      else this.hint = '三朵都开了';
      return;
    }
    if (this.mode === STATE.RESET) {
      this.hint = '花在回拢';
      return;
    }
    if (this.pet === 0) this.hint = '轻触一朵';
    else if (this.pet < 3) this.hint = '再摸一下';
    else this.hint = '三朵都开了';
  }
}

export default InteractionEngine;