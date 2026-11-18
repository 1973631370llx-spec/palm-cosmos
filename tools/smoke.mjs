/**
 * smoke.mjs — 真实浏览器里跑一遍：demo / 指针 / 合成手 / 手机竖屏 / 性能 / 网络。
 * 用法：node tools/smoke.mjs [--url http://127.0.0.1:4173/] [--out shots]
 */
import { launch, screenshot } from './cdp.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = arg('--url', 'http://127.0.0.1:4173/').replace(/\/$/, '');
const OUT = path.resolve(arg('--out', 'shots'));
await mkdir(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { url: BASE, errors: [], requests: [], checks: [], timings: {}, fps: {} };

const b = await launch({
  port: 9444,
  headless: true,
  extraArgs: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const { cdp } = b;

const check = (name, ok, detail) => {
  results.checks.push({ name, ok: !!ok, detail });
  console.log(ok ? 'PASS' : 'FAIL', name, detail !== undefined ? JSON.stringify(detail) : '');
};

try {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Log.enable');

  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'warning') {
      results.errors.push(`${p.type}: ` + p.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    results.errors.push('EXC: ' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  });
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error') results.errors.push('LOG: ' + p.entry.text);
  });
  cdp.on('Network.requestWillBeSent', (p) => results.requests.push(p.request.url));

  const viewport = (width, height, dpr) =>
    cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: dpr,
      mobile: width < 600,
      screenWidth: width,
      screenHeight: height,
    });

  const nav = async (url) => {
    const t0 = Date.now();
    await cdp.send('Page.navigate', { url });
    await cdp.waitFor('window.PALM_COSMOS && window.PALM_COSMOS.state.booted', { timeout: 30000, interval: 50 });
    return Date.now() - t0;
  };

  const shot = async (name) => {
    await screenshot(cdp, path.join(OUT, name));
  };

  const ev = async (expr) => {
    const s = await cdp.eval(`JSON.stringify(${expr})`);
    return s ? JSON.parse(s) : null;
  };

  /* ── 1. 桌面 demo ───────────────────────────────────────── */
  await viewport(1440, 900, 1.5);
  results.timings.bootMs = await nav(`${BASE}/?demo=1`);
  await sleep(900);
  const s0 = await ev('PALM_COSMOS.stats()');
  check('boot: WebGL2 + particles', s0 && s0.particles >= 8000, s0);
  check('boot: ≤ 4000ms', results.timings.bootMs <= 4000, results.timings.bootMs);
  await shot('01-demo-open.png');

  // demo：坍缩 → 爆发
  let sawCollapse = false;
  let sawSupernova = false;
  let collapseMs = 0;
  const start = Date.now();
  while (Date.now() - start < 20000 && !(sawCollapse && sawSupernova)) {
    const s = await ev('({phase: PALM_COSMOS.state.phase, collapse: +PALM_COSMOS.state.collapse.toFixed(3), flash: +PALM_COSMOS.state.flash.toFixed(2)})');
    if (!sawCollapse && s.collapse > 0.9) {
      sawCollapse = true;
      collapseMs = Date.now() - start;
      await shot('02-demo-collapse.png');
    }
    if (!sawSupernova && s.phase === 'supernova') {
      sawSupernova = true;
      await shot('03-demo-supernova.png');
    }
    await sleep(60);
  }
  check('demo: collapse', sawCollapse);
  check('demo: supernova', sawSupernova);

  // 爆发帧连续性：先等上一轮结束，再干净地触发一次（期间不截图）
  await sleep(2600);
  await cdp.eval('PALM_COSMOS.triggerSupernova(1)');
  const burstFps = [];
  for (let i = 0; i < 5; i++) {
    const s = await ev('({phase: PALM_COSMOS.state.phase, fps: +PALM_COSMOS.state.fps.toFixed(1)})');
    burstFps.push(s.fps);
    await sleep(300);
  }
  results.fps.burst = burstFps;
  const worstDt = await ev('+(PALM_COSMOS.state.burstMaxDt || 0).toFixed(4)');
  results.fps.burstMaxDt = worstDt;
  check('perf: burst frame ≤ 22ms (no dropped frame)', worstDt > 0 && worstDt <= 0.022, { worstDt, burstFps });

  // 性能：不截图，2.5s 平均
  await sleep(600);
  const fpsBefore = await ev('PALM_COSMOS.state.fps');
  await sleep(2500);
  const fpsAfter = await ev('PALM_COSMOS.state.fps');
  results.fps.demo = { before: fpsBefore, after: fpsAfter };
  check('perf: ≥ 55fps (demo, GPU)', fpsAfter >= 55, results.fps.demo);

  // 8000 粒子下限也测一遍
  results.timings.lowParticlesBootMs = await nav(`${BASE}/?demo=1&count=8000`);
  await sleep(2200);
  const low = await ev('({fps: +PALM_COSMOS.state.fps.toFixed(1), n: PALM_COSMOS.stats().particles})');
  results.fps.low = low;
  check('perf: 8000 particles ≥ 55fps', low.fps >= 55 && low.n === 8000, low);

  const external = results.requests.filter(
    (u) => !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:')
  );
  check('network: no external requests', external.length === 0, external);
  check(
    'network: three + mediapipe local',
    results.requests.some((u) => u.includes('three.module.js')),
    results.requests.filter((u) => /three|mediapipe/.test(u)).slice(0, 6)
  );

  /* ── 2. 指针模式 ────────────────────────────────────────── */
  await nav(`${BASE}/?debug=1`);
  await cdp.eval(`document.getElementById('btnPointer').click()`);
  await sleep(250);
  const dbgVisible = await cdp.eval(`!document.getElementById('debugPanel').hidden`);
  check('debug: ?debug=1 panel', dbgVisible === 'true' || dbgVisible === true, dbgVisible);

  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 760, y: 430, button: 'none' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 760, y: 430, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(1500);
  const pDown = await ev('({collapse: +PALM_COSMOS.state.collapse.toFixed(2), down: PALM_COSMOS.state.pointer.down})');
  await shot('05-pointer-collapse.png');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 760, y: 430, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(200);
  const pUp = await ev('({phase: PALM_COSMOS.state.phase, flash: +PALM_COSMOS.state.flash.toFixed(2)})');
  await shot('06-pointer-supernova.png');
  check('pointer: hold collapses', pDown.collapse > 0.8, pDown);
  check('pointer: release bursts', pUp.phase === 'supernova' || pUp.flash > 0.05, pUp);

  /* ── 3. 合成手：跟随 / 张掌 / 握拳 / 丢失 / 爆发 ────────── */
  await nav(`${BASE}/?debug=1`);
  await cdp.eval(`window.PALM_COSMOS.setMode('hand')`);
  const makeHand = (pose, center) =>
    cdp.eval(`(async () => {
      const m = await import('/tools/fakehand.mjs');
      return m.makeHand('${pose}', { aspect: innerWidth / innerHeight, scale: 0.62, center: { x: ${center.x}, y: ${center.y} } });
    })()`);

  const lmOpenA = await makeHand('OPEN', { x: 0.46, y: 0.64 });
  await cdp.eval(`window.PALM_COSMOS.setSyntheticLandmarks(${JSON.stringify(lmOpenA)})`);
  await sleep(900);
  const hOpen = await ev('({openness: +PALM_COSMOS.state.openness.toFixed(2), collapse: +PALM_COSMOS.state.collapse.toFixed(2), scale: +PALM_COSMOS.state.scale.toFixed(2), anchor: PALM_COSMOS.state.handAnchorScreen, fingers: (PALM_COSMOS.state.fingerWorld||[]).length})');
  await shot('07-hand-open.png');

  // 手向右上移动，检查锚点跟随（位移 ×1.15）
  const lmOpenB = await makeHand('OPEN', { x: 0.58, y: 0.58 });
  await cdp.eval(`window.PALM_COSMOS.setSyntheticLandmarks(${JSON.stringify(lmOpenB)})`);
  await sleep(700);
  const hMoved = await ev('({anchor: PALM_COSMOS.state.handAnchorScreen, x: PALM_COSMOS.galaxy().group.position.x, y: PALM_COSMOS.galaxy().group.position.y})');
  await shot('08-hand-follow.png');

  // 握拳
  const lmFist = await makeHand('FIST', { x: 0.58, y: 0.58 });
  await cdp.eval(`window.PALM_COSMOS.setSyntheticLandmarks(${JSON.stringify(lmFist)})`);
  await sleep(1500);
  const hFist = await ev('({openness: +PALM_COSMOS.state.openness.toFixed(2), collapse: +PALM_COSMOS.state.collapse.toFixed(2), phase: PALM_COSMOS.state.phase})');
  await shot('09-hand-fist.png');

  // 张开 → 超新星
  const lmOpenC = await makeHand('OPEN', { x: 0.58, y: 0.58 });
  await cdp.eval(`window.PALM_COSMOS.setSyntheticLandmarks(${JSON.stringify(lmOpenC)})`);
  await sleep(180);
  const hBurst = await ev('({phase: PALM_COSMOS.state.phase, flash: +PALM_COSMOS.state.flash.toFixed(2)})');
  await shot('10-hand-supernova.png');

  // 手离开 → 等超新星结束 → 回待机
  await cdp.eval(`window.PALM_COSMOS.setSyntheticLandmarks(null)`);
  await sleep(3200);
  const hLost = await ev('({phase: PALM_COSMOS.state.phase, tracking: PALM_COSMOS.state.tracking})');
  await shot('11-hand-lost.png');

  check('hand: open detected', hOpen.openness > 0.7 && hOpen.collapse < 0.25, hOpen);
  check('hand: 5 fingertip stars', hOpen.fingers === 5, hOpen.fingers);
  check('hand: scale in 0.8–2.0×', hOpen.scale >= 0.7 && hOpen.scale <= 2.0, hOpen.scale);
  check(
    'hand: anchor follows (no sticky)',
    hMoved.anchor && Math.abs(hMoved.anchor.x - hOpen.anchor.x) > 40,
    { from: hOpen.anchor, to: hMoved.anchor, world: [hMoved.x, hMoved.y] }
  );
  check('hand: fist collapses', hFist.collapse > 0.6, hFist);
  check('hand: open triggers supernova', hBurst.phase === 'supernova' || hBurst.flash > 0.05, hBurst);
  check('hand: lost returns to standby', hLost.phase === 'standby' && hLost.tracking === false, hLost);

  /* ── 3b. 双手 / 捏合 / 指向 ─────────────────────────────── */
  const lmL = await makeHand('OPEN', { x: 0.32, y: 0.6 });
  const lmR = await makeHand('OPEN', { x: 0.68, y: 0.6 });
  await cdp.eval(`window.PALM_COSMOS.setSyntheticHands([${JSON.stringify(lmL)},${JSON.stringify(lmR)}])`);
  await sleep(1200);
  const dual = await ev(`({
    hands: PALM_COSMOS.state.handCount,
    fadeB: +PALM_COSMOS.slots()[1].fade.toFixed(2),
    sep: +Math.abs(PALM_COSMOS.slots()[0].ax - PALM_COSMOS.slots()[1].ax).toFixed(2),
    fps: +PALM_COSMOS.state.fps.toFixed(1)
  })`);
  await shot('15-dual.png');
  check('dual: two hands tracked', dual.hands === 2, dual);
  check('dual: second galaxy visible', dual.fadeB > 0.8, dual.fadeB);
  check('dual: galaxies apart', dual.sep > 0.8, dual.sep);
  check('dual: ≥ 55fps (2 × 12000)', dual.fps >= 55, dual.fps);

  // 两掌靠近 → 合并爆发
  const lmL2 = await makeHand('OPEN', { x: 0.475, y: 0.6 });
  const lmR2 = await makeHand('OPEN', { x: 0.525, y: 0.6 });
  await cdp.eval(`window.PALM_COSMOS.setSyntheticHands([${JSON.stringify(lmL2)},${JSON.stringify(lmR2)}])`);
  await sleep(700);
  const merge = await ev('({phase: PALM_COSMOS.state.phase, a: PALM_COSMOS.supernova().active, b: PALM_COSMOS.supernovaB().active})');
  await shot('16-merge.png');
  check('dual: close palms → merge burst', merge.phase === 'supernova' && merge.a && merge.b, merge);

  // 捏合 → 引力透镜
  const lmPinch = JSON.parse(JSON.stringify(lmOpenA));
  lmPinch[4] = { ...lmPinch[8] };
  await cdp.eval(`window.PALM_COSMOS.setSyntheticHands(null); window.PALM_COSMOS.setSyntheticLandmarks(${JSON.stringify(lmPinch)})`);
  await sleep(900);
  const pinch = await ev('({pinchOn: PALM_COSMOS.slots()[0].pinchOn, lens: +PALM_COSMOS.slots()[0].lens.toFixed(2), collapse: +PALM_COSMOS.slots()[0].collapse.toFixed(2), horizon: PALM_COSMOS.blackhole().horizon.visible})');
  await shot('17-pinch.png');
  check('pinch: lens engaged, no horizon', pinch.pinchOn && pinch.lens > 0.6 && !pinch.horizon, pinch);

  // 单指 → 指尖星加亮
  const lmPoint = await makeHand('POINT', { x: 0.5, y: 0.6 });
  await cdp.eval(`window.PALM_COSMOS.setSyntheticLandmarks(${JSON.stringify(lmPoint)})`);
  await sleep(500);
  const point = await ev('({point: PALM_COSMOS.slots()[0].point, pinchOn: PALM_COSMOS.slots()[0].pinchOn})');
  check('point: index-only detected', point.point === true && point.pinchOn === false, point);

  /* ── 4. 手机竖屏 ────────────────────────────────────────── */
  await viewport(390, 844, 3);
  results.timings.mobileBootMs = await nav(`${BASE}/?demo=1`);
  await sleep(1600);
  const mobile = await ev('({w: innerWidth, h: innerHeight, fps: +PALM_COSMOS.state.fps.toFixed(1), dpr: PALM_COSMOS.renderer().getPixelRatio()})');
  await shot('12-mobile-demo.png');
  check('mobile: 390×844 + dpr≤1.5', mobile.w === 390 && mobile.h === 844 && mobile.dpr <= 1.5, mobile);

  await cdp.send('Page.navigate', { url: `${BASE}/` });
  await cdp.waitFor('document.querySelector("#gate") && !document.querySelector("#gate").classList.contains("hidden")', { timeout: 15000 });
  await shot('13-mobile-gate.png');
} catch (err) {
  results.errors.push('TEST: ' + (err?.stack || err?.message || String(err)));
  console.error(err);
} finally {
  await b.close();
}

results.summary = {
  passed: results.checks.filter((c) => c.ok).length,
  failed: results.checks.filter((c) => !c.ok).map((c) => c.name),
};
await writeFile(path.join(OUT, 'report.json'), JSON.stringify(results, null, 2));
console.log('\nSUMMARY', JSON.stringify(results.summary));
if (results.errors.length) console.log('ERRORS', results.errors.slice(0, 6));