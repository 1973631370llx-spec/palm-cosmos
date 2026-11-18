import * as THREE from 'three';
import { CONFIG } from './config.js';
import { clamp, srgb } from './utils.js';

const WAVE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const WAVE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uProgress;
uniform float uTime;
uniform float uFlash;
uniform vec3 uColA;
uniform vec3 uColB;

void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  if (r > 1.0) discard;
  float ang = atan(p.y, p.x);

  // 一根细而干净的冲击波环，边缘带一点细丝
  float edge = mix(0.012, 0.045, uProgress);
  float ring = exp(-pow((r - 0.86) / edge, 2.0)) * pow(1.0 - uProgress, 1.2);
  float hair = 0.82 + 0.18 * sin(ang * 13.0 + uTime * 2.0) * sin(ang * 5.0);
  float inner = exp(-pow(r / (0.42 * (1.0 - uProgress) + 0.02), 2.0)) * uFlash * 0.5;

  vec3 col = mix(uColA, uColB, smoothstep(0.1, 0.85, uProgress) * 0.5);
  gl_FragColor = vec4(col, ring * hair + inner);
}
`;

export class Supernova {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'supernova';
    this.group.visible = false;
    scene.add(this.group);

    this.uniforms = {
      uProgress: { value: 0 },
      uTime: { value: 0 },
      uFlash: { value: 0 },
      uColA: { value: srgb(0xe9fbff) },
      uColB: { value: srgb(0xff3d81) },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: WAVE_VERT,
      fragmentShader: WAVE_FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.ring.frustumCulled = false;
    this.ring.renderOrder = 5;
    this.group.add(this.ring);

    this.active = false;
    this.t = 0;
    this.power = 1;
    this.values = { flash: 0, burst: 0, tint: new THREE.Color(1, 1, 1), progress: 0 };
    this._tintTarget = new THREE.Color();
  }

  trigger(power = 1) {
    this.active = true;
    this.t = 0;
    this.power = power;
    this.group.visible = true;
  }

  update(dt, time) {
    const v = this.values;
    this.uniforms.uTime.value = time;

    if (!this.active) {
      v.flash = 0;
      v.burst = 0;
      v.tint.setRGB(1, 1, 1);
      v.progress = 0;
      return v;
    }

    this.t += dt;
    const dur = CONFIG.supernova.duration;
    const p = clamp(this.t / dur, 0, 1);
    v.progress = p;

    const flashDur = CONFIG.supernova.flashMs / 1000;
    v.flash = Math.pow(Math.max(0, 1 - this.t / flashDur), 1.8) * Math.min(1.2, this.power);

    // 冲击波 0.4s，粒子径向冲量 2s 余波
    const shock = clamp(this.t / (CONFIG.supernova.shockMs / 1000), 0, 1);
    v.burst =
      (this.t < 0.4 ? shock : Math.pow(Math.max(0, 1 - (this.t - 0.4) / 1.6), 2.0)) * this.power;

    const tintAmt = Math.pow(Math.max(0, 1 - this.t / 1.6), 2.0);
    this._tintTarget.setRGB(1.0 + 0.10 * tintAmt, 0.92 + 0.04 * tintAmt, 1.0 + 0.16 * tintAmt);
    v.tint.lerp(this._tintTarget, 0.25);

    this.uniforms.uProgress.value = clamp(this.t / 0.8, 0, 1);
    this.uniforms.uFlash.value = v.flash;

    const ease = 1 - Math.pow(1 - clamp(this.t / 0.4, 0, 1), 3);
    const size = (0.4 + ease * CONFIG.supernova.shockRadius) * this.power;
    this.ring.scale.set(size, size, 1);

    if (p >= 1) {
      this.active = false;
      this.group.visible = false;
      v.burst = 0;
      v.flash = 0;
    }
    return v;
  }
}