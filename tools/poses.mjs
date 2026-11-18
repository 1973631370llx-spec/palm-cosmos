/** poses.mjs �?GPU 下定格四个姿态截图，用于视觉校对（不�?demo 时序影响）�?*/
import { launch, screenshot } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await launch({
  port: 9449,
  headless: true,
  extraArgs: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const { cdp } = b;
const errs = [];
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Log.enable');
cdp.on('Runtime.exceptionThrown', (p) => errs.push('EXC ' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text)));
cdp.on('Log.entryAdded', (p) => errs.push('LOG ' + p.entry.level + ' ' + p.entry.text));

const width = Number(process.argv[2] || 1440);
const height = Number(process.argv[3] || 900);
await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1.5, mobile: false });
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:4174/?demo=1' });
await cdp.waitFor('window.PALM_COSMOS && window.PALM_COSMOS.state.booted', { timeout: 40000 });
await cdp.eval('localStorage.clear && 0');

const poses = [
  ['pose-open', { collapse: 0, x: 0.01, y: -0.2, tilt: 0.98 }],
  ['pose-collapse', { collapse: 1, x: 0.01, y: -0.2, tilt: 0.98 }],
  ['pose-burst', { collapse: 0.22, flash: 0.85, burst: 0.95, ring: 0.22, x: 0.01, y: -0.2, tilt: 0.98 }],
  ['pose-after', { collapse: 0.03, flash: 0.12, burst: 0.25, x: 0.01, y: -0.2, tilt: 0.98 }],
];

for (const [name, pose] of poses) {
  await cdp.eval(`PALM_COSMOS.setPose(${JSON.stringify(pose)})`);
  await sleep(260);
  await screenshot(cdp, `shots/${name}.png`);
  console.log('shot', name, await cdp.eval('JSON.stringify({collapse:+PALM_COSMOS.state.collapse.toFixed(2),scale:+PALM_COSMOS.state.scale.toFixed(2),fps:+PALM_COSMOS.state.fps.toFixed(0)})'));
}

console.log('ERRS', errs.slice(0, 5));
await b.close();