'use strict';
/* global app, rb, h, tr, toast, isTimed, fpsOf, currentFrame, totalFrames, markDirty, renderShapes, ensureLoaded, closeMenus, refreshCtl */
// 어니언 스킨: 멈춰 있을 때 앞뒤 프레임을 색을 입혀 겹쳐 보여 준다 (Blender 의 어니언 스킨처럼)
//  * 지금 프레임과 달라진 곳만 칠한다: 움직인 부분이 어디서 와서 어디로 가는지 보이고, 가만히 있는 배경은 그대로
//  * 이전 프레임은 초록, 다음 프레임은 파랑. 지금 프레임에서 멀수록 옅게
//  * 재생 중에는 숨긴다 (멈추거나 한 프레임씩 넘길 때 보인다)
//  * 영상: 옆 프레임은 숨은 <video> 하나로 읽는다 (켤 때 만들고 끄면 닫는다). 읽은 프레임은 기억해 두어
//    한 프레임씩 넘길 때는 새로 생긴 끝 프레임 하나만 더 읽는다. GIF: 이미 읽어 둔 프레임을 쓴다
//  * 합치기는 GPU(WebGL 셰이더)로: 화면 스레드를 막지 않고 1280px 까지 그린다. WebGL 이 없으면 CPU 로 640px

const ONION_MAX = 10; // 이전 / 다음 각각 최대 프레임 수
const ONION_MAX_W_GPU = 1280; // 이 너비로 줄여서 합친다
const ONION_MAX_W = 640; // CPU 로 합칠 때 (느리지 않게)
const ONION_BEFORE = [60, 220, 110];
const ONION_AFTER = [80, 150, 255];
const ONION_DIFF = 14; // 이보다 작은 차이는 같은 것으로 (압축 노이즈)

// it.onion = { b: 이전 프레임 수, a: 다음 프레임 수 } | 0 (꺼짐). 예전 보드의 숫자 n 은 { b: n, a: n }
function onionCounts(v) {
  if (!v) return null;
  const c = typeof v === 'number' ? { b: v, a: v } : v;
  const clamp = (x) => Math.max(0, Math.min(ONION_MAX, Math.round(Number(x) || 0)));
  const r = { b: clamp(c.b), a: clamp(c.a) };
  return r.b || r.a ? r : null;
}
// 앞뒤 프레임마다 색 (설정 onionColors = { b: ['#rrggbb', …], a: […] }, 거리 1 이 0번). 비어 있으면 기본색
const ONION_BASE = { b: ONION_BEFORE, a: ONION_AFTER };
const hexRgb = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const rgbHex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
function onionColor(side, d) {
  const s = app.settings.onionColors?.[side]?.[d - 1];
  return /^#[0-9a-f]{6}$/i.test(s || '') ? hexRgb(s) : ONION_BASE[side];
}
let onionColorSave = 0;
function setOnionColor(side, d, hex) {
  const c = { b: [...(app.settings.onionColors?.b || [])], a: [...(app.settings.onionColors?.a || [])] };
  if (hex) c[side][d - 1] = hex;
  else c[side] = []; // 기본색으로
  app.settings.onionColors = c;
  clearTimeout(onionColorSave);
  onionColorSave = setTimeout(() => rb.setSetting('onionColors', app.settings.onionColors), 300); // 고르는 동안 계속 바뀐다
  // 켜져 있는 모든 영상에 바로
  for (const it of app.items.values()) {
    if (!it.onion) continue;
    it.onionKey = null;
    renderShapes(it);
    updateOnionMenu(it);
  }
}

// 새로 켤 때는 마지막으로 쓴 값 (설정에 기억)
const onionDefault = () => onionCounts(app.settings.onionDefault) || { b: 2, a: 2 };
// 영상마다 기억해 둘 프레임: 보이는 것 + 한 칸씩 넘길 때 다시 쓰는 것
const onionCacheSize = (it) => Math.max(12, (it.onion?.b || 0) + (it.onion?.a || 0) + 6);

function toggleOnion(it) {
  if (!isTimed(it)) return;
  setOnion(it, it.onion ? 0 : onionDefault());
  toast(it.onion ? tr('어니언 스킨: 이전 {0} · 다음 {1}프레임 (멈췄을 때 보입니다)', it.onion.b, it.onion.a) : tr('어니언 스킨 끔'));
}

// remember: 다음에 켤 때의 기본값으로 기억 (보드를 불러올 때는 아님)
function setOnion(it, v, { remember = true } = {}) {
  if (!isTimed(it)) return;
  it.onion = onionCounts(v) || 0;
  it.ctl?.onion?.classList.toggle('on', !!it.onion);
  updateOnionMenu(it);
  markDirty();
  renderShapes(it); // 프레임별 그림의 앞뒤도 같은 수만큼 (framedraw.js)
  if (!it.onion) return closeOnion(it);
  if (remember) {
    app.settings.onionDefault = it.onion;
    rb.setSetting('onionDefault', it.onion);
  }
  if (!it.onionCv) {
    it.onionCv = h('canvas', 'onion');
    it.onionCv.hidden = true;
    it.vis.append(it.onionCv);
    syncOnionBox(it);
  }
  // 멈춘 채 올려 둔 영상은 아직 받지 않았다 (preload none): 지금 프레임을 받아야 겹쳐 볼 수 있다
  // (보드를 불러오는 중이면 아직 주소가 없다: 보이게 되면 onionTick 이 받는다)
  if (it.kind === 'video' && it.srcUrl && it.onScreen !== false) ensureLoaded(it);
  it.onionKey = null; // 다시 그린다
}

/* ---------- 이전 / 다음 프레임 수 고르기 (컨트롤 바의 어니언 버튼) ---------- */

function buildOnionMenu(it, bar) {
  const m = h('div', 'menu onion-menu');
  m.append(h('div', 'om-title', tr('어니언 스킨')));
  const row = (label, key, cls) => {
    const r = h('div', 'om-row ' + cls);
    const minus = h('button', 'om-step', '−');
    const val = h('b', 'om-val');
    const plus = h('button', 'om-step', '+');
    const change = (d) => {
      const c = it.onion || onionDefault();
      setOnion(it, { ...c, [key]: c[key] + d });
      if (!it.onion) closeMenus();
    };
    minus.onclick = (e) => (e.stopPropagation(), change(-1));
    plus.onclick = (e) => (e.stopPropagation(), change(1));
    r.onwheel = (e) => (e.preventDefault(), e.stopPropagation(), change(e.deltaY < 0 ? 1 : -1));
    const dot = h('span', 'om-dot');
    r.append(dot, h('span', 'om-label', label), minus, val, plus);
    // 그 아래: 프레임마다 색 (누르면 색 고르기)
    const strip = h('div', 'om-colors ' + cls);
    m.append(r, strip);
    return { val, dot, strip };
  };
  it.ctl.onionRows = { b: row(tr('이전'), 'b', 'before'), a: row(tr('다음'), 'a', 'after') };
  const foot = h('div', 'om-foot');
  const reset = h('button', 'om-reset', tr('기본 색으로'));
  reset.onclick = (e) => {
    e.stopPropagation();
    setOnionColor('b', 0, null);
    setOnionColor('a', 0, null);
  };
  const off = h('button', 'om-off', tr('끄기'));
  off.onclick = (e) => {
    e.stopPropagation();
    setOnion(it, 0);
    closeMenus();
  };
  foot.append(reset, off);
  m.append(foot);
  it.ctl.onionMenu = m;
  bar.append(m);
  updateOnionMenu(it);
}

function updateOnionMenu(it) {
  const rows = it.ctl?.onionRows;
  if (!rows) return;
  const c = it.onion || onionDefault();
  for (const side of ['b', 'a']) {
    const { val, dot, strip } = rows[side];
    val.textContent = c[side];
    dot.style.background = rgbHex(onionColor(side, 1));
    // 거리마다 색 칸: 이전은 먼 것(-n)부터 왼쪽에, 다음은 가까운 것(+1)부터
    const ds = Array.from({ length: c[side] }, (_, i) => i + 1);
    if (side === 'b') ds.reverse();
    const want = ds.map((d) => `${d}:${rgbHex(onionColor(side, d))}`).join(' ');
    if (strip.dataset.v === want) continue; // 고르는 중인 색 입력칸을 다시 만들지 않게
    strip.dataset.v = want;
    strip.replaceChildren(
      ...ds.map((d) => {
        const sw = h('label', 'om-sw');
        sw.title = tr('{0} 프레임 색', (side === 'b' ? '-' : '+') + d);
        const input = h('input');
        input.type = 'color';
        input.value = rgbHex(onionColor(side, d));
        input.oninput = () => setOnionColor(side, d, input.value);
        input.onclick = (e) => e.stopPropagation();
        sw.append(input, h('span', '', (side === 'b' ? '-' : '+') + d));
        return sw;
      }),
    );
  }
}

// 어니언 버튼: 꺼져 있으면 켜고, 켜져 있으면 프레임 수 고르기를 열고 닫는다
function onionButton(it) {
  if (!it.onion) {
    toggleOnion(it);
    return;
  }
  openOnionMenu(it, !it.ctl.onionMenu.classList.contains('open'));
}

function openOnionMenu(it, open = true) {
  closeMenus();
  if (!open) return;
  if (!it.onion) setOnion(it, onionDefault());
  it.ctl.onionMenu.classList.add('open');
  it.ctlEl.classList.add('menu-open');
  refreshCtl(it);
}

function closeOnion(it) {
  it.onionGen = (it.onionGen || 0) + 1;
  it.onionCv?.remove();
  it.onionCv = null;
  it.onionKey = null;
  clearFrames(it);
  it.onionFrames = null;
  if (it.onionVid) {
    it.onionVid.pause();
    it.onionVid.removeAttribute('src');
    it.onionVid.load(); // NAS 스트림을 닫는다
    it.onionVid.remove();
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
  // 화면 밖에 나갔다 돌아와 내려 둔 영상(unloaded)이면 다시 받는다 (보일 때만)
  if (!ready && it.kind === 'video' && it.onScreen !== false && v.paused) ensureLoaded(it);
  if (!show) return;
  const f = currentFrame(it);
  const key = `${f}|${it.onion.b}|${it.onion.a}`;
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
  const gpu = onionGl();
  const s = Math.min(1, (gpu ? ONION_MAX_W_GPU : ONION_MAX_W) / W0);
  const W = Math.max(1, Math.round(W0 * s));
  const H = Math.max(1, Math.round(H0 * s));
  if (it.onionSize !== `${W}x${H}`) {
    it.onionSize = `${W}x${H}`;
    clearFrames(it);
  }
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  // 지금 프레임: GPU 는 영상 / GIF 캔버스를 그대로 올리고, CPU 는 픽셀을 읽는다
  const cur = gpu ? src : grab(src, W, H);
  if (!cur) return;
  const total = it.kind === 'gif' ? it.media.frameCount : totalFrames(it);
  const { b, a } = it.onion;
  // 먼 프레임부터 (가까운 프레임이 위에 오게)
  const want = [];
  for (let d = Math.max(b, a); d >= 1; d--) {
    for (const dir of [-1, 1]) {
      const n = dir < 0 ? b : a;
      const i = f + dir * d;
      if (d <= n && i >= 0 && i < total) want.push({ i, d, dir, n });
    }
  }
  // 영상: 없는 프레임을 한 번에 읽는다 (한 번 이동 + 천천히 재생하며 잡기 - readVideoFrames)
  if (it.kind === 'video') {
    const missing = want.map((w) => w.i).filter((i) => !it.onionFrames?.has(i));
    if (missing.length) await readVideoFrames(it, Math.min(...missing), Math.max(...missing), W, H);
    if (gen !== it.onionGen) return;
  }
  // 하나 읽을 때마다 다시 합쳐 보여 준다 (GIF · 영상에서 놓친 프레임은 하나씩 읽는다)
  const ghosts = [];
  const out = gpu ? null : ctx.createImageData(W, H);
  for (const { i, d, dir, n } of want) {
    const bmp = await onionFrame(it, i, W, H);
    if (gen !== it.onionGen) return;
    if (!bmp) continue;
    const g = { bmp, tint: onionColor(dir < 0 ? 'b' : 'a', d), alpha: 0.75 * (1 - (d - 1) / (n + 1)) };
    if (gpu) {
      ghosts.push(g);
      if (!blendGpu(gpu, cur, ghosts, W, H)) return; // 영상 프레임을 올리지 못함 (아주 드묾): 다음에
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(gpu.canvas, 0, 0);
    } else {
      const gd = grab(bmp, W, H);
      if (gd) blendGhost(out.data, cur.data, gd.data, g.tint, g.alpha);
      ctx.putImageData(out, 0, 0);
    }
  }
}

/* ---------- GPU 로 합치기 (WebGL 하나를 모든 영상이 같이 쓴다) ---------- */

// 위아래는 셰이더에서 뒤집는다: UNPACK_FLIP_Y 는 <video> 에는 듣지만 ImageBitmap(앞뒤 프레임)에는 듣지 않아서
// 그것을 쓰면 앞뒤 프레임만 상하가 뒤집혀 겹쳤다 (같은 프레임끼리도 전부 "다르다"로 칠해짐)
const ONION_VS = 'attribute vec2 p; varying vec2 uv; void main() { uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); gl_Position = vec4(p, 0.0, 1.0); }';
// blendGhost 와 같은 계산: 지금 프레임과 다른 곳만 그 프레임 색 20% + 이전(초록) / 다음(파랑) 색 80%
const ONION_FS = `precision mediump float;
uniform sampler2D cur; uniform sampler2D gh; uniform vec3 tint; uniform float alpha; uniform float diff;
varying vec2 uv;
void main() {
  vec3 c = texture2D(cur, uv).rgb;
  vec3 g = texture2D(gh, uv).rgb;
  float d = (abs(g.r - c.r) + abs(g.g - c.g) + abs(g.b - c.b)) / 3.0 * 255.0;
  if (d < diff) discard;
  float a = min(1.0, (d - diff) / 40.0) * alpha;
  gl_FragColor = vec4((g * 0.2 + tint / 255.0 * 0.8) * a, a);
}`;

let onionGlState; // undefined: 아직 / null: 쓸 수 없음 (CPU 로)
function onionGl() {
  if (onionGlState !== undefined) return onionGlState;
  onionGlState = null;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl) return null;
    const sh = (type, code) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, code);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, ONION_VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, ONION_FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const p = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(p);
    gl.vertexAttribPointer(p, 2, gl.FLOAT, false, 0, 0);
    const tex = () => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
      for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.LINEAR);
      return t;
    };
    const texCur = tex();
    const texGh = tex();
    gl.uniform1i(gl.getUniformLocation(prog, 'cur'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'gh'), 1);
    gl.uniform1f(gl.getUniformLocation(prog, 'diff'), ONION_DIFF);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // 미리 곱한 알파로 겹치기
    onionGlState = { gl, canvas, texCur, texGh, uTint: gl.getUniformLocation(prog, 'tint'), uAlpha: gl.getUniformLocation(prog, 'alpha') };
  } catch (e) {
    console.warn('어니언 스킨: WebGL 을 쓸 수 없어 CPU 로 합칩니다', e.message);
  }
  return onionGlState;
}

function blendGpu(st, cur, ghosts, W, H) {
  const { gl, canvas } = st;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  try {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, st.texCur);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cur);
  } catch {
    return false;
  }
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, st.texGh);
  for (const g of ghosts) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, g.bmp);
    gl.uniform3f(st.uTint, ...g.tint);
    gl.uniform1f(st.uAlpha, g.alpha);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  return true;
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
  return img && storeFrame(it, i, img);
}

function storeFrame(it, i, img) {
  if (!it.onionFrames) {
    img.close(); // 기다리는 사이에 꺼졌다
    return null;
  }
  const old = it.onionFrames.get(i);
  if (old && old !== img) old.close();
  it.onionFrames.delete(i);
  it.onionFrames.set(i, img);
  while (it.onionFrames.size > onionCacheSize(it)) {
    const [k, first] = it.onionFrames.entries().next().value;
    it.onionFrames.delete(k);
    first.close();
  }
  return img;
}

function clearFrames(it) {
  for (const b of it.onionFrames?.values() || []) b.close();
  it.onionFrames?.clear();
}

// 프레임은 계산할 크기로 줄인 ImageBitmap 으로 둔다 (GPU 에 바로 올라간다)
const shrink = (src, W, H) => createImageBitmap(src, { resizeWidth: W, resizeHeight: H, resizeQuality: 'medium' });

async function gifFrame(it, i, W, H) {
  const g = it.media;
  const bmp = await g._bitmap(i).catch(() => null);
  if (!bmp) return null;
  const img = await shrink(bmp, W, H).catch(() => null);
  if (!g.bitmaps.has(i)) bmp.close();
  return img;
}

// 옆 프레임을 읽는 숨은 <video>. 프레임마다 그리는 시점을 받으려면(requestVideoFrameCallback) 문서 안에 있어야 해서
// 보이지 않게 붙여 둔다. 받는 요청은 보드 재생보다 뒤로 (주소의 bg=1 - proxy.js)
function onionHelper(it) {
  if (it.onionVid) return it.onionVid;
  if (!it.onionCv || !it.srcUrl) return null;
  const v = (it.onionVid = h('video', 'onion-helper'));
  v.muted = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous'; // 프레임을 읽으려면
  v.src = it.srcUrl + (it.srcUrl.includes('?') ? '&' : '?') + 'bg=1';
  document.body.append(v);
  return v;
}

// 이동할 때마다 Chromium 은 앞 키프레임부터 다시 풀고, 큰 영상은 그만큼을 NAS 에서 다시 받는다
// (4K 40Mbps, 앞뒤 2장: 프레임마다 이동하면 2.9초 · 133MB, 이 방식은 1.1초 · 48MB).
// 그래서 lo 로 한 번만 이동하고, 천천히 재생하며 lo~hi 의 프레임을 모두 잡는다.
// 숨은 영상이 이미 바로 앞(ONION_AHEAD 안)에 있으면 이동하지 않고 이어서 재생한다 (→ 로 한 칸씩 넘길 때)
const ONION_RATE = 0.5;
const ONION_AHEAD = 30;
function readVideoFrames(it, lo, hi, W, H) {
  const run = async () => {
    const v = onionHelper(it);
    if (!v) return;
    it.onionFrames ??= new Map(); // 잡은 프레임을 둘 곳 (onionFrame 보다 먼저 불린다)
    if (v.readyState < 1 && !(await once(v, 'loadedmetadata'))) return;
    const fps = fpsOf(it);
    const frameOf = (t) => Math.floor(t * fps + 0.01);
    const keep = (i) => {
      if (i < lo || i > hi || !it.onionFrames) return;
      shrink(v, W, H).then((img) => storeFrame(it, i, img), () => {});
    };
    const pos = frameOf(v.currentTime);
    if (!(v.readyState >= 2 && lo > pos && lo - pos <= ONION_AHEAD)) {
      v.currentTime = (lo + 0.5) / fps; // 프레임 가운데 (seekFrame 과 같게)
      if (!(await once(v, 'seeked'))) return;
      keep(lo);
      if (hi === lo) return;
    }
    const start = frameOf(v.currentTime);
    await new Promise((resolve) => {
      let timer = 0;
      const done = () => {
        clearTimeout(timer);
        v.onended = null;
        v.pause();
        resolve();
      };
      timer = setTimeout(done, ((hi - start + 2) / fps / ONION_RATE) * 1000 + 4000);
      const onFrame = (_now, meta) => {
        const i = frameOf(meta.mediaTime);
        if (i >= hi || !it.onionCv) {
          keep(i);
          return done();
        }
        v.requestVideoFrameCallback(onFrame); // 먼저 다음 것을 걸어 둔다 (잡는 동안 지나가지 않게)
        keep(i);
      };
      v.requestVideoFrameCallback(onFrame);
      v.onended = done;
      v.playbackRate = ONION_RATE;
      v.play().catch(done);
    });
    await new Promise((r) => setTimeout(r, 0)); // 마지막으로 잡은 것이 저장되게
  };
  it.onionQ = (it.onionQ || Promise.resolve()).then(run, run);
  return it.onionQ;
}

// 하나만 읽기 (재생하며 잡다가 놓친 프레임): 그 프레임으로 이동해서
function videoFrame(it, i, W, H) {
  const run = async () => {
    const v = onionHelper(it);
    if (!v) return null;
    if (v.readyState < 1 && !(await once(v, 'loadedmetadata'))) return null;
    v.currentTime = (i + 0.5) / fpsOf(it);
    if (!(await once(v, 'seeked'))) return null;
    return shrink(v, W, H).catch(() => null);
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
