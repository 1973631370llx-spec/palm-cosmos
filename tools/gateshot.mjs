/** gateshot.mjs — 手机 + 桌面开始面板截图。 */
import { launch, screenshot } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await launch({ port: 9450, headless: true, extraArgs: ['--use-angle=d3d11', '--enable-gpu'] });
const { cdp } = b;
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');

for (const [name, w, h, dpr] of [
  ['20-gate-desktop.png', 1440, 900, 1.5],
  ['21-gate-mobile.png', 390, 844, 2],
]) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile: w < 600 });
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:4173/' });
  await cdp.waitFor('window.PALM_COSMOS && PALM_COSMOS.state.booted', { timeout: 20000 });
  await sleep(900);
  await screenshot(cdp, `shots/${name}`);
  const box = await cdp.eval(`JSON.stringify((() => { const r = document.querySelector('.gate-card').getBoundingClientRect(); return {top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), vh: innerHeight}; })())`);
  console.log(name, box);
}
await b.close();