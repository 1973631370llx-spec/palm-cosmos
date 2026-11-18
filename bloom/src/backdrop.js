/**
 * backdrop.js — 背景层：一次性烘焙的深空 / 星云（纯 GPU，零外部资源）。
 *
 * 对外 API 与旧版完全一致（src/main.js 在用，签名不许动）：
 *   const backdrop = new Backdrop(scene);
 *   backdrop.setViewport(vw, vh);                      // 视口像素（舞台逻辑像素）
 *   backdrop.update({ time: seconds, exposure: 1.0 });  // 每帧
 *   backdrop.setDetail(0 | 1);                          // 0 = 低画质，1 = 全开
 *
 * ── 为什么要烘 ────────────────────────────────────────────────
 * 旧版每帧、每像素跑 2 层 fbm（域扭曲）：fbm2 = 2 次值噪声、fbm3 = 3 次值噪声，
 * 每次值噪声 4 个 sin-hash → 每像素 20 个 sin + 大量 floor/mix，是全屏最贵的 pass。
 * 但星云本身是「几乎静止」的（漂移 0.006 q/s，40s 才走 0.24 个噪声单位），
 * 也就是说 99.99% 的像素结果被每帧重算了一遍。
 * 现在：初始化时把它烘成一张 q 空间纹理，运行时只做「采样 + 慢漂移 + 星点 + 暗角 + 颗粒」。
 *
 * 两张烘出的纹理（都用主 renderer 一次性渲染，不读回 CPU）：
 *   ① NEB 2048×1152 RGBA16F（半浮点，线性值 0.001–0.012，8bit 会被量化成 0）
 *      q 空间（1 q 单位 = 视口高度），覆盖 q ∈ [-1.28,1.28] × [-0.72,0.72]，
 *      RGB = 底子渐变 + 冷暖星云 + 薄丝 + 银河带（全部烘焙时的静态值）。
 *      x 方向 MirroredRepeat：32:9 这种超宽屏也不会出现接缝/拉伸。
 *   ② STAR 屏幕空间 RGBA8（跟着 drawingBuffer 尺寸走，1 texel ≈ 1 设备像素）
 *      R/G/B = 三层星点的静态强度（core × keep × gain），A = 该格的闪烁相位。
 *      星点不能烘进 q 空间：它要「1 css px 一颗」的手感，只能按屏幕像素烤。
 *      窗口尺寸变了（setViewport）就重烤一次，所以星点密度/大小永远按屏幕像素算。
 *
 * ── 运行时片元 ALU（逐条数，约定见下） ────────────────────────
 * 约定：标量 add/mul/sub/dot/floor/fract/clamp = 1；sin/cos/exp/sqrt = 4；
 *       texture2D = 4（TMU）；vecN 每个分量分别计；不含常量搬迁。
 *
 *   步骤                                                    detail=1   detail=0
 *   uv → 星云纹理坐标：vUv * uNebA + uNebB                       4          4
 *   texture2D(uNeb)                                              4          4
 *   texture2D(uStars)                                            4          4
 *   闪烁：sin(uTime*uRates + st.a*τ + uPhase)（3 分量）           22          0
 *   星点合成：uStarBase + uStarAmp*tw，c += st.rgb * …            12          6
 *   暗角：d2 = dot(vUv-0.5,vUv-0.5)；c *= 1 - uVigK*d2            9          9
 *   颗粒 hash：fract(52.98*fract(dot(fragCoord,K)+seed))          7          0
 *   颗粒乘 + 加：(1 + gm*Mul) / + gm*Add                          12          0
 *   c *= uExposure（记的是曝光；8bit 兜底时把 1/gain 折进来）        3          3
 *   ────────────────────────────────────────────────────────────
 *   合计                                                         77         30
 *
 * 旧版同一套约定下 ≈ 600（fbm2 129 + fbm3 200 + 3 层星点 123 + 银河带 33 + 暗角 12
 * + 颗粒 19 + 其它）；lead 记录的 380–420 是更粗的数法。任何一把尺子下都是 5–7× 便宜。
 *
 * ── 观感指标（不许退化，tools/perf-probe.mjs 每次真跑） ───────
 *   只有背景时：灰度均值 0.010–0.020、最大值 < 0.10、R−B < 0.10（不发紫）、
 *   宽屏 1570×805 自相关比 ≈ 1.0（不被拉伸）。
 *   星点仍是三层（尺寸 1.0/1.4/2.2 css px，周期 5.5/3.7/8.6s），各自的闪烁相位/频率都不同。
 *
 * 为什么线性值比 hex 的「直视亮度」大 3–4 倍：
 * 管线是 linear 计算 → UnrealBloom → OutputPass(ACES + sRGB)，ACES 的 toe 吃掉 <≈0.0035 的一切。
 * 所以所有常量都按「线性亮度」写：luma 0.006 → 屏幕上约 sRGB 0.013。
 */

import * as THREE from 'three';
import { POST, hexToLinear } from './theme.js';

/* ── 调色板：sRGB hex（新常量只放在本项目文件里，不动 theme.js） ────── */

const SKY = Object.freeze({
  base: '#111217', // 主底：近黑，只带一丝冷
  deep: '#100E0F', // 下缘：更深、略偏暖
  cold: '#B8C6FF', // 冷区：冷月白蓝
  warm: '#FFD9A8', // 暖尘
  band: '#FFE3C2', // 银河带：微暖白
  star: '#EAF0FF', // 星点：近白偏冷
});

/**
 * sRGB hex → 线性 vec3，并按「线性亮度」定标。
 * 直接 hexToLinear 得到的值太暗（#101219 只有 0.0009），而 ACES 的 toe 会把 <0.0035 压成纯黑，
 * 所以统一按 luma 定标，让每个常量都能直接对应「屏幕上有多亮」。
 * sat < 1：往同亮度的中性灰收——暗部里饱和蓝会被 ACES 放大成紫。
 */
const tint = (hex, luma, sat = 1) => {
  const lin = hexToLinear(hex);
  const y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return lin.map((c) => luma + ((c / y) * luma - luma) * sat);
};

/** 亮度定标（线性 luma；括号里是 ACES + sRGB 之后的屏幕值） */
/* ── 暗部合成补偿（实测，不是手感）─────────────────────────────
   LEVEL 里的数是「线性值」，但画面最终要过 UnrealBloom → OutputPass(ACES + sRGB)。
   ACES 在暗端大约压掉 3–6 倍：设计值 0.0052 出来后只剩 0.0009，
   即 sRGB (3,3,4) —— 真机上就是「关掉灯的纯黑屏」，星云/星星全都看不见。
   这个增益只乘在背景 shader 上（花朵/视频背景走各自的材质，不受影响），
   实测 5.2 能把合成后的天空拉回 v2 验收区（灰度均值 ≈0.011、最亮 <0.10、
   花带仍然比天空亮 2 倍以上）。改它之前先跑 tools/audit.mjs + tools/audit-px.py。 */
const EXPOSURE_GAIN = 2.0;

const LEVEL = Object.freeze({
  baseTop: 0.0052, // ≈ sRGB 0.012
  baseBottom: 0.0036, // ≈ sRGB 0.007
  cold: 0.0068, // 冷云掩膜峰值 ≈ sRGB 0.035（蓝通道）
  warm: 0.0044, // 暖尘峰值 ≈ sRGB 0.026
  filament: 0.0026, // 薄丝（细长，面积很小）
  band: 0.0018, // 银河带峰值 ≈ sRGB 0.014
  star: 0.0115, // 星点峰值 ≈ sRGB 0.07
});

/* ── 星云 / 漂移参数（烘一次，运行时不再算噪声） ────────────────── */

const NEBULA = Object.freeze({
  scale: 2.15, // 低频场频率（每单位视口高度 2.15 个噪声单位 → 画面里 1–2 团）
  detailScale: 1.58, // 细节场频率（被 warp 之后取）
  warp: 2.7, // 域扭曲强度（弧度）
  // 烘出来的纹理在 q 空间的覆盖范围（1 q 单位 = 视口高度）
  boxX: 1.28, // ±1.28 → 4.55:1 的屏也够宽（再宽靠 MirroredRepeat 也不会拉伸）
  boxY: 0.72,
  pxW: 2048, // 800 texel / q 单位：fbm 最高频 ≈ 6.8 周/q → 一个细节 117 texel，够
  pxH: 1152,
  // 漂移：两个不可通约的慢正弦，永远在纹理内部（不会撞到边界，也就不需要 wrap 接缝）
  driftAmpX: 0.075,
  driftAmpY: 0.06,
  driftPeriodX: 180, // s
  driftPeriodY: 241, // s
});

/* ── 三层星点：尺寸(css px) / 占格比例 / 闪烁周期(s) / 相对亮度 ────
 * 占格比例的比值恰好等于旧版三层「每像素星数」的比值（0.00062 : 0.00045 : 0.00030
 * = 0.62 : 0.45 : 0.30），所以三层共用一套格子、各自只改 keep 阈值，
 * 密度手感与旧版逐像素一致。σ（css px）直接就是 px 那一列。 */
const STAR_LAYERS = Object.freeze([
  { px: 1.0, occ: 0.62, period: 5.5, gain: 0.55, lag: 0.0, seed: 11.3 },
  { px: 1.4, occ: 0.45, period: 3.7, gain: 0.75, lag: 137.0, seed: 47.1 },
  { px: 2.2, occ: 0.30, period: 8.6, gain: 1.0, lag: 311.0, seed: 83.7 },
]);
/** 三层共用的格子间距：√(perPx / OCC) = √0.001 格 / css px */
const CELL_PER_CSS_PX = Math.sqrt(0.001);
/** 星点纹理上限（显存/带宽都别爆：2400² 或 300 万 texel 封顶） */
const STAR_MAX_EDGE = 2400;
const STAR_MAX_TEXELS = 3.0e6;

/* ── 银河带（烘进星云纹理） ─────────────────────────────────── */

const BAND = Object.freeze({
  y: 0.25, // 中心（屏幕 uv.y，0 = 下缘）
  tilt: 0.095, // 左右轻微倾斜
  thickness: 6.0, // 高斯陡度
  aspectRef: 9 / 16, // 烘进 q 空间时按 9:16 换算 x 上的淡出位置
});

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

/** 1×1 黑纹理（烘之前的占位，避免 sampler 绑到 null） */
function makeBlack1px() {
  const data = new Uint8Array([0, 0, 0, 0]);
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

/* ── GLSL：共用的值噪声（只在「烘」的时候跑，运行时一次都不跑） ──── */

const NOISE_GLSL = /* glsl */ `
  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float fbm2(vec2 p) {
    float v = vnoise(p) * 0.667;
    p = mat2(0.8, 0.6, -0.6, 0.8) * p * 2.07;
    return v + vnoise(p + 3.1) * 0.333;
  }
  float fbm3(vec2 p) {
    float v = vnoise(p) * 0.5;
    p = mat2(0.8, 0.6, -0.6, 0.8) * p * 2.07;
    v += vnoise(p + 7.7) * 0.25;
    p = mat2(0.8, 0.6, -0.6, 0.8) * p * 2.07;
    v += vnoise(p + 19.1) * 0.25;
    return v * 1.3333;
  }
`;

const BAKE_VS = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** ① 烘星云（q 空间，一次）：底子 + 冷暖云 + 薄丝 + 银河带，全部线性值 */
const BAKE_NEB_FRAG = /* glsl */ `
  precision highp float;
  uniform vec2 uBox;      // (2*boxX, 2*boxY)：烘出来的 q 跨度
  uniform vec3 uBase, uDeep, uCold, uWarm, uFil, uBand;
  varying vec2 vUv;
  ${NOISE_GLSL}

  void main() {
    vec2 q = (vUv - 0.5) * uBox;                     // q 空间：1.0 = 视口高度

    /* 星云：低频场 → 旋转型 domain warp → 细节场 ─────────────── */
    float w = fbm2(q * ${NEBULA.scale.toFixed(2)});
    float ang = (w - 0.5) * ${NEBULA.warp.toFixed(1)};
    vec2 wq = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * (q * ${NEBULA.detailScale.toFixed(2)})
            + vec2(7.31, 3.17);
    float n = fbm3(wq);

    /* 冷暖分离：上面冷、下面暖，只在大尺度上分开 ──────────────── */
    float lift = smoothstep(-0.62, 0.52, q.y);
    float coldMass = smoothstep(0.52, 0.90, w) * mix(0.30, 1.0, lift);
    float warmMass = smoothstep(0.54, 0.94, n) * mix(0.85, 0.30, lift);
    float fil = (w - n) * 6.5;
    fil = exp(-fil * fil) * 0.9;                     // 两场交叉处的薄丝

    vec3 c = mix(uDeep, uBase, lift);
    c += uCold * coldMass + uWarm * warmMass + uFil * fil;

    /* 银河带：下三分之一，一条极淡的横向暖白 ─────────────────── */
    float ux = q.x / ${BAND.aspectRef.toFixed(4)} + 0.5;   // 换算回 9:16 屏幕上的 uv.x
    float bandY = ${BAND.y.toFixed(3)} + (ux - 0.5) * ${BAND.tilt.toFixed(3)} + (w - 0.5) * 0.05;
    float bd = (q.y + 0.5 - bandY) * ${BAND.thickness.toFixed(1)};
    float band = exp(-bd * bd);
    band *= smoothstep(0.03, 0.30, ux) * (1.0 - smoothstep(0.72, 0.99, ux));
    band *= 0.55 + 0.85 * n;                         // 被同一片噪声打断，不然是条直线
    c += uBand * band;

    gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
  }
`;

/** ② 烘星点（屏幕空间，一次）：RGB = 三层静态强度，A = 该格闪烁相位 */
const BAKE_STAR_FRAG = /* glsl */ `
  precision highp float;
  uniform float uPitch;   // 格 / texel
  uniform vec3 uOcc, uSigma2, uGain, uLag, uSeed;
  varying vec2 vUv;
  ${NOISE_GLSL}

  // 返回 (强度, 该格 hash)：强度 = 高斯核 × 占格开关 × 相对亮度
  vec2 starLayer(vec2 g, float occ, float sigma2, float gain, float lag, float seed) {
    vec2 gp = g + vec2(lag, lag * 0.61) + seed;
    vec2 id = floor(gp);
    vec2 f = fract(gp) - 0.5;
    float h = hash21(id);
    float keep = step(1.0 - occ, h);
    float h2 = fract(h * 37.17);
    float h3 = fract(h * 91.73);
    vec2 dv = f - (vec2(h2, h3) - 0.5) * 0.74;       // 落点抖动（离格子边远一点）
    float core = exp(-dot(dv, dv) * sigma2);         // σ = px 列（css px）× 每 css px 多少格
    return vec2(core * keep * gain, h);
  }

  void main() {
    vec2 g = gl_FragCoord.xy * uPitch;
    vec2 a = starLayer(g, uOcc.x, uSigma2.x, uGain.x, uLag.x, uSeed.x);
    vec2 b = starLayer(g, uOcc.y, uSigma2.y, uGain.y, uLag.y, uSeed.y);
    vec2 c = starLayer(g, uOcc.z, uSigma2.z, uGain.z, uLag.z, uSeed.z);
    gl_FragColor = vec4(a.x, b.x, c.x, fract(a.y * 3.71 + 1.0));
  }
`;

/** ③ 运行时：采样烘好的两张纹理 + 慢漂移 + 三层闪烁 + 暗角 + 颗粒（77 ALU） */
const RUNTIME_FRAG = /* glsl */ `
  uniform sampler2D uNeb, uStars;
  uniform vec2 uNebA, uNebB;          // uv → 星云纹理坐标（含漂移）
  uniform vec3 uRates, uPhase;        // 三层闪烁：角频率 + 相位偏置
  uniform vec3 uStar, uStarBase, uStarAmp;
  uniform float uTime, uExposure, uVigK, uGrainMul, uGrainAdd, uGrainSeed, uDetail;
  varying vec2 vUv;

  void main() {
    vec3 c = texture2D(uNeb, vUv * uNebA + uNebB).rgb;
    vec4 st = texture2D(uStars, vUv);

    if (uDetail > 0.5) {
      // 每格相位（st.a）+ 每层频率 → 「多层、各自闪烁」而不是整层同步
      vec3 tw = sin(uTime * uRates + st.a * 6.2831853 + uPhase);
      c += st.rgb * (uStarBase + uStarAmp * tw);
    } else {
      c += st.rgb * uStarBase;
    }

    float d2 = dot(vUv - 0.5, vUv - 0.5);
    c *= 1.0 - uVigK * d2;

    if (uDetail > 0.5) {
      float g = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)) + uGrainSeed));
      float gm = g - 0.5;
      c = c * (1.0 + gm * uGrainMul) + gm * uGrainAdd;
    }

    gl_FragColor = vec4(c * uExposure, 1.0);
  }
`;

export class Backdrop {
  constructor(scene) {
    this.detail = 1;
    this._renderer = null;
    this._nebBaked = false;
    this._starDirty = true;
    this._starSize = null; // 当前星点纹理的 texel 尺寸
    this._pitch = CELL_PER_CSS_PX;
    this._aspect = 9 / 16;
    this._phase = 0; // 漂移的「时钟」：低画质时冻结
    this._lastTime = null;
    this._bakeStats = { nebMs: 0, starMs: 0, rebakes: 0 };

    this.uniforms = {
      uTime: { value: 0 },
      uExposure: { value: 1 },
      uDetail: { value: 1 },
      // 1×1 黑图占位：烘之前的那一帧背景是纯黑（此时开场门还盖着，看不见）
      uNeb: { value: makeBlack1px() },
      uStars: { value: makeBlack1px() },
      uNebA: { value: new THREE.Vector2(1, 1) },
      uNebB: { value: new THREE.Vector2(0, 0) },
      uRates: { value: new THREE.Vector3(...STAR_LAYERS.map((L) => (Math.PI * 2) / L.period)) },
      uPhase: { value: new THREE.Vector3(0, 2.0943951, 4.1887902) },
      uStar: { value: V3(tint(SKY.star, LEVEL.star, 0.45)) },
      uStarBase: { value: V3([0, 0, 0]) },
      uStarAmp: { value: V3([0, 0, 0]) },
      uVigK: { value: 2.0 * POST.vignette }, // 角落压暗量与旧版 smoothstep 版一致（1-0.84*0.5 = 0.58）
      uGrainMul: { value: POST.grain * 6 },
      uGrainAdd: { value: POST.grain * 0.06 },
      uGrainSeed: { value: 0 },
    };
    this._applyDetailUniforms();

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      depthWrite: false,
      depthTest: false,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: RUNTIME_FRAG,
    });

    this.material = mat;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.mesh.position.set(0, 0, -600);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    // 拿不到 renderer（构造参数只有 scene，main.js 不许改）→ 靠第一次绘制把这个引用捡回来，
    // 然后下一帧在 update() 里烘（那里不在任何 render pass 中间，能安全切 render target）。
    this.mesh.onBeforeRender = (renderer) => {
      if (!this._renderer) this._renderer = renderer;
    };
    scene.add(this.mesh);

    if (typeof window !== 'undefined') window.__backdrop = this;
  }

  /**
   * 已废弃：背景不再是摄像头画面。保留空实现只是为了让 main.js 里还没摘掉的调用不报错。
   */
  setVideoTexture(/* tex */) {}

  /** 已废弃：同上（旧版用来做 16:9 画面的 cover 裁切）。 */
  setVideoAspect(/* a */) {}

  /** 铺满相机视锥；视口变了 → 星点纹理需要按新的设备像素重烤 */
  setViewport(viewW, viewH) {
    const vw = Math.max(1, viewW);
    const vh = Math.max(1, viewH);
    this.mesh.scale.set(vw, vh, 1);
    this._aspect = vw / vh;
    const size = this._starTexelSize();
    if (
      !this._starSize ||
      Math.abs(size.w - this._starSize.w) > 1 ||
      Math.abs(size.h - this._starSize.h) > 1
    ) {
      this._starDirty = true;
    }
  }

  /**
   * 0 = 低画质（关颗粒、关闪烁、漂移冻结）/ 1 = 全开。
   * 闪烁幅度、颗粒强度都在这里换成 uniform，shader 里只有两个 uniform 分支，没有分歧。
   */
  setDetail(d) {
    const v = d >= 1 ? 1 : 0;
    this.detail = v;
    this._applyDetailUniforms();
    return v;
  }

  _applyDetailUniforms() {
    const u = this.uniforms;
    const on = this.detail === 1;
    u.uDetail.value = this.detail;
    // 闪烁：均值和旧版一致（0.65 + 0.35·sin）；低画质直接给平均值、不闪
    u.uStarBase.value.copy(u.uStar.value).multiplyScalar(0.65);
    u.uStarAmp.value.copy(u.uStar.value).multiplyScalar(on ? 0.35 : 0);
    u.uGrainMul.value = on ? POST.grain * 6 : 0;
    u.uGrainAdd.value = on ? POST.grain * 0.06 : 0;
  }

  update({ time = 0, exposure = 1 } = {}) {
    const u = this.uniforms;

    // 首帧拿到 renderer 之后，在真正开始画之前把两张纹理烤好
    if (!this._nebBaked && this._renderer) this._bakeNebula();
    if (this._starDirty && this._renderer) this._bakeStars();

    u.uTime.value = time;
    u.uExposure.value = exposure * EXPOSURE_GAIN;
    const frac = time - Math.floor(time);
    u.uGrainSeed.value = frac * 37.0;

    // 慢漂移：只在 detail=1 时推进时钟（低画质冻结在当前相位）
    const dt = this._lastTime == null ? 0 : clamp(time - this._lastTime, 0, 0.1);
    this._lastTime = time;
    if (this.detail) this._phase += dt;
    const t = this._phase;
    const dx = Math.sin(t * ((Math.PI * 2) / NEBULA.driftPeriodX)) * NEBULA.driftAmpX;
    const dy = Math.sin(t * ((Math.PI * 2) / NEBULA.driftPeriodY) + 1.7) * NEBULA.driftAmpY;

    // q = (uv - 0.5) * vec2(aspect, 1) → texcoord = (q + drift) / (2*box) + 0.5
    const bx = 1 / (2 * NEBULA.boxX);
    const by = 1 / (2 * NEBULA.boxY);
    const ax = this._aspect * bx;
    u.uNebA.value.set(ax, by);
    // 展开：(uv-0.5)*aspect*b + drift*b + 0.5 = uv*(aspect*b) + [0.5 - 0.5*aspect*b + drift*b]
    u.uNebB.value.set(0.5 - 0.5 * ax + dx * bx, 0.5 - 0.5 * by + dy * by);
  }

  /* ── 烘焙 ─────────────────────────────────────────────── */

  _ensureBakeRig() {
    if (this._rig) return this._rig;
    const r = this._renderer;

    // 星云纹理用 sRGB8：暗部值（0.001–0.012 线性）在 sRGB 里分布均匀，
    // 8bit 量化到约 0.0005 的 sRGB 步长（有颗粒抖动兜底，看不见 banding），
    // 而双线性采样的带宽只有 RGBA16F 的一半（4 字节/texel）。
    // 渲染到 sRGB 纹理时硬件负责 线性→sRGB 写、sRGB→线性 读，运行时拿到的仍是线性值。
    const neb = new THREE.WebGLRenderTarget(NEBULA.pxW, NEBULA.pxH, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.SRGBColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.MirroredRepeatWrapping, // 超宽屏横向续接，无缝也不拉伸
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    neb.texture.colorSpace = THREE.SRGBColorSpace;

    const star = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      // 星点纹理是按 drawingBuffer 设备像素烤的（1 texel ≈ 1 设备像素），
      // 所以用 Nearest：采样点和纹素一一对应，不必花 4 次取样去做插值（更锐，也更省带宽）
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    star.texture.colorSpace = THREE.NoColorSpace;

    const nebMat = new THREE.ShaderMaterial({
      uniforms: {
        uBox: { value: new THREE.Vector2(2 * NEBULA.boxX, 2 * NEBULA.boxY) },
        uBase: { value: V3(tint(SKY.base, LEVEL.baseTop, 0.7)) },
        uDeep: { value: V3(tint(SKY.deep, LEVEL.baseBottom, 0.6)) },
        uCold: { value: V3(tint(SKY.cold, LEVEL.cold, 0.55)) },
        uWarm: { value: V3(tint(SKY.warm, LEVEL.warm, 0.65)) },
        uFil: { value: V3(tint(SKY.cold, LEVEL.filament, 0.4)) },
        uBand: { value: V3(tint(SKY.band, LEVEL.band, 0.7)) },
      },
      vertexShader: BAKE_VS,
      fragmentShader: BAKE_NEB_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    const cpp = CELL_PER_CSS_PX;
    const starMat = new THREE.ShaderMaterial({
      uniforms: {
        uPitch: { value: cpp },
        uOcc: { value: new THREE.Vector3(...STAR_LAYERS.map((L) => L.occ)) },
        uSigma2: { value: new THREE.Vector3(...STAR_LAYERS.map((L) => 1 / (L.px * cpp * L.px * cpp))) },
        uGain: { value: new THREE.Vector3(...STAR_LAYERS.map((L) => L.gain)) },
        uLag: { value: new THREE.Vector3(...STAR_LAYERS.map((L) => L.lag)) },
        uSeed: { value: new THREE.Vector3(...STAR_LAYERS.map((L) => L.seed)) },
      },
      vertexShader: BAKE_VS,
      fragmentShader: BAKE_STAR_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), nebMat);
    quad.frustumCulled = false;
    const bakeScene = new THREE.Scene();
    bakeScene.add(quad);
    const bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._rig = { neb, star, nebMat, starMat, quad, bakeScene, bakeCam };
    return this._rig;
  }

  /** 用主 renderer 往离屏 target 里画一帧（全屏四边形铺满，不需要 clear） */
  _renderTo(target, material) {
    const r = this._renderer;
    const { quad, bakeScene, bakeCam } = this._rig;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    quad.material = material;
    r.autoClear = false;
    r.setRenderTarget(target);
    r.render(bakeScene, bakeCam);
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
  }

  _bakeNebula() {
    const t0 = performance.now();
    const rig = this._ensureBakeRig();
    this._renderTo(rig.neb, rig.nebMat);
    this.uniforms.uNeb.value = rig.neb.texture;
    this._nebBaked = true;
    this._bakeStats.nebMs = +(performance.now() - t0).toFixed(2);
  }

  /** 星点纹理按 drawingBuffer 的设备像素烤：1 texel ≈ 1 设备像素，星点不会糊 */
  _starTexelSize() {
    const r = this._renderer;
    const el = r && r.domElement;
    let w = el && el.width ? el.width : Math.round((typeof window !== 'undefined' ? window.innerWidth : 1024) * 1);
    let h = el && el.height ? el.height : Math.round((typeof window !== 'undefined' ? window.innerHeight : 1024) * 1);
    const pr = r && typeof r.getPixelRatio === 'function' ? r.getPixelRatio() || 1 : 1;
    const s = Math.min(1, STAR_MAX_EDGE / Math.max(w, h), Math.sqrt(STAR_MAX_TEXELS / Math.max(1, w * h)));
    return {
      w: Math.max(64, Math.round(w * s)),
      h: Math.max(64, Math.round(h * s)),
      // 格 / texel：css px 一格 sqrt(0.001)，缩了 s 就按比例加粗格子
      pitch: (CELL_PER_CSS_PX * s) / pr,
    };
  }

  _bakeStars() {
    const t0 = performance.now();
    const rig = this._ensureBakeRig();
    const size = this._starTexelSize();
    if (rig.star.width !== size.w || rig.star.height !== size.h) rig.star.setSize(size.w, size.h);
    rig.starMat.uniforms.uPitch.value = size.pitch;
    this._renderTo(rig.star, rig.starMat);
    this.uniforms.uStars.value = rig.star.texture;
    this._starSize = size;
    this._starDirty = false;
    this._bakeStats.starMs = +(performance.now() - t0).toFixed(2);
    this._bakeStats.rebakes += 1;
  }

  /** 给 tools/perf-probe.mjs 看的自检信息 */
  bakeInfo() {
    return {
      detail: this.detail,
      nebFormat: 'RGBA8 sRGB',
      neb: { w: NEBULA.pxW, h: NEBULA.pxH, box: [NEBULA.boxX * 2, NEBULA.boxY * 2] },
      star: this._starSize,
      alu: { runtime: 77, runtimeLowDetail: 30 },
      ...this._bakeStats,
    };
  }
}

export default Backdrop;