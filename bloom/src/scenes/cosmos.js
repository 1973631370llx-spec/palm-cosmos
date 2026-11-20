/**
 * scenes/cosmos.js — 掌心宇宙（v6 重写）
 *
 * 上一版的根因（用户原话「完全不知道在做什么，玩不来，画面也差」）：
 *   · 画面没有主体——三层星星均匀撒在球壳里，看不出「有个东西」；
 *   · 玩法是「张开手巡航 · 捏住拖星」，拖动全靠弹簧，用户摸不到因果，划过去也没反应。
 *
 * 这一版的取舍（为什么这么写）：
 *   · 主体 = 一只发光的手托着一团旋臂星系。手掌是 canvas 画的剪影（掌身压暗、指头点亮），
 *     星系是 3000–6000 个 Points 按对数螺旋排的，一眼能认出「这是星系」；
 *   · 三个反馈统一成一句「手在哪 → 哪就亮」：指尖光在 shader 里按 1/(1+d²) 抬亮附近的点，
 *     捏合点亮离手最近的主星（引擎没有 pinch 事件，所以自己判边沿），横挥让星野沿视线拉丝；
 *   · 全部自发光 + 加色混合，不写后处理：平台 bloom 阈值 0.42 只吃亮点，
 *     暗底 + 少量亮点才不会糊成灰雾（整屏平均亮度实测压在 45–75/255）。
 */

export const META = Object.freeze({
  id: 'cosmos',
  label: '掌心宇宙',
  sub: 'PALM COSMOS',
  hint: '手划过去星云亮 · 捏合点亮一颗星 · 横挥跃迁',
  howto: [
    '手在画面上划过去，星尘被拨亮',
    '捏一下，点亮离手最近的那颗星',
    '横挥一下 = 跃迁，星野拉成线',
    '右下圆盘往上推，凑近看星系',
  ],
});

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** 指数趋近：掉帧时不会越过目标，比 lerp(a,b,dt) 稳 */
const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

/** 相机基准：舞台 1080 宽 = 世界 1080 单位，1520 处看 z=0 平面的半高 = tan(23°)*1520 ≈ 645 */
const CAM = { fov: 46, dist: 1520, distFirst: 820, y: 60 };
/** 星系盘：世界坐标（y 向上），r 是盘半径；倾角小一点，旋臂在竖屏里才展开得开 */
const GAL = { y: 140, r: 265, tilt: -0.9 };
const TIP_Z = 40; // 指尖光比星系心往前这么多，落在盘面附近

/* ── 程序贴图 ─────────────────────────────────────────────── */

/** 径向柔光（指尖光 / 主星光晕 / 盘心辉光都用它，只改 tint 和 opacity） */
function glowTexture(THREE, inner, mid, size = 128) {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.3, mid);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 星云：几团偏心的软斑 + 细丝。低透明度加色铺在星系后面，只负责「气」 */
function nebulaTexture(THREE, hueA, hueB, seed) {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'lighter';
  const blobs = [
    { x: 0.44, y: 0.5, r: 0.46, c: hueA, a: 0.85 },
    { x: 0.6, y: 0.56, r: 0.34, c: hueB, a: 0.7 },
    { x: 0.5, y: 0.48, r: 0.7, c: '#2b3a8f', a: 0.5 },
  ];
  for (const b of blobs) {
    const grd = g.createRadialGradient(S * b.x, S * b.y, 0, S * b.x, S * b.y, S * b.r);
    grd.addColorStop(0, b.c);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalAlpha = b.a;
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
  }
  g.globalAlpha = 0.22;
  g.strokeStyle = '#c8d6ff';
  g.lineWidth = 1.4;
  for (let i = 0; i < 18; i += 1) {
    const y0 = rand(0, S);
    g.beginPath();
    g.moveTo(0, y0);
    for (let x = 0; x <= S; x += 16) {
      g.lineTo(x, y0 + Math.sin((x / S) * TAU * rand(0.6, 1.6) + seed) * rand(3, 16));
    }
    g.stroke();
  }
  g.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 手掌：先在一张「遮罩」画布上画实心形状，再分两次合成到成品——大模糊当外发光、
 * 小模糊当实体。为什么不用一层大模糊了事：糊得只剩一团亮斑时，用户看不出「这是手」，
 * 所以指头要留利边、指尖高低错开，顶边才有手指的锯齿；指缝宽度要大于模糊半径，
 * 否则四根指头会糊成一块（上一版就是这么变成柱子的）。
 * 腕部往下 fade 掉，读成「手从暗处伸出来」而不是一块方图。
 */
function palmTexture(THREE) {
  const W = 512;
  const H = 640;

  const shape = document.createElement('canvas');
  shape.width = W;
  shape.height = H;
  {
    const s = shape.getContext('2d');
    s.fillStyle = '#fff';
    s.strokeStyle = '#fff';
    s.lineCap = 'round';
    s.lineJoin = 'round';
    // 掌身：下缘出画（靠 fade 收），上缘是掌指关节那条线
    s.beginPath();
    s.moveTo(178, H);
    s.quadraticCurveTo(168, 520, 188, 432);
    s.lineTo(336, 422);
    s.quadraticCurveTo(354, 520, 338, H);
    s.closePath();
    s.fill();
    // 四指：小指短、中指长，指尖高低错开；指宽 34–38、间距 44–48，留 8–12px 指缝
    const fingers = [
      { x: 204, y: 430, len: 122, w: 34, bend: -20 }, // 小指
      { x: 252, y: 422, len: 164, w: 36, bend: -8 }, // 无名指
      { x: 300, y: 418, len: 184, w: 38, bend: 4 }, // 中指
      { x: 344, y: 426, len: 160, w: 36, bend: 16 }, // 食指
    ];
    for (const f of fingers) {
      s.lineWidth = f.w;
      s.beginPath();
      s.moveTo(f.x, f.y);
      s.quadraticCurveTo(f.x + f.bend, f.y - f.len * 0.55, f.x + f.bend * 1.4, f.y - f.len);
      s.stroke();
    }
    // 拇指：从掌侧斜着向上外展，明显离开四指，这是「手」最强的轮廓线索
    s.lineWidth = 44;
    s.beginPath();
    s.moveTo(192, 500);
    s.quadraticCurveTo(140, 448, 112, 386);
    s.stroke();
  }

  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  g.globalCompositeOperation = 'lighter';
  // 外发光：大半径、低强度
  g.filter = 'blur(26px)';
  g.globalAlpha = 0.5;
  g.drawImage(shape, 0, 0);
  // 实体：小半径利边，形状（手指、指缝）全靠这一层
  g.filter = 'blur(3px)';
  g.globalAlpha = 0.9;
  g.drawImage(shape, 0, 0);
  g.filter = 'none';
  g.globalAlpha = 1;

  // 上色：把白色剪影「染」成蜜金——用 source-in 只作用于已有像素，不会涂到透明区
  g.globalCompositeOperation = 'source-in';
  const warm = g.createLinearGradient(0, 0, 0, H);
  warm.addColorStop(0, '#fff3dc');
  warm.addColorStop(0.5, '#ffd9a0');
  warm.addColorStop(1, '#a8703c');
  g.fillStyle = warm;
  g.fillRect(0, 0, W, H);

  // 掌心那团光：星系的光落在手上。峰值只给 0.32——再高这里先烧成一团白，
  // bloom 会把它糊满半个屏幕（实测整屏平均亮度会冲到 90+，远超 45–75 的目标）
  g.globalCompositeOperation = 'lighter';
  const core = g.createRadialGradient(262, 508, 0, 262, 508, 178);
  core.addColorStop(0, 'rgba(255,246,226,0.32)');
  core.addColorStop(0.45, 'rgba(255,214,160,0.12)');
  core.addColorStop(1, 'rgba(255,214,160,0)');
  g.fillStyle = core;
  g.fillRect(0, 0, W, H);

  // 腕部往下化开，别让画布边缘露出直边
  g.globalCompositeOperation = 'destination-out';
  const fade = g.createLinearGradient(0, H * 0.7, 0, H);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = fade;
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'source-over';

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 竖直方向上「下亮上透」的光柱，用来把掌心光和星系连起来 */
function beamTexture(THREE) {
  const W = 128;
  const H = 256;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  const v = g.createLinearGradient(0, H, 0, 0);
  v.addColorStop(0, 'rgba(255,224,176,0.85)');
  v.addColorStop(0.55, 'rgba(190,190,255,0.28)');
  v.addColorStop(1, 'rgba(140,150,255,0)');
  g.fillStyle = v;
  g.fillRect(0, 0, W, H);
  // 横向收边：中间实、两边透，光柱才不会像一块矩形
  g.globalCompositeOperation = 'destination-in';
  const h = g.createLinearGradient(0, 0, W, 0);
  h.addColorStop(0, 'rgba(0,0,0,0)');
  h.addColorStop(0.5, 'rgba(0,0,0,1)');
  h.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = h;
  g.fillRect(0, 0, W, H);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 星点着色器（星野 / 星尘 / 星系共用一套程序，只换 uSizeK 和几何）：
 *   · uTip/uGlow：世界坐标距离 1/(1+d²)，d≈120 时权重剩一半——「手划过去」有确定的响应半径；
 *   · uWarp：视图空间里把点沿「相机→点」方向推近 = 屏幕上径向飞散；
 *     点精灵本身是方的，没法真的画成线段，所以在片元里沿径向把高斯拉长（vAxis 就是屏幕径向）。
 */
function starMaterial(THREE, shared, opts) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTip: shared.uTip,
      uGlow: shared.uGlow,
      uWarp: shared.uWarp,
      uPx: { value: shared.px },
      uSizeK: { value: opts.sizeK },
      uOpacity: { value: opts.opacity },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute vec3 aColor;
      uniform float uPx;
      uniform float uSizeK;
      uniform float uWarp;
      uniform float uGlow;
      uniform vec3  uTip;
      varying vec3 vC;
      varying vec2 vAxis;
      varying float vWarp;

      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        // 跃迁：每颗星沿自己那条射线被推近，屏幕上就是整片星野向外飞散
        mv.xyz *= 1.0 + uWarp * 0.55;

        vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
        vec3 dv = wp - uTip;
        // 7e-5 ≈ 1/14400：距离 120 世界单位时权重 0.5
        float glow = uGlow / (1.0 + dot(dv, dv) * 7.0e-5);

        gl_Position = projectionMatrix * mv;
        float atten = clamp(1500.0 / max(400.0, -mv.z), 0.45, 1.5);
        float px = aSize * uPx * uSizeK * atten * (1.0 + glow * 2.4 + uWarp * 1.1);
        gl_PointSize = clamp(px, 1.0, 34.0);

        vec2 dir = mv.xy;
        vAxis = dot(dir, dir) > 1.0e-4 ? normalize(dir) : vec2(0.0, 1.0);
        vC = aColor * (1.0 + glow * 2.6 + uWarp * 0.9);
        vWarp = uWarp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOpacity;
      varying vec3 vC;
      varying vec2 vAxis;
      varying float vWarp;

      void main() {
        vec2 q = gl_PointCoord - 0.5;
        float along = dot(q, vAxis);
        float across = dot(q, vec2(-vAxis.y, vAxis.x));
        float st = 1.0 + vWarp * 5.0;
        float r = sqrt(along * along / (st * st) + across * across);
        float a = smoothstep(0.5, 0.0, r);
        a *= 0.8 + 0.55 * smoothstep(0.18, 0.0, length(q));
        if (a < 0.004) discard;
        gl_FragColor = vec4(vC, a * uOpacity);
      }
    `,
  });
}

/** 指尖拖尾用的圆点（点位在 update 里改，材质只管大小和衰减） */
function dotMaterial(THREE, color, opacity) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uPx: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute float aFade;
      uniform float uPx;
      varying float vF;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(aSize * uPx * (1400.0 / max(400.0, -mv.z)), 1.0, 40.0);
        vF = aFade;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vF;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        if (r > 0.5) discard;
        float a = smoothstep(0.5, 0.0, r);
        gl_FragColor = vec4(uColor, a * a * vF * uOpacity);
      }
    `,
  });
}

export function createScene(ctx) {
  const { THREE, group, stage, quality } = ctx;

  /* 密度：低画质也必须「像星系」，所以星系点保底 3000；本场景几乎全是点，三角面远低于预算 */
  const low = quality === 'low';
  const mid = quality === 'mid';
  const GALAXY_N = low ? 3000 : mid ? 4400 : 5600;
  const FAR_N = low ? 900 : mid ? 1400 : 2000;
  const MID_N = low ? 280 : mid ? 460 : 680;
  const DUST_N = low ? 110 : mid ? 170 : 240;
  const STAR_N = low ? 8 : mid ? 10 : 12; // 主星：8–12 颗
  const TRAIL_N = 16;

  const cam = new THREE.PerspectiveCamera(CAM.fov, stage.w / stage.h, 1, 8000);
  cam.position.set(0, CAM.y, CAM.dist);
  cam.lookAt(0, GAL.y, 0);

  const px = Math.max(1, Math.min(ctx.dpr || 1, 2.5));
  /* 三个手势反馈共用的 uniform：改一处，三层星野 + 星系一起响应 */
  const shared = {
    uTip: { value: new THREE.Vector3(0, GAL.y, TIP_Z) },
    uGlow: { value: 0 },
    uWarp: { value: 0 },
    px,
  };

  const tmpV = new THREE.Vector3();
  const lookAt = new THREE.Vector3(0, GAL.y, 0);
  const camTarget = new THREE.Vector3(0, GAL.y, 0);

  /* ── 1. 星系盘：对数螺旋，两条臂 + 一个亮的核球 ─────────────── */
  const galaxyPivot = new THREE.Group(); // 只负责倾斜
  galaxyPivot.position.set(0, GAL.y, 0);
  galaxyPivot.rotation.x = GAL.tilt;
  galaxyPivot.rotation.z = 0.12;
  const galaxySpin = new THREE.Group(); // 只负责自转（在盘面内转，父级承担倾斜）
  galaxyPivot.add(galaxySpin);
  group.add(galaxyPivot);

  {
    const pos = new Float32Array(GALAXY_N * 3);
    const col = new Float32Array(GALAXY_N * 3);
    const size = new Float32Array(GALAXY_N);
    const coreCol = new THREE.Color('#ffe6c0');
    const armColors = [new THREE.Color('#a9c6ff'), new THREE.Color('#ffb7c9')];
    const tmpC = new THREE.Color();
    const R = GAL.r;
    const coreN = Math.floor(GALAXY_N * 0.14);
    const TURNS = 1.45;
    const spinAt = (arm, u) => arm * Math.PI + u * TURNS * TAU;
    /* 亮结：真实星系的旋臂上有一串亮团，撒点撒不出来——先定 9 个结，再把一部分点堆过去，
       这样「螺旋」是能顺着亮团读出来的，不是一片均匀的点云 */
    const knots = [];
    for (let k = 0; k < 9; k += 1) {
      knots.push({ arm: k % 2, u: 0.17 + (k / 9) * 0.82 + rand(-0.03, 0.03) });
    }
    for (let i = 0; i < GALAXY_N; i += 1) {
      let x;
      let y;
      let z;
      if (i < coreN) {
        // 核球：密度按 r^1.7 往上堆，越靠中心越挤（不然中心是一圈空心）
        const r = Math.pow(Math.random(), 1.7) * R * 0.24;
        const a = Math.random() * TAU;
        x = Math.cos(a) * r;
        y = Math.sin(a) * r;
        z = rand(-1, 1) * R * 0.07 * (1 - (r / (R * 0.24)) * 0.6);
        tmpC.copy(coreCol).multiplyScalar(rand(0.85, 1.15));
        size[i] = rand(2.6, 6.2);
      } else if (Math.random() < 0.24) {
        // 亮结附近：位置聚成一团，颜色更白更亮，尺寸更大
        const kn = knots[Math.floor(Math.random() * knots.length)];
        const u = Math.min(0.98, Math.max(0.1, kn.u + rand(-0.05, 0.05)));
        const r = R * (0.13 + 0.87 * u) + rand(-1, 1) * R * 0.035;
        const theta = spinAt(kn.arm, u) + rand(-1, 1) * 0.05;
        x = Math.cos(theta) * r;
        y = Math.sin(theta) * r;
        z = rand(-1, 1) * R * 0.035;
        tmpC.copy(armColors[kn.arm]).lerp(coreCol, 0.55).multiplyScalar(rand(0.9, 1.2));
        size[i] = rand(2.4, 5.4);
      } else {
        // 螺旋臂：u 沿臂走，r 线性长、角度按圈数累加，再给一点角度抖动当臂宽
        const arm = i % 2;
        const u = Math.pow(Math.random(), 0.62);
        const r = R * (0.13 + 0.87 * u);
        const theta = spinAt(arm, u) + rand(-0.1, 0.1) * (1.1 - u * 0.5);
        x = Math.cos(theta) * r;
        y = Math.sin(theta) * r;
        // 盘很薄：厚度随半径收窄，边缘有点翘，避免看起来像贴纸
        z = rand(-1, 1) * R * 0.042 * (1.15 - u * 0.7);
        tmpC.copy(armColors[arm]).multiplyScalar(rand(0.8, 1.1));
        if (u < 0.22) tmpC.lerp(coreCol, 0.55); // 臂根偏暖，接到核球上
        size[i] = rand(1.9, 4.6);
      }
      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;
      col[i * 3] = tmpC.r;
      col[i * 3 + 1] = tmpC.g;
      col[i * 3 + 2] = tmpC.b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    const mat = starMaterial(THREE, shared, { sizeK: 1, opacity: 0.95 });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 1;
    galaxySpin.add(pts);
  }

  /* 盘心辉光：正对相机的柔光片，比单纯的点更容易在 bloom 里烧出一个核 */
  const galaxyTex = glowTexture(THREE, 'rgba(255,246,226,1)', 'rgba(255,214,160,0.42)');
  const coreGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(300, 300),
    new THREE.MeshBasicMaterial({
      map: galaxyTex,
      color: 0xfff0d8,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  );
  coreGlow.position.set(0, GAL.y, TIP_Z - 20);
  coreGlow.renderOrder = 2;
  group.add(coreGlow);

  /* ── 2. 三层星野（远 / 中 / 尘），全部走同一套 shader ───────── */
  function starField(n, opts) {
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const c = new THREE.Color();
    for (let i = 0; i < n; i += 1) {
      if (opts.shell) {
        // 球壳：半径大、密度均匀，只当背景视差
        const r = rand(opts.rMin, opts.rMax);
        const th = Math.random() * TAU;
        const ph = Math.acos(rand(-1, 1));
        pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
        pos[i * 3 + 1] = r * Math.cos(ph);
        pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      } else {
        // 星尘：贴着星系盘铺一层扁的，手划过去最容易看见它亮
        const r = rand(opts.rMin, opts.rMax);
        const a = Math.random() * TAU;
        pos[i * 3] = Math.cos(a) * r;
        pos[i * 3 + 1] = GAL.y + Math.sin(a) * r * 0.55 + rand(-160, 160);
        pos[i * 3 + 2] = rand(-520, 160);
      }
      if (Math.random() > 0.9) c.setRGB(1, 0.86, 0.66);
      else if (Math.random() > 0.74) c.setRGB(0.72, 0.82, 1);
      else c.setRGB(0.92, 0.94, 1);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
      size[i] = rand(opts.sMin, opts.sMax);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    const mat = starMaterial(THREE, shared, { sizeK: opts.sizeK, opacity: opts.opacity });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 0;
    group.add(pts);
    return { pts, mat };
  }

  const far = starField(FAR_N, { shell: true, rMin: 1500, rMax: 2900, sMin: 1.2, sMax: 3.6, sizeK: 1, opacity: 0.85 });
  const midField = starField(MID_N, { shell: true, rMin: 900, rMax: 1500, sMin: 1.8, sMax: 5, sizeK: 1.1, opacity: 0.9 });
  const dust = starField(DUST_N, { shell: false, rMin: 260, rMax: 760, sMin: 2.4, sMax: 6.5, sizeK: 1.2, opacity: 0.55 });

  /* ── 3. 星云：两片大 plane，低透明度加色，只呼吸不抢戏 ─────── */
  const nebTexA = nebulaTexture(THREE, '#6f8bff', '#ff9ad5', 1.3);
  const nebTexB = nebulaTexture(THREE, '#7ad6ff', '#b9a0ff', 4.1);
  const nebulas = [];
  for (let i = 0; i < 2; i += 1) {
    const mat = new THREE.MeshBasicMaterial({
      map: i ? nebTexB : nebTexA,
      transparent: true,
      opacity: i ? 0.028 : 0.038,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400), mat);
    m.position.set(i ? 120 : -80, GAL.y + (i ? -40 : 30), -1100 - i * 260);
    m.rotation.z = i ? 1.1 : -0.4;
    m.renderOrder = -3;
    group.add(m);
    nebulas.push(m);
  }

  /* ── 4. 手掌：整张画的主体，星系就悬在它上面 ─────────────── */
  const palm = new THREE.Mesh(
    // 560×700 与 512×640 的贴图同比例，不会把手指拉扁
    new THREE.PlaneGeometry(560, 700),
    new THREE.MeshBasicMaterial({
      map: palmTexture(THREE),
      transparent: true,
      // 0.34：掌心已经是最亮的一团，再高会整片泛白，把星星压下去
      opacity: 0.34,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  );
  palm.position.set(0, -230, 30);
  palm.rotation.x = 0.1;
  palm.rotation.z = 0.02;
  palm.renderOrder = -2;
  group.add(palm);

  // 掌心外的第二层大光，让手真的像「托着」而不是举着
  const palmLight = new THREE.Mesh(
    new THREE.PlaneGeometry(620, 620),
    new THREE.MeshBasicMaterial({
      map: galaxyTex,
      color: 0xffd9a0,
      transparent: true,
      opacity: 0.1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  );
  palmLight.position.set(0, -300, 10);
  palmLight.renderOrder = -1;
  group.add(palmLight);

  // 光柱：把掌心光和星系连起来，读成「星系停在手上」而不是两坨分开的亮斑
  const beam = new THREE.Mesh(
    new THREE.PlaneGeometry(300, 420),
    new THREE.MeshBasicMaterial({
      map: beamTexture(THREE),
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  );
  beam.position.set(0, -34, 20);
  beam.renderOrder = -1;
  group.add(beam);

  /* ── 5. 主星：8–12 颗有光晕的亮星，捏合点亮的就是它们 ──────── */
  const mainStars = [];
  const haloGeo = new THREE.PlaneGeometry(190, 190);
  const coreGeo = new THREE.PlaneGeometry(54, 54);
  const dullColor = new THREE.Color('#6b80b8'); // 没点亮：偏冷的蓝白，看得见但不抢核球
  const palettes = [
    new THREE.Color('#fff0d0'),
    new THREE.Color('#cfe4ff'),
    new THREE.Color('#ffd8e8'),
    new THREE.Color('#d8ffe6'),
  ];
  for (let i = 0; i < STAR_N; i += 1) {
    // 角度均分 + 小抖动：抖动只给 ±0.07（间距的 13%），保证每颗星都有自己的「势力范围」，
    // 否则两颗挤在一起时，其中一颗永远选不中，用户就没法点亮整片星域
    const a = (i / STAR_N) * TAU + rand(-0.07, 0.07);
    const rr = rand(200, 330);
    const sx = Math.cos(a) * rr;
    const sy = GAL.y + Math.sin(a) * rr * 0.45;
    // z 都落在指尖光附近：差太多的话「离手最近」选出来的星不在手指下面，玩起来会莫名其妙
    const sz = 60 + rand(0, 80);
    const bright = palettes[i % palettes.length];
    const root = new THREE.Group();
    root.position.set(sx, sy, sz);
    const halo = new THREE.Mesh(
      haloGeo,
      new THREE.MeshBasicMaterial({
        map: galaxyTex,
        color: bright.clone(),
        transparent: true,
        opacity: 0.13,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      }),
    );
    const starCore = new THREE.Mesh(
      coreGeo,
      new THREE.MeshBasicMaterial({
        map: galaxyTex,
        color: dullColor.clone(),
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      }),
    );
    halo.renderOrder = 3;
    starCore.renderOrder = 4;
    root.add(halo, starCore);
    group.add(root);
    mainStars.push({
      root,
      halo,
      core: starCore,
      bright,
      baseY: sy,
      phase: rand(0, TAU),
      lit: false,
      burst: 0,
      k: 0, // 0 → 1 的亮度插值，避免「啪」地跳变
    });
  }

  /* ── 6. 指尖光 + 拖尾 + 星云热点（手在哪，哪就亮） ─────────── */
  const tipTex = glowTexture(THREE, 'rgba(255,250,240,1)', 'rgba(255,214,150,0.45)');
  const tipGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(260, 260),
    new THREE.MeshBasicMaterial({
      map: tipTex,
      color: 0xfff2dc,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  );
  tipGlow.position.set(0, GAL.y, TIP_Z);
  tipGlow.renderOrder = 5;
  group.add(tipGlow);

  const nebHot = new THREE.Mesh(
    new THREE.PlaneGeometry(760, 760),
    new THREE.MeshBasicMaterial({
      map: nebTexA,
      color: 0xbfd3ff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  );
  nebHot.position.set(0, GAL.y, -140);
  nebHot.renderOrder = 2;
  group.add(nebHot);

  const trailPos = new Float32Array(TRAIL_N * 3);
  const trailSize = new Float32Array(TRAIL_N);
  const trailFade = new Float32Array(TRAIL_N);
  for (let i = 0; i < TRAIL_N; i += 1) {
    trailSize[i] = 14 - i * 0.7;
    trailFade[i] = 0.55 - i * 0.028;
    trailPos[i * 3] = 0;
    trailPos[i * 3 + 1] = GAL.y;
    trailPos[i * 3 + 2] = TIP_Z;
  }
  const trailGeo = new THREE.BufferGeometry();
  const trailAttr = new THREE.BufferAttribute(trailPos, 3);
  trailAttr.setUsage(THREE.DynamicDrawUsage);
  trailGeo.setAttribute('position', trailAttr);
  trailGeo.setAttribute('aSize', new THREE.BufferAttribute(trailSize, 1));
  trailGeo.setAttribute('aFade', new THREE.BufferAttribute(trailFade, 1));
  const trailMat = dotMaterial(THREE, '#ffe6c0', 0.9);
  trailMat.uniforms.uPx.value = px;
  const trail = new THREE.Points(trailGeo, trailMat);
  trail.frustumCulled = false;
  trail.renderOrder = 5;
  group.add(trail);
  let trailHead = 0;
  let trailLife = 0;

  /* ── 状态 ─────────────────────────────────────────────────── */
  const WARP_DUR = 1.1; // 契约：星野拉伸 1.1 秒
  const WARP_CD = 1.5; // 契约：内部 1.5 秒冷却，别让一挥就刷屏
  const state = {
    t: 0,
    glow: 0,
    warpT: 0,
    warpCd: 0,
    warp: 0,
    dolly: 0,
    parallaxX: 0,
    parallaxY: 0,
    firstPerson: false,
    lit: 0,
    msg: '',
    msgT: 0,
    pinches: new Map(), // slot → 上一帧捏住了没（自己判边沿，引擎不给 pinch 事件）
    sweeps: 0,
  };
  /* 文案预生成：update 里不要再拼字符串、开新对象 */
  const starMsg = mainStars.map((s, i) => `点亮 · 第 ${i + 1} 颗星`);
  const IDLE_MSG = '掌心 · 星系停在你手上';
  const GLOW_MSG = '抚摸 · 星尘被你拨亮';
  const WARP_MSG = '跃迁 · 加速';
  const ALL_MSG = '整片星域亮了';

  /** 手语回执：单独一条通道，不会被跃迁 / 抚摸的常驻文案盖掉 */
  function signFlash(text, sec = 2.2) {
    state.signMsg = text;
    state.signMsgT = sec;
  }

  function flash(text, sec) {
    state.msg = text;
    state.msgT = sec;
  }

  function statusNow() {
    // 手语回执优先：比完一个词，屏幕上必须先说「这个词做了什么」，
    // 否则手一直在动、跃迁文案常驻，人根本分不清是自己比出来的还是画面本来就这样
    if (state.signMsgT > 0) return state.signMsg;
    if (state.warpT > 0.02) return WARP_MSG;
    if (state.msgT > 0) return state.msg;
    if (state.lit >= STAR_N && STAR_N > 0) return ALL_MSG;
    if (state.glow > 0.12) return GLOW_MSG;
    return IDLE_MSG;
  }

  function triggerWarp() {
    if (state.warpCd > 0) return false;
    state.warpT = WARP_DUR;
    state.warpCd = WARP_CD;
    return true;
  }

  /** 点亮离给定世界坐标最近的主星；已经在亮的就只补一次闪光 */
  function lightNearest(wx, wy, wz) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < mainStars.length; i += 1) {
      const s = mainStars[i];
      const dx = s.root.position.x - wx;
      const dy = s.root.position.y - wy;
      // z 方向压一半：盘是斜的，深度差会被透视放大，不压的话「看着就在手指下」的那颗会选不中
      const dz = (s.root.position.z - wz) * 0.5;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        best = i;
      }
    }
    if (best < 0) return;
    const s = mainStars[best];
    s.burst = 1;
    if (!s.lit) {
      s.lit = true;
      state.lit += 1;
      signFlash(state.lit >= STAR_N ? ALL_MSG : starMsg[best], 1.9);
    } else {
      signFlash(starMsg[best], 1.4);
    }
  }

  function resetAll() {
    for (const s of mainStars) {
      s.lit = false;
      s.burst = 0;
      s.k = 0;
    }
    state.lit = 0;
    state.glow = 0;
    state.warpT = 0;
    state.warpCd = 0;
    state.dolly = 0;
    state.firstPerson = false;
    signFlash('归位 · 回到掌心');
  }

  /** 手语 🤟「爱你」：一口气点亮整片星域（一次给满，别让人比两次） */
  function lightAll() {
    let fresh = 0;
    for (const s of mainStars) {
      if (!s.lit) {
        s.lit = true;
        fresh += 1;
      }
      s.burst = 1;
    }
    state.lit = mainStars.length;
    signFlash(fresh ? '爱你 · 整片星域亮了' : '爱你 · 星域已经全亮');
  }

  /**
   * 舞台坐标 → 世界坐标。
   * 为什么在相机坐标系里算：舞台坐标本来就是「屏幕上的一点」，先按视锥把它放到相机前方
   * 距离 D 的平面上，再乘相机世界矩阵——相机绕/俯/推拉时指尖光都正好落在手指下面。
   * D 取到星系心再往前 TIP_Z，指尖光就落在盘面附近，能真的把附近的星点抬亮。
   */
  function stageToWorld(sx, sy, out) {
    const viewDist = cam.position.distanceTo(lookAt);
    const D = Math.max(200, viewDist - TIP_Z);
    const halfH = Math.tan((cam.fov * Math.PI) / 360) * D;
    const halfW = halfH * (stage.w / stage.h);
    out.set((sx / stage.w - 0.5) * 2 * halfW, (0.5 - sy / stage.h) * 2 * halfH, -D);
    out.applyMatrix4(cam.matrixWorld);
    return out;
  }

  const tipWorld = new THREE.Vector3(0, GAL.y, TIP_Z);

  const api = {
    camera: () => cam,

    enter(opts = {}) {
      resetAll();
      state.msg = '';
      state.msgT = 0;
      // 进场景时的内部复位不该显示成「归位」的回执 —— 那不是用户比出来的
      state.signMsg = '';
      state.signMsgT = 0;
      state.parallaxX = 0;
      state.parallaxY = 0;
      state.pinches.clear();
      if (!opts.instant) {
        // 切进来先给一小段跃迁：告诉用户「你到了一片星域」，也盖住第一帧的跳变
        state.warpT = WARP_DUR;
        state.warpCd = 0;
      }
    },

    exit() {
      state.warpT = 0;
      state.glow = 0;
      shared.uGlow.value = 0;
      shared.uWarp.value = 0;
      state.pinches.clear();
    },

    toggleView() {
      state.firstPerson = !state.firstPerson;
      flash(state.firstPerson ? '视角 · 钻进星系' : '视角 · 退到掌心外', 1.6);
      return state.firstPerson ? 'first' : 'third';
    },

    actions() {
      return [
        { id: 'warp', label: '跃迁' },
        { id: 'reset', label: '归位' },
      ];
    },

    action(id) {
      if (id === 'warp') {
        if (triggerWarp()) flash(WARP_MSG, 1.1);
      } else if (id === 'reset') {
        resetAll();
      }
    },

    gesture(ev) {
      if (!ev || !ev.type) return;
      if (ev.type === 'sweep') {
        state.sweeps += 1;
        if (triggerWarp()) flash(WARP_MSG, 1.1);
        return;
      }
      // v7 手语：比出手形停 0.4 秒，平台就会送来一条 sign 事件
      if (ev.type === 'sign') {
        state.signs = (state.signs || 0) + 1;
        state.lastSign = ev.sign;
        if (ev.sign === 'thumbUp') {
          // 冷却里也要给回执：不然按了没反应，人会以为手势没认出来
          const ok = triggerWarp();
          signFlash(ok ? '好 · 跃迁一次' : '好 · 正在跃迁中');
        } else if (ev.sign === 'ily') {
          lightAll();
        } else if (ev.sign === 'point') {
          // ☝️ 点你手指底下那颗星；认不出手位（比如没摄像头）就退回最近没亮的一颗
          const tw = state.tipWorld;
          if (tw) {
            lightNearest(tw.x, tw.y, tw.z);
          } else {
            const next = mainStars.find((s) => !s.lit) || mainStars[0];
            if (next) lightNearest(next.root.position.x, next.root.position.y, next.root.position.z);
          }
        } else if (ev.sign === 'v') {
          resetAll();
        }
      }
    },

    hud() {
      const value = STAR_N ? clamp01(state.lit / STAR_N) : 0;
      return { status: statusNow(), value };
    },

    debug() {
      return {
        signs: state.signs || 0,
        lastSign: state.lastSign || '',
        lit: state.lit,
        stars: STAR_N,
        warp: +state.warp.toFixed(2),
        dolly: +state.dolly.toFixed(2),
        glow: +state.glow.toFixed(2),
        sweeps: state.sweeps,
        status: statusNow(),
      };
    },

    stats() {
      let tris = 0;
      let points = 0;
      group.traverse((o) => {
        if (!o.isMesh && !o.isPoints) return;
        const g = o.geometry;
        if (!g) return;
        if (o.isPoints) {
          points += g.attributes.position ? g.attributes.position.count : 0;
        } else {
          const count = g.index ? g.index.count : g.attributes.position ? g.attributes.position.count : 0;
          tris += Math.floor(count / 3) * (o.isInstancedMesh ? o.count : 1);
        }
      });
      return { objects: group.children.length, tris, points };
    },

    update(dt, frame) {
      const d = Math.min(dt, 0.05);
      state.t += d;
      const t = state.t;

      /* ── 输入 / 计时 ─────────────────────────────────────── */
      const input = frame.input || { dolly: 0 };
      state.dolly = approach(state.dolly, input.dolly || 0, 3.4, d);
      if (state.warpT > 0) state.warpT = Math.max(0, state.warpT - d);
      if (state.warpCd > 0) state.warpCd = Math.max(0, state.warpCd - d);
      if (state.msgT > 0) state.msgT = Math.max(0, state.msgT - d);
      if (state.signMsgT > 0) state.signMsgT = Math.max(0, state.signMsgT - d);
      // 跃迁包络：0.12 秒起手，剩下的按 0.75 次方软收尾
      const age = WARP_DUR - state.warpT;
      const warp = state.warpT > 0 ? Math.min(1, age / 0.12) * Math.pow(state.warpT / WARP_DUR, 0.75) : 0;
      state.warp = warp;
      shared.uWarp.value = warp;

      /* ── 手：指尖光 / 视差 / 捏合边沿 ────────────────────── */
      const hands = frame.hands || [];
      let hasTip = false;
      let sawSlot = -1;
      for (let i = 0; i < hands.length; i += 1) {
        const hand = hands[i];
        const slot = hand.slot | 0;
        const on = !!(hand.pinch && hand.pinch.on);
        const prev = state.pinches.get(slot) === true;
        state.pinches.set(slot, on);
        if (i === 0) {
          stageToWorld(hand.tip.x, hand.tip.y, tipWorld);
          hasTip = true;
          sawSlot = slot;
          // 视差：手往右，星野往左让，手才像在「拨」而不是「跟着动」
          state.parallaxX = approach(state.parallaxX, (0.5 - hand.tip.x / stage.w) * 2, 3, d);
          state.parallaxY = approach(state.parallaxY, (hand.tip.y / stage.h - 0.5) * 2, 3, d);
        }
        if (on && !prev) {
          stageToWorld(hand.tip.x, hand.tip.y, tmpV);
          lightNearest(tmpV.x, tmpV.y, tmpV.z);
        }
      }
      if (sawSlot >= 0) {
        // 手离开画面后要把边沿记录清掉：不然下次手一进画面就被当成「一直捏着」，边沿永远不来
        // （Map 迭代中删当前 key 是安全的，不额外分配数组）
        for (const key of state.pinches.keys()) {
          let alive = false;
          for (let i = 0; i < hands.length; i += 1) {
            if ((hands[i].slot | 0) === key) alive = true;
          }
          if (!alive) state.pinches.delete(key);
        }
      } else {
        state.pinches.clear();
      }
      if (!hasTip && frame.pointer && frame.pointer.on) {
        // 没有摄像头时鼠标也能演示：走同一条换算路径
        stageToWorld(frame.pointer.x, frame.pointer.y, tipWorld);
        hasTip = true;
      }

      /* 指尖光：抬手就到 1，手离开 0.8 秒衰到 0（契约里的时长） */
      if (hasTip) {
        state.glow = Math.min(1, state.glow + d * 9);
      } else {
        state.glow = Math.max(0, state.glow - d / 0.8);
        state.parallaxX = approach(state.parallaxX, 0, 2.2, d);
        state.parallaxY = approach(state.parallaxY, 0, 2.2, d);
      }
      shared.uGlow.value = state.glow;
      shared.uTip.value.copy(tipWorld);
      state.tipWorld = hasTip ? { x: tipWorld.x, y: tipWorld.y, z: tipWorld.z } : null;

      tipGlow.position.copy(tipWorld);
      tipGlow.material.opacity = state.glow * (0.34 + 0.1 * Math.sin(t * 6.2));
      nebHot.position.set(tipWorld.x, tipWorld.y, -140);
      nebHot.material.opacity = state.glow * 0.2;

      // 拖尾：环缓冲，头在 0，越往后越淡。手停下来它也收敛，不留一条死线
      trailLife = hasTip ? Math.min(1, trailLife + d * 4) : Math.max(0, trailLife - d * 3);
      if (hasTip) {
        trailHead = (trailHead + 1) % TRAIL_N;
        const o = trailHead * 3;
        trailPos[o] = tipWorld.x;
        trailPos[o + 1] = tipWorld.y;
        trailPos[o + 2] = tipWorld.z - 4;
        trailAttr.needsUpdate = true;
      }
      trailMat.uniforms.uOpacity.value = 0.85 * trailLife;

      /* ── 星系 / 星野的自转与呼吸 ─────────────────────────── */
      galaxySpin.rotation.z += d * (0.055 + warp * 0.35);
      far.pts.rotation.y += d * 0.004;
      midField.pts.rotation.y -= d * 0.008;
      dust.pts.rotation.y += d * 0.012;
      nebulas[0].rotation.z += d * 0.006;
      nebulas[1].rotation.z -= d * 0.004;
      const breathe = 1 + 0.06 * Math.sin(t * 0.9);
      coreGlow.material.opacity = 0.26 * breathe + state.glow * 0.1 + warp * 0.2;
      coreGlow.scale.setScalar(1 + 0.05 * Math.sin(t * 1.3) + warp * 0.3);
      palmLight.material.opacity = 0.09 + 0.02 * Math.sin(t * 0.7) + state.glow * 0.05;
      beam.material.opacity = 0.1 + 0.03 * Math.sin(t * 0.8) + warp * 0.15;

      /* ── 主星：呼吸 + 点亮时「爆一下」（1.6 倍 → 1.0，0.6 秒） ── */
      for (let i = 0; i < mainStars.length; i += 1) {
        const s = mainStars[i];
        if (s.burst > 0) s.burst = Math.max(0, s.burst - d / 0.6);
        s.k = approach(s.k, s.lit ? 1 : 0, 7, d);
        const pop = 1 + 0.6 * s.burst;
        const breath = 1 + 0.07 * Math.sin(t * 1.6 + s.phase);
        s.halo.scale.setScalar(breath * pop);
        s.halo.material.opacity = (0.08 + 0.3 * s.k) * (1 + 0.9 * s.burst);
        s.core.scale.setScalar((1 + 0.12 * s.burst) * (0.9 + 0.1 * breath));
        s.core.material.color.copy(dullColor).lerp(s.bright, s.k);
        s.core.material.opacity = 0.5 + 0.5 * s.k;
        // 点亮之后轻微浮动，让「它活着」这件事一直看得见
        s.root.position.y = s.baseY + Math.sin(t * 0.7 + s.phase) * 6 * s.k;
      }

      /* ── 相机：微环绕 + 手部视差 + 推拉 / 第一视角 ─────────── */
      const baseDist = state.firstPerson ? CAM.distFirst : CAM.dist;
      const dist = baseDist * (1 - state.dolly * 0.4) * (1 - warp * 0.1);
      const yaw = Math.sin(t * 0.13) * 0.16 + state.parallaxX * 0.05;
      const pitch = Math.sin(t * 0.09) * 0.035 + state.parallaxY * 0.02;
      camTarget.set(0, GAL.y, 0);
      cam.position.set(
        Math.sin(yaw) * dist + state.parallaxX * 55,
        camTarget.y + Math.sin(pitch) * dist + state.parallaxY * 40,
        Math.cos(yaw) * dist * Math.cos(pitch),
      );
      if (state.firstPerson) {
        // 钻进盘里：视线抬到盘面高度，从内部看核球
        camTarget.set(0, GAL.y + 20, -GAL.r * 0.5);
      } else if (warp > 0.02) {
        camTarget.y += warp * 10;
      }
      lookAt.copy(camTarget);
      cam.lookAt(camTarget);
      cam.updateMatrixWorld();
    },
  };

  /* 加色层统一压一档：手机竖屏画幅比桌面窄，掌心光 + 光柱 + 星云叠在一起时
     整片会泛白（实测 4.6% 的像素打到 235 以上，整屏均值 106）。乘 0.68 之后
     核球还是最亮的，但夜空的黑留得住 —— 这个场景要的是「黑夜里有光」，不是白雾。 */
  group.traverse((o) => {
    const m = o.material;
    if (m && m.blending === THREE.AdditiveBlending && m.transparent) m.opacity *= 0.68;
  });

  return api;
}

export default { META, createScene };