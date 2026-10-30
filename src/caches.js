// 다시 만들 수 있는 캐시의 크기 관리 (썸네일은 thumbs.js 가 따로 정리한다)
//  * blender-clips: Blender 로 보낸 NAS 영상. 오래 안 쓴 것부터 지운다 (쓸 때마다 수정 시각을 갱신 - blender.js)
//  * listings: 폴더 목록. 오래된 것 / 너무 많으면 지운다
//  * Chromium 디스크 캐시: 프록시로 받은 영상 조각도 여기 쌓인다 → 크기 상한 (main.js 의 disk-cache-size)
// 앱을 켜고 조금 뒤에 한 번, 이후 하루에 한 번 정리한다. 설정의 "캐시 비우기" 는 전부 지운다.
const fs = require('fs');
const path = require('path');
const { app, session } = require('electron');

const MB = 1024 * 1024;
const DISK_CACHE_BYTES = 512 * MB;
const CLIPS_MAX_BYTES = (Number(process.env.RB_CLIPS_CACHE_MB) || 2048) * MB;
const LISTINGS_MAX_FILES = 2000;
const LISTINGS_MAX_AGE_MS = 60 * 24 * 3600 * 1000;
const PART_MAX_AGE_MS = 24 * 3600 * 1000; // 받다 만 .part (받는 중인 것은 하루가 안 된다)

const dirOf = (name) => path.join(app.getPath('userData'), name);

// 폴더 안의 파일들 (한 단계 아래 폴더까지): { file, size, mtime }
async function filesIn(dir) {
  const out = [];
  const walk = async (d, depth) => {
    let names;
    try {
      names = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) {
        if (depth < 1) await walk(p, depth + 1);
        continue;
      }
      const st = await fs.promises.stat(p).catch(() => null);
      if (st) out.push({ file: p, size: st.size, mtime: st.mtimeMs });
    }
  };
  await walk(dir, 0);
  return out;
}

const rm = (f) => fs.promises.rm(f, { force: true }).catch(() => {}); // Blender 가 잡고 있는 파일은 지워지지 않는다 - 다음에

async function pruneClips() {
  const files = await filesIn(dirOf('blender-clips'));
  const now = Date.now();
  let total = 0;
  for (const f of files) total += f.size;
  for (const f of files.filter((f) => f.file.endsWith('.part') && now - f.mtime > PART_MAX_AGE_MS)) {
    await rm(f.file);
    total -= f.size;
  }
  if (total <= CLIPS_MAX_BYTES) return;
  for (const f of files.filter((f) => !f.file.endsWith('.part')).sort((a, b) => a.mtime - b.mtime)) {
    if (total <= CLIPS_MAX_BYTES * 0.8) break;
    await rm(f.file);
    total -= f.size;
  }
  // 빈 폴더 정리
  for (const d of await fs.promises.readdir(dirOf('blender-clips')).catch(() => [])) {
    await fs.promises.rmdir(path.join(dirOf('blender-clips'), d)).catch(() => {});
  }
}

async function pruneListings() {
  const files = (await filesIn(dirOf('listings'))).sort((a, b) => b.mtime - a.mtime);
  const now = Date.now();
  for (const [i, f] of files.entries()) {
    if (i >= LISTINGS_MAX_FILES || now - f.mtime > LISTINGS_MAX_AGE_MS) await rm(f.file);
  }
}

function prune() {
  return Promise.all([pruneClips(), pruneListings()]).catch(() => {});
}

function schedule() {
  setTimeout(prune, 20000).unref?.();
  setInterval(prune, 24 * 3600 * 1000).unref?.();
}

const dirSize = async (name) => (await filesIn(dirOf(name))).reduce((a, f) => a + f.size, 0);

const cacheSize = async () =>
  (await dirSize('thumbs')) + (await dirSize('blender-clips')) + (await dirSize('listings')) + (await session.defaultSession.getCacheSize().catch(() => 0));

// 설정의 "캐시 비우기": 썸네일 · fps · 폴더 목록 · Blender 로 보낸 영상 · 받아 둔 영상 조각. 지운 크기(바이트)를 돌려준다
async function clearAll() {
  const before = await cacheSize();
  require('./thumbs').clearCache();
  require('./probe').clearCache();
  for (const f of await filesIn(dirOf('blender-clips'))) await rm(f.file);
  await fs.promises.rm(dirOf('listings'), { recursive: true, force: true }).catch(() => {});
  await session.defaultSession.clearCache().catch(() => {});
  return Math.max(0, before - (await cacheSize()));
}

module.exports = { DISK_CACHE_BYTES, schedule, prune, clearAll };
