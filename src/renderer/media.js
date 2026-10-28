'use strict';
/* global app, board, isTimed, applySync */
// 영상 네트워크 / 메모리 아끼기
//
// 측정 (1080p 8Mbps): Chromium 은 멈춘 영상도 preload="auto"/"metadata" 둘 다 약 30~40초(≈39MB)를 미리 받고,
// 화면 밖으로 나간 영상도 계속 재생·다운로드하며, 영상 하나가 메모리를 약 70MB 쓴다.
//  1. 멈춘 영상은 preload="none" - 아무것도 받지 않는다. 대신 그 시각의 썸네일을 포스터로 보여 주고,
//     크기/길이는 ffprobe(헤더만 읽음) 값으로 쓴다. 재생 / 프레임 이동 / 진행 바 / 구간 이동 때 비로소 받는다.
//  2. 화면 밖으로 나가면 자동 일시정지 → 돌아오면 다시 재생 (사용자가 멈춘 것과 구분해 기억)
//  3. 화면 밖에 일정 시간 이상 있으면 지금 프레임을 정지 화면으로 남기고 영상을 내려 디코더·버퍼 메모리를 돌려준다.
//     돌아오면 그 시각으로 다시 붙인다 (멈춰 있던 영상은 여전히 받지 않음).

const UNLOAD_AFTER_MS = 8000;
let reloadSeq = 0;
let shardSeq = 0;

// Chromium 은 한 호스트에 연결을 6개까지만 연다. 받는 중인 영상이 그 6개를 붙잡으면 7번째 영상(또는 이동 요청)이
// 줄을 서서 멈춘다. 영상마다 다른 이름(v3.localhost 등, 모두 127.0.0.1)으로 받아 연결 묶음을 나눈다.
function shardUrl(url) {
  return url.replace('//127.0.0.1:', `//v${shardSeq++ % 32}.localhost:`);
}
const VIS_MARGIN = 200; // 화면 가장자리에서 이만큼 밖까지는 "보이는 것"으로 (스크롤할 때 바로 보이게)

function isOnScreen(it) {
  if (document.hidden) return false;
  const { x, y, s } = app.view;
  const l = it.x * s + x;
  const t = it.y * s + y;
  return l + it.w * s > -VIS_MARGIN && t + it.h * s > -VIS_MARGIN && l < board.clientWidth + VIS_MARGIN && t < board.clientHeight + VIS_MARGIN;
}

// layoutAll / 창 크기 / 창 숨김에서 불린다
function updateVisibility() {
  for (const it of app.items.values()) {
    if (!isTimed(it)) continue;
    const vis = isOnScreen(it);
    if (vis === it.onScreen) continue;
    it.onScreen = vis;
    if (vis) enterScreen(it);
    else leaveScreen(it);
  }
}

function leaveScreen(it) {
  const m = it.media;
  if (!m.paused) {
    it.autoPaused = true; // 사용자가 멈춘 게 아니라 자동으로 멈춤 → 돌아오면 다시 재생
    m.pause();
  }
  if (it.kind === 'video') {
    clearTimeout(it.unloadTimer);
    it.unloadTimer = setTimeout(() => !it.onScreen && unloadVideo(it), UNLOAD_AFTER_MS);
  }
}

function enterScreen(it) {
  clearTimeout(it.unloadTimer);
  const resume = it.autoPaused;
  it.autoPaused = false;
  if (it.unloaded) reloadVideo(it, { play: resume });
  else if (resume) it.media.play().catch(() => {});
  if (it.sync && app.blender) applySync(it, app.blender);
}

// 프레임 이동 · 진행 바 · 구간 이동처럼 실제 영상이 필요할 때
function ensureLoaded(it) {
  if (it.kind !== 'video') return;
  if (it.unloaded) reloadVideo(it, { load: true });
  else if (it.media.preload !== 'auto') it.media.preload = 'auto'; // none → auto: Chromium 이 이어서 받기 시작
}

// 지금 프레임을 정지 화면(포스터)으로 남기고 영상을 내린다
async function unloadVideo(it) {
  const v = it.media;
  if (it.kind !== 'video' || it.unloaded || !it.srcUrl || !v.getAttribute('src')) return;
  if (v.readyState >= 2 && v.videoWidth) {
    try {
      const c = document.createElement('canvas');
      const scale = Math.min(1, 960 / v.videoWidth); // 정지 화면은 적당한 크기로
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * scale);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
      if (it.onScreen || !app.items.has(it.id)) return; // 그 사이에 돌아왔다
      if (blob) setPoster(it, URL.createObjectURL(blob), true);
    } catch {
      // 정지 화면을 못 만들면 원래 포스터 그대로
    }
  }
  if (it.onScreen || !app.items.has(it.id)) return;
  it.savedT = v.currentTime;
  it.unloaded = true;
  v.removeAttribute('src');
  v.load(); // 디코더와 버퍼를 돌려준다
}

function reloadVideo(it, { play = false, load = false } = {}) {
  const v = it.media;
  const t = it.savedT || 0;
  it.unloaded = false;
  v.preload = play || load ? 'auto' : 'none';
  // 같은 주소를 다시 붙이면 Chromium 이 (같은 주소끼리 공유하는) 이전 미디어 버퍼를 다시 쓰려다 멈춘다.
  // 다시 붙일 때마다 주소 끝을 바꿔 새로 받게 한다 (중계 서버는 ? 뒤를 무시한다)
  v.src = `${it.srcUrl}${it.srcUrl.includes('?') ? '&' : '?'}r=${++reloadSeq}`;
  v.playbackRate = it.rate;
  if (!play && !load) {
    v.currentTime = t; // 받지 않는 동안에는 "시작 위치"로 기억되었다가, 받기 시작하면 그리로 간다
    return;
  }
  // 받으면서 바로 재생할 때: 시작 위치를 미리 정하고 play() 하면 Chromium 이 이동하다 멈춰 버린다.
  // 메타데이터를 받은 뒤 이동하고, 그다음 재생한다.
  it.reloadT = t;
  v.addEventListener(
    'loadedmetadata',
    () => {
      if (it.reloadT == null) return;
      v.currentTime = it.reloadT;
      it.reloadT = null;
      if (play) v.play().catch(() => {});
    },
    { once: true }
  );
}

function setPoster(it, url, isBlob = false) {
  if (it.posterBlob) URL.revokeObjectURL(it.posterBlob);
  it.posterBlob = isBlob ? url : null;
  it.media.poster = url;
}

function releaseMedia(it) {
  clearTimeout(it.unloadTimer);
  if (it.posterBlob) URL.revokeObjectURL(it.posterBlob);
}

function initMediaSaver() {
  document.addEventListener('visibilitychange', updateVisibility);
  // 패널을 열고 닫거나 창 크기가 바뀌어 보드 크기가 달라질 때
  new ResizeObserver(() => updateVisibility()).observe(board);
}
