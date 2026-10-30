'use strict';
/* global h, tr, toast, isTimed, fpsOf, currentFrame, totalFrames, markDirty */
// 어니언 스킨: 멈춰 있을 때 앞뒤 프레임을 색을 입혀 겹쳐 보여 준다 (Blender 의 어니언 스킨처럼)
//  * 지금 프레임과 달라진 곳만 칠한다: 움직인 부분이 어디서 와서 어디로 가는지 보이고, 가만히 있는 배경은 그대로
//  * 이전 프레임은 초록, 다음 프레임은 파랑. 지금 프레임에서 멀수록 옅게
//  * 재생 중에는 숨긴다 (멈추거나 한 프레임씩 넘길 때 보인다)
//  * 영상: 옆 프레임은 숨은 <video> 하나로 읽는다 (켤 때 만들고 끄면 닫는다). 읽은 프레임은 기억해 두어
//    한 프레임씩 넘길 때는 새로 생긴 끝 프레임 하나만 더 읽는다. GIF: 이미 읽어 둔 프레임을 쓴다

const ONION_COUNTS = [1, 2, 3];
const ONION_MAX_W = 640; // 이 너비로 줄여서 계산한다 (큰 영상도 느리지 않게)
const ONION_BEFORE = [60, 220, 110];
const ONION_AFTER = [80, 150, 255];
const ONION_DIFF = 14; // 이보다 작은 차이는 같은 것으로 (압축 노이즈)
const ONION_CACHE = 24; // 영상마다 기억해 둘 프레임 수

function toggleOnion(it) {
  if (!isTimed(it)) return;
  setOnion(it, it.onion ? 0 : 2);
  toast(it.onion ? tr('어니언 스킨: 앞뒤 {0}프레임 (멈췄을 때 보입니다)', it.onion) : tr('어니언 스킨 끔'));
}

function setOnion(it, n) {
  if (!isTimed(it)) return;
  it.onion = n || 0;
  it.ctl?.onion?.classList.toggle('on', !!it.onion);
  markDirty();
  if (!it.onion) return closeOnion(it);
  if (!it.onionCv) {
    it.onionCv = h('canvas', 'onion');
    it.onionCv.hidden = true;
    it.vis.append(it.onionCv);
    syncOnionBox(it);
  }
  it.onionKey = null; // 다시 그린다
}

function closeOnion(it) {
  it.onionGen = (it.onionGen || 0) + 1;
  it.onionCv?.remove();
  it.onionCv = null;
  it.onionKey = null;
  it.onionFrames?.clear();
  if (it.onionVid) {
    it.onionVid.removeAttribute('src');
    it.onionVid.load(); // NAS 스트림을 닫는다
    it.onionVid = null;
  }
}

// 자르기 / 반전: 영상과 같은 자리에 (transform.js 의 applyVisual 에서 불린다)
function syncOnionBox(it) {
  const cv = it.onionCv;
  if (!cv) return;
  const m = it.media.canvas || it.media;
  for (const k of ['width', 'height', 'left', 'top']) cv.style[k] = m.style[k];
}

// tick() 에서 매 화면마다: 멈춘 프레임이 바뀌었으면 다시 그린다
function onionTick(it) {
  const cv = it.onionCv;
  if (!cv) return;
  const v = it.media;
  const ready = it.kind === 'gif' ? v.frameCount > 0 && !v.grid : v.readyState >= 2 && !it.unloaded;
  const show = ready && v.paused && !v.seeking && it.pendingSeek == null && !it.cropEdit;
  if (cv.hidden === show) cv.hidden = !show;
  if (!show) return;
  const f = currentFrame(it);
  const key = `${f}|${it.onion}`;
  if (key === it.onionKey) return;
  it.onionKey = key;
  renderOnion(it, f, (it.onionGen = (it.onionGen || 0) + 1));
}

async function renderOnion(it, f, gen) {
  const cv = it.onionCv;
  const src = it.kind === 'gif' ? it.media.canvas : it.media;
  const W0 = it.kind === 'gif' ? it.media.videoWidth : src.videoWidth;
  const H0 = it.kind === 'gif' ? it.media.videoHeight : src.videoHeight;
  if (!W0 || !H0) return;
  const s = Math.min(1, ONION_MAX_W / W0);
  const W = Math.max(1, Math.round(W0 * s));
  const H = Math.max(1, Math.round(H0 * s));
  if (it.onionSize !== `${W}x${H}`) {
    it.onionSize = `${W}x${H}`;
    it.onionFrames?.clear();
  }
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  const cur = grab(src, W, H);
  if (!cur) return;
  const total = it.kind === 'gif' ? it.media.frameCount : totalFrames(it);
  const n = it.onion;
  const out = ctx.createImageData(W, H);
  // 먼 프레임부터 그려서 가까운 프레임이 위에 오게
  for (let d = n; d >= 1; d--) {
    for (const dir of [-1, 1]) {
      const i = f + dir * d;
      if (i < 0 || i >= total) continue;
      const g = await onionFrame(it, i, W, H);
      if (gen !== it.onionGen) return;
      if (!g) continue;
      blendGhost(out.data, cur.data, g.data, dir < 0 ? ONION_BEFORE : ONION_AFTER, 0.75 * (1 - (d - 1) / (n + 1)));
      ctx.putImageData(out, 0, 0); // 하나 읽을 때마다 보여 준다
    }
  }
}

let grabCv = null;
function grab(src, W, H) {
  grabCv ??= document.createElement('canvas');
  grabCv.width = W;
  grabCv.height = H;
  const g = grabCv.getContext('2d', { willReadFrequently: true });
  try {
    g.drawImage(src, 0, 0, W, H);
    return g.getImageData(0, 0, W, H);
  } catch {
    return null;
  }
}

async function onionFrame(it, i, W, H) {
  it.onionFrames ??= new Map();
  const hit = it.onionFrames.get(i);
  if (hit) {
    it.onionFrames.delete(i); // 최근에 쓴 것으로
    it.onionFrames.set(i, hit);
    return hit;
  }
  const img = it.kind === 'gif' ? await gifFrame(it, i, W, H) : await videoFrame(it, i, W, H);
  if (!img) return null;
  it.onionFrames.set(i, img);
  while (it.onionFrames.size > ONION_CACHE) it.onionFrames.delete(it.onionFrames.keys().next().value);
  return img;
}

async function gifFrame(it, i, W, H) {
  const g = it.media;
  const bmp = await g._bitmap(i).catch(() => null);
  if (!bmp) return null;
  const img = grab(bmp, W, H);
  if (!g.bitmaps.has(i)) bmp.close();
  return img;
}

// 숨은 <video> 로 그 프레임까지 이동해서 읽는다. 한 번에 하나씩 (이동이 겹치면 다른 프레임을 읽는다)
function videoFrame(it, i, W, H) {
  const run = async () => {
    if (!it.onionCv || !it.srcUrl) return null;
    let v = it.onionVid;
    if (!v) {
      v = it.onionVid = h('video');
      v.muted = true;
      v.preload = 'auto';
      v.crossOrigin = 'anonymous'; // 프레임을 읽으려면
      v.src = it.srcUrl;
    }
    if (v.readyState < 1 && !(await once(v, 'loadedmetadata'))) return null;
    v.currentTime = (i + 0.5) / fpsOf(it); // 프레임 가운데 (seekFrame 과 같게)
    if (!(await once(v, 'seeked'))) return null;
    return grab(v, W, H);
  };
  it.onionQ = (it.onionQ || Promise.resolve()).then(run, run);
  return it.onionQ;
}

function once(el, ev, ms = 8000) {
  return new Promise((resolve) => {
    const done = (ok) => {
      clearTimeout(timer);
      el.removeEventListener(ev, yes);
      el.removeEventListener('error', no);
      resolve(ok);
    };
    const yes = () => done(true);
    const no = () => done(false);
    const timer = setTimeout(no, ms);
    el.addEventListener(ev, yes);
    el.addEventListener('error', no);
  });
}

// 지금 프레임과 다른 곳만: 그 프레임의 색에 이전(초록) / 다음(파랑) 색을 섞어 겹친다
function blendGhost(out, cur, gh, tint, alpha) {
  const [tr0, tg0, tb0] = tint;
  for (let p = 0; p < out.length; p += 4) {
    const d = (Math.abs(gh[p] - cur[p]) + Math.abs(gh[p + 1] - cur[p + 1]) + Math.abs(gh[p + 2] - cur[p + 2])) / 3;
    if (d < ONION_DIFF) continue;
    const a = Math.min(1, (d - ONION_DIFF) / 40) * alpha;
    const oa = out[p + 3] / 255;
    const na = a + oa * (1 - a);
    const k = oa * (1 - a);
    out[p] = (((gh[p] * 0.2 + tr0 * 0.8) * a) + out[p] * k) / na;
    out[p + 1] = (((gh[p + 1] * 0.2 + tg0 * 0.8) * a) + out[p + 1] * k) / na;
    out[p + 2] = (((gh[p + 2] * 0.2 + tb0 * 0.8) * a) + out[p + 2] * k) / na;
    out[p + 3] = na * 255;
  }
}
