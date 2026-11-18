/**
 * camera.js — 摄像头采集 + MediaPipe HandLandmarker。
 *
 * · getUserMedia 只在本机处理，视频帧不出浏览器（没有任何上传代码）。
 * · 模型 / wasm 全部来自本地 vendor/，可以完全离线跑（首次把进度条走完）。
 * · delegate 先 'GPU'，失败自动回退 'CPU'。
 * · 检测循环用 requestVideoFrameCallback（没有就退 rAF），不用 setInterval。
 */

import { FilesetResolver, HandLandmarker } from '../vendor/mediapipe/vision_bundle.js';
import { CAMERA, HANDS } from './config.js';

const WASM_DIR = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
const MODEL_URL = new URL('../vendor/mediapipe/hand_landmarker.task', import.meta.url).href;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带进度的预取：把 wasm / 模型先灌进浏览器缓存，
 * 这样 MediaPipe 自己再去拿的时候是命中缓存，进度条才有意义。
 */
export async function preloadAssets({ onProgress = () => {}, signal } = {}) {
  const urls = [
    `${WASM_DIR}/vision_wasm_internal.js`,
    `${WASM_DIR}/vision_wasm_internal.wasm`,
    MODEL_URL,
  ];
  let total = 0;
  const sizes = [];
  for (const url of urls) {
    let size = 0;
    try {
      const head = await fetch(url, { method: 'HEAD', signal });
      size = Number(head.headers.get('content-length')) || 0;
    } catch {
      size = 0;
    }
    sizes.push(size);
    total += size;
  }
  if (!total) total = 1;
  let done = 0;
  for (let i = 0; i < urls.length; i += 1) {
    try {
      const res = await fetch(urls[i], { signal });
      if (!res.ok) {
        done += sizes[i] || total / urls.length;
        onProgress(Math.min(1, done / total));
        continue;
      }
      if (!res.body || !res.body.getReader) {
        await res.arrayBuffer();
        done += sizes[i] || total / urls.length;
        onProgress(Math.min(1, done / total));
        continue;
      }
      const reader = res.body.getReader();
      for (;;) {
        const { done: chunkDone, value } = await reader.read();
        if (chunkDone) break;
        done += value ? value.byteLength : 0;
        onProgress(Math.min(1, done / total));
      }
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      done += sizes[i] || total / urls.length;
      onProgress(Math.min(1, done / total));
    }
  }
  return true;
}

/** 创建 HandLandmarker：GPU 优先，失败回退 CPU */
export async function createLandmarker({ onProgress = () => {}, onDelegate = () => {}, signal } = {}) {
  onProgress(0.02);
  const fileset = await FilesetResolver.forVisionTasks(WASM_DIR);
  onProgress(0.35);
  const base = {
    runningMode: 'VIDEO',
    numHands: HANDS.numHands,
    minHandDetectionConfidence: HANDS.minHandDetectionConfidence,
    minHandPresenceConfidence: HANDS.minHandPresenceConfidence,
    minTrackingConfidence: HANDS.minTrackingConfidence,
  };
  const attempt = async (delegate) => {
    const lm = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      ...base,
    });
    return lm;
  };
  let landmarker = null;
  let delegate = HANDS.delegate;
  try {
    landmarker = await attempt(HANDS.delegate);
  } catch (err) {
    console.warn('[bloom] GPU delegate 失败，回退 CPU', err && err.message);
    delegate = HANDS.delegateFallback;
    landmarker = await attempt(HANDS.delegateFallback);
  }
  onDelegate(delegate);
  onProgress(1);
  void signal;
  return landmarker;
}

/**
 * 打开摄像头。返回 { stream, video }；video 已经是隐藏播放状态。
 */
export async function openCamera(video, { constraints = CAMERA.constraints } = {}) {
  // 用 http://内网IP 打开时浏览器不给 getUserMedia（不是安全上下文），
  // 这种情况单独报，别让用户以为「浏览器不支持」
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    const err = new Error('http 地址浏览器禁止调用摄像头（需要 https 或 localhost）');
    err.code = 'insecure';
    throw err;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const err = new Error('浏览器不支持摄像头');
    err.code = 'unsupported';
    throw err;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    const e = new Error(err && err.name === 'NotAllowedError' ? '摄像头权限被拒绝' : '打不开摄像头');
    e.code = err && err.name === 'NotAllowedError' ? 'denied' : 'unavailable';
    e.raw = err;
    throw e;
  }
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  try {
    await video.play();
  } catch {
    /* 自动播放被拦：等一次用户手势即可，不阻塞 */
  }
  return { stream, video };
}

/** 每帧检测：requestVideoFrameCallback 驱动 */
export function createFrameLoop({ video, landmarker, onResult = () => {}, onError = () => {} }) {
  let running = false;
  let handle = null;
  let raf = null;

  const tick = (now, metadata) => {
    if (!running) return;
    const t0 = performance.now();
    let result = null;
    try {
      result = landmarker.detectForVideo(video, t0);
    } catch (err) {
      onError(err);
    }
    const inferMs = performance.now() - t0;
    const presented = metadata && metadata.presentationTime ? metadata.presentationTime : t0;
    onResult(result, {
      inferMs,
      latencyMs: performance.now() - presented + inferMs,
      videoTime: video.currentTime,
    });
    schedule();
  };

  const schedule = () => {
    if (!running) return;
    if (typeof video.requestVideoFrameCallback === 'function') {
      handle = video.requestVideoFrameCallback(tick);
    } else {
      raf = requestAnimationFrame((t) => tick(t, null));
    }
  };

  return {
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    stop() {
      running = false;
      if (handle !== null && typeof video.cancelVideoFrameCallback === 'function') {
        try {
          video.cancelVideoFrameCallback(handle);
        } catch {
          /* ignore */
        }
      }
      if (raf !== null) cancelAnimationFrame(raf);
      handle = null;
      raf = null;
    },
    get running() {
      return running;
    },
  };
}

/** 平均亮度（0..1）：32×18 缩略图采样，400ms 一次就够 */
export function createBrightnessProbe(video) {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 18;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let last = 0;
  let lastValue = 0.18;
  return {
    sample(now) {
      if (now - last < CAMERA.brightProbeIntervalMs) return lastValue;
      last = now;
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) {
          sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
        }
        lastValue = sum / (data.length / 4);
      } catch {
        /* 视频还没准备好 */
      }
      return lastValue;
    },
    get value() {
      return lastValue;
    },
  };
}

export { sleep };