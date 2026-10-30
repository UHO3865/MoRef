'use strict';
/* global rb */

const $ = (s, el = document) => el.querySelector(s);
const h = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

const SPEEDS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const FRAME = 1 / 30;
const isTimed = (it) => it.kind === 'video' || it.kind === 'gif'; // 재생 컨트롤이 붙는 항목

// ---- 영상 프레임 (실제 프레임 레이트 기준) ----
// it.fps: ffprobe 로 읽은 값. 못 읽으면 재생 중 화면에 나온 프레임 간격으로 추정(it.estFps), 그것도 없으면 30.
const fpsOf = (it) => it.fps || it.estFps || 30;
// 영상 길이. 아직 받지 않은(멈춘) 영상은 ffprobe 로 읽은 값
const durOf = (it) => (isFinite(it.media.duration) && it.media.duration > 0 ? it.media.duration : it.probeDur || NaN);
function totalFrames(it) {
  if (it.kind === 'gif') return it.media.frameCount;
  const d = durOf(it);
  return it.frames || (isFinite(d) ? Math.max(1, Math.round(d * fpsOf(it))) : 0);
}
// 지금 화면에 나온 프레임 번호(0부터). 가능하면 Chromium 이 실제로 그린 프레임의 시각을 쓴다
function currentFrame(it) {
  const v = it.media;
  if (it.kind === 'gif') return v.frameIndex;
  const fps = fpsOf(it);
  if (it.pendingSeek != null) return Math.max(0, Math.floor(it.pendingSeek * fps + 0.01)); // 곧 그 프레임으로 간다
  const mt = it.mediaTime != null && !v.seeking && Math.abs(it.mediaTime - v.currentTime) < 1.5 / fps ? it.mediaTime : v.currentTime;
  return Math.max(0, Math.floor(mt * fps + 0.01));
}
// 프레임 경계에 정확히 맞추면 반올림 때문에 앞 프레임이 나올 수 있어, 프레임의 가운데로 이동한다
// 이동 중에 또 이동하면 Chromium 이 멈춰 버리는 경우가 있어(빠른 스크럽, 연속 키 입력),
// 이동이 끝날 때까지는 마지막 목표만 기억해 두었다가 끝나면 그리로 간다.
function seekFrame(it, n) {
  ensureLoaded(it);
  const max = Math.max(0, totalFrames(it) - 1);
  n = Math.max(0, Math.min(max, n));
  const t = (n + 0.5) / fpsOf(it);
  const v = it.media;
  if (v.seeking) {
    it.pendingSeek = t;
    if (!it.seekHooked) {
      it.seekHooked = true;
      v.addEventListener('seeked', () => {
        if (it.pendingSeek == null) return;
        const next = it.pendingSeek;
        it.pendingSeek = null;
        v.currentTime = next;
      });
    }
  } else {
    it.pendingSeek = null;
    v.currentTime = t;
  }
  return n;
}
function fpsLabel(it) {
  if (it.kind === 'gif') return '';
  const f = fpsOf(it);
  const txt = Math.abs(f - Math.round(f)) < 0.01 ? String(Math.round(f)) : f.toFixed(3);
  return it.fps ? `${txt} fps${it.vfr ? tr(' (가변 프레임 - 대략값)') : ''}` : it.estFps ? tr('{0} fps (재생 화면으로 추정)', txt) : tr('30 fps (확인 전 - 기본값)');
}

// 24x24 선 아이콘 (stroke = currentColor)
const ICONS = {
  play: '<path d="M6.6 5.2v13.6a.8.8 0 0 0 1.2.7l10.9-6.8a.8.8 0 0 0 0-1.4L7.8 4.5a.8.8 0 0 0-1.2.7z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="4.5" width="4.2" height="15" rx="1.2" fill="currentColor" stroke="none"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2" fill="currentColor" stroke="none"/>',
  prev: '<path d="M6 5v14"/><path d="M18.5 5.6v12.8a.6.6 0 0 1-.95.5L9.4 12.5a.6.6 0 0 1 0-1L17.55 5.1a.6.6 0 0 1 .95.5z" fill="currentColor" stroke="none"/>',
  next: '<path d="M18 5v14"/><path d="M5.5 5.6v12.8a.6.6 0 0 0 .95.5l8.15-6.4a.6.6 0 0 0 0-1L6.45 5.1a.6.6 0 0 0-.95.5z" fill="currentColor" stroke="none"/>',
  vol: '<path d="M4 9.5h3.2L12 5.6v12.8l-4.8-3.9H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z" fill="currentColor" stroke="none"/><path d="M15.5 9.2a4 4 0 0 1 0 5.6"/><path d="M18.2 6.6a7.6 7.6 0 0 1 0 10.8"/>',
  mute: '<path d="M4 9.5h3.2L12 5.6v12.8l-4.8-3.9H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z" fill="currentColor" stroke="none"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>',
  loop: '<path d="M17 3l3 3-3 3"/><path d="M4 11V9.5A3.5 3.5 0 0 1 7.5 6H20"/><path d="M7 21l-3-3 3-3"/><path d="M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H4"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  pen: '<path d="M4 20l1-4.2L15.6 5.2a2.1 2.1 0 0 1 3 0l.2.2a2.1 2.1 0 0 1 0 3L8.2 19z"/><path d="M13.5 7.3l3.2 3.2"/>',
  arrow: '<path d="M5 19L19 5"/><path d="M9.5 5H19v9.5"/>',
  circle: '<circle cx="12" cy="12" r="7.8"/>',
  eraser: '<path d="M9 20h11"/><path d="M4.7 13.8l8.6-8.6a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8L12 18.5a2 2 0 0 1-1.4.6H8.9a2 2 0 0 1-1.4-.6l-2.8-2.8a2 2 0 0 1 0-1.9z"/><path d="M9.2 9.3l6 6"/>',
  undo: '<path d="M9 14.5L4 9.5l5-5"/><path d="M4 9.5h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="M15 14.5l5-5-5-5"/><path d="M20 9.5H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  trash: '<path d="M4 7h16"/><path d="M9.5 7V4.8a.8.8 0 0 1 .8-.8h3.4a.8.8 0 0 1 .8.8V7"/><path d="M6.3 7l.9 12.2a1.9 1.9 0 0 0 1.9 1.8h5.8a1.9 1.9 0 0 0 1.9-1.8L17.7 7"/><path d="M10 11v6M14 11v6"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeOff: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/><path d="M4 4l16 16"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.5H15"/>',
  segAdd: '<path d="M4 7v10M20 7v10"/><path d="M4 12h9"/><path d="M16.5 9v6M13.5 12h6"/>',
  link: '<path d="M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2"/><path d="M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2"/>',
  mirror: '<path d="M12 3v18" stroke-dasharray="2 2.4"/><path d="M9 7v10L3.5 12z"/><path d="M15 7v10l5.5-5z" fill="currentColor"/>',
  flipV: '<path d="M3 12h18" stroke-dasharray="2 2.4"/><path d="M7 9h10L12 3.5z"/><path d="M7 15h10l-5 5.5z" fill="currentColor"/>',
  gray: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>',
  crop: '<path d="M6.5 2.5v15h15"/><path d="M2.5 6.5h15v15"/>',
  frames: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.3"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.3"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.3"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.3"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  onion: '<circle cx="7.5" cy="12" r="4.5" opacity=".4"/><circle cx="12" cy="12" r="4.5" opacity=".7"/><circle cx="16.5" cy="12" r="4.5"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 15.5 15 10l-8 9"/>',
  target: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/><path d="M12 1.8v3M12 19.2v3M1.8 12h3M19.2 12h3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  tag: '<path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1 1 0 0 1 0 1.4l-7.3 7.3a1 1 0 0 1-1.4 0z"/><circle cx="8" cy="8" r="1.6"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  markA: '<path d="M7 4v16"/><path d="M7 5h9l-2.5 3.5L16 12H7"/>',
  markB: '<path d="M17 4v16"/><path d="M17 5H8l2.5 3.5L8 12h9"/>',
  grip: '<g fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></g>',
};
const icon = (name) =>
  `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

const app = {
  proxyBase: '',
  sources: [],
  settings: {},
  // 탐색 패널
  sourceId: null,
  cwd: '',
  entries: [],
  listCache: new Map(), // 키 → { entries, at }
  listSource: null,
  cardByKey: new Map(), // 보드 키 → 패널 카드
  boardCount: new Map(), // 보드 키 → 보드에 올라간 개수
  pendingLocate: null,
  menu: null,
  blender: null, // 도킹 모드: Blender 타임라인 { frame, fps, playing }
  clipLib: {}, // 파일별 저장 구간 (패널 표시용) 키 → 구간 목록
  panelOpen: new Set(), // 패널에서 구간 썸네일 줄을 펼쳐 둔 카드
  // 보드
  view: { x: 0, y: 0, s: 1 },
  items: new Map(),
  selected: new Set(),
  z: 1,
  boardFile: null,
  dirty: false,
  // 그리기
  draw: { on: false, tool: 'pen', color: '#ff3b30', width: 4 },
  undo: [],
  redo: [],
};

function toast(msg, ms = 1600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}

const fmtTime = (t) => {
  if (!isFinite(t)) return '0:00';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};
const fmtSize = (b) => (b > 1e9 ? (b / 1e9).toFixed(1) + 'GB' : b > 1e6 ? (b / 1e6).toFixed(0) + 'MB' : '');

function mediaUrl(ref) {
  if (ref.file) return rb.fileUrl(ref.file);
  const enc = ref.path.split('/').map(encodeURIComponent).join('/');
  return Promise.resolve(`${app.proxyBase}/s/${encodeURIComponent(ref.sourceId)}/${enc}`);
}

/* =====================================================================
 * 탐색 패널
 * ===================================================================*/

function renderSourceSelect() {
  const sel = $('#sourceSelect');
  sel.innerHTML = '';
  if (!app.sources.length) {
    sel.append(new Option(tr('소스 없음 - ⚙ 에서 추가'), ''));
    return;
  }
  for (const s of app.sources) sel.append(new Option(s.name, s.id));
  sel.value = app.sourceId || '';
}

// 폴더 열기: 메모리/디스크에 저장된 목록을 먼저 보여 주고, NAS 에서 새로 받아 바뀌었으면 다시 그린다
const LIST_FRESH_MS = 15000;

async function openFolder(rel, { refresh = false } = {}) {
  if (!app.sourceId) {
    app.entries = [];
    renderGrid();
    $('#crumbs').innerHTML = '';
    $('#listInfo').textContent = tr('연결된 소스가 없습니다.');
    return;
  }
  const changedFolder = app.cwd !== rel || app.listSource !== app.sourceId;
  if (changedFolder) rb.thumb.cancel();
  app.cwd = rel;
  app.listSource = app.sourceId;
  renderCrumbs();
  const sourceId = app.sourceId;
  const key = `${sourceId}|${rel}`;
  const stillHere = () => app.cwd === rel && app.sourceId === sourceId;
  const info = $('#listInfo');
  info.classList.remove('error');

  let shown = null;
  const mem = app.listCache.get(key);
  if (mem && !refresh) {
    shown = mem.entries;
    showEntries(shown, changedFolder);
    if (Date.now() - mem.at < LIST_FRESH_MS) return finishOpen(rel);
  } else if (!refresh) {
    const disk = await rb.source.listCached(sourceId, rel);
    if (!stillHere()) return;
    if (disk) {
      shown = disk;
      showEntries(shown, changedFolder);
    }
  }
  if (!shown) {
    info.textContent = tr('불러오는 중…');
    vg.list = [];
    vg.index.clear();
    clearGridCards();
    relayoutGrid();
  } else {
    info.textContent += tr(' · 새로 고치는 중…');
  }

  // 오래 걸리면: 절전 중이던 NAS 가 깨어나는 중일 수 있다
  const slow = setTimeout(() => {
    if (stillHere() && !shown) info.textContent = tr('NAS 응답을 기다리는 중… (절전 중이던 NAS 는 깨어나는 데 10~30초 걸릴 수 있습니다)');
  }, 2500);
  const r = await rb.source.list(sourceId, rel);
  clearTimeout(slow);
  if (!stillHere()) return;
  if (r.error) {
    if (shown) {
      info.textContent = tr('폴더 {0} · 파일 {1} (저장된 목록 - 새로 고침 실패: {2})', countDirs(shown), shown.length - countDirs(shown), r.error);
    } else {
      info.textContent = tr('불러오기 실패: {0} - ⟳ 로 다시 시도', r.error);
      info.classList.add('error');
    }
    return;
  }
  app.listCache.set(key, { entries: r.entries, at: Date.now() });
  if (!shown || JSON.stringify(shown) !== JSON.stringify(r.entries)) showEntries(r.entries, !shown && changedFolder);
  else updateListInfo();
  finishOpen(rel);
}

const countDirs = (list) => list.filter((e) => e.kind === 'dir').length;

function showEntries(entries, resetFilter) {
  const grid = $('#grid');
  const scroll = grid.scrollTop;
  app.entries = entries;
  if (resetFilter) $('#filter').value = '';
  renderGrid();
  if (!resetFilter) grid.scrollTop = scroll; // 새로 고침으로 다시 그릴 때는 보던 자리 유지
}

function finishOpen(rel) {
  rb.setSetting('lastFolder', { sourceId: app.sourceId, path: rel });
  if (app.pendingLocate) {
    const k = app.pendingLocate;
    app.pendingLocate = null;
    flashCard(k);
  }
}

function renderCrumbs() {
  const c = $('#crumbs');
  c.innerHTML = '';
  const src = app.sources.find((s) => s.id === app.sourceId);
  const parts = app.cwd ? app.cwd.split('/') : [];
  const root = h('span', '', src ? src.name : '/');
  root.onclick = () => openFolder('');
  c.append(root);
  parts.forEach((p, i) => {
    c.append(document.createTextNode('/'));
    const s = h('span', '', p);
    s.onclick = () => openFolder(parts.slice(0, i + 1).join('/'));
    c.append(s);
  });
}

// ---------- 썸네일: 보이는 카드는 먼저(high), 근처 카드는 미리(low), 멀어지면 취소 ----------

const gridEl = document.getElementById('grid');
const nearObserver = new IntersectionObserver(
  (records) => {
    for (const r of records) {
      const card = r.target;
      if (r.isIntersecting) requestThumb(card, 'low');
      else if (card.thumbState === 'pending') {
        rb.thumb.drop(thumbEntry(card));
        card.thumbState = null;
      }
    }
  },
  { root: gridEl, rootMargin: '700px 0px' }
);
const visibleObserver = new IntersectionObserver(
  (records) => {
    for (const r of records) if (r.isIntersecting) requestThumb(r.target, 'high');
  },
  { root: gridEl }
);

const thumbEntry = (card) => {
  const e = card._entry;
  return { sourceId: card._sourceId, path: e.path, size: e.size, mtime: e.mtime, kind: e.kind };
};

// 받은 썸네일 결과: 화면 밖으로 나갔다가 다시 그려지는 카드에 바로 붙인다 (다시 묻지 않음)
const thumbDone = new Map(); // 소스|경로|크기|수정시각 → { url } | { error }
const thumbKey = (card) => `${card._sourceId}|${card._entry.path}|${card._entry.size}|${card._entry.mtime}`;

function applyThumb(card, r) {
  const th = $('.th', card);
  if (r.url) {
    card.thumbState = 'done';
    th.style.backgroundImage = `url("${r.url}")`;
    th.firstChild.textContent = '';
  } else {
    card.thumbState = 'error';
    th.title = tr(r.error); // 썸네일 실패 기록(한국어 원문)도 번역
    th.firstChild.textContent = '⚠';
  }
  nearObserver.unobserve(card);
  visibleObserver.unobserve(card);
}

async function requestThumb(card, pri) {
  if (card.thumbState === 'done' || card.thumbState === 'error') return;
  if (card.thumbState === 'pending' && (pri === 'low' || card.thumbPri === 'high')) return;
  card.thumbState = 'pending';
  card.thumbPri = pri;
  const r = await rb.thumb.get(thumbEntry(card), pri);
  if (r.url || r.error) thumbDone.set(thumbKey(card), r);
  if (!card.isConnected) return;
  if (r.url || r.error) applyThumb(card, r);
  else if (card.thumbState === 'pending') {
    card.thumbState = null; // 취소됨 → 다시 보이면 재요청
  }
}

const boardKey = (sourceId, p) => `${sourceId}|${p}`;

// ---------- 패널 목록: 보이는 줄(+ 위아래 여유)의 카드만 만든다 ----------
// 파일이 수만 개인 폴더에서 카드를 전부 만들면 화면 메모리가 수백 MB 늘고 스크롤이 끊긴다
// (3만 개: +860MB, 프레임 110ms). 목록은 "줄" 단위로 나누고, 화면 밖 줄은 위아래 빈 칸(spacer)의 높이로만 둔다.
//  * 한 줄 = 카드 cols 개. 구간 썸네일 줄을 펼친 카드가 있으면 그 카드에서 줄이 끝나고 펼친 줄이 같은 블록에 붙는다.
//  * 줄 높이는 처음엔 계산한 값, 그려 본 뒤에는 잰 값. 위쪽 줄 높이가 바뀌면 보던 자리가 흔들리지 않게 스크롤을 맞춘다.
const GRID_OVERSCAN = 700; // 화면 위아래로 이만큼 더 그린다 (근처 썸네일 미리 받기와 같은 거리)

const vg = {
  list: [], // 필터를 거친 항목
  index: new Map(), // 보드 키 → list 안 위치
  blocks: [], // { start, end, seg } (list 범위, seg = 펼친 구간 줄이 붙은 블록)
  offs: new Float64Array(1), // 블록 i 의 위쪽 = offs[i] (블록 사이 간격 포함)
  measured: new Map(), // 블록 번호 → 잰 높이
  est: { file: 0, dir: 0, width: 0, cols: 0 }, // 잰 카드 줄 높이 (너비 / 열 수가 바뀌면 다시)
  cards: new Map(), // list 위치 → 카드 (지금 그려진 것)
  from: 0,
  to: 0,
  top: null,
  bottom: null,
  raf: 0,
};

const gridCols = () => Number(gridEl.style.getPropertyValue('--cols')) || 3;
const GRID_GAP = 6;

function renderGrid() {
  const q = $('#filter').value.trim().toLowerCase();
  vg.list = q ? app.entries.filter((e) => e.name.toLowerCase().includes(q)) : app.entries;
  vg.index = new Map();
  vg.list.forEach((e, i) => e.kind !== 'dir' && vg.index.set(boardKey(app.sourceId, e.path), i));
  updateListInfo(vg.list);
  clearGridCards();
  relayoutGrid();
}

function clearGridCards() {
  for (const card of vg.cards.values()) dropCard(card);
  vg.cards.clear();
  app.cardByKey.clear();
  vg.top = h('div', 'grid-spacer');
  vg.bottom = h('div', 'grid-spacer');
  gridEl.replaceChildren(vg.top, vg.bottom);
}

// 블록 나누기 (항목 / 열 수 / 펼친 구간이 바뀔 때)
function relayoutGrid() {
  if (!vg.top) clearGridCards(); // 처음 (썸네일 크기 단계를 정할 때 불릴 수 있다)
  const cols = gridCols();
  const blocks = [];
  let start = 0;
  for (let i = 0; i < vg.list.length; i++) {
    const e = vg.list[i];
    const seg = e.kind !== 'dir' && app.panelOpen.has(boardKey(app.sourceId, e.path)) && app.clipLib[boardKey(app.sourceId, e.path)]?.length > 0;
    if (seg || i - start + 1 === cols || i === vg.list.length - 1) {
      blocks.push({ start, end: i + 1, seg, file: vg.list.slice(start, i + 1).some((x) => x.kind !== 'dir') });
      start = i + 1;
    }
  }
  vg.blocks = blocks;
  vg.measured.clear();
  computeOffsets();
  renderWindow();
}

function blockHeight(i) {
  const m = vg.measured.get(i);
  if (m != null) return m;
  const b = vg.blocks[i];
  const row = b.file ? vg.est.file : vg.est.dir;
  return b.seg ? row + GRID_GAP + 150 : row;
}

function computeOffsets() {
  const w = gridEl.clientWidth;
  const cols = gridCols();
  if (w !== vg.est.width || cols !== vg.est.cols) {
    // 아직 재 보지 못한 줄: 너비로 계산 (카드 = 16:9 썸네일 + 이름 한 줄 + 테두리)
    const cardW = Math.max(40, (w - 12 - GRID_GAP * (cols - 1)) / cols);
    const card = Math.round((cardW * 9) / 16) + 19;
    vg.est = { width: w, cols, file: card, dir: cols === 1 ? 38 : card };
    vg.measured.clear();
  }
  const n = vg.blocks.length;
  const offs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) offs[i + 1] = offs[i] + blockHeight(i) + GRID_GAP;
  vg.offs = offs;
}

// offs 에서 y 를 넘지 않는 마지막 블록
function blockAt(y) {
  let lo = 0;
  let hi = vg.blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (vg.offs[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

function scheduleGridWindow() {
  if (vg.raf) return;
  vg.raf = requestAnimationFrame(() => {
    vg.raf = 0;
    renderWindow();
  });
}

function renderWindow() {
  if (!gridEl.clientWidth) return; // 패널이 숨겨져 있음 (구간 탭 / 패널 닫기): 다시 보일 때 그린다
  for (let pass = 0; pass < 3; pass++) {
    const n = vg.blocks.length;
    const pad = 2; // .grid 의 위쪽 안쪽 여백
    const y0 = gridEl.scrollTop - pad - GRID_OVERSCAN;
    const y1 = gridEl.scrollTop - pad + gridEl.clientHeight + GRID_OVERSCAN;
    const from = n ? blockAt(Math.max(0, y0)) : 0;
    let to = n ? blockAt(y1) + 1 : 0;
    to = Math.min(n, to);
    drawBlocks(from, to);
    if (!measureBlocks()) break; // 잰 높이가 어림과 같으면 끝, 다르면 다시 계산해서 한 번 더
  }
}

function drawBlocks(from, to) {
  vg.from = from;
  vg.to = to;
  const first = from < to ? vg.blocks[from].start : 0;
  const last = from < to ? vg.blocks[to - 1].end : 0;
  // 범위 밖 카드 치우기
  for (const [i, card] of vg.cards) {
    if (i < first || i >= last) {
      dropCard(card);
      vg.cards.delete(i);
    }
  }
  // 위쪽 빈 칸: 앞 블록들의 높이 (뒤따르는 간격 하나는 grid gap 이 채운다)
  const topH = vg.offs[from] - GRID_GAP;
  vg.top.style.display = from > 0 ? '' : 'none';
  vg.top.style.height = Math.max(0, topH) + 'px';
  const bottomH = vg.offs[vg.blocks.length] - vg.offs[to] - GRID_GAP;
  vg.bottom.style.display = to < vg.blocks.length ? '' : 'none';
  vg.bottom.style.height = Math.max(0, bottomH) + 'px';
  // 순서대로 끼워 넣기 (이미 있는 카드는 옮기지 않는다: 마우스 올림 / 끌기가 끊기지 않게)
  let cursor = vg.top.nextSibling;
  for (let i = first; i < last; i++) {
    let card = vg.cards.get(i);
    if (card) {
      cursor = (card._segRow || card).nextSibling;
      continue;
    }
    card = makeCard(vg.list[i]);
    vg.cards.set(i, card);
    gridEl.insertBefore(card, cursor);
    if (card._key) decorateCard(card); // 저장된 구간 표시 / 펼친 구간 썸네일 (카드 바로 뒤에 붙는다)
  }
}

// 그려진 블록의 실제 높이를 잰다. 어림과 달랐으면 true
function measureBlocks() {
  let changed = false;
  const scrollTop = gridEl.scrollTop;
  for (let b = vg.from; b < vg.to; b++) {
    const blk = vg.blocks[b];
    const card = vg.cards.get(blk.start);
    if (!card) continue;
    const lastEl = blk.seg ? vg.cards.get(blk.end - 1)?._segRow : null;
    // 소수점까지 (offsetHeight 는 반올림돼서 수백 줄을 지나면 몇 px 씩 어긋난다)
    const r0 = card.getBoundingClientRect();
    const hgt = lastEl ? lastEl.getBoundingClientRect().bottom - r0.top : r0.height;
    if (!hgt) continue; // 패널이 숨겨져 있음
    const old = blockHeight(b);
    if (!blk.seg) {
      // 같은 종류의 줄은 높이가 같다: 한 번 재면 아직 안 그린 줄도 그 값으로
      const kind = blk.file ? 'file' : 'dir';
      if (Math.abs(vg.est[kind] - hgt) > 0.01) {
        vg.est[kind] = hgt;
        changed = true;
      }
    } else if (Math.abs(old - hgt) > 0.5) {
      vg.measured.set(b, hgt);
      changed = true;
    }
  }
  if (!changed) return false;
  // 보던 자리 유지: 첫 그려진 블록의 위치가 바뀐 만큼 스크롤도 옮긴다
  const before = vg.offs[vg.from];
  computeOffsets();
  const delta = vg.offs[vg.from] - before;
  if (delta && vg.from > 0) gridEl.scrollTop = scrollTop + delta;
  return true;
}

function dropCard(card) {
  nearObserver.unobserve(card);
  visibleObserver.unobserve(card);
  if (card.thumbState === 'pending') rb.thumb.drop(thumbEntry(card));
  card._segRow?.remove();
  card.remove();
  if (card._key && app.cardByKey.get(card._key) === card) app.cardByKey.delete(card._key);
}

function makeCard(e) {
  const card = h('div', 'card ' + e.kind);
  card._entry = e;
  card._sourceId = app.sourceId;
  card.title = e.name;
  const th = h('div', 'th');
  th.append(h('span', '', e.kind === 'dir' ? '📁' : e.kind === 'image' ? '🖼' : '🎞'));
  if (e.kind === 'video' && e.size) th.append(h('span', 'badge', fmtSize(e.size)));
  if (e.kind === 'gif') th.append(h('span', 'badge', 'GIF'));
  card.append(th, h('div', 'nm', e.name));
  card.oncontextmenu = (ev) => {
    ev.preventDefault();
    cardMenu(ev, card);
  };
  if (e.kind === 'dir') {
    card.onclick = () => openFolder(e.path);
    return card;
  }
  card.title = `${e.name}\n${tr('꾹 누르고 있으면 미리 보기')}`; // peek.js
  const key = boardKey(app.sourceId, e.path);
  card._key = key;
  app.cardByKey.set(key, card);
  card.draggable = true;
  card.ondblclick = () => addFromEntry(e);
  card.ondragstart = (ev) => {
    ev.dataTransfer.setData('application/x-refboard', JSON.stringify({ sourceId: app.sourceId, entry: e }));
    ev.dataTransfer.effectAllowed = 'copy';
  };
  markCard(card);
  const done = thumbDone.get(thumbKey(card));
  if (done) applyThumb(card, done);
  else {
    nearObserver.observe(card);
    visibleObserver.observe(card);
  }
  return card;
}

// 펼친 구간 줄이 열리거나 닫히거나 구간 수가 바뀌면 (segthumbs.js): 블록을 다시 나눈다
function gridSegsChanged() {
  const keep = gridEl.scrollTop;
  relayoutGrid();
  gridEl.scrollTop = keep;
  renderWindow();
}

// 목록 안의 파일 카드로 스크롤해서 그려 둔다 (화면 밖이라 아직 카드가 없을 수 있다)
function ensureCard(key) {
  const i = vg.index.get(key);
  if (i == null) return null;
  if (!vg.cards.has(i)) {
    const b = vg.blocks.findIndex((x) => i >= x.start && i < x.end);
    gridEl.scrollTop = Math.max(0, vg.offs[b] - gridEl.clientHeight / 2);
    renderWindow();
  }
  return vg.cards.get(i) || null;
}

function initGridWindow() {
  gridEl.addEventListener('scroll', scheduleGridWindow, { passive: true });
  // 패널 너비 / 창 높이가 바뀌면: 카드 크기가 달라지니 다시 계산
  new ResizeObserver(() => {
    if (!gridEl.clientWidth) return;
    if (gridEl.clientWidth !== vg.est.width) {
      computeOffsets();
      renderWindow();
    } else scheduleGridWindow();
  }).observe(gridEl);
}

function updateListInfo(list = app.entries) {
  const nDir = countDirs(list);
  const onBoard = list.filter((e) => e.kind !== 'dir' && app.boardCount.get(boardKey(app.sourceId, e.path))).length;
  $('#listInfo').textContent = tr('폴더 {0} · 파일 {1}', nDir, list.length - nDir) + (onBoard ? tr(' · 보드에 {0}', onBoard) : '');
}

// ---------- 보드에 올라간 영상 표시 ----------

function markCard(card) {
  const n = app.boardCount.get(card._key) || 0;
  card.classList.toggle('on-board', n > 0);
  let tag = $('.ob', card);
  if (!n) return tag?.remove();
  if (!tag) {
    tag = h('span', 'ob');
    tag.title = tr('보드에 올라가 있음 - 우클릭: 보드에서 보기');
    $('.th', card).append(tag);
  }
  tag.innerHTML = icon('check') + (n > 1 ? `<b>${n}</b>` : '');
}

function boardChanged(it, delta) {
  if (!it.ref.sourceId) return;
  const key = boardKey(it.ref.sourceId, it.ref.path);
  const n = (app.boardCount.get(key) || 0) + delta;
  if (n > 0) app.boardCount.set(key, n);
  else app.boardCount.delete(key);
  const card = app.cardByKey.get(key);
  if (card && card._sourceId === it.ref.sourceId) markCard(card);
  clearTimeout(boardChanged.t);
  boardChanged.t = setTimeout(() => updateListInfo(), 50);
}

function flashCard(key) {
  const card = ensureCard(key);
  if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card.classList.remove('flash');
  void card.offsetWidth;
  card.classList.add('flash');
}

// 보드 항목 → 패널에서 해당 파일 위치 보여 주기
function locateInPanel(it) {
  if (!it.ref.sourceId) return toast(tr('탐색기에서 끌어온 파일이라 패널 위치가 없습니다'));
  if (document.body.classList.contains('panel-hidden')) togglePanel();
  const key = boardKey(it.ref.sourceId, it.ref.path);
  const dir = it.ref.path.split('/').slice(0, -1).join('/');
  if (app.sourceId === it.ref.sourceId && app.cwd === dir && vg.index.has(key)) return flashCard(key);
  app.pendingLocate = key;
  if (app.sourceId !== it.ref.sourceId) {
    app.sourceId = it.ref.sourceId;
    renderSourceSelect();
  }
  $('#filter').value = '';
  openFolder(dir);
}

function cardMenu(ev, card) {
  const e = card._entry;
  if (e.kind === 'dir') {
    return showMenu(ev.clientX, ev.clientY, [{ label: tr('폴더 열기'), icon: 'folder', action: () => openFolder(e.path) }]);
  }
  const onBoard = [...app.items.values()].filter((it) => it.ref.sourceId === card._sourceId && it.ref.path === e.path);
  const items = [];
  if (onBoard.length) {
    items.push({
      label: onBoard.length > 1 ? tr('보드에서 보기 ({0}개 중 다음)', onBoard.length) : tr('보드에서 보기'),
      icon: 'target',
      primary: true,
      action: () => {
        const i = (card._goIdx = ((card._goIdx ?? -1) + 1) % onBoard.length);
        goToItem(onBoard[i]);
      },
    });
  }
  items.push({ label: onBoard.length ? tr('보드에 하나 더 올리기') : tr('보드에 올리기'), icon: 'plus', hint: tr('더블클릭'), action: () => addFromEntry(e) });
  if (onBoard.length) {
    items.push({ label: tr('보드에서 모두 닫기'), icon: 'x', danger: true, action: () => onBoard.forEach(removeItem) });
  }
  items.push('sep', {
    label: tr('경로 복사'),
    icon: 'copy',
    action: () => {
      const src = app.sources.find((s) => s.id === card._sourceId);
      const full = src?.type === 'local' ? src.url.replace(/[\\/]+$/, '') + '\\' + e.path.replaceAll('/', '\\') : (src?.url || '') + e.path;
      rb.copyText(full);
      toast(tr('경로를 복사했습니다'));
    },
  });
  showMenu(ev.clientX, ev.clientY, items);
}

function addFromEntry(e, at) {
  const c = at || boardCenter();
  addItem({ kind: e.kind, ref: { sourceId: app.sourceId, path: e.path, size: e.size, mtime: e.mtime }, name: e.name, x: c.x, y: c.y, center: true });
}

function initPanel() {
  $('#sourceSelect').onchange = (e) => {
    app.sourceId = e.target.value || null;
    openFolder('');
  };
  $('#btnRefresh').onclick = () => openFolder(app.cwd, { refresh: true });
  $('#btnUp').onclick = goUp;
  $('#filter').oninput = renderGrid;
  initGridWindow();
  initThumbSlider();
  $('#btnPanel').onclick = togglePanel;

  // 패널 너비 조절
  $('#panelResizer').onpointerdown = (ev) => {
    const startX = ev.clientX;
    const startW = $('#panel').offsetWidth;
    ev.target.setPointerCapture(ev.pointerId);
    ev.target.onpointermove = (m) => {
      const w = Math.max(180, Math.min(window.innerWidth - 200, startW + m.clientX - startX));
      document.documentElement.style.setProperty('--panel-w', w + 'px');
    };
    ev.target.onpointerup = () => {
      ev.target.onpointermove = null;
      rb.setSetting('panelWidth', $('#panel').offsetWidth);
    };
  };
}

// ---------- 썸네일 크기 (정해진 단계에 자석처럼 붙는 슬라이더) ----------

const THUMB_COLS = [4, 3, 2, 1]; // 왼쪽 = 작게(많이), 오른쪽 = 크게
const SNAP_STEP = 100; // 슬라이더 값: 단계 i 의 위치 = i * 100
const SNAP_PULL = 28; // 단계에서 이만큼 안쪽이면 끌려 붙는다

function gridIcon(n) {
  const gap = n === 1 ? 0 : 1.6;
  const cell = (16 - gap * (n - 1)) / n;
  let rects = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      rects += `<rect x="${x * (cell + gap)}" y="${y * (cell + gap)}" width="${cell}" height="${cell}" rx="${n === 1 ? 3 : 1}"/>`;
    }
  }
  return `<svg viewBox="0 0 16 16" fill="currentColor">${rects}</svg>`;
}

function setThumbStep(i, save = true) {
  app.thumbStep = i;
  const cols = THUMB_COLS[i];
  const grid = $('#grid');
  grid.style.setProperty('--cols', cols);
  grid.className = 'grid c' + cols;
  // 한 줄 카드 수가 바뀌면 줄을 다시 나눈다 (보던 위치는 비율로 유지)
  const ratio = grid.scrollHeight > grid.clientHeight ? grid.scrollTop / (grid.scrollHeight - grid.clientHeight) : 0;
  relayoutGrid();
  if (ratio) {
    grid.scrollTop = ratio * (grid.scrollHeight - grid.clientHeight);
    renderWindow();
  }
  for (const [k, b] of [...$('#gridIcons').children].entries()) b.classList.toggle('on', k === i);
  if (save) rb.setSetting('thumbStep', i);
}

function paintSlider() {
  const v = app.thumbVal;
  const snap = $('#thumbSize');
  snap.style.setProperty('--p', v / thumbMax());
  snap.setAttribute('aria-valuenow', app.thumbStep);
  snap.classList.toggle('stuck', Math.abs(v - app.thumbStep * SNAP_STEP) < 1);
  for (const [k, t] of [...$('#snapTicks').children].entries()) {
    t.classList.toggle('passed', k * SNAP_STEP < v);
    t.classList.toggle('on', Math.abs(k * SNAP_STEP - v) < 1);
  }
}

const thumbMax = () => (THUMB_COLS.length - 1) * SNAP_STEP;

// 손잡이를 단계 위치로 부드럽게 옮긴다
function glideSlider(to) {
  cancelAnimationFrame(glideSlider.raf);
  const from = app.thumbVal;
  const t0 = performance.now();
  const dur = 170;
  const frame = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    app.thumbVal = from + (to - from) * (1 - Math.pow(1 - k, 3));
    paintSlider();
    if (k < 1) glideSlider.raf = requestAnimationFrame(frame);
  };
  glideSlider.raf = requestAnimationFrame(frame);
}

function goThumbStep(i) {
  i = Math.max(0, Math.min(THUMB_COLS.length - 1, i));
  if (i !== app.thumbStep) setThumbStep(i);
  glideSlider(i * SNAP_STEP);
}

function initThumbSlider() {
  const snap = $('#thumbSize');
  const last = THUMB_COLS.length - 1;
  const ticks = $('#snapTicks');
  const icons = $('#gridIcons');
  THUMB_COLS.forEach((cols, i) => {
    const pos = (i / last) * 100 + '%';
    const t = h('i');
    t.style.left = pos;
    ticks.append(t);
    const b = h('button');
    b.innerHTML = gridIcon(cols);
    b.title = cols === 1 ? tr('한 줄에 1개 (가장 크게)') : tr('한 줄에 {0}개', cols);
    b.style.left = pos;
    b.onclick = () => goThumbStep(i);
    icons.append(b);
  });

  // 손잡이 중심이 움직이는 범위 = 양 끝에서 손잡이 반지름만큼 안쪽
  const valueAt = (clientX) => {
    const r = snap.getBoundingClientRect();
    const knob = parseFloat(getComputedStyle(snap).getPropertyValue('--knob')) || 16;
    const f = (clientX - r.left - knob / 2) / (r.width - knob);
    return Math.min(1, Math.max(0, f)) * thumbMax();
  };
  const dragTo = (clientX) => {
    let v = valueAt(clientX);
    const i = Math.round(v / SNAP_STEP);
    if (Math.abs(v - i * SNAP_STEP) < SNAP_PULL) v = i * SNAP_STEP; // 자석
    app.thumbVal = v;
    if (i !== app.thumbStep) setThumbStep(i);
    paintSlider();
  };
  snap.onpointerdown = (e) => {
    if (e.button !== 0) return;
    cancelAnimationFrame(glideSlider.raf);
    snap.setPointerCapture(e.pointerId);
    snap.classList.add('dragging');
    snap.focus();
    dragTo(e.clientX);
    snap.onpointermove = (m) => dragTo(m.clientX);
    snap.onpointerup = snap.onpointercancel = () => {
      snap.onpointermove = snap.onpointerup = snap.onpointercancel = null;
      snap.classList.remove('dragging');
      goThumbStep(Math.round(app.thumbVal / SNAP_STEP)); // 놓으면 가까운 단계로
    };
  };
  snap.onkeydown = (e) => {
    const d = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    goThumbStep(app.thumbStep + d);
  };
  snap.setAttribute('aria-valuemin', 0);
  snap.setAttribute('aria-valuemax', last);

  const saved = app.settings.thumbStep;
  const i = Number.isInteger(saved) && saved >= 0 && saved <= last ? saved : 1;
  setThumbStep(i, false);
  app.thumbVal = i * SNAP_STEP;
  paintSlider();
}

function goUp() {
  if (!app.cwd) return;
  openFolder(app.cwd.split('/').slice(0, -1).join('/'));
}

function togglePanel() {
  document.body.classList.toggle('panel-hidden');
  rb.setSetting('panelHidden', document.body.classList.contains('panel-hidden'));
}

/* =====================================================================
 * 보드
 * ===================================================================*/

const board = document.getElementById('board');
const itemsEl = document.getElementById('items');

function boardCenter() {
  return screenToBoard(board.clientWidth / 2, board.clientHeight / 2);
}
function screenToBoard(sx, sy) {
  return { x: (sx - app.view.x) / app.view.s, y: (sy - app.view.y) / app.view.s };
}
function clientToBoard(cx, cy) {
  const r = board.getBoundingClientRect();
  return screenToBoard(cx - r.left, cy - r.top);
}

function layoutItem(it) {
  const { x, y, s } = app.view;
  const st = it.el.style;
  st.left = it.x * s + x + 'px';
  st.top = it.y * s + y + 'px';
  st.width = it.w * s + 'px';
  st.height = it.h * s + 'px';
  st.zIndex = it.z;
  it.el.classList.toggle('tiny', it.w * s < 220);
  // 아주 작으면 이름 · 닫기 · 가운데 재생 버튼을 숨긴다 (닫기는 Delete / 우클릭)
  it.el.classList.toggle('micro', it.w * s < 90 || it.h * s < 56);
  positionCtl(it);
  const vb = `0 0 1 ${it.h / it.w}`;
  if (it.svg.getAttribute('viewBox') !== vb) it.svg.setAttribute('viewBox', vb);
}

// PureRef 처럼 재생 바를 레퍼런스 바로 아래에 둔다 (화면 크기 고정, 확대/축소와 무관)
const CTL_MIN_W = 150;
function positionCtl(it) {
  const bar = it.ctlEl;
  if (!bar) return;
  const { x, y, s } = app.view;
  const left = it.x * s + x;
  const top = it.y * s + y;
  const w = it.w * s;
  const bw = Math.max(w, CTL_MIN_W);
  const bh = (it.ctlH ||= bar.offsetHeight || 50);
  let bt = top + it.h * s + 6;
  const maxTop = board.clientHeight - bh - 4;
  if (bt > maxTop) bt = Math.max(top + 4, maxTop); // 화면 아래로 넘치면 화면 안으로 끌어올린다
  positionSide(it);
  // 바가 레퍼런스보다 넓을 때: 옆의 구간 썸네일 줄 쪽으로는 넘치지 않게 반대쪽으로 늘린다
  const side = it.sideEl?.classList.contains('has') ? (it.sideEl.classList.contains('left') ? 'left' : 'right') : null;
  const bl = bw <= w ? left : side === 'right' ? left + w - bw : side === 'left' ? left : left + (w - bw) / 2;
  bar.style.left = bl + 'px';
  bar.style.top = bt + 'px';
  bar.style.width = bw + 'px';
  bar.style.zIndex = it.z;
  // 폭에 따라 덜 중요한 것부터 숨긴다 (small: 총 길이 · tiny: 시간 · micro: 프레임 이동 버튼)
  bar.classList.toggle('small', bw < 420);
  bar.classList.toggle('tiny', bw < 300);
  bar.classList.toggle('micro', bw < 230);
  bar.classList.toggle('nano', bw < 190); // 재생 · 프레임 번호 · 구간 칩만
}

// 보일 때: 마우스가 항목이나 바 위에 있을 때, 선택됐을 때, 속도 목록이 열려 있을 때
function refreshCtl(it) {
  const keep = it.ctlEl?.classList.contains('menu-open') || it.ctlEl?.classList.contains('editing');
  it.ctlEl?.classList.toggle('show', !!(it.hover || app.selected.has(it) || keep));
  refreshSideVisibility(it);
}

function setHover(it, on) {
  clearTimeout(it.hoverTimer);
  if (on) {
    it.hover = true;
    refreshCtl(it);
  } else {
    // 항목에서 바로 내려가는 사이에 꺼지지 않게 잠깐 기다린다
    it.hoverTimer = setTimeout(() => {
      it.hover = false;
      refreshCtl(it);
    }, 280);
  }
}

function layoutAll() {
  for (const it of app.items.values()) layoutItem(it);
  updateVisibility(); // 화면 밖 영상 자동 일시정지 / 내리기
  $('#zoomLabel').textContent = Math.round(app.view.s * 100) + '%';
  $('#emptyHint').style.display = app.items.size ? 'none' : '';
}

function markDirty() {
  app.dirty = true;
  updateTitle();
  clearTimeout(markDirty.timer);
  markDirty.timer = setTimeout(() => rb.board.autosave(serialize(), app.boardFile, app.dirty), 800);
}

function updateTitle() {
  const name = app.boardFile ? app.boardFile.split(/[\\/]/).pop() : tr('제목 없음');
  $('#boardName').textContent = (app.dirty ? '● ' : '') + name;
  document.title = `${name} - MoRef`;
}

let nextId = 1;

// opts: { kind, ref, name, x, y, w?, h?, center?, rate, a, b, muted, t, z, paused }
async function addItem(opts) {
  const it = {
    id: nextId++,
    kind: opts.kind,
    ref: opts.ref,
    name: opts.name || (opts.ref.path || opts.ref.file || '').split(/[\\/]/).pop(),
    x: opts.x,
    y: opts.y,
    w: opts.w || 480,
    h: opts.h || 270,
    sized: !!opts.h,
    rate: opts.rate || 1,
    muted: true, // 레퍼런스는 항상 음소거로 시작
    z: opts.z || ++app.z,
    paused: !!opts.paused,
    shapes: opts.shapes ? structuredClone(opts.shapes) : [],
    flipH: !!opts.flipH,
    flipV: !!opts.flipV,
    gray: !!opts.gray,
    crop: opts.crop || null,
    sync: opts.sync || null, // Blender 타임라인 기준점 { b0, t0 }
  };
  initSegments(it, opts); // 반복 구간 (it.a / it.b = 활성 구간)
  app.z = Math.max(app.z, it.z);
  if (opts.center) {
    it.x -= it.w / 2;
    it.y -= it.h / 2;
  }
  buildItemEl(it);
  if (opts.onion) setOnion(it, opts.onion, { remember: false });
  app.items.set(it.id, it);
  boardChanged(it, 1);
  layoutAll();
  select(it, false);
  markDirty();

  if (it.kind === 'video') {
    rb.probe(it.ref).then((r) => {
      if (!r?.fps || !app.items.has(it.id)) return;
      it.fps = r.fps;
      it.frames = r.frames;
      it.vfr = r.vfr;
      it.probeDur = r.duration || null;
      // 아직 영상을 받지 않았으면 크기는 ffprobe 값으로
      if (!it.media.videoWidth && r.width && r.height) fitAspect(it, r.width, r.height);
      updateFpsUi(it);
      renderSegments(it);
    });
  }
  const url = await mediaUrl(it.ref);
  it.srcUrl = it.kind === 'video' ? shardUrl(url) : url;
  if (it.kind === 'image') {
    it.media.src = url;
  } else {
    it.onScreen = isOnScreen(it);
    if (it.kind === 'video' && (it.paused || !it.onScreen)) {
      // 재생하지 않는 영상은 받지 않는다: 그 시각의 프레임 썸네일을 보여 준다 (캐시됨)
      rangeThumb(it.ref, 'video', opts.t || 0).then((u) => u && it.media.readyState < 2 && setPoster(it, u));
    }
    it.media.src = url;
    it.media.playbackRate = it.rate;
    if (opts.t) it.media.currentTime = opts.t;
    if (!it.paused) {
      if (it.onScreen) it.media.play().catch(() => {});
      else it.autoPaused = true; // 화면 밖에 올라온 재생 영상: 보일 때 재생
    }
  }
  return it;
}

function fitAspect(it, w, h) {
  if (!w || !h) return;
  const oldW = it.w;
  if (!it.sized) {
    // 처음 열 때: 긴 변 기준으로 적당한 크기
    const base = 480;
    it.w = w >= h ? base : (base * w) / h;
  }
  const cx = it.x + oldW / 2;
  const c = cropOf(it);
  it.h = (it.w * h * c.h) / (w * c.w);
  if (!it.sized) it.x = cx - it.w / 2;
  it.sized = true;
  layoutItem(it);
}

function buildItemEl(it) {
  const el = h('div', 'item');
  it.el = el;
  el._item = it;

  if (it.kind === 'image') {
    it.media = h('img');
    it.media.onload = () => fitAspect(it, it.media.naturalWidth, it.media.naturalHeight);
    it.media.onerror = () => showError(it, tr('이미지를 불러올 수 없음'));
  } else if (it.kind === 'gif') {
    const g = new GifPlayer();
    g.onloadedmetadata = () => fitAspect(it, g.videoWidth, g.videoHeight);
    g.onready = () => {
      if (it.sync && app.blender) applySync(it, app.blender);
      if (it.seekSegWhenReady) activateSegment(it, it.activeSeg, { quiet: true });
    };
    g.onerror = () => showError(it, g.error?.message || tr('GIF 를 불러올 수 없음'));
    g.onplay = g.onpause = () => updatePlayBtn(it);
    it.media = g;
  } else {
    const v = h('video');
    v.loop = true;
    v.muted = it.muted;
    v.preload = 'none'; // 멈춘 영상은 받지 않는다 (재생·이동할 때 받기 시작 - media.js)
    v.crossOrigin = 'anonymous'; // 화면 밖으로 나갈 때 정지 화면을 저장하려면
    v.playsInline = true;
    v.onloadedmetadata = () => {
      fitAspect(it, v.videoWidth, v.videoHeight);
      if (it.sync && app.blender) applySync(it, app.blender);
      if (it.seekSegWhenReady) activateSegment(it, it.activeSeg, { quiet: true });
    };
    v.onerror = () => {
      const code = v.error?.code;
      showError(it, code === 4 ? tr('재생할 수 없는 형식/코덱입니다') : tr('NAS에서 영상을 읽지 못했습니다 (연결 확인)'));
    };
    v.onplay = v.onpause = () => updatePlayBtn(it);
    for (const ev of ['seeking', 'seeked', 'loadeddata', 'durationchange', 'progress', 'ratechange']) v.addEventListener(ev, wakeTick);
    v.addEventListener('loadstart', () => (it.hasFrame = false));
    v.addEventListener('loadeddata', () => (it.hasFrame = true));
    it.media = v;
    // 화면에 프레임이 그려질 때마다 그 프레임의 시각을 기억 (프레임 번호 표시용)
    // ffprobe 로 못 읽은 경우: 1배속 재생 중 연속 프레임 간격의 중앙값으로 fps 추정
    const gaps = [];
    let last = null;
    const onFrame = (_now, meta) => {
      if (!it.el.isConnected) return;
      if (!it.fps && last && meta.presentedFrames === last.presentedFrames + 1 && v.playbackRate === 1) {
        const g = meta.mediaTime - last.mediaTime;
        if (g > 0.002 && g < 0.2) gaps.push(g);
        if (gaps.length >= 15) {
          const m = [...gaps].sort((a, b) => a - b)[gaps.length >> 1];
          it.estFps = 1 / m;
          gaps.length = 0;
          updateFpsUi(it);
        }
      }
      last = meta;
      it.mediaTime = meta.mediaTime;
      v.requestVideoFrameCallback(onFrame);
    };
    v.requestVideoFrameCallback(onFrame);
  }
  it.vis = h('div', 'vis');
  it.vis.append(it.media.canvas || it.media);
  el.append(it.vis);

  it.svg = document.createElementNS(SVG_NS, 'svg');
  it.svg.setAttribute('class', 'anno');
  it.svg.setAttribute('preserveAspectRatio', 'none');
  el.append(it.svg);
  renderShapes(it);

  const top = h('div', 'ibar top');
  top.append(h('span', 'nm', it.name));
  it.badges = h('span', 'vbadges');
  top.append(it.badges);
  const close = h('button', 'close');
  close.innerHTML = icon('x');
  close.title = tr('닫기 (Delete)');
  close.onpointerdown = (e) => e.stopPropagation();
  close.onclick = () => removeItem(it);
  top.append(close);
  el.append(top);

  if (isTimed(it)) {
    const big = h('button', 'bigplay');
    big.innerHTML = icon('play');
    big.title = tr('재생 (Space)');
    big.onpointerdown = (e) => e.stopPropagation();
    big.onclick = () => togglePlay(it);
    el.append(big);
    el.classList.add('paused');
    it.ctlEl = buildControls(it);
    $('#ctlLayer').append(it.ctlEl);
    buildSide(it);
    el.addEventListener('pointerenter', () => setHover(it, true));
    el.addEventListener('pointerleave', () => setHover(it, false));
  }

  const rs = h('div', 'resize');
  rs.onpointerdown = (ev) => startResize(ev, it);
  el.append(rs);

  applyVisual(it);
  el.onpointerdown = (ev) => onItemPointerDown(ev, it);
  el.oncontextmenu = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    itemMenu(ev, it);
  };
  itemsEl.append(el);
}

function buildControls(it) {
  const bar = h('div', 'ctl');
  const row = h('div', 'row');
  const c = (it.ctl = {});
  const stop = (e) => e.stopPropagation();
  bar.onpointerdown = stop;
  bar.ondblclick = stop;
  bar.onwheel = stop;
  bar.addEventListener('pointerenter', () => setHover(it, true));
  bar.addEventListener('pointerleave', () => setHover(it, false));
  bar.oncontextmenu = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    itemMenu(ev, it);
  };

  // ---- 진행 바: 버퍼 / 반복 구간 / 진행 / A·B 손잡이 / 마우스 위치 시간
  const scrub = h('div', 'scrub');
  const rail = h('div', 'rail');
  c.buf = h('div', 'buf');
  c.bands = h('div', 'bands'); // 구간 띠
  c.fill = h('div', 'fill');
  rail.append(c.buf, c.bands, c.fill);
  c.knob = h('div', 'knob');
  c.mkA = h('div', 'mk a');
  c.mkB = h('div', 'mk b');
  c.mkP = h('div', 'mk p'); // 끝을 정하기 전의 새 구간 시작점
  c.tip = h('div', 'tip');
  scrub.append(rail, c.mkA, c.mkB, c.mkP, c.knob, c.tip);

  const frac = (e) => {
    const r = rail.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };
  const dur = () => durOf(it) || 0;
  const hover = (e) => {
    if (!dur()) return;
    const f = frac(e);
    c.tip.textContent = fmtTime(f * dur());
    c.tip.style.left = f * 100 + '%';
  };
  scrub.onpointermove = hover;
  scrub.onpointerdown = (ev) => {
    ev.stopPropagation();
    if (ev.button !== 0 || !dur()) return; // 우클릭은 메뉴용 - 이동하지 않음
    scrub.setPointerCapture(ev.pointerId);
    scrub.classList.add('dragging');
    ensureLoaded(it);
    const seek = (e) => (it.media.currentTime = frac(e) * dur());
    seek(ev);
    scrub.onpointermove = (e) => {
      hover(e);
      seek(e);
    };
    scrub.onpointerup = () => {
      scrub.onpointermove = hover;
      scrub.classList.remove('dragging');
      realignSync(it);
    };
  };
  // 활성 구간의 시작/끝 손잡이를 끌어서 조절
  for (const [mk, which] of [[c.mkA, 'a'], [c.mkB, 'b']]) {
    mk.title = which === 'a' ? tr('구간 시작 - 끌어서 조절') : tr('구간 끝 - 끌어서 조절');
    mk.onpointerdown = (ev) => {
      ev.stopPropagation();
      if (ev.button !== 0) return;
      mk.setPointerCapture(ev.pointerId);
      scrub.classList.add('dragging');
      const gap = 0.05;
      mk.onpointermove = (e) => {
        const s = segActive(it);
        if (!s) return;
        const t = frac(e) * dur();
        // 프레임 경계에 붙여서 (시작은 프레임 처음, 끝은 프레임 끝)
        if (which === 'a') s.a = Math.max(0, Math.min(snapStart(it, t), snapStart(it, (s.b ?? dur()) - gap)));
        else s.b = Math.min(dur(), Math.max(snapEnd(it, t), snapEnd(it, s.a)));
        c.tip.textContent = fmtTime(s[which]);
        c.tip.style.left = (s[which] / dur()) * 100 + '%';
        renderSegments(it);
      };
      mk.onpointerup = () => {
        mk.onpointermove = null;
        scrub.classList.remove('dragging');
        const s = segActive(it);
        if (s && which === 'a') {
          ensureLoaded(it);
          it.media.currentTime = s.a;
        }
        saveSegments(it);
      };
    };
  }

  const btn = (name, title, fn, cls = '') => {
    const b = h('button', 'ib ' + cls);
    b.innerHTML = icon(name);
    b.title = title;
    b.onclick = (e) => {
      e.stopPropagation();
      fn();
    };
    row.append(b);
    return b;
  };

  c.play = btn('play', tr('재생 / 일시정지 (Space)'), () => togglePlay(it), 'play');
  btn('prev', tr('한 프레임 뒤로 (←, Shift: 1초)'), () => step(it, -FRAME), 'step');
  btn('next', tr('한 프레임 앞으로 (→, Shift: 1초)'), () => step(it, FRAME), 'step');
  c.time = h('span', 'time');
  c.cur = h('b', '', '0:00.0');
  c.dur = h('span', 'dur', ' / 0:00.0');
  c.time.append(c.cur, c.dur);
  row.append(c.time);
  c.fr = h('span', 'fr', '1 / 1'); // 프레임 번호 (구간 반복 중이면 그 구간 안에서)
  row.append(c.fr);
  row.append(h('span', 'grow'));

  // 구간 추가: 누를 때마다 시작 → 끝 (끝을 누르면 구간이 생긴다)
  c.segAdd = btn('segAdd', tr('구간 만들기 - 시작에서 한 번, 끝에서 한 번 ([ / ])'), () => {
    if (segActive(it)) it.activeSeg = null; // 새 구간은 전체 재생 상태에서 만든다
    setLoopPoint(it, it.pendingA == null ? 'a' : 'b');
  }, 'segadd');

  // 속도: 클릭하면 목록, 휠로 한 단계씩
  c.speed = h('button', 'speed');
  c.speed.title = tr('재생 속도 (클릭: 목록 · 휠: 한 단계 · - / =)');
  c.menu = h('div', 'menu');
  for (const r of [...SPEEDS].reverse()) {
    const o = h('button', '', r + '×');
    o.dataset.rate = r;
    o.onclick = (e) => {
      e.stopPropagation();
      setSpeed(it, r);
      c.menu.classList.remove('open');
    };
    c.menu.append(o);
  }
  c.speed.onclick = (e) => {
    e.stopPropagation();
    const open = !c.menu.classList.contains('open');
    closeMenus();
    c.menu.classList.toggle('open', open);
    bar.classList.toggle('menu-open', open);
    refreshCtl(it);
  };
  c.speed.onwheel = (e) => {
    e.preventDefault();
    e.stopPropagation();
    changeSpeed(it, e.deltaY < 0 ? 1 : -1);
  };
  row.append(c.speed);
  c.onion = btn('onion', tr('어니언 스킨 - 멈췄을 때 이전 · 다음 프레임 겹쳐 보기 (K) · 켜져 있으면 눌러서 프레임 수'), () => onionButton(it), 'onionbtn');
  c.sync = btn('link', '', () => toggleSync(it), 'sync'); // Blender 와 연결됐을 때만 보인다 (CSS)
  if (it.kind === 'gif') c.frames = btn('frames', tr('모든 프레임 보기 (G) - 프레임을 누르면 그 프레임으로'), () => toggleFrames(it), 'framesbtn');
  else c.mute = btn('mute', tr('소리 켜기 / 끄기 (M)'), () => toggleMute(it), 'mutebtn');

  c.strip = h('div', 'segstrip');
  bar.append(scrub, row, c.strip, c.menu);
  buildOnionMenu(it, bar);
  updateSpeedBtn(it);
  updateLoopUi(it);
  queueMicrotask(() => renderSegments(it));
  updateFpsUi(it);
  updateSyncUi(it);
  return bar;
}

function closeMenus() {
  document.querySelectorAll('.ctl .menu.open').forEach((m) => m.classList.remove('open'));
  document.querySelectorAll('.ctl.menu-open').forEach((m) => m.classList.remove('menu-open'));
  for (const it of app.items.values()) refreshCtl(it);
}

function showError(it, msg) {
  if ($('.err', it.el)) return;
  const e = h('div', 'err', msg);
  it.el.insertBefore(e, it.el.children[1]);
}

function updateFpsUi(it) {
  if (it.ctl?.fr) it.ctl.fr.title = tr('프레임 번호 · {0}', fpsLabel(it));
}

function updatePlayBtn(it) {
  wakeTick(); // 재생 / 멈춤 (영상 · GIF)
  if (!it.ctl) return;
  const paused = it.media.paused;
  it.ctl.play.innerHTML = icon(paused ? 'play' : 'pause');
  it.el.classList.toggle('paused', paused);
}
function updateSpeedBtn(it) {
  it.ctl.speed.textContent = it.rate + '×';
  it.ctl.speed.classList.toggle('on', it.rate !== 1);
  for (const o of it.ctl.menu.children) o.classList.toggle('on', Number(o.dataset.rate) === it.rate);
}
function updateLoopUi(it) {
  const c = it.ctl;
  if (c.mute) {
    c.mute.innerHTML = icon(it.muted ? 'mute' : 'vol');
    c.mute.classList.toggle('on', !it.muted);
  }
}

function togglePlay(it) {
  if (!isTimed(it)) return;
  // Blender 타임라인에 맞춘 레퍼런스: Blender 재생을 켜고 끈다 (영상은 Blender 를 따라간다).
  // 여러 개를 골라 Space 를 눌러도 한 번만 보낸다
  if (it.sync && app.blender) {
    const now = performance.now();
    if (now - (app.blenderPlayReq || 0) > 150) {
      app.blenderPlayReq = now;
      rb.blender.want('play');
    }
    return;
  }
  if (it.media.paused) it.media.play().catch(() => {});
  else it.media.pause();
  markDirty();
}
function step(it, dt) {
  if (!isTimed(it)) return;
  // GIF 는 프레임마다 길이가 달라서 실제 프레임 단위로 이동
  if (it.kind === 'gif' && Math.abs(dt) < 0.5) {
    it.media.stepFrame(dt > 0 ? 1 : -1);
    return realignSync(it);
  }
  it.media.pause();
  if (it.kind === 'video') {
    const n = Math.abs(dt) < 0.5 ? Math.sign(dt) : Math.round(dt * fpsOf(it));
    seekFrame(it, currentFrame(it) + n);
    return realignSync(it);
  }
  it.media.currentTime = Math.max(0, Math.min(it.media.duration || 0, it.media.currentTime + dt));
}
function changeSpeed(it, dir) {
  if (!isTimed(it)) return;
  let i = SPEEDS.indexOf(it.rate);
  if (i < 0) i = SPEEDS.indexOf(1);
  i = Math.max(0, Math.min(SPEEDS.length - 1, i + dir));
  setSpeed(it, SPEEDS[i]);
}
function setSpeed(it, rate) {
  it.rate = rate;
  it.media.playbackRate = rate;
  updateSpeedBtn(it);
  toast(tr('속도 {0}×', rate));
  markDirty();
}
// GIF: 모든 프레임 보기
function toggleFrames(it) {
  if (it.kind !== 'gif') return;
  const on = !it.media.grid;
  it.media.setGrid(on);
  applyVisual(it); // 모든 프레임은 자르지 않고 전체로
  it.ctl.frames.classList.toggle('on', on);
  it.el.classList.toggle('frames', on);
  toast(on ? tr('모든 프레임 - 프레임을 누르면 그 프레임으로 갑니다') : tr('모든 프레임 보기 끔'));
}

function toggleMute(it) {
  if (it.kind !== 'video') return;
  it.muted = !it.muted;
  it.media.muted = it.muted;
  updateLoopUi(it);
  markDirty();
}

function removeItem(it) {
  if (it.kind === 'video') {
    // 연결을 확실히 끊어 NAS 스트림을 닫는다
    it.media.pause();
    it.media.removeAttribute('src');
    it.media.load();
  } else if (it.kind === 'gif') {
    it.media.destroy();
  }
  clearTimeout(it.hoverTimer);
  closeOnion(it);
  releaseMedia(it);
  if (app.cropping === it) app.cropping = null;
  it.ctlEl?.remove();
  it.sideEl?.remove();
  it.el.remove();
  app.items.delete(it.id);
  boardChanged(it, -1);
  app.selected.delete(it);
  layoutAll();
  markDirty();
}

function clearBoard() {
  for (const it of [...app.items.values()]) removeItem(it);
  app.undo = [];
  app.redo = [];
  app.view = { x: 0, y: 0, s: 1 };
  layoutAll();
}

function select(it, additive) {
  if (!additive) {
    const was = [...app.selected];
    for (const s of was) s.el.classList.remove('sel');
    app.selected.clear();
    was.forEach(refreshCtl);
  }
  if (it) {
    app.selected.add(it);
    it.el.classList.add('sel');
    it.z = ++app.z;
    it.el.style.zIndex = it.z;
    if (it.ctlEl) it.ctlEl.style.zIndex = it.z;
    refreshCtl(it);
  }
}

// 반복 구간 / 진행 바 갱신.
// 무언가 움직이는 동안(재생 · 이동 중)만 매 화면 돈다. 모두 멈춰 있으면 1초에 4번만 (대기 중에 CPU / GPU 를 쓰지 않게).
// 재생 · 이동 · 입력이 생기면 wakeTick() 으로 바로 다시 매 화면으로
const TICK_IDLE_MS = 250;
let tickRaf = 0;
let tickTimer = 0;
function wakeTick() {
  if (tickRaf) return;
  clearTimeout(tickTimer);
  tickTimer = 0;
  tickRaf = requestAnimationFrame(tick);
}
// 값이 바뀔 때만 쓴다 (같은 값을 매 화면 써도 스타일 계산이 다시 돈다)
function setStyle(el, k, v) {
  const c = (el._st ??= {});
  if (c[k] === v) return;
  c[k] = v;
  el.style[k] = v;
}

function tick() {
  tickRaf = 0;
  let busy = false;
  updateBlenderRange();
  for (const it of app.items.values()) {
    if (!isTimed(it)) continue;
    const v = it.media;
    const d = durOf(it);
    if (!v.paused || v.seeking || it.pendingSeek != null) busy = true;
    if (it.onion) onionTick(it);
    // 연속 seek 중 멈춰 버리는 경우(webm 등)가 있어, 오래 걸리면 seek 을 다시 건다.
    // 처음 받는 중(첫 프레임 전)에는 걸지 않고, 다시 걸 때마다 기다리는 시간을 두 배로: 여러 영상을 동시에
    // 처음부터 받으며 이동하면 몇 초씩 걸리는데, 그때 다시 걸면 끝나지 못하고 계속 처음부터 이동한다.
    if (v.seeking && it.hasFrame) {
      const now = performance.now();
      it.seekSince ??= now;
      if (now - it.seekSince > 700 * 2 ** (it.seekKicks || 0)) {
        it.seekSince = now;
        it.seekKicks = (it.seekKicks || 0) + 1;
        v.currentTime = v.currentTime;
      }
    } else it.seekSince = it.seekKicks = null;
    if (it.a != null || it.b != null) {
      const a = it.a ?? 0;
      const b = it.b ?? d;
      const out = v.currentTime >= b || v.currentTime < a - 0.05;
      // seek 이 끝나지 않은 채 재생이 계속되는 경우도 있어, 확실히 넘어갔으면 seeking 중이라도 되돌린다
      if (!v.paused && out && (!v.seeking || v.currentTime > b + 0.1)) v.currentTime = a;
    }
    if (!isFinite(d) || !d) continue;
    const c = it.ctl;
    const pct = (x) => (x / d) * 100 + '%';
    const t = v.currentTime;
    setStyle(c.fill, 'width', pct(t));
    setStyle(c.knob, 'left', pct(t));
    const cur = fmtTime(t);
    if (c.cur.textContent !== cur) c.cur.textContent = cur;
    const total = ' / ' + fmtTime(d);
    if (c.dur.textContent !== total) c.dur.textContent = total;
    if (it.segDur !== d) renderSegments(it); // 길이를 알게 되면 구간 띠를 다시 그린다
    // 프레임 번호: 구간 반복 중이면 그 구간 안에서 몇 번째인지
    const si = segFrameInfo(it);
    const fr = si ? `${si.cur} / ${si.total}` : `${currentFrame(it) + 1} / ${totalFrames(it)}`;
    if (c.fr.textContent !== fr) c.fr.textContent = fr;
    const inSeg = si ? si.name : '';
    if (c.fr.dataset.seg !== inSeg) {
      c.fr.dataset.seg = inSeg;
      c.fr.classList.toggle('inseg', !!si);
      c.fr.style.setProperty('--c', si?.color || '');
      c.fr.title = si ? tr('{0} 안에서의 프레임 · 전체 {1}프레임 중 {2}', si.name, totalFrames(it), currentFrame(it) + 1) : tr('프레임 번호 · {0}', fpsLabel(it) || tr('프레임'));
    }
    let bufEnd = 0;
    for (let i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= t + 0.1) bufEnd = Math.max(bufEnd, v.buffered.end(i));
    }
    setStyle(c.buf, 'width', pct(bufEnd));
  }
  if (tickRaf) return; // 도는 중에 wakeTick() 이 이미 다음 화면을 잡았다 (두 줄로 돌지 않게)
  if (busy) tickRaf = requestAnimationFrame(tick);
  else {
    clearTimeout(tickTimer);
    tickTimer = setTimeout(wakeTick, TICK_IDLE_MS);
  }
}

// ---------- 우클릭 메뉴 ----------
// items: { label, icon?, hint?, action, disabled?, danger?, primary? } | 'sep' | { header }

function showMenu(x, y, items) {
  closeMenu();
  const m = h('div', 'ctx');
  for (const it of items) {
    if (it === 'sep') {
      m.append(h('div', 'ctx-sep'));
      continue;
    }
    if (it.header) {
      m.append(h('div', 'ctx-head', it.header));
      continue;
    }
    const b = h('button', 'ctx-item' + (it.danger ? ' danger' : '') + (it.primary ? ' primary' : ''));
    b.disabled = !!it.disabled;
    const ic = h('span', 'ctx-ic');
    if (it.icon && ICONS[it.icon]) ic.innerHTML = icon(it.icon);
    b.append(ic, h('span', 'ctx-label', it.label));
    if (it.hint) b.append(h('span', 'ctx-hint', it.hint));
    if (it.checked) {
      b.classList.add('checked');
      const ck = h('span', 'ctx-check');
      ck.innerHTML = icon('check');
      b.append(ck);
    }
    b.onclick = (e) => {
      e.stopPropagation();
      closeMenu();
      it.action();
    };
    m.append(b);
  }
  m.onpointerdown = (e) => e.stopPropagation();
  m.oncontextmenu = (e) => e.preventDefault();
  document.body.append(m);
  // 화면 밖으로 나가지 않게
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  app.menu = m;
  m.querySelector('.ctx-item:not(:disabled)')?.focus({ preventScroll: true });
}

function closeMenu() {
  app.menu?.remove();
  app.menu = null;
}

function initMenus() {
  window.addEventListener('pointerdown', (e) => app.menu && !app.menu.contains(e.target) && closeMenu(), true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('wheel', (e) => app.menu && !app.menu.contains(e.target) && closeMenu(), { capture: true, passive: true });
  window.addEventListener('keydown', (e) => {
    if (!app.menu) return;
    const btns = [...app.menu.querySelectorAll('.ctx-item:not(:disabled)')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'Escape') closeMenu();
    else if (e.key === 'ArrowDown') btns[(i + 1) % btns.length]?.focus();
    else if (e.key === 'ArrowUp') btns[(i - 1 + btns.length) % btns.length]?.focus();
    else if (e.key === 'Enter' && i >= 0) btns[i].click();
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
}

// ---------- 보드에서 해당 항목으로 이동 ----------

function goToItem(it) {
  if (!app.items.has(it.id)) return;
  select(it, false);
  const bw = board.clientWidth;
  const bh = board.clientHeight;
  // 화면의 60% 정도를 차지하도록 (너무 크게 확대하지는 않음)
  const s = Math.min(4, Math.max(0.1, Math.min((bw * 0.6) / it.w, (bh * 0.6) / it.h)));
  const to = { s, x: bw / 2 - (it.x + it.w / 2) * s, y: bh / 2 - (it.y + it.h / 2) * s };
  const from = { ...app.view };
  cancelAnimationFrame(goToItem.raf);
  const t0 = performance.now();
  const dur = 380;
  const frame = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    // 확대/축소는 로그 공간에서 보간해야 자연스럽다
    app.view.s = Math.exp(Math.log(from.s) + (Math.log(to.s) - Math.log(from.s)) * e);
    app.view.x = from.x + (to.x - from.x) * e;
    app.view.y = from.y + (to.y - from.y) * e;
    layoutAll();
    if (k < 1) goToItem.raf = requestAnimationFrame(frame);
    else {
      markDirty();
      it.el.classList.remove('found');
      void it.el.offsetWidth;
      it.el.classList.add('found');
    }
  };
  goToItem.raf = requestAnimationFrame(frame);
}

// ---------- 보드 항목 우클릭 ----------

function itemMenu(ev, it) {
  if (!app.selected.has(it)) select(it, false);
  const items = [];
  if (isTimed(it)) {
    const v = it.media;
    const d = isFinite(v.duration) ? v.duration : 0;
    // 진행 바 위에서 누르면 그 지점, 아니면 현재 재생 위치
    const scrub = ev.target.closest?.('.scrub');
    let t = v.currentTime;
    let where = tr('현재 위치');
    if (scrub && d) {
      const r = $('.rail', scrub).getBoundingClientRect();
      t = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * d;
      where = tr('이 지점');
    }
    const fr = it.kind === 'gif' ? (v.frameCount ? v.frameAt(t) + 1 : 0) : Math.floor(t * fpsOf(it) + 0.01) + 1;
    items.push({ header: tr('{0} {1} · {2} / {3} 프레임', where, fmtTime(t), fr, totalFrames(it)) + (it.kind === 'video' ? ` · ${fpsLabel(it).split(' (')[0]}` : '') });
    const sg = segActive(it);
    if (sg) {
      const n = segIndex(it, sg);
      items.push({ label: tr('구간 {0} 시작을 여기로', n), icon: 'markA', hint: '[', action: () => setLoopPoint(it, 'a', t) });
      items.push({ label: tr('구간 {0} 끝을 여기로', n), icon: 'markB', hint: ']', action: () => setLoopPoint(it, 'b', t) });
      items.push({ label: tr('전체 재생 (구간 반복 끄기)'), icon: 'loop', hint: '0', action: () => clearLoop(it) });
      items.push({ label: `${segName(it, sg)} - ${sg.name ? tr('이름 바꾸기…') : tr('이름 붙이기…')}`, icon: 'pen', hint: 'F2', action: () => startRename(it, sg.id) });
      items.push({ label: tr('구간 {0} 삭제', n), icon: 'trash', danger: true, action: () => deleteSegment(it, sg.id) });
    } else {
      items.push({ label: it.pendingA != null ? tr('새 구간 시작을 여기로 (지금 {0})', fmtTime(it.pendingA)) : tr('여기서 새 구간 시작'), icon: 'markA', hint: '[', action: () => setLoopPoint(it, 'a', t) });
      items.push({ label: tr('여기서 새 구간 끝 - 구간 만들기'), icon: 'markB', hint: ']', disabled: t <= (it.pendingA ?? 0) + 0.02, action: () => setLoopPoint(it, 'b', t) });
    }
    if (it.segments.length) {
      it.segments.forEach((g, i) => {
        if (g !== sg && i < 9) items.push({ label: tr('{0} 반복 · {1}프레임', segName(it, g), segFrames(it, g)), icon: 'loop', hint: String(i + 1), action: () => activateSegment(it, g.id) });
      });
    }
    items.push('sep');
    items.push({ label: v.paused ? tr('재생') : tr('일시정지'), icon: v.paused ? 'play' : 'pause', hint: 'Space', action: () => togglePlay(it) });
    if (it.kind === 'gif') items.push({ label: v.grid ? tr('모든 프레임 보기 끄기') : tr('모든 프레임 보기'), icon: 'frames', hint: 'G', action: () => toggleFrames(it) });
    else items.push({ label: it.muted ? tr('소리 켜기') : tr('소리 끄기'), icon: it.muted ? 'vol' : 'mute', hint: 'M', action: () => toggleMute(it) });
    items.push({ label: tr('어니언 스킨 (앞뒤 프레임 겹쳐 보기)'), icon: 'onion', hint: 'K', checked: !!it.onion, action: () => toggleOnion(it) });
    items.push({ label: it.onion ? tr('어니언 스킨 프레임 수… (이전 {0} · 다음 {1})', it.onion.b, it.onion.a) : tr('어니언 스킨 프레임 수…'), icon: 'onion', action: () => openOnionMenu(it) });
    items.push('sep');
  }
  if (app.linked && isTimed(it)) {
    items.push({ label: tr('Blender 타임라인에 맞추기'), icon: 'link', hint: 'L', checked: !!it.sync, action: () => toggleSync(it) });
    if (it.sync) items.push({ label: tr('지금 프레임으로 다시 맞추기'), icon: 'target', action: () => { realignSync(it); toast(tr('기준점을 다시 맞췄습니다')); } });
    if (it.kind === 'video') {
      items.push({ label: tr('Blender 뷰포트에 띄우기'), icon: 'image', action: () => sendToViewport(it) });
      items.push({ label: tr('Blender 카메라 배경으로 보내기'), icon: 'image', action: () => sendToCameraBg(it) });
    }
    items.push('sep');
  }
  items.push({ label: tr('좌우 반전'), icon: 'mirror', hint: 'Shift+H', checked: it.flipH, action: () => toggleFlip(it, 'flipH') });
  items.push({ label: tr('상하 반전'), icon: 'flipV', hint: 'Shift+V', checked: it.flipV, action: () => toggleFlip(it, 'flipV') });
  items.push({ label: tr('흑백'), icon: 'gray', hint: 'Shift+G', checked: it.gray, action: () => toggleGray(it) });
  items.push({ label: tr('자르기…'), icon: 'crop', hint: 'C', action: () => startCrop(it) });
  if (it.crop) items.push({ label: tr('자르기 해제'), icon: 'undo', action: () => resetCrop(it) });
  items.push('sep');
  items.push({ label: tr('패널에서 위치 보기'), icon: 'folder', disabled: !it.ref.sourceId, action: () => locateInPanel(it) });
  items.push({ label: tr('보드에서 닫기'), icon: 'x', hint: 'Delete', danger: true, action: () => removeItem(it) });
  showMenu(ev.clientX, ev.clientY, items);
}

// ---------- 포인터 조작 ----------

function onItemPointerDown(ev, it) {
  if (ev.button === 1) return; // 가운데 버튼은 보드 이동
  if (ev.button !== 0) return;
  ev.stopPropagation();
  board.focus();
  if (app.cropping && app.cropping !== it) applyCrop(app.cropping);
  if (it.cropEdit) return;
  if (app.draw.on) {
    startStroke(ev, it);
    return;
  }
  if (ev.shiftKey || ev.ctrlKey) {
    if (app.selected.has(it)) {
      app.selected.delete(it);
      it.el.classList.remove('sel');
      return;
    }
    select(it, true);
  } else if (!app.selected.has(it)) {
    select(it, false);
  } else {
    it.z = ++app.z;
    it.el.style.zIndex = it.z;
  }
  const start = { x: ev.clientX, y: ev.clientY };
  const orig = [...app.selected].map((s) => ({ s, x: s.x, y: s.y }));
  let moved = false;
  it.el.setPointerCapture(ev.pointerId);
  it.el.onpointermove = (m) => {
    const dx = (m.clientX - start.x) / app.view.s;
    const dy = (m.clientY - start.y) / app.view.s;
    if (!moved && Math.hypot(m.clientX - start.x, m.clientY - start.y) < 3) return;
    moved = true;
    for (const o of orig) {
      o.s.x = o.x + dx;
      o.s.y = o.y + dy;
      layoutItem(o.s);
    }
  };
  it.el.onpointerup = (up) => {
    it.el.onpointermove = null;
    if (moved) return markDirty();
    // GIF 모든 프레임 보기: 누른 프레임으로 이동하고 한 장 보기로 돌아간다
    if (it.kind === 'gif' && it.media.grid) {
      const r = it.media.canvas.getBoundingClientRect();
      const i = it.media.frameAtPoint((up.clientX - r.left) / r.width, (up.clientY - r.top) / r.height);
      if (i >= 0) {
        toggleFrames(it);
        it.media.currentTime = it.media.starts[i];
        it.media.stepFrame(0);
      }
    }
  };
  it.el.ondblclick = (e) => {
    if (app.draw.on || e.target.closest('.ibar')) return;
    togglePlay(it);
  };
}

function startResize(ev, it) {
  if (ev.button !== 0) return;
  ev.stopPropagation();
  select(it, false);
  const start = { x: ev.clientX, w: it.w };
  const aspect = it.h / it.w;
  const t = ev.target;
  t.setPointerCapture(ev.pointerId);
  it.el.classList.add('resizing');
  t.onpointermove = (m) => {
    it.w = Math.max(60, start.w + (m.clientX - start.x) / app.view.s);
    it.h = it.w * aspect;
    layoutItem(it);
  };
  t.onpointerup = () => {
    t.onpointermove = null;
    it.el.classList.remove('resizing');
    markDirty();
  };
}

function initBoard() {
  board.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 && ev.button !== 1) return;
    if (ev.button === 0 && ev.target.closest('.item')) return;
    ev.preventDefault();
    board.focus();
    if (app.cropping) applyCrop(app.cropping); // 빈 곳을 누르면 자르기 적용
    if (ev.button === 0 && !ev.shiftKey) select(null, false);
    const start = { x: ev.clientX, y: ev.clientY, vx: app.view.x, vy: app.view.y };
    board.classList.add('panning');
    board.setPointerCapture(ev.pointerId);
    const move = (m) => {
      app.view.x = start.vx + m.clientX - start.x;
      app.view.y = start.vy + m.clientY - start.y;
      layoutAll();
    };
    const up = () => {
      board.classList.remove('panning');
      board.removeEventListener('pointermove', move);
      board.removeEventListener('pointerup', up);
      if (start.vx !== app.view.x || start.vy !== app.view.y) markDirty();
    };
    board.addEventListener('pointermove', move);
    board.addEventListener('pointerup', up);
  });

  board.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      if (app.draw.on && ev.altKey) {
        setWidth(app.draw.width + (ev.deltaY < 0 ? 1 : -1));
        return;
      }
      const r = board.getBoundingClientRect();
      const sx = ev.clientX - r.left;
      const sy = ev.clientY - r.top;
      const before = screenToBoard(sx, sy);
      const f = Math.pow(1.0015, -ev.deltaY);
      app.view.s = Math.min(8, Math.max(0.05, app.view.s * f));
      app.view.x = sx - before.x * app.view.s;
      app.view.y = sy - before.y * app.view.s;
      layoutAll();
      markDirty();
    },
    { passive: false }
  );

  // 패널 / 탐색기에서 끌어다 놓기
  board.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    board.classList.add('drop-over');
  });
  board.addEventListener('dragleave', () => board.classList.remove('drop-over'));
  board.addEventListener('drop', (ev) => {
    ev.preventDefault();
    board.classList.remove('drop-over');
    const at = clientToBoard(ev.clientX, ev.clientY);
    const data = ev.dataTransfer.getData('application/x-refboard');
    if (data) {
      const { sourceId, entry } = JSON.parse(data);
      addItem({ kind: entry.kind, ref: { sourceId, path: entry.path, size: entry.size, mtime: entry.mtime }, name: entry.name, x: at.x, y: at.y, center: true });
      return;
    }
    let off = 0;
    for (const f of ev.dataTransfer.files) {
      const abs = rb.pathForFile(f);
      const kind = /\.(mp4|mov|m4v|webm|mkv)$/i.test(abs) ? 'video' : /\.gif$/i.test(abs) ? 'gif' : /\.(jpe?g|png|webp|bmp)$/i.test(abs) ? 'image' : null;
      if (!abs || !kind) continue;
      addItem({ kind, ref: { file: abs }, x: at.x + off, y: at.y + off, center: true });
      off += 30;
    }
  });

  window.addEventListener('resize', layoutAll);
  // 속도 목록 바깥을 누르면 닫기
  window.addEventListener('pointerdown', (e) => !e.target.closest('.menu, .speed, .onionbtn') && closeMenus(), true);
}

function fitView() {
  const list = app.selected.size ? [...app.selected] : [...app.items.values()];
  if (!list.length) {
    app.view = { x: 0, y: 0, s: 1 };
    layoutAll();
    return;
  }
  const minX = Math.min(...list.map((i) => i.x));
  const minY = Math.min(...list.map((i) => i.y));
  const maxX = Math.max(...list.map((i) => i.x + i.w));
  const maxY = Math.max(...list.map((i) => i.y + i.h));
  const pad = 20;
  // 그리기 툴바가 위에 떠 있으면 그 아래 영역에 맞춘다
  const bar = $('#drawBar');
  const top = app.draw.on && bar.offsetTop < board.clientHeight / 2 ? bar.offsetTop + bar.offsetHeight : 0;
  const W = board.clientWidth - pad * 2;
  const H = board.clientHeight - top - pad * 2;
  const s = Math.min(8, W / (maxX - minX), H / (maxY - minY));
  app.view.s = s;
  app.view.x = pad + (W - (maxX - minX) * s) / 2 - minX * s;
  app.view.y = top + pad + (H - (maxY - minY) * s) / 2 - minY * s;
  layoutAll();
  markDirty();
}

/* =====================================================================
 * 그리기 (영상 위 오버레이)
 *  도형은 항목마다 it.shapes 에 저장한다. 좌표/굵기는 "항목 너비 = 1" 단위라
 *  영상을 옮기거나 크기를 바꿔도 그림이 같이 따라간다.
 *  { t: 'pen' | 'arrow' | 'circle', c: '#rrggbb', w: 굵기, p: [[x, y], ...] }
 * ===================================================================*/

const SVG_NS = 'http://www.w3.org/2000/svg';
const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#00c7ff', '#0a84ff', '#bf5af2', '#ffffff', '#000000'];
const round4 = (n) => Math.round(n * 10000) / 10000;

function svgEl(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

function shapeEl(s) {
  const common = { stroke: s.c, 'stroke-width': s.w };
  const [a, b] = [s.p[0], s.p[s.p.length - 1]];
  if (s.t === 'pen') {
    if (s.p.length === 1) return svgEl('circle', { cx: a[0], cy: a[1], r: s.w / 2, fill: s.c, style: 'fill:' + s.c, stroke: 'none' });
    return svgEl('path', { ...common, d: 'M' + s.p.map((q) => q.join(' ')).join('L') });
  }
  if (s.t === 'circle') {
    return svgEl('ellipse', {
      ...common,
      cx: (a[0] + b[0]) / 2,
      cy: (a[1] + b[1]) / 2,
      rx: Math.abs(b[0] - a[0]) / 2,
      ry: Math.abs(b[1] - a[1]) / 2,
    });
  }
  // arrow
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const len = Math.max(s.w * 4, 0.02);
  const wing = (d) => [b[0] - len * Math.cos(ang + d), b[1] - len * Math.sin(ang + d)];
  const [l, r] = [wing(0.5), wing(-0.5)];
  return svgEl('path', { ...common, d: `M${a.join(' ')}L${b.join(' ')}M${l.join(' ')}L${b.join(' ')}L${r.join(' ')}` });
}

function renderShapes(it) {
  it.svg.replaceChildren(...it.shapes.map(shapeEl));
}

// 지우개 판정용: 도형을 꺾은선으로 근사
function shapePolyline(s) {
  if (s.t !== 'circle') return s.p;
  const [a, b] = [s.p[0], s.p[s.p.length - 1]];
  const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
  const rx = Math.abs(b[0] - a[0]) / 2, ry = Math.abs(b[1] - a[1]) / 2;
  return Array.from({ length: 37 }, (_, i) => {
    const t = (i / 36) * Math.PI * 2;
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
  });
}

function distToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function hitShape(s, p, tol) {
  const line = shapePolyline(s);
  if (line.length === 1) return Math.hypot(p[0] - line[0][0], p[1] - line[0][1]) <= tol + s.w / 2;
  for (let i = 1; i < line.length; i++) if (distToSegment(p, line[i - 1], line[i]) <= tol + s.w / 2) return true;
  return false;
}

function pushUndo(action) {
  app.undo.push(action);
  if (app.undo.length > 200) app.undo.shift();
  app.redo.length = 0;
  markDirty();
}

// action: { it, before: shapes[], after: shapes[] } - 항목 하나의 그림 상태 전/후
function applyShapes(action, which) {
  for (const { it, before, after } of action) {
    if (!app.items.has(it.id)) continue; // 이미 닫힌 영상
    it.shapes = structuredClone(which === 'before' ? before : after);
    renderShapes(it);
  }
  markDirty();
}

function undo() {
  const a = app.undo.pop();
  if (!a) return toast(tr('되돌릴 그림이 없습니다'));
  applyShapes(a, 'before');
  app.redo.push(a);
}

function redo() {
  const a = app.redo.pop();
  if (!a) return;
  applyShapes(a, 'after');
  app.undo.push(a);
}

function startStroke(ev, it) {
  const rect = it.el.getBoundingClientRect();
  const toLocal = (e) => [round4((e.clientX - rect.left) / rect.width), round4((e.clientY - rect.top) / rect.width)];
  const before = structuredClone(it.shapes);
  const el = it.el;
  el.setPointerCapture(ev.pointerId);
  const { tool, color } = app.draw;

  if (tool === 'eraser') {
    const tol = 6 / rect.width;
    let prev = null;
    const erase = (e) => {
      const p = toLocal(e);
      // 빠르게 문질러도 빠지지 않게 직전 위치와의 사이를 촘촘히 검사
      const from = prev || p;
      const steps = Math.max(1, Math.ceil(Math.hypot(p[0] - from[0], p[1] - from[1]) / tol));
      const probes = Array.from({ length: steps + 1 }, (_, i) => [
        from[0] + ((p[0] - from[0]) * i) / steps,
        from[1] + ((p[1] - from[1]) * i) / steps,
      ]);
      prev = p;
      const n = it.shapes.length;
      it.shapes = it.shapes.filter((s) => !probes.some((q) => hitShape(s, q, tol)));
      if (it.shapes.length !== n) renderShapes(it);
    };
    erase(ev);
    el.onpointermove = erase;
    el.onpointerup = () => {
      el.onpointermove = el.onpointerup = null;
      if (it.shapes.length !== before.length) pushUndo([{ it, before, after: structuredClone(it.shapes) }]);
    };
    return;
  }

  const shape = { t: tool, c: color, w: round4(app.draw.width / rect.width), p: [toLocal(ev)] };
  it.shapes.push(shape);
  let node = shapeEl(shape);
  it.svg.append(node);
  const minStep = 2 / rect.width;
  el.onpointermove = (e) => {
    const p = toLocal(e);
    if (tool === 'pen') {
      const last = shape.p[shape.p.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < minStep) return;
      shape.p.push(p);
    } else {
      shape.p = [shape.p[0], p];
    }
    const next = shapeEl(shape);
    node.replaceWith(next);
    node = next;
  };
  el.onpointerup = () => {
    el.onpointermove = el.onpointerup = null;
    // 화살표/원은 거의 안 끌었으면 버린다
    const [a, b] = [shape.p[0], shape.p[shape.p.length - 1]];
    if (tool !== 'pen' && Math.hypot(b[0] - a[0], b[1] - a[1]) < 4 / rect.width) {
      it.shapes.pop();
      node.remove();
      return;
    }
    pushUndo([{ it, before, after: structuredClone(it.shapes) }]);
  };
}

function clearDrawings() {
  const targets = (app.selected.size ? [...app.selected] : [...app.items.values()]).filter((it) => it.shapes.length);
  if (!targets.length) return;
  const action = targets.map((it) => ({ it, before: structuredClone(it.shapes), after: [] }));
  applyShapes(action, 'after');
  pushUndo(action);
  toast(tr('그림을 지웠습니다 (Ctrl+Z 로 되돌리기)'));
}

function setDrawMode(on) {
  app.draw.on = on;
  document.body.classList.toggle('drawing', on);
  $('#btnDraw').classList.toggle('on', on);
  if (on) {
    if (document.body.classList.contains('draw-hidden')) toggleDrawHidden(false);
    // 저장된 위치는 툴바가 보인 뒤에야 크기를 알 수 있어 이때 적용
    if (app.draw.barPos) {
      app.draw.placeBar(app.draw.barPos.x, app.draw.barPos.y);
      app.draw.barPos = null;
    }
  }
}

function setTool(tool) {
  app.draw.tool = tool;
  for (const b of document.querySelectorAll('#drawBar [data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);
  document.body.classList.toggle('tool-eraser', tool === 'eraser');
  rb.setSetting('draw', { tool, color: app.draw.color, width: app.draw.width });
}

function setColor(color) {
  app.draw.color = color;
  $('#drawColor').value = color;
  for (const b of $('#swatches').children) b.classList.toggle('on', b.dataset.color === color);
  $('.cpick').classList.toggle('on', !COLORS.includes(color));
  updateWidthDot();
  if (app.draw.tool === 'eraser') setTool('pen');
  else setTool(app.draw.tool);
}

function setWidth(w) {
  app.draw.width = Math.max(1, Math.min(24, Math.round(w)));
  $('#drawWidth').value = app.draw.width;
  $('#drawWidthLabel').textContent = app.draw.width;
  updateWidthDot();
  setTool(app.draw.tool);
}

// 굵기 미리보기 점: 실제 굵기와 현재 색
function updateWidthDot() {
  const d = $('#widthDot');
  const size = Math.max(2, Math.min(22, app.draw.width)) + 'px';
  d.style.width = d.style.height = size;
  d.style.background = app.draw.color;
  d.style.boxShadow = app.draw.color.toLowerCase() === '#000000' ? '0 0 0 1px #ffffff55' : '';
}

function toggleDrawHidden(force) {
  const hidden = document.body.classList.toggle('draw-hidden', force);
  $('#btnHideDraw').innerHTML = icon(hidden ? 'eyeOff' : 'eye');
  toast(hidden ? tr('그림 숨김 (H)') : tr('그림 보임'));
}

function initDraw() {
  const saved = app.settings.draw || {};
  for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon);
  for (const c of COLORS) {
    const b = h('button');
    b.dataset.color = c;
    b.style.background = c;
    b.title = c;
    b.onclick = () => setColor(c);
    $('#swatches').append(b);
  }
  for (const b of document.querySelectorAll('#drawBar [data-tool]')) b.onclick = () => setTool(b.dataset.tool);
  $('#drawColor').oninput = (e) => setColor(e.target.value);
  $('#drawWidth').oninput = (e) => setWidth(Number(e.target.value));
  $('#btnUndo').onclick = undo;
  $('#btnRedo').onclick = redo;
  $('#btnClearDraw').onclick = clearDrawings;
  $('#btnHideDraw').onclick = () => toggleDrawHidden();
  $('#btnDrawDone').onclick = () => setDrawMode(false);
  $('#btnDraw').onclick = () => setDrawMode(!app.draw.on);
  const bar = $('#drawBar');
  bar.onpointerdown = (e) => e.stopPropagation();
  bar.onwheel = (e) => e.stopPropagation();
  // 손잡이로 툴바를 옮겨 영상을 가리지 않게
  const placeBar = (x, y) => {
    x = Math.max(0, Math.min(board.clientWidth - bar.offsetWidth, x));
    y = Math.max(0, Math.min(board.clientHeight - bar.offsetHeight, y));
    bar.classList.add('moved');
    bar.style.left = x + 'px';
    bar.style.top = y + 'px';
  };
  $('#drawGrip').onpointerdown = (e) => {
    const g = e.currentTarget;
    const br = bar.getBoundingClientRect();
    const bb = board.getBoundingClientRect();
    placeBar(br.left - bb.left, br.top - bb.top); // translate(-50%) 를 실제 left 로 바꿔 둔다
    const sx = e.clientX - bar.offsetLeft;
    const sy = e.clientY - bar.offsetTop;
    g.setPointerCapture(e.pointerId);
    g.onpointermove = (m) => placeBar(m.clientX - sx, m.clientY - sy);
    g.onpointerup = () => {
      g.onpointermove = null;
      rb.setSetting('drawBarPos', { x: bar.offsetLeft, y: bar.offsetTop });
    };
  };
  if (app.settings.drawBarPos) {
    app.draw.barPos = app.settings.drawBarPos;
  }
  app.draw.placeBar = placeBar;
  app.draw.color = saved.color || app.draw.color;
  app.draw.width = saved.width || app.draw.width;
  setColor(app.draw.color);
  setWidth(app.draw.width);
  setTool(saved.tool || 'pen');
}

/* =====================================================================
 * 보드 저장 / 불러오기
 * ===================================================================*/

function serialize() {
  return {
    version: 1,
    view: app.view,
    items: [...app.items.values()].map((it) => ({ it, g: it.cropEdit ? it.cropEdit.before : it })).map(({ it, g }) => ({
      kind: it.kind,
      ref: it.ref,
      name: it.name,
      x: g.x,
      y: g.y,
      w: g.w,
      h: g.h,
      flipH: it.flipH,
      flipV: it.flipV,
      gray: it.gray,
      crop: it.crop,
      sync: it.sync,
      segments: it.segments,
      activeSeg: it.activeSeg,
      z: it.z,
      rate: it.rate,
      a: it.a,
      b: it.b,
      muted: it.muted,
      onion: it.onion || undefined,
      t: isTimed(it) ? (it.unloaded ? it.savedT : it.media.currentTime) : 0,
      paused: isTimed(it) ? !it.autoPaused && it.media.paused : false,
      shapes: it.shapes,
    })),
  };
}

async function loadBoard(json, filePath) {
  clearBoard();
  app.view = json.view || { x: 0, y: 0, s: 1 };
  const items = [...(json.items || [])].sort((a, b) => (a.z || 0) - (b.z || 0));
  for (const i of items) await addItem(i);
  select(null, false);
  app.boardFile = filePath || null;
  app.dirty = false;
  layoutAll();
  updateTitle();
}

async function saveBoard(saveAs) {
  const p = await rb.board.save(serialize(), saveAs ? null : app.boardFile);
  if (!p) return;
  app.boardFile = p;
  app.dirty = false;
  updateTitle();
  rb.board.autosave(serialize(), p);
  toast(tr('저장됨'));
}

async function openBoard() {
  const r = await rb.board.open();
  if (r) await loadBoard(r.json, r.filePath);
}

function newBoard() {
  clearBoard();
  app.boardFile = null;
  app.dirty = false;
  updateTitle();
  rb.board.autosave(serialize(), null);
}

/* =====================================================================
 * 설정 (소스 관리)
 * ===================================================================*/

let editingId = null;

function openSettings() {
  refreshAddonStatus();
  $('#settings').classList.remove('hidden');
  $('#ffmpegPath').value = app.settings.ffmpegPath && app.settings.ffmpegPath !== 'ffmpeg' ? app.settings.ffmpegPath : '';
  $('#checkUpdates').checked = app.settings.checkUpdates !== false;
  showFfmpegInfo();
  renderSrcList();
  editSource(app.sources.find((s) => s.id === (editingId || app.sourceId)) || app.sources[0] || null);
}

// 지금 쓰는 ffmpeg: 직접 지정 / MoRef 에 들어 있는 것 / PATH
async function showFfmpegInfo() {
  const i = await rb.ffmpegInfo();
  $('#ffmpegInfo').textContent = i.custom ? tr('지정한 ffmpeg 를 씁니다') : i.bundled ? tr('MoRef 에 들어 있는 ffmpeg 를 씁니다') : tr('PATH 의 ffmpeg 를 씁니다 (MoRef 에 들어 있지 않음)');
}

function renderSrcList() {
  const list = $('#srcList');
  list.innerHTML = '';
  for (const s of app.sources) {
    const d = h('div', 'src-item' + (s.id === editingId ? ' active' : ''), s.name);
    d.append(h('small', '', s.type === 'dav' ? 'WebDAV' : s.url)); // WebDAV 주소는 화면에 다시 띄우지 않는다
    d.onclick = () => editSource(s);
    list.append(d);
  }
}

function editSource(s) {
  const f = $('#srcForm');
  editingId = s?.id || null;
  f.id.value = s?.id || '';
  f.name.value = s?.name || '';
  f.type.value = s?.type || 'dav';
  f.url.value = s?.type === 'local' ? s.url : '';
  f.username.value = '';
  f.password.value = '';
  // 저장된 WebDAV 의 주소 / 아이디는 다시 보여 주지 않는다. [바꾸기] 를 눌러야 새로 넣는 칸이 열린다
  f.classList.toggle('login-locked', s?.type === 'dav');
  f.password.placeholder = s?.hasPassword ? tr('저장됨 - 바꾸려면 새로 입력') : '';
  f.insecureTLS.checked = !!s?.insecureTLS;
  $('#btnDelSrc').style.display = s ? '' : 'none';
  $('#testResult').textContent = '';
  onTypeChange();
  renderSrcList();
}

// 지금 고치는 소스가 같은 종류로 저장돼 있으면 주소 / 아이디 칸을 비워 둬도 저장된 값을 쓴다
const savedSameType = (f) => !!f.id.value && app.sources.find((s) => s.id === f.id.value)?.type === f.type.value;

function onTypeChange() {
  const f = $('#srcForm');
  const dav = f.type.value === 'dav';
  if (!dav) f.classList.remove('login-locked'); // 로컬 폴더로 바꾸면 경로를 새로 넣어야 한다
  $('.dav-only', f).style.display = dav ? '' : 'none';
  $('#btnBrowse').style.display = dav ? 'none' : '';
  $('#urlLabel').textContent = dav ? tr('WebDAV 주소') : tr('폴더 경로');
  const keep = dav && savedSameType(f) ? tr('비워 두면 저장된 값을 그대로 씁니다') : '';
  f.url.placeholder = keep || (dav ? 'https://192.168.0.10:5006/refs' : tr('\\\\NAS\\refs  또는  Z:\\refs'));
  f.username.placeholder = keep;
}

function formData() {
  const f = $('#srcForm');
  return {
    id: f.id.value || undefined,
    name: f.name.value,
    type: f.type.value,
    url: f.url.value,
    username: f.username.value,
    password: f.password.value,
    insecureTLS: f.insecureTLS.checked,
    keepLogin: savedSameType(f), // 주소 / 아이디 칸이 비어 있으면 저장된 값 유지
  };
}

function initSettings() {
  const f = $('#srcForm');
  f.type.onchange = onTypeChange;
  $('#btnBrowse').onclick = async () => {
    const p = await rb.pickFolder();
    if (p) f.url.value = p;
  };
  $('#btnAddSrc').onclick = () => editSource(null);
  $('#btnEditLogin').onclick = () => {
    f.classList.remove('login-locked');
    f.url.focus();
  };
  $('#btnTest').onclick = async () => {
    const out = $('#testResult');
    out.className = 'test-result';
    out.textContent = tr('연결 중…');
    const r = await rb.source.test(formData());
    out.className = 'test-result ' + (r.ok ? 'ok' : 'bad');
    out.textContent = r.ok ? tr('연결 성공 - 최상위에 폴더/미디어 {0}개', r.count) : tr('실패: {0}', r.error);
  };
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    if (!f.url.value.trim() && !savedSameType(f)) {
      $('#testResult').className = 'test-result bad';
      $('#testResult').textContent = tr('주소/경로를 입력하세요');
      return;
    }
    const saved = await rb.source.save(formData());
    const i = app.sources.findIndex((s) => s.id === saved.id);
    if (i >= 0) app.sources[i] = saved;
    else app.sources.push(saved);
    app.listCache.clear();
    editSource(saved);
    app.sourceId = saved.id;
    renderSourceSelect();
    openFolder('');
    toast(tr('소스 저장됨'));
  };
  $('#btnDelSrc').onclick = async () => {
    if (!editingId || !(await askConfirm(tr('이 소스를 삭제할까요? (NAS 파일은 그대로입니다)'), { okLabel: tr('삭제'), danger: true }))) return;
    await rb.source.delete(editingId);
    app.sources = app.sources.filter((s) => s.id !== editingId);
    if (app.sourceId === editingId) app.sourceId = app.sources[0]?.id || null;
    editSource(app.sources[0] || null);
    renderSourceSelect();
    openFolder('');
  };
  $('#checkUpdates').onchange = (e) => {
    app.settings.checkUpdates = e.target.checked;
    rb.setSetting('checkUpdates', e.target.checked);
  };
  $('#ffmpegPath').onchange = async (e) => {
    app.settings.ffmpegPath = e.target.value.trim() || 'ffmpeg'; // 'ffmpeg' = 자동 (src/ffmpeg.js)
    await rb.setSetting('ffmpegPath', app.settings.ffmpegPath);
    showFfmpegInfo();
  };
  $('#btnClearThumbs').onclick = async () => {
    const freed = await rb.thumb.clear();
    toast(tr('캐시를 비웠습니다 ({0})', fmtSize(freed) || `${Math.round((freed || 0) / 1e6)}MB`));
    thumbDone.clear();
    thumbUrls.clear(); // 구간 · 예고편 썸네일 주소 (segthumbs.js)
    renderGrid();
  };
  for (const m of document.querySelectorAll('.modal')) {
    m.addEventListener('pointerdown', (e) => e.target === m && m.classList.add('hidden'));
    $('[data-close]', m).onclick = () => m.classList.add('hidden');
  }
}

/* =====================================================================
 * 창 / 단축키
 * ===================================================================*/

function setPinned(on) {
  app.settings.alwaysOnTop = on;
  $('#btnPin').classList.toggle('on', on);
  rb.setSetting('alwaysOnTop', on);
}

function initTitlebar() {
  $('#btnMin').onclick = rb.win.minimize;
  $('#btnMax').onclick = rb.win.toggleMaximize;
  $('#btnClose').onclick = async () => {
    await rb.board.autosave(serialize(), app.boardFile);
    rb.win.close();
  };
  rb.win.onState(({ maximized }) => ($('#btnMax').innerHTML = maximized ? '&#xE923;' : '&#xE922;'));
  $('#btnNew').onclick = newBoard;
  $('#btnOpen').onclick = openBoard;
  $('#btnSave').onclick = (e) => saveBoard(e.shiftKey);
  $('#btnPin').onclick = () => setPinned(!app.settings.alwaysOnTop);
  $('#btnFit').onclick = fitView;
  $('#btnSettings').onclick = openSettings;
  $('#btnHelp').onclick = () => $('#help').classList.remove('hidden');
  $('#opacity').oninput = (e) => rb.setSetting('opacity', Number(e.target.value) / 100);
  $('#titlebar').ondblclick = (e) => !e.target.closest('button,input,label') && rb.win.toggleMaximize();
}

function initKeys() {
  window.addEventListener('keydown', (e) => {
    const inField = e.target.closest('input, select, textarea');
    const ctrl = e.ctrlKey || e.metaKey;
    if (app.cropping && (e.key === 'Escape' || e.key === 'Enter') && !inField) {
      e.preventDefault();
      return e.key === 'Enter' ? applyCrop(app.cropping) : cancelCrop(app.cropping);
    }
    if (e.key === 'Escape') {
      const open = [...document.querySelectorAll('.modal:not(.hidden)')];
      open.forEach((m) => m.classList.add('hidden'));
      if (!open.length && app.draw.on) setDrawMode(false);
      return;
    }
    if (ctrl) {
      const k = e.key.toLowerCase();
      if (inField && (k === 'z' || k === 'y')) return; // 입력칸 자체 되돌리기
      if (k === 'z' && !e.shiftKey) undo();
      else if (k === 'y' || (k === 'z' && e.shiftKey)) redo();
      else if (k === 's') saveBoard(e.shiftKey);
      else if (k === 'o') openBoard();
      else if (k === 'n') newBoard();
      else if (k === 't') setPinned(!app.settings.alwaysOnTop);
      else if (k === 'a' && !inField) {
        for (const it of app.items.values()) select(it, true);
      } else return;
      e.preventDefault();
      return;
    }
    if (inField) return;
    const sel = [...app.selected];
    const each = (fn) => sel.forEach(fn);
    // Shift+H / V / G: 좌우 반전 · 상하 반전 · 흑백
    if (e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      const act = { h: (it) => toggleFlip(it, 'flipH'), v: (it) => toggleFlip(it, 'flipV'), g: toggleGray }[k];
      if (act) {
        each(act);
        e.preventDefault();
        return;
      }
    }
    switch (e.key) {
      case 'Tab': togglePanel(); break;
      case 'F1': $('#help').classList.remove('hidden'); break;
      case ' ': each(togglePlay); break;
      case 'ArrowLeft': each((it) => step(it, e.shiftKey ? -1 : -FRAME)); break;
      case 'ArrowRight': each((it) => step(it, e.shiftKey ? 1 : FRAME)); break;
      case '[': each((it) => setLoopPoint(it, 'a')); break;
      case ']': each((it) => setLoopPoint(it, 'b')); break;
      case '\\': each(clearLoop); break;
      case '-': each((it) => changeSpeed(it, -1)); break;
      case '=': case '+': each((it) => changeSpeed(it, 1)); break;
      case 'm': case 'M': each(toggleMute); break;
      case 'c': case 'C': if (sel.length === 1) startCrop(sel[0]); break;
      case 'l': case 'L': if (app.linked) each(toggleSync); break;
      case '0': each(clearLoop); break;
      case 'F2': if (sel.length === 1) renameCurrent(sel[0]); break;
      case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9':
        each((it) => it.segments?.[Number(e.key) - 1] && activateSegment(it, it.segments[Number(e.key) - 1].id));
        break;
      case 'g': case 'G': each(toggleFrames); break;
      case 'k': case 'K': each(toggleOnion); break;
      case 'f': case 'F': fitView(); break;
      case 'd': case 'D': setDrawMode(!app.draw.on); break;
      case 'h': case 'H': toggleDrawHidden(); break;
      case 'p': case 'P': setDrawMode(true); setTool('pen'); break;
      case 'a': case 'A': setDrawMode(true); setTool('arrow'); break;
      case 'o': case 'O': setDrawMode(true); setTool('circle'); break;
      case 'e': case 'E': setDrawMode(true); setTool('eraser'); break;
      case 'Delete': each(removeItem); break;
      case 'Backspace':
        if (sel.length) each(removeItem);
        else goUp();
        break;
      default: return;
    }
    e.preventDefault();
  });
}

/* =====================================================================
 * 시작
 * ===================================================================*/

async function main() {
  const init = await rb.init();
  Object.assign(app, { proxyBase: init.proxyBase, sources: init.sources, settings: init.settings, debugSync: !!init.debugSync });
  app.settings.languageNow = init.language;
  const st = app.settings;
  if (st.panelWidth) document.documentElement.style.setProperty('--panel-w', st.panelWidth + 'px');
  if (st.panelHidden) document.body.classList.add('panel-hidden');
  $('#opacity').value = Math.round((st.opacity || 1) * 100);
  $('#btnPin').classList.toggle('on', !!st.alwaysOnTop);

  initTitlebar();
  initPanel();
  initLibrary();
  initBoard();
  initSettings();
  initDraw();
  initMenus();
  initBlenderLink();
  initUpdateNotice();
  initAddonSetup();
  initPeek();
  initMediaSaver();
  initKeys();
  // 입력이 있으면 진행 바 / 프레임 번호를 바로 따라가게 (GIF 이동 · 진행 바 끌기는 미디어 이벤트가 없다)
  for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown']) window.addEventListener(ev, wakeTick, { capture: true, passive: true });
  wakeTick();

  await loadClipLib();
  const last = st.lastFolder;
  app.sourceId = app.sources.find((s) => s.id === last?.sourceId)?.id || app.sources[0]?.id || null;
  renderSourceSelect();
  openFolder(app.sourceId === last?.sourceId ? last.path || '' : '');

  const restored = await rb.board.restore();
  if (restored?.json) {
    await loadBoard(restored.json, restored.filePath);
    if (restored.dirty) {
      app.dirty = true; // 새로 고치기 전에 저장 안 된 변경이 있었다
      updateTitle();
    }
  } else updateTitle();
  layoutAll();

  if (!app.sources.length) openSettings();
}

window.RB = { app, undo, redo, setDrawMode, setTool, setColor, setWidth, clearDrawings, addItem, openFolder, openSettings, saveBoard, loadBoard, serialize, fitView, select, setLoopPoint, changeSpeed, removeItem };
main();
