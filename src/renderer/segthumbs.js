'use strict';
/* global app, rb, $, h, icon, toast, fmtTime, isTimed, fpsOf, segActive, segColor, segName, segFrames, libKey,
   activateSegment, segMenu, setHover, goToItem, addItem, boardCenter, boardKey, renderSegments */
// 반복 구간 썸네일
//  * 보드: 구간이 있는 레퍼런스 오른쪽에 세로로 구간 시작 프레임 썸네일 (누르면 그 구간 반복)
//  * 패널: 구간이 저장된 파일 카드에 "구간 n" 표시 → 누르면 카드 아래에 구간 썸네일 줄 (누르면 보드에서 그 구간으로)

const SIDE_W = 96;
const SIDE_W_SMALL = 60;
const thumbUrls = new Map(); // 썸네일 키 → file:// 주소 (요청 중이면 Promise)

// 구간 시작 프레임의 썸네일.
// ffmpeg -ss T 는 "시각이 T 이상인 첫 프레임"을 준다. 구간 시작(= 그 프레임의 시작 시각)보다 4ms 앞을 주면
// fps 와 상관없이(250fps 까지) 정확히 시작 프레임이 나온다. (가운데를 주면 다음 프레임이 나온다)
function rangeThumb(ref, kind, a) {
  const at = Math.max(0, a - 0.004);
  const entry = ref.file
    ? { file: ref.file, kind, at }
    : { sourceId: ref.sourceId, path: ref.path, size: ref.size, mtime: ref.mtime, kind, at };
  const key = JSON.stringify(entry);
  const known = thumbUrls.get(key);
  if (known) return Promise.resolve(known);
  const p = rb.thumb.get(entry, 'high').then((r) => {
    if (r.url) thumbUrls.set(key, r.url);
    else thumbUrls.delete(key);
    return r.url || null;
  });
  thumbUrls.set(key, p);
  return p;
}

const setImg = (img, p) =>
  Promise.resolve(p).then((url) => {
    if (url && img.isConnected !== false) img.style.backgroundImage = `url("${url}")`;
  });

// ---------- 보드: 오른쪽 세로 썸네일 ----------

function buildSide(it) {
  const side = h('div', 'segside');
  const stop = (e) => e.stopPropagation();
  side.onpointerdown = side.onwheel = side.ondblclick = stop;
  side.addEventListener('pointerenter', () => setHover(it, true));
  side.addEventListener('pointerleave', () => setHover(it, false));
  side.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  $('#ctlLayer').append(side);
  it.sideEl = side;
  return side;
}

function renderSide(it) {
  const side = it.sideEl;
  if (!side) return;
  const segs = it.segments || [];
  side.classList.toggle('has', segs.length > 0);
  if (!segs.length) return side.replaceChildren();
  const s = segActive(it);
  const fps = fpsOf(it);
  // 같은 구간(위치·이름·활성)이면 다시 만들지 않는다 (썸네일 깜박임 방지)
  const sig = JSON.stringify([segs.map((g) => [g.id, g.a, g.b, g.name]), s?.id, fps]);
  if (side.dataset.sig === sig) return;
  side.dataset.sig = sig;
  side.replaceChildren(
    ...segs.map((g, i) => {
      const tile = h('button', 'st' + (g === s ? ' on' : ''));
      tile.style.setProperty('--c', segColor(g));
      const img = h('div', 'img');
      const meta = h('div', 'meta');
      meta.append(h('b', '', String(i + 1)));
      if (g.name) meta.append(Object.assign(h('span', 'nm'), { textContent: g.name }));
      meta.append(h('span', 'fc', `${segFrames(it, g) || ''}f`));
      tile.append(img, meta);
      tile.title = tr('{0} · {1} – {2}\n클릭: 이 구간 반복 · 우클릭: 메뉴', segName(it, g), fmtTime(g.a), fmtTime(g.b ?? it.media.duration));
      tile.onclick = (e) => {
        e.stopPropagation();
        activateSegment(it, g === s ? null : g.id);
      };
      tile.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        segMenu(it, g, e.clientX, e.clientY);
      };
      setImg(img, rangeThumb(it.ref, it.kind, g.a));
      return tile;
    })
  );
}

// layoutItem 에서 불린다: 레퍼런스 오른쪽, 같은 높이 (화면 크기 고정 폭)
function positionSide(it) {
  const side = it.sideEl;
  if (!side) return;
  const { x, y, s } = app.view;
  const sw = it.w * s < 160 || it.h * s < 100 ? SIDE_W_SMALL : SIDE_W;
  let left = it.x * s + x + it.w * s + 8;
  // 오른쪽에 자리가 없으면 왼쪽에 붙인다
  const flip = left + sw > board.clientWidth && it.x * s + x - sw - 8 >= 0;
  if (flip) left = it.x * s + x - sw - 8;
  side.classList.toggle('left', flip);
  const top = it.y * s + y;
  side.style.left = left + 'px';
  side.style.top = top + 'px';
  side.style.maxHeight = Math.max(it.h * s, 140) + 'px';
  // 작은 레퍼런스에서는 마우스를 올리거나 선택했을 때만, 그리고 좁게 (번호만)
  const compact = it.w * s < 160 || it.h * s < 100;
  side.style.width = (compact ? SIDE_W_SMALL : SIDE_W) + 'px';
  side.style.zIndex = it.z;
  side.classList.toggle('compact', compact);
}

function refreshSideVisibility(it) {
  it.sideEl?.classList.toggle('show', !!(it.hover || app.selected.has(it)));
}

// ---------- 패널: 카드의 구간 표시 + 펼친 썸네일 줄 ----------

async function loadClipLib() {
  app.clipLib = (await rb.clips.all()) || {};
}

// 카드 하나에 구간 표시 붙이기 (renderGrid 에서)
function decorateCard(card) {
  const e = card._entry;
  if (e.kind !== 'video' && e.kind !== 'gif') return;
  const segs = app.clipLib[card._key];
  card.querySelector('.segbadge')?.remove();
  card._segRow?.remove();
  card._segRow = null;
  if (!segs?.length) return;
  const badge = h('button', 'segbadge' + (app.panelOpen.has(card._key) ? ' open' : ''));
  badge.innerHTML = `${icon('loop')}<span>${segs.length}</span>`;
  badge.title = tr('저장된 구간 {0}개 - 눌러서 펼치기', segs.length);
  badge.onclick = (ev) => {
    ev.stopPropagation();
    if (app.panelOpen.has(card._key)) app.panelOpen.delete(card._key);
    else app.panelOpen.add(card._key);
    decorateCard(card);
  };
  badge.ondblclick = (ev) => ev.stopPropagation();
  card.querySelector('.th').append(badge);
  if (app.panelOpen.has(card._key)) {
    const row = buildSegRow(card, segs);
    card.after(row);
    card._segRow = row;
  }
}

function buildSegRow(card, segs) {
  const e = card._entry;
  const ref = { sourceId: card._sourceId, path: e.path, size: e.size, mtime: e.mtime };
  const row = h('div', 'segrow');
  const head = h('div', 'segrow-head');
  head.append(Object.assign(h('span'), { textContent: e.name }), h('span', 'n', tr('구간 {0}', segs.length)));
  row.append(head);
  const list = h('div', 'segrow-list');
  segs.forEach((g, i) => {
    const tile = h('button', 'pt');
    tile.style.setProperty('--c', segColor(g));
    const img = h('div', 'img');
    const meta = h('div', 'meta');
    meta.append(h('b', '', String(i + 1)));
    if (g.name) meta.append(Object.assign(h('span', 'nm'), { textContent: g.name }));
    tile.append(img, meta);
    tile.title = tr('구간 {0}{1} · {2}{3}\n클릭: 보드에서 이 구간으로', i + 1, g.name ? ` · ${g.name}` : '', fmtTime(g.a), g.b != null ? ` – ${fmtTime(g.b)}` : '');
    tile.onclick = (ev) => {
      ev.stopPropagation();
      openRange(card._sourceId, e, g.id);
    };
    setImg(img, rangeThumb(ref, e.kind, g.a));
    list.append(tile);
  });
  row.append(list);
  return row;
}

// 보드에서 그 구간으로: 이미 있으면 그리로 이동, 없으면 올리고 그 구간부터
async function openRange(sourceId, entry, segId) {
  const existing = [...app.items.values()].find((it) => it.ref.sourceId === sourceId && it.ref.path === entry.path);
  if (existing) {
    goToItem(existing);
    activateSegment(existing, segId);
    return;
  }
  const c = boardCenter();
  const it = await addItem({
    kind: entry.kind,
    ref: { sourceId, path: entry.path, size: entry.size, mtime: entry.mtime },
    name: entry.name,
    x: c.x,
    y: c.y,
    center: true,
    openSeg: segId,
  });
  setTimeout(() => app.items.has(it.id) && goToItem(it), 600);
}

// 구간이 바뀌면 (saveSegments 에서): 패널 표시도 바로 고친다
function clipLibChanged(key, segments) {
  if (segments?.length) app.clipLib[key] = segments.map((s) => ({ ...s }));
  else delete app.clipLib[key];
  const card = app.cardByKey.get(key);
  if (card) decorateCard(card);
  libraryChanged(); // 구간 탭
}
