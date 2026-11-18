import { Color } from 'three';

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => clamp((v - a) / (b - a), 0, 1);
export const smoothstep = (a, b, v) => {
  const t = invLerp(a, b, v);
  return t * t * (3 - 2 * t);
};
export const damp = (cur, target, lambda, dt) =>
  target + (cur - target) * Math.exp(-lambda * dt);

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(rng) {
  // Box–Muller，一次取两个值只用第一个足够稳定
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const dist2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function srgb(hex) {
  return new Color(hex).convertSRGBToLinear();
}

export function srgbArray(hex) {
  const c = srgb(hex);
  return [c.r, c.g, c.b];
}

/** 临界阻尼弹簧，带惯性。 */
export class Spring {
  constructor(value = 0, stiffness = 40, damping = 9) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.stiffness = stiffness;
    this.damping = damping;
  }

  step(dt) {
    const d = Math.min(dt, 1 / 24);
    const accel = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
    this.velocity += accel * d;
    this.value += this.velocity * d;
    return this.value;
  }

  reset(value = this.target) {
    this.value = value;
    this.velocity = 0;
  }
}

export function formatNumber(n) {
  return n.toLocaleString('en-US');
}

/** 跟随弹簧：按 60Hz 步长归一化，k=0.08 / 阻尼 0.85。带惯性，不抖动。 */
/** One Euro Filter：指尖星用它，慢速不抖、快速不拖。 */
export class OneEuroFilter {
  constructor({ minCutoff = 1.2, beta = 0.02, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x, t) {
    const dt = this.tPrev == null ? 1 / 60 : Math.max(1e-3, t - this.tPrev);
    this.tPrev = t;
    if (this.xPrev == null) {
      this.xPrev = x;
      return x;
    }
    const dx = (x - this.xPrev) / dt;
    const aD = OneEuroFilter.alpha(this.dCutoff, dt);
    this.dxPrev = this.dxPrev + aD * (dx - this.dxPrev);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxPrev);
    const a = OneEuroFilter.alpha(cutoff, dt);
    this.xPrev = this.xPrev + a * (x - this.xPrev);
    return this.xPrev;
  }

  reset() {
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }
}

/** 跟随弹簧：用 SmoothDamp（临界阻尼、无过 shoot）实现，不会橡皮筋。 */
export class InertialSpring {
  constructor(value = 0, k = 0.08, damping = 0.85) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.k = k;
    this.damping = damping;
    this.maxSpeed = 34;
  }

  step(dt) {
    const smoothTime = Math.max(0.02, 0.9 / (60 * this.k));
    return (this.value = smoothDamp(this.value, this.target, this, smoothTime, this.maxSpeed, dt));
  }

  reset(value = this.target) {
    this.value = value;
    this.velocity = 0;
  }
}

/** Unity 同款临界阻尼跟随：无超调、有速度上限。 */
export function smoothDamp(cur, target, velRef, smoothTime, maxSpeed, dt) {
  const d = Math.min(dt, 0.05);
  const omega = 2 / smoothTime;
  const x = omega * d;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  let change = cur - target;
  const maxChange = maxSpeed * smoothTime;
  change = clamp(change, -maxChange, maxChange);
  const temp = (velRef.velocity + omega * change) * d;
  velRef.velocity = (velRef.velocity - omega * temp) * exp;
  let out = target + (change + temp) * exp;
  if ((target - cur > 0) === (out > target)) {
    out = target;
    velRef.velocity = 0;
  }
  return out;
}

export function isCoarsePointer() {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}