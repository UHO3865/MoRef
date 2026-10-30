'use strict';
/* global app, rb, $, tr, toast, icon, isTimed, currentFrame, shapeEl, renderShapes, applyVisual, markDirty, onionColor */
// 프레임별 그리기 / 배경 (그림만 보기)
//
// 프레임별 그리기 (그리기 막대의 필름 버튼): 켜고 그린 선은 그때의 프레임에만 보인다 (도형의 f = 프레임 번호).
//   끄고 그린 선(f 없음)은 예전처럼 모든 프레임에 보인다. ← → 로 프레임을 옮기며 그리면 프레임마다 다른 그림이 된다.
//   어니언 스킨이 켜져 있으면 앞뒤 프레임의 그림도 옅게 (이전 초록 · 다음 파랑, 프레임 수도 어니언과 같게).
// 배경 (그리기 막대의 배경 버튼 / B): 그대로 → 흑백 → 숨김 (그림만). 숨겨도 영상은 그대로 돌아서,
//   재생하면 프레임별 그림이 플립북처럼 움직인다.

function togglePerFrame(force) {
  app.draw.perFrame = force ?? !app.draw.perFrame;
  updateDrawExtrasUi();
  rb.setSetting('draw', { tool: app.draw.tool, color: app.draw.color, width: app.draw.width, perFrame: app.draw.perFrame });
  toast(app.draw.perFrame ? tr('프레임별 그리기: 지금 프레임에만 그립니다 (← → 로 프레임 이동)') : tr('프레임별 그리기 끔: 모든 프레임에 보이게 그립니다'));
}

// 이 도형이 지금 보이는가 (프레임별로 그린 것은 그 프레임에서만)
function shapeVisible(s, cur) {
  return s.f == null || cur == null || s.f === cur;
}

// 프레임별 그림이 있는 항목의 지금 프레임 (없으면 null - 모든 도형을 그대로 그린다)
function shapeFrameOf(it) {
  return isTimed(it) && it.shapes.some((s) => s.f != null) ? currentFrame(it) : null;
}

// renderShapes 가 그릴 노드: 어니언으로 앞뒤 프레임 그림 (먼 것부터) + 지금 보이는 그림
function shapeNodes(it) {
  const cur = shapeFrameOf(it);
  it.shapeFrame = cur;
  const nodes = [];
  if (cur != null && it.onion) {
    const ghosts = [];
    for (const s of it.shapes) {
      if (s.f == null || s.f === cur) continue;
      const d = s.f - cur;
      const n = d < 0 ? it.onion.b : it.onion.a;
      if (Math.abs(d) > n) continue;
      ghosts.push({ s, d: Math.abs(d), n, tint: onionColor(d < 0 ? 'b' : 'a', Math.abs(d)) });
    }
    ghosts.sort((x, y) => y.d - x.d);
    for (const g of ghosts) {
      const node = shapeEl({ ...g.s, c: `rgb(${g.tint.join(',')})` });
      node.setAttribute('opacity', (0.7 * (1 - (g.d - 1) / (g.n + 1))).toFixed(2));
      node.classList.add('ghost');
      nodes.push(node);
    }
  }
  for (const s of it.shapes) if (shapeVisible(s, cur)) nodes.push(shapeEl(s));
  return nodes;
}

// tick() 에서: 프레임이 바뀌면 그 프레임의 그림으로 (그리는 중에는 건드리지 않는다)
function frameShapesTick(it) {
  if (it.shapeFrame == null || it.stroking) return;
  if (currentFrame(it) !== it.shapeFrame) renderShapes(it);
}

/* ---------- 배경: 그대로 / 흑백 / 숨김 ---------- */

const bgOf = (it) => (it.hideMedia ? 'hidden' : it.gray ? 'gray' : 'normal');
const BG_NEXT = { normal: 'gray', gray: 'hidden', hidden: 'normal' };
const BG_LABEL = () => ({ normal: tr('배경: 그대로'), gray: tr('배경: 흑백'), hidden: tr('배경: 숨김 (그림만)') });

function setBackground(it, mode) {
  it.gray = mode === 'gray';
  it.hideMedia = mode === 'hidden';
  applyVisual(it);
  markDirty();
}

function toggleHideMedia(it) {
  setBackground(it, it.hideMedia ? (it.gray ? 'gray' : 'normal') : 'hidden');
  toast(BG_LABEL()[bgOf(it)]);
}

// 그리기 막대의 배경 버튼: 고른 항목 (없으면 보드 전체)을 함께 다음 단계로
function cycleBackground() {
  const targets = app.selected.size ? [...app.selected] : [...app.items.values()];
  if (!targets.length) return;
  const next = BG_NEXT[bgOf(targets[0])];
  for (const it of targets) setBackground(it, next);
  updateDrawExtrasUi();
  toast(BG_LABEL()[next]);
}

// applyVisual 에서: 숨기면 영상(과 영상 어니언)을 투명하게, 항목 바탕도 비운다
function applyBackground(it) {
  it.vis.style.opacity = it.hideMedia ? '0' : '';
  it.el.classList.toggle('media-hidden', !!it.hideMedia);
}

function updateDrawExtrasUi() {
  const pf = $('#btnPerFrame');
  if (!pf) return;
  pf.classList.toggle('on', !!app.draw.perFrame);
  document.body.classList.toggle('per-frame', !!app.draw.perFrame);
  const sel = app.selected.size ? [...app.selected] : [...app.items.values()];
  const mode = sel.length ? bgOf(sel[0]) : 'normal';
  const b = $('#btnBg');
  b.dataset.mode = mode;
  b.classList.toggle('on', mode !== 'normal');
  b.innerHTML = icon(mode === 'hidden' ? 'bgHidden' : mode === 'gray' ? 'gray' : 'bgShown');
  b.title = `${BG_LABEL()[mode]} - ${tr('누를 때마다 그대로 → 흑백 → 숨김 (B)')}`;
}

// 그리기 중 항목 위의 프레임 번호 (컨트롤 바가 숨겨져 있어서)
function updateFrameBadge(it) {
  const b = it.frameBadge;
  if (!b) return;
  const show = app.draw.on && app.draw.perFrame && isTimed(it);
  if (b.hidden === show) b.hidden = !show;
  if (!show) return;
  const f = currentFrame(it) + 1;
  const n = it.shapes.filter((s) => s.f === f - 1).length;
  const text = n ? tr('{0} 프레임 · 그림 {1}', f, n) : tr('{0} 프레임', f);
  if (b.textContent !== text) b.textContent = text;
}
