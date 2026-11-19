#!/usr/bin/env node
/**
 * server.mjs — 零依赖静态服务器（纯静态站点，不需要构建）。
 *
 *   node server.mjs                        → http://127.0.0.1:4173/
 *   node server.mjs --port 8080            → 换端口
 *   node server.mjs --host 0.0.0.0         → 局域网（手机同网段可看）
 *   node server.mjs --lan                  → 等价于 --host 0.0.0.0，并把局域网 IP 全打印出来
 *   node server.mjs --lan --tls            → https://<ip>:4443/（用 cert/bloom.pfx，手机摄像头才给开）
 *   node server.mjs --tls --pfx-pass xxx   → 换 PFX 口令（默认 bloom）
 *
 * 只做这几件事：
 *   1. 安全的路径解析 + 正确的 MIME（.wasm / .task 不能是 octet-stream）；
 *   2. 预压缩直发：磁盘上有 foo.js.br / foo.js.gz 就直接发，绝不每次请求现场压缩；
 *   3. 缓存策略：/vendor/ 一年 immutable，html/src/styles/tools 走 no-cache + ETag/304 协商；
 *   4. 可选 HTTPS（Node 原生读 pfx，不需要 openssl），给手机摄像头用。
 *
 * 依赖：只用 node: 内置模块。
 */

import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createReadStream, promises as fs, existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const argVal = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const OPT_LAN = hasFlag('--lan');
const OPT_TLS = hasFlag('--tls');

// --lan 只是把 --host 的默认值改成 0.0.0.0；显式 --host 仍然优先
const HOST = argVal('--host', OPT_LAN ? '0.0.0.0' : process.env.HOST || '127.0.0.1');
// TLS 默认 4443（避免和明文 4173 撞端口），显式 --port / PORT 仍然优先
const PORT = Number(argVal('--port', process.env.PORT || (OPT_TLS ? 4443 : 4173)));

const CERT_DIR = join(ROOT, 'cert');
const PFX_PATH = argVal('--pfx', join(CERT_DIR, 'bloom.pfx'));
const PFX_PASS = argVal('--pfx-pass', 'bloom');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.task': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.y4m': 'video/x-yuv4mpeg',
  '.mp4': 'video/mp4',
};

/** 路径穿越防护：解析后的绝对路径必须落在 ROOT 里面 */
function safePath(urlPath) {
  const decoded = decodeURIComponent((urlPath || '/').split('?')[0].split('#')[0]);
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  const abs = join(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null;
  return abs;
}

/** 磁盘相对路径（统一成 / 分隔），用来判断缓存分区 */
function relOf(absPath) {
  if (absPath === ROOT) return '';
  return absPath.slice(ROOT.length + 1).split(sep).join('/');
}

/**
 * 缓存策略：
 *   /vendor/**                → 一年 + immutable（three / mediapipe 版本号由路径固定）
 *   *.html  /src/** /styles/** /tools/** → no-cache（每次协商，命中 ETag 回 304）
 *   其他 .wasm/.task          → 一周
 *   其他                      → 一分钟
 */
function cacheControlFor(rel, ext) {
  const p = '/' + rel;
  if (p === '/vendor/' || p.startsWith('/vendor/')) return 'public, max-age=31536000, immutable';
  if (ext === '.html') return 'no-cache';
  if (p.startsWith('/src/') || p.startsWith('/styles/') || p.startsWith('/tools/')) return 'no-cache';
  if (ext === '.wasm' || ext === '.task') return 'public, max-age=604800';
  return 'public, max-age=60';
}

/** 解析 Accept-Encoding → { br: q, gzip: q }（* 当通配；q=0 视为不接受） */
function parseAcceptEncoding(header) {
  const out = { br: 0, gzip: 0 };
  const raw = String(header || '').toLowerCase();
  if (!raw) return out;
  let wildcard = 0;
  for (const part of raw.split(',')) {
    const [rawName, ...params] = part.trim().split(';');
    const name = (rawName || '').trim();
    if (!name) continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p);
      if (m) q = Number(m[1]);
    }
    if (name === 'br') out.br = q;
    else if (name === 'gzip' || name === 'x-gzip') out.gzip = q;
    else if (name === '*') wildcard = q;
  }
  if (wildcard > 0) {
    if (raw.includes('br') === false && out.br === 0) out.br = wildcard;
    if (raw.includes('gzip') === false && out.gzip === 0) out.gzip = wildcard;
  }
  return out;
}

/** 弱 ETag：内容长度 + 修改时间（毫秒），加编码后缀区分 br/gz/原文件 */
function weakEtag(stat, tag) {
  const size = stat.size.toString(16);
  const mtime = Math.floor(stat.mtimeMs).toString(16);
  return `W/"${size}-${mtime}${tag ? '-' + tag : ''}"`;
}

async function statFile(p) {
  try {
    const s = await fs.stat(p);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

/**
 * 选预压缩文件：磁盘上存在 <file>.br / <file>.gz 且客户端接受，就用它。
 * 不做现场压缩——压 wasm 一次几百毫秒，请求一多就把事件循环卡死。
 */
async function pickPrecompressed(filePath, accept) {
  const enc = parseAcceptEncoding(accept);
  if (enc.br > 0) {
    const s = await statFile(filePath + '.br');
    if (s) return { filePath: filePath + '.br', stat: s, encoding: 'br', tag: 'br' };
  }
  if (enc.gzip > 0) {
    const s = await statFile(filePath + '.gz');
    if (s) return { filePath: filePath + '.gz', stat: s, encoding: 'gzip', tag: 'gz' };
  }
  return null;
}

/** 把文件流安全地送出去：客户端中途取消也不会把进程带崩 */
async function sendFile(res, filePath, opts) {
  try {
    await pipeline(createReadStream(filePath, opts), res);
  } catch (err) {
    if (err && (err.code === 'ERR_STREAM_PREMATURE_CLOSE' || err.code === 'ECONNRESET' || err.code === 'EPIPE')) return;
    console.error('[bloom] 发送失败', err && err.message);
    if (!res.headersSent) res.writeHead(500);
    res.destroy();
  }
}

/** 304 判定：If-None-Match 优先，没有才看 If-Modified-Since（秒级截断） */
function isNotModified(req, etag, stat) {
  const inm = req.headers['if-none-match'];
  if (inm) {
    const list = String(inm)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.includes('*')) return true;
    // 弱比较：W/"x"、"x"、W/x 都当同一个（有些客户端/代理会把引号吃掉）
    const norm = (s) => s.trim().replace(/^W\//i, '').replace(/^"|"$/g, '').trim();
    const mine = norm(etag);
    return list.some((t) => t === etag || norm(t) === mine);
  }
  const ims = req.headers['if-modified-since'];
  if (ims) {
    const since = Date.parse(ims);
    if (!Number.isNaN(since)) {
      const mtimeSec = Math.floor(stat.mtimeMs / 1000) * 1000;
      return mtimeSec <= since;
    }
  }
  return false;
}

async function handle(req, res) {
  const started = Date.now();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }
  try {
    let filePath = safePath(req.url);
    if (!filePath) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }
    let stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = join(filePath, 'index.html');
      stat = await fs.stat(filePath);
    }
    const ext = extname(filePath).toLowerCase();
    const rel = relOf(filePath);
    const cacheControl = cacheControlFor(rel, ext);

    // Range 请求直接走原文件（媒体/大文件分块不要和 Content-Encoding 混）
    const wantRange = Boolean(req.headers.range);
    const enc = wantRange ? null : await pickPrecompressed(filePath, req.headers['accept-encoding']);
    const served = enc ? enc.stat : stat;
    const etag = weakEtag(served, enc ? enc.tag : '');

    const baseHeaders = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl,
      ETag: etag,
      'Last-Modified': served.mtime.toUTCString(),
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Accept-Encoding',
    };

    if (isNotModified(req, etag, served)) {
      res.writeHead(304, baseHeaders);
      res.end();
      return;
    }

    if (enc) {
      res.writeHead(200, {
        ...baseHeaders,
        'Content-Encoding': enc.encoding,
        'Content-Length': served.size,
      });
      if (req.method === 'HEAD') return res.end();
      await sendFile(res, enc.filePath);
      return;
    }

    const headers = {
      ...baseHeaders,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
    };

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Number(m[2]) : stat.size - 1;
        if (start <= end && end < stat.size) {
          res.writeHead(206, {
            ...headers,
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          });
          if (req.method === 'HEAD') return res.end();
          await sendFile(res, filePath, { start, end });
          return;
        }
      }
    }

    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    await sendFile(res, filePath);
  } catch (err) {
    if (err && err instanceof URIError) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('400 Bad Request: 路径里的 % 编码不对');
    } else if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + (req.url || ''));
    } else {
      console.error('[bloom]', err);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500 Internal Server Error');
    }
  } finally {
    if (process.env.LOG !== '0') {
      console.log(`${req.method} ${req.url} → ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
}

/** 所有非内部回环的 IPv4（给手机用的那些地址） */
function lanIPv4() {
  const found = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) found.push({ name, address: ni.address });
    }
  }
  return found;
}

async function main() {
  let server;
  const scheme = OPT_TLS ? 'https' : 'http';

  if (OPT_TLS) {
    if (!existsSync(PFX_PATH)) {
      console.error('');
      console.error('  [bloom] 找不到证书：' + PFX_PATH);
      console.error('  --tls 需要 PKCS#12 证书。二选一：');
      console.error('    1) 局域网自签名（推荐，本机跑）：');
      console.error('         powershell -File tools/tls-cert.ps1');
      console.error('    2) 已有证书（阿里云/腾讯云下载的 .pfx）放到 cert/bloom.pfx，');
      console.error('       口令不同的加上：node server.mjs --tls --pfx-pass <口令>');
      console.error('  证书缺失时不会回落 http —— http 下手机浏览器会拒绝摄像头。');
      console.error('');
      process.exit(1);
    }
    let pfx;
    try {
      pfx = await fs.readFile(PFX_PATH);
    } catch (err) {
      console.error(`  [bloom] 证书读取失败：${PFX_PATH} — ${err && err.message}`);
      process.exit(1);
    }
    try {
      server = createHttpsServer({ pfx, passphrase: PFX_PASS }, (req, res) => {
        handle(req, res);
      });
    } catch (err) {
      console.error(`  [bloom] 证书加载失败（口令错了？默认口令 bloom）：${err && err.message}`);
      process.exit(1);
    }
    server.on('tlsClientError', (err) => {
      // 手机点「继续访问」前会有握手噪音，忽略
      if (process.env.LOG !== '0' && process.env.LOG_TLS === '1') console.error('[bloom] tls', err && err.message);
    });
  } else {
    server = createServer((req, res) => {
      handle(req, res);
    });
  }

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${PORT} 已被占用，换一个：node server.mjs --port ${PORT + 1}${OPT_TLS ? ' --tls' : ''}`);
      process.exit(1);
    }
    if (err.code === 'EACCES') {
      console.error(`端口 ${PORT} 被系统拒绝（<1024 需要管理员）。换一个：node server.mjs --port 8443${OPT_TLS ? ' --tls' : ''}`);
      process.exit(1);
    }
    throw err;
  });

  // 浏览器中途刷新/取消下载时不要带崩整个进程
  process.on('uncaughtException', (err) => {
    console.error('[bloom] 未捕获异常（已忽略）', err && err.message);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[bloom] 未处理的 Promise 拒绝（已忽略）', err && err.message);
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  server.listen(PORT, HOST, () => {
    const lan = lanIPv4();
    const wildcard = HOST === '0.0.0.0' || HOST === '::';
    const loop = wildcard ? '127.0.0.1' : HOST;

    console.log('');
    console.log('  指尖生花 / BLOOM AT YOUR FINGERTIPS');
    console.log(`  → ${scheme}://${loop}:${PORT}/`);
    if (wildcard) {
      for (const { name, address } of lan) {
        console.log(`  → ${scheme}://${address}:${PORT}/`);
      }
      if (!lan.length) console.log('  （没扫到局域网 IPv4：这台机器当前没连 Wi-Fi/网线）');
      console.log(`  · 已监听 ${HOST}:${PORT}（网卡：${lan.map((n) => n.name).join(', ') || '无'}）`);
      console.log('  · 手机要和电脑同一个 Wi-Fi（同一个路由器、同一网段）');
    } else if (OPT_LAN) {
      console.log(`  · --lan 已生效但 --host 覆盖成了 ${HOST}，只有这台机器能访问`);
    }
    if (OPT_TLS) {
      console.log('  · HTTPS 是自签名证书：手机上要点「高级 → 继续访问」，');
      console.log('    点了之后摄像头才能开（不信任的证书浏览器不给 getUserMedia）。');
    } else if (wildcard) {
      console.log('  · 注意：手机用 http:// 访问时浏览器多半不给摄像头，要开摄像头请加 --tls');
    }
    console.log(`  → ${scheme}://${loop}:${PORT}/?demo=1    自动循环四种交互（录屏用）`);
    console.log(`  → ${scheme}://${loop}:${PORT}/?debug=1    FPS / 延迟 / 骨架 / 触发半径`);
    console.log(`  → ${scheme}://${loop}:${PORT}/?pointer=1  直接进指针模式`);
    console.log('  · 预压缩：磁盘上有 .br/.gz 就直接发（先跑 node tools/pack.mjs 生成）');
    console.log('  Ctrl+C 停止');
    console.log('');
  });
}

main();