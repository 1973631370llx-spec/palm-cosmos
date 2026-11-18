/** probe-boot.mjs — 打开公网站点，报首屏时间、预载百分比、控制台错误。直连（绕过系统代理）。
 *  用法：node tools/probe-boot.mjs [url] */
import { launch } from './cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL_ARG = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'https://1973631370llx-spec.github.io/palm-cosmos/';

const b = await launch({
  port: 9466,
  headless: true,
  extraArgs: ['--use-angle=d3d11', '--enable-gpu', '--no-proxy-server'],
});
const { cdp } = b;
const errs = [];
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Log.enable');
cdp.on('Runtime.exceptionThrown', (p) =>
  errs.push('EXC ' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text))
);
cdp.on('Runtime.consoleAPICalled', (p) => {
  if (p.type === 'error') errs.push('CON ' + p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
});
cdp.on('Log.entryAdded', (p) => {
  if (p.entry.level === 'error') errs.push('LOG ' + p.entry.text.slice(0, 200));
});

const t0 = Date.now();
const u = new URL(URL_ARG);
u.searchParams.set('debug', '1');
await cdp.send('Page.navigate', { url: u.href });

let booted = false;
for (let i = 0; i < 90; i++) {
  if (await cdp.eval('!!(window.PALM_COSMOS && PALM_COSMOS.state.booted)')) {
    booted = true;
    break;
  }
  await sleep(500);
}
console.log('booted', booted, Date.now() - t0, 'ms');

let preloadMs = 0;
let lastPct = '';
for (let i = 0; i < 240; i++) {
  const txt = await cdp.eval("document.getElementById('gatePreload')?.textContent || ''");
  if (txt !== lastPct) {
    lastPct = txt;
  }
  if (txt.includes('100%') || txt.includes('失败')) {
    preloadMs = Date.now() - t0;
    console.log('preload:', txt.slice(0, 32).trim(), preloadMs, 'ms');
    break;
  }
  await sleep(500);
}

const t1 = Date.now();
const ok = await cdp.eval('PALM_COSMOS.startCamera()');
console.log('start', ok, Date.now() - t1, 'ms', 'mode', await cdp.eval('PALM_COSMOS.state.mode'), 'src', await cdp.eval('PALM_COSMOS.tracker().source'));
console.log('errors', JSON.stringify(errs.slice(0, 5)));
await b.close();