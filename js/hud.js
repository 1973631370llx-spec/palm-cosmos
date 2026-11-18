import { CONFIG } from './config.js';
import { HAND_BONES } from './hands.js';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor() {
    this.el = {
      state: $('stateVal'),
      mass: $('massVal'),
      spin: $('spinVal'),
      count: $('countVal'),
      fps: $('fpsVal'),
      dpr: $('dprVal'),
      camDot: $('camDot'),
      camLabel: $('camLabel'),
      camMode: $('camMode'),
      flash: $('flash'),
      gate: $('gate'),
      hint: $('hint'),
      overlay: $('overlay'),
      status: $('statusBox'),
      delegate: $('delegateVal'),
      dbg: $('debugPanel'),
      dbgFps: $('dbgFps'),
      dbgLat: $('dbgLat'),
      dbgMode: $('dbgMode'),
      dbgAnchor: $('dbgAnchor'),
      dbgHands: $('dbgHands'),
      preload: $('gatePreload'),
    };
    this.overlay = this.el.overlay;
    this.ctx = this.overlay.getContext('2d');
    this.fpsAccum = 0;
    this.fpsFrames = 0;
    this.lastFpsAt = 0;
    this.flashUntil = 0;
    this.lastDebugAt = 0;
    this.resize();
  }

  setDebug(on) {
    if (this.el.dbg) this.el.dbg.hidden = !on;
    this.debug = !!on;
  }

  updateDebug(fps, latencyMs, mode, anchor, now, handCount = 0) {
    if (!this.debug || !this.el.dbg) return;
    if (now - this.lastDebugAt < 200) return;
    this.lastDebugAt = now;
    if (this.el.dbgFps) this.el.dbgFps.textContent = fps.toFixed(0);
    if (this.el.dbgLat) this.el.dbgLat.textContent = latencyMs > 0 ? latencyMs.toFixed(1) : '–';
    if (this.el.dbgMode) this.el.dbgMode.textContent = mode.toUpperCase();
    if (this.el.dbgAnchor) {
      this.el.dbgAnchor.textContent = anchor
        ? `${Math.round(anchor.x)}, ${Math.round(anchor.y)}`
        : '—';
    }
    if (this.el.dbgHands) this.el.dbgHands.textContent = String(handCount);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.overlay.width = Math.round(w * dpr);
    this.overlay.height = Math.round(h * dpr);
    this.overlay.style.width = w + 'px';
    this.overlay.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
  }

  showGate(show) {
    this.el.gate.classList.toggle('hidden', !show);
  }

  setCameraLabel(text, live) {
    if (this.el.camLabel) this.el.camLabel.textContent = text;
    if (this.el.camDot) this.el.camDot.classList.toggle('live', !!live);
  }

  setDelegate(text) {
    if (this.el.delegate) this.el.delegate.textContent = text;
  }

  setHint(text) {
    if (this.el.hint && this.el.hint.textContent !== text) this.el.hint.textContent = text;
  }

  /** 面板上的模型加载进度（0–1；<0 表示失败）。 */
  setPreload(p) {
    const el = this.el.preload;
    const bar = document.getElementById('gateBar');
    if (!el) return;
    if (p == null || p < 0) {
      el.hidden = false;
      el.innerHTML = '模型加载失败 · 点「开启掌心」会重试';
      if (bar) bar.hidden = true;
      return;
    }
    const pct = Math.round(Math.min(1, p) * 100);
    el.hidden = false;
    const b = el.querySelector('b');
    if (b) b.textContent = `${pct}%`;
    // 按钮副标题也报进度：拇指底下就能看到，不用找小字
    const btnEn = document.querySelector('#btnCamera .en');
    if (btnEn) btnEn.textContent = pct >= 100 ? 'READY · 点击进入' : `模型 ${pct}%`;
    const hint = document.getElementById('gatePreloadHint');
    if (hint) hint.textContent = pct >= 100 ? ' · 已就绪' : ' · 首次约 20 秒';
    el.style.color = pct >= 100 ? 'rgba(255,246,232,0.5)' : 'rgba(53,224,208,0.72)';
    if (bar) {
      bar.hidden = false;
      bar.classList.toggle('ready', pct >= 100);
      const fill = bar.querySelector('i');
      if (fill) fill.style.width = `${pct}%`;
    }
  }

  setState(name, detail) {
    const el = this.el.state;
    if (!el) return;
    if (el.textContent !== name) el.textContent = name;
    el.dataset.state = detail || name.toLowerCase();
  }

  updateStats(spin, mass, count, dpr) {
    if (this.el.spin) this.el.spin.textContent = spin.toFixed(2);
    if (this.el.mass) this.el.mass.textContent = mass.toFixed(2);
    if (this.el.count) this.el.count.textContent = String(count);
    if (this.el.dpr) this.el.dpr.textContent = Math.min(dpr, CONFIG.renderer.dprMax).toFixed(1);
  }

  tickFps(now, dt) {
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (now - this.lastFpsAt > 480) {
      const fps = this.fpsFrames / Math.max(this.fpsAccum, 0.001);
      if (this.el.fps) this.el.fps.textContent = fps.toFixed(0);
      this.fpsAccum = 0;
      this.fpsFrames = 0;
      this.lastFpsAt = now;
    }
  }

  flash(strength) {
    if (!this.el.flash) return;
    this.el.flash.style.opacity = String(Math.max(0, Math.min(1, strength)));
  }

  drawOverlay(hands, collapse = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!hands || !hands.length || !CONFIG.hand.skeleton) return;

    const scale = Math.min(this.w, this.h);

    for (const hand of hands) {
      const points = hand.screen;
      if (!points || !points.length) continue;

      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = hand.pinch ? 'rgba(255, 61, 129, 0.26)' : 'rgba(53, 224, 208, 0.18)';
      ctx.beginPath();
      for (const [a, b] of HAND_BONES) {
        const p = points[a];
        const q = points[b];
        if (!p || !q) continue;
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();

      ctx.fillStyle = 'rgba(255, 246, 232, 0.4)';
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (!p) continue;
        const big = i === 0 || i % 4 === 0;
        ctx.beginPath();
        ctx.arc(p.x, p.y, big ? 2 : 1.2, 0, Math.PI * 2);
        ctx.fill();
      }

      // 掌心锚点：虚线环 + 四角刻度
      const anchor = hand.anchor;
      if (anchor) {
        const r = scale * (0.062 + 0.018 * (1 - collapse));
        ctx.translate(anchor.x, anchor.y);
        ctx.strokeStyle = `rgba(255, 61, 129, ${0.14 + (1 - collapse) * 0.14})`;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 7]);
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.strokeStyle = `rgba(53, 224, 208, ${0.24 + (1 - collapse) * 0.18})`;
        const t = r * 1.22;
        for (let i = 0; i < 4; i++) {
          const a = (i * Math.PI) / 2 + Math.PI / 4;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * t, Math.sin(a) * t);
          ctx.lineTo(Math.cos(a) * (t + 7), Math.sin(a) * (t + 7));
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }
}