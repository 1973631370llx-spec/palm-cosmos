/** MediaPipe HandLandmarker 本地封装（双手中）。
 * 识别跑在 Worker 里（传 ImageBitmap），主线程只做渲染 → 动得快也不卡。
 * 若 Worker 初始化失败，自动退回主线程同步识别。
 * 画面只在本机处理：不上传、不录制、不写盘。
 */
import { CONFIG } from './config.js';
import { clamp } from './utils.js';

const SORT_KEY = (h) => {
  const lm = h.landmarks;
  return 1 - (lm[0].x + lm[9].x) * 0.5; // 镜像后的屏幕 x，左 → 右
};

export class HandTracker {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.worker = null;
    this.landmarker = null;
    this.running = false;
    this.mode = 'idle'; // worker | main
    this.delegate = '—';
    this.error = null;

    this.lastHands = [];
    this.lastSeen = 0;
    this.videoFrame = 0;
    this.videoFrameAt = 0;
    this._rvfcOn = false;
    this._rvfcId = 0;

    this.lastDetectMs = 0;
    this.latencyMs = 0;
    this._pending = false;
        this._frameId = 0;
        this._sentAt = 0;
        this._lastTs = 0;
        this.sent = 0;
        this.results = 0;
        this.avgDetect = 0;
        this._watchdog = 0;
        this.fallbackReason = null;
  }

  async start(opts = {}) {
    if (this.running) return true;
    this.error = null;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('浏览器不支持摄像头（需要 https 或 localhost）');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: CONFIG.hand.video.width },
        height: { ideal: CONFIG.hand.video.height },
        frameRate: { ideal: 30, max: 30 },
      },
    });
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    // 画面通了就先让场景出来，模型继续在后台加载（onCamera 由调用方关面板）
    try {
      opts.onCamera?.();
    } catch (e) {
      /* 调用方自己的 UI 逻辑，不影响识别 */
    }

    // 预载还在跑就等它（同一批字节，不重复下载）
    if (this._preloadPromise && !this._assets) {
      await this._preloadPromise.catch(() => {});
    }

    await this._startMainThread();
    // 主线程拿到 GPU 就用主线程（640×360 约 6–9ms）；只有退回 CPU 才把识别挪进 Worker。
    if (!this.landmarker && !this.worker) throw new Error(this.error || '识别器初始化失败');

    this.running = true;
    this._rvfcOn = true;
    if (typeof this.video.requestVideoFrameCallback === 'function') {
      const onFrame = (now) => {
        this.videoFrame++;
        this.videoFrameAt = now;
        if (this.mode === 'worker') this._grabFrame(now);
        if (this._rvfcOn) this._rvfcId = this.video.requestVideoFrameCallback(onFrame);
      };
      this._rvfcId = this.video.requestVideoFrameCallback(onFrame);
    }
    return true;
  }

  /** 预载 wasm + 模型字节：下载一次就留在内存里，点开始直接喂给 MediaPipe。
   * 公网走镜像（阿里 npm 镜像 + Google 模型源，实测 3–6MB/s）；本机走 vendor/ + 本地 gzip。 */
  preload(onProgress) {
    if (this._assets?.task) return Promise.resolve(true);
    if (this._preloadPromise) return this._preloadPromise;
    this._preloadCtl = new AbortController();
    const signal = this._preloadCtl.signal;
    const cdn = CONFIG.hand.useCdn;
    const base = cdn
      ? [`${CONFIG.hand.cdnWasm}/vision_wasm_internal.wasm`, CONFIG.hand.cdnModel]
      : [
          new URL('../vendor/mediapipe/wasm/vision_wasm_internal.wasm', import.meta.url).href,
          new URL('../vendor/mediapipe/hand_landmarker.task', import.meta.url).href,
        ];
    // 本地能解压就下 .gz（Safari 16.4+ / Chrome 全支持）；CDN 自带压缩，直接下原件
    const codec = !cdn && (() => {
      for (const c of ['brotli', 'gzip']) {
        try {
          new DecompressionStream(c);
          return c;
        } catch (e) {
          /* next */
        }
      }
      return null;
    })();
    const suffix = codec === 'brotli' ? '.br' : codec === 'gzip' ? '.gz' : '';

    const fetchBytes = async (url, onBytes) => {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`preload ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      if (!res.body) {
        const buf = await res.arrayBuffer();
        onBytes(buf.byteLength);
        return new Uint8Array(buf);
      }
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.byteLength;
        onBytes(value.byteLength, total);
      }
      const out = new Uint8Array(got);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.byteLength;
      }
      return out;
    };

    const load = async (url, onBytes) => {
      if (suffix) {
        try {
          const packed = await fetchBytes(`${url}${suffix}`, onBytes);
          const raw = await new Response(
            new Blob([packed]).stream().pipeThrough(new DecompressionStream(codec))
          ).arrayBuffer();
          return new Uint8Array(raw);
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
        }
      }
      return fetchBytes(url, () => {});
    };

    this._preloadPromise = (async () => {
      try {
        const heads = await Promise.all(
          base.map((u) =>
            fetch(`${u}${suffix}`, { method: 'HEAD', signal })
              .then((r) => (r.ok ? Number(r.headers.get('content-length')) || 0 : 0))
              .catch(() => 0)
          )
        );
        const total = heads.reduce((a, b) => a + b, 0) || 1;
        let done = 0;
        const step = (bytes) => {
          done += bytes;
          onProgress?.(Math.min(0.995, done / total));
        };
        const [wasm, task] = await Promise.all(base.map((u) => load(u, step)));
        this._assets = {
          wasmUrl: URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' })),
          task,
          packed: !!suffix,
        };
        onProgress?.(1);
        return true;
      } catch (err) {
        this._assets = null;
        onProgress?.(-1);
        return false;
      }
    })();
    return this._preloadPromise;
  }

  /** 兼容旧调用：预载不再需要用户中断（start 会直接复用它的结果）。 */
  abortPreload() {
    this._preloadCtl = null;
  }

  async _startWorker() {
    if (typeof Worker === 'undefined' || typeof createImageBitmap !== 'function') return false;
    try {
      const worker = new Worker(new URL('./hand-worker.js', import.meta.url), { type: 'module' });
      const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker init timeout')), 15000);
        worker.onmessage = (e) => {
          const m = e.data;
          if (m.type === 'ready') {
            clearTimeout(timer);
            this.delegate = m.delegate;
            resolve(true);
          } else if (m.type === 'error') {
            clearTimeout(timer);
            reject(new Error(m.error));
          }
        };
        worker.onerror = (e) => {
          clearTimeout(timer);
          reject(new Error(e.message || 'worker error'));
        };
        worker.postMessage({
          type: 'init',
          wasmPath: new URL('../vendor/mediapipe/wasm', import.meta.url).href,
          modelPath: new URL('../vendor/mediapipe/hand_landmarker.task', import.meta.url).href,
          numHands: 2,
          delegate: CONFIG.hand.workerDelegate || 'GPU',
        });
      });
      if (!ready) throw new Error('worker not ready');

      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'log') {
          console.info('[hand-worker]', m.msg);
          return;
        }
        if (m.type !== 'result') return;
        this._pending = false;
        this.results++;
        this.lastDetectMs = m.ms || 0;
        this.avgDetect = this.avgDetect * 0.85 + this.lastDetectMs * 0.15;
        this.latencyMs = performance.now() - this._sentAt;
        this.lastHands = (m.hands || []).sort((a, b) => SORT_KEY(a) - SORT_KEY(b));
        if (this.lastHands.length) this.lastSeen = performance.now();
        if (m.error) this.error = m.error;
      };
      this.worker = worker;
      this.mode = 'worker';
      this.delegate = `${this.delegate}+worker`;
      return true;
    } catch (err) {
      this.error = err?.message || String(err);
      this.worker?.terminate?.();
      this.worker = null;
      return false;
    }
  }

  /** 载入 MediaPipe 运行库：公网先试镜像，失败退回本地 vendor/。 */
  async _loadVision() {
    if (CONFIG.hand.useCdn) {
      try {
        return await import(CONFIG.hand.visionBundle);
      } catch (err) {
        this.fallbackReason = 'vision cdn';
      }
    }
    return import('../vendor/mediapipe/vision_bundle.mjs');
  }

  async _startMainThread() {
    const vision = await this._loadVision();
    const cdn = CONFIG.hand.useCdn && vision !== undefined;
    this.source = cdn ? 'cdn' : 'local';

    const build = async (useCdn) => {
      const basePath = useCdn ? CONFIG.hand.cdnWasm : new URL('../vendor/mediapipe/wasm', import.meta.url).href;
      const fileset = await vision.FilesetResolver.forVisionTasks(basePath);
      const modelPath = useCdn
        ? CONFIG.hand.cdnModel
        : new URL('../vendor/mediapipe/hand_landmarker.task', import.meta.url).href;
      // 预载过了就直接用内存里的字节：省掉一次 8–12MB 的下载
      if (this._assets?.wasmUrl) fileset.wasmBinaryPath = this._assets.wasmUrl;
      const opts = (delegate) => ({
        baseOptions: {
          delegate,
          ...(this._assets?.task ? { modelAssetBuffer: this._assets.task } : { modelAssetPath: modelPath }),
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.4,
      });
      try {
        this.landmarker = await vision.HandLandmarker.createFromOptions(fileset, opts('GPU'));
        this.delegate = 'GPU';
      } catch (err) {
        this.landmarker = await vision.HandLandmarker.createFromOptions(fileset, opts('CPU'));
        this.delegate = 'CPU';
      }
    };

    try {
      await build(cdn);
    } catch (err) {
      if (!cdn) throw err;
      // 镜像挂了：退回本地 vendor/（慢，但一定能开）
      this.fallbackReason = 'asset cdn';
      this.source = 'local-fallback';
      await build(false);
    }

    this.mode = 'main';
    if (this.delegate !== 'GPU' && CONFIG.hand.useWorker) {
      const moved = await this._startWorker();
      if (moved) {
        try {
          this.landmarker.close();
        } catch (e) {
          /* noop */
        }
        this.landmarker = null;
      }
    }
  }

  async _grabFrame(now) {
    if (this._pending) return;
    this._pending = true;
    this._sentAt = now;
    const id = ++this._frameId;
    this.sent++;
    try {
      const bitmap = await createImageBitmap(this.video);
      const ts = Math.max(this._lastTs + 1, Math.round(performance.now()));
      this._lastTs = ts;
      this.worker.postMessage({ type: 'frame', id, bitmap, ts }, [bitmap]);
      if (!this._watchdog && this.results === 0) {
        this._watchdog = setTimeout(() => {
          if (this.results === 0 && this.mode === 'worker') {
            this.fallbackReason = 'worker no result';
            this._fallbackToMain();
          }
        }, CONFIG.hand.watchdogMs || 2500);
      }
    } catch (err) {
      this._pending = false;
      this.error = err?.message || String(err);
    }
  }

  /** Worker 卡死时回退到主线程 GPU（一次性）。 */
  async _fallbackToMain() {
    clearTimeout(this._watchdog);
    this._watchdog = 0;
    this.mode = 'idle';
    this._pending = false;
    try {
      this.worker?.terminate();
    } catch (e) {
      /* noop */
    }
    this.worker = null;
    try {
      await this._startMainThread();
      this._rvfcOn = true;
    } catch (err) {
      this.error = err?.message || String(err);
    }
  }

  /** 主线程同步识别（Worker 不可用时的退路）。返回 hands 数组。 */
  _detectMain(now) {
    if (!this.landmarker) return this.lastHands;
    if (this.videoFrame === 0 && this.video.currentTime === this._lastVideoTime) return this.lastHands;
    this._lastVideoTime = this.video.currentTime;

    const ts = Math.max(this._lastTs + 1, Math.round(now));
    this._lastTs = ts;
    const t0 = performance.now();
    try {
      const res = this.landmarker.detectForVideo(this.video, ts);
      this.lastDetectMs = performance.now() - t0;
      this.latencyMs = this.lastDetectMs;
      const hands = (res?.landmarks || []).map((lm, i) => ({
        landmarks: lm,
        worldLandmarks: res.worldLandmarks?.[i] || null,
        handedness: (res.handednesses || res.handedness)?.[i]?.[0]?.categoryName || null,
      }));
      this.lastHands = hands.sort((a, b) => SORT_KEY(a) - SORT_KEY(b));
      if (hands.length) this.lastSeen = now;
    } catch (err) {
      this.error = err?.message || String(err);
    }
    return this.lastHands;
  }

  /** 当前双手（最多 2），已按镜像后的屏幕位置左→右排序。 */
  hands(now) {
    if (!this.running) return [];
    if (this.mode === 'main') this._detectMain(now);
    const fresh = now - this.lastSeen < 600;
    return fresh ? this.lastHands : [];
  }

  age(now) {
    return now - this.lastSeen;
  }

  stop() {
    this.running = false;
    this._rvfcOn = false;
    if (this._rvfcId && this.video?.cancelVideoFrameCallback) {
      try {
        this.video.cancelVideoFrameCallback(this._rvfcId);
      } catch (e) {
        /* noop */
      }
      this._rvfcId = 0;
    }
    if (this.worker) {
      clearTimeout(this._watchdog);
      try {
        this.worker.postMessage({ type: 'close' });
        this.worker.terminate();
      } catch (e) {
        /* noop */
      }
      this.worker = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    if (this.landmarker) {
      try {
        this.landmarker.close();
      } catch (e) {
        /* noop */
      }
      this.landmarker = null;
    }
    if (this.video) this.video.srcObject = null;
  }
}

/** 手掌开合度：0 = 拳，1 = 全开。用指尖 / 掌心比例，对距离不敏感。 */
export function computeOpenness(lm) {
  if (!lm || lm.length < 21) return null;
  const wrist = lm[0];
  const palm = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) + 0.0001;
  const tips = [8, 12, 16, 20];
  let sum = 0;
  for (const i of tips) {
    sum += Math.hypot(lm[i].x - wrist.x, lm[i].y - wrist.y) / palm;
  }
  const avg = sum / tips.length;
  const thumb = Math.hypot(lm[4].x - wrist.x, lm[4].y - wrist.y) / palm;

  const fingerOpen = clamp((avg - 1.22) / (1.62 - 1.22), 0, 1);
  const thumbOpen = clamp((thumb - 0.9) / (1.12 - 0.9), 0, 1);
  return clamp(fingerOpen * 0.88 + thumbOpen * 0.12, 0, 1);
}

/** 捏合：拇指尖 4 与食指尖 8 的距离 / 掌心宽度。越小越像捏。 */
export function computePinch(lm) {
  if (!lm || lm.length < 21) return 1;
  const palm = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) + 0.0001;
  const d = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y) / palm;
  return clamp(d, 0, 2);
}

/** 食指单指（point）：食指伸展，其余三指蜷起。 */
export function computePoint(lm) {
  if (!lm || lm.length < 21) return false;
  const wrist = lm[0];
  const palm = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) + 0.0001;
  const ext = (tip, pip) =>
    Math.hypot(lm[tip].x - wrist.x, lm[tip].y - wrist.y) / palm >
    Math.hypot(lm[pip].x - wrist.x, lm[pip].y - wrist.y) / palm;

  const index = ext(8, 6);
  const middle = ext(12, 10);
  const ring = ext(16, 14);
  const pinky = ext(20, 18);
  return index && !middle && !ring && !pinky;
}

/** 掌面几何：宽度、倾角、z 深度。坐标为 MediaPipe 归一化坐标（未镜像）。 */
export function palmMetrics(lm) {
  const thumbBase = lm[1];
  const indexMcp = lm[5];
  const middleMcp = lm[9];
  const pinkyMcp = lm[17];

  const width = Math.hypot(indexMcp.x - pinkyMcp.x, indexMcp.y - pinkyMcp.y);
  const roll = Math.atan2(pinkyMcp.y - indexMcp.y, pinkyMcp.x - indexMcp.x);
  const depth = middleMcp.z;
  const yaw = (indexMcp.z - pinkyMcp.z) * 4.2;
  const pitch = (thumbBase.z - middleMcp.z) * 3.4;

  return {
    width,
    roll,
    depth,
    yaw,
    pitch,
    anchor: {
      x: (lm[0].x + lm[9].x) * 0.5,
      y: (lm[0].y + lm[9].y) * 0.5,
    },
  };
}

export const LANDMARKS = {
  wrist: 0,
  thumbTip: 4,
  indexTip: 8,
  middleTip: 12,
  ringTip: 16,
  pinkyTip: 20,
};

export const HAND_BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];