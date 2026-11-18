#!/usr/bin/env node
/**
 * PALM COSMOS — 零依赖静态服务器
 * 用法：node server.mjs [--port 4173] [--host 127.0.0.1]
 * 默认：http://127.0.0.1:4173/
 */
import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, constants as zc } from 'node:zlib';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const HOST = argVal('--host', process.env.HOST || '127.0.0.1');
const PORT = Number(argVal('--port', process.env.PORT || 4173));

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
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function safePath(urlPath) {
  const decoded = decodeURIComponent((urlPath || '/').split('?')[0].split('#')[0]);
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  const abs = join(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null;
  return abs;
}

/* 大文件压缩（wasm / task 17MB → 4MB 左右），带内存缓存，只压一次。 */
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.task', '.wasm', '.txt', '.md']);
const compressed = new Map(); // key → { buf, encoding }
const CACHE_LIMIT = 24;

async function encodedBody(filePath, stat, ext, accept) {
  if (!COMPRESSIBLE.has(ext) || stat.size < 1024) return null;
  if (!/\b(br|gzip)\b/.test(accept || '')) return null;
  const encoding = /\bbr\b/.test(accept) ? 'br' : 'gzip';
  const key = `${filePath}:${stat.size}:${stat.mtimeMs}:${encoding}`;
  const hit = compressed.get(key);
  if (hit) return hit;
  const raw = await fs.readFile(filePath);
  const buf =
    encoding === 'br'
      ? brotliCompressSync(raw, {
          params: { [zc.BROTLI_PARAM_QUALITY]: 5, [zc.BROTLI_PARAM_SIZE_HINT]: raw.length },
        })
      : gzipSync(raw, { level: 6 });
  const entry = { buf, encoding };
  if (compressed.size >= CACHE_LIMIT) compressed.clear();
  compressed.set(key, entry);
  return entry;
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  let filePath = safePath(req.url);
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    let stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      filePath = join(filePath, 'index.html');
      stat = await fs.stat(filePath);
    }

    const ext = extname(filePath).toLowerCase();
    const longLived = ext === '.wasm' || ext === '.task';
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': longLived
        ? 'public, max-age=604800'
        : ext === '.html'
          ? 'no-cache'
          : 'public, max-age=120',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes',
      Vary: 'Accept-Encoding',
    };

    // 压缩版本（无 Range 支持；媒体播放走原文件）
    const enc = await encodedBody(filePath, stat, ext, req.headers['accept-encoding']);
    if (enc) {
      delete headers['Accept-Ranges'];
      res.writeHead(200, {
        ...headers,
        'Content-Encoding': enc.encoding,
        'Content-Length': enc.buf.length,
      });
      if (req.method === 'HEAD') return res.end();
      res.end(enc.buf);
      return;
    }

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
          createReadStream(filePath, { start, end }).pipe(res);
          return;
        }
      }
    }

    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    createReadStream(filePath).pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + (req.url || ''));
    } else {
      console.error('[palm-cosmos]', err);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500 Internal Server Error');
    }
  } finally {
    const ms = Date.now() - started;
    if (process.env.LOG !== '0') console.log(`${req.method} ${req.url} → ${res.statusCode} ${ms}ms`);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用。换一个端口：node server.mjs --port 4174\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  PALM COSMOS / 掌心宇宙');
  console.log(`  → http://${HOST}:${PORT}/`);
  console.log(`  → http://${HOST}:${PORT}/?demo=1   (自动循环，录屏用)`);
  console.log('  Ctrl+C 停止\n');
});