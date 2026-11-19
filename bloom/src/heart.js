/**
 * heart.js — 比心彩蛋（v4）
 *
 * 为什么单独做成一块 2D canvas 而不是再进 three.js：
 *   · 这是一次性的 1.6 秒特效，用 points 进场景要新建 geometry/material、还要进 bloom 管线，
 *     成本比收益大；2D canvas 上画光点，叠在暗底上一样亮，还天然不吃 GPU 帧预算；
 *   · 出问题时可以直接 remove()，不会污染 flora 的状态机。
 *
 * 外观：40 颗心形分布的光点从花心向外铺开 + 一个描边心的轮廓淡入，
 * 全部 additive 混合（`lighter`），1.6s 后自己收尾。
 */

const TAU = Math.PI * 2;

/** 心形参数方程（归一化到 ±1） */
function heartPoint(t) {
  const x = 16 * Math.sin(t) ** 3;
  const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
  return { x: x / 17, y: -y / 17 };
}

export class HeartBurst {
  constructor(host) {
    this.host = host;
    this.canvas = null;
    this.raf = 0;
    this.t0 = 0;
    this.parts = [];
    this.duration = 1.6;
  }

  /**
   * @param {object} opts
   * @param {number} opts.x  舞台坐标（0–1080）
   * @param {number} opts.y  舞台坐标（0–1920）
   * @param {string} opts.color 光点颜色（CSS 色）
   * @param {number} opts.scale 尺寸倍率
   */
  play({ x, y, color = '#ffd2dc', scale = 1 } = {}) {
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
    const R = size * 0.26 * scale;

    this.parts = [];
    for (let i = 0; i < 44; i += 1) {
      const t = (i / 44) * TAU;
      const p = heartPoint(t);
      const jitter = 0.86 + Math.random() * 0.3;
      this.parts.push({
        hx: p.x * jitter,
        hy: p.y * jitter,
        // 每颗点自己的出发延迟与大小
        delay: Math.random() * 0.34,
        r: (1.4 + Math.random() * 2.6) * (size / 720),
        drift: 0.16 + Math.random() * 0.3,
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

  _draw(t) {
    const { ctx, dpr, rect, sx, sy, R, color } = this;
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.globalCompositeOperation = 'lighter';

    const p = Math.min(1, t / (this.duration * 0.72));
    const ease = 1 - (1 - p) ** 3;
    const fade = Math.max(0, 1 - Math.max(0, t - this.duration * 0.6) / (this.duration * 0.4));

    // 描边心：先淡入一个轮廓，再散开
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.22 * fade * (0.4 + 0.6 * ease);
    ctx.lineWidth = Math.max(1, 2 * (rect.width / 720));
    ctx.beginPath();
    for (let i = 0; i <= 64; i += 1) {
      const hp = heartPoint((i / 64) * TAU);
      const px = sx + hp.x * R * (0.6 + 0.4 * ease);
      const py = sy + hp.y * R * (0.6 + 0.4 * ease);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();

    // 光点：从中心飞向心形轨迹
    for (const q of this.parts) {
      const local = Math.max(0, Math.min(1, (t - q.delay) / (this.duration * 0.55)));
      if (local <= 0) continue;
      const e = 1 - (1 - local) ** 3;
      const spread = q.hx * R * e + Math.sin(q.seed + t * 3.2) * R * q.drift * 0.08;
      const spreadY = q.hy * R * e + Math.cos(q.seed + t * 2.6) * R * q.drift * 0.08;
      const px = sx + spread;
      const py = sy + spreadY;
      const a = fade * (1 - local * 0.35);
      const rad = q.r * (1 + local * 0.5);
      const g = ctx.createRadialGradient(px, py, 0, px, py, rad * 3);
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = a;
      ctx.fillStyle = g;
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

export default { HeartBurst };