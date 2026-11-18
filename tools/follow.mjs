/** follow.mjs — 量化"跟手"：手瞬移 0.5 屏宽后，星系多久贴到目标。 */
import { launch } from './cdp.mjs';

const b = await launch({ port: 9451, headless: true, extraArgs: ['--use-angle=d3d11', '--enable-gpu'] });
const { cdp } = b;
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:4173/?debug=1' });
await cdp.waitFor('window.PALM_COSMOS && PALM_COSMOS.state.booted', { timeout: 20000 });
await cdp.eval(`PALM_COSMOS.setMode('hand')`);

const hand = (x, y) =>
  cdp.eval(`(async () => {
    const m = await import('/tools/fakehand.mjs');
    return JSON.stringify(m.makeHand('OPEN', { aspect: innerWidth / innerHeight, scale: 0.62, center: { x: ${x}, y: ${y} } }));
  })()`);

const setHand = async (x, y) => {
  const lm = JSON.parse(await hand(x, y));
  await cdp.eval(`PALM_COSMOS.setSyntheticLandmarks(${JSON.stringify(lm)})`);
};

await setHand(0.2, 0.6);
await new Promise((r) => setTimeout(r, 900));
await setHand(0.8, 0.6);

const t0 = Date.now();
const samples = [];
for (let i = 0; i < 40; i++) {
  const s = JSON.parse(
    await cdp.eval(`JSON.stringify({v: PALM_COSMOS.slots()[0].anchorX.value, t: PALM_COSMOS.slots()[0].anchorX.target, vel: PALM_COSMOS.slots()[0].velX, fps: PALM_COSMOS.state.fps})`)
  );
  samples.push({ ms: Date.now() - t0, err: Math.abs(s.v - s.t), v: +s.v.toFixed(2), t: +s.t.toFixed(2), vel: +s.vel.toFixed(1), fps: s.fps });
  if (samples.length > 6 && samples.slice(-3).every((x) => x.err < 0.05)) break;
  await new Promise((r) => setTimeout(r, 20));
}
console.log(JSON.stringify(samples.slice(0, 12), null, 0));
const ref = Math.abs(samples[1].v - samples[1].t) || 1;
const first = samples.slice(2).find((x) => x.err < 0.15 * ref);
const settled = samples.find((x, i) => samples.slice(i).every((y) => y.err < 0.05 * ref));
console.log(
  JSON.stringify(
    {
      jump: +ref.toFixed(2),
      reach15pctMs: first?.ms ?? null,
      settleMs: settled?.ms ?? samples[samples.length - 1].ms,
      finalErr: +samples[samples.length - 1].err.toFixed(3),
      fps: samples[samples.length - 1].fps.toFixed(0),
    },
    null,
    2
  )
);
await b.close();