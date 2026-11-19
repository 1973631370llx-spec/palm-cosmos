/**
 * scenes/station.js — 空间站（v5 平台第四个场景）
 *
 * 设计取舍：
 *   · 两套视角要能用同一套手控逻辑：第三人称「手拖视角绕站体」、第一人称「手点控制台」，
 *     所以相机状态集中在一个 state 里，toggleView 只切模式；
 *   · 第一人称的控制台要能「悬停 + 捏合按下」：手在画面里的点从相机打一条射线，
 *     和驾驶舱里那块斜面板所在的平面求交，交点就是光标位置——不做物理碰撞，成本和收益都对；
 *   · 舱内不用真光源（没有灯反而更像夜景）：全部自发光材质 + 加色光斑，靠平台的 bloom 出光；
 *   · 手势只用「悬停 + 捏合」一种（外加第三人称下的手拖视角），符合「手势要少」。
 */

export const META = Object.freeze({
  id: 'station',
  label: '空间站',
  sub: 'ORBITAL STATION',
  hint: '捏合按控制台 · 推杆加速',
});

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);

/** 控制台平面（舱内）：z = -180，向后倾斜 18° */
const PANEL = { z: -460, tilt: -0.34, w: 640, h: 216, y: -105 };

function glowTexture(THREE, color = '#bfe0ff') {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, color);
  grd.addColorStop(0.4, 'rgba(150,190,255,0.35)');
  grd.addColorStop(1, 'rgba(120,160,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 圆点星星（Points + 自写 shader，省钱） */
function starField(THREE, n, radius) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3);
  const size = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const r = radius * rand(0.8, 1.4);
    const th = Math.random() * TAU;
    const ph = Math.acos(rand(-1, 1));
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = r * Math.cos(ph);
    pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    size[i] = rand(1.4, 5);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uPx: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aSize;
      uniform float uPx;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(aSize * uPx, 1.0, 5.0);
      }
    `,
    fragmentShader: /* glsl */ `
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        if (length(d) > 0.5) discard;
        gl_FragColor = vec4(0.86, 0.92, 1.0, smoothstep(0.5, 0.0, length(d)));
      }
    `,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

export function createScene(ctx) {
  const { THREE, group, stage, quality } = ctx;
  const low = quality === 'low';
  const mid = quality === 'mid';

  /* 相机：第三人称在外面，第一人称进驾驶舱 */
  const cam = new THREE.PerspectiveCamera(50, stage.w / stage.h, 1, 8000);
  cam.position.set(0, 120, 620);
  cam.lookAt(0, 0, 0);

  /* ── 星空（两个视角都用得上） ─────────────────────────────── */
  group.add(starField(THREE, low ? 900 : mid ? 1500 : 2200, 3600));

  /* ── 地球：大球 + 加色大气壳 ─────────────────────────────── */
  const earthGroup = new THREE.Group();
  // 位置算过：地板在 y=-255，地球原来放 y=-300 会被地板整块挡掉；\n  // 抬到窗口视线上（水平 7°、垂直 1°，竖屏半角约 11°），前窗里才真的有一颗地球。\n  earthGroup.position.set(-330, -40, -2700);
  const earthTex = (() => {
    // 程序生成的「海蓝 + 云带」，够远看一眼就行，别指望像卫星图
    const S = 256;
    const cv = document.createElement('canvas');
    cv.width = S;
    cv.height = S;
    const g = cv.getContext('2d');
    g.fillStyle = '#1c5b9e';
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 220; i += 1) {
      const x = Math.random() * S;
      const y = Math.random() * S;
      const r = rand(6, 40);
      g.fillStyle = Math.random() > 0.55 ? 'rgba(58,132,92,0.6)' : 'rgba(170,208,252,0.3)';
      g.beginPath();
      g.ellipse(x, y, r, r * rand(0.4, 1), Math.random() * TAU, 0, TAU);
      g.fill();
    }
    for (let i = 0; i < 90; i += 1) {
      g.fillStyle = `rgba(240,248,255,${rand(0.06, 0.2)})`;
      g.beginPath();
      g.ellipse(rand(0, S), rand(0, S), rand(10, 46), rand(3, 12), rand(-0.4, 0.4), 0, TAU);
      g.fill();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  })();
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(310, low ? 24 : 40, low ? 16 : 28),
    new THREE.MeshBasicMaterial({ map: earthTex }),
  );
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(330, 32, 20),
    new THREE.MeshBasicMaterial({
      color: '#7fb6ff',
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  earthGroup.add(earth, atmo);
  group.add(earthGroup);

  /* ── 空间站本体（第三人称看得见） ─────────────────────────── */
  const stationBody = new THREE.Group();
  const hull = new THREE.Mesh(
    new THREE.CylinderGeometry(52, 52, 300, 18, 1, true),
    new THREE.MeshBasicMaterial({ color: '#5d6a7e', side: THREE.DoubleSide }),
  );
  hull.rotation.z = Math.PI / 2;
  stationBody.add(hull);
  // 环段
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(150, 12, 10, 40),
    new THREE.MeshBasicMaterial({ color: '#4c5b70' }),
  );
  ring.rotation.x = Math.PI / 2;
  stationBody.add(ring);
  // 太阳能板（两块 instanced 板阵列）
  const panelGeo = new THREE.BoxGeometry(120, 2, 74);
  const panelMat = new THREE.MeshBasicMaterial({ color: '#1e3a6b' });
  const panels = new THREE.InstancedMesh(panelGeo, panelMat, low ? 8 : 14);
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3(1, 1, 1);
    let i = 0;
    for (let side = -1; side <= 1; side += 2) {
      for (let k = 0; k < (low ? 4 : 7); k += 1) {
        v.set(side * (250 + k * 126), 0, -20);
        m.compose(v, q, s);
        panels.setMatrixAt(i, m);
        i += 1;
        if (i >= panels.count) break;
      }
      if (i >= panels.count) break;
    }
    panels.instanceMatrix.needsUpdate = true;
  }
  stationBody.add(panels);
  // 舱壁小窗（加色小方块，像亮着的房间）
  const winGeo = new THREE.BoxGeometry(10, 10, 2);
  const winMat = new THREE.MeshBasicMaterial({ color: '#ffe3a8' });
  const windows = new THREE.InstancedMesh(winGeo, winMat, low ? 10 : 18);
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const s = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < windows.count; i += 1) {
      const a = rand(0, TAU);
      v.set(Math.cos(a) * 53, rand(-130, 130), Math.sin(a) * 53);
      m.compose(v, q, s);
      windows.setMatrixAt(i, m);
    }
    windows.instanceMatrix.needsUpdate = true;
  }
  stationBody.add(windows);
  group.add(stationBody);

  /* ── 驾驶舱（第一人称）：窗框 + 仪表 + 控制台 ─────────────── */
  const cockpit = new THREE.Group();
  group.add(cockpit);

  /* 舱壁：五块板（前脸留空 = 窗），这样前窗外面才是真的星空。
     早先用一个 BackSide 大盒子把相机罩住，代价是「窗外」也被封死，只剩一块死蓝色玻璃。 */
  const WALL_OFF_C = new THREE.Color('#05070b');
  const WALL_ON_C = new THREE.Color('#131b28');
  const wallMat = new THREE.MeshBasicMaterial({ color: '#131b28', side: THREE.DoubleSide });
  const wallParts = [
    { w: 700, h: 520, p: [0, 0, 260], rx: 0, ry: Math.PI }, // 后墙（相机背后）
    { w: 700, h: 520, p: [-330, 0, -140], rx: 0, ry: Math.PI / 2 }, // 左壁
    { w: 700, h: 520, p: [330, 0, -140], rx: 0, ry: -Math.PI / 2 }, // 右壁
    { w: 660, h: 620, p: [0, 265, -140], rx: Math.PI / 2, ry: 0 }, // 顶
    { w: 660, h: 620, p: [0, -255, -140], rx: -Math.PI / 2, ry: 0 }, // 地板
  ];
  const walls = [];
  for (const q of wallParts) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(q.w, q.h), wallMat);
    m.position.set(q.p[0], q.p[1], q.p[2]);
    m.rotation.set(q.rx, q.ry, 0);
    cockpit.add(m);
    walls.push(m);
  }
  const wall = walls[0]; // 保留这个名字：调色时按整舱处理

  /* 前窗：只在玻璃上留一层很淡的冷色，不挡星 */
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(560, 300),
    new THREE.MeshBasicMaterial({
      color: '#0a1424',
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    }),
  );
  glass.position.set(0, 30, -528);
  cockpit.add(glass);

  // 窗框（四条亮边，深空站该有的样子）
  const frameMat = new THREE.MeshBasicMaterial({ color: '#5b6a80' });
  const frameGeo = new THREE.BoxGeometry(1, 1, 1);
  const frames = [
    { s: [600, 8, 10], p: [0, 30 + 152, -524] },
    { s: [600, 8, 10], p: [0, 30 - 152, -524] },
    { s: [10, 312, 10], p: [-296, 30, -524] },
    { s: [10, 312, 10], p: [296, 30, -524] },
    { s: [8, 312, 8], p: [0, 30, -524] }, // 中间一根竖框，窗格感
  ];
  for (const f of frames) {
    const m = new THREE.Mesh(frameGeo, frameMat);
    m.scale.set(f.s[0], f.s[1], f.s[2]);
    m.position.set(f.p[0], f.p[1], f.p[2]);
    cockpit.add(m);
  }

  /* 舱内灯带：驾驶舱不能是一块黑。
     现实里这种舱会有沿着顶/底/侧壁走的冷光灯条，它既能照亮结构，
     又不会像面光那样把画面糊白（加色混合 + 低不透明度，只提亮自己）。 */
  const stripMat = new THREE.MeshBasicMaterial({
    color: '#2f567a',
    transparent: true,
    opacity: 0.52,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const stripGeo = new THREE.BoxGeometry(1, 1, 1);
  const strips = [
    { s: [640, 3, 3], p: [0, 246, -505] }, // 顶前
    { s: [640, 3, 3], p: [0, 246, 30] }, // 顶后
    { s: [640, 2, 2], p: [0, -238, -505] }, // 底前
    { s: [3, 3, 300], p: [-318, 246, -240] }, // 顶左
    { s: [3, 3, 300], p: [318, 246, -240] }, // 顶右
    { s: [2, 300, 2], p: [-318, -110, -505] }, // 侧前左
    { s: [2, 300, 2], p: [318, -110, -505] }, // 侧前右
    { s: [420, 2, 2], p: [0, 116, -512] }, // 窗下沿一条
  ];
  for (const s of strips) {
    const m = new THREE.Mesh(stripGeo, stripMat);
    m.scale.set(s.s[0], s.s[1], s.s[2]);
    m.position.set(s.p[0], s.p[1], s.p[2]);
    cockpit.add(m);
  }

  /* 控制台顶上的两盏舱灯：给面板一点俯照，顺便在画面上半部留两个亮斑 */
  const lampMat = new THREE.MeshBasicMaterial({
    color: '#b9d3ea',
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const lampGeo = new THREE.PlaneGeometry(150, 14);
  for (const lx of [-150, 150]) {
    const l = new THREE.Mesh(lampGeo, lampMat);
    l.position.set(lx, 214, -392);
    cockpit.add(l);
  }

  /* 控制台：一块斜面板（拉远到 z=-460，按钮缩到 48×30，
     否则一块按钮在画面里就有 200×130 px，整块面板会把屏幕糊成一片亮块） */
  const console3d = new THREE.Group();
  console3d.position.set(0, PANEL.y, PANEL.z);
  console3d.rotation.x = PANEL.tilt;
  cockpit.add(console3d);
  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(PANEL.w, PANEL.h, 10),
    new THREE.MeshBasicMaterial({ color: '#0d131c' }),
  );
  console3d.add(panel);
  // 面板上的一圈细线（像仪表边框）
  const bezel = new THREE.Mesh(
    new THREE.BoxGeometry(PANEL.w - 14, PANEL.h - 14, 2),
    new THREE.MeshBasicMaterial({ color: '#16202e' }),
  );
  bezel.position.z = 6;
  console3d.add(bezel);

  /* 6 个按钮：4 + 2 排布，各自有颜色和动作 */
  const BUTTONS = [
    { id: 'lights', label: '灯', color: '#ffd9a0', x: -150, y: 40 },
    { id: 'scan', label: '扫', color: '#b8f0c8', x: -50, y: 40 },
    { id: 'dock', label: '接', color: '#a9c6ff', x: 50, y: 40 },
    { id: 'arm', label: '臂', color: '#ffb7c9', x: 150, y: 40 },
    { id: 'nav', label: '航', color: '#c9d6ff', x: -100, y: -46 },
    { id: 'thrust', label: '推', color: '#ffe6c2', x: 100, y: -46 },
  ];
  const buttons = [];
  const btnGeo = new THREE.BoxGeometry(50, 32, 8);
  const glowGeo = new THREE.PlaneGeometry(86, 68);
  for (const b of BUTTONS) {
    const mesh = new THREE.Mesh(btnGeo, new THREE.MeshBasicMaterial({ color: b.color }));
    mesh.position.set(b.x, b.y, 11);
    console3d.add(mesh);
    const glow = new THREE.Mesh(
      glowGeo,
      new THREE.MeshBasicMaterial({
        map: glowTexture(THREE, b.color),
        transparent: true,
        opacity: 0.18,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    glow.position.set(b.x, b.y, 15);
    console3d.add(glow);
    buttons.push({ ...b, mesh, glow, press: 0, on: false });
  }

  /* 推杆：一根杆 + 一个把手，上下滑动 */
  const throttleGroup = new THREE.Group();
  throttleGroup.position.set(252, -30, 18);
  const leverTrack = new THREE.Mesh(
    new THREE.BoxGeometry(9, 96, 5),
    new THREE.MeshBasicMaterial({ color: '#2a3a52' }),
  );
  const leverKnob = new THREE.Mesh(
    new THREE.SphereGeometry(10, 12, 10),
    new THREE.MeshBasicMaterial({ color: '#ffe6c2' }),
  );
  leverKnob.position.y = 0;
  throttleGroup.add(leverTrack, leverKnob);
  console3d.add(throttleGroup);

  /* 机械臂：三段 + 夹爪，从控制台右侧伸出去 */
  const armRoot = new THREE.Group();
  armRoot.position.set(292, -60, 14);
  console3d.add(armRoot);
  const armSegs = [];
  {
    const segGeo = new THREE.BoxGeometry(11, 74, 11);
    segGeo.translate(0, 37, 0); // 让旋转绕根部
    let parent = armRoot;
    for (let i = 0; i < 3; i += 1) {
      const seg = new THREE.Group();
      const mesh = new THREE.Mesh(segGeo, new THREE.MeshBasicMaterial({ color: '#5b6a80' }));
      seg.add(mesh);
      parent.add(seg);
      armSegs.push(seg);
      parent = seg;
      parent.position.y = i === 0 ? 0 : 74;
    }
    // 夹爪
    const grip = new THREE.Group();
    grip.position.y = 76;
    const jawGeo = new THREE.BoxGeometry(5, 22, 5);
    const jawA = new THREE.Mesh(jawGeo, new THREE.MeshBasicMaterial({ color: '#ffe6c2' }));
    const jawB = new THREE.Mesh(jawGeo, new THREE.MeshBasicMaterial({ color: '#ffe6c2' }));
    jawA.position.x = -6;
    jawB.position.x = 6;
    grip.add(jawA, jawB);
    parent.add(armSegs.grip = grip);
    armSegs.jaws = [jawA, jawB];
  }

  /* 光标环（第一人称：手在哪，环在哪） */
  const cursor = new THREE.Group();
  const cursorMats = [];
  for (let i = 0; i < 3; i += 1) {
    const t = new THREE.Mesh(
      new THREE.TorusGeometry(13 - i * 3, 0.8, 6, 30),
      new THREE.MeshBasicMaterial({
        color: '#ffe6c2',
        transparent: true,
        opacity: 0.75,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    cursorMats.push(t.material);
    cursor.add(t);
  }
  cursor.position.set(0, 0, 24);
  console3d.add(cursor);
  cursor.visible = false;
  // 扫描光带（一条加色长条，scan 时扫过舱体）
  const scanBeam = new THREE.Mesh(
    new THREE.PlaneGeometry(760, 8),
    new THREE.MeshBasicMaterial({
      color: '#b8f0c8',
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  scanBeam.position.set(0, 0, -300);
  cockpit.add(scanBeam);

  // 对接口光带（dock 时亮起来）
  const dockRing = new THREE.Mesh(
    new THREE.TorusGeometry(70, 4, 8, 36),
    new THREE.MeshBasicMaterial({
      color: '#a9c6ff',
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  dockRing.position.set(0, -120, -2200);
  group.add(dockRing);

  /* ── 状态 ─────────────────────────────────────────────────── */
  // 舱内三种材质的「暗/亮」色（都是 sRGB 深色：夜景靠点缀的光，不靠把墙照亮）
  const WALL_OFF = new THREE.Color('#05070b');
  const WALL_ON = new THREE.Color('#0a0e15');
  const PANEL_OFF = new THREE.Color('#0a0e15');
  const PANEL_ON = new THREE.Color('#0d131c');
  const BEZEL_OFF = new THREE.Color('#121a26');
  const BEZEL_ON = new THREE.Color('#16202e');

  const state = {
    firstPerson: false,
    t: 0,
    rx: 0,
    ry: 0.12,
    dist: 1500,
    handPan: { x: 0, y: 0 },
    lightsOn: true,
    thrust: 0.25,
    target: 0.25,
    scan: 0,
    dock: 0,
    armX: 0,
    armY: 0,
    grip: 0,
    pressed: '',
    hover: -1,
    status: '空间站 · 静默巡航',
    shake: 0,
  };

  /** 舱内「手 → 控制台平面」求交（不碰物理，纯几何） */
  const ndc = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const panelPlane = new THREE.Plane();
  const panelPoint = new THREE.Vector3(0, PANEL.y, PANEL.z);
  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const cursorLocal = new THREE.Vector3(0, 0, 26);

  function updatePanelPlane() {
    // 面板法线：绕 x 倾斜后的 +z
    panelPlane.setFromNormalAndCoplanarPoint(
      tmpV2.set(0, Math.sin(-PANEL.tilt), Math.cos(PANEL.tilt)).normalize(),
      panelPoint,
    );
  }

  function handToPanel(hand) {
    ndc.set((hand.tip.x / stage.w) * 2 - 1, -(hand.tip.y / stage.h) * 2 + 1);
    raycaster.setFromCamera(ndc, cam);
    const hit = new THREE.Vector3();
    const ok = raycaster.ray.intersectPlane(panelPlane, hit);
    if (!ok) return null;
    return hit;
  }

  function pressButton(b) {
    state.pressed = b.id;
    b.press = 1;
    b.on = !b.on;
    switch (b.id) {
      case 'lights':
        state.lightsOn = b.on;
        state.status = state.lightsOn ? '舱内灯 · 已开' : '舱内灯 · 全暗';
        break;
      case 'scan':
        state.scan = 1;
        state.status = '结构扫描 · 进行中';
        break;
      case 'dock':
        state.dock = 1;
        state.status = '对接口 · 光带张开';
        break;
      case 'arm':
        state.grip = state.grip > 0.5 ? 0 : 1;
        state.status = state.grip > 0.5 ? '机械臂 · 夹爪闭合' : '机械臂 · 夹爪张开';
        break;
      case 'nav':
        state.rx += 0.6;
        state.status = '姿态调整 · 转向对接口';
        break;
      case 'thrust':
        state.target = state.target > 0.6 ? 0.2 : 0.9;
        state.status = `推进 · ${Math.round(state.target * 100)}%`;
        break;
      default:
        break;
    }
  }

  const api = {
    camera: () => cam,

    enter(opts = {}) {
      state.firstPerson = !!opts.firstPerson;
      state.t = 0;
      state.status = state.firstPerson ? '驾驶舱 · 手就是操作杆' : '空间站 · 静默巡航';
    },

    exit() {
      state.pressed = '';
    },

    toggleView() {
      state.firstPerson = !state.firstPerson;
      state.status = state.firstPerson ? '驾驶舱 · 手就是操作杆' : '空间站 · 静默巡航';
      return state.firstPerson ? 'first' : 'third';
    },

    actions() {
      return [
        { id: 'lights', label: '舱内灯' },
        { id: 'scan', label: '扫描' },
        { id: 'dock', label: '对接口' },
        { id: 'arm', label: '机械臂' },
        { id: 'thrust', label: '推进' },
      ];
    },

    action(id) {
      const b = buttons.find((q) => q.id === id);
      if (b) pressButton(b);
    },

    gesture(ev) {
      if (!ev || !ev.type) return;
      if (ev.type === 'pinch' && state.firstPerson && state.hover >= 0) {
        pressButton(buttons[state.hover]);
      } else if (ev.type === 'pinch' && !state.firstPerson) {
        state.status = '第三视角 · 手左右拖动看站体';
      }
    },

    hud() {
      return {
        status: state.status,
        value: state.thrust,
      };
    },

    debug() {
      return {
        firstPerson: state.firstPerson,
        hover: state.hover,
        pressed: state.pressed,
        thrust: +state.thrust.toFixed(2),
        lightsOn: state.lightsOn,
        grip: state.grip,
        status: state.status,
      };
    },

    stats() {
      let tris = 0;
      group.traverse((o) => {
        if (!o.isMesh && !o.isInstancedMesh) return;
        const g = o.geometry;
        if (!g) return;
        const cnt = g.index ? g.index.count : g.attributes.position ? g.attributes.position.count : 0;
        tris += Math.floor(cnt / 3) * (o.isInstancedMesh ? o.count : 1);
      });
      return { objects: group.children.length, tris, buttons: buttons.length };
    },

    update(dt, frame) {
      const d = Math.min(dt, 0.05);
      state.t += d;
      const t = state.t;
      const hands = frame.hands || [];
      const h0 = hands[0];

      /* 推进：滑到目标值，带一点抖动 */
      state.thrust += (state.target - state.thrust) * Math.min(1, d * 1.6);
      state.shake = Math.max(0, state.shake - d * 2);
      const shake = state.thrust * state.thrust * 2.2 + state.shake * 3;

      /* 灯光 / 扫描 / 对接 的衰减 */
      state.scan = Math.max(0, state.scan - d * 0.55);
      state.dock = Math.max(0, state.dock - d * 0.4);
      scanBeam.material.opacity = Math.sin((1 - state.scan) * Math.PI) * 0.6 * (state.scan > 0 ? 1 : 0);
      scanBeam.position.y = 120 - (1 - state.scan) * 240;
      dockRing.material.opacity = state.dock * 0.7;
      dockRing.scale.setScalar(1 + (1 - state.dock) * 0.35);

      const lightLvl = state.lightsOn ? 1 : 0.22;
      for (const b of buttons) {
        b.press = Math.max(0, b.press - d * 2.4);
        b.mesh.position.z = 12 - b.press * 5;
        const glowBase = b.on ? 0.26 : 0.1;
        b.glow.material.opacity = (glowBase + b.press * 0.3) * lightLvl;
      }
      // 舱内亮度：用两个「真的暗」的色值插值（早先 setScalar(0.1) 是线性值 = 中灰，
      // 整块舱壁会被照成一堵白墙，实测整屏平均亮度 188/255，必须用 sRGB 暗色）
      const dimK = state.lightsOn ? 1 : 0;
      wallMat.color.copy(WALL_OFF).lerp(WALL_ON, dimK);
      panel.material.color.copy(PANEL_OFF).lerp(PANEL_ON, dimK);
      bezel.material.color.copy(BEZEL_OFF).lerp(BEZEL_ON, dimK);

      /* 推杆：把手位置跟 thrust */
      leverKnob.position.y = -50 + state.thrust * 100;
      throttleGroup.rotation.z = -state.thrust * 0.12;

      /* 地球自转、星空缓慢转（两个视角都有动静） */
      earth.rotation.y += d * 0.02;
      earthGroup.rotation.y += d * 0.004;

      /* 站体：第三人称自转；第一人称时把站体藏起来（进了舱就看不见它了） */
      stationBody.visible = !state.firstPerson;
      cockpit.visible = state.firstPerson;
      stationBody.rotation.y += d * 0.06;

      if (state.firstPerson) {
        /* ── 第一人称 ─────────────────────────────────────── */
        updatePanelPlane();
        const handWorld = h0 ? handToPanel(h0) : null;
        let hoverIdx = -1;

        if (handWorld) {
          // 换算到控制台局部坐标，判断离哪个按钮最近
          tmpV.copy(handWorld);
          console3d.worldToLocal(tmpV);
          cursorLocal.set(
            Math.max(-PANEL.w / 2 + 10, Math.min(PANEL.w / 2 - 10, tmpV.x)),
            Math.max(-PANEL.h / 2 + 8, Math.min(PANEL.h / 2 - 8, tmpV.y)),
            26,
          );
          cursor.position.lerp(cursorLocal, Math.min(1, d * 12));
          cursor.visible = true;
          for (let i = 0; i < buttons.length; i += 1) {
            const b = buttons[i];
            const dd = Math.hypot(cursor.position.x - b.x, cursor.position.y - b.y);
            if (dd < 46) {
              hoverIdx = i;
              break;
            }
          }
          // 悬停高亮
          const pulse = 1 + 0.1 * Math.sin(t * 8);
          cursor.scale.setScalar(hoverIdx >= 0 ? 1.25 * pulse : 1);
          for (let i = 0; i < cursorMats.length; i += 1) {
            cursorMats[i].opacity = hoverIdx >= 0 ? 0.95 : 0.55;
            cursorMats[i].color.set(hoverIdx >= 0 ? '#fff2cf' : '#ffe6c2');
          }
          state.hover = hoverIdx;

          // 抓住推杆区（右侧）→ 手的上下动推杆
          const nearLever = Math.hypot(cursor.position.x - 252, cursor.position.y + 30) < 58;
          if (h0.pinch && h0.pinch.on && nearLever) {
            const v = Math.max(0, Math.min(1, (cursor.position.y + 70) / 140));
            state.target = v;
            state.status = `推杆 · ${Math.round(v * 100)}%`;
          }
          // 抓住左侧空白区 → 驱动机械臂末端
          const armZone = cursor.position.x < -160;
          if (armZone && !(h0.pinch && h0.pinch.on)) {
            state.armX += (Math.max(-1, Math.min(1, cursor.position.x / 240)) - state.armX) * Math.min(1, d * 5);
            state.armY += (Math.max(-1, Math.min(1, cursor.position.y / 90)) - state.armY) * Math.min(1, d * 5);
          }
        } else {
          cursor.visible = false;
          state.hover = -1;
        }

        /* 机械臂：三段用正弦分配角度，末端跟手 */
        armSegs[0].rotation.z = state.armX * 0.7;
        armSegs[0].rotation.x = -0.4 + state.armY * 0.5;
        armSegs[1].rotation.z = Math.sin(t * 0.8) * 0.25 + state.armX * 0.5;
        armSegs[2].rotation.z = 0.5 + state.armY * 0.4;
        const jawOpen = 1 - state.grip;
        armSegs.jaws[0].position.x = -7 - jawOpen * 6;
        armSegs.jaws[1].position.x = 7 + jawOpen * 6;

        /* 相机：舱内朝前看，推进时轻微抖 */
        cam.position.x += (Math.sin(t * 0.4) * 6 - cam.position.x) * Math.min(1, d * 2);
        cam.position.y += (Math.sin(t * 0.31) * 4 - cam.position.y) * Math.min(1, d * 2);
        cam.position.z += (60 - cam.position.z) * Math.min(1, d * 2);
        cam.position.x += Math.sin(t * 47) * shake * 0.5;
        cam.position.y += Math.cos(t * 39) * shake * 0.5;
        cam.lookAt(0, -8, -600);
      } else {
        /* ── 第三人称：手左右拖 → 视角绕站体 ─────────────────── */
        if (h0) {
          const nx = h0.tip.x / stage.w - 0.5;
          const ny = h0.tip.y / stage.h - 0.5;
          state.handPan.x += (nx - state.handPan.x) * Math.min(1, d * 3);
          state.handPan.y += (ny - state.handPan.y) * Math.min(1, d * 3);
        } else {
          state.handPan.x *= 1 - d * 2;
          state.handPan.y *= 1 - d * 2;
        }
        state.rx += d * 0.12 + state.handPan.x * d * 2.4;
        state.ry = 0.12 + state.handPan.y * 0.5;
        const dist = state.dist - state.thrust * 420;
        const cx = Math.sin(state.rx) * dist * Math.cos(state.ry);
        const cz = Math.cos(state.rx) * dist * Math.cos(state.ry);
        const cy = Math.sin(state.ry) * dist;
        const k = Math.min(1, d * 2);
        cam.position.x += (cx - cam.position.x) * k;
        cam.position.y += (cy - cam.position.y) * k;
        cam.position.z += (cz - cam.position.z) * k;
        cam.position.x += Math.sin(t * 43) * shake * 0.8;
        cam.position.y += Math.cos(t * 37) * shake * 0.8;
        cam.lookAt(0, 0, 0);
      }

      cam.updateMatrixWorld();

      /* 捏合按按钮：引擎不发 pinch 事件（那是花的逻辑），所以自己判边沿 ——
         「上一帧没捏、这一帧捏了」且光标停在某个按钮上 = 按下。 */
      const pinchNow = !!(h0 && h0.pinch && h0.pinch.on);
      if (state.firstPerson && pinchNow && !state.wasPinch && state.hover >= 0) {
        pressButton(buttons[state.hover]);
      }
      state.wasPinch = pinchNow;

      /* 状态回落：压下去 1.4 秒还没新动作就回到一句中性描述 */
      if (state.pressed) {
        state.pressed = '';
      }
    },
  };

  return api;
}

export default { META, createScene };