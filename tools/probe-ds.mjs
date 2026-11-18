import { launch } from './cdp.mjs';
const b=await launch({port:9458,headless:true,extraArgs:['--use-angle=d3d11','--enable-gpu']});
const {cdp}=b; await cdp.send('Runtime.enable');
await cdp.send('Page.navigate',{url:'http://127.0.0.1:4173/'});
await cdp.waitFor('window.PALM_COSMOS',{timeout:20000});
console.log(await cdp.eval(`JSON.stringify({
  ua: navigator.userAgent.match(/Chrome\\/[\\d.]+/)?.[0],
  hasDS: typeof DecompressionStream,
  brotli: (()=>{ try { new DecompressionStream('brotli'); return true } catch(e) { return String(e).slice(0,40) } })(),
  gzip: (()=>{ try { new DecompressionStream('gzip'); return true } catch(e) { return false } })()
})`));
await b.close();
