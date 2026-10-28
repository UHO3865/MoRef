'use strict';
/* global app, $, h, icon, toast, select, layoutItem, markDirty, renderShapes, round4, toggleFrames, setDrawMode */
// 좌우/상하 반전 · 흑백 · 자르기 — 영상/GIF/이미지 공통, 보드 파일에 저장된다.
//
// 좌표계
//  * 원본 좌표 (sx, sy): 원본 영상/이미지 전체에 대한 0~1 비율. it.crop = { x, y, w, h } 도 이 좌표.
//  * 표시 좌표 (u, v): 보드에 보이는 항목 상자에 대한 0~1 비율. 자르기 → 반전 순서로 원본에서 표시로 간다.
//  * 그림(it.shapes)은 "항목 너비 = 1" 단위의 표시 좌표라, 자르기/반전이 바뀌면 같은 내용 위에 남도록 옮겨 준다.
// 자르면 내용의 크기와 위치는 그대로 두고 항목 상자만 줄어든다 (PureRef 와 같음).

const FULL_CROP = { x: 0, y: 0, w: 1, h: 1 };
const MIN_CROP = 0.02;
const cropOf = (it) => it.crop || FULL_CROP;
const isFullCrop = (c) => !c || (c.x <= 0.0005 && c.y <= 0.0005 && c.w >= 0.999 && c.h >= 0.999);

function viewState(it) {
  return { crop: cropOf(it), flipH: !!it.flipH, flipV: !!it.flipV, aspect: it.h / it.w };
}

function toSource(st, u, v) {
  const c = st.crop;
  return [c.x + (st.flipH ? 1 - u : u) * c.w, c.y + (st.flipV ? 1 - v : v) * c.h];
}

function toDisplay(st, sx, sy) {
  const c = st.crop;
  let u = (sx - c.x) / c.w;
  let v = (sy - c.y) / c.h;
  if (st.flipH) u = 1 - u;
  if (st.flipV) v = 1 - v;
  return [u, v];
}

// 원본 비율의 사각형 → 표시 상자 안에서의 위치 (반전 반영)
function cropToDisplay(it, c) {
  return {
    x: it.flipH ? 1 - c.x - c.w : c.x,
    y: it.flipV ? 1 - c.y - c.h : c.y,
    w: c.w,
    h: c.h,
  };
}

function remapShapes(it, from, to) {
  if (!it.shapes?.length) return;
  const k = from.crop.w / to.crop.w; // 굵기도 "항목 너비" 단위라 같이 바뀐다
  it.shapes = it.shapes.map((s) => ({
    ...s,
    w: round4(s.w * k),
    p: s.p.map(([px, py]) => {
      const [sx, sy] = toSource(from, px, py / from.aspect);
      const [u, v] = toDisplay(to, sx, sy);
      return [round4(u), round4(v * to.aspect)];
    }),
  }));
  renderShapes(it);
}

// 미디어 요소 배치 (자르기) + 반전 / 흑백
function applyVisual(it) {
  const m = it.media.canvas || it.media;
  const grid = it.kind === 'gif' && it.media.grid;
  const c = it.cropEdit || grid ? FULL_CROP : cropOf(it);
  m.style.width = 100 / c.w + '%';
  m.style.height = 100 / c.h + '%';
  m.style.left = (-c.x / c.w) * 100 + '%';
  m.style.top = (-c.y / c.h) * 100 + '%';
  m.style.objectFit = grid ? 'contain' : 'fill';
  it.vis.style.transform = it.flipH || it.flipV ? `scale(${it.flipH ? -1 : 1}, ${it.flipV ? -1 : 1})` : '';
  it.vis.style.filter = it.gray ? 'grayscale(1)' : '';
  updateViewBadges(it);
}

function updateViewBadges(it) {
  const b = it.badges;
  if (!b) return;
  const on = [
    it.flipH && ['mirror', tr('좌우 반전')],
    it.flipV && ['flipV', tr('상하 반전')],
    it.gray && ['gray', tr('흑백')],
    it.crop && ['crop', tr('잘림')],
    it.sync && ['link', tr('Blender 타임라인에 맞춤')],
  ].filter(Boolean);
  b.innerHTML = on.map(([ic, t]) => `<span title="${t}">${icon(ic)}</span>`).join('');
  it.el.classList.toggle('has-view', on.length > 0);
}

// ---------- 반전 / 흑백 ----------

function toggleFlip(it, axis) {
  if (it.cropEdit) return;
  const from = viewState(it);
  it[axis] = !it[axis];
  remapShapes(it, from, viewState(it));
  applyVisual(it);
  markDirty();
  toast(axis === 'flipH' ? (it.flipH ? tr('좌우 반전') : tr('좌우 반전 끔')) : it.flipV ? tr('상하 반전') : tr('상하 반전 끔'));
}

function toggleGray(it) {
  it.gray = !it.gray;
  applyVisual(it);
  markDirty();
  toast(it.gray ? tr('흑백') : tr('흑백 끔'));
}

// ---------- 자르기 ----------

// 내용은 제자리에 둔 채 자르기 영역만 바꾼다 (항목 위치/크기를 다시 계산)
function setCrop(it, next) {
  const from = viewState(it);
  const c0 = cropOf(it);
  const c1 = isFullCrop(next) ? FULL_CROP : next;
  const W = it.w / c0.w; // 원본 전체가 보일 때의 크기
  const H = it.h / c0.h;
  const d0 = cropToDisplay(it, c0);
  const X = it.x - d0.x * W;
  const Y = it.y - d0.y * H;
  const d1 = cropToDisplay(it, c1);
  it.x = X + d1.x * W;
  it.y = Y + d1.y * H;
  it.w = W * c1.w;
  it.h = H * c1.h;
  it.crop = c1 === FULL_CROP ? null : { x: round4(c1.x), y: round4(c1.y), w: round4(c1.w), h: round4(c1.h) };
  remapShapes(it, from, viewState(it));
  applyVisual(it);
  layoutItem(it);
  markDirty();
}

function startCrop(it) {
  if (it.cropEdit) return;
  if (app.cropping) applyCrop(app.cropping);
  if (app.draw.on) setDrawMode(false);
  if (it.kind === 'gif' && it.media.grid) toggleFrames(it);
  select(it, false);
  const c0 = cropOf(it);
  it.cropEdit = { ...c0, before: { x: it.x, y: it.y, w: it.w, h: it.h } };
  // 원본 전체를 보여 준다 (내용은 제자리)
  const W = it.w / c0.w;
  const H = it.h / c0.h;
  const d0 = cropToDisplay(it, c0);
  it.x -= d0.x * W;
  it.y -= d0.y * H;
  it.w = W;
  it.h = H;
  app.cropping = it;
  it.el.classList.add('cropping');
  buildCropUi(it);
  applyVisual(it);
  layoutItem(it);
  drawCropBox(it);
  toast(tr('자르기: 모서리를 끌어 영역을 정하고 Enter · Esc 취소'), 2600);
}

function endCropUi(it) {
  const b = it.cropEdit.before;
  Object.assign(it, b);
  const crop = { x: it.cropEdit.x, y: it.cropEdit.y, w: it.cropEdit.w, h: it.cropEdit.h };
  it.cropEdit = null;
  app.cropping = null;
  it.cropUi?.remove();
  it.cropUi = null;
  it.el.classList.remove('cropping');
  return crop;
}

function applyCrop(it) {
  if (!it?.cropEdit) return;
  const crop = endCropUi(it);
  setCrop(it, crop);
  toast(isFullCrop(crop) ? tr('자르기 해제') : tr('잘랐습니다 (우클릭 ▸ 자르기 해제로 되돌림)'));
}

function cancelCrop(it) {
  if (!it?.cropEdit) return;
  endCropUi(it);
  applyVisual(it);
  layoutItem(it);
}

function resetCrop(it) {
  if (it.cropEdit) cancelCrop(it);
  if (!it.crop) return;
  setCrop(it, null);
  toast(tr('자르기 해제'));
}

function buildCropUi(it) {
  const ui = h('div', 'cropui');
  const box = h('div', 'cropbox');
  for (const d of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
    const hd = h('i', 'ch ' + d);
    hd.dataset.dir = d;
    box.append(hd);
  }
  box.append(h('b', 'third v1'), h('b', 'third v2'), h('b', 'third h1'), h('b', 'third h2'));
  const bar = h('div', 'cropbar');
  const mk = (label, cls, fn) => {
    const b = h('button', cls, label);
    b.onpointerdown = (e) => e.stopPropagation();
    b.onclick = (e) => {
      e.stopPropagation();
      fn();
    };
    bar.append(b);
  };
  mk(tr('전체'), '', () => {
    Object.assign(it.cropEdit, FULL_CROP);
    drawCropBox(it);
  });
  mk(tr('취소'), '', () => cancelCrop(it));
  mk(tr('적용'), 'primary', () => applyCrop(it));
  box.append(bar);
  // 바깥 어둡게: 항목 안에서만 (손잡이는 가장자리 밖으로 나와야 잡기 쉬워서 따로 잘라 둔다)
  const dim = h('div', 'cropdim');
  it.cropShade = h('div', 'cropshade');
  dim.append(it.cropShade);
  ui.append(dim, box);
  ui.onpointerdown = (ev) => cropPointerDown(ev, it);
  ui.ondblclick = (ev) => {
    ev.stopPropagation();
    applyCrop(it);
  };
  it.el.append(ui);
  it.cropUi = ui;
  it.cropBox = box;
}

function drawCropBox(it) {
  const d = cropToDisplay(it, it.cropEdit);
  for (const el of [it.cropBox, it.cropShade]) {
    const st = el.style;
    st.left = d.x * 100 + '%';
    st.top = d.y * 100 + '%';
    st.width = d.w * 100 + '%';
    st.height = d.h * 100 + '%';
  }
}

function cropPointerDown(ev, it) {
  if (ev.button !== 0) return;
  ev.stopPropagation();
  const r = it.el.getBoundingClientRect();
  const at = (e) => [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  const start = at(ev);
  const d0 = cropToDisplay(it, it.cropEdit); // 표시 좌표에서 편집하고, 원본 좌표로 저장
  const dir = ev.target.dataset?.dir || (ev.target.closest('.cropbox') ? 'move' : 'new');
  const ui = it.cropUi;
  ui.setPointerCapture(ev.pointerId);
  ui.onpointermove = (m) => {
    const [u, v] = at(m);
    let { x, y, w, h: hh } = d0;
    if (dir === 'move') {
      x = Math.min(1 - w, Math.max(0, d0.x + u - start[0]));
      y = Math.min(1 - hh, Math.max(0, d0.y + v - start[1]));
    } else if (dir === 'new') {
      x = Math.min(start[0], u);
      y = Math.min(start[1], v);
      w = Math.max(MIN_CROP, Math.abs(u - start[0]));
      hh = Math.max(MIN_CROP, Math.abs(v - start[1]));
      x = Math.min(x, 1 - w);
      y = Math.min(y, 1 - hh);
    } else {
      let l = d0.x;
      let t = d0.y;
      let rr = d0.x + d0.w;
      let b = d0.y + d0.h;
      if (dir.includes('w')) l = Math.min(u, rr - MIN_CROP);
      if (dir.includes('e')) rr = Math.max(u, l + MIN_CROP);
      if (dir.includes('n')) t = Math.min(v, b - MIN_CROP);
      if (dir.includes('s')) b = Math.max(v, t + MIN_CROP);
      x = l;
      y = t;
      w = rr - l;
      hh = b - t;
    }
    // 표시 → 원본 (반전돼 있으면 뒤집어서)
    it.cropEdit.x = it.flipH ? 1 - x - w : x;
    it.cropEdit.y = it.flipV ? 1 - y - hh : y;
    it.cropEdit.w = w;
    it.cropEdit.h = hh;
    drawCropBox(it);
  };
  ui.onpointerup = () => {
    ui.onpointermove = null;
  };
}
