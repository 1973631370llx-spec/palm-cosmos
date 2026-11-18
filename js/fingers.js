import * as THREE from 'three';
import { srgb, OneEuroFilter, clamp } from './utils.js';

const TRAIL_LEN = 24;
const PER_HAND = 5;
const MAX_STARS = PER_HAND * 2;

const COLORS = [
  [0xfff6e8, 0x35e0d0, 0xfff6e8, 0xff3d81, 0x2a3bff],
  [0xff3d81, 0xfff6e8, 0x35e0d0, 0x2a3bff, 0xfff6e8],
];

function makeStarTexture() {
  const s = 96;
  const canvas = document.createElement('canvas');
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(255,255,255,0.7)');
  g.addColorStop(0.55, 'rgba(160,200,255,0.22)');
  g.addColorStop(1, 'rgba(80,0,140,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class FingerStars {
  constructor(scene, filterOpts) {
    this.group = new THREE.Group();
    this.group.name = 'finger-stars';
    scene.add(this.group);
    this.filterOpts = filterOpts || { minCutoff: 1.2, beta: 0.02, dCutoff: 1.0 };

    const tex = makeStarTexture();
    this.items = [];
    for (let i = 0; i < MAX_STARS; i++) {
      const hand = Math.floor(i / PER_HAND);
      const hex = COLORS[hand][i % PER_HAND];

      const mat = new THREE.SpriteMaterial({
        map: tex,
        color: hex,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        opacity: 0,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.setScalar(0.2);
      sprite.renderOrder = 6;
      sprite.visible = false;
      this.group.add(sprite);

      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(TRAIL_LEN * 3);
      const col = new Float32Array(TRAIL_LEN * 3);
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const lineMat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        opacity: 0.9,
      });
      const line = new THREE.Line(geo, lineMat);
      line.frustumCulled = false;
      line.renderOrder = 5;
      line.visible = false;
      this.group.add(line);

      this.items.push({
        sprite,
        line,
        mat,
        lineMat,
        geo,
        color: srgb(hex),
        phase: i * 1.7,
        filters: [
          new OneEuroFilter(this.filterOpts),
          new OneEuroFilter(this.filterOpts),
          new OneEuroFilter(this.filterOpts),
        ],
        burstDir: new THREE.Vector3(0, 1, 0),
        pos: new THREE.Vector3(),
        history: Array.from({ length: TRAIL_LEN }, () => new THREE.Vector3()),
        head: 0,
        filled: 0,
        active: false,
      });
    }
    this._eject = 0;
    this._tmp = new THREE.Vector3();
  }

  reset() {
    for (const it of this.items) {
      it.active = false;
      it.filled = 0;
      it.head = 0;
      it.sprite.visible = false;
      it.line.visible = false;
      it.mat.opacity = 0;
    }
  }

  /**
   * points: 最多 10 个指尖世界坐标（前 5 左手，后 5 右手；缺省 null）
   * fx: { suck, eject, center:{x,y}, point:[bool,bool] }
   * time 与 px 用于 One Euro 的时间戳
   */
  update(points, time, opacity = 1, fx = null, active = null) {
    const suck = fx ? fx.suck || 0 : 0;
    const eject = fx ? fx.eject || 0 : 0;
    const center = fx ? fx.center : null;
    const point = (fx && fx.point) || [false, false];

    if (eject > 0 && this._eject === 0) {
      for (const it of this.items) {
        const d = this._tmp.copy(it.pos);
        if (center) {
          d.x -= center.x;
          d.y -= center.y;
        }
        if (d.lengthSq() < 1e-4) d.set(Math.random() - 0.5, Math.random() - 0.5, 0);
        it.burstDir.copy(d.normalize());
      }
    }
    this._eject = eject;

    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      const hand = Math.floor(i / PER_HAND);
      const p = points ? points[i] : null;
      const on = !!p && (!active || active[hand] !== false);

      if (!on) {
        it.active = false;
        it.sprite.visible = false;
        it.line.visible = false;
        it.mat.opacity = 0;
        it.filled = 0;
        continue;
      }

      it.active = true;
      const bob = 0.012 * Math.sin(time * 2.4 + it.phase);

      let tx = it.filters[0].filter(p.x, time);
      let ty = it.filters[1].filter(p.y, time) + bob;
      let tz = it.filters[2].filter(p.z, time);

      if (suck > 0 && center) {
        const k = Math.min(1, suck) * 0.94;
        tx += (center.x - tx) * k;
        ty += (center.y - ty) * k;
        tz += (0 - tz) * k;
      }
      if (eject > 0) {
        const d = eject * 3.2;
        tx += it.burstDir.x * d;
        ty += it.burstDir.y * d;
        tz += it.burstDir.z * d * 0.5;
      }

      it.pos.set(tx, ty, tz);
      it.sprite.position.copy(it.pos);
      it.sprite.visible = true;

      const tw = 0.82 + 0.18 * Math.sin(time * 3.1 + it.phase * 2.0);
      const isPointing = point[hand] && i % PER_HAND === 1;
      const boost = isPointing ? 1.9 : 1.0;
      const shrink = 1 - suck * 0.55 + eject * 0.25;
      it.sprite.scale.setScalar(0.2 * tw * shrink * boost);
      it.mat.opacity =
        clamp(opacity * (0.75 + 0.25 * tw) * (1 - eject * 0.85) * (1 - suck * 0.35) * (isPointing ? 1.3 : 1), 0, 1);

      // 环形缓冲，不分配、不搬数组
      const h = it.history[it.head];
      h.copy(it.pos);
      it.head = (it.head + 1) % TRAIL_LEN;
      it.filled = Math.min(it.filled + 1, TRAIL_LEN);

      const pos = it.geo.attributes.position.array;
      const col = it.geo.attributes.color.array;
      for (let k = 0; k < TRAIL_LEN; k++) {
        const idx = (it.head - 1 - k + TRAIL_LEN * 2) % TRAIL_LEN;
        const hh = it.history[idx];
        pos[k * 3] = hh.x;
        pos[k * 3 + 1] = hh.y;
        pos[k * 3 + 2] = hh.z;
        const age = k / TRAIL_LEN;
        const f = Math.pow(1 - age, 2.2) * Math.min(1, it.filled / 3) * (1 - eject);
        col[k * 3] = it.color.r * f;
        col[k * 3 + 1] = it.color.g * f;
        col[k * 3 + 2] = it.color.b * f;
      }
      it.geo.attributes.position.needsUpdate = true;
      it.geo.attributes.color.needsUpdate = true;
      it.line.visible = it.filled > 2;
      it.lineMat.opacity = 0.9 * clamp((1 - eject) * opacity, 0, 1);
    }
  }
}