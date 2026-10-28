// 파일별 반복 구간 라이브러리: 같은 영상을 다른 보드에서, 나중에 다시 열어도 구간이 그대로 남는다.
// 키 = "<소스>|<경로>" (NAS) 또는 "file|<절대 경로>" (탐색기에서 끌어온 파일)
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const file = () => path.join(app.getPath('userData'), 'clips.json');
let lib = null;
let timer = null;

function load() {
  if (lib) return lib;
  try {
    lib = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    lib = {};
  }
  return lib;
}

function get(key) {
  return load()[key]?.segments || null;
}

function set(key, segments) {
  load();
  const clean = (segments || [])
    .filter((s) => isFinite(s.a) && (s.b == null || (isFinite(s.b) && s.b > s.a)))
    .map((s) => {
      const name = typeof s.name === 'string' ? s.name.trim().slice(0, 60) : '';
      return name ? { id: s.id, a: s.a, b: s.b ?? null, name } : { id: s.id, a: s.a, b: s.b ?? null };
    });
  if (clean.length) lib[key] = { segments: clean, at: Date.now() };
  else delete lib[key];
  clearTimeout(timer);
  timer = setTimeout(() => fs.writeFile(file(), JSON.stringify(lib), () => {}), 500);
}

// 구간이 저장된 파일 키 목록 / 전체 (패널 표시용)
const keys = () => Object.keys(load());
const all = () => Object.fromEntries(Object.entries(load()).map(([k, v]) => [k, v.segments]));

module.exports = { get, set, keys, all };
