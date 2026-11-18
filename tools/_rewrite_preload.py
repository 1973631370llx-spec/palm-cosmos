import io, re
p = 'js/hands.js'
s = io.open(p, encoding='utf-8').read()
start = s.index('  /** 预载 wasm + 模型字节')
end = s.index('  /** 兼容旧调用')
new = '''  /** 预载 wasm + 模型字节：下载一次就留在内存里，点开始直接喂给 MediaPipe。
   * 每个资源都备多个来源（阿里 npm 镜像 / Google 模型源 / 本站 gz），2.5 秒没下完就并行开备胎，谁先到用谁。 */
  preload(onProgress) {
    if (this._assets?.task) return Promise.resolve(true);
    if (this._preloadPromise) return this._preloadPromise;
    const cdn = CONFIG.hand.useCdn;
    const localWasm = new URL('../vendor/mediapipe/wasm/vision_wasm_internal.wasm', import.meta.url).href;
    const localTask = new URL('../vendor/mediapipe/hand_landmarker.task', import.meta.url).href;

    // 能解压就下 .gz（Safari 16.4+ / Chrome 全支持）
    const codec = (() => {
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

    const WASM_RAW = 11153617;
    const TASK_RAW = 7819105;
    const wasmSources = cdn
      ? [`${CONFIG.hand.cdnWasm}/vision_wasm_internal.wasm`, localWasm + suffix]
      : [localWasm + suffix, localWasm];
    const taskSources = cdn ? [CONFIG.hand.cdnModel, localTask + suffix] : [localTask + suffix, localTask];
    const estimate = (url, raw) => (suffix && url.endsWith(suffix) ? raw * 0.34 : raw);

    const decode = async (packed, bytes) => {
      if (!packed) return bytes;
      const raw = await new Response(
        new Blob([bytes]).stream().pipeThrough(new DecompressionStream(codec))
      ).arrayBuffer();
      return new Uint8Array(raw);
    };

    // 逐块读流，边下边报字节
    const streamFrom = async (url, onBytes, signal) => {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`preload ${res.status}`);
      const packed = !!suffix && url.endsWith(suffix);
      if (!res.body) {
        const buf = new Uint8Array(await res.arrayBuffer());
        onBytes(buf.byteLength);
        return decode(packed, buf);
      }
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.byteLength;
        onBytes(value.byteLength);
      }
      const out = new Uint8Array(got);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.byteLength;
      }
      return decode(packed, out);
    };

    /** 多源竞速：先跑第一个，2.5 秒后把备胎也放出去，第一个完成的胜出。 */
    const race = (urls, onBytes) =>
      new Promise((resolve, reject) => {
        let settled = false;
        let failed = 0;
        let timer = null;
        const controllers = [];
        const launch = (url, i) => {
          const ctl = new AbortController();
          controllers.push(ctl);
          const est = estimate(url, i === urls.length - 1 && !cdn ? TASK_RAW : WASM_RAW);
          streamFrom(url, (n) => onBytes(i, n, est), ctl.signal).then(
            (bytes) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              controllers.forEach((c) => c.abort());
              resolve(bytes);
            },
            (err) => {
              if (settled) return;
              failed++;
              if (failed >= urls.length) {
                settled = true;
                clearTimeout(timer);
                controllers.forEach((c) => c.abort());
                reject(err);
              }
            }
          );
        };
        launch(urls[0], 0);
        timer = setTimeout(() => {
          if (settled) return;
          urls.slice(1).forEach((u, k) => launch(u, k + 1));
        }, 2500);
      });

    this._preloadPromise = (async () => {
      try {
        // 进度：两件资源各自已收字节 / 估算大小，取较小的那个（都要下完才算好）
        const got = [
          { bytes: 0, est: estimate(wasmSources[0], WASM_RAW) },
          { bytes: 0, est: estimate(taskSources[0], TASK_RAW) },
        ];
        const report = () => {
          const a = Math.min(1, got[0].bytes / got[0].est);
          const b = Math.min(1, got[1].bytes / got[1].est);
          onProgress?.(Math.min(0.995, (a + b) / 2));
        };
        const track = (slot) => (i, n, est) => {
          got[slot].bytes += n;
          if (est) got[slot].est = est;
          report();
        };

        const [wasm, task] = await Promise.all([
          race(wasmSources, track(0)),
          race(taskSources, track(1)),
        ]);
        this._assets = {
          wasmUrl: URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' })),
          task,
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

'''
s = s[:start] + new + s[end:]
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('rewritten')
