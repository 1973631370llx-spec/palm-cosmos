/** gate.mjs — 桌面开始面板截图。 */
import { launch, screenshot } from './cdp.mjs';

const b = await launch({
  port: 9448,
  headless: true,
  extraArgs: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const { cdp } = b;
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1.5, mobile: false });
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:4173/' });
await cdp.waitFor('window.PALM_COSMOS && PALM_COSMOS.state.booted', { timeout: 20000 });
await new Promise((r) => setTimeout(r, 900));
await screenshot(cdp, 'shots/14-desktop-gate.png');
console.log(await cdp.eval(`document.querySelector('.gate-card h2').textContent + ' | ' + document.querySelector('.gate-sub').textContent + ' | ' + [...document.querySelectorAll('.btn .zh')].map(e=>e.textContent).join(' / ') + ' | ' + document.querySelector('.privacy').textContent`));
await b.close();