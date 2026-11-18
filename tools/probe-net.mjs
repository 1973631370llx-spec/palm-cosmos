import { launch } from './cdp.mjs';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const b=await launch({port:9465,headless:true,extraArgs:['--use-angle=d3d11','--enable-gpu']});
const {cdp}=b; await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
await cdp.send('Page.navigate',{url:'https://1973631370llx-spec.github.io/palm-cosmos/'});
await cdp.waitFor('window.PALM_COSMOS',{timeout:60000});
await cdp.eval(`window.__probe=[]; window.__go=async()=>{
  const test=async(u,label)=>{ const t=performance.now(); try{ const res=await fetch(u); const buf=await res.arrayBuffer(); const s=(performance.now()-t)/1000; window.__probe.push({label, mb:+(buf.byteLength/1048576).toFixed(2), s:+s.toFixed(2), kbs:Math.round(buf.byteLength/1024/s)}); }catch(e){ window.__probe.push({label, err:String(e).slice(0,60)}); } };
  await Promise.all([
    test('https://registry.npmmirror.com/@mediapipe/tasks-vision/0.10.35/files/wasm/vision_wasm_internal.wasm','npmmirror-wasm'),
    test('https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task','google-model'),
    test('https://1973631370llx-spec.github.io/palm-cosmos/vendor/mediapipe/wasm/vision_wasm_internal.wasm.gz','github-gz')
  ]);
  window.__done=true;
};
window.__probe=[]; window.__done=false; window.__go();`);
for(let i=0;i<80;i++){ if(await cdp.eval('!!window.__done')) break; await sleep(1000); }
console.log(await cdp.eval('JSON.stringify(window.__probe)'));
await b.close();
