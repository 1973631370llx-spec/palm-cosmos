import { launch } from './cdp.mjs';
const b=await launch({port:9463,headless:true,extraArgs:['--use-angle=d3d11','--enable-gpu']});
const {cdp}=b; await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
await cdp.send('Page.navigate',{url:'http://127.0.0.1:4173/?cdn=1&debug=1'});
await cdp.waitFor('window.PALM_COSMOS && PALM_COSMOS.state.booted',{timeout:60000});
const res=await cdp.eval(`JSON.stringify(performance.getEntriesByType('resource').map(e=>({n:e.name.replace(/^https?:\\/\\//,'').slice(0,70),d:Math.round(e.duration),s:Math.round(e.transferSize/1024),st:Math.round(e.startTime)})).sort((a,b)=>b.d-a.d).slice(0,12))`);
console.log(res);
await b.close();
