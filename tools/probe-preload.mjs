import { launch } from './cdp.mjs';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const b=await launch({port:9457,headless:true,extraArgs:['--use-angle=d3d11','--enable-gpu']});
const {cdp}=b;
await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
await cdp.send('Page.navigate',{url:'http://127.0.0.1:4173/?debug=1'});
await cdp.waitFor('window.PALM_COSMOS && PALM_COSMOS.state.booted',{timeout:30000});
const seen=new Set();
for(let i=0;i<40;i++){ const t=await cdp.eval("document.getElementById('gatePreload').textContent"); if(!seen.has(t)){seen.add(t); console.log('gate:', t);} if(t.includes('100%')) break; await sleep(250); }
const packed=await cdp.eval("!!(PALM_COSMOS.tracker()._assets||{}).packed");
console.log('packed(brotli):', packed);
const t0=Date.now();
await cdp.eval("PALM_COSMOS.startCamera()");
const mode=await cdp.eval("PALM_COSMOS.state.mode");
const det=await cdp.eval("+(PALM_COSMOS.tracker().avgDetect||0).toFixed(1)");
console.log('start ms=', Date.now()-t0, 'mode=', mode, 'detect=', det, 'delegate=', await cdp.eval("PALM_COSMOS.tracker().delegate"));
console.log('err=', await cdp.eval("PALM_COSMOS.state.cameraError || PALM_COSMOS.tracker().error || ''"));
await b.close();
