/**
 * platform.js — v5「交互平台」的场景登记与加载。
 *
 * 为什么要这一层：
 *   · 花的场景（bloom）写死在 main.js 里，动它风险大；新的场景要能独立开发、独立自检，
 *     所以这里只做「登记 + 动态 import + 统一 ctx」三件事，main.js 只跟这一个接口打交道；
 *   · 场景之间完全隔离：各自的 THREE.Group、各自的相机、各自的 update；
 *     切换 = 换可见性 + 换渲染相机，不销毁（再切回来是原样，不用重建几何）。
 *
 * 契约见 src/scenes/CONTRACT.md。
 */

import { createSignTracker } from './poses.js';

export const PLATFORMS = Object.freeze([
  {
    id: 'bloom',
    label: '指尖生花',
    sub: 'BLOOM AT YOUR FINGERTIPS',
    hint: '靠近开花 · 捏合释放 · 横抚整枝',
    howto: ['靠近花苞自己会开', '捏一下 = 释放花瓣', '横抚整枝 = 三朵一起开', '张手抓住一朵可以转着看'],
    signs: [
      { sign: 'thumbUp', effect: '三朵一起绽放' },
      { sign: 'ily', effect: '开出一颗心（花海）' },
      { sign: 'v', effect: '双生花苞并开' },
      { sign: 'ok', effect: '收束成花苞' },
    ],
    builtin: true,
  },
  {
    id: 'cosmos',
    label: '掌心宇宙',
    sub: 'PALM COSMOS',
    hint: '手划过去星云会亮 · 捏合点亮一颗星 · 横挥跃迁',
    howto: ['手在画面上划过去，星云跟着亮', '捏合 = 点亮离手最近的那颗星', '横挥 = 跃迁加速', '圆盘往前推 = 靠近星云'],
    signs: [
      { sign: 'thumbUp', effect: '跃迁一次' },
      { sign: 'ily', effect: '整片星域亮起来' },
      { sign: 'point', effect: '点亮你指尖下那颗星' },
      { sign: 'v', effect: '归位、星野散开' },
    ],
    file: 'scenes/cosmos.js',
  },
  {
    id: 'xmas',
    label: '圣诞树',
    sub: 'CHRISTMAS TREE',
    hint: '手放树上掉礼物 · 挥手摇落一场雪',
    howto: ['把手放在树上，礼物会掉下来', '礼物落地会堆在树下，数字 +1', '横挥 = 摇树，礼物成片掉', '捏合 = 点树顶的星星开灯串'],
    signs: [
      { sign: 'thumbUp', effect: '摇树，礼物成片落' },
      { sign: 'ily', effect: '灯串全开 + 下一场礼物雨' },
      { sign: 'ok', effect: '掉一件大礼物' },
      { sign: 'v', effect: '撒一场大雪' },
    ],
    file: 'scenes/xmas.js',
  },
  {
    id: 'station',
    label: '空间站',
    sub: 'ORBITAL STATION',
    hint: '手是光标 · 捏合按按钮 · 圆盘走近控制台',
    howto: ['点「视角」进驾驶舱，手就是光标', '手停在按钮上，捏一下 = 按下', '圆盘往前推 = 走近控制台', '按 ARM 接管机械臂，手往哪移它就往哪走'],
    signs: [
      { sign: 'thumbUp', effect: '推进到 100%' },
      { sign: 'v', effect: '切第一 / 第三人称' },
      { sign: 'ily', effect: '对接 · 光带张开' },
      { sign: 'ok', effect: '舱内灯开 / 关' },
    ],
    file: 'scenes/station.js',
  },
]);

const byId = new Map(PLATFORMS.map((p) => [p.id, p]));

export const platformMeta = (id) => byId.get(id) || null;

/**
 * 场景宿主：懒加载 + 缓存 + 前/后台切换。
 * main.js 只调 `host.activate(id)` 与 `host.update(dt, frame)`。
 */
export class PlatformHost {
  constructor({ THREE, sceneRef, stage, quality, dpr }) {
    this.THREE = THREE;
    this.sceneRef = sceneRef;
    this.stage = stage;
    this.quality = quality;
    this.dpr = dpr;
    this.loaded = new Map(); // id → { api, group }
    this.onSign = null; // main.js 挂的钩子：用来弹提示
    // 手语判定：稳定保持 0.4 秒才算「比出来了」，然后转发给当前场景
    this.signTracker = createSignTracker((sign, slot) => {
      const api = this.host && this.host.api;
      if (api && api.gesture) api.gesture({ type: 'sign', sign, slot });
      if (this.onSign) this.onSign(sign, slot);
    });
    /** 场景共用输入：圆盘推拉（-1 退 / +1 进）。main.js 每帧写，场景每帧读 */
    this.input = { dolly: 0 };
    this.activeId = 'bloom';
    this.host = null; // 当前前台的 { api, group }
    this.errors = [];
    this.loading = new Map();
  }

  /** 场景自己的 Group（懒建，挂在根场景下） */
  _groupFor(id) {
    const g = new this.THREE.Group();
    g.name = `platform:${id}`;
    g.visible = false;
    this.sceneRef.add(g);
    return g;
  }

  async load(id) {
    const meta = platformMeta(id);
    if (!meta || meta.builtin) return null;
    if (this.loaded.has(id)) return this.loaded.get(id);
    if (this.loading.has(id)) return this.loading.get(id);
    const task = (async () => {
      try {
        const mod = await import(`./${meta.file}`);
        const group = this._groupFor(id);
        const api = mod.createScene({
          THREE: this.THREE,
          stage: this.stage,
          quality: this.quality,
          group,
          dpr: this.dpr,
        });
        const entry = { api, group, META: mod.META || meta };
        this.loaded.set(id, entry);
        return entry;
      } catch (err) {
        this.errors.push({ id, message: String(err && err.message) || String(err) });
        // 场景挂了也不能让整个页面白屏：记下来，继续用旧场景
        console.error(`[platform] ${id} 加载失败`, err);
        return null;
      } finally {
        this.loading.delete(id);
      }
    })();
    this.loading.set(id, task);
    return task;
  }

  /** 切场景；返回真正切过去的 id（加载失败时还是原来的） */
  async activate(id, opts = {}) {
    const meta = platformMeta(id);
    if (!meta) return this.activeId;
    if (id === this.activeId && this.host) return id;

    // 先退掉旧的
    if (this.host) {
      this.host.group.visible = false;
      try {
        this.host.api.exit && this.host.api.exit();
      } catch (err) {
        console.warn('[platform] exit 出错', err);
      }
      this.host = null;
    }

    if (meta.builtin) {
      this.activeId = id;
      return id;
    }

    const entry = await this.load(id);
    if (!entry) return this.activeId; // 加载失败 → 不切
    entry.group.visible = true;
    this.host = entry;
    this.activeId = id;
    try {
      entry.api.enter && entry.api.enter({ firstPerson: !!opts.firstPerson, instant: !!opts.instant });
    } catch (err) {
      console.warn('[platform] enter 出错', err);
    }
    return id;
  }

  /** 当前前台场景渲染用的相机（没有就返回 null，用平台的） */
  camera() {
    if (!this.host) return null;
    try {
      return (this.host.api.camera && this.host.api.camera()) || null;
    } catch (err) {
      console.warn('[platform] camera 出错', err);
      return null;
    }
  }

  update(dt, frame) {
    if (!this.host) return;
    try {
      frame.input = this.input;
      this.dispatchSign(dt, frame);
      this.host.api.update && this.host.api.update(dt, frame);
    } catch (err) {
      if (!this.errors.some((e) => e.id === this.activeId && e.message === String(err && err.message))) {
        this.errors.push({ id: this.activeId, message: String(err && err.message) || String(err) });
        console.error('[platform] update 出错', err);
      }
    }
  }

  /**
   * v7 手语：一只手比出同一个词、**稳定保持 0.4 秒**，才当成「比出来了」，
   * 然后给场景发一次 `gesture({type:'sign', sign})`。
   *
   * 为什么要 hold 而不是看到就触发：从张开手换成任何一个手形，中间必然经过
   * 一堆过渡手形（收手指的过程中会短暂像「三」像「L」），单帧触发会乱开特效。
   * 为什么是 0.4 秒：比手语的人停住一个手形的自然时长就是 0.3–0.6 秒，
   * 低于 0.3 会漏、高于 0.6 会显得迟钝（实测手感取 0.4）。
   */
  dispatchSign(dt, frame) {
    // 判定逻辑在 poses.js 的 createSignTracker 里（花的场景也用同一套，手感一致）
    this.signTracker.update(dt, (frame && frame.hands) || []);
  }

  /** 当前场景支持的手语词（给玩法卡用） */
  signs() {
    const meta = platformMeta(this.activeId);
    return (meta && meta.signs) || [];
  }

  gesture(ev) {
    if (!this.host) return;
    try {
      this.host.api.gesture && this.host.api.gesture(ev);
    } catch (err) {
      console.warn('[platform] gesture 出错', err);
    }
  }

  toggleView() {
    if (!this.host) return null;
    try {
      return (this.host.api.toggleView && this.host.api.toggleView()) || null;
    } catch (err) {
      console.warn('[platform] toggleView 出错', err);
      return null;
    }
  }

  /** 当前场景的「怎么玩」条目（屏幕上给人看的那几条） */
  howto() {
    const meta = platformMeta(this.activeId);
    return (meta && meta.howto) || [];
  }

  actions() {
    if (!this.host) return [];
    try {
      return (this.host.api.actions && this.host.api.actions()) || [];
    } catch (err) {
      return [];
    }
  }

  action(id) {
    if (!this.host) return false;
    try {
      this.host.api.action && this.host.api.action(id);
      return true;
    } catch (err) {
      console.warn('[platform] action 出错', err);
      return false;
    }
  }

  hud() {
    if (!this.host) return null;
    try {
      return (this.host.api.hud && this.host.api.hud()) || null;
    } catch (err) {
      return null;
    }
  }

  info() {
    const out = {
      active: this.activeId,
      loaded: [...this.loaded.keys()],
      errors: this.errors.slice(0, 4),
      sign: this.signTracker.peek(), // 正在比的手语词和已保持时长（自检 / 排错用）
    };
    if (this.host) {
      try {
        out.stats = this.host.api.stats ? this.host.api.stats() : null;
      } catch (err) {
        out.stats = null;
      }
      try {
        out.debug = this.host.api.debug ? this.host.api.debug() : null;
      } catch (err) {
        out.debug = null;
      }
      out.meta = this.host.META || null;
    }
    return out;
  }
}

export default PlatformHost;