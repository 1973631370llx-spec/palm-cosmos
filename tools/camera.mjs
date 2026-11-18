/** camera.mjs — 用假摄像头走一遍真实 MediaPipe 路径，检查本地模型加载与延迟。 */
import { launch, screenshot } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = (process.argv.slice(2).find((a) => !a.startsWith('--')) || 'http://127.0.0.1:4173').replace(/\/$/, '');

const b = await launch({
  port: 9447,
  headless: !process.argv.includes('--headful'),
  extraArgs: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const { cdp } = b;
const errors = [];
const requests = [];
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');
await cdp.send('Log.enable');
cdp.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
cdp.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') errors.push('console: ' + p.args.map((a) => a.value ?? a.description ?? '').join(' '));
  if (p.args?.[0]?.value === '[hand-worker]') errors.push('worker: ' + (p.args[1]?.value || ''));
});
cdp.on('Log.entryAdded', (p) => p.entry.level === 'error' && errors.push(p.entry.text));
cdp.on('Network.requestWillBeSent', (p) => requests.push(p.request.url));

await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1.5, mobile: false });
await cdp.send('Page.navigate', { url: `${BASE}/?debug=1` });
await cdp.waitFor('window.PALM_COSMOS && window.PALM_COSMOS.state.booted', { timeout: 30000 });

await cdp.eval(`document.getElementById('btnCamera').click()`);
const started = await cdp
  .waitFor(`window.PALM_COSMOS.state.mode === 'hand' || document.getElementById('camLabel').textContent.includes('OFFLINE')`, {
    timeout: 120000,
    interval: 150,
  })
  .then(() => true)
  .catch(() => false);

await sleep(2500);
const info = JSON.parse(
  await cdp.eval(`JSON.stringify({
    mode: PALM_COSMOS.state.mode,
    trackerMode: PALM_COSMOS.tracker().mode,
    running: PALM_COSMOS.tracker().running,
    delegate: PALM_COSMOS.tracker().delegate,
    latency: +PALM_COSMOS.tracker().latencyMs.toFixed(1),
    detect: +PALM_COSMOS.tracker().lastDetectMs.toFixed(1),
    fps: +PALM_COSMOS.state.fps.toFixed(1),
    camLabel: document.getElementById('camLabel').textContent,
    delegateText: document.getElementById('delegateVal').textContent,
    error: PALM_COSMOS.tracker().error,
    appError: PALM_COSMOS.state.cameraError,
    sent: PALM_COSMOS.tracker().sent,
    results: PALM_COSMOS.tracker().results,
    avgDetect: +PALM_COSMOS.tracker().avgDetect.toFixed(1),
    age: Math.round(performance.now() - PALM_COSMOS.tracker().lastSeen)
  })`)
);

const mediapipe = requests.filter((u) => /mediapipe|wasm|\.task/.test(u));
const external = requests.filter((u) => !u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:'));

await screenshot(cdp, 'shots/20-camera.png');
console.log(JSON.stringify({ started, info, mediapipe, external, errors: errors.slice(0, 5) }, null, 2));
await b.close();