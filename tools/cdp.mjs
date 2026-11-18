/**
 * cdp.mjs — 极简 Chrome/Edge DevTools Protocol 客户端（零依赖，用 node 自带 WebSocket）。
 *
 * 用途：起一个带 fake 摄像头的 headless 浏览器，跑真实页面，取
 * 控制台错误 / 网络请求 / FPS / 画布像素，必要时截图。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe` : '',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

export function findBrowser() {
  for (const p of BROWSERS) if (existsSync(p)) return p;
  throw new Error('找不到 Chrome / Edge，请用 --browser 指定');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data || ''}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.handlers.get(msg.method) || []) fn(msg.params);
      }
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new CDP(ws)));
      ws.addEventListener('error', (e) => reject(new Error(`WS error ${e.message || ''}`)));
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 45000);
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
    return () => {
      const list = this.handlers.get(method) || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  async eval(expression, { awaitPromise = true, returnByValue = true } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true,
      allowUnsafeEvalBlockedByCSP: false,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`page eval failed: ${d.text} ${d.exception?.description || ''}`);
    }
    return res.result?.value;
  }

  async waitFor(expression, { timeout = 15000, interval = 100 } = {}) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      try {
        if (await this.eval(expression)) return true;
      } catch { /* 页面还没就绪 */ }
      await sleep(interval);
    }
    throw new Error(`waitFor timeout: ${expression}`);
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/**
 * 启动浏览器并连接第一个页面 target。
 * @param {{port?:number, headless?:boolean, args?:string[], browser?:string}} opts
 */
export async function launch(opts = {}) {
  const port = opts.port ?? 9333;
  const browser = opts.browser || findBrowser();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'shadow-cdp-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    '--hide-scrollbars',
    '--mute-audio',
    '--window-size=1440,900',
    // 假摄像头：绿幕/彩条画面 + 自动同意权限
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // headless 下用软栈跑 WebGL2，保证 three 与 MediaPipe 都能起
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    ...(opts.extraArgs || []),
  ];
  if (opts.headless === false) args.splice(2, 1);

  const child = spawn(browser, args, { stdio: 'ignore', detached: false });

  const versionUrl = `http://127.0.0.1:${port}/json/version`;
  let info = null;
  const started = Date.now();
  while (Date.now() - started < 20000) {
    try {
      const res = await fetch(versionUrl);
      if (res.ok) { info = await res.json(); break; }
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  if (!info) throw new Error('浏览器调试端口没起来');

  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  const target = await res.json();
  const cdp = await CDP.connect(target.webSocketDebuggerUrl);

  return {
    cdp,
    browser,
    version: info.Browser,
    port,
    userDataDir,
    async close() {
      cdp.close();
      try { child.kill(); } catch { /* ignore */ }
      await sleep(300);
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

export async function screenshot(cdp, filePath) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(filePath, Buffer.from(data, 'base64'));
  return filePath;
}

export async function pngInfo(filePath) {
  const buf = await readFile(filePath);
  return { bytes: buf.length };
}