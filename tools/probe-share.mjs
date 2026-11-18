/** probe-share.mjs — 手机视口冷启动：首屏 / 预载 / 点开始到进场景的耗时（直连，绕过系统代理）。 */
import { launch } from './cdp.mjs';

const BASE = (process.argv.slice(2).find((a) => !a.startsWith('--')) || 'http://127.0.0.1:4173').replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await launch({
  port: 9459,
  headless: true,
  extraArgs: ['--use-angle=d3d11', '--enable-gpu', '--no-proxy-server'],
});
const { cdp } = b;
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await cdp.send('Emulation.setUserAgentOverride', {
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
});

const t0 = Date.now();
const u = new URL(BASE + '/');
u.searchParams.set('debug', '1');
await cdp.send('Page.navigate', { url: u.href });
await cdp.waitFor('window.PALM_COSMOS && PALM_COSMOS.state.booted', { timeout: 90000 });
console.log('booted ms', Date.now() - t0);

let last = '';
for (let i = 0; i < 240; i++) {
  const t = await cdp.eval("document.getElementById('gatePreload').textContent");
  if (t !== last) {
    last = t;
    console.log(Date.now() - t0, t.trim().slice(0, 40));
  }
  if (t.includes('100%') || t.includes('失败')) break;
  await sleep(250);
}

const t1 = Date.now();
const ok = await cdp.eval('PALM_COSMOS.startCamera()');
console.log('start ok=', ok, 'ms=', Date.now() - t1, 'mode=', await cdp.eval('PALM_COSMOS.state.mode'), 'delegate=', await cdp.eval("PALM_COSMOS.tracker().delegate"), 'src=', await cdp.eval("PALM_COSMOS.tracker().source"), 'err=', await cdp.eval("PALM_COSMOS.state.cameraError||''"));
await b.close();