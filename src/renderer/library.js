'use strict';
/* global app, rb, $, h, icon, toast, tr, fmtTime, showMenu, closeMenu, addItem, boardCenter, goToItem, activateSegment,
   segColor, rangeThumb, renderSegments, segActive, clipLibChanged, isTimed, libKey, saveSegments, markDirty */
// 구간 라이브러리 (왼쪽 패널의 "구간" 탭)
//
//  * 보드에서 만든 구간은 모두 자동으로 여기 모인다 (파일별 구간 저장: src/clips.js). 처음엔 "미분류".
//  * 폴더(하위 폴더 가능)에 넣고, 태그를 여러 개 달고, 이름 / 파일 이름 / 태그 / 폴더 이름으로 찾는다.
//    검색창에 #태그 를 쓰면 그 태그만. 태그 칩을 누르면 그 태그로 거른다 (여러 개 = 모두 가진 것).
//  * 누르면 보드에서 그 구간을 반복한다 (보드에 없으면 올린다). 구간 카드를 폴더 위로 끌면 그 폴더로 옮긴다.
//  * 여기서 고친 이름 / 태그 / 폴더 / 삭제는 보드에 올려 둔 같은 영상에도 바로 반영된다.

const L = {
  on: false,
  entries: [], // [{ key, meta, segments, at }]
  folders: [], // [{ id, name, parent }]
  folder: 'all', // 'all' | 'none' | 폴더 id
  tags: new Set(), // 고른 태그
  open: new Set(), // 펼친 폴더
  reloadTimer: null,
};

function initLibrary() {
  $('#tabFiles').onclick = () => setLibraryTab(false);
  $('#tabRanges').onclick = () => setLibraryTab(true);
  $('#libSearch').oninput = () => renderLibList();
  $('#libNewFolder').onclick = () => newFolder(null);
  if (app.settings.panelTab === 'ranges') setLibraryTab(true);
}

async function setLibraryTab(on) {
  L.on = on;
  document.body.classList.toggle('lib-mode', on);
  $('#tabFiles').classList.toggle('on', !on);
  $('#tabRanges').classList.toggle('on', on);
  rb.setSetting('panelTab', on ? 'ranges' : 'files');
  if (on) await reloadLibrary();
}

async function reloadLibrary() {
  const [entries, folders] = await Promise.all([rb.clips.library(), rb.clips.folders()]);
  L.entries = entries || [];
  L.folders = folders || [];
  if (L.folder !== 'all' && L.folder !== 'none' && !L.folders.some((f) => f.id === L.folder)) L.folder = 'all';
  renderLibrary();
}

// 보드에서 구간이 바뀌면 (clipLibChanged): 탭이 열려 있을 때만 잠시 뒤에 다시 읽는다
function libraryChanged() {
  if (!L.on) return;
  clearTimeout(L.reloadTimer);
  L.reloadTimer = setTimeout(reloadLibrary, 300);
}

// ---------- 데이터 ----------

const libRows = () => {
  const rows = [];
  for (const e of L.entries) e.segments.forEach((s, i) => rows.push({ e, s, i }));
  return rows;
};
const rowName = (r) => r.s.name || tr('구간 {0}', r.i + 1);
const folderById = (id) => L.folders.find((f) => f.id === id);
const childFolders = (id) => L.folders.filter((f) => (f.parent || null) === id).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
function folderAndBelow(id) {
  const out = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of L.folders) if (f.parent && out.has(f.parent) && !out.has(f.id)) (out.add(f.id), (grew = true));
  }
  return out;
}
const folderPath = (id) => {
  const names = [];
  for (let f = folderById(id); f; f = folderById(f.parent)) names.unshift(f.name);
  return names.join(' / ');
};

function filteredRows() {
  let rows = libRows();
  if (L.folder === 'none') rows = rows.filter((r) => !r.s.folder || !folderById(r.s.folder));
  else if (L.folder !== 'all') {
    const ids = folderAndBelow(L.folder);
    rows = rows.filter((r) => r.s.folder && ids.has(r.s.folder));
  }
  const q = $('#libSearch').value.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const want = new Set([...L.tags].map((t) => t.toLowerCase()));
  for (const w of words) if (w.startsWith('#') && w.length > 1) want.add(w.slice(1));
  const text = words.filter((w) => !w.startsWith('#'));
  rows = rows.filter((r) => {
    const tags = (r.s.tags || []).map((t) => t.toLowerCase());
    for (const t of want) if (!tags.includes(t)) return false;
    if (!text.length) return true;
    const hay = [rowName(r), r.e.meta.name, ...tags, r.s.folder ? folderPath(r.s.folder) : ''].join(' ').toLowerCase();
    return text.every((w) => hay.includes(w));
  });
  // 최근에 고친 파일 먼저, 그 안에서는 영상 순서대로
  return rows.sort((a, b) => b.e.at - a.e.at || a.s.a - b.s.a);
}

// ---------- 그리기 ----------

function renderLibrary() {
  renderLibFolders();
  renderLibTags();
  renderLibList();
}

function renderLibFolders() {
  const box = $('#libFolders');
  box.innerHTML = '';
  const rows = libRows();
  const countIn = (id) => {
    const ids = folderAndBelow(id);
    return rows.filter((r) => r.s.folder && ids.has(r.s.folder)).length;
  };
  const none = rows.filter((r) => !r.s.folder || !folderById(r.s.folder)).length;
  const item = (id, label, n, depth, ic) => {
    const el = h('div', 'lf' + (L.folder === id ? ' on' : ''));
    el.style.paddingLeft = 6 + depth * 14 + 'px';
    const kids = typeof id === 'string' && id !== 'all' && id !== 'none' ? childFolders(id) : [];
    const tw = h('span', 'tw', kids.length ? (L.open.has(id) ? '▾' : '▸') : '');
    tw.onclick = (ev) => {
      ev.stopPropagation();
      if (!kids.length) return;
      if (L.open.has(id)) L.open.delete(id);
      else L.open.add(id);
      renderLibFolders();
    };
    const i = h('span', 'ic');
    i.innerHTML = icon(ic);
    el.append(tw, i, Object.assign(h('span', 'nm'), { textContent: label }), h('span', 'n', String(n)));
    el.onclick = () => {
      L.folder = id;
      renderLibrary();
    };
    if (id !== 'all') {
      // 구간 카드를 끌어다 놓으면 이 폴더로
      el.ondragover = (ev) => {
        if (ev.dataTransfer.types.includes('application/x-refboard-range')) {
          ev.preventDefault();
          el.classList.add('drop');
        }
      };
      el.ondragleave = () => el.classList.remove('drop');
      el.ondrop = (ev) => {
        el.classList.remove('drop');
        const d = JSON.parse(ev.dataTransfer.getData('application/x-refboard-range') || 'null');
        if (d) moveToFolder(d.key, d.id, id === 'none' ? null : id);
      };
    }
    if (typeof id === 'string' && id !== 'all' && id !== 'none') el.oncontextmenu = (ev) => (ev.preventDefault(), folderMenu(ev, id));
    box.append(el);
    if (kids.length && L.open.has(id)) for (const k of kids) item(k.id, k.name, countIn(k.id), depth + 1, 'folder');
  };
  item('all', tr('전체'), rows.length, 0, 'loop');
  item('none', tr('미분류'), none, 0, 'folder');
  for (const f of childFolders(null)) item(f.id, f.name, countIn(f.id), 0, 'folder');
}

function renderLibTags() {
  const box = $('#libTags');
  box.innerHTML = '';
  const count = new Map();
  for (const r of libRows()) for (const t of r.s.tags || []) count.set(t, (count.get(t) || 0) + 1);
  for (const t of [...L.tags]) if (!count.has(t)) L.tags.delete(t);
  const tags = [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  box.hidden = !tags.length;
  for (const [t, n] of tags) {
    const c = h('button', 'ltag' + (L.tags.has(t) ? ' on' : ''));
    c.append(Object.assign(h('span'), { textContent: '#' + t }), h('small', '', String(n)));
    c.onclick = () => {
      if (L.tags.has(t)) L.tags.delete(t);
      else L.tags.add(t);
      renderLibTags();
      renderLibList();
    };
    box.append(c);
  }
}

const libThumbObserver = new IntersectionObserver(
  (records) => {
    for (const r of records) {
      if (!r.isIntersecting) continue;
      const el = r.target;
      libThumbObserver.unobserve(el);
      rangeThumb(el._meta, el._meta.kind, el._a).then((url) => url && (el.style.backgroundImage = `url("${url}")`));
    }
  },
  { rootMargin: '400px 0px' }
);

function renderLibList() {
  const list = $('#libList');
  libThumbObserver.disconnect();
  list.innerHTML = '';
  const rows = filteredRows();
  const total = libRows().length;
  $('#libInfo').textContent = rows.length === total ? tr('구간 {0}개', total) : tr('구간 {0}개 중 {1}개', total, rows.length);
  if (!total) {
    list.append(h('div', 'lib-empty', tr('저장된 구간이 없습니다. 보드에서 영상에 구간을 만들면 여기에 모입니다.')));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const { e, s } = r;
    const card = h('div', 'lr');
    card.style.setProperty('--c', segColor(s));
    card.draggable = true;
    const th = h('div', 'lr-th');
    th._meta = e.meta;
    th._a = s.a;
    libThumbObserver.observe(th);
    const body = h('div', 'lr-body');
    body.append(Object.assign(h('div', 'lr-name'), { textContent: rowName(r) }));
    body.append(Object.assign(h('div', 'lr-file'), { textContent: e.meta.name }));
    const len = s.b != null ? s.b - s.a : null;
    body.append(h('div', 'lr-time', `${fmtTime(s.a)}${s.b != null ? ` – ${fmtTime(s.b)}` : ''}${len != null ? ` · ${len.toFixed(1)}s` : ''}`));
    const tags = h('div', 'lr-tags');
    if (s.folder && folderById(s.folder) && L.folder === 'all') tags.append(Object.assign(h('span', 'lr-folder'), { textContent: folderPath(s.folder) }));
    for (const t of s.tags || []) tags.append(Object.assign(h('span', 'lr-tag'), { textContent: '#' + t }));
    if (tags.childNodes.length) body.append(tags);
    card.append(th, body);
    card.title = tr('{0} · {1}\n클릭: 보드에서 이 구간 반복 · 우클릭: 메뉴 · 폴더로 끌어서 옮기기', rowName(r), e.meta.name);
    card.onclick = () => openLibRange(e, s.id);
    card.oncontextmenu = (ev) => (ev.preventDefault(), rangeMenu(ev, r));
    card.ondragstart = (ev) => ev.dataTransfer.setData('application/x-refboard-range', JSON.stringify({ key: e.key, id: s.id }));
    frag.append(card);
  }
  list.append(frag);
}

// ---------- 동작 ----------

// 보드에서 그 구간을 반복: 같은 영상이 보드에 있으면 그리로, 없으면 올린다
async function openLibRange(e, segId) {
  const m = e.meta;
  const existing = [...app.items.values()].find((it) => isTimed(it) && libKey(it) === e.key);
  if (existing) {
    goToItem(existing);
    activateSegment(existing, segId);
    return;
  }
  const ref = m.file ? { file: m.file } : { sourceId: m.sourceId, path: m.path, size: m.size, mtime: m.mtime };
  if (!m.file && !app.sources.some((s) => s.id === m.sourceId)) return toast(tr('이 구간의 소스를 찾을 수 없습니다 (설정에서 지운 NAS 일 수 있습니다)'), 3000);
  const c = boardCenter();
  const it = await addItem({ kind: m.kind, ref, name: m.name, x: c.x, y: c.y, center: true, openSeg: segId });
  setTimeout(() => app.items.has(it.id) && goToItem(it), 600);
}

// 라이브러리에서 고친 것을 저장하고, 보드에 올라간 같은 영상에도 반영
async function patchRange(key, id, patch) {
  const segments = await rb.clips.update(key, id, patch);
  for (const it of app.items.values()) {
    if (!isTimed(it) || libKey(it) !== key) continue;
    it.segments = (segments || []).map((s) => ({ ...s }));
    if (!segActive(it)) it.activeSeg = null;
    renderSegments(it);
    markDirty();
  }
  clipLibChanged(key, segments || []);
  await reloadLibrary();
}

const moveToFolder = (key, id, folder) => patchRange(key, id, { folder });

function rangeMenu(ev, r) {
  const { e, s } = r;
  const moveItems = [{ label: tr('미분류'), icon: 'folder', checked: !s.folder, action: () => moveToFolder(e.key, s.id, null) }];
  const walk = (parent, depth) => {
    for (const f of childFolders(parent)) {
      moveItems.push({ label: `${'  '.repeat(depth)}${f.name}`, icon: 'folder', checked: s.folder === f.id, action: () => moveToFolder(e.key, s.id, f.id) });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  showMenu(ev.clientX, ev.clientY, [
    { header: `${rowName(r)} · ${e.meta.name}` },
    { label: tr('보드에서 이 구간 반복'), icon: 'loop', primary: true, action: () => openLibRange(e, s.id) },
    { label: s.name ? tr('이름 바꾸기…') : tr('이름 붙이기…'), icon: 'pen', action: () => renameRange(r) },
    { label: tr('태그…'), icon: 'tag', action: () => editTags(e.key, s) },
    'sep',
    { header: tr('폴더로 옮기기') },
    ...moveItems,
    { label: tr('새 폴더에 넣기…'), icon: 'plus', action: async () => { const f = await newFolder(null); if (f) moveToFolder(e.key, s.id, f.id); } },
    'sep',
    { label: tr('구간 삭제'), icon: 'trash', danger: true, action: () => deleteRange(r) },
  ]);
}

async function renameRange(r) {
  const v = await askText(tr('구간 이름'), r.s.name || '', tr('구간 이름'));
  if (v == null) return;
  await patchRange(r.e.key, r.s.id, { name: v.trim().slice(0, 60) });
}

async function deleteRange(r) {
  if (!confirm(tr('이 구간을 지울까요? ({0} · {1})', rowName(r), r.e.meta.name))) return;
  await patchRange(r.e.key, r.s.id, { delete: true });
}

// 태그: 쉼표나 띄어쓰기로 여러 개. 이미 쓰는 태그는 눌러서 넣는다
async function editTags(key, s, onBoardItem) {
  const known = [...new Set(libRows().flatMap((r) => r.s.tags || []))].sort();
  const v = await askText(tr('태그 (쉼표나 띄어쓰기로 여러 개)'), (s.tags || []).join(', '), tr('예: 걷기, 정면, 손'), known);
  if (v == null) return;
  const tags = v.split(/[,\s]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean);
  if (onBoardItem) {
    if (tags.length) s.tags = tags;
    else delete s.tags;
    saveSegments(onBoardItem);
    return;
  }
  await patchRange(key, s.id, { tags });
}

// ---------- 폴더 ----------

const newFolderId = () => 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function newFolder(parent) {
  const name = await askText(parent ? tr('하위 폴더 이름') : tr('새 폴더 이름'), '', tr('예: 걷기 / 달리기'));
  if (!name || !name.trim()) return null;
  const f = { id: newFolderId(), name: name.trim().slice(0, 60), parent: parent || null };
  if (L.folders.length === 0) L.folders = (await rb.clips.folders()) || [];
  L.folders = await rb.clips.setFolders([...L.folders, f]);
  if (parent) L.open.add(parent);
  if (L.on) renderLibrary();
  return f;
}

function folderMenu(ev, id) {
  const f = folderById(id);
  showMenu(ev.clientX, ev.clientY, [
    { header: folderPath(id) },
    { label: tr('하위 폴더 만들기…'), icon: 'plus', action: () => newFolder(id) },
    { label: tr('이름 바꾸기…'), icon: 'pen', action: async () => {
      const v = await askText(tr('폴더 이름'), f.name, '');
      if (!v || !v.trim()) return;
      L.folders = await rb.clips.setFolders(L.folders.map((x) => (x.id === id ? { ...x, name: v.trim() } : x)));
      renderLibrary();
    } },
    'sep',
    { label: tr('폴더 삭제 (안의 구간은 미분류로)'), icon: 'trash', danger: true, action: async () => {
      const ids = [...folderAndBelow(id)];
      if (!confirm(tr('"{0}" 폴더를 지울까요? 안에 있던 구간은 지워지지 않고 미분류로 옮겨집니다.', f.name))) return;
      await rb.clips.clearFolders(ids);
      L.folders = await rb.clips.setFolders(L.folders.filter((x) => !ids.includes(x.id)));
      if (ids.includes(L.folder)) L.folder = 'all';
      // 보드에 있는 같은 구간에서도 폴더를 지운다
      for (const it of app.items.values()) if (isTimed(it)) for (const s of it.segments) if (s.folder && ids.includes(s.folder)) delete s.folder;
      await reloadLibrary();
    } },
  ]);
}

// 보드의 구간 칩 메뉴에서: 폴더 고르기
async function boardSegFolderMenu(it, g, x, y) {
  if (!L.folders.length) L.folders = (await rb.clips.folders()) || [];
  const items = [{ header: tr('폴더로 옮기기') }, { label: tr('미분류'), icon: 'folder', checked: !g.folder, action: () => setBoardSegFolder(it, g, null) }];
  const walk = (parent, depth) => {
    for (const f of childFolders(parent)) {
      items.push({ label: `${'  '.repeat(depth)}${f.name}`, icon: 'folder', checked: g.folder === f.id, action: () => setBoardSegFolder(it, g, f.id) });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  items.push({ label: tr('새 폴더에 넣기…'), icon: 'plus', action: async () => { const f = await newFolder(null); if (f) setBoardSegFolder(it, g, f.id); } });
  showMenu(x, y, items);
}

function setBoardSegFolder(it, g, folder) {
  if (folder) g.folder = folder;
  else delete g.folder;
  saveSegments(it);
  toast(folder ? tr('"{0}" 폴더에 넣었습니다', folderPath(folder)) : tr('미분류로 옮겼습니다'));
}

// ---------- 글자 입력 창 ----------

function askText(title, value, placeholder, suggestions = []) {
  return new Promise((resolve) => {
    closeMenu();
    const modal = h('div', 'modal ask-modal');
    const card = h('div', 'modal-card ask-card');
    const inp = h('input', 'ask-input');
    inp.value = value || '';
    inp.placeholder = placeholder || '';
    inp.spellcheck = false;
    card.append(h('div', 'ask-title', title), inp);
    if (suggestions.length) {
      const sug = h('div', 'ask-sug');
      for (const t of suggestions) {
        const b = h('button', 'ltag', '#' + t);
        b.onclick = () => {
          const cur = inp.value.split(/[,\s]+/).filter(Boolean);
          if (!cur.includes(t)) inp.value = [...cur, t].join(', ');
          inp.focus();
        };
        sug.append(b);
      }
      card.append(sug);
    }
    const row = h('div', 'ask-row');
    const ok = h('button', 'btn primary', tr('확인'));
    const cancel = h('button', 'btn', tr('취소'));
    row.append(cancel, ok);
    card.append(row);
    modal.append(card);
    document.body.append(modal);
    const done = (v) => {
      modal.remove();
      resolve(v);
    };
    ok.onclick = () => done(inp.value);
    cancel.onclick = () => done(null);
    modal.onpointerdown = (ev) => ev.target === modal && done(null);
    inp.onkeydown = (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') done(inp.value);
      if (ev.key === 'Escape') done(null);
    };
    setTimeout(() => (inp.focus(), inp.select()), 0);
  });
}
