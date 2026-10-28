// FFmpeg 로 썸네일을 만들어 로컬 캐시에 둔다.
// 키 = 소스 + 경로 + 크기 + 수정시각 → NAS 파일이 바뀌면 자동으로 새로 만든다.
//
// 성능 메모 (1080p 8Mbps / 4K HEVC 테스트 파일, WebDAV 경유 측정)
//  - "-ss 1" 로 1초 지점을 잡으면 첫 프레임보다 NAS 에서 약 2배(1080p: 12MB → 21MB)를 읽고 2배 느리다.
//    → 첫 프레임을 쓰고, 같은 실행에서 8x8 회색조 사본을 함께 뽑아 거의 검은 화면일 때만 1초 지점으로 다시 만든다.
//  - "-skip_frame nokey" 는 오히려 다음 키프레임까지 읽어 2~3배 더 읽으므로 쓰지 않는다.
//  - 디코더 스레드를 1개로 하면 미리 읽는 양이 줄어든다 (1080p: 18MB → 12MB).
//  - 캐시 확인은 메모리 색인으로 (폴더 1500개를 열 때 파일 존재 확인 1500번을 없앰).
//  - 화면에 보이는 카드(high)를 먼저, 근처 카드(low)는 나중에. 화면 밖으로 나간 대기 작업은 버린다.
//  - 한 번 실패한 파일(코덱 미지원 등)은 기억해 두고 다시 시도하지 않는다.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app } = require('electron');
const proxy = require('./proxy');
const sources = require('./sources');

const MAX_PARALLEL = 4;
const TIMEOUT_MS = 30000;
const GENERIC_FAIL = '썸네일 생성 실패';
const MAX_CACHE_BYTES = 1024 * 1024 * 1024; // 1GB 를 넘으면 오래 안 쓴 것부터 정리
const BLACK_LEVEL = 18; // 8x8 평균 밝기가 이보다 낮으면 "검은 첫 프레임"
const cacheDir = () => path.join(app.getPath('userData'), 'thumbs');
const failedFile = () => path.join(cacheDir(), 'failed.json');

const index = new Set(); // 캐시에 있는 키
let indexReady = false;
let failed = {}; // 키 → 오류 메시지
const touched = new Set();

const jobs = new Map(); // 키 → job (대기 또는 실행 중)
const high = []; // 화면에 보이는 것: 최근 요청부터
const low = []; // 근처: 요청 순서대로
let running = 0;

// at: 이 시각(초)의 프레임 (반복 구간 썸네일). 없으면 첫 프레임. file: 탐색기에서 끌어온 파일
const keyOf = ({ sourceId, path: rel, file: abs, size, mtime, at }) =>
  crypto.createHash('sha1').update(`${abs ? `file|${abs}` : `${sourceId}|${rel}`}|${size}|${mtime}${at != null ? `|@${at.toFixed(3)}` : ''}`).digest('hex');
const fileOf = (key) => path.join(cacheDir(), key.slice(0, 2), key + '.jpg');

// ---------- 캐시 색인 / 정리 ----------

async function init() {
  const dir = cacheDir();
  try {
    failed = JSON.parse(await fs.promises.readFile(failedFile(), 'utf8'));
    // 예전 버전은 시간 초과(오류 글 없음)도 실패로 기억했다 → 다시 시도하도록 지운다
    const stale = Object.keys(failed).filter((k) => failed[k] === GENERIC_FAIL);
    stale.forEach((k) => delete failed[k]);
    if (stale.length) fs.writeFile(failedFile(), JSON.stringify(failed), () => {});
  } catch {
    failed = {};
  }
  try {
    for (const sub of await fs.promises.readdir(dir)) {
      if (sub.length !== 2) continue;
      for (const f of await fs.promises.readdir(path.join(dir, sub))) {
        if (f.endsWith('.jpg') && !f.includes('.tmp')) index.add(f.slice(0, -4));
        else fs.promises.rm(path.join(dir, sub, f), { force: true }); // 중단된 임시 파일
      }
    }
  } catch {}
  indexReady = true;
  setTimeout(prune, 15000).unref?.();
}

async function prune() {
  const files = [];
  let total = 0;
  for (const key of index) {
    try {
      const st = await fs.promises.stat(fileOf(key));
      files.push({ key, size: st.size, mtime: st.mtimeMs });
      total += st.size;
    } catch {
      index.delete(key);
    }
  }
  if (total <= MAX_CACHE_BYTES) return;
  files.sort((a, b) => a.mtime - b.mtime);
  for (const f of files) {
    if (total <= MAX_CACHE_BYTES * 0.8) break;
    await fs.promises.rm(fileOf(f.key), { force: true });
    index.delete(f.key);
    total -= f.size;
  }
}

let failedTimer = null;
function rememberFailure(key, error) {
  failed[key] = error;
  clearTimeout(failedTimer);
  failedTimer = setTimeout(() => {
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFile(failedFile(), JSON.stringify(failed), () => {});
  }, 1000);
}

// ---------- FFmpeg ----------

function runFfmpeg(args) {
  return new Promise((resolve) => {
    const ffmpeg = sources.loadConfig().settings.ffmpegPath || 'ffmpeg';
    let stderr = '';
    const out = [];
    let proc;
    try {
      proc = spawn(ffmpeg, args, { windowsHide: true });
    } catch (e) {
      resolve({ ok: false, error: e.message });
      return;
    }
    let timedOut = false;
    const timer = setTimeout(() => ((timedOut = true), proc.kill()), TIMEOUT_MS);
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, missing: e.code === 'ENOENT', error: e.code === 'ENOENT' ? 'ffmpeg 를 찾을 수 없음' : e.message });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: Buffer.concat(out), timedOut, error: timedOut ? '시간 초과' : stderr.trim().split('\n').pop() });
    });
  });
}

const BASE = ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '1'];
const SCALE = "scale='min(360,iw)':-2";

async function makeThumb(url, out, kind, at) {
  if (at != null) {
    // 정확한 시각의 프레임 (-ss 를 입력 앞에 두면 키프레임으로 찾아간 뒤 그 시각까지 디코딩한다)
    return runFfmpeg([...BASE, '-ss', at.toFixed(4), '-i', url, '-an', '-sn', '-dn', '-vf', SCALE, '-frames:v', '1', '-q:v', '5', '-update', '1', out]);
  }
  if (kind !== 'video') { // 이미지 · GIF: 첫 프레임
    return runFfmpeg([...BASE, '-i', url, '-vf', SCALE, '-frames:v', '1', '-q:v', '5', '-update', '1', out]);
  }
  // 첫 프레임 + 밝기 확인용 8x8 회색조를 한 번에
  const r = await runFfmpeg([
    ...BASE, '-i', url, '-an', '-sn', '-dn',
    '-filter_complex', `[0:v:0]split=2[a][b];[a]${SCALE}[t];[b]scale=8:8,format=gray[g]`,
    '-map', '[t]', '-frames:v', '1', '-q:v', '5', '-update', '1', out,
    '-map', '[g]', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1',
  ]);
  if (!r.ok) return r;
  const px = r.stdout || Buffer.alloc(0);
  const mean = px.length ? px.reduce((a, v) => a + v, 0) / px.length : 255;
  if (mean >= BLACK_LEVEL) return r;
  // 검은 첫 프레임(페이드인 등) → 1초 지점으로 다시. 실패하면 첫 프레임을 그대로 쓴다
  const tmp2 = out.replace(/\.jpg$/, '.2.jpg');
  const r2 = await runFfmpeg([...BASE, '-ss', '1', '-i', url, '-an', '-sn', '-dn', '-vf', SCALE, '-frames:v', '1', '-q:v', '5', '-update', '1', tmp2]);
  if (r2.ok && fs.existsSync(tmp2) && fs.statSync(tmp2).size > 0) fs.renameSync(tmp2, out);
  else fs.rmSync(tmp2, { force: true });
  return r;
}

// ---------- 대기열 ----------

function pump() {
  while (running < MAX_PARALLEL && (high.length || low.length)) {
    const job = high.length ? high.pop() : low.shift();
    job.state = 'running';
    running++;
    job.run().finally(() => {
      running--;
      pump();
    });
  }
}

function unqueue(job) {
  const list = job.pri === 'high' ? high : low;
  const i = list.indexOf(job);
  if (i >= 0) list.splice(i, 1);
}

// 결과: { file } | { error } | { cancelled }
function get(entry, pri = 'high') {
  const key = keyOf(entry);
  const out = fileOf(key);
  if (index.has(key) || (!indexReady && fs.existsSync(out))) {
    index.add(key);
    if (!touched.has(key)) {
      touched.add(key);
      const now = new Date();
      fs.utimes(out, now, now, () => {}); // 정리할 때 "최근에 쓴 것"으로
    }
    return Promise.resolve({ file: out });
  }
  if (failed[key]) return Promise.resolve({ error: failed[key] });

  const existing = jobs.get(key);
  if (existing) {
    if (pri === 'high' && existing.state === 'queued' && existing.pri === 'low') {
      unqueue(existing);
      existing.pri = 'high';
      high.push(existing);
      pump();
    }
    return existing.promise;
  }

  const job = { key, pri, state: 'queued' };
  job.promise = new Promise((resolve) => {
    job.resolve = resolve;
    job.run = async () => {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const tmp = out.replace(/\.jpg$/, '.tmp.jpg');
      const url = entry.file ? proxy.fileUrl(entry.file) : proxy.sourceUrl(entry.sourceId, entry.path);
      const r = await makeThumb(url, tmp, entry.kind, entry.at);
      if (r.ok && fs.existsSync(tmp) && fs.statSync(tmp).size > 0) {
        fs.renameSync(tmp, out);
        index.add(key);
        resolve({ file: out });
      } else {
        fs.rmSync(tmp, { force: true });
        const error = r.error || GENERIC_FAIL;
        // ffmpeg 가 없거나, 시간 초과 / NAS 연결 문제 / 이유를 모르는 실패는 일시적일 수 있으니 기억하지 않는다
        // (파일 자체가 깨진 경우처럼 ffmpeg 가 이유를 말한 실패만 기억)
        const transient = r.missing || r.timedOut || !r.error || /Connection|timed out|refused|reset|HTTP error|I\/O error|End of file/i.test(error);
        if (!transient) rememberFailure(key, error);
        resolve({ error });
      }
    };
  }).finally(() => jobs.delete(key));
  jobs.set(key, job);
  (pri === 'high' ? high : low).push(job);
  pump();
  return job.promise;
}

// 화면에서 멀어진 카드의 대기 작업 취소 (이미 만드는 중이면 그대로 둔다)
function drop(entry) {
  const job = jobs.get(keyOf(entry));
  if (!job || job.state !== 'queued') return;
  unqueue(job);
  jobs.delete(job.key);
  job.resolve({ cancelled: true });
}

// 폴더를 옮길 때: 대기 중인 것 전부 취소
function cancelQueued() {
  for (const job of [...high.splice(0), ...low.splice(0)]) {
    jobs.delete(job.key);
    job.resolve({ cancelled: true });
  }
}

function clearCache() {
  cancelQueued();
  fs.rmSync(cacheDir(), { recursive: true, force: true });
  index.clear();
  touched.clear();
  failed = {};
}

module.exports = { init, get, drop, cancelQueued, clearCache };
