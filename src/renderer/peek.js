'use strict';
/* global rb, $, h, tr, mediaUrl, rangeThumb */
// 패널 썸네일 미리 보기 두 가지
//
// 1. 마우스를 올려 두면 예고편: 영상 전체에서 고르게 고른 몇 장면을 썸네일 자리에서 차례로 보여 준다
//  * 장면은 ffmpeg 썸네일(구간 썸네일과 같은 캐시)이라 한 번 만든 것은 NAS 를 다시 읽지 않는다
//  * 하나씩 차례로 만든다: 마우스가 금방 지나가면 더 만들지 않는다
//  * 마우스를 좌우로 움직이면 그 위치의 장면으로
//
// 2. 꾹 누르고 있는 동안만 크게 미리 보기 (떼면 닫힌다)
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
  initTrailer(grid);
}

/* ---------- 예고편 (마우스를 올려 두면) ---------- */

const TRAILER_SHOTS = 8;
const TRAILER_DELAY_MS = 350; // 지나가기만 하는 카드는 만들지 않게
const TRAILER_STEP_MS = 450;
const TRAILER_SCRUB_HOLD_MS = 1200; // 좌우로 움직여 고른 장면을 이만큼 보여 준 뒤 다시 차례로
const trailer = { card: null, timer: 0, tick: 0, seq: 0, el: null, shots: [], i: 0, holdUntil: 0 };
const trailerable = (card) => card?._entry && (card._entry.kind === 'video' || card._entry.kind === 'gif');

function initTrailer(grid) {
  grid.addEventListener('pointermove', (ev) => {
    const card = ev.target.closest('.card');
    if (card !== trailer.card) {
      stopTrailer();
      if (!trailerable(card) || ev.buttons || peek.card) return;
      trailer.card = card;
      trailer.timer = setTimeout(() => startTrailer(card), TRAILER_DELAY_MS);
    } else if (trailer.el) {
      const r = card.getBoundingClientRect();
      const i = Math.min(TRAILER_SHOTS - 1, Math.max(0, Math.floor(((ev.clientX - r.left) / r.width) * TRAILER_SHOTS)));
      if (trailer.shots[i]) {
        trailer.holdUntil = performance.now() + TRAILER_SCRUB_HOLD_MS;
        showShot(i);
      }
    }
  });
  grid.addEventListener('pointerleave', stopTrailer);
  grid.addEventListener('pointerdown', stopTrailer);
  grid.addEventListener('scroll', stopTrailer, { passive: true });
}

async function startTrailer(card) {
  const seq = trailer.seq;
  const e = card._entry;
  const ref = { sourceId: card._sourceId, path: e.path, size: e.size, mtime: e.mtime };
  const info = await rb.probe(ref).catch(() => null); // 길이 (캐시됨)
  const dur = info?.duration;
  if (seq !== trailer.seq || !dur) return;
  const th = card.querySelector('.th');
  const el = h('div', 'trailer');
  const img = h('img');
  const bar = h('div', 'tbar');
  for (let i = 0; i < TRAILER_SHOTS; i++) bar.append(h('i'));
  el.append(img, bar);
  th.append(el);
  Object.assign(trailer, { el, img, bar, shots: [], i: -1 });
  trailer.tick = setInterval(() => {
    if (!card.isConnected) return stopTrailer(); // 목록을 다시 그렸다: 다음 마우스 움직임에서 새 카드로
    if (performance.now() < trailer.holdUntil) return;
    const have = trailer.shots.map((u, i) => (u ? i : -1)).filter((i) => i >= 0);
    if (have.length < 2) return;
    showShot(have[(have.indexOf(trailer.i) + 1) % have.length]);
  }, TRAILER_STEP_MS);
  // 앞 장면부터 두 개씩: 마우스가 떠나면 거기서 멈춘다 (만드는 중인 것만 마저 만들어 캐시에 둔다)
  let next = 0;
  const worker = async () => {
    while (next < TRAILER_SHOTS && seq === trailer.seq) {
      const i = next++;
      const url = await rangeThumb(ref, e.kind, (dur * (i + 0.5)) / TRAILER_SHOTS).catch(() => null);
      if (seq !== trailer.seq) return;
      if (!url) continue;
      trailer.shots[i] = url;
      trailer.bar.children[i].classList.add('ok');
      if (trailer.i < 0) showShot(i);
    }
  };
  worker();
  worker();
}

function showShot(i) {
  trailer.i = i;
  trailer.img.src = trailer.shots[i];
  [...trailer.bar.children].forEach((b, k) => b.classList.toggle('on', k === i));
}

function stopTrailer() {
  trailer.seq++;
  clearTimeout(trailer.timer);
  clearInterval(trailer.tick);
  trailer.el?.remove();
  Object.assign(trailer, { card: null, el: null, shots: [], i: -1, holdUntil: 0 });
}

function cancelHold() {
  clearTimeout(peek.timer);
  peek.down = null;
}

async function showPeek(card) {
  if (peek.card === card) return;
  stopTrailer();
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
