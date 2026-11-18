/** mobile.mjs — 手机端（iPhone 视口 + 移动 UA + 假摄像头）在公网 URL 上跑一遍。 */
import { launch, screenshot } from './cdp.mjs';

const BASE = (process.argv.slice(2).find((a) => !a.startsWith('--')) || 'http://127.0.0.1:4173').replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await launch({ port: 9453, headless: true, extraArgs: ['--use-angle=d3d11', '--enable-gpu'] });
const { cdp } = b;
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await cdp.send('Emulation.setUserAgentOverride', {
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
});

const t0 = Date.now();
await cdp.send('Page.navigate', { url: `${BASE}/?debug=1` });
await cdp.waitFor('window.PALM_COSMOS && PALM_COSMOS.state.booted', { timeout: 60000 });
const bootMs = Date.now() - t0;
await sleep(900);

const info = JSON.parse(
  await cdp.eval(`JSON.stringify({
    w: innerWidth, h: innerHeight, dpr: PALM_COSMOS.state.dpr, count: PALM_COSMOS.state.count,
    fps: +PALM_COSMOS.state.fps.toFixed(0), mobile: PALM_COSMOS.state.isMobile,
    gate: !document.getElementById('gate').classList.contains('hidden'),
    supportsWebGL2: !!document.createElement('canvas').getContext('webgl2')
  })`)
);

// 手机端开摄像头
const cam = JSON.parse(
  await cdp.eval(`(async () => {
    const t = performance.now();
    const ok = await PALM_COSMOS.startCamera();
    const tr = PALM_COSMOS.tracker() || {};
    return JSON.stringify({
      ok, ms: Math.round(performance.now() - t), mode: PALM_COSMOS.state.mode,
      err: PALM_COSMOS.state.cameraError || tr.error || null,
      delegate: tr.delegate, trackerMode: tr.mode
    });
  })()`)
);

await screenshot(cdp, 'shots/22-mobile-tunnel.png');
const res = JSON.parse(
  await cdp.eval(`JSON.stringify({
    source: (PALM_COSMOS.tracker() || {}).source,
    slow: performance.getEntriesByType('resource')
      .filter(e => e.duration > 300)
      .map(e => ({ u: e.name.replace(/^https?:\\/\\//, '').slice(0, 46), ms: Math.round(e.duration), kb: Math.round(e.transferSize / 1024) }))
      .sort((a, b) => b.ms - a.ms).slice(0, 8)
  })`)
);
const out = { base: BASE, bootMs, ...info, cam, ...res };
console.log(JSON.stringify(out, null, 2));
await b.close();