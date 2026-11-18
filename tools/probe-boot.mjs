import { launch } from './cdp.mjs';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const b=await launch({port:9466,headless:true,extraArgs:['--use-angle=d3d11','--enable-gpu']});
const {cdp}=b; const errs=[];
await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Log.enable');
cdp.on('Runtime.exceptionThrown',p=>errs.push('EXC '+(p.exceptionDetails?.exception?.description||p.exceptionDetails?.text)));
cdp.on('Runtime.consoleAPICalled',p=>{ if(p.type==='error') errs.push('CON '+p.args.map(a=>a.value??a.description??'').join(' ').slice(0,200)); });
cdp.on('Log.entryAdded',p=>{ if(p.entry.level==='error') errs.push('LOG '+p.entry.text.slice(0,200)); });
const t0=Date.now();
await cdp.send('Page.navigate',{url:'https://1973631370llx-spec.github.io/palm-cosmos/?v=6&debug=1'});
let ok=false;
for(let i=0;i<40;i++){ if(await cdp.eval('!!(window.PALM_COSMOS&&PALM_COSMOS.state.booted)')){ ok=true; break; } await sleep(1000); }
console.log('booted', ok, (Date.now()-t0)+'ms');
console.log('errors', JSON.stringify(errs.slice(0,6)));
console.log('gate', await cdp.eval("document.getElementById('gatePreload')?.textContent"));
await b.close();
