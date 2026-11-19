/**
 * scenes/xmas.js — 圣诞树（v5 平台第三个场景）
 *
 * 为什么这么做：
 *   · 树「有体积」的关键不是贴图，是轮廓：三层锥形树体打底 + 3000 片针叶簇（InstancedMesh）
 *     长在锥面上，剪影才会毛糙；远处的雪和近处的灯串负责「夜」的气质；
 *   · 交互只留两种手势（捏合、横挥）+ 两个按钮，符合「手势不要太复杂」的要求；
 *   · 所有动画都按 dt 推进，没有 setTimeout，切场景直接停（平台只在前台调 update）。
 */

export const META = Object.freeze({
  id: 'xmas',
  label: '圣诞树',
  sub: 'CHRISTMAS TREE',
  hint: '捏合挂一件 · 挥手撒雪',
});

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);

/** 树的外形：底部半径、高度、层数 */
const TREE = { r: 300, h: 900, base: -420, tiers: 3 };

/** 锥面在高度 k（0 底 → 1 顶）处的半径 */
const radiusAt = (k) => TREE.r * (1 - k) * 0.96 + 26;

/** 暖光晕贴图（径向渐变），给灯串和星星用 */
function glowTexture(THREE, inner = '#fff3d0', outer = 'rgba(255,217,160,0)') {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.35, 'rgba(255,225,175,0.55)');
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createScene(ctx) {
  const { THREE, group, stage, quality } = ctx;
  const low = quality === 'low';
  const mid = quality === 'mid';

  const cam = new THREE.PerspectiveCamera(46, stage.w / stage.h, 1, 6000);
  cam.position.set(0, 60, 1500);
  cam.lookAt(0, -60, 0);

  /* ── 地面：雪地（径向渐变 + 一点点起伏） ─────────────────── */
  const snowTex = (() => {
    const S = 512;
    const cv = document.createElement('canvas');
    cv.width = S;
    cv.height = S;
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grd.addColorStop(0, '#1b2231');
    grd.addColorStop(0.55, '#0d1119');
    grd.addColorStop(1, '#05070c');
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
    // 一层细雪点
    for (let i = 0; i < 2600; i += 1) {
      const a = Math.random() * TAU;
      const r = Math.pow(Math.random(), 0.55) * (S / 2);
      const x = S / 2 + Math.cos(a) * r;
      const y = S / 2 + Math.sin(a) * r;
      g.fillStyle = `rgba(226,238,255,${0.05 + Math.random() * 0.22})`;
      g.fillRect(x, y, 1.4, 1.4);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  })();
  const groundGeo = new THREE.CircleGeometry(1500, 64);
  const ground = new THREE.Mesh(
    groundGeo,
    new THREE.MeshBasicMaterial({ map: snowTex, transparent: true, opacity: 0.95, depthWrite: false }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = TREE.base - 8;
  group.add(ground);

  /* ── 树体：三层锥 + 针叶簇 ─────────────────────────────────── */
  const treeGroup = new THREE.Group();
  group.add(treeGroup);

  const coneColors = ['#0a1f1a', '#0c241d', '#0e2b21'];
  for (let i = 0; i < TREE.tiers; i += 1) {
    const k = i / TREE.tiers; // 0 底
    const h = TREE.h * (0.52 - i * 0.06);
    const r = radiusAt(k) * 1.0;
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(r, h, 26, 1, true),
      new THREE.MeshBasicMaterial({ color: coneColors[i], side: THREE.DoubleSide }),
    );
    cone.position.y = TREE.base + h / 2 + TREE.h * k * 0.55;
    treeGroup.add(cone);
  }

  // 针叶簇：锥面上的小三角片，朝外张开（InstancedMesh，一次 draw call）
  const NEEDLE = low ? 900 : mid ? 1800 : 3000;
  const needleGeo = new THREE.ConeGeometry(9, 26, 3, 1, true);
  const needleMat = new THREE.MeshBasicMaterial({ color: '#14352a', side: THREE.DoubleSide });
  const needles = new THREE.InstancedMesh(needleGeo, needleMat, NEEDLE);
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    const c = new THREE.Color();
    for (let i = 0; i < NEEDLE; i += 1) {
      // 高度偏下多一点（底部的枝更密）
      const k = Math.pow(Math.random(), 0.75);
      const rad = radiusAt(k * 0.98);
      const a = Math.random() * TAU;
      v.set(Math.cos(a) * rad * rand(0.86, 1.02), TREE.base + k * TREE.h, Math.sin(a) * rad * rand(0.86, 1.02));
      euler.set(rand(-0.5, 0.5), -a + Math.PI / 2, rand(-0.7, -0.2));
      q.setFromEuler(euler);
      const sc = rand(0.55, 1.25);
      s.set(sc, sc * rand(0.8, 1.5), sc);
      m.compose(v, q, s);
      needles.setMatrixAt(i, m);
      // 颜色：靠外的枝头亮一点（雪压在上面）
      const t = Math.random();
      c.set(t > 0.9 ? '#79b79c' : t > 0.7 ? '#1d4736' : '#0f2a20');
      needles.setColorAt(i, c);
    }
    needles.instanceMatrix.needsUpdate = true;
    if (needles.instanceColor) needles.instanceColor.needsUpdate = true;
  }
  treeGroup.add(needles);

  /* ── 灯串：一条螺旋缠绕的暖光灯点（可开关） ────────────────── */
  const LIGHTS = low ? 90 : mid ? 150 : 210;
  const lightGeo = new THREE.BufferGeometry();
  {
    const pos = new Float32Array(LIGHTS * 3);
    const size = new Float32Array(LIGHTS);
    for (let i = 0; i < LIGHTS; i += 1) {
      const t = i / LIGHTS;
      const k = 0.06 + t * 0.9;
      const a = t * TAU * 5.2;
      const rad = radiusAt(k) * 1.03;
      pos[i * 3] = Math.cos(a) * rad;
      pos[i * 3 + 1] = TREE.base + k * TREE.h;
      pos[i * 3 + 2] = Math.sin(a) * rad;
      size[i] = rand(5, 12);
    }
    lightGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    lightGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  }
  const lightMat = new THREE.ShaderMaterial({
    uniforms: {
      uPx: { value: 1 },
      uOn: { value: 1 },
      uTime: { value: 0 },
      uGlow: { value: glowTexture(THREE) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aSize;
      uniform float uPx;
      uniform float uOn;
      varying float vI;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(aSize * uPx * uOn * (700.0 / max(200.0, -mv.z)), 1.0, 60.0);
        vI = uOn;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uGlow;
      varying float vI;
      void main() {
        vec4 t = texture2D(uGlow, gl_PointCoord);
        gl_FragColor = vec4(t.rgb * 1.5, t.a * vI);
      }
    `,
  });
  const lightPoints = new THREE.Points(lightGeo, lightMat);
  group.add(lightPoints);

  /* ── 树顶星 ───────────────────────────────────────────────── */
  const starGroup = new THREE.Group();
  starGroup.position.set(0, TREE.base + TREE.h + 40, 0);
  const starCore = new THREE.Mesh(
    new THREE.IcosahedronGeometry(34, 0),
    new THREE.MeshBasicMaterial({ color: '#ffe9b8' }),
  );
  const starHalo = new THREE.Mesh(
    new THREE.PlaneGeometry(320, 320),
    new THREE.MeshBasicMaterial({
      map: glowTexture(THREE, '#fff6dd'),
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  starGroup.add(starCore, starHalo);
  group.add(starGroup);

  /* ── 挂饰：30 个球，长在锥面上，可以「捏一下就点亮」 ────────── */
  const ORN = low ? 16 : mid ? 24 : 30;
  const ornGeo = new THREE.SphereGeometry(1, 14, 10);
  const ornPalette = ['#ff8fa3', '#ffe1a8', '#c9d6ff', '#b8f0c8', '#ffd9a0'];
  const ornaments = [];
  const ornGroup = new THREE.Group();
  for (let i = 0; i < ORN; i += 1) {
    const k = rand(0.08, 0.82);
    const a = rand(0, TAU);
    const rad = radiusAt(k) * 1.04;
    const hue = ornPalette[i % ornPalette.length];
    const core = new THREE.Mesh(ornGeo, new THREE.MeshBasicMaterial({ color: hue }));
    const halo = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: glowTexture(THREE, hue),
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    const r = rand(13, 21);
    core.scale.setScalar(r);
    halo.scale.setScalar(r * 9);
    core.position.set(Math.cos(a) * rad, TREE.base + k * TREE.h, Math.sin(a) * rad);
    halo.position.copy(core.position);
    ornGroup.add(core, halo);
    ornaments.push({ core, halo, r, home: core.position.clone(), lit: 0, phase: rand(0, TAU) });
  }
  group.add(ornGroup);

  /* ── 雪：Points，落到地面重生 ─────────────────────────────── */
  const SNOW = low ? 700 : mid ? 1400 : 2600;
  const snowGeo = new THREE.BufferGeometry();
  const snowPos = new Float32Array(SNOW * 3);
  const snowVel = new Float32Array(SNOW * 2); // y 速度、漂移相位
  for (let i = 0; i < SNOW; i += 1) {
    snowPos[i * 3] = rand(-900, 900);
    snowPos[i * 3 + 1] = rand(TREE.base, 1500);
    snowPos[i * 3 + 2] = rand(-900, 700);
    snowVel[i * 2] = rand(40, 130);
    snowVel[i * 2 + 1] = rand(0, TAU);
  }
  snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
  const snowMat = new THREE.PointsMaterial({
    // 雪是「夜里的白点」，不是一层白膜：颜色压到 #cfdcf5、尺寸 3.4、加色 0.4
    color: '#cfdcf5',
    size: 3.4,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const snow = new THREE.Points(snowGeo, snowMat);
  group.add(snow);

  /* ── 状态 ─────────────────────────────────────────────────── */
  const buf = { waves: 0, pins: 0 };
  const state = {
    t: 0,
    lights: 1, // 0..1 灯串亮度
    lightsOn: true,
    snowHeavy: false,
    gust: 0, // 横挥后的阵风剩余
    pinned: 0, // 已挂亮的挂饰数
    crowned: false,
    firstPerson: false,
    rx: 0,
    status: '雪夜 · 院子里的一棵树',
  };

  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();

  /** 手（舞台坐标）→ 世界坐标：投到过树轴、平行于相机的平面上 */
  function handToWorld(hand) {
    const nx = hand.tip.x / stage.w - 0.5;
    const ny = hand.tip.y / stage.h - 0.5;
    const dist = cam.position.length();
    const hh = 2 * Math.tan((cam.fov * Math.PI) / 360) * dist;
    const ww = hh * cam.aspect;
    tmpV.set(nx * ww, -ny * hh, 0).applyQuaternion(cam.quaternion).add(cam.position);
    return tmpV;
  }

  const api = {
    camera: () => cam,

    enter(opts = {}) {
      state.t = 0;
      state.gust = 0;
      state.status = '雪夜 · 院子里的一棵树';
      if (opts.firstPerson) state.firstPerson = true;
    },

    exit() {
      state.gust = 0;
    },

    toggleView() {
      state.firstPerson = !state.firstPerson;
      state.status = state.firstPerson ? '树冠里 · 仰头看星' : '雪夜 · 院子里的一棵树';
      return state.firstPerson ? 'first' : 'third';
    },

    actions() {
      return [
        { id: 'lights', label: this._lightsLabel() },
        { id: 'snow', label: state.snowHeavy ? '大雪' : '小雪' },
      ];
    },

    _lightsLabel() {
      return state.lightsOn ? '灯串 开' : '灯串 关';
    },

    action(id) {
      if (id === 'lights') {
        state.lightsOn = !state.lightsOn;
        state.status = state.lightsOn ? '灯串 · 亮起来' : '灯串 · 熄了';
      } else if (id === 'snow') {
        state.snowHeavy = !state.snowHeavy;
        state.status = state.snowHeavy ? '大雪 · 下紧一点' : '小雪 · 轻轻的';
      }
    },

    gesture(ev) {
      if (!ev || !ev.type) return;
      if (ev.type === 'sweep') {
        buf.waves += 1;
        state.gust = 1;
        state.status = '挥手 · 雪被吹起来';
      } else if (ev.type === 'pinch') {
        state.status = '捏合 · 挂一件';
      }
    },

    hud() {
      return {
        status: state.status,
        value: state.pinned / Math.max(1, ORN),
      };
    },

    debug() {
      return {
        firstPerson: state.firstPerson,
        lights: +state.lights.toFixed(2),
        lightsOn: state.lightsOn,
        pinned: state.pinned,
        crowned: state.crowned,
        gust: +state.gust.toFixed(2),
        waves: buf.waves,
        status: state.status,
      };
    },

    stats() {
      let tris = 0;
      group.traverse((o) => {
        if (!o.isMesh && !o.isPoints && !o.isInstancedMesh) return;
        const g = o.geometry;
        if (!g) return;
        const cnt = g.index ? g.index.count : g.attributes.position ? g.attributes.position.count : 0;
        if (o.isPoints) return;
        tris += Math.floor(cnt / 3) * (o.isInstancedMesh ? o.count : 1);
      });
      return { objects: group.children.length, tris, ornaments: ORN, needles: NEEDLE, snow: SNOW };
    },

    update(dt, frame) {
      const d = Math.min(dt, 0.05);
      state.t += d;
      const t = state.t;

      /* 灯串亮度缓动（开 = 1，关 = 0） */
      const target = state.lightsOn ? 1 : 0;
      state.lights += (target - state.lights) * Math.min(1, d * 5);
      lightMat.uniforms.uOn.value = state.lights * (0.75 + 0.25 * Math.sin(t * 2.4));
      lightMat.uniforms.uPx.value = 1;

      /* 树顶星：慢转 + 呼吸 */
      starGroup.rotation.y += d * 0.5;
      const pulse = 1 + 0.08 * Math.sin(t * 1.9);
      starCore.scale.setScalar(state.crowned ? 1.35 * pulse : pulse);
      starCore.material.color.set(state.crowned ? '#fffdf2' : '#ffe9b8');
      starHalo.material.opacity = (state.crowned ? 0.72 : 0.45) * pulse;

      /* 挂饰：漂一点、被点亮后亮一档 */
      for (const o of ornaments) {
        o.core.position.y = o.home.y + Math.sin(t * 0.9 + o.phase) * 4;
        o.lit = Math.max(0, o.lit - d * 0.25);
        const s = o.r * (1 + 0.06 * Math.sin(t * 1.6 + o.phase) + o.lit * 0.5);
        o.core.scale.setScalar(s);
        o.halo.position.copy(o.core.position);
        o.halo.scale.setScalar(s * 9 * (1 + o.lit * 0.8));
        o.halo.material.opacity = 0.26 + 0.1 * Math.sin(t * 2.1 + o.phase) + o.lit * 0.5;
      }

      /* 雪：下落 + 阵风 */
      state.gust = Math.max(0, state.gust - d * 0.5);
      const gust = state.gust;
      const fall = state.snowHeavy ? 1.9 : 1;
      const pos = snowGeo.attributes.position.array;
      for (let i = 0; i < SNOW; i += 1) {
        const i3 = i * 3;
        pos[i3 + 1] -= snowVel[i * 2] * fall * d;
        pos[i3] += (Math.sin(t * 0.7 + snowVel[i * 2 + 1]) * 22 + gust * 460) * d;
        if (pos[i3 + 1] < TREE.base) {
          pos[i3] = rand(-900, 900);
          pos[i3 + 1] = rand(1200, 1600);
          pos[i3 + 2] = rand(-900, 700);
        }
        if (pos[i3] > 1000) pos[i3] = -900;
      }
      snowGeo.attributes.position.needsUpdate = true;
      snowMat.opacity = 0.3 + 0.22 * (state.snowHeavy ? 1 : 0);

      /* 手：捏合点到就点亮最近的挂饰 / 给星加冕 */
      const hands = frame.hands || [];
      const h0 = hands[0];
      if (h0) {
        const w = handToWorld(h0);
        if (h0.pinch && h0.pinch.on) {
          // 先看星（最亮的那颗）
          if (w.distanceTo(starGroup.position) < 150 && !state.crowned) {
            state.crowned = true;
            state.status = '加冕 · 树顶星亮了';
            state.pinned += 1;
          } else {
            let best = -1;
            let bestD = 1e9;
            for (let i = 0; i < ornaments.length; i += 1) {
              const dd = ornaments[i].core.position.distanceTo(w);
              if (dd < bestD) {
                bestD = dd;
                best = i;
              }
            }
            if (best >= 0 && bestD < 110 && ornaments[best].lit < 0.4) {
              ornaments[best].lit = 1;
              state.pinned += 0.5;
              state.status = '挂上 · 又亮一颗';
            }
          }
        }
      }

      /* 相机：第三人称绕树 / 第一人称钻进树冠 */
      if (state.firstPerson) {
        const k = Math.min(1, d * 2.4);
        cam.position.x += (Math.sin(t * 0.5) * 40 - cam.position.x) * k;
        cam.position.y += (TREE.base + TREE.h * 0.55 - cam.position.y) * k;
        cam.position.z += (120 - cam.position.z) * k;
        tmpV2.set(0, TREE.base + TREE.h + 30, 0);
        cam.lookAt(tmpV2);
      } else {
        state.rx += d * 0.16;
        const rad = 1500;
        const ty = 120 + Math.sin(t * 0.4) * 40;
        const k = Math.min(1, d * 1.8);
        cam.position.x += (Math.sin(state.rx) * rad - cam.position.x) * k;
        cam.position.z += (Math.cos(state.rx) * rad - cam.position.z) * k;
        cam.position.y += (ty - cam.position.y) * k;
        tmpV2.set(0, TREE.base + TREE.h * 0.45, 0);
        cam.lookAt(tmpV2);
      }
      cam.updateMatrixWorld();
    },
  };

  return api;
}

export default { META, createScene };