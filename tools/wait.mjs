/** wait.mjs — 模拟「用户先在面板停留一会儿再点开始」：预载后再开摄像头。 */
import { launch } from './cdp.mjs';

const BASE = (process.argv.slice(2).find((a) => !a.startsWith('--')) || 'http://127.0.0.1:4173').replace(/\/$/, '');
const WAIT = Number(process.argv.find((a) => a.startsWith('--wait='))?.split('=')[1] || 25);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await launch({ port: 9454, headless: true, extraArgs: ['--use-angle=d3d11', '--enable-gpu'] });
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

await sleep(WAIT * 1000);
const pre = await cdp.eval(`(document.getElementById('gatePreload').hidden ? 'done' : document.getElementById('gatePreload').textContent)`);

const t1 = Date.now();
const cam = JSON.parse(
  await cdp.eval(`(async () => {
    const ok = await PALM_COSMOS.startCamera();
    const tr = PALM_COSMOS.tracker() || {};
    return JSON.stringify({ ok, mode: PALM_COSMOS.state.mode, err: PALM_COSMOS.state.cameraError || tr.error || null, delegate: tr.delegate });
  })()`)
);
console.log(JSON.stringify({ base: BASE, bootMs, waitedMs: WAIT * 1000, preload: pre, cameraMs: Date.now() - t1, ...cam }, null, 2));
const res = await cdp.eval(
  `JSON.stringify({
    downloads: performance.getEntriesByType('resource').filter(e => /\\.(wasm|task)$/.test(e.name))
      .map(e => ({ f: e.name.split('/').pop(), transfer: e.transferSize, dur: Math.round(e.duration) })),
    assets: !!PALM_COSMOS.tracker()._assets,
    wasmUrl: (PALM_COSMOS.tracker()._assets?.wasmUrl || '').slice(0, 24)
  })`
);
console.log('downloads:', res);
await b.close();