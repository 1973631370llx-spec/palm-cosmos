/**
 * scenes/cosmos.js — 掌心宇宙（v5 平台的第二个场景）
 *
 * 设计思路（为什么这么写）：
 *   · 舞台坐标就是世界坐标（1080 宽 = 1080 世界单位，见 CONTRACT.md），所以手势坐标
 *     不用换算就能当世界坐标用——手在画面里放在哪，星云就在哪被拨动；
 *   · 星星要「一眼看着深」：三层深度（远景 Points 3000 颗 / 中景 900 颗带颜色 /
 *     近景星尘 260 颗大点）+ 一层程序生成的星云（canvas 贴图，两张交叉，加色混合）。
 *     全部加色，靠平台的 bloom 出光，自己不写后处理；
 *   · 交互只用两种手势（张开手巡航、捏住拖星）+ 横挥跃迁 + 三个按钮，
 *     因为用户明确说「手势不要太多」。
 */

/** 场景元信息（平台读它渲染卡片） */
export const META = Object.freeze({
  id: 'cosmos',
  label: '掌心宇宙',
  sub: 'PALM COSMOS',
  hint: '张手巡航 · 捏住拖星 · 横挥跃迁',
});

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);

/** 程序生成一张星云贴图（径向 + 噪声条纹），返回 CanvasTexture */
function nebulaTexture(THREE, seed = 1) {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  // 三层偏心的软斑，模仿星云的团块感
  const blobs = [
    { x: 0.42, y: 0.46, r: 0.5, c: ['#6f8bff', '#0000'], a: 0.9 },
    { x: 0.62, y: 0.56, r: 0.34, c: ['#ff9ad5', '#0000'], a: 0.7 },
    { x: 0.5, y: 0.5, r: 0.72, c: ['#2b3a8f', '#0000'], a: 0.85 },
  ];
  g.globalCompositeOperation = 'lighter';
  for (const b of blobs) {
    const grd = g.createRadialGradient(S * b.x, S * b.y, 0, S * b.x, S * b.y, S * b.r);
    grd.addColorStop(0, b.c[0]);
    grd.addColorStop(1, b.c[1]);
    g.globalAlpha = b.a;
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
  }
  // 细丝：几条随机弧线，让云不是一团圆
  g.globalAlpha = 0.28;
  g.strokeStyle = '#c8d6ff';
  g.lineWidth = 1.6;
  for (let i = 0; i < 26; i += 1) {
    const y0 = rand(0, S);
    g.beginPath();
    g.moveTo(0, y0);
    for (let x = 0; x <= S; x += 16) {
      g.lineTo(x, y0 + Math.sin((x / S) * TAU * rand(0.6, 1.8) + seed) * rand(4, 22));
    }
    g.stroke();
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function createScene(ctx) {
  const { THREE, group, stage, quality } = ctx;
  const low = quality === 'low';
  const mid = quality === 'mid';
  const STAR_FAR = low ? 1200 : mid ? 2000 : 3000;
  const STAR_MID = low ? 380 : mid ? 640 : 900;
  const DUST = low ? 120 : mid ? 180 : 260;

  const cam = new THREE.PerspectiveCamera(52, stage.w / stage.h, 1, 6000);
  cam.position.set(0, 0, 760);
  cam.lookAt(0, 0, 0);

  /* ── 远景星空：一个大球壳上的点，随相机巡航有视差 ───────────── */
  const farGeo = new THREE.BufferGeometry();
  {
    const pos = new Float32Array(STAR_FAR * 3);
    const col = new Float32Array(STAR_FAR * 3);
    const size = new Float32Array(STAR_FAR);
    const c = new THREE.Color();
    for (let i = 0; i < STAR_FAR; i += 1) {
      // 球壳（半径 1200–2600），避免正对相机太密
      const r = rand(1200, 2600);
      const th = Math.random() * TAU;
      const ph = Math.acos(rand(-1, 1));
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph);
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      // 色温：多数冷白，少数偏蓝 / 偏金
      const k = Math.random();
      if (k > 0.92) c.setRGB(1, 0.86, 0.66);
      else if (k > 0.72) c.setRGB(0.78, 0.86, 1);
      else c.setRGB(0.92, 0.94, 1);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
      size[i] = rand(1.2, 4.4);
    }
    farGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    farGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    farGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  }
  const starMat = new THREE.ShaderMaterial({
    uniforms: { uPx: { value: 1 }, uOpacity: { value: 1 } },
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aSize;
      uniform float uPx;
      varying vec3 vC;
      void main() {
        vC = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        // 远星不随距离无限缩小：给一个下限，看起来才像星空
        gl_PointSize = clamp(aSize * uPx * (900.0 / max(300.0, -mv.z)) * 0.72, 1.0, 4.2);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying vec3 vC;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d);
        if (r > 0.5) discard;
        float a = smoothstep(0.5, 0.0, r);
        gl_FragColor = vec4(vC, a * uOpacity);
      }
    `,
  });
  const farStars = new THREE.Points(farGeo, starMat);
  farStars.frustumCulled = false;
  group.add(farStars);

  /* ── 中景星团：绕着中心慢慢转的一团，颜色更饱和 ───────────── */
  const midGeo = new THREE.BufferGeometry();
  const midPhase = new Float32Array(STAR_MID);
  {
    const pos = new Float32Array(STAR_MID * 3);
    const col = new Float32Array(STAR_MID * 3);
    const size = new Float32Array(STAR_MID);
    const palette = [
      new THREE.Color('#a9c6ff'),
      new THREE.Color('#ffb7c9'),
      new THREE.Color('#ffd9a0'),
      new THREE.Color('#b8f0c8'),
    ];
    for (let i = 0; i < STAR_MID; i += 1) {
      // 螺旋盘：半径 220–900，厚度很薄
      const r = rand(200, 900);
      const a = rand(0, TAU);
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = rand(-70, 70) * (1 - r / 1400);
      pos[i * 3 + 2] = Math.sin(a) * r - 300;
      const c = palette[i % palette.length];
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
      size[i] = rand(2.2, 7.5);
      midPhase[i] = a;
    }
    midGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    midGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    midGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  }
  const midMat = starMat.clone();
  const midStars = new THREE.Points(midGeo, midMat);
  midStars.frustumCulled = false;
  group.add(midStars);

  /* ── 近景星尘：跟着手走的一层，制造「手在星里」的感觉 ───────── */
  const dustGeo = new THREE.BufferGeometry();
  const dustPos = new Float32Array(DUST * 3);
  const dustSize = new Float32Array(DUST);
  for (let i = 0; i < DUST; i += 1) {
    dustPos[i * 3] = rand(-540, 540);
    dustPos[i * 3 + 1] = rand(-900, 900);
    dustPos[i * 3 + 2] = rand(-520, 260);
    dustSize[i] = rand(2.5, 8);
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  dustGeo.setAttribute('aSize', new THREE.BufferAttribute(dustSize, 1));
  const dustMat = new THREE.ShaderMaterial({
    uniforms: { uPx: { value: 1 }, uColor: { value: new THREE.Color('#ffe6c2') }, uOpacity: { value: 0.18 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aSize;
      uniform float uPx;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(aSize * uPx * (300.0 / max(120.0, -mv.z)), 1.0, 26.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d);
        if (r > 0.5) discard;
        float a = smoothstep(0.5, 0.0, r);
        gl_FragColor = vec4(uColor, a * uOpacity);
      }
    `,
  });
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  group.add(dust);

  /* ── 星云：两张交叉的加色面片 ─────────────────────────────── */
  const texA = nebulaTexture(THREE, 1.3);
  const texB = nebulaTexture(THREE, 4.1);
  const nebGroup = new THREE.Group();
  for (let i = 0; i < 2; i += 1) {
    const geo = new THREE.PlaneGeometry(2600, 2600);
    const mat = new THREE.MeshBasicMaterial({
      map: i % 2 ? texB : texA,
      transparent: true,
      // 星云只是「背景的呼吸」，不能压过星星：0.075 是实测整屏亮度最舒服的值
      opacity: 0.05,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(rand(-160, 160), rand(-160, 160), -900 - i * 220);
    m.rotation.z = rand(0, TAU);
    nebGroup.add(m);
  }
  nebGroup.renderOrder = -2;
  group.add(nebGroup);

  /* ── 可拖的「小星体」：捏住能抓住、松手甩出去 ───────────────── */
  const BODIES = low ? 4 : 6;
  const bodies = [];
  const bodiesGroup = new THREE.Group();
  const coreGeo = new THREE.IcosahedronGeometry(1, 2);
  const haloGeo = new THREE.SphereGeometry(1, 16, 12);
  for (let i = 0; i < BODIES; i += 1) {
    const root = new THREE.Group();
    const hue = [0xffd9a0, 0xffb7c9, 0xa9c6ff, 0xb8f0c8, 0xffe6c2, 0xd5b8ff][i % 6];
    const core = new THREE.Mesh(
      coreGeo,
      new THREE.MeshBasicMaterial({ color: hue }),
    );
    const halo = new THREE.Mesh(
      haloGeo,
      new THREE.MeshBasicMaterial({
        color: hue,
        transparent: true,
        opacity: 0.07,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    const r = rand(7, 16);
    core.scale.setScalar(r);
    halo.scale.setScalar(r * 2.4);
    root.add(core, halo);
    const a = (i / BODIES) * TAU + rand(-0.2, 0.2);
    const rad = rand(260, 620);
    const p = new THREE.Vector3(Math.cos(a) * rad, rand(-260, 260), Math.sin(a) * rad - 420);
    root.position.copy(p);
    bodiesGroup.add(root);
    bodies.push({
      root,
      core,
      halo,
      base: p.clone(),
      home: p.clone(),
      vel: new THREE.Vector3(),
      grabbed: false,
      phase: rand(0, TAU),
      r,
      hue,
    });
  }
  group.add(bodiesGroup);

  /* ── 掌心光：手在画面里 → 世界坐标处的一团暖光 ───────────────── */
  const palmLight = new THREE.Mesh(
    new THREE.PlaneGeometry(420, 420),
    new THREE.MeshBasicMaterial({
      map: texA,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  );
  palmLight.position.set(0, 0, 60);
  group.add(palmLight);

  /* ── 状态 ─────────────────────────────────────────────────── */
  const state = {
    firstPerson: false,
    rx: 0, // 第三人称：绕中心的水平角
    ry: 0.15,
    dist: 780,
    warp: 0, // 跃迁剩余时间
    orbitSpin: true,
    t: 0,
    grabbed: -1,
    grain: 0,
    status: '星域 · 天鹅座悬臂',
  };
  /* 自检计数：手势到底有没有真的改变场景（tools/platform-check.mjs 读它） */
  const buf = { warps: 0, grabs: 0, taps: 0, releases: 0 };
  let nearestDist = -1;

  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const dragTarget = new THREE.Vector3();

  /** 手（舞台坐标）→ 世界坐标（相机前方 z = -260 的平面上） */
  function handToWorld(hand) {
    const nx = hand.tip.x / stage.w - 0.5; // -0.5..0.5
    const ny = hand.tip.y / stage.h - 0.5;
    // 视野在 z=-260 处的高度 = 2 * tan(fov/2) * 260
    const hh = 2 * Math.tan((cam.fov * Math.PI) / 360) * 260;
    const ww = hh * cam.aspect;
    tmpV.set(nx * ww, -ny * hh, -260).applyMatrix4(cam.matrixWorld);
    return tmpV;
  }

  const api = {
    camera: () => cam,

    enter(opts = {}) {
      state.firstPerson = !!opts.firstPerson;
      state.warp = 0;
      state.grabbed = -1;
      for (const b of bodies) {
        b.root.position.copy(b.home);
        b.vel.set(0, 0, 0);
        b.grabbed = false;
      }
      state.status = state.firstPerson ? '星域 · 视界之内' : '星域 · 天鹅座悬臂';
      if (!opts.instant) state.warp = 1.1; // 切进来先给一段冲刺，视觉上「到站」
    },

    exit() {
      state.grabbed = -1;
      for (const b of bodies) b.grabbed = false;
    },

    toggleView() {
      state.firstPerson = !state.firstPerson;
      state.dist = state.firstPerson ? 320 : 780;
      state.status = state.firstPerson ? '星域 · 视界之内' : '星域 · 天鹅座悬臂';
      return state.firstPerson ? 'first' : 'third';
    },

    actions() {
      return [
        { id: 'warp', label: '跃迁' },
        { id: 'orbit', label: state.orbitSpin ? '自转 开' : '自转 关' },
        { id: 'home', label: '归位' },
      ];
    },

    action(id) {
      if (id === 'warp') {
        // 跃迁：一次冲刺 + 星空拉丝（在 update 里按 warp 量放大星点长度感）
        if (state.warp < 0.4) {
          state.warp = 1.25;
          state.status = '跃迁 · 正在加速';
        }
      } else if (id === 'orbit') {
        state.orbitSpin = !state.orbitSpin;
      } else if (id === 'home') {
        state.firstPerson = false;
        state.dist = 780;
        state.rx = 0;
        state.ry = 0.15;
        for (const b of bodies) {
          b.root.position.copy(b.home);
          b.vel.set(0, 0, 0);
        }
        state.status = '星域 · 归位';
      }
    },

    /** 手势：捏合（抓/放星体）、横挥（跃迁）、轻触（拨一下星云） */
    gesture(ev) {
      if (!ev || !ev.type) return;
      if (ev.type === 'sweep') {
        buf.warps += 1;
        if (state.warp < 0.4) {
          state.warp = 1.1;
          state.status = '横挥 · 跃迁加速';
        }
        for (const b of bodies) {
          // 挥手把星体往外推一下
          b.vel.add(tmpV2.set(b.root.position.x, b.root.position.y, 0).normalize().multiplyScalar(140));
        }
      } else if (ev.type === 'tap') {
        buf.taps += 1;
        state.grain = Math.min(1, state.grain + 0.35);
      } else if (ev.type === 'pinch') {
        buf.taps += 0;
      }
    },

    hud() {
      return {
        status: state.status,
        value: Math.max(0, Math.min(1, state.warp)),
      };
    },

    debug() {
      return {
        firstPerson: state.firstPerson,
        warp: +state.warp.toFixed(2),
        grabbed: state.grabbed >= 0 ? 1 : 0,
        warps: buf.warps,
        grabs: buf.grabs,
        taps: buf.taps,
        releases: buf.releases,
        status: state.status,
        nearest: Math.round(nearestDist),
      };
    },

    stats() {
      let tris = 0;
      group.traverse((o) => {
        if (!o.isMesh && !o.isPoints) return;
        const g = o.geometry;
        if (!g) return;
        const count = g.index ? g.index.count : g.attributes.position ? g.attributes.position.count : 0;
        tris += o.isPoints ? 0 : Math.floor(count / 3) * (o.isInstancedMesh ? o.count : 1);
      });
      return { objects: group.children.length, tris, stars: STAR_FAR + STAR_MID + DUST, bodies: BODIES };
    },

    update(dt, frame) {
      const d = Math.min(dt, 0.05);
      state.t += d;
      const t = state.t;

      // ── 跃迁 / 巡航推进 ────────────────────────────────────
      if (state.warp > 0) state.warp = Math.max(0, state.warp - d * 0.55);
      const rush = state.warp * state.warp * 1400; // 二次曲线：一开始猛，收得也快
      state.grain = Math.max(0, state.grain - d * 0.9);
      const grain = state.grain;

      // ── 手：掌心光 + 巡航视差 + 拖星 ────────────────────────
      const hands = frame.hands || [];
      const h0 = hands[0];
      if (h0) {
        const w = handToWorld(h0);
        palmLight.position.set(w.x, w.y, w.z + 40);
        palmLight.material.opacity = 0.16 + 0.1 * Math.sin(t * 3.1);
        // 手在画面里左右上下 → 相机反向微移，产生「手在拨宇宙」的视差
        const nx = h0.tip.x / stage.w - 0.5;
        const ny = h0.tip.y / stage.h - 0.5;
        cam.position.x += (-nx * 180 - cam.position.x) * Math.min(1, d * 2.2);
        cam.position.y += (ny * 120 - cam.position.y) * Math.min(1, d * 2.2);

        // 捏住最近的星体 → 拖
        if (h0.pinch && h0.pinch.on) {
          if (state.grabbed < 0) {
            let best = -1;
            let bestD = 1e9;
            for (let i = 0; i < bodies.length; i += 1) {
              const dd = bodies[i].root.position.distanceTo(w);
              if (dd < bestD) {
                bestD = dd;
                best = i;
              }
            }
            nearestDist = best >= 0 ? bestD : -1;
            // 捏一下就抓「离手最近的那颗」——不设死距离阈值，捏空最恼人
            if (best >= 0) {
              state.grabbed = best;
              buf.grabs += 1;
              bodies[best].grabbed = true;
              state.status = '捏住 · 拖动一颗星';
            }
          }
          if (state.grabbed >= 0) {
            dragTarget.copy(w);
            dragTarget.z = bodies[state.grabbed].root.position.z;
            bodies[state.grabbed].root.position.lerp(dragTarget, Math.min(1, d * 9));
          }
        } else if (state.grabbed >= 0) {
          const b = bodies[state.grabbed];
          b.grabbed = false;
          // 甩出去：用最近一帧的位移当速度
          b.vel.copy(b.root.position).sub(dragTarget).multiplyScalar(6).clampLength(0, 900);
          buf.releases += 1;
          state.grabbed = -1;
          state.status = '松手 · 它自己飞';
        }
      } else {
        palmLight.material.opacity += (0 - palmLight.material.opacity) * Math.min(1, d * 3);
        cam.position.x *= 1 - d * 1.5;
        cam.position.y *= 1 - d * 1.5;
      }

      // ── 星体：弹簧回位 / 惯性 / 呼吸光 ──────────────────────
      for (let i = 0; i < bodies.length; i += 1) {
        const b = bodies[i];
        const p = b.root.position;
        if (!b.grabbed) {
          // 惯性
          p.addScaledVector(b.vel, d);
          b.vel.multiplyScalar(1 - Math.min(1, d * 1.4));
          // 弹回自己的轨道位（很软，像被星云牵着）
          tmpV.copy(b.home).sub(p).multiplyScalar(d * 0.55);
          b.vel.add(tmpV);
          if (p.length() > 2400) {
            p.copy(b.home);
            b.vel.set(0, 0, 0);
          }
        }
        // 呼吸光：尺寸与光晕周期性起伏
        const s = 1 + 0.06 * Math.sin(t * 1.7 + b.phase) + (b.grabbed ? 0.16 : 0);
        b.core.scale.setScalar(b.r * s);
        b.halo.scale.setScalar(b.r * 3.2 * s * (1 + grain * 0.3));
        b.halo.material.opacity = 0.12 + 0.05 * Math.sin(t * 2.3 + b.phase) + (b.grabbed ? 0.12 : 0);
        b.root.rotation.y += d * (0.25 + (b.grabbed ? 0.9 : 0));
      }

      // ── 星空层：自转 + 跃迁拉伸 ─────────────────────────────
      if (state.orbitSpin) {
        midStars.rotation.y += d * 0.035;
        nebGroup.rotation.z += d * 0.006;
      }
      farStars.rotation.y += d * 0.004;
      dust.rotation.y += d * 0.01;
      // 星点尺寸随跃迁放大（拉丝感）
      starMat.uniforms.uPx.value = 1 + state.warp * 2.2 + grain * 0.6;
      midMat.uniforms.uPx.value = 1 + state.warp * 1.8;

      // ── 相机：第三人称绕、第一人称在内部随手动 ──────────────
      if (state.firstPerson) {
        state.ry = 0.08 + Math.sin(t * 0.13) * 0.05;
        cam.position.z += ((state.dist * 0.35 + rush * 0.02) - cam.position.z) * Math.min(1, d * 3);
        cam.lookAt(0, 0, -600);
      } else {
        state.rx += d * 0.045;
        const dist = state.dist + rush * 0.06;
        const cx = Math.sin(state.rx) * dist * Math.cos(state.ry);
        const cz = Math.cos(state.rx) * dist * Math.cos(state.ry);
        const cy = Math.sin(state.ry) * dist;
        cam.position.x += (cx - cam.position.x) * Math.min(1, d * 1.6);
        cam.position.y += (cy - cam.position.y) * Math.min(1, d * 1.6);
        cam.position.z += (cz - cam.position.z) * Math.min(1, d * 1.6);
        cam.lookAt(0, 0, -300);
      }
      // 跃迁时轻微抖动
      if (state.warp > 0.05) {
        cam.position.x += Math.sin(t * 61) * state.warp * 2.4;
        cam.position.y += Math.cos(t * 53) * state.warp * 2.0;
      }
      cam.updateMatrixWorld();

      // 星云面片永远面向相机（不加色雾会看出是平面）
      for (const m of nebGroup.children) m.quaternion.copy(cam.quaternion);

      if (state.status === '跃迁 · 正在加速' && state.warp < 0.2) state.status = '星域 · 天鹅座悬臂';
    },
  };

  return api;
}

export default { META, createScene };