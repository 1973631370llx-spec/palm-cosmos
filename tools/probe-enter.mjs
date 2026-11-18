import { launch } from './cdp.mjs';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const b=await launch({port:9461,headless:true,extraArgs:['--use-angle=d3d11','--enable-gpu']});
const {cdp}=b;
await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:3,mobile:true});
const t0=Date.now();
await cdp.send('Page.navigate',{url:'http://127.0.0.1:4173/?debug=1'});
await cdp.waitFor('window.PALM_COSMOS && PALM_COSMOS.state.booted',{timeout:30000});
console.log('boot', Date.now()-t0);
await cdp.eval("document.getElementById('btnCamera').click()");
let gateClosed=0, runningAt=0;
for(let i=0;i<200;i++){
  const st=await cdp.eval("JSON.stringify({gate:document.getElementById('gate').className, mode:PALM_COSMOS.state.mode, run:!!PALM_COSMOS.tracker().running, det:PALM_COSMOS.tracker().avgDetect|0, hint:document.getElementById('hint').textContent})");
  const o=JSON.parse(st);
  if(!gateClosed && o.gate.includes('hidden')){ gateClosed=Date.now()-t0; console.log('gate closed ms', gateClosed, 'hint:', o.hint); }
  if(!runningAt && o.run){ runningAt=Date.now()-t0; console.log('tracker running ms', runningAt, 'detect', o.det); break; }
  await sleep(200);
}
const fps=await cdp.eval("Math.round(PALM_COSMOS.state.fps||0)");
console.log('fps', fps, 'mode', await cdp.eval("PALM_COSMOS.state.mode"));
await b.close();


