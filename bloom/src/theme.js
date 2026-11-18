/**
 * theme.js — 审美参数（颜色 / 粒度 / 光 / 排版）。
 * 行为与硬性数值在 src/config.js。
 *
 * 暗夜温室：近黑底 + 一枝珊瑚粉花 + 大量暗部留白；
 * 冷月白只在边缘出现（≤10%），绝不出现彩虹 / 紫霓虹 / 卡通 / 花海。
 */

/**
 * 本文件里所有颜色都按「你在屏幕上看到的样子」写（sRGB）。
 * 渲染管线是 linear 计算 + OutputPass 做 ACES + sRGB 输出，
 * 所以任何喂进 shader 的颜色都必须先过这里转换，否则整体会被抬亮 3 倍（灰雾）。
 */
export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const hexToLinear = (hex) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(srgbToLinear);
};
export const rgbToLinear = (rgb) => rgb.map(srgbToLinear);

export const COLOR = Object.freeze({
  /** 背景近黑（不是纯黑） */
  bg: '#060509',
  bgDeep: '#040307',
  /** 同色系三阶：珊瑚粉 → 樱粉 → 蜜白 */
  coral: '#FF8FA3',
  sakura: '#FFC2D1',
  honey: '#FFF1E6',
  /** 花心暖白 → 蜜金 */
  core: '#FFF6E8',
  gold: '#FFD9A8',
  /** 冷月白（用量 ≤10%） */
  moon: '#B8C6FF',
  /** HUD */
  ink: 'rgba(255, 241, 230, 0.86)',
  inkDim: 'rgba(255, 241, 230, 0.46)',
  inkFaint: 'rgba(255, 241, 230, 0.2)',
  line: 'rgba(255, 241, 230, 0.14)',
  live: 'rgba(184, 198, 255, 0.9)',
});

/** 每朵的色相主调（同色系，只换重心） */
export const FLOWER_TINT = Object.freeze([
  // 0 左：珊瑚粉
  { petal: [1.0, 0.56, 0.64], edge: [1.0, 0.76, 0.82], core: [1.0, 0.965, 0.9] },
  // 1 中：樱粉（最亮，画面重心）
  { petal: [1.0, 0.76, 0.82], edge: [1.0, 0.9, 0.86], core: [1.0, 0.975, 0.93] },
  // 2 右：蜜白
  { petal: [1.0, 0.9, 0.84], edge: [1.0, 0.86, 0.8], core: [1.0, 0.97, 0.92] },
]);

/** 摄像头背景：压暗 + 虚化 + 降饱和（亮度 ≤15%） */
export const CAMERA_BG = Object.freeze({
  exposure: 0.115, // 最终亮度上限 ≈ 11.5%
  saturate: 0.34, // 降饱和
  blur: 0.0055, // uv 半径（9 taps）
  vignette: 0.62,
  grain: 0.018,
  coldShift: [0.010, 0.016, 0.030], // 极轻的冷色偏移（线性），压住暖光
});

/** 花序：一枝横枝 + 三朵错落 */
export const FLORA = Object.freeze({
  baseRadius: 288, // 花的世界半径（v2 放大：原来 228，画面里明显偏小） // 逻辑像素（乘每朵 scale）
  petalCount: [5, 6, 5], // 5–6 片
  petalLayers: [0.54, 0.78, 1.0], // 每片 3 层
  petalLayerTwist: [0.0, 0.15, -0.11], // 层间错位（弧度）
  petalWidth: 0.34,
  petalOpenCurl: 0.34, // 绽放时花瓣向上翻（z 方向），只影响光晕/景深
  budHeight: 0.58, // 花苞高度（相对 R）
  budWidth: 0.17,
  coreRadius: 0.21,
  pollenShell: 1.28,
  // 粒子构成（每朵 3000）：芯 / 瓣 / 描边 / 花粉 / 柔光
  mix: { core: 0.2, petal: 0.48, outline: 0.17, pollen: 0.08, haze: 0.07 },
  // 尺寸（逻辑像素 = 屏幕上多大）
  size: {
    core: [6.0, 13.0],
    petal: [7.0, 14.0],
    outline: [9.0, 16.0],
    pollen: [3.0, 7.0],
    haze: [30, 52],
  },
  alpha: { core: 0.35, petal: 0.5, outline: 1.0, pollen: 0.45, haze: 0.035 },
  // 层错开（秒）：花心 60ms / 花瓣 80ms / 轮廓 120ms / 花粉 100ms / 柔光 150ms
  layerDelay: { core: 0.06, petal: 0.08, outline: 0.12, pollen: 0.1, haze: 0.15 },
  // 绽放瞬间花心亮度 +15%，0.4s 回落
  coreFlash: 0.15,
  coreFlashDur: 0.4,
});

/** 藤蔓 / 树枝 */
export const BRANCH = Object.freeze({
  opacity: 0.17,
  color: '#FFC2D1',
  sag: 30, // 中段下垂（逻辑像素）
  width: 1.2,
  tendrils: 5,
  tendrilOpacity: 0.1,
  stemOpacity: 0.16,
  // 用光点再画一遍枝条（1px 线在竖屏里读不出来）
  dotSize: [2.2, 4.6],
  dotAlpha: 0.5,
  stemDotAlpha: 0.32,
});

/** 后处理 */
export const POST = Object.freeze({
  bloomStrength: 0.5,
  bloomRadius: 0.55,
  bloomThreshold: 0.09, // 线性空间阈值：花瓣（≈0.1）也发茸，但不会整屏起雾
  grain: 0.012,
  vignette: 0.42,
});

/**
 * 画质分级（性能侧唯一的一张表）：档位越高越好看也越贵。
 * src/perf.js 的 TIERS 就是这张表；src/backdrop.js 的 setDetail 读 backdropDetail。
 *   dpr          渲染像素比（high = 满设备像素，上限 2）
 *   bloomScale   bloom pass 的分辨率缩放（1.0 / 0.7 / 0.5）
 *   particles    花朵粒子预算
 *   backdropDetail 1 = 背景全开（闪烁 + 颗粒 + 漂移），0 = 低画质（全关、漂移冻结）
 * 下面 5 个是 governor 的判据（毫秒 / 次数），改这里就等于改升级降级手感。
 */
export const QUALITY = Object.freeze({
  tiers: Object.freeze([
    Object.freeze({
      name: 'high',
      dpr: Math.min(2, typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1),
      bloomScale: 1.0,
      particles: 9000,
      backdropDetail: 1,
    }),
    Object.freeze({ name: 'mid', dpr: 1.25, bloomScale: 0.7, particles: 6000, backdropDetail: 1 }),
    Object.freeze({ name: 'low', dpr: 1.0, bloomScale: 0.5, particles: 4500, backdropDetail: 0 }),
  ]),
  downMs: 20, // 平均帧时 > 20ms（≈ <50fps）
  upMs: 12, // 平均帧时 < 12ms（≈ >83fps）
  downHoldMs: 1200, // 持续 1.2s 才降
  upHoldMs: 4000, // 持续 4s 才升
  maxChangesPerMin: 4, // 每分钟最多变 4 次
});

/** 取景（v2）：宽屏上收紧纵向取景把花放大，别再整幅缩小居中 */
export const VIEW = Object.freeze({
  // 纵向最少保留多少画布高度（比例）。越小 = 宽屏越放大越裁。
  minH: 0.6,
  // 取景中心放在画布高度的哪个位置（花带中心，不是正中）
  centerY: 0.52,
});

/** 指尖微光 / 光丝 */
export const TRAIL = Object.freeze({
  seconds: 0.15,
  samples: 10,
  size: [2.2, 7.5],
  alpha: 0.85,
  filamentColor: '#FFF6E8',
  filamentWidth: 2.6,
  filamentTail: 0.22,
});

/** 双端爆花：白色冲击环 + 花粉球，0.5s 消散，不是火球 */
export const BURST = Object.freeze({
  dur: 0.5,
  ringR0: 0.12,
  ringR1: 1.15,
  ringAlpha: 0.72,
  pollenCount: 1000,
  pollenR: [0.15, 1.05],
  scatter: 1.0,
});

/** 排版（编辑风：细线等宽小字贴四角） */
export const TYPE = Object.freeze({
  serif: "'Songti SC','STSong','SimSun','Noto Serif CJK SC','Noto Serif SC',serif",
  sans: "'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans SC',system-ui,sans-serif",
  mono: "ui-monospace,'SF Mono','JetBrains Mono','Cascadia Mono',Consolas,'Courier New',monospace",
  titleSize: 'clamp(34px, 6.2vw, 66px)',
  heroSize: 'clamp(22px, 3.2vw, 34px)',
  bodySize: 'clamp(11px, 1.32vw, 14px)',
  microSize: 'clamp(8.5px, 1.02vw, 11px)',
  tracking: '0.2em',
});

export const THEME = Object.freeze({
  COLOR,
  FLOWER_TINT,
  CAMERA_BG,
  FLORA,
  BRANCH,
  POST,
  TRAIL,
  BURST,
  TYPE,
});

export default THEME;