/**
 * heart.js — 手势图案层（v4：比心；v4.2：OK → 圆 · 耶/叶 → 叶 · 星 · 花）
 *
 * 为什么单独做成一块 2D canvas 而不是再进 three.js：
 *   · 都是一次性的 1.6–2.0 秒特效，用 points 进场景要新建 geometry/material、还要进 bloom 管线，
 *     成本比收益大；2D canvas 上画光点，叠在暗底上一样亮，还天然不吃 GPU 帧预算；
 *   · 出问题时可以直接 remove()，不会污染 flora 的状态机。
 *
 * 每种图形 = 一条「单位轮廓」+ 沿轮廓铺的光点 + 从中心长出来的动画。
 * v4.2 把心画大了（R 从 0.26 → 0.42 短边），轮廓画两遍（粗光边 + 细亮线），
 * 中间补一层柔光填充，所以远看就是一颗心，不是一圈点。
 */

const TAU = Math.PI * 2;

/** 心形参数方程（归一化到 ±1；16/17 / 17 让它占满单位方框） */
function heartPoint(t) {
  const x = 16 * Math.sin(t) ** 3;
  const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
  return { x: x / 17, y: -y / 17 };
}

/** 单位轮廓：返回 t∈[0,1) → {x,y}，都在 ±1 内 */
const OUTLINES = {
  heart: (t) => heartPoint(t * TAU),
  /** 圆：OK 手势 */
  ring: (t) => {
    const a = t * TAU - Math.PI / 2;
    return { x: Math.cos(a), y: Math.sin(a) };
  },
  /** 叶片：两条对称弧（矢状形），尖端上下 */
  leaf: (t) => {
    const a = t * TAU;
    const v = Math.sin(a); // -1..1 纵向
    const halfW = 0.62 * Math.sqrt(Math.max(0, 1 - v * v)) * (a < Math.PI ? 1 : 1);
    return { x: Math.cos(a) * halfW, y: -v };
  },
  /** 星形：五角，外 1 / 内 0.42 */
  star: (t) => {
    const a = t * TAU - Math.PI / 2;
    const lobe = Math.abs(Math.cos((5 * a) / 2));
    const r = 0.42 + 0.58 * lobe ** 0.9;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  },
  /** 六瓣花 */
  petal: (t) => {
    const a = t * TAU;
    const r = 0.45 + 0.55 * Math.abs(Math.cos(3 * a));
    return { x: Math.cos(a) * r, y: Math.sin(a) * r };
  },
};

export const MOTIFS = Object.freeze(Object.keys(OUTLINES));

export class MotifFx {
  constructor(host) {
    this.host = host;
    this.canvas = null;
    this.raf = 0;
    this.t0 = 0;
    this.parts = [];
    this.duration = 1.9;
    this.shape = 'heart';
  }

  /**
   * @param {object} opts
   * @param {number} opts.x  舞台坐标（0–1080）
   * @param {number} opts.y  舞台坐标（0–1920）
   * @param {string} opts.color 光点颜色（CSS 色）
   * @param {number} opts.scale 尺寸倍率
   * @param {string} opts.shape heart | ring | leaf | star | petal
   */
  play({ x, y, color = '#ffd2dc', scale = 1, shape = 'heart' } = {}) {
    if (typeof document === 'undefined') return;
    this.stop();

    const host = this.host || document.body;
    const rect = host.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    canvas.className = 'heart-fx';
    canvas.setAttribute('aria-hidden', 'true');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    host.appendChild(canvas);
    this.canvas = canvas;

    // 舞台坐标 → 宿主像素
    const sx = (x / 1080) * rect.width;
    const sy = (y / 1920) * rect.height;
    const size = Math.min(rect.width, rect.height);
    // v4.2：心要「像心」，得占满画面中央一大块 —— 0.26 → 0.42
    const base = shape === 'heart' ? 0.42 : 0.36;
    const R = size * base * scale;

    this.shape = OUTLINES[shape] ? shape : 'heart';
    this.outline = OUTLINES[this.shape];
    this.duration = this.shape === 'heart' ? 2.0 : 1.8;

    const N = this.shape === 'heart' ? 84 : 64;
    this.parts = [];
    for (let i = 0; i < N; i += 1) {
      const t = i / N;
      const p = this.outline(t);
      const jitter = 0.9 + Math.random() * 0.18;
      this.parts.push({
        hx: p.x * jitter,
        hy: p.y * jitter,
        delay: Math.random() * 0.3,
        r: (1.5 + Math.random() * 2.8) * (size / 720),
        drift: 0.14 + Math.random() * 0.26,
        seed: Math.random() * TAU,
      });
    }

    this.ctx = canvas.getContext('2d');
    this.dpr = dpr;
    this.rect = rect;
    this.sx = sx;
    this.sy = sy;
    this.R = R;
    this.color = color;
    this.t0 = performance.now();

    const frame = () => {
      const now = performance.now();
      const t = (now - this.t0) / 1000;
      if (t >= this.duration || !this.ctx) {
        this.stop();
        return;
      }
      this._draw(t);
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  _path(ease) {
    const { ctx, sx, sy, R, outline } = this;
    const k = 0.55 + 0.45 * ease;
    ctx.beginPath();
    for (let i = 0; i <= 128; i += 1) {
      const p = outline(i / 128);
      const px = sx + p.x * R * k;
      const py = sy + p.y * R * k;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  _draw(t) {
    const { ctx, dpr, rect, sx, sy, R, color } = this;
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.globalCompositeOperation = 'lighter';

    const p = Math.min(1, t / (this.duration * 0.5));
    const ease = 1 - (1 - p) ** 3;
    const fade = Math.max(0, 1 - Math.max(0, t - this.duration * 0.62) / (this.duration * 0.38));
    const unit = rect.width / 720;

    // ① 轮廓：粗光边 + 细亮线，两遍叠出「笔画感」
    this._path(ease);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.3 * fade * (0.35 + 0.65 * ease);
    ctx.lineWidth = Math.max(2, 7 * unit);
    ctx.stroke();
    ctx.globalAlpha = 0.72 * fade * (0.35 + 0.65 * ease);
    ctx.lineWidth = Math.max(1, 2.2 * unit);
    ctx.stroke();

    // ② 柔光填充：让轮廓里面也亮，远看是一整颗心
    if (this.shape === 'heart' || this.shape === 'petal') {
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, R * 0.95);
      g.addColorStop(0, color);
      g.addColorStop(0.55, 'rgba(255,255,255,0.06)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = 0.2 * fade * ease;
      ctx.fillStyle = g;
      ctx.fill();
    }

    // ③ 光点：从中心飞到轮廓上
    for (const q of this.parts) {
      const local = Math.max(0, Math.min(1, (t - q.delay) / (this.duration * 0.42)));
      if (local <= 0) continue;
      const e = 1 - (1 - local) ** 3;
      const px = sx + q.hx * R * e + Math.sin(q.seed + t * 3.2) * R * q.drift * 0.07;
      const py = sy + q.hy * R * e + Math.cos(q.seed + t * 2.6) * R * q.drift * 0.07;
      const a = fade * (1 - local * 0.3);
      const rad = q.r * (1 + local * 0.45);
      const g2 = ctx.createRadialGradient(px, py, 0, px, py, rad * 3);
      g2.addColorStop(0, color);
      g2.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = a;
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.arc(px, py, rad * 3, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.canvas = null;
    this.ctx = null;
  }
}

/** 旧名字，main.js / 测试里还在用 */
export class HeartBurst extends MotifFx {}

export default { MotifFx, HeartBurst, MOTIFS };