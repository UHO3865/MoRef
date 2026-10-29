// 127.0.0.1 전용 스트리밍 프록시.
// <video> 와 ffmpeg 가 같은 URL 로 NAS 영상을 읽도록, 인증 헤더와 Range 를 대신 처리한다.
//   /<token>/s/<sourceId>/<rel path>   소스 안의 파일
//   /<token>/f/<absolute path>         보드에 직접 끌어다 놓은 로컬 파일
const { tr } = require('./i18n');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sources = require('./sources');

const token = crypto.randomBytes(16).toString('hex');
let base = '';

// Chromium 이 .mov/.mkv 도 재생을 시도하도록 MIME 을 맞춰 준다 (H.264/H.265 + AAC 면 대부분 재생됨).
const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4',
  '.webm': 'video/webm', '.mkv': 'video/webm',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
};
const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

function serveFile(req, res, full) {
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404).end();
      return;
    }
    const headers = { 'Content-Type': mimeOf(full), 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let start = 0;
    let end = st.size - 1;
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = Number(m[1]);
        if (m[2]) end = Math.min(Number(m[2]), end);
      } else {
        start = Math.max(0, st.size - Number(m[2]));
      }
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
        return;
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      res.writeHead(206, { ...headers, 'Content-Length': end - start + 1 });
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
    }
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(full, { start, end });
    stream.pipe(res);
    res.on('close', () => stream.destroy());
  });
}

// NAS 에서는 4MB 씩 짧게 받아 바로 메모리로 읽고, 그다음 요청에 같은 연결을 다시 쓴다.
// 어떤 NAS 는 로그인한 연결을 한 번에 하나만 받아서(두 번째 연결은 첫 연결이 닫힐 때까지 기다림),
// 받는 쪽(<video>, ffmpeg)이 천천히 읽으며 연결을 붙잡고 있으면 다른 요청이 수십 초씩 멈춘다.
//  * 화면(<video>): 요청한 범위의 첫 조각만 돌려준다. 나머지는 브라우저가 이어서 다시 요청한다.
//  * 그 밖(ffmpeg 등): 조각을 이어 붙여 요청한 범위를 통째로 돌려준다 (조각 사이에 연결은 비어 있다).
//    ffmpeg 는 썸네일 하나에 필요한 양(색인 + 프레임 몇 개)보다 훨씬 많이 미리 읽어 버려서, 조각을 작게 한다.
//    1GB 영상 측정: 4MB 조각이면 썸네일 하나에 20~40MB, 1MB 면 7~16MB (속도는 같음). 256KB 는 요청이 많아 오히려 느렸다.
const CHUNK = 4 * 1024 * 1024;
const CHUNK_FFMPEG = 1024 * 1024;

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const parts = [];
    stream.on('data', (d) => parts.push(d));
    stream.on('end', () => resolve(Buffer.concat(parts)));
    stream.on('error', reject);
  });
}

async function fetchChunk(src, rel, start, end, size) {
  const last = Math.min(end, start + size - 1);
  const get = async () => {
    const up = await sources.davRequest(src, 'GET', rel, { headers: { Range: `bytes=${start}-${Number.isFinite(last) ? last : ''}` } });
    return { status: up.statusCode, headers: up.headers, body: await readAll(up) };
  };
  try {
    return await get();
  } catch {
    return get(); // NAS 가 쉬던 연결을 막 닫은 순간이면 한 번 더
  }
}

async function serveDav(req, res, src, rel) {
  const out = { 'Content-Type': mimeOf(rel), 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
  // 화면 밖으로 나간 영상의 정지 화면을 캔버스로 저장하려면 CORS 허용이 필요하다 (Access-Control-Allow-Origin)
  const copy = (h) => {
    for (const k of ['last-modified', 'etag']) if (h[k]) out[k] = h[k];
  };
  try {
    if (req.method === 'HEAD') {
      const up = await sources.davRequest(src, 'HEAD', rel);
      up.resume();
      for (const k of ['content-length', 'last-modified', 'etag']) if (up.headers[k]) out[k] = up.headers[k];
      res.writeHead(up.statusCode, out).end();
      return;
    }
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const partial = !!m;
    const start = m ? Number(m[1]) : 0;
    let end = m && m[2] !== '' ? Number(m[2]) : Infinity;
    const browser = /Chrome\//.test(req.headers['user-agent'] || '');
    const size = browser ? CHUNK : CHUNK_FFMPEG;
    const first = await fetchChunk(src, rel, start, end, size);
    copy(first.headers);
    if (first.status === 200) {
      // NAS 가 범위를 무시하고 파일 전체를 보냈다 (작은 파일)
      res.writeHead(200, { ...out, 'Content-Length': first.body.length }).end(first.body);
      return;
    }
    if (first.status !== 206) {
      res.writeHead(first.status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(first.body);
      return;
    }
    const total = Number(/\/(\d+)$/.exec(first.headers['content-range'] || '')?.[1]);
    if (!Number.isFinite(total)) throw new Error('Content-Range 없음');
    end = Math.min(end, total - 1);
    if (browser) end = start + first.body.length - 1; // 화면: 첫 조각만
    const len = end - start + 1;
    res.writeHead(partial ? 206 : 200, {
      ...out,
      'Content-Length': len,
      ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
    });
    let closed = false;
    res.on('close', () => (closed = true));
    let pos = start;
    let body = first.body.subarray(0, len);
    for (;;) {
      if (!res.write(body)) await new Promise((r) => res.once('drain', r).once('close', r));
      pos += body.length;
      if (pos > end || closed) break;
      const next = await fetchChunk(src, rel, pos, end, size);
      if (next.status !== 206 || !next.body.length) throw new Error(tr('NAS 응답 {0}', next.status));
      body = next.body.subarray(0, end - pos + 1);
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }).end(e.message);
    else res.destroy();
  }
}

function handler(req, res) {
  const parts = req.url.split('?')[0].split('/'); // ['', token, kind, ...]
  if (parts[1] !== token) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (parts[2] === 's') {
      const src = sources.getSource(decodeURIComponent(parts[3] || ''));
      if (!src) return res.writeHead(404).end();
      const rel = parts.slice(4).map(decodeURIComponent).join('/');
      if (src.type === 'dav') return serveDav(req, res, src, rel);
      return serveFile(req, res, sources.localFullPath(src, rel));
    }
    if (parts[2] === 'f') {
      const abs = decodeURIComponent(parts.slice(3).join('/'));
      if (!sources.mediaKind(abs)) return res.writeHead(403).end();
      return serveFile(req, res, path.resolve(abs));
    }
  } catch (e) {
    res.writeHead(400).end(String(e.message));
    return;
  }
  res.writeHead(404).end();
}

function start() {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.keepAliveTimeout = 30000;
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}/${token}`;
      resolve(base);
    });
  });
}

const enc = (rel) => rel.split('/').map(encodeURIComponent).join('/');
const sourceUrl = (sourceId, rel) => `${base}/s/${encodeURIComponent(sourceId)}/${enc(rel)}`;
const fileUrl = (abs) => `${base}/f/${encodeURIComponent(abs)}`;

module.exports = { start, sourceUrl, fileUrl, getBase: () => base };
