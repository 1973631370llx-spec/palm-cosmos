/** probe.mjs — 在真实 GPU 上做一次可控实验：切换 bloom / 粒子 / 黑洞，测中心暗度。 */
import { launch, screenshot } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await launch({
  port: 9451,
  headless: true,
  extraArgs: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const { cdp } = b;
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
const errors = [];
cdp.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.text));

await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1.5, mobile: false });
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:4174/?demo=1' });
await cdp.waitFor('window.PALM_COSMOS && window.PALM_COSMOS.state.booted', { timeout: 40000 });
await cdp.eval('PALM_COSMOS.setPose({collapse:1,x:0.01,y:-0.2,tilt:0.98})');
await sleep(400);

const shot = async (name) => {
  await screenshot(cdp, `shots/probe-${name}.png`);
  console.log('shot', name, await cdp.eval('JSON.stringify({bloom:+PALM_COSMOS.bloom().strength.toFixed(2),thr:+PALM_COSMOS.bloom().threshold.toFixed(2)})'));
};

await shot('base');

await cdp.eval('PALM_COSMOS.bloom().strength = 0');
await sleep(300);
await shot('nobloom');
await cdp.eval('PALM_COSMOS.bloom().strength = 0.4');

await cdp.eval('PALM_COSMOS.galaxy().points.visible = false; PALM_COSMOS.galaxy().disk.visible = false; PALM_COSMOS.galaxy().glow.visible = false');
await sleep(300);
await shot('noparticles');
await cdp.eval('PALM_COSMOS.galaxy().points.visible = true; PALM_COSMOS.galaxy().disk.visible = true; PALM_COSMOS.galaxy().glow.visible = true');

await cdp.eval('PALM_COSMOS.blackhole().horizon.material.color.set(0xff0000)');
await sleep(300);
await shot('horizon-red');
await cdp.eval('PALM_COSMOS.blackhole().horizon.material.color.set(0x000000)');

console.log('ERRORS', errors);
await b.close();