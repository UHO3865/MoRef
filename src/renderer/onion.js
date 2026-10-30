'use strict';
/* global h, tr, toast, isTimed, fpsOf, currentFrame, totalFrames, markDirty */
// 어니언 스킨: 멈춰 있을 때 앞뒤 프레임을 색을 입혀 겹쳐 보여 준다 (Blender 의 어니언 스킨처럼)
//  * 지금 프레임과 달라진 곳만 칠한다: 움직인 부분이 어디서 와서 어디로 가는지 보이고, 가만히 있는 배경은 그대로
//  * 이전 프레임은 초록, 다음 프레임은 파랑. 지금 프레임에서 멀수록 옅게
//  * 재생 중에는 숨긴다 (멈추거나 한 프레임씩 넘길 때 보인다)
//  * 영상: 옆 프레임은 숨은 <video> 하나로 읽는다 (켤 때 만들고 끄면 닫는다). 읽은 프레임은 기억해 두어
//    한 프레임씩 넘길 때는 새로 생긴 끝 프레임 하나만 더 읽는다. GIF: 이미 읽어 둔 프레임을 쓴다
//  * 합치기는 GPU(WebGL 셰이더)로: 화면 스레드를 막지 않고 1280px 까지 그린다. WebGL 이 없으면 CPU 로 640px

const ONION_COUNTS = [1, 2, 3];
const ONION_MAX_W_GPU = 1280; // 이 너비로 줄여서 합친다
const ONION_MAX_W = 640; // CPU 로 합칠 때 (느리지 않게)
const ONION_BEFORE = [60, 220, 110];
const ONION_AFTER = [80, 150, 255];
const ONION_DIFF = 14; // 이보다 작은 차이는 같은 것으로 (압축 노이즈)
const ONION_CACHE = 12; // 영상마다 기억해 둘 프레임 수 (앞뒤 3 + 한 칸씩 넘길 때 다시 쓰는 것)

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
  clearFrames(it);
  it.onionFrames = null;
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
  const n = it.onion;
  // 먼 프레임부터 (가까운 프레임이 위에 오게). 하나 읽을 때마다 다시 합쳐 보여 준다
  const ghosts = [];
  const out = gpu ? null : ctx.createImageData(W, H);
  for (let d = n; d >= 1; d--) {
    for (const dir of [-1, 1]) {
      const i = f + dir * d;
      if (i < 0 || i >= total) continue;
      const bmp = await onionFrame(it, i, W, H);
      if (gen !== it.onionGen) return;
      if (!bmp) continue;
      const g = { bmp, tint: dir < 0 ? ONION_BEFORE : ONION_AFTER, alpha: 0.75 * (1 - (d - 1) / (n + 1)) };
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
}

/* ---------- GPU 로 합치기 (WebGL 하나를 모든 영상이 같이 쓴다) ---------- */

const ONION_VS = 'attribute vec2 p; varying vec2 uv; void main() { uv = (p + 1.0) * 0.5; gl_Position = vec4(p, 0.0, 1.0); }';
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
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
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
  if (!img) return null;
  if (!it.onionFrames) {
    img.close(); // 기다리는 사이에 꺼졌다
    return null;
  }
  it.onionFrames.set(i, img);
  while (it.onionFrames.size > ONION_CACHE) {
    const [k, old] = it.onionFrames.entries().next().value;
    it.onionFrames.delete(k);
    old.close();
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
