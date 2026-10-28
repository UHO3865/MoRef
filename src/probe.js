// 영상의 실제 프레임 레이트 / 프레임 수를 ffprobe 로 읽어 디스크에 캐시한다.
// (헤더만 읽어서 빠르다. 같은 파일은 한 번만 확인)
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');
const proxy = require('./proxy');
const sources = require('./sources');

const MAX_PARALLEL = 3;
const TIMEOUT_MS = 20000;
const cacheFile = () => path.join(app.getPath('userData'), 'probe-cache.json');

let cache = null;
const pending = new Map();
const queue = [];
let running = 0;

function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

let saveTimer = null;
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(cacheFile(), JSON.stringify(cache), () => {}), 1000);
}

// 설정의 ffmpeg 경로 옆에 있는 ffprobe
function ffprobePath() {
  const ff = sources.loadConfig().settings.ffmpegPath || 'ffmpeg';
  return ff.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'));
}

// "24000/1001" → 23.976…
function rational(s) {
  const [n, d] = String(s || '').split('/').map(Number);
  const v = d ? n / d : n;
  return isFinite(v) && v > 0 && v < 1000 ? v : null;
}

function runProbe(url) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let proc;
    try {
      proc = spawn(ffprobePath(), [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=avg_frame_rate,r_frame_rate,nb_frames,duration,codec_name,width,height:format=duration',
        '-of', 'json', url,
      ], { windowsHide: true });
    } catch (e) {
      return resolve({ error: e.message });
    }
    const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ error: e.code === 'ENOENT' ? 'ffprobe 를 찾을 수 없음' : e.message, transient: true });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ error: err.trim().split('\n').pop() || 'ffprobe 실패', transient: true });
      try {
        const j = JSON.parse(out);
        const st = j.streams?.[0];
        if (!st) return resolve({ error: '영상 스트림 없음' });
        const avg = rational(st.avg_frame_rate);
        const r = rational(st.r_frame_rate);
        const fps = avg || r;
        if (!fps) return resolve({ error: '프레임 레이트를 알 수 없음' });
        const duration = Number(st.duration) || Number(j.format?.duration) || 0;
        const nb = Number(st.nb_frames) || 0;
        resolve({
          fps,
          frames: nb || (duration ? Math.round(duration * fps) : 0),
          vfr: !!(avg && r && Math.abs(avg - r) / r > 0.01), // 가변 프레임 (휴대폰 촬영 등): 대략값
          codec: st.codec_name,
          // 영상을 아직 받지 않아도 크기/길이를 알 수 있게 (멈춘 영상은 재생 전까지 받지 않는다)
          duration,
          width: Number(st.width) || 0,
          height: Number(st.height) || 0,
        });
      } catch (e) {
        resolve({ error: 'ffprobe 결과를 읽을 수 없음' });
      }
    });
  });
}

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    running++;
    job().finally(() => {
      running--;
      pump();
    });
  }
}

// ref: { sourceId, path, size?, mtime? } 또는 { file }
async function probe(ref) {
  loadCache();
  let key;
  let url;
  if (ref.file) {
    const st = await fs.promises.stat(ref.file).catch(() => null);
    key = `v2|file|${ref.file}|${st?.size ?? ''}|${Math.round(st?.mtimeMs ?? 0)}`;
    url = proxy.fileUrl(ref.file);
  } else {
    key = `v2|${ref.sourceId}|${ref.path}|${ref.size ?? ''}|${ref.mtime ?? ''}`;
    url = proxy.sourceUrl(ref.sourceId, ref.path);
  }
  if (cache[key]) return cache[key];
  if (pending.has(key)) return pending.get(key);
  const p = new Promise((resolve) => {
    queue.push(async () => {
      const r = await runProbe(url);
      if (!r.transient) {
        const { transient, ...keep } = r;
        cache[key] = keep;
        saveCache();
      }
      resolve(r);
    });
    pump();
  }).finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

module.exports = { probe };
