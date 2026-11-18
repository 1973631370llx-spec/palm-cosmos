/* 审美常量：颜色 / 光 / 动效 / 构图。
 * 只允许这一个色板：深空黑 + 靛蓝 + 品红 + 青 + 暖白。
 * 玩法参数在 js/config.js（CONFIG），视觉参数在这里（THEME）。
 */
export const THEME = {
  colors: {
    ink: '#030409',
    indigo: '#2A3BFF',
    magenta: '#FF3D81',
    cyan: '#35E0D0',
    paper: '#FFF6E8',
    deep: '#101A66',
  },

  hex: {
    ink: 0x030409,
    indigo: 0x2a3bff,
    magenta: 0xff3d81,
    cyan: 0x35e0d0,
    paper: 0xfff6e8,
    deep: 0x101a66,
  },

  light: {
    exposure: 1.0,
    bloom: { strength: 0.32, radius: 0.36, threshold: 0.95 },
    supernovaBloom: 0.5,
    horizon: 0.26,
  },

  motion: {
    spin: 0.02,          // rad/s，呼吸式
    breatheHz: 0.06,
    breatheAmp: 0.35,
    collapseMs: 1200,    // ease-in
    releaseMs: 450,
    shockMs: 400,
    afterglowMs: 2000,
    flashMs: 260,
  },

  composition: {
    palmY: -0.2,         // 掌心在画面下 40%
    galaxyScale: 0.92,   // 星系直径约为画面高度 40%
  },
};

export const PALETTE = THEME.colors;