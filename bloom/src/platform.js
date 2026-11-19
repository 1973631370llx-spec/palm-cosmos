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

export const PLATFORMS = Object.freeze([
  {
    id: 'bloom',
    label: '指尖生花',
    sub: 'BLOOM AT YOUR FINGERTIPS',
    hint: '靠近开花 · 捏合释放 · 横抚整枝',
    builtin: true,
  },
  {
    id: 'cosmos',
    label: '掌心宇宙',
    sub: 'PALM COSMOS',
    hint: '张手巡航 · 捏住拖星 · 横挥跃迁',
    file: 'scenes/cosmos.js',
  },
  {
    id: 'xmas',
    label: '圣诞树',
    sub: 'CHRISTMAS TREE',
    hint: '捏合挂一件 · 挥手撒雪',
    file: 'scenes/xmas.js',
  },
  {
    id: 'station',
    label: '空间站',
    sub: 'ORBITAL STATION',
    hint: '捏合按控制台 · 推杆加速',
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
      this.host.api.update && this.host.api.update(dt, frame);
    } catch (err) {
      if (!this.errors.some((e) => e.id === this.activeId && e.message === String(err && err.message))) {
        this.errors.push({ id: this.activeId, message: String(err && err.message) || String(err) });
        console.error('[platform] update 出错', err);
      }
    }
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
    const out = { active: this.activeId, loaded: [...this.loaded.keys()], errors: this.errors.slice(0, 4) };
    if (this.host) {
      try {
        out.stats = this.host.api.stats ? this.host.api.stats() : null;
      } catch (err) {
        out.stats = null;
      }
      out.meta = this.host.META || null;
    }
    return out;
  }
}

export default PlatformHost;