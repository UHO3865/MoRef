'use strict';
// GIF 재생기: 프레임마다 실제 표시 시간을 읽어 캔버스에 그린다.
// <video> 와 같은 모양(currentTime, duration, paused, play(), pause(), playbackRate, onplay …)을 갖춰
// 보드의 재생 컨트롤(진행 바, A-B 반복, 속도, 우클릭 메뉴)을 그대로 쓴다.
// 추가 기능: 한 프레임씩 이동(stepFrame), 모든 프레임 보기(setGrid).

const GIF_MIN_DELAY = 0.02; // 브라우저처럼: 10ms 이하 지연은 100ms 로 본다
const GIF_CACHE_BUDGET = 192 * 1024 * 1024; // 이 GIF 의 프레임 비트맵을 메모리에 둘 최대 크기

class GifPlayer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gif';
    this.ctx = this.canvas.getContext('2d');
    this.delays = []; // 프레임별 표시 시간(초)
    this.starts = []; // 프레임 시작 시각
    this.bitmaps = new Map(); // 프레임 번호 → ImageBitmap
    this.cacheBytes = 0;
    this.frameCount = 0;
    this.frameIndex = 0;
    this.complete = false;
    this.duration = NaN;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.paused = true;
    this.playbackRate = 1;
    this.seeking = false;
    this.readyState = 0;
    this.error = null;
    this.muted = true;
    this.loop = true;
    this.grid = false;
    this._t = 0;
    this._raf = 0;
    this._decoding = new Set();
    const self = this;
    this.buffered = { get length() { return self.complete ? 1 : 0; }, start: () => 0, end: () => self.duration || 0 };
  }

  set src(url) {
    this._load(url);
  }

  async _load(url) {
    try {
      if (!('ImageDecoder' in window)) throw new Error('이 환경은 GIF 프레임 읽기를 지원하지 않습니다');
      const res = await fetch(url);
      if (!res.ok) throw new Error('GIF 를 불러오지 못했습니다 (' + res.status + ')');
      this.decoder = new ImageDecoder({ data: res.body, type: 'image/gif' });
      await this.decoder.tracks.ready;
      let i = 0;
      // 데이터가 다 올 때까지 프레임 수가 늘어날 수 있어, 디코딩하면서 따라간다
      for (;;) {
        const track = this.decoder.tracks.selectedTrack;
        if (i >= track.frameCount) {
          if (this.decoder.complete) break;
          await Promise.race([this.decoder.completed, new Promise((r) => setTimeout(r, 50))]);
          continue;
        }
        const { image } = await this.decoder.decode({ frameIndex: i });
        const delay = (image.duration ?? 0) / 1e6;
        this.delays.push(delay > GIF_MIN_DELAY ? delay : 0.1);
        if (i === 0) this._first(image);
        await this._keep(i, image);
        image.close();
        i++;
        this._timeline();
        if (i === 1) this.draw();
      }
      this.complete = true;
      this.readyState = 4;
      this._timeline();
      // 저장된 위치가 있으면 그 프레임으로
      this._t = Math.min(this._t, (this.duration || 0) - 1e-6);
      this._dirty = true;
      this._setFrame(this.frameAt(Math.max(0, this._t)));
      this.onready?.(); // 모든 프레임을 읽음 (길이 확정)
    } catch (e) {
      this.error = { code: 4, message: e.message };
      this.onerror?.();
    }
  }

  _first(image) {
    this.videoWidth = image.displayWidth;
    this.videoHeight = image.displayHeight;
    this.canvas.width = this.videoWidth;
    this.canvas.height = this.videoHeight;
    this.readyState = 1;
    this.onloadedmetadata?.();
  }

  async _keep(i, image) {
    const bytes = this.videoWidth * this.videoHeight * 4;
    if (this.cacheBytes + bytes > GIF_CACHE_BUDGET) return; // 너무 크면 그때그때 디코딩
    this.bitmaps.set(i, await createImageBitmap(image));
    this.cacheBytes += bytes;
  }

  _timeline() {
    this.frameCount = this.delays.length;
    this.starts = [];
    let t = 0;
    for (const d of this.delays) {
      this.starts.push(t);
      t += d;
    }
    this.duration = t || NaN;
  }

  frameAt(t) {
    // 이진 탐색: t 가 들어가는 프레임
    let lo = 0;
    let hi = this.frameCount - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  get currentTime() {
    return this._t;
  }

  set currentTime(t) {
    if (!this.frameCount) {
      this._t = Math.max(0, t); // 아직 불러오는 중: 첫 프레임이 오면 이 위치부터
      return;
    }
    const d = this.duration || 0;
    this._t = Math.max(0, Math.min(d ? d - 1e-6 : 0, t));
    this._setFrame(this.frameAt(this._t));
  }

  _setFrame(i) {
    if (i === this.frameIndex && !this._dirty) return;
    this.frameIndex = i;
    this._dirty = false;
    this.draw();
  }

  // 한 프레임 앞/뒤로 (재생 중이면 멈춤)
  stepFrame(dir) {
    if (!this.frameCount) return;
    this.pause();
    const i = (this.frameIndex + dir + this.frameCount) % this.frameCount;
    this._t = this.starts[i];
    this._dirty = true;
    this._setFrame(i);
  }

  play() {
    if (!this.paused) return Promise.resolve();
    this.paused = false;
    let last = performance.now();
    const loop = (now) => {
      if (this.paused) return;
      const d = this.duration;
      if (d && this.frameCount) {
        let t = this._t + ((now - last) / 1000) * this.playbackRate;
        if (t >= d) t = this.complete ? t % d : d - 1e-6;
        this._t = t;
        this._setFrame(this.frameAt(t));
      }
      last = now;
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
    this.onplay?.();
    return Promise.resolve();
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    cancelAnimationFrame(this._raf);
    this.onpause?.();
  }

  // ---- 그리기 ----

  async _bitmap(i) {
    const cached = this.bitmaps.get(i);
    if (cached) return cached;
    if (!this.decoder || this._decoding.has(i)) return null;
    this._decoding.add(i);
    try {
      const { image } = await this.decoder.decode({ frameIndex: i });
      const bmp = await createImageBitmap(image);
      image.close();
      return bmp; // 예산을 넘는 GIF: 쓰고 버린다
    } finally {
      this._decoding.delete(i);
    }
  }

  draw() {
    if (!this.frameCount) return;
    if (this.grid) return this._drawGrid();
    const i = this.frameIndex;
    const bmp = this.bitmaps.get(i);
    if (bmp) return this._paint(bmp);
    this._bitmap(i).then((b) => {
      if (b && this.frameIndex === i && !this.grid) this._paint(b);
      if (b && !this.bitmaps.has(i)) b.close();
    });
  }

  _paint(bmp) {
    if (this.canvas.width !== this.videoWidth) {
      this.canvas.width = this.videoWidth;
      this.canvas.height = this.videoHeight;
    }
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(bmp, 0, 0);
  }

  // 모든 프레임: 원래 비율을 유지한 칸에 순서대로 배치
  gridLayout() {
    const n = this.frameCount;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const scale = Math.min(1 / cols, 1 / rows);
    const W = this.canvas.width;
    const H = this.canvas.height;
    const cw = W * scale;
    const ch = H * scale;
    const ox = (W - cw * cols) / 2;
    const oy = (H - ch * rows) / 2;
    return { cols, rows, cw, ch, ox, oy };
  }

  async _drawGrid() {
    // 칸이 작아지므로 해상도를 올려 그린다
    const up = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(this.frameCount) / 2)));
    if (this.canvas.width !== this.videoWidth * up) {
      this.canvas.width = this.videoWidth * up;
      this.canvas.height = this.videoHeight * up;
    }
    const g = this.ctx;
    const { cols, cw, ch, ox, oy } = this.gridLayout();
    g.fillStyle = '#111';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const token = (this._gridToken = {});
    const gap = Math.max(1, cw * 0.02);
    for (let i = 0; i < this.frameCount; i++) {
      const x = ox + (i % cols) * cw;
      const y = oy + Math.floor(i / cols) * ch;
      const bmp = await this._bitmap(i);
      if (this._gridToken !== token || !this.grid) {
        if (bmp && !this.bitmaps.has(i)) bmp.close();
        return;
      }
      if (bmp) {
        g.drawImage(bmp, x + gap, y + gap, cw - gap * 2, ch - gap * 2);
        if (!this.bitmaps.has(i)) bmp.close();
      }
      // 프레임 번호
      const fs = Math.max(10, ch * 0.13);
      g.font = `600 ${fs}px "Segoe UI", sans-serif`;
      const label = String(i + 1);
      const tw = g.measureText(label).width;
      g.fillStyle = 'rgba(0,0,0,.65)';
      g.fillRect(x + gap, y + gap, tw + fs * 0.6, fs * 1.3);
      g.fillStyle = '#fff';
      g.fillText(label, x + gap + fs * 0.3, y + gap + fs * 1.0);
      if (i === this.frameIndex) {
        g.strokeStyle = '#4ea1ff';
        g.lineWidth = Math.max(2, cw * 0.025);
        g.strokeRect(x + gap, y + gap, cw - gap * 2, ch - gap * 2);
      }
    }
  }

  setGrid(on) {
    this.grid = on;
    if (on) this.pause();
    this._dirty = true;
    this.draw();
  }

  // 모든 프레임 보기에서 누른 위치(0~1 비율) → 프레임 번호 (빈 곳이면 -1)
  frameAtPoint(fx, fy) {
    const { cols, rows, cw, ch, ox, oy } = this.gridLayout();
    const x = fx * this.canvas.width - ox;
    const y = fy * this.canvas.height - oy;
    if (x < 0 || y < 0) return -1;
    const c = Math.floor(x / cw);
    const r = Math.floor(y / ch);
    const i = r * cols + c;
    return c < cols && r < rows && i < this.frameCount ? i : -1;
  }

  destroy() {
    this.pause();
    this._gridToken = null;
    for (const b of this.bitmaps.values()) b.close();
    this.bitmaps.clear();
    try {
      this.decoder?.close();
    } catch {}
  }
}
