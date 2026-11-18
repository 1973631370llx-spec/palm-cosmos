/**
 * perf.js — 画质分级 governor（只认帧时，其它什么都不做）。
 *
 * 用它的地方（main.js / 我在接）：每帧 tick 里 `governor.sample(dtMs)`，
 * 然后在 `onTier(tier, index)` 里把 tier.dpr / bloomScale / particles / backdropDetail 应用下去。
 * 这个对象不碰 renderer、不碰 DOM、不碰背景 —— 只吃帧间隔、吐档位。
 *
 *   import { TIERS, QualityGovernor } from './perf.js';
 *   const gov = new QualityGovernor({
 *     onTier: (tier, i) => {
 *       renderer.setPixelRatio(tier.dpr); composer.setPixelRatio(tier.dpr);
 *       bloomPass.setSize(w, h * tier.bloomScale); ...
 *       flora.setBudget(tier.particles);
 *       backdrop.setDetail(tier.backdropDetail);
 *     },
 *   });                                  // 构造时就回调一次（保证第一档被应用）
 *   // 每帧：
 *   gov.sample(dtMs);
 *
 * 规则（评审 / 验收要看的数字）：
 *   · 从 0 档（high）开始
 *   · 窗口 1200ms 的**平均**帧时 > 20ms 持续 1.2s → 降一档（掉到 <50fps 就退）
 *   · 平均帧时 < 12ms 持续 4s            → 升一档（>83fps 有余量才升，避免来回抖）
 *   · 每分钟最多变 4 次（force() 不计入，方便测试 / 用户手选）
 *   · 到顶/到底就不再动，且计数清零，不会「攒着」一次跳两档
 */

import { QUALITY } from './theme.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** 三档画质：dpr / bloom 分辨率缩放 / 粒子数 / 背景细节（数值在 theme.js 的 QUALITY 里） */
export const TIERS = QUALITY.tiers;

/** 判据常量（对单元测试和 perf-probe 都可见） */
export const RULES = Object.freeze({
  downMs: QUALITY.downMs, // 平均帧时 > 20ms ≈ <50fps
  upMs: QUALITY.upMs, // 平均帧时 < 12ms ≈ >83fps
  downHoldMs: QUALITY.downHoldMs, // 持续 1.2s 才降
  upHoldMs: QUALITY.upHoldMs, // 持续 4s 才升
  maxChanges: QUALITY.maxChangesPerMin, // 每分钟最多变 4 次
  changeWindowMs: 60000,
  warmupMs: 300, // 开头 300ms 不判断（首帧 shader 编译 / 布局）
});

export class QualityGovernor {
  /**
   * @param {{onTier?: (tier: object, index: number) => void, windowMs?: number}} opts
   */
  constructor({ onTier, windowMs = 1200 } = {}) {
    this.onTier = typeof onTier === 'function' ? onTier : null;
    this.windowMs = Math.max(200, Number(windowMs) || 1200);

    this._buf = []; // 窗口内的 { ms, t }
    this._sum = 0;
    this._clock = 0; // 累计毫秒（= 引擎时间，不受墙钟漂移影响）
    this._index = 0;
    this._downMs = 0;
    this._upMs = 0;
    this._downs = 0;
    this._ups = 0;
    this._changes = []; // 最近的变化时刻（防抖窗口）
    this._lo = now(); // 最近一次墙钟（stats 里算 fps 用）

    this._emit(); // 第一档也要回调一次，确保应用
  }

  /** 当前档位 0..2 */
  get index() {
    return this._index;
  }

  /** 当前档位对象（TIERS[index]） */
  get tier() {
    return TIERS[this._index];
  }

  /** 每帧调用一次：传真实帧间隔（毫秒） */
  sample(dtMs) {
    const ms = clamp(Number(dtMs) || 0, 0, 500);
    if (!(ms > 0)) return;

    this._clock += ms;
    this._buf.push({ ms, t: this._clock });
    this._sum += ms;
    const cut = this._clock - this.windowMs;
    while (this._buf.length > 1 && this._buf[0].t < cut) this._sum -= this._buf.shift().ms;

    if (this._clock < RULES.warmupMs || this._buf.length < 3) return;

    const avg = this._sum / this._buf.length;

    if (avg > RULES.downMs) {
      this._downMs += ms;
      this._upMs = 0;
    } else if (avg < RULES.upMs) {
      this._upMs += ms;
      this._downMs = 0;
    } else {
      // 20–12ms 之间是「够用但没余量」的滞回带：两边计数都清零
      this._downMs = 0;
      this._upMs = 0;
    }

    if (this._downMs >= RULES.downHoldMs) {
      this._downMs = 0;
      if (this._index < TIERS.length - 1 && this._canChange()) {
        this._downs += 1;
        this._apply(this._index + 1);
      }
      return;
    }

    if (this._upMs >= RULES.upHoldMs) {
      this._upMs = 0;
      if (this._index > 0 && this._canChange()) {
        this._ups += 1;
        this._apply(this._index - 1);
      }
    }
  }

  /** 强制档位（并触发 onTier；不计入防抖窗口） */
  force(i) {
    const v = clamp(Math.round(Number(i) || 0), 0, TIERS.length - 1);
    this._index = v;
    this._downMs = 0;
    this._upMs = 0;
    this._emit();
    return TIERS[v];
  }

  /** { fps, avgMs, p95Ms, tier, downs, ups }（tier 是名字，另附 index） */
  stats() {
    const n = this._buf.length;
    const sum = this._sum;
    const avgMs = n ? sum / n : 0;
    let p95Ms = 0;
    if (n) {
      const sorted = this._buf.map((s) => s.ms).sort((a, b) => a - b);
      p95Ms = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
    }
    const wall = now();
    const dtWall = wall - this._lo;
    // fps 用「窗口内帧数 / 窗口时长（引擎时间）」算，不受调用频率影响
    const fps = avgMs > 0 ? 1000 / avgMs : 0;
    return {
      fps: +fps.toFixed(1),
      avgMs: +avgMs.toFixed(2),
      p95Ms: +p95Ms.toFixed(2),
      tier: TIERS[this._index].name,
      index: this._index,
      downs: this._downs,
      ups: this._ups,
      frames: n,
      windowMs: this.windowMs,
      wallMs: +dtWall.toFixed(1),
    };
  }

  /** 换档并回调（内部用） */
  _apply(i) {
    this._index = clamp(i, 0, TIERS.length - 1);
    this._changes.push(this._clock);
    this._emit();
  }

  _emit() {
    if (this.onTier) this.onTier(TIERS[this._index], this._index);
  }

  /** 每分钟最多 4 次 */
  _canChange() {
    const cut = this._clock - RULES.changeWindowMs;
    this._changes = this._changes.filter((t) => t >= cut);
    return this._changes.length < RULES.maxChanges;
  }
}

export default QualityGovernor;