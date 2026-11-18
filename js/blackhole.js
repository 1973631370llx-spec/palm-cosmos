import * as THREE from 'three';
import { CONFIG } from './config.js';
import { srgb, smoothstep, clamp } from './utils.js';

const LENS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const LENS_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uStrength;
uniform vec3 uColA;
uniform vec3 uColB;

void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  if (r > 0.995) discard;
  float ang = atan(p.y, p.x);

  // 一圈很细的引力透镜光环 + 极淡的晕
  float ring = exp(-pow((r - 0.50) / 0.016, 2.0));
  float halo = exp(-pow((r - 0.50) / 0.12, 2.0)) * 0.10;
  float flick = 0.92 + 0.08 * sin(uTime * 0.7 + ang * 3.0);

  // 上下被拉开的细弧（透镜效应）
  float arc = exp(-pow((abs(p.x) - 0.47) / 0.035, 2.0))
            * smoothstep(0.12, 0.62, abs(p.y)) * 0.22;

  vec3 col = mix(uColA, uColB, 0.28 + 0.22 * sin(ang * 2.0 + uTime * 0.25));
  float a = (ring + halo + arc) * flick * uStrength;
  gl_FragColor = vec4(col, a);
}
`;

export class BlackHole {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'blackhole';

    this.horizon = new THREE.Mesh(
      new THREE.SphereGeometry(1, 48, 32),
      new THREE.MeshBasicMaterial({ color: 0x000000, depthWrite: true, depthTest: true })
    );
    this.horizon.renderOrder = 1;
    this.horizon.visible = false;
    this.group.add(this.horizon);

    this.uniforms = {
      uTime: { value: 0 },
      uStrength: { value: 0 },
      uColA: { value: srgb(CONFIG.blackhole.lensColorA) },
      uColB: { value: srgb(CONFIG.blackhole.lensColorB) },
    };
    const lensMat = new THREE.ShaderMaterial({
      vertexShader: LENS_VERT,
      fragmentShader: LENS_FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.lens = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), lensMat);
    this.lens.renderOrder = 4;
    this.lens.frustumCulled = false;
    this.lens.visible = false;
    this.group.add(this.lens);
  }

  update(time, collapse, flash, scale = 1, lensExtra = 0) {
    this.uniforms.uTime.value = time;
    // 只有真正握紧（collapse > 0.7）才出现视界；捏合/半收缩只留下透镜环
    const k = smoothstep(0.70, 0.96, collapse);
    const lensAmt = clamp(k + lensExtra * 0.9, 0, 1);
    this.horizon.visible = k > 0.01;
    this.lens.visible = lensAmt > 0.02;

    if (this.horizon.visible) {
      const s = CONFIG.blackhole.horizon * k * scale;
      this.horizon.scale.setScalar(s * (1.0 + flash * 0.15));
    }

    if (this.lens.visible) {
      const s = CONFIG.blackhole.horizon * (0.42 + 0.58 * Math.max(k, lensExtra * 0.55)) * scale;
      this.lens.scale.set(s * (3.2 + 0.7 * lensExtra), s * (2.2 + 0.6 * lensExtra), 1);
      this.uniforms.uStrength.value = lensAmt * (0.85 + flash * 0.6);
    }
  }
}