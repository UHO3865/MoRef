// 소스(레퍼런스 저장소) 설정과 폴더 목록 조회.
// type 'dav'  : WebDAV (Synology/QNAP 등) - PROPFIND 로 목록, GET+Range 로 스트리밍
// type 'local': 로컬 폴더, 매핑된 드라이브, \\NAS\share 같은 SMB 경로
const { tr } = require('./i18n');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');
const { XMLParser } = require('fast-xml-parser');

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

function mediaKind(name) {
  const ext = path.extname(name).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (ext === '.gif') return 'gif'; // 프레임 단위 재생 컨트롤이 붙는다
  if (IMAGE_EXT.has(ext)) return 'image';
  return null;
}

// ---------- config ----------

const configPath = () => path.join(app.getPath('userData'), 'config.json');
let config = null;

// fresh: 디스크에서 다시 읽는다. 데스크톱 창과 Blender 도킹 창이 함께 떠 있을 때
// 서로의 변경을 덮어쓰지 않도록, 설정을 바꾸기 직전에는 항상 fresh 로 읽는다.
function loadConfig(fresh = false) {
  if (config && !fresh) return config;
  config = null;
  try {
    config = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    config = {};
  }
  config.sources ??= [];
  config.settings ??= { ffmpegPath: 'ffmpeg', alwaysOnTop: false, opacity: 1 };
  return config;
}

function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

function encryptPassword(pw) {
  if (!pw) return '';
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(pw).toString('base64');
  return 'raw:' + Buffer.from(pw).toString('base64');
}

function decryptPassword(stored) {
  if (!stored) return '';
  const [kind, data] = [stored.slice(0, 4), stored.slice(4)];
  if (kind === 'enc:') return safeStorage.decryptString(Buffer.from(data, 'base64'));
  return Buffer.from(data, 'base64').toString();
}

// 렌더러로 보낼 때는 비밀번호를 빼고 보낸다.
function publicSource(s) {
  const { password, ...rest } = s;
  return { ...rest, hasPassword: !!password };
}

function getSource(id) {
  return loadConfig().sources.find((s) => s.id === id) || null;
}

// 입력값 → 저장용 소스 객체. password 가 빈 값이면 기존 비밀번호 유지.
function normalizeSource(input, existing) {
  const s = {
    id: existing?.id || input.id || crypto.randomUUID(),
    name: (input.name || '').trim() || 'NAS',
    type: input.type === 'local' ? 'local' : 'dav',
    url: (input.url || '').trim(),
    username: (input.username || '').trim(),
    insecureTLS: !!input.insecureTLS,
    password: existing?.password || '',
  };
  if (input.password) s.password = encryptPassword(input.password);
  if (input.clearPassword) s.password = '';
  if (s.type === 'dav' && s.url && !s.url.endsWith('/')) s.url += '/';
  return s;
}

function upsertSource(input) {
  const cfg = loadConfig(true);
  const idx = cfg.sources.findIndex((s) => s.id === input.id);
  const s = normalizeSource(input, idx >= 0 ? cfg.sources[idx] : null);
  if (idx >= 0) cfg.sources[idx] = s;
  else cfg.sources.push(s);
  saveConfig();
  dropAgent(s.id);
  return publicSource(s);
}

function deleteSource(id) {
  const cfg = loadConfig(true);
  cfg.sources = cfg.sources.filter((s) => s.id !== id);
  saveConfig();
  dropAgent(id);
}

// ---------- WebDAV ----------

const agents = new Map();
function dropAgent(id) {
  agents.get(id)?.destroy();
  agents.delete(id);
}

function agentFor(src) {
  let a = agents.get(src.id);
  if (!a) {
    const isHttps = src.url.startsWith('https:');
    // NAS 연결은 하나만 열어 돌려 쓴다. 어떤 NAS 는 로그인한 연결을 한 번에 하나만 받아서
    // 두 번째 연결이 첫 연결이 닫힐 때까지(쉬는 연결이면 약 5초) 기다린다. 요청은 짧게 나눠 보내므로(proxy.js)
    // 하나로 줄 세워도 금방 차례가 온다.
    const opts = { keepAlive: true, maxSockets: 1 };
    a = isHttps ? new https.Agent({ ...opts, rejectUnauthorized: !src.insecureTLS }) : new http.Agent(opts);
    agents.set(src.id, a);
  }
  return a;
}

function authHeader(src) {
  if (!src.username) return {};
  const token = Buffer.from(`${src.username}:${decryptPassword(src.password)}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

// 상대 경로("a/b c.mp4") → 소스 기준 절대 URL
function davUrl(src, rel) {
  const enc = rel.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return new URL(enc, src.url).toString();
}

// WebDAV 요청. 응답 스트림(IncomingMessage)을 그대로 돌려준다.
function davRequest(src, method, rel, { headers = {}, body } = {}) {
  const url = new URL(davUrl(src, rel));
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      { method, agent: agentFor(src), headers: { ...authHeader(src), ...headers } },
      resolve
    );
    req.setTimeout(30000, () => req.destroy(new Error(tr('NAS 응답 시간 초과'))));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function readBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  '<d:resourcetype/><d:getcontentlength/><d:getlastmodified/>' +
  '</d:prop></d:propfind>';

const xml = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false });
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

async function listDav(src, rel) {
  const propfind = () =>
    davRequest(src, 'PROPFIND', rel ? rel.replace(/\/?$/, '/') : '', {
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
    });
  // 디스크 절전 중인 NAS 는 첫 요청에 10~30초 걸리거나 연결을 끊는다: 연결 오류 / 시간 초과면 한 번 더 기다린다
  // (인증 실패 같은 HTTP 오류는 다시 하지 않는다)
  let res;
  try {
    res = await propfind();
  } catch {
    res = await propfind();
  }
  const text = await readBody(res);
  if (res.statusCode === 401) throw new Error(tr('인증 실패 (아이디/비밀번호 확인)'));
  if (res.statusCode !== 207) throw new Error(tr('WebDAV 오류 {0}', res.statusCode));

  const basePath = safeDecode(new URL(src.url).pathname).replace(/\/+$/, '');
  const doc = xml.parse(text);
  const out = [];
  for (const r of asArray(doc.multistatus?.response)) {
    const href = String(r.href || '');
    const hrefPath = safeDecode(href.startsWith('http') ? new URL(href).pathname : href).replace(/\/+$/, '');
    let relPath = hrefPath.startsWith(basePath) ? hrefPath.slice(basePath.length) : hrefPath;
    relPath = relPath.replace(/^\/+/, '');
    if (relPath === (rel || '').replace(/^\/+|\/+$/g, '')) continue; // 폴더 자신

    const props = asArray(r.propstat).find((p) => /\s200\s/.test(String(p.status || '')))?.prop || {};
    const rt = props.resourcetype;
    const isDir = rt && typeof rt === 'object' && 'collection' in rt;
    const name = relPath.split('/').pop();
    if (!name || name.startsWith('.') || name.startsWith('@')) continue; // .DS_Store, @eaDir 등
    const kind = isDir ? 'dir' : mediaKind(name);
    if (!kind) continue;
    out.push({
      name,
      path: relPath,
      kind,
      size: Number(props.getcontentlength) || 0,
      mtime: props.getlastmodified ? Date.parse(props.getlastmodified) || 0 : 0,
    });
  }
  return out;
}

// ---------- local / SMB ----------

function localFullPath(src, rel) {
  const root = path.resolve(src.url);
  const full = path.resolve(root, ...rel.split('/').filter(Boolean));
  if (full !== root && !full.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
    throw new Error(tr('잘못된 경로'));
  }
  return full;
}

async function listLocal(src, rel) {
  const dir = localFullPath(src, rel);
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  const out = [];
  await Promise.all(
    dirents.map(async (d) => {
      if (d.name.startsWith('.') || d.name.startsWith('@') || d.name.startsWith('$')) return;
      const kind = d.isDirectory() ? 'dir' : mediaKind(d.name);
      if (!kind) return;
      let st = { size: 0, mtimeMs: 0 };
      try {
        st = await fs.promises.stat(path.join(dir, d.name));
      } catch {}
      out.push({
        name: d.name,
        path: rel ? `${rel.replace(/\/+$/, '')}/${d.name}` : d.name,
        kind,
        size: st.size,
        mtime: Math.round(st.mtimeMs),
      });
    })
  );
  return out;
}

async function list(sourceId, rel = '') {
  const src = getSource(sourceId);
  if (!src) throw new Error(tr('소스를 찾을 수 없음'));
  const entries = src.type === 'dav' ? await listDav(src, rel) : await listLocal(src, rel);
  const order = { dir: 0, video: 1, gif: 2, image: 3 };
  entries.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name, 'ko', { numeric: true }));
  return entries;
}

async function testSource(input) {
  const existing = input.id ? getSource(input.id) : null;
  const src = { ...normalizeSource(input, existing), id: '__test__' + Date.now() };
  try {
    const entries = src.type === 'dav' ? await listDav(src, '') : await listLocal(src, '');
    return { ok: true, count: entries.length };
  } catch (e) {
    return { ok: false, error: e.code ? `${e.code} ${e.message}` : e.message };
  } finally {
    dropAgent(src.id);
  }
}

module.exports = {
  loadConfig,
  saveConfig,
  publicSource,
  getSource,
  upsertSource,
  deleteSource,
  list,
  testSource,
  davRequest,
  localFullPath,
  mediaKind,
};
