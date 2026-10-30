'use strict';
/* global $, h, tr, mediaUrl */
// 패널 썸네일을 꾹 누르고 있는 동안만 미리 보기 (떼면 닫힌다)
//  * 짧게 누르면(클릭 / 더블클릭) 미리 보기 없이 그대로 - 더블클릭은 보드에 올리기
//  * 누르자마자 움직이면 끌어다 놓기 (보드에 올리기). 미리 보기가 뜬 뒤에는 끌지 않고, 다른 썸네일로 옮기면 그것을 미리 본다
//  * 닫거나 다른 것으로 바꾸면 받던 것을 끊는다 (NAS 에 쓸데없는 요청이 남지 않게).
//    주소는 보드 재생과 같아서 NAS 요청 차례도 재생과 같다 (sources.js - 가장 먼저)

const PEEK_HOLD_MS = 220;
const PEEK_MOVE_PX = 5; // 이보다 먼저 움직이면 끌기로 본다
const peek = { el: null, card: null, down: null, timer: 0, seq: 0 };

const peekable = (card) => card?._entry && ['video', 'gif', 'image'].includes(card._entry.kind);

function initPeek() {
  peek.el = h('div', 'peek');
  peek.el.hidden = true;
  document.body.append(peek.el);
  const grid = $('#grid');
  grid.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const card = ev.target.closest('.card');
    if (!peekable(card)) return;
    clearTimeout(peek.timer);
    peek.down = { x: ev.clientX, y: ev.clientY };
    peek.timer = setTimeout(() => showPeek(card), PEEK_HOLD_MS);
  });
  grid.addEventListener(
    'dragstart',
    (ev) => {
      if (peek.card) ev.preventDefault();
      else cancelHold();
    },
    true,
  );
  document.addEventListener('pointermove', (ev) => {
    if (peek.card) {
      const card = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('#grid .card');
      if (card && card !== peek.card && peekable(card)) showPeek(card);
    } else if (peek.down && Math.hypot(ev.clientX - peek.down.x, ev.clientY - peek.down.y) > PEEK_MOVE_PX) {
      cancelHold();
    }
  });
  document.addEventListener('pointerup', closePeek);
  document.addEventListener('pointercancel', closePeek);
  grid.addEventListener('scroll', cancelHold, { passive: true });
  window.addEventListener('blur', closePeek);
}

function cancelHold() {
  clearTimeout(peek.timer);
  peek.down = null;
}

async function showPeek(card) {
  if (peek.card === card) return;
  peek.card?.classList.remove('peeking');
  peek.card = card;
  card.classList.add('peeking');
  const seq = ++peek.seq;
  const e = card._entry;
  stopPeekMedia();
  // 받는 동안은 썸네일을 깔아 둔다
  peek.el.style.backgroundImage = card.querySelector('.th')?.style.backgroundImage || '';
  peek.el.hidden = false;
  placePeek();
  const url = await mediaUrl({ sourceId: card._sourceId, path: e.path });
  if (seq !== peek.seq) return;
  // 첫 화면이 나오면 크기에 맞춰 다시 놓고 깔아 둔 썸네일을 걷는다
  const ready = () => {
    peek.el.style.backgroundImage = '';
    placePeek();
  };
  let m;
  if (e.kind === 'video') {
    m = h('video');
    m.muted = true;
    m.loop = true;
    m.playsInline = true;
    m.autoplay = true;
    m.onerror = () => peekError(seq, tr('재생할 수 없는 형식/코덱입니다'));
    m.onloadeddata = ready;
  } else {
    // GIF 도 <img> 로: 미리 보기는 움직이기만 하면 된다
    m = h('img');
    m.onerror = () => peekError(seq, tr('이미지를 불러올 수 없음'));
    m.onload = ready;
  }
  m.src = url;
  peek.el.replaceChildren(m, h('div', 'nm', e.name));
}

function peekError(seq, msg) {
  if (seq !== peek.seq) return;
  stopPeekMedia();
  peek.el.replaceChildren(h('div', 'err', msg), h('div', 'nm', peek.card?._entry.name || ''));
  placePeek();
}

function stopPeekMedia() {
  for (const m of peek.el.querySelectorAll('video, img')) {
    m.onerror = null;
    m.removeAttribute('src');
    if (m.load) m.load(); // 받던 것을 끊는다
  }
  peek.el.replaceChildren();
}

function closePeek() {
  cancelHold();
  if (!peek.card) return;
  peek.seq++;
  peek.card.classList.remove('peeking');
  peek.card = null;
  stopPeekMedia();
  peek.el.hidden = true;
  peek.el.style.backgroundImage = '';
}

// 패널 오른쪽(보드 위), 누른 썸네일 높이에. 보드가 좁으면 패널 위에 겹쳐 띄운다
function placePeek() {
  if (!peek.card) return;
  const el = peek.el;
  const panel = $('#panel').getBoundingClientRect();
  const r = peek.card.getBoundingClientRect();
  const room = window.innerWidth - panel.right - 24;
  const w = Math.max(160, Math.min(420, room >= 200 ? room : window.innerWidth - 24));
  el.style.width = w + 'px';
  const x = room >= 200 ? panel.right + 12 : Math.max(12, (window.innerWidth - w) / 2);
  const hgt = el.offsetHeight || w * 0.6;
  const y = Math.min(Math.max(40, r.top + r.height / 2 - hgt / 2), window.innerHeight - hgt - 12);
  el.style.left = x + 'px';
  el.style.top = Math.max(8, y) + 'px';
}
