/** 识别 Worker：吃 ImageBitmap，吐 21 点。不碰 DOM，不碰主线程。 */
import { FilesetResolver, HandLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

let landmarker = null;
let delegate = '—';
let busy = false;
let canvas = null;
let ctx2d = null;

async function init(msg) {
  // MediaPipe 的 wasm loader 是 classic script，靠全局 ModuleFactory 工作；
  // module worker 里 importScripts 不可用，先把它以全局方式执行一次。
  if (!self.ModuleFactory) {
    const res = await fetch(`${msg.wasmPath}/vision_wasm_internal.js`);
    const code = await res.text();
    // eslint-disable-next-line no-eval
    (0, eval)(code);
  }
  const fileset = await FilesetResolver.forVisionTasks(msg.wasmPath);
  const opts = (d) => ({
    baseOptions: { modelAssetPath: msg.modelPath, delegate: d },
    runningMode: 'VIDEO',
    numHands: msg.numHands || 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.4,
  });
  try {
    landmarker = await HandLandmarker.createFromOptions(fileset, opts(msg.delegate || 'CPU'));
    delegate = msg.delegate || 'CPU';
  } catch (err) {
    const alt = (msg.delegate || 'CPU') === 'GPU' ? 'CPU' : 'GPU';
    landmarker = await HandLandmarker.createFromOptions(fileset, opts(alt));
    delegate = alt;
  }
  return delegate;
}

self.onmessage = async (e) => {
  const m = e.data;

  if (m.type === 'init') {
    try {
      const d = await init(m);
      self.postMessage({ type: 'ready', delegate: d });
    } catch (err) {
      self.postMessage({ type: 'error', error: err?.message || String(err) });
    }
    return;
  }

  if (m.type === 'frame') {
    const bitmap = m.bitmap;
    if (!landmarker || busy) {
      self.postMessage({ type: 'log', msg: 'frame dropped', has: !!landmarker, busy });
      bitmap?.close?.();
      return;
    }
    busy = true;
    const t0 = performance.now();
    try {
      self.postMessage({ type: 'log', msg: `detect start ${m.id} ${bitmap.width}x${bitmap.height}` });
      if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        ctx2d = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
      }
      ctx2d.drawImage(bitmap, 0, 0);
      const res = landmarker.detectForVideo(canvas, m.ts);
      const hands = (res?.landmarks || []).map((lm, i) => ({
        landmarks: lm,
        worldLandmarks: res.worldLandmarks?.[i] || null,
        handedness: (res.handednesses || res.handedness)?.[i]?.[0]?.categoryName || null,
      }));
      self.postMessage({ type: 'result', id: m.id, hands, ms: performance.now() - t0 });
    } catch (err) {
      self.postMessage({ type: 'result', id: m.id, hands: [], ms: 0, error: err?.message || String(err) });
    } finally {
      busy = false;
      bitmap?.close?.();
    }
    return;
  }

  if (m.type === 'close') {
    try {
      landmarker?.close?.();
    } catch (err) {
      /* noop */
    }
    landmarker = null;
    self.close();
  }
};