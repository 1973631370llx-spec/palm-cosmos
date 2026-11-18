import * as THREE from 'three';
import { CONFIG } from './config.js';
import { mulberry32, gauss, srgb } from './utils.js';

/* PALM COSMOS - galaxy: 2-arm spiral, power-law stars, edge-lit collapse. */

const VERT = /* glsl */ `
attribute float aRadius;
attribute float aAngle;
attribute float aHeight;
attribute float aSize;
attribute float aSeed;
attribute float aBright;
attribute vec3 aColor;

uniform float uTime;
uniform float uSpin;
uniform float uCollapse;
uniform float uOpen;
uniform float uBurst;
uniform float uScale;
uniform float uPixelRatio;
uniform float uPointScale;
uniform float uFlash;
uniform vec3 uTint;
uniform float uAlpha;

varying vec3 vColor;
varying float vAlpha;

void main() {
  float r = aRadius;
  float t = uTime;

  float ang = aAngle + t * uSpin * (0.55 + 1.0 / (0.35 + r * 2.0));

  float radius = r * R_MAX;
  radius *= mix(1.0, 1.12, uOpen);
  float collapsed = radius * 0.24 + 0.02;
  collapsed = max(collapsed, 0.30);
  radius = mix(radius, collapsed, uCollapse);
  ang += uCollapse * (1.6 + 3.4 * (1.0 - r));

  vec2 radial = vec2(cos(ang), sin(ang));
  radius += uBurst * (0.22 + aSeed * 0.8) * 1.5;

  float height = aHeight * THICK * (1.0 - 0.90 * uCollapse) * (1.0 + 0.85 * uOpen);
  height += uBurst * (aSeed - 0.5) * 0.7;

  vec3 p = vec3(radial.x * radius, height, radial.y * radius);

  float jitter = 0.008 + 0.03 * uOpen + 0.014 * uCollapse;
  p.x += sin(t * 1.1 + aSeed * 43.0) * jitter;
  p.y += cos(t * 0.9 + aSeed * 91.0) * jitter;
  p.z += sin(t * 0.8 + aSeed * 17.0) * jitter;

  vec4 mv = modelViewMatrix * vec4(p * uScale, 1.0);
  gl_Position = projectionMatrix * mv;

  float dist = max(-mv.z, 0.15);
  float size = aSize * uPointScale * uPixelRatio * (1.0 + 0.3 * uCollapse) / dist;
  gl_PointSize = clamp(size, 0.6, 34.0);

  float inner = 1.0 - smoothstep(0.0, 0.32, r);
  float edge = smoothstep(0.30, 0.60, radius);
  vec3 col = aColor * uTint;

  col = mix(col, mix(vec3(0.55, 0.85, 1.0), vec3(1.0, 0.96, 0.90), edge), uCollapse * 0.5);
  col += uFlash * 0.5;

  vColor = col;
  float a = A_BASE * aBright * (0.40 + 0.55 * inner) / (1.0 + 0.65 * r);
  a *= mix(1.0, 0.05 + 1.9 * edge, uCollapse);
  vAlpha = a * (1.0 + 0.18 * uOpen) * uAlpha;
}
`;

const FRAG = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  if (r > 1.0) discard;
  float a = pow(1.0 - r, 2.2);
  gl_FragColor = vec4(vColor, a * vAlpha);
}
`;

const DISK_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DISK_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uSpin;
uniform float uCollapse;
uniform float uFlash;
uniform float uOpacity;
uniform float uAlpha;
uniform vec3 uIndigo;
uniform vec3 uDeep;
uniform vec3 uCore;
uniform vec3 uCyan;
uniform vec3 uMagenta;

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

void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  if (r > 0.995) discard;
  float ang = atan(p.y, p.x);

  float phase = 2.0 * ang - 5.6 * log(max(r, 0.035)) + uTime * uSpin * 3.0;
  float arm = pow(0.5 + 0.5 * cos(phase), 3.5);
  float between = smoothstep(0.45, 1.0, 0.5 + 0.5 * cos(phase + 3.14159));

  float radial = exp(-pow(r / 0.60, 2.1));
  float glow = radial * (0.16 + 0.9 * arm) * (1.0 - 0.55 * between);

  float n = noise(p * 7.0 + vec2(uTime * 0.02, -uTime * 0.013));
  float n2 = noise(p * 22.0 - vec2(uTime * 0.008, 0.0));
  glow *= 0.62 + 0.5 * n + 0.22 * n2;

  vec3 col = mix(uDeep, uIndigo, smoothstep(0.1, 0.85, arm));
  col = mix(col, uCore, exp(-pow(r / 0.13, 2.0)) * 0.85);
  col = mix(col, uCyan, smoothstep(0.82, 1.0, n) * 0.22 * smoothstep(0.25, 0.6, r));
  col = mix(col, uMagenta, smoothstep(0.86, 1.0, n2) * 0.14 * smoothstep(0.35, 0.8, r));

  float a = glow * uOpacity * uAlpha * mix(1.0, 0.02, uCollapse) * (1.0 + uFlash * 1.2);
  gl_FragColor = vec4(col, a);
}
`;

function makeGlowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,250,238,1)');
  g.addColorStop(0.22, 'rgba(255,240,220,0.5)');
  g.addColorStop(0.5, 'rgba(90,110,255,0.14)');
  g.addColorStop(1, 'rgba(10,12,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Galaxy {
  constructor(renderer, variant = 0) {
    this.renderer = renderer;
    this.variant = variant;
    this.group = new THREE.Group();
    this.group.name = variant ? 'galaxy-b' : 'galaxy';

    const count = CONFIG.particles.count;
    const rng = mulberry32(CONFIG.seed + variant * 9176);
    this.count = count;
    const C = CONFIG.particles.colors;
    const core = srgb(C.core);
    const indigo = srgb(C.indigo);
    const deep = srgb(C.deep);
    const cyan = srgb(C.cyan);
    const magenta = srgb(C.magenta);
    // 第二团星系：色相往品红偏，仍控制在五色板内
    const base = variant ? magenta.clone().lerp(indigo, 0.55) : indigo;
    const deepBase = variant ? deep.clone().lerp(magenta, 0.3) : deep;

    const radius = new Float32Array(count);
    const angle = new Float32Array(count);
    const height = new Float32Array(count);
    const size = new Float32Array(count);
    const seed = new Float32Array(count);
    const bright = new Float32Array(count);
    const color = new Float32Array(count * 3);
    const position = new Float32Array(count * 3);
    const TAU = Math.PI * 2;

    for (let i = 0; i < count; i++) {
      const isBulge = rng() < 0.035;
      let r;
      let a;
      let brightVal = 1.0;
      let sizeVal;

      if (isBulge) {
        r = Math.pow(rng(), 2.6) * 0.13;
        a = rng() * TAU;
        brightVal = 1.0;
        sizeVal = 0.3 + Math.pow(rng(), 2.2) * 1.4;
      } else {
        r = 0.14 + Math.pow(rng(), 0.9) * 0.86;
        const arm = i % 2;
        a = arm * Math.PI + r * 4.15 + gauss(rng) * 0.13 * (0.35 + r);

        const role = rng();
        if (role < 0.52) {
          brightVal = 0.28 + rng() * 0.16;
          sizeVal = 0.3 + Math.pow(rng(), 2.2) * 0.9;
        } else if (role < 0.9) {
          brightVal = 0.85 + rng() * 0.5;
          sizeVal = 0.35 + Math.pow(rng(), 2.4) * 2.0;
        } else if (role < 0.975) {
          brightVal = 2.2 + rng() * 1.6;
          sizeVal = 1.6 + Math.pow(rng(), 2.0) * 3.2;
        } else {
          brightVal = 0.12 + rng() * 0.1;
          sizeVal = 0.35 + rng() * 1.1;
        }
      }

      radius[i] = r;
      angle[i] = a;
      height[i] = gauss(rng) * (0.42 + (1 - r) * 0.9) * (isBulge ? 1.4 : 1.0);
      size[i] = sizeVal;
      seed[i] = rng();
      bright[i] = brightVal;

      let c;
      if (isBulge) {
        c = core.clone().lerp(base, rng() * 0.3);
      } else if (brightVal < 0.3) {
        c = deepBase.clone().lerp(base, rng() * 0.35);
      } else {
        c = base.clone().lerp(deepBase, Math.pow(rng(), 0.8) * 0.35);
        if (rng() < 0.045) c = cyan.clone().lerp(base, rng() * 0.4);
        if (rng() < (variant ? 0.05 : 0.025)) c = magenta.clone().lerp(base, rng() * 0.45);
      }
      c.lerp(srgb(0xffffff), 0.16);
      color[i * 3] = c.r;
      color[i * 3 + 1] = c.g;
      color[i * 3 + 2] = c.b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geo.setAttribute('aRadius', new THREE.BufferAttribute(radius, 1));
    geo.setAttribute('aAngle', new THREE.BufferAttribute(angle, 1));
    geo.setAttribute('aHeight', new THREE.BufferAttribute(height, 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aBright', new THREE.BufferAttribute(bright, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60);

    this.uniforms = {
      uTime: { value: 0 },
      uSpin: { value: CONFIG.particles.spin },
      uCollapse: { value: 0 },
      uOpen: { value: 1 },
      uBurst: { value: 0 },
      uScale: { value: 1 },
      uPixelRatio: { value: renderer.getPixelRatio() },
      uPointScale: { value: CONFIG.particles.pointScale },
      uFlash: { value: 0 },
      uTint: { value: new THREE.Color(1, 1, 1) },
      uAlpha: { value: 1 },
    };

    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    material.defines = {
      R_MAX: CONFIG.particles.radius.toFixed(3),
      THICK: CONFIG.particles.thickness.toFixed(3),
      A_BASE: '0.55',
    };

    this.points = new THREE.Points(geo, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.group.add(this.points);

    // Continuous disk glow behind the particles (spiral haze, not a sprite).
    this.diskUniforms = {
      uTime: { value: 0 },
      uSpin: { value: CONFIG.particles.spin },
      uCollapse: { value: 0 },
      uFlash: { value: 0 },
      uOpacity: { value: 0.32 },
      uAlpha: { value: 1 },
      uIndigo: { value: srgb(C.indigo) },
      uDeep: { value: srgb(C.deep) },
      uCore: { value: srgb(C.core) },
      uCyan: { value: srgb(C.cyan) },
      uMagenta: { value: srgb(C.magenta) },
    };
    const diskMat = new THREE.ShaderMaterial({
      vertexShader: DISK_VERT,
      fragmentShader: DISK_FRAG,
      uniforms: this.diskUniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.disk = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), diskMat);
    this.disk.rotation.x = -Math.PI / 2;
    this.disk.renderOrder = 0;
    this.disk.frustumCulled = false;
    this.group.add(this.disk);

    this.glowMat = new THREE.SpriteMaterial({
      map: makeGlowTexture(),
      color: 0xfff2e2,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      opacity: 0.05,
    });
    this.glow = new THREE.Sprite(this.glowMat);
    this.glow.renderOrder = 1;
    this.glow.scale.setScalar(1.0);
    this.group.add(this.glow);
  }

  update(time, spin, collapse, open, burst, flash) {
    const u = this.uniforms;
    u.uTime.value = time;
    u.uSpin.value = spin;
    u.uCollapse.value = collapse;
    u.uOpen.value = open;
    u.uBurst.value = burst;
    u.uFlash.value = flash;
    u.uPixelRatio.value = this.renderer.getPixelRatio();

    const du = this.diskUniforms;
    du.uTime.value = time;
    du.uSpin.value = spin;
    du.uCollapse.value = collapse;
    du.uFlash.value = flash;
    this.disk.scale.setScalar(CONFIG.particles.radius * 1.2 * Math.max(u.uScale.value, 0.001));

    this.glowMat.opacity = 0.03 + 0.06 * (1 - collapse) + 0.16 * flash;
    this.glow.scale.setScalar(0.9 + 0.35 * (1 - collapse) + flash * 1.2);
  }
}