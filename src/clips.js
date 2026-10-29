// 구간 라이브러리: 파일별 반복 구간 + 구간마다 폴더 / 태그.
// 같은 영상을 다른 보드에서, 나중에 다시 열어도 구간이 그대로 남고, 구간 탭에서 폴더 / 검색 / 태그로 찾는다.
//  clips.json        키 → { segments: [{ id, a, b, name?, tags?, folder? }], at, meta? }
//                    키 = "<소스>|<경로>" (NAS) 또는 "file|<절대 경로>" (탐색기에서 끌어온 파일)
//                    meta = { sourceId?, path?, file?, name, kind, size?, mtime? } - 라이브러리에서 열고 썸네일을 만들 때 쓴다
//  range-folders.json { folders: [{ id, name, parent }] }   (parent: 상위 폴더 id, 없으면 맨 위)
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const file = () => path.join(app.getPath('userData'), 'clips.json');
const foldersFile = () => path.join(app.getPath('userData'), 'range-folders.json');
let lib = null;
let folders = null;
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

function save() {
  clearTimeout(timer);
  timer = setTimeout(() => fs.writeFile(file(), JSON.stringify(lib), () => {}), 500);
}

const cleanTags = (tags) =>
  [...new Set((Array.isArray(tags) ? tags : []).map((t) => String(t).trim().replace(/^#/, '').slice(0, 30)).filter(Boolean))].slice(0, 20);

function cleanSeg(s) {
  const out = { id: s.id, a: s.a, b: s.b ?? null };
  const name = typeof s.name === 'string' ? s.name.trim().slice(0, 60) : '';
  if (name) out.name = name;
  const tags = cleanTags(s.tags);
  if (tags.length) out.tags = tags;
  if (s.folder) out.folder = String(s.folder);
  return out;
}

const validSeg = (s) => isFinite(s.a) && (s.b == null || (isFinite(s.b) && s.b > s.a));

function cleanMeta(m) {
  if (!m || typeof m !== 'object') return null;
  const out = {};
  for (const k of ['sourceId', 'path', 'file', 'name', 'kind']) if (typeof m[k] === 'string' && m[k]) out[k] = m[k];
  for (const k of ['size', 'mtime']) if (isFinite(m[k])) out[k] = Number(m[k]);
  return out.name ? out : null;
}

// 예전에 저장된 항목(meta 없음)은 키에서 알아낸다
function metaFromKey(key) {
  const file = key.startsWith('file|') ? key.slice(5) : null;
  const i = key.indexOf('|');
  const p = file || key.slice(i + 1);
  const name = p.split(/[\\/]/).pop();
  const kind = /\.gif$/i.test(name) ? 'gif' : 'video';
  return file ? { file, name, kind } : { sourceId: key.slice(0, i), path: p, name, kind };
}

function get(key) {
  return load()[key]?.segments || null;
}

function set(key, segments, meta) {
  load();
  const clean = (segments || []).filter(validSeg).map(cleanSeg);
  if (clean.length) {
    const m = cleanMeta(meta) || lib[key]?.meta || null;
    lib[key] = { segments: clean, at: Date.now(), ...(m ? { meta: m } : {}) };
  } else delete lib[key];
  save();
}

// 라이브러리에서 구간 하나를 고칠 때 (보드에 없는 영상도): patch = { name?, tags?, folder?, delete? }
function update(key, id, patch) {
  load();
  const e = lib[key];
  if (!e) return null;
  if (patch.delete) e.segments = e.segments.filter((s) => s.id !== id);
  else {
    const s = e.segments.find((g) => g.id === id);
    if (!s) return e.segments;
    if ('name' in patch) s.name = patch.name;
    if ('tags' in patch) s.tags = patch.tags;
    if ('folder' in patch) s.folder = patch.folder;
    Object.assign(s, cleanSeg(s));
    if (!s.name) delete s.name;
    if (!s.tags) delete s.tags;
    if (!s.folder) delete s.folder;
  }
  if (!e.segments.length) delete lib[key];
  save();
  return lib[key]?.segments || [];
}

// 폴더를 지우면 그 안(하위 폴더 포함)의 구간은 "미분류"로
function clearFolders(ids) {
  load();
  const set = new Set(ids);
  for (const e of Object.values(lib)) for (const s of e.segments) if (s.folder && set.has(s.folder)) delete s.folder;
  save();
}

// 구간이 저장된 파일 키 목록 / 전체 (패널 표시용)
const keys = () => Object.keys(load());
const all = () => Object.fromEntries(Object.entries(load()).map(([k, v]) => [k, v.segments]));
// 라이브러리 화면용: [{ key, meta, segments, at }]
const library = () => Object.entries(load()).map(([key, v]) => ({ key, meta: v.meta || metaFromKey(key), segments: v.segments, at: v.at || 0 }));

function getFolders() {
  if (folders) return folders;
  try {
    folders = JSON.parse(fs.readFileSync(foldersFile(), 'utf8')).folders || [];
  } catch {
    folders = [];
  }
  return folders;
}

function setFolders(list) {
  folders = (Array.isArray(list) ? list : [])
    .filter((f) => f && f.id && typeof f.name === 'string')
    .map((f) => ({ id: String(f.id), name: f.name.trim().slice(0, 60) || '?', parent: f.parent ? String(f.parent) : null }));
  fs.writeFile(foldersFile(), JSON.stringify({ folders }), () => {});
  return folders;
}

module.exports = { get, set, update, clearFolders, keys, all, library, getFolders, setFolders };
