/**
 * scenes/xmas.js — 圣诞树（v6「能玩的圣诞树」）
 *
 * 为什么这么改（v5 的教训：好看，但玩不了、看不懂）：
 *   · 玩法只留两条主线，而且两条都在 0.2 秒内出现实物反馈：
 *     手停在树冠里 → 礼物一件件落；横挥 → 摇树（整棵晃 + 成片礼物 + 雪被震落）。
 *     人不需要先理解规则，先看到东西掉下来就懂了；
 *   · 礼物落进雪地会按「下面有没有东西」叠起来 → 堆本身是进度条，右下角数字 +1 是第二重确认；
 *   · 捏合只认树顶星那一小块（舞台 480..600 / 300..460），别处的捏合不再乱触发；
 *   · 整棵树挂在 treeGroup 里、原点放在树根，摇的时候绕根晃，不会像被从中间折断；
 *   · 礼物是 24 件固定池子 + 4 个 InstancedMesh（盒 / 两条丝带 / 蝴蝶结），回收只改矩阵，
 *     所以「最多 24 件、超出回收最旧」既便宜又不可能泄漏；
 *   · 全场景 MeshBasicMaterial / ShaderMaterial（没有灯），靠暗底 + 少量亮点出层次，
 *     亮色（>0.85）交给平台的 bloom 发光，自己不写后处理；
 *   · 所有动画按 dt 推进，update 里不 new，不用 setTimeout。
 */

export const META = Object.freeze({
  id: 'xmas',
  label: '圣诞树',
  sub: 'CHRISTMAS TREE',
  hint: '手放树上掉礼物 · 挥手摇落一场雪',
  howto: [
    '把手放到树冠上，礼物一件件掉下来',
    '礼物落地会堆在树下，右下角数字 +1',
    '横挥手 = 摇树，礼物成片掉、雪被震落',
    '捏合点树顶那颗星 = 灯串 开 / 关',
  ],
});

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);

/** 树的外形：底部半径、高度、层数（世界坐标；树根在 y = base） */
const TREE = { r: 300, h: 900, base: -420, tiers: 3 };

/** 树冠在舞台上的投影（玩法 1 的判定框，y 向下）——手放进来就掉礼物 */
const CROWN = { x0: 300, x1: 780, y0: 420, y1: 1500 };

/** 树冠外再放宽一圈：手还没进树冠时也有暖光跟着，靠近了才变亮 */
const CROWN_NEAR = { x0: 170, x1: 910, y0: 300, y1: 1620 };

/** 树顶星在舞台上的判定框（玩法 4） */
const STAR_BOX = { x0: 480, x1: 600, y0: 300, y1: 460 };

/** 锥面在高度 k（0 底 → 1 顶）处的半径 */
const radiusAt = (k) => TREE.r * (1 - k) * 0.96 + 26;

/** 礼物盒子：6 个节日色（深红 / 墨绿 / 金 / 奶白 / 酒红 / 孔雀蓝）+ 亮丝带 */
const GIFT_COLORS = ['#8e1b2a', '#17503a', '#d8a542', '#f0e6d2', '#5e1230', '#0f6b7a'];
const RIBBON_COLORS = ['#ffd9a0', '#fff3d0', '#ffcf7a'];

/** 礼物落地速度阈值：低于这个不再弹，直接躺平（免得小抖动的盒子一直跳） */
const GRAVITY = 1500;
const SHAKE_TIME = 0.6;

const BASE_STATUS = '把手放在树上 · 礼物会掉下来';

/** 径向柔光贴图：灯点、星、手部暖光都用它（一张程序生成的 canvas 就够） */
function glowTexture(THREE, inner = '#fff3d0', midStop = 'rgba(255,225,175,0.5)') {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.42, midStop);
  grd.addColorStop(1, 'rgba(255,217,160,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 圆环贴图：礼物落地时在雪地上扩散的那一圈白光 */
function ringTexture(THREE) {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, S * 0.2, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(255,240,210,0)');
  grd.addColorStop(0.62, 'rgba(255,244,222,0)');
  grd.addColorStop(0.82, 'rgba(255,247,232,0.85)');
  grd.addColorStop(0.94, 'rgba(214,232,255,0.35)');
  grd.addColorStop(1, 'rgba(210,230,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 天幕贴图：夜空的垂直渐变 + 地平线暖光 + 疏星 + 一道雪坡剪影。
 * 为什么要它：竖屏里 65% 的画面是树背后的天，纯黑会把整屏平均亮度压到 30 出头，
 * 录屏出来就是「黑屏里一棵树」。这里给的是暗但看得见的层次，而不是一块亮墙。
 */
function skyTexture(THREE) {
  const W = 512;
  const H = 1024;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0.0, '#070a13');
  grd.addColorStop(0.28, '#0c1220');
  grd.addColorStop(0.5, '#141b2c');
  grd.addColorStop(0.64, '#1d2538');
  grd.addColorStop(0.72, '#28304a');
  grd.addColorStop(0.86, '#161b2a');
  grd.addColorStop(1.0, '#0c0f18');
  g.fillStyle = grd;
  g.fillRect(0, 0, W, H);
  // 地平线后一团暖光：树顶星和灯串在这上面才显得「有光在背后」
  const warm = g.createRadialGradient(W / 2, H * 0.68, 0, W / 2, H * 0.68, W * 0.62);
  warm.addColorStop(0, 'rgba(255,206,150,0.14)');
  warm.addColorStop(0.5, 'rgba(255,190,140,0.05)');
  warm.addColorStop(1, 'rgba(255,190,140,0)');
  g.fillStyle = warm;
  g.fillRect(0, 0, W, H);
  // 疏星：只在上半片，靠大小和透明度分远近
  for (let i = 0; i < 150; i += 1) {
    const x = Math.random() * W;
    const y = Math.pow(Math.random(), 1.5) * H * 0.62;
    const r = Math.random() < 0.12 ? rand(1.4, 2.2) : rand(0.7, 1.2);
    g.fillStyle = `rgba(220,232,255,${rand(0.1, 0.5)})`;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }
  // 远处雪坡剪影：只是一道比天稍亮的起伏，给「地平线」一个交代
  g.beginPath();
  g.moveTo(0, H * 0.735);
  for (let i = 0; i <= 16; i += 1) {
    g.lineTo((W * i) / 16, H * 0.735 + Math.sin(i * 1.7) * 7 + rand(-3, 3));
  }
  g.lineTo(W, H);
  g.lineTo(0, H);
  g.closePath();
  g.fillStyle = 'rgba(58,72,102,0.5)';
  g.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createScene(ctx) {
  const { THREE, group, stage, quality } = ctx;
  const low = quality === 'low';
  const mid = quality === 'mid';

  /* ── 相机：把树摆进竖屏的画法 ─────────────────────────────────
     1 世界单位 ≈ 1.19 舞台像素（1920 高看得到约 1613 单位），于是树顶星落在
     舞台 y≈382、雪地落在 y≈1500 —— 正好是「手一抬就在树上」的位置。 */
  const cam = new THREE.PerspectiveCamera(46, stage.w / stage.h, 1, 6000);
  const EYE_Y = 60;
  const CAM_DIST = 1900;
  const LOOK = new THREE.Vector3(0, 34, 0);
  const STAR_WORLD = new THREE.Vector3(0, TREE.base + TREE.h + 40, 0);
  cam.position.set(0, EYE_Y, CAM_DIST);
  cam.lookAt(LOOK);
  cam.updateMatrixWorld();

  /* ── 天幕：夜空的层次（树背后那一大片不能是纯黑） ───────────────── */
  const skyTex = skyTexture(THREE);
  const sky = new THREE.Mesh(
    new THREE.PlaneGeometry(3400, 3200),
    new THREE.MeshBasicMaterial({ map: skyTex, depthWrite: false }),
  );
  sky.position.set(0, 200, -1250);
  sky.frustumCulled = false;
  group.add(sky);

  /* ── 雪地：径向渐变 canvas + 一层细雪点 ─────────────────────── */
  const snowTex = (() => {
    const S = 512;
    const cv = document.createElement('canvas');
    cv.width = S;
    cv.height = S;
    const g = cv.getContext('2d');
    const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    // 中心比边缘亮两档：树下是「被灯照亮的一块雪」，礼物落在上面才看得见
    grd.addColorStop(0, '#5a6a86');
    grd.addColorStop(0.34, '#3f4d68');
    grd.addColorStop(0.62, '#242c40');
    grd.addColorStop(0.85, '#11161f');
    grd.addColorStop(1, '#05070c');
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 2600; i += 1) {
      const a = Math.random() * TAU;
      const r = Math.pow(Math.random(), 0.55) * (S / 2);
      g.fillStyle = `rgba(226,238,255,${0.05 + Math.random() * 0.22})`;
      g.fillRect(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, 1.4, 1.4);
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

  /* ── 树：挂在一个「原点在树根」的 group 里，摇树时绕根晃 ────────── */
  const treeGroup = new THREE.Group();
  treeGroup.position.y = TREE.base;
  group.add(treeGroup);

  const coneColors = ['#0b2a22', '#0d3026', '#10382b'];
  for (let i = 0; i < TREE.tiers; i += 1) {
    const k = i / TREE.tiers; // 0 底
    const h = TREE.h * (0.52 - i * 0.06);
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(radiusAt(k), h, 26, 1, true),
      new THREE.MeshBasicMaterial({ color: coneColors[i], side: THREE.DoubleSide }),
    );
    cone.position.y = h / 2 + TREE.h * k * 0.55; // 相对树根
    treeGroup.add(cone);
  }

  // 针叶簇：锥面上的小锥片，朝外张开（InstancedMesh，一次 draw call）
  const NEEDLE = low ? 900 : mid ? 1800 : 3000;
  const needleGeo = new THREE.ConeGeometry(9, 26, 3, 1, true);
  const needleMat = new THREE.MeshBasicMaterial({ color: '#14352a', side: THREE.DoubleSide });
  const needles = new THREE.InstancedMesh(needleGeo, needleMat, NEEDLE);
  needles.frustumCulled = false;
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3();
    const c = new THREE.Color();
    for (let i = 0; i < NEEDLE; i += 1) {
      // 高度偏下多一点：底部的枝更密，剪影才有「越往上越尖」的重量感
      const k = Math.pow(Math.random(), 0.75);
      const rad = radiusAt(k * 0.98);
      const a = Math.random() * TAU;
      v.set(Math.cos(a) * rad * rand(0.86, 1.02), k * TREE.h, Math.sin(a) * rad * rand(0.86, 1.02));
      e.set(rand(-0.5, 0.5), -a + Math.PI / 2, rand(-0.7, -0.2));
      q.setFromEuler(e);
      const sc = rand(0.55, 1.25);
      s.set(sc, sc * rand(0.8, 1.5), sc);
      m.compose(v, q, s);
      needles.setMatrixAt(i, m);
      // 少量枝头调亮：夜里雪压在梢上的那点亮
      const t = Math.random();
      c.set(t > 0.9 ? '#8ecfb0' : t > 0.7 ? '#245844' : '#12352a');
      needles.setColorAt(i, c);
    }
    needles.instanceMatrix.needsUpdate = true;
    if (needles.instanceColor) needles.instanceColor.needsUpdate = true;
  }
  treeGroup.add(needles);

  /* ── 灯串：一条螺旋缠上去的暖光灯点，每个点有自己的闪烁相位 ──────── */
  const LIGHTS = low ? 90 : mid ? 150 : 210;
  const glowTex = glowTexture(THREE);
  const lightGeo = new THREE.BufferGeometry();
  {
    const pos = new Float32Array(LIGHTS * 3);
    const size = new Float32Array(LIGHTS);
    const phase = new Float32Array(LIGHTS);
    for (let i = 0; i < LIGHTS; i += 1) {
      const t = i / LIGHTS;
      const k = 0.06 + t * 0.9;
      const a = t * TAU * 5.2;
      const rad = radiusAt(k) * 1.03;
      pos[i * 3] = Math.cos(a) * rad;
      pos[i * 3 + 1] = k * TREE.h;
      pos[i * 3 + 2] = Math.sin(a) * rad;
      size[i] = rand(5, 12);
      phase[i] = Math.random();
    }
    lightGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    lightGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    lightGeo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  }
  const lightMat = new THREE.ShaderMaterial({
    uniforms: {
      uPx: { value: 1 },
      uOn: { value: 1 },
      uTime: { value: 0 },
      uGlow: { value: glowTex },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aPhase;
      uniform float uPx;
      uniform float uOn;
      uniform float uTime;
      varying float vI;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        // 每颗灯自己闪：相位来自 aPhase，肉眼能看出「在闪」而不是整体呼吸
        float tw = 0.55 + 0.45 * sin(uTime * 2.7 + aPhase * 6.283);
        vI = uOn * (0.35 + 0.65 * tw);
        gl_PointSize = clamp(aSize * uPx * vI * (760.0 / max(240.0, -mv.z)), 1.0, 64.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uGlow;
      varying float vI;
      void main() {
        vec4 t = texture2D(uGlow, gl_PointCoord);
        gl_FragColor = vec4(t.rgb * 1.45, t.a * vI);
      }
    `,
  });
  const lightPoints = new THREE.Points(lightGeo, lightMat);
  lightPoints.frustumCulled = false;
  treeGroup.add(lightPoints);

  /* ── 树顶星 + 光晕（灯串一关，星也跟着暗，是「开关」的第二重反馈） ── */
  const starGroup = new THREE.Group();
  starGroup.position.y = TREE.h + 40;
  const STAR_ON = new THREE.Color('#fff4d0');
  const STAR_OFF = new THREE.Color('#6b5a3a');
  const starCore = new THREE.Mesh(
    new THREE.IcosahedronGeometry(34, 0),
    new THREE.MeshBasicMaterial({ color: '#ffe9b8' }),
  );
  const starHalo = new THREE.Mesh(
    new THREE.PlaneGeometry(380, 380),
    new THREE.MeshBasicMaterial({
      map: glowTexture(THREE, '#fff6dd', 'rgba(255,238,200,0.45)'),
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  starHalo.frustumCulled = false;
  // 第二层更大的淡光晕：星星在夜空里应该「有一圈空气感」。
  // 注意别做太大太亮 —— 它会连 bloom 一起把画面上半部糊成一块白。
  const starAura = new THREE.Mesh(
    new THREE.PlaneGeometry(760, 760),
    new THREE.MeshBasicMaterial({
      map: glowTexture(THREE, 'rgba(255,226,170,0.55)', 'rgba(255,206,150,0.16)'),
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  starAura.frustumCulled = false;
  starGroup.add(starCore, starHalo, starAura);
  treeGroup.add(starGroup);

  /* ── 挂饰：30 个球，长在锥面上（纯装饰，只慢慢浮 + 跟着灯串亮暗） ── */
  const ORN = low ? 16 : mid ? 24 : 30;
  const ornGeo = new THREE.SphereGeometry(1, 14, 10);
  const ornPalette = ['#ff8fa3', '#ffe1a8', '#c9d6ff', '#b8f0c8', '#ffd9a0'];
  const ornaments = [];
  for (let i = 0; i < ORN; i += 1) {
    const k = rand(0.08, 0.82);
    const a = rand(0, TAU);
    const rad = radiusAt(k) * 1.04;
    const hue = ornPalette[i % ornPalette.length];
    const core = new THREE.Mesh(ornGeo, new THREE.MeshBasicMaterial({ color: hue }));
    const halo = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: glowTexture(THREE, hue, 'rgba(255,225,180,0.35)'),
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    halo.frustumCulled = false;
    const r = rand(13, 21);
    core.scale.setScalar(r);
    halo.scale.setScalar(r * 9);
    core.position.set(Math.cos(a) * rad, k * TREE.h, Math.sin(a) * rad);
    halo.position.copy(core.position);
    treeGroup.add(core, halo);
    ornaments.push({ core, halo, r, homeY: core.position.y, phase: rand(0, TAU) });
  }

  /* ── 飘雪：2600 点，落到底部重生；摇树时整片雪被吹快、被吹斜 ────── */
  const SNOW = low ? 700 : mid ? 1400 : 2600;
  const snowGeo = new THREE.BufferGeometry();
  const snowPos = new Float32Array(SNOW * 3);
  const snowVel = new Float32Array(SNOW * 2); // 下落速度、漂移相位
  for (let i = 0; i < SNOW; i += 1) {
    snowPos[i * 3] = rand(-900, 900);
    snowPos[i * 3 + 1] = rand(TREE.base, 1500);
    snowPos[i * 3 + 2] = rand(-900, 700);
    snowVel[i * 2] = rand(40, 130);
    snowVel[i * 2 + 1] = rand(0, TAU);
  }
  snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
  const snowMat = new THREE.PointsMaterial({
    // 雪是「夜里的白点」，不是一层白膜：压暗 + 加色，才不会被 bloom 糊成一团白
    color: '#cfdcf5',
    size: 3.4,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const snow = new THREE.Points(snowGeo, snowMat);
  snow.frustumCulled = false;
  group.add(snow);

  /* ── 摇树时从树上抖下来的那一阵雪（一次性粒子，用完隐藏） ────────── */
  const PUFF = low ? 140 : mid ? 240 : 360;
  const puffPos = new Float32Array(PUFF * 3);
  const puffVel = new Float32Array(PUFF * 3);
  const puffGeo = new THREE.BufferGeometry();
  puffGeo.setAttribute('position', new THREE.BufferAttribute(puffPos, 3));
  const puffMat = new THREE.PointsMaterial({
    color: '#e7f0ff',
    size: 5.2,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const puff = new THREE.Points(puffGeo, puffMat);
  puff.frustumCulled = false;
  puff.visible = false;
  group.add(puff);

  /* ── 礼物池：24 件，4 个 InstancedMesh 画完（盒 / 丝带 ×2 / 蝴蝶结） ──
     为什么不是每件一个 Group：24 × 4 = 96 次 draw call，手机上太贵；
     合并成 4 个 InstancedMesh 后不管地上躺多少件都只有 4 次。
     几何/材质全程共享，回收只改实例矩阵 → 不可能泄漏。 */
  const GIFT_MAX = low ? 14 : mid ? 20 : 24;
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const giftMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  const ribbonMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  const bowGeo = new THREE.IcosahedronGeometry(0.5, 0);
  const bowMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  const boxMesh = new THREE.InstancedMesh(unitBox, giftMat, GIFT_MAX);
  const ribbonA = new THREE.InstancedMesh(unitBox, ribbonMat, GIFT_MAX);
  const ribbonB = new THREE.InstancedMesh(unitBox, ribbonMat, GIFT_MAX);
  const bowMesh = new THREE.InstancedMesh(bowGeo, bowMat, GIFT_MAX * 2);
  for (const m of [boxMesh, ribbonA, ribbonB, bowMesh]) {
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    group.add(m);
  }

  const gifts = [];
  for (let i = 0; i < GIFT_MAX; i += 1) {
    gifts.push({
      active: false,
      seq: 0,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      size: 60,
      bounce: 0,
      landed: false,
      groundY: 0,
      rotY: 0,
      spin: 0,
      tiltX: 0,
      tiltZ: 0,
      phase: 0,
    });
  }
  let giftSeq = 0;

  /* ── 落地光环：礼物每次碰地，雪地上扩散一圈白光（5 个够用了） ────── */
  const ringGeo = new THREE.PlaneGeometry(1, 1);
  const rings = [];
  for (let i = 0; i < 5; i += 1) {
    const mat = new THREE.MeshBasicMaterial({
      map: ringTexture(THREE),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(ringGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = TREE.base + 3;
    mesh.visible = false;
    mesh.frustumCulled = false;
    group.add(mesh);
    rings.push({ mesh, mat, life: 0, power: 1 });
  }

  /* ── 手部暖光：手在画面里动，树冠上就有一团跟着动的暖光 ────────────
     位置用「手在屏幕上的点」反投到树轴平面算出来，所以它永远正好贴在手指底下。 */
  const warmMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: glowTexture(THREE, '#ffd7a0', 'rgba(255,196,120,0.34)'),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  warmMesh.scale.set(560, 560, 1);
  warmMesh.frustumCulled = false;
  warmMesh.visible = false;
  group.add(warmMesh);

  /* ── 状态 ─────────────────────────────────────────────────── */
  const state = {
    t: 0,
    lightsOn: true,
    lights: 1, // 灯串亮度（缓动后的值，0..1）
    received: 0, // 累计收下的礼物数（hud 的 value 用它）
    status: BASE_STATUS,
    statusHold: 0,
    hover: 0, // 手在树冠里停留了多久
    hovering: false,
    drop: 0.16, // 下一次掉礼物的倒计时
    warm: 0, // 手部暖光强度
    shake: 0, // 摇树剩余时间
    gust: 0,
    snowBurst: 0, // 手语 ✌️ 撒雪的额外增速（秒）
    puffLife: 0,
    pinchCool: 0,
    pinchHeld: false,
    pinchFired: false, // 这一次捏合是不是已经切过灯了（松手才重置，长捏不会闪成跑马灯）
    shakeCool: 0,
    toggles: 0, // 灯串被切换过几次（自检用：一次捏合应该只 +1）
    swingArm: 0, // 横挥位移累计
    swingY: 0, // 同期纵向位移（用来区分「横挥」和「手斜着移」）
    swingDir: 0,
    swingOn: false,
    swingX: 0,
    swingY0: 0,
    tipX: -1,
    tipY: -1,
    firstPerson: false,
  };

  /* 预分配：update 里一个 new 都不许有 */
  const mtx = new THREE.Matrix4();
  const HIDE = new THREE.Matrix4().makeScale(0, 0, 0);
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scl = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const posB = new THREE.Vector3();
  const col = new THREE.Color();
  const rayV = new THREE.Vector3();
  const rayDir = new THREE.Vector3();
  const warmPos = new THREE.Vector3(0, 0, 0);
  const lookTmp = new THREE.Vector3();

  const inBox = (p, box) => p && p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1;

  /** 舞台坐标 → 世界坐标（投到过树轴的 z=0 平面：屏幕位置和手完全重合） */
  function stageToWorld(sx, sy, out) {
    rayV.set((sx / stage.w) * 2 - 1, 1 - (sy / stage.h) * 2, 0.5).unproject(cam);
    rayDir.copy(rayV).sub(cam.position).normalize();
    const dz = Math.abs(rayDir.z) < 1e-4 ? -1e-4 : rayDir.z;
    out.copy(cam.position).addScaledVector(rayDir, Math.max(0, -cam.position.z / dz));
    return out;
  }

  /** 落点高度：压在别的礼物上面就抬高（这就是「堆起来」的全部实现） */
  function groundFor(x, z, size, skip) {
    let y = TREE.base + size * 0.5;
    for (let i = 0; i < GIFT_MAX; i += 1) {
      if (i === skip) continue;
      const o = gifts[i];
      if (!o.active || !o.landed) continue;
      const dx = o.x - x;
      const dz = o.z - z;
      if (dx * dx + dz * dz > 118 * 118) continue;
      const top = o.y + o.size * 0.5 + size * 0.5 - 10; // 咬合 10 单位，堆起来才不像浮空
      if (top > y) y = top;
    }
    return y;
  }

  function flashRing(x, z, power) {
    let slot = null;
    for (const r of rings) {
      if (r.life <= 0) {
        slot = r;
        break;
      }
    }
    if (!slot) {
      slot = rings[0];
      for (const r of rings) if (r.life < slot.life) slot = r;
    }
    slot.life = 1;
    slot.power = power;
    slot.mesh.position.set(x, TREE.base + 3, z);
    slot.mesh.visible = true;
  }

  /** 从树冠上取一个位置生成礼物；池子满了就顶掉最旧的那件（seq 最小） */
  function spawnGift(kBias) {
    let slot = null;
    let oldest = Infinity;
    for (const g of gifts) {
      if (!g.active) {
        slot = g;
        break;
      }
      if (g.seq < oldest) {
        oldest = g.seq;
        slot = g;
      }
    }
    if (!slot) return;
    const k = Math.min(0.92, Math.max(0.12, (kBias || rand(0.12, 0.86)) + rand(-0.05, 0.05)));
    // 75% 从树的正面（z>0 朝向相机）掉：背面全被针叶挡住就白掉了
    const a = Math.random() < 0.75 ? rand(0.25, Math.PI - 0.25) : rand(0, TAU);
    const rad = radiusAt(k) * rand(0.45, 1.0);
    giftSeq += 1;
    slot.active = true;
    slot.seq = giftSeq;
    slot.size = rand(46, 74);
    // 注意：礼物挂在 group 下（世界坐标），树在 treeGroup 下用相对树根的坐标
    slot.x = Math.cos(a) * rad;
    slot.y = TREE.base + k * TREE.h;
    slot.z = Math.sin(a) * rad;
    slot.vx = Math.cos(a) * rand(8, 46);
    slot.vz = Math.sin(a) * rand(8, 46);
    slot.vy = rand(-40, -6);
    slot.bounce = 0;
    slot.landed = false;
    slot.groundY = groundFor(slot.x, slot.z, slot.size, -1);
    slot.rotY = rand(0, TAU);
    slot.spin = rand(-2.2, 2.2);
    slot.tiltX = rand(-0.3, 0.3);
    slot.tiltZ = rand(-0.3, 0.3);
    slot.phase = rand(0, TAU);

    const idx = gifts.indexOf(slot);
    const ci = (Math.random() * GIFT_COLORS.length) | 0;
    col.set(GIFT_COLORS[ci]);
    boxMesh.setColorAt(idx, col);
    col.set(RIBBON_COLORS[(Math.random() * RIBBON_COLORS.length) | 0]);
    ribbonA.setColorAt(idx, col);
    ribbonB.setColorAt(idx, col);
    bowMesh.setColorAt(idx * 2, col);
    bowMesh.setColorAt(idx * 2 + 1, col);
    if (boxMesh.instanceColor) boxMesh.instanceColor.needsUpdate = true;
    if (ribbonA.instanceColor) ribbonA.instanceColor.needsUpdate = true;
    if (ribbonB.instanceColor) ribbonB.instanceColor.needsUpdate = true;
    if (bowMesh.instanceColor) bowMesh.instanceColor.needsUpdate = true;
  }

  /** 把一件礼物写进 4 个 InstancedMesh（不活跃的用零缩放矩阵藏起来） */
  function writeGift(g, i) {
    if (!g.active) {
      boxMesh.setMatrixAt(i, HIDE);
      ribbonA.setMatrixAt(i, HIDE);
      ribbonB.setMatrixAt(i, HIDE);
      bowMesh.setMatrixAt(i * 2, HIDE);
      bowMesh.setMatrixAt(i * 2 + 1, HIDE);
      return;
    }
    const s = g.size;
    pos.set(g.x, g.y, g.z);
    euler.set(g.tiltX, g.rotY, g.tiltZ);
    quat.setFromEuler(euler);
    scl.set(s, s * 0.82, s);
    mtx.compose(pos, quat, scl);
    boxMesh.setMatrixAt(i, mtx);
    // 丝带绕盒一周：沿 x 一条、沿 z 一条，两条交叠成十字
    scl.set(s * 1.02, s * 0.86, s * 0.18);
    mtx.compose(pos, quat, scl);
    ribbonA.setMatrixAt(i, mtx);
    scl.set(s * 0.18, s * 0.86, s * 1.02);
    mtx.compose(pos, quat, scl);
    ribbonB.setMatrixAt(i, mtx);
    // 蝴蝶结：两片小疙瘩并排，落在盒顶
    for (let k = 0; k < 2; k += 1) {
      posB.set((k === 0 ? 0.15 : -0.15) * s, 0.46 * s, 0).applyQuaternion(quat).add(pos);
      scl.set(s * 0.17, s * 0.14, s * 0.17);
      mtx.compose(posB, quat, scl);
      bowMesh.setMatrixAt(i * 2 + k, mtx);
    }
  }

  /** 摇树：整棵绕根晃 0.6 秒 + 一次性掉 5 件 + 雪被震落 */
  function doShake() {
    // 平台手势和场景自己的横挥判定可能同一帧都触发；用一个冷却把「一次挥手」压成一次
    if (state.shakeCool > 0) return;
    state.shakeCool = 0.9;
    state.shake = SHAKE_TIME;
    state.gust = 1.5;
    for (let i = 0; i < 5; i += 1) spawnGift(0.12 + i * 0.17);
    // 抖雪：树冠表面炸出一层雪点
    puff.visible = true;
    state.puffLife = 1.6;
    for (let i = 0; i < PUFF; i += 1) {
      const k = rand(0.1, 0.95);
      const a = rand(0, TAU);
      const rad = radiusAt(k) * rand(0.55, 1.05);
      puffPos[i * 3] = Math.cos(a) * rad;
      puffPos[i * 3 + 1] = TREE.base + k * TREE.h;
      puffPos[i * 3 + 2] = Math.sin(a) * rad;
      puffVel[i * 3] = Math.cos(a) * rand(18, 80);
      puffVel[i * 3 + 1] = rand(-70, -10);
      puffVel[i * 3 + 2] = Math.sin(a) * rand(18, 80);
    }
    puffGeo.attributes.position.needsUpdate = true;
    state.status = '摇树 · 礼物成片落下';
    state.statusHold = 2.8;
  }

  function toggleLights() {
    state.lightsOn = !state.lightsOn;
    state.toggles += 1;
    state.status = state.lightsOn ? '灯串 · 开' : '灯串 · 关';
    state.statusHold = 2.4;
  }

  /* ── v7 手语动作：三个词就能把「掉礼物 / 灯串 / 雪」全玩一遍 ───────── */
  /** 🤟 爱你：灯串全开 + 下 8 件礼物（「喜欢就多给点」的直觉） */
  function signILY() {
    if (!state.lightsOn) toggleLights();
    for (let i = 0; i < 8; i += 1) spawnGift(0.1 + i * 0.1);
    state.gust = 1.2;
    state.status = '爱你 · 灯串全开，礼物成堆';
    state.statusHold = 2.8;
  }

  /** 👌 可以：掉一件特别大的礼物 */
  function signOK(sizeBias) {
    spawnGift(0.5);
    const last = gifts.reduce((a, b) => (b.active && (!a || b.seq > a.seq) ? b : a), null);
    if (last) last.size = 108; // 一件「大礼」：比平时的 46–74 明显大
    state.status = '可以 · 收下一件大礼物';
    state.statusHold = 2.4;
  }

  /** ✌️ 二：撒一场大雪 */
  function signV() {
    state.snowBurst = 1.4;
    state.gust = 1.8;
    state.status = '二 · 下雪了';
    state.statusHold = 2.4;
  }

  const api = {
    camera: () => cam,

    enter(opts = {}) {
      state.t = 0;
      state.shake = 0;
      state.gust = 0;
      state.hover = 0;
      state.drop = 0.16;
      state.shakeCool = 0;
      state.pinchFired = false;
      state.swingOn = false;
      state.swingArm = 0;
      state.status = BASE_STATUS;
      state.statusHold = 0;
      if (opts && opts.firstPerson) state.firstPerson = true;
    },

    exit() {
      state.shake = 0;
      state.gust = 0;
      state.hover = 0;
      state.swingOn = false;
      state.puffLife = 0;
      puff.visible = false;
      puffMat.opacity = 0;
    },

    toggleView() {
      state.firstPerson = !state.firstPerson;
      state.status = state.firstPerson ? '第一视角 · 站在树下抬头看星' : BASE_STATUS;
      state.statusHold = 2.4;
      return state.firstPerson ? 'first' : 'third';
    },

    actions() {
      return [
        { id: 'lights', label: '灯串 开/关', hint: '也可以捏合点树顶那颗星' },
        { id: 'shake', label: '摇一摇', hint: '也可以横挥手' },
      ];
    },

    action(id) {
      if (id === 'lights') toggleLights();
      else if (id === 'shake') doShake();
      return true;
    },

    gesture(ev) {
      if (!ev || !ev.type) return;
      if (ev.type === 'sweep') {
        doShake();
      } else if (ev.type === 'sign') {
        state.signs = (state.signs || 0) + 1;
        state.lastSign = ev.sign;
        if (ev.sign === 'thumbUp') doShake();
        else if (ev.sign === 'ily') signILY();
        else if (ev.sign === 'ok') signOK();
        else if (ev.sign === 'v') signV();
      } else if (ev.type === 'pinch') {
        // 捏合只在「指尖确实停在树顶星上」时才算开关，避免在别处捏一下就闪灯。
        // 冷却时间和 update 里的捏合检测共用：同一次捏合会被平台同时送进这两条路，
        // 不共用的话一次捏合会来回切两下 = 看起来没反应。
        if (state.pinchCool <= 0 && state.tipX >= STAR_BOX.x0 && state.tipX <= STAR_BOX.x1 && state.tipY >= STAR_BOX.y0 && state.tipY <= STAR_BOX.y1) {
          toggleLights();
          state.pinchCool = 0.7;
          state.pinchFired = true;
        }
      }
    },

    hud() {
      return { status: state.status, value: Math.min(1, state.received / 12) };
    },

    debug() {
      let active = 0;
      let landed = 0;
      for (const g of gifts) {
        if (!g.active) continue;
        active += 1;
        if (g.landed) landed += 1;
      }
      return {
        gifts: active,
        landed,
        received: state.received,
        lights: state.lightsOn,
        lightsLevel: +state.lights.toFixed(2),
        hovering: state.hovering,
        shake: +state.shake.toFixed(2),
        shakeCool: +state.shakeCool.toFixed(2),
        toggles: state.toggles,
        pinchHeld: state.pinchHeld,
        pinchInStar: !!state.pinchInStar,
        signs: state.signs || 0,
        lastSign: state.lastSign || '',
        snowBurst: +(state.snowBurst || 0).toFixed(2),
        status: state.status,
      };
    },

    stats() {
      let tris = 0;
      let objects = 0;
      group.traverse((o) => {
        if (!o.isMesh && !o.isPoints && !o.isInstancedMesh) return;
        objects += 1;
        if (o.isPoints) return;
        const g = o.geometry;
        if (!g) return;
        const cnt = g.index ? g.index.count : g.attributes.position ? g.attributes.position.count : 0;
        tris += Math.floor(cnt / 3) * (o.isInstancedMesh ? o.count : 1);
      });
      return { objects, tris, gifts: GIFT_MAX, needles: NEEDLE, lights: LIGHTS, ornaments: ORN, snow: SNOW };
    },

    dispose() {
      group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else if (m) m.dispose();
      });
      snowTex.dispose();
      skyTex.dispose();
      glowTex.dispose();
    },

    update(rawDt, frame) {
      const d = Math.min(rawDt, 0.05);
      state.t += d;
      const t = state.t;

      /* 事件状态显示几秒，然后回到常驻提示（不然玩完就看不懂下一步） */
      if (state.statusHold > 0) {
        state.statusHold -= d;
        if (state.statusHold <= 0) state.status = BASE_STATUS;
      }

      /* ── 相机：慢摆 + 圆盘推拉；第一视角站在树下抬头看星 ── */
      const dolly = frame && frame.input ? frame.input.dolly || 0 : 0;
      if (state.firstPerson) {
        const k = Math.min(1, d * 2.2);
        cam.position.x += (0 - cam.position.x) * k;
        cam.position.y += (TREE.base + 120 - cam.position.y) * k;
        cam.position.z += (620 - cam.position.z) * k;
        lookTmp.copy(STAR_WORLD);
      } else {
        const sway = Math.sin(t * 0.07) * 0.3;
        const dist = CAM_DIST - dolly * 420;
        cam.position.set(
          Math.sin(sway) * dist,
          EYE_Y + Math.sin(t * 0.21) * 14,
          Math.cos(sway) * dist,
        );
        lookTmp.copy(LOOK);
      }
      cam.lookAt(lookTmp);
      cam.updateMatrixWorld();

      /* ── 灯串 / 树顶星：亮度缓动，星色跟着走 ── */
      state.lights += ((state.lightsOn ? 1 : 0) - state.lights) * Math.min(1, d * 6);
      const L = state.lights;
      lightMat.uniforms.uTime.value = t;
      lightMat.uniforms.uOn.value = L;
      starCore.material.color.copy(STAR_OFF).lerp(STAR_ON, L);
      starCore.scale.setScalar(0.86 + 0.22 * L + 0.05 * Math.sin(t * 2.2));
      starHalo.material.opacity = 0.06 + 0.52 * L;
      starAura.material.opacity = 0.03 + 0.1 * L;
      starGroup.rotation.y += d * 0.5;
      // 光晕片反向转回来：星在自转，光晕要是跟着转就会周期性「变成一条边」
      starHalo.rotation.y = -starGroup.rotation.y;
      starAura.rotation.y = -starGroup.rotation.y;
      for (let i = 0; i < ornaments.length; i += 1) {
        const o = ornaments[i];
        o.core.position.y = o.homeY + Math.sin(t * 0.9 + o.phase) * 4;
        o.halo.position.y = o.core.position.y;
        o.halo.quaternion.copy(cam.quaternion); // 光晕永远对着相机，侧看才不是一条线
        o.halo.material.opacity = (0.14 + 0.24 * L) * (0.8 + 0.2 * Math.sin(t * 2.1 + o.phase));
      }

      /* ── 摇树：绕树根的 sin 衰减摆动 ── */
      if (state.shake > 0) {
        state.shake = Math.max(0, state.shake - d);
        const k = 1 - state.shake / SHAKE_TIME; // 0 → 1
        const amp = 0.075 * Math.exp(-3.2 * k) * Math.sin(k * 26);
        treeGroup.rotation.z = amp;
        treeGroup.rotation.x = amp * 0.45;
      } else {
        treeGroup.rotation.z *= 0.86;
        treeGroup.rotation.x *= 0.86;
      }

      /* ── 手：树冠里停留 → 按 0.55 秒节奏掉礼物；同时暖光跟着手走 ── */
      const hands = (frame && frame.hands) || [];
      let hoverHand = null;
      let nearHand = null;
      for (let i = 0; i < hands.length; i += 1) {
        const h = hands[i];
        if (inBox(h.tip, CROWN) || inBox(h.palm, CROWN)) {
          hoverHand = h;
          break;
        }
        if (!nearHand && (inBox(h.tip, CROWN_NEAR) || inBox(h.palm, CROWN_NEAR))) nearHand = h;
      }
      if (hands.length) {
        state.tipX = hands[0].tip.x;
        state.tipY = hands[0].tip.y;
      }

      /* ── 横挥 = 摇树：场景自己判一次 ──
         平台的 sweep 事件是给花的三朵锚点写的，在树冠里横划不一定发得出来；
         玩法必须自己保证能触发，所以按「0.4 秒内横向净位移攒够 240 舞台像素、
         同期纵向别跟着乱跑」判一次。慢移会被 620px/s 的衰减吃掉，不会误触。 */
      state.shakeCool = Math.max(0, state.shakeCool - d);
      const h0 = hands.length ? hands[0] : null;
      if (!h0) {
        state.swingOn = false;
        state.swingArm = 0;
        state.swingY = 0;
      } else if (h0.pinch && h0.pinch.on) {
        state.swingOn = false; // 捏着就不算挥（那是「点星」的姿势）
      } else {
        if (!state.swingOn) {
          state.swingOn = true;
          state.swingX = h0.tip.x;
          state.swingY0 = h0.tip.y;
          state.swingArm = 0;
          state.swingY = 0;
        }
        const dx = h0.tip.x - state.swingX;
        const dy = h0.tip.y - state.swingY0;
        state.swingX = h0.tip.x;
        state.swingY0 = h0.tip.y;
        state.swingArm = Math.max(0, state.swingArm - 620 * d);
        state.swingY = Math.max(0, state.swingY - 620 * d);
        if (dx !== 0 && Math.sign(dx) !== state.swingDir && Math.abs(dx) > 6) {
          state.swingArm = 0; // 换方向了：重新攒
          state.swingDir = Math.sign(dx);
        }
        state.swingArm += Math.abs(dx);
        state.swingY += Math.abs(dy);
        if (state.swingArm > 240 && state.swingY < state.swingArm * 0.9) {
          state.swingArm = 0;
          state.swingY = 0;
          doShake();
        }
      }
      // 手一进画面就有一团暖光跟过去（在树冠里更亮）——这就是「放上去有反应」的第一眼反馈
      const follow = hoverHand || nearHand;
      if (follow) {
        stageToWorld(follow.tip.x, follow.tip.y, warmPos);
        warmMesh.visible = true;
        state.warm = Math.min(1, state.warm + d * 4);
      } else {
        state.warm = Math.max(0, state.warm - d * 2.2);
      }
      state.hover = hoverHand ? Math.min(1.5, state.hover + d) : Math.max(0, state.hover - d * 3);
      state.hovering = state.hover > 0.12;
      if (state.warm > 0.01) {
        warmMesh.position.copy(warmPos);
        warmMesh.position.z += 40; // 往相机方向挪一点，别和针叶打架
        warmMesh.quaternion.copy(cam.quaternion); // 柔光片永远正对相机
        const power = hoverHand ? 1 : 0.45;
        warmMesh.material.opacity = state.warm * 0.34 * power * (0.85 + 0.15 * Math.sin(t * 6));
      } else {
        warmMesh.visible = false;
      }

      if (state.hovering) {
        state.drop -= d;
        if (state.drop <= 0) {
          spawnGift();
          state.drop = 0.55;
        }
      } else if (state.drop < 0.3) {
        // 手抬起来时把节奏收回起点，但不要瞬间清零（边界抖动会连发）
        state.drop = Math.min(0.3, state.drop + d);
      }

      /* ── 捏合点树顶星：捏住 + 指尖在星上 = 切一次，松手才允许下一次 ──
         不能只认「捏住的那一帧」：指尖位置是平滑过的，手伸过去再捏的那一瞬间
         指尖往往还在路上，只用上升沿会漏掉一大半；改成「捏着并且在星上」，
         再用 pinchFired 保证一次捏合只切一下。 */
      state.pinchCool = Math.max(0, state.pinchCool - d);
      let pinching = false;
      let pinchInStar = false;
      for (let i = 0; i < hands.length; i += 1) {
        const h = hands[i];
        if (h.pinch && h.pinch.on) {
          pinching = true;
          if (inBox(h.tip, STAR_BOX)) pinchInStar = true;
        }
      }
      if (pinchInStar && !state.pinchFired && state.pinchCool <= 0) {
        toggleLights();
        state.pinchCool = 0.7;
        state.pinchFired = true;
      }
      if (!pinching) state.pinchFired = false;
      state.pinchHeld = pinching;
      state.pinchInStar = pinchInStar;

      /* ── 礼物：重力 + 微曲线 + 两次弹跳 → 躺到「堆顶」 ── */
      for (let i = 0; i < GIFT_MAX; i += 1) {
        const g = gifts[i];
        if (g.active && !g.landed) {
          g.vy -= GRAVITY * d;
          g.x += g.vx * d + Math.sin(t * 2.4 + g.phase) * 14 * d;
          g.z += g.vz * d;
          g.y += g.vy * d;
          g.rotY += g.spin * d;
          g.vx *= 1 - Math.min(0.5, d * 0.9);
          g.vz *= 1 - Math.min(0.5, d * 0.9);
          if (g.y < TREE.base + 260) g.groundY = groundFor(g.x, g.z, g.size, i); // 快落地时按最新堆顶算
          if (g.y <= g.groundY && g.vy < 0) {
            g.y = g.groundY;
            g.x = Math.max(-470, Math.min(470, g.x));
            g.z = Math.max(-390, Math.min(390, g.z));
            if (g.bounce < 2 && g.vy < -110) {
              g.bounce += 1;
              g.vy = -g.vy * 0.32;
              g.vx *= 0.55;
              g.vz *= 0.55;
              flashRing(g.x, g.z, 0.45);
            } else {
              // 躺平：清掉速度，记一次「收下」
              g.vy = 0;
              g.vx = 0;
              g.vz = 0;
              g.landed = true;
              g.tiltX = rand(-0.06, 0.06);
              g.tiltZ = rand(-0.06, 0.06);
              state.received += 1;
              state.status = `收下第 ${state.received} 件礼物`;
              state.statusHold = 2.6;
              flashRing(g.x, g.z, 1);
            }
          }
        }
        writeGift(g, i);
      }
      boxMesh.instanceMatrix.needsUpdate = true;
      ribbonA.instanceMatrix.needsUpdate = true;
      ribbonB.instanceMatrix.needsUpdate = true;
      bowMesh.instanceMatrix.needsUpdate = true;

      /* ── 落地光环：躺在雪地上扩散 + 淡出（扁椭圆才有地平线的透视感） ── */
      for (let i = 0; i < rings.length; i += 1) {
        const r = rings[i];
        if (r.life <= 0) continue;
        r.life = Math.max(0, r.life - d * 1.25);
        const k = 1 - r.life;
        const s = r.power * (110 + k * 640);
        r.mesh.scale.set(s, s, 1);
        r.mat.opacity = r.life * 0.5 * r.power;
        if (r.life <= 0) {
          r.mesh.visible = false;
          r.mat.opacity = 0;
        }
      }

      /* ── 雪：越吹越快，摇完慢慢回来 ── */
      state.gust = Math.max(0, state.gust - d * 0.6);
      // 手语 ✌️「下雪」：额外给一段雪花增速，和 gust 分开算，不然摇树会把它顶掉
      state.snowBurst = Math.max(0, (state.snowBurst || 0) - d);
      const speed = 1 + state.gust * 1.7 + state.snowBurst * 2.4;
      const gust = state.gust;
      const sp = snowGeo.attributes.position.array;
      for (let i = 0; i < SNOW; i += 1) {
        const i3 = i * 3;
        sp[i3 + 1] -= snowVel[i * 2] * speed * d;
        sp[i3] += (Math.sin(t * 0.7 + snowVel[i * 2 + 1]) * 22 + gust * 420) * d;
        if (sp[i3 + 1] < TREE.base) {
          sp[i3] = rand(-900, 900);
          sp[i3 + 1] = rand(1200, 1600);
          sp[i3 + 2] = rand(-900, 700);
        }
        if (sp[i3] > 1050) sp[i3] = -900;
      }
      snowGeo.attributes.position.needsUpdate = true;
      snowMat.opacity = 0.36 + 0.2 * Math.min(1, gust);

      /* ── 抖下来的那阵雪 ── */
      if (state.puffLife > 0) {
        state.puffLife = Math.max(0, state.puffLife - d * 0.85);
        const pp = puffGeo.attributes.position.array;
        for (let i = 0; i < PUFF; i += 1) {
          const i3 = i * 3;
          puffVel[i3 + 1] -= 260 * d;
          pp[i3] += puffVel[i3] * d;
          pp[i3 + 1] += puffVel[i3 + 1] * d;
          pp[i3 + 2] += puffVel[i3 + 2] * d;
          if (pp[i3 + 1] < TREE.base) pp[i3 + 1] = TREE.base;
        }
        puffGeo.attributes.position.needsUpdate = true;
        puffMat.opacity = Math.min(1, state.puffLife) * 0.8;
        if (state.puffLife <= 0) {
          puff.visible = false;
          puffMat.opacity = 0;
        }
      }
    },
  };

  return api;
}

export default { META, createScene };