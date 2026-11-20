# 场景模块契约（v5「交互平台」）

这个文件是**接口契约**，不是建议。`src/platform.js` 按它加载场景；不符合契约的场景会直接加载失败。
先读 `src/main.js` 里花的场景怎么用 `THREE`、`STAGE`、颜色，再写自己的模块。

## 1. 文件与导出

- 每个场景一个文件：`src/scenes/<id>.js`。**只改自己那一个文件**，不要动 `index.html`、`styles/main.css`、`src/main.js`、`src/platform.js`。
- 只导出两个东西：

```js
export const META = Object.freeze({
  id: 'xmas',            // 与文件名一致，lowercase
  label: '圣诞树',        // 场景卡片上的大字（≤5 个汉字）
  sub: 'CHRISTMAS TREE', // 卡片上的小字（大写英文 / 短句，≤18 字符）
  hint: '捏合挂一件 · 挥手撒雪', // 一行玩法提示（≤22 个汉字）
  howto: ['把手放在树上，礼物会掉下来', '…'], // v6 必填：3–4 条「怎么玩」，进场景就摊在屏幕上
});

export function createScene(ctx) { /* ... */ return api; }
```

## 2. createScene(ctx) 的入参

```js
ctx = {
  THREE,                     // 与平台同一个 three 实例（r169，裸模块 'three'）
  stage: { w: 1080, h: 1920 },// 逻辑舞台尺寸（和花的场景同一套坐标）
  quality: 'high' | 'mid' | 'low', // 由性能治理器给出，构建时选密度
  group: THREE.Group,        // 把你要画的所有东西 add 到这里；平台负责显示/隐藏
  dpr: number,               // 设备像素比上限
};
```

## 3. 返回的 api（全部可选，除 update）

```js
api = {
  camera(),            // 返回 THREE.PerspectiveCamera（或 null = 用平台默认相机）
  enter(opts),         // 场景被切到前台：opts = { firstPerson:boolean, instant:boolean }
  exit(),              // 离开前台：停掉自己的动画状态，别留 timer
  update(dt, frame),   // 每帧（只在前台时被调用），见 §4
  gesture(ev),         // 手势事件，见 §5
  toggleView(),        // 可选：第一/第三人称切换，返回 'first' | 'third' | null
  actions(),           // 可选：[{ id, label, hint }] → 平台渲染成可点的 HUD 按钮
  action(id),          // 可选：执行某个控制台动作（点击和手势共用这个入口）
  hud(),               // 可选：{ status: '一句状态', value: 0..1|null } 给 HUD 用
  stats(),             // 可选：{ objects, tris } 给自检用
  dispose(),           // 可选：释放几何/材质（切换场景不销毁，只在卸载时调用）
};
```

`update` 必须存在。其余缺失时平台自己兜底。

## 4. update(dt, frame)

```js
frame = {
  t: number,                 // 秒，从平台启动算
  now: number,               // performance.now()
  hands: [                   // 当前帧的手（可能为空数组）
    {
      slot: 0,
      tip:  { x, y },        // 食指尖，舞台坐标（1080×1920，y 向下）
      palm: { x, y },        // 掌心
      pinch: { on: boolean },// 拇指食指是否捏住
      pose: { pose: 'open'|'point'|'pinch'|'fist'|'ok'|'v'|'other', nExt: 0..5, palm: {x,y} },
      still: number,         // 这只手静止了多久（秒）
    },
  ],
  pointer: { on: boolean, x, y }, // 无摄像头模式的鼠标位置（舞台坐标）
  firstPerson: boolean,
  input: { dolly: number },  // v6：屏幕右下推拉圆盘，-1 = 后退，+1 = 前进，0 = 松手
};
```

硬性要求：

- **不许每帧 new**：预分配 `THREE.Vector3` 等，update 里只赋值。`frame.hands` 的数组本身也不许改。
- **不许 setInterval / setTimeout 做动画**；一切按 `dt` 推进（手机切后台 dt 会跳，用 `Math.min(dt, 0.05)`）。
- **不许读文件 / fetch / 外部图片**：几何和贴图全部程序生成。
- 手是 0 只时要正常跑（比如相机继续缓慢环绕）。

## 5. gesture(ev) 的事件

`ev.type` 只会是：`'tap'`（轻触）、`'pinch'`（捏一下，已去抖）、`'sweep'`（横抚/横挥）、`'fist'`（握拳）、`'near'`（手靠近）、`'duet'`（双手同时）。事件可能带 `{ order, dir, slot }`，不要依赖不存在的字段。

**手势要少、要好认**：一个场景最多用两种手势，其余操作走 `actions()` 按钮（可点，也支持手在画面里「悬停 + 捏合」按下，平台会把画面坐标给你）。

## 6. 视觉与性能

- 平台已经挂了 `UnrealBloomPass`（AE + ACES + sRGB 输出）。**亮色（>0.85 的 sRGB）会自动发光**，靠颜色出光，不要自己再写后处理。
- 目标：手机 60fps。三角面总数 ≤ 12 万（`quality==='low'` 时 ≤ 5 万），`update` 里三角面/对象数不变。
- 大量重复物体用 `THREE.InstancedMesh`；粒子用 `THREE.Points` + 自写 shader 或 `PointsMaterial`。
- 深色底（场景背景是 `#060509`），配色沿用花的场景的调性：蜜金 `#ffd9a0`、樱粉 `#ffb7c9`、冷蓝 `#a9c6ff`、薄荷 `#b8f0c8`。
- 相机：`PerspectiveCamera(48, stage.w / stage.h, 1, 4000)`，位置自己按场景摆。舞台坐标 = 世界坐标（1080 宽 = 世界 1080 单位），这样手势坐标能直接当世界坐标用。
- 第一人称：把相机放进场景内部（比如驾驶舱里），第三人称：在外面绕。`toggleView()` 负责切换并返回新视角。

## 7. 自检（必须做）

在 `E:\AI剪辑模式\bloom-fingertips` 下用仓库自带的服务器 + CDP 自测（`tools/cdp.mjs` 有 `launch/waitFor/sleep`）：

```powershell
node server.mjs --port 4222
```

打开 `http://127.0.0.1:4222/?debug=1`，在 console 里用
`__bloom.setPlatform('<你的 id>')` 切到自己的场景，`__bloom.platformInfo()` 看 stats，
并截图确认画面不是黑的。**交活前必须截图**（存到 `shots/v5/<id>.png`）。

## 8. 交活格式

回报里写：
1. 文件路径与行数；
2. `stats()` 的数字（对象数 / 三角面）；
3. 用了哪两种手势、各自什么效果；
4. `actions()` 列表；
5. 截图路径；
6. 已知没做/做得糙的地方（要老实说）。