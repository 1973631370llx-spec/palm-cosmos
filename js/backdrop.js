import * as THREE from 'three';
import { CONFIG, PALETTE } from './config.js';
import { mulberry32, srgb } from './utils.js';

/* ------------------------------------------------------------------ */
/* 程序化星云：域扭曲 fbm，靛蓝 / 品红 / 青，压在掌心后方               */
/* ------------------------------------------------------------------ */
const NEB_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const NEB_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uAspect;
uniform float uCollapse;
uniform float uFlash;
uniform float uIntensity;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
uniform vec3 uColorD;
uniform vec3 uCore;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.62, 1.18, -1.18, 1.62);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float ca = cos(-0.42);
  float sa = sin(-0.42);
  vec2 q = vec2(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
  q.y *= 1.75;
  float r = length(q);
  float ang = atan(q.y, q.x);

  vec2 swirl = vec2(cos(ang + r * 2.2 - uTime * 0.02), sin(ang + r * 2.2 - uTime * 0.02)) * r;
  vec2 warp = vec2(
    fbm(swirl * 1.5 + uTime * 0.012),
    fbm(swirl * 1.5 + 7.3 - uTime * 0.009)
  );

  float n = fbm(swirl * 2.1 + warp * 1.3 + vec2(0.0, uTime * 0.008));
  float n2 = fbm(swirl * 4.4 - warp * 1.1 + 11.0);
  float cloud = smoothstep(0.30, 0.92, n * 0.86 + n2 * 0.30 + warp.x * 0.14);

  float lane = smoothstep(0.015, 0.10, abs(q.y + 0.02 * sin(ang * 2.0)));
  float mask = smoothstep(0.62, 0.05, r) * lane;
  float rim = exp(-pow((r - 0.34) / 0.16, 2.0));

  vec3 base = mix(uColorB, uColorA, smoothstep(0.15, 0.9, cloud));
  base = mix(base, uColorC, smoothstep(0.45, 1.0, cloud) * 0.34);
  base = mix(base, uColorD, pow(cloud, 4.0) * 0.18);
  base = mix(base, uCore, exp(-pow(r / 0.10, 2.0)) * 0.12);

  float alpha = cloud * mask * (0.40 + 0.60 * rim);
  alpha *= mix(1.0, 0.5, uCollapse);
  alpha *= 1.0 + uFlash * 0.9;

  gl_FragColor = vec4(base * (0.75 + uFlash * 0.6), alpha * uIntensity);
}
`;

export class Nebula {
  constructor(scene, renderer, camera) {
    this.renderer = renderer;
    this.camera = camera;
    this.uniforms = {
      uTime: { value: 0 },
      uAspect: { value: 1 },
      uCollapse: { value: 0 },
      uFlash: { value: 0 },
      uIntensity: { value: CONFIG.nebula.intensity },
      uColorA: { value: srgb(CONFIG.nebula.colorA) },
      uColorB: { value: srgb(CONFIG.nebula.colorB) },
      uColorC: { value: srgb(CONFIG.nebula.colorC) },
      uColorD: { value: srgb(CONFIG.nebula.colorD) },
      uCore: { value: srgb(CONFIG.nebula.core) },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: NEB_VERT,
      fragmentShader: NEB_FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.mesh.position.set(0, CONFIG.nebula.centerY, CONFIG.nebula.z);
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.resize();
  }

  resize() {
    const cam = this.camera;
    const dist = CONFIG.renderer.cameraZ - CONFIG.nebula.z;
    const h = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * dist;
    const w = h * cam.aspect;
    this.mesh.scale.set(w * 1.05, h * 1.05, 1);
    this.uniforms.uAspect.value = w / h;
    this.mesh.position.y = CONFIG.nebula.centerY;
  }

  update(time, collapse, flash) {
    this.uniforms.uTime.value = time;
    this.uniforms.uCollapse.value = collapse;
    this.uniforms.uFlash.value = flash;
  }
}

/* ------------------------------------------------------------------ */
/* 背景星空：稀疏、幂律大小、冷色                                       */
/* ------------------------------------------------------------------ */
const STAR_VERT = /* glsl */ `
attribute float aSize;
attribute float aSeed;
attribute vec3 aColor;
uniform float uTime;
uniform float uPixelRatio;
uniform float uFlash;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float tw = 0.6 + 0.4 * sin(uTime * (0.35 + aSeed * 0.9) + aSeed * 31.0);
  gl_PointSize = clamp(aSize * uPixelRatio * (1.1 + tw), 0.6, 6.5);
  vColor = aColor;
  vAlpha = (0.18 + tw * 0.5) * (1.0 + uFlash * 0.8);
}
`;

const STAR_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float a = pow(1.0 - d, 2.4);
  gl_FragColor = vec4(vColor, a * vAlpha);
}
`;

export class Starfield {
  constructor(scene, renderer) {
    this.renderer = renderer;
    const count = CONFIG.starfield.count;
    const rng = mulberry32(CONFIG.seed + 77);
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const seed = new Float32Array(count);
    const color = new Float32Array(count * 3);
    const tints = [srgb(0xdfe8ff), srgb(0xa9b8e8), srgb(0xfff2e2), srgb(0xcfe6ff)];

    for (let i = 0; i < count; i++) {
      const u = rng() * 2 - 1;
      const theta = rng() * Math.PI * 2;
      const r = CONFIG.starfield.radius * (0.55 + rng() * 0.55);
      const s = Math.sqrt(1 - u * u);
      pos[i * 3] = Math.cos(theta) * s * r;
      pos[i * 3 + 1] = u * r;
      pos[i * 3 + 2] = Math.sin(theta) * s * r - 12;
      size[i] = 0.35 + Math.pow(rng(), 4.2) * 5.2;
      seed[i] = rng();
      const c = tints[Math.floor(rng() * tints.length)].clone().multiplyScalar(0.45 + rng() * 0.45);
      color[i * 3] = c.r;
      color[i * 3 + 1] = c.g;
      color[i * 3 + 2] = c.b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 80);

    this.uniforms = {
      uTime: { value: 0 },
      uPixelRatio: { value: renderer.getPixelRatio() },
      uFlash: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = -9;
    scene.add(this.points);
  }

  update(time, flash) {
    this.uniforms.uTime.value = time;
    this.uniforms.uFlash.value = flash;
    this.uniforms.uPixelRatio.value = this.renderer?.getPixelRatio?.() ?? 1;
  }
}

/* ------------------------------------------------------------------ */
/* 近景尘埃：三层景深，慢慢漂                                           */
/* ------------------------------------------------------------------ */
const DUST_VERT = /* glsl */ `
attribute float aSize;
attribute float aSeed;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uTime;
uniform float uPixelRatio;
uniform float uCollapse;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec3 p = position;
  float t = uTime * (0.05 + aSeed * 0.08);
  p.x += sin(t + aSeed * 19.0) * 0.35;
  p.y += cos(t * 0.8 + aSeed * 27.0) * 0.28;
  p.z += sin(t * 0.6 + aSeed * 7.0) * 0.2;
  p *= mix(1.0, 0.6, uCollapse);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uPixelRatio * 2.4 / max(-mv.z, 0.5), 0.6, 6.0);
  vColor = aColor;
  vAlpha = aAlpha * (0.6 + 0.4 * uCollapse);
}
`;

const DUST_FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  gl_FragColor = vec4(vColor, pow(1.0 - d, 2.8) * vAlpha);
}
`;

export class Dust {
  constructor(scene, renderer) {
    const count = CONFIG.dust.count;
    const rng = mulberry32(CONFIG.seed + 202);
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const seed = new Float32Array(count);
    const alpha = new Float32Array(count);
    const color = new Float32Array(count * 3);
    const tints = [srgb(PALETTE.indigo), srgb(PALETTE.cyan), srgb(0xfff6e8)];
    const layers = [
      { z0: -3.6, z1: -2.0, size: 0.35, alpha: 0.09, spread: 1.25 },
      { z0: -1.2, z1: 1.2, size: 0.6, alpha: 0.14, spread: 0.9 },
      { z0: 2.0, z1: 4.4, size: 1.0, alpha: 0.20, spread: 0.55 },
    ];

    for (let i = 0; i < count; i++) {
      const L = layers[i % layers.length];
      const r = 0.7 + Math.pow(rng(), 0.7) * CONFIG.dust.spread * L.spread;
      const a = rng() * Math.PI * 2;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = Math.sin(a) * r * 0.72 + CONFIG.nebula.centerY * 0.4;
      pos[i * 3 + 2] = L.z0 + rng() * (L.z1 - L.z0);
      size[i] = 0.3 + Math.pow(rng(), 2.0) * 2.0 * L.size;
      seed[i] = rng();
      alpha[i] = L.alpha * (0.5 + rng() * 0.5);
      const c = tints[Math.floor(rng() * tints.length)];
      color[i * 3] = c.r;
      color[i * 3 + 1] = c.g;
      color[i * 3 + 2] = c.b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 30);

    this.uniforms = {
      uTime: { value: 0 },
      uPixelRatio: { value: renderer.getPixelRatio() },
      uCollapse: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: DUST_VERT,
      fragmentShader: DUST_FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
    scene.add(this.points);
  }

  update(time, collapse) {
    this.uniforms.uTime.value = time;
    this.uniforms.uCollapse.value = collapse;
  }
}