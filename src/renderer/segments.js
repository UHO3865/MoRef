'use strict';
/* global app, rb, $, h, icon, toast, fmtTime, isTimed, fpsOf, currentFrame, seekFrame, markDirty, positionCtl, showMenu */
// 반복 구간 (여러 개) - 영상·GIF 공통
//
//  * it.segments = [{ id, a, b }]  (b 가 null 이면 끝까지). it.activeSeg = 지금 반복 중인 구간 id (없으면 전체 재생)
//  * it.a / it.b 는 "활성 구간"의 시작/끝을 가리킨다 (반복 재생, Blender 동기화가 이 값을 쓴다)
//  * 구간은 파일별로 라이브러리에 저장된다 → 같은 영상을 다른 보드에서 / 나중에 열어도 그대로
//  * [ : 활성 구간이 있으면 시작을 지금으로, 없으면 새 구간 시작   ] : 끝 (새 구간이면 여기서 만들어짐)
//    \ 또는 0 : 전체 재생   1~9 : 그 번호 구간 반복

const SEG_COLORS = ['#ffb347', '#5ad1a3', '#7fb2ff', '#f27ad8', '#ffe066', '#9b8cff', '#ff7a7a', '#6fd5ff'];
const segColor = (s) => SEG_COLORS[(s.id - 1) % SEG_COLORS.length];
const segActive = (it) => (it.activeSeg != null && it.segments?.find((s) => s.id === it.activeSeg)) || null;
const segIndex = (it, s) => it.segments.indexOf(s) + 1;
// "구간 2 · 발 디딤" (이름이 없으면 "구간 2")
const segName = (it, s) => tr('구간 {0}{1}', segIndex(it, s), s.name ? ` · ${s.name}` : '');
const libKey = (it) => (it.ref.file ? `file|${it.ref.file}` : `${it.ref.sourceId}|${it.ref.path}`);
const mediaDur = (it) => durOf(it) || 0; // 받기 전이면 ffprobe 길이

// 구간 경계는 프레임 경계에 맞춘다: 시작 = 그 프레임의 처음, 끝 = 그 프레임의 끝 (화면에 보이던 프레임까지 포함)
function snapStart(it, t) {
  if (it.kind === 'gif') return it.media.frameCount ? it.media.starts[it.media.frameAt(t)] : t;
  const fps = fpsOf(it);
  return Math.floor(t * fps + 0.01) / fps;
}
function snapEnd(it, t) {
  const d = mediaDur(it) || Infinity;
  if (it.kind === 'gif') {
    const m = it.media;
    if (!m.frameCount) return t;
    const i = m.frameAt(t);
    return i + 1 < m.frameCount ? m.starts[i + 1] : d;
  }
  const fps = fpsOf(it);
  return Math.min(d, (Math.floor(t * fps + 0.01) + 1) / fps);
}

// it.a / it.b → 활성 구간
function defineLoopAccessors(it) {
  for (const k of ['a', 'b']) {
    Object.defineProperty(it, k, {
      enumerable: true,
      configurable: true,
      get: () => segActive(it)?.[k] ?? null,
      set: (v) => {
        const s = segActive(it);
        if (v == null) it.activeSeg = null; // 예전 코드의 "구간 해제"
        else if (s) s[k] = v;
      },
    });
  }
}

// 보드 파일 / 예전 형식(a, b 하나) → 구간 목록
function initSegments(it, opts) {
  it.segments = (opts.segments || []).map((s) => ({ id: s.id, a: s.a, b: s.b ?? null, ...(s.name ? { name: s.name } : {}) }));
  it.activeSeg = opts.activeSeg ?? null;
  if (!opts.segments && (opts.a != null || opts.b != null)) {
    it.segments = [{ id: 1, a: opts.a ?? 0, b: opts.b ?? null }];
    it.activeSeg = 1;
  }
  it.pendingA = null;
  defineLoopAccessors(it);
  if (!isTimed(it)) return;
  // 라이브러리에 이 파일의 구간이 있으면 그것을 쓴다 (없으면 보드의 구간을 라이브러리에 올린다)
  rb.clips.get(libKey(it)).then((lib) => {
    if (!app.items.has(it.id)) return;
    if (lib?.length) {
      const fresh = !it.segments.length;
      it.segments = lib.map((s) => ({ ...s }));
      if (!segActive(it)) it.activeSeg = null;
      if (fresh && opts.openSeg == null) toast(tr('저장된 구간 {0}개를 불러왔습니다 - {1}', lib.length, it.name), 2200);
    } else if (it.segments.length) {
      rb.clips.set(libKey(it), it.segments);
    }
    renderSegments(it);
    if (opts.openSeg != null && it.segments.some((s) => s.id === opts.openSeg)) activateSegment(it, opts.openSeg);
  });
}

// 구간이 바뀌었을 때: 라이브러리 저장 + 같은 파일의 다른 레퍼런스에도 반영
function saveSegments(it) {
  const key = libKey(it);
  rb.clips.set(key, it.segments);
  clipLibChanged(key, it.segments);
  for (const o of app.items.values()) {
    if (o === it || !isTimed(o) || libKey(o) !== key) continue;
    o.segments = it.segments.map((s) => ({ ...s }));
    if (!segActive(o)) o.activeSeg = null;
    renderSegments(o);
  }
  markDirty();
}

function nextSegId(it) {
  return it.segments.reduce((m, s) => Math.max(m, s.id), 0) + 1;
}

// 구간 길이(프레임) - 영상은 실제 fps, GIF 는 실제 프레임
function segFrames(it, s) {
  const d = mediaDur(it);
  if (!d) return 0;
  const b = s.b ?? d;
  if (it.kind === 'gif') return it.media.frameAt(b - 1e-6) - it.media.frameAt(s.a) + 1;
  const fps = fpsOf(it);
  return Math.max(1, Math.ceil(b * fps - 0.01) - Math.floor(s.a * fps + 0.01));
}

// 활성 구간 안에서 지금 몇 번째 프레임인지
function segFrameInfo(it) {
  const s = segActive(it);
  if (!s || !mediaDur(it)) return null;
  const total = segFrames(it, s);
  const first = it.kind === 'gif' ? it.media.frameAt(s.a) : Math.floor(s.a * fpsOf(it) + 0.01);
  const now = it.kind === 'gif' ? it.media.frameIndex : currentFrame(it);
  return { n: segIndex(it, s), name: segName(it, s), cur: Math.min(total, Math.max(1, now - first + 1)), total, color: segColor(s) };
}

function addSegment(it, a, b) {
  const s = { id: nextSegId(it), a, b };
  it.segments.push(s);
  it.pendingA = null;
  activateSegment(it, s.id, { quiet: true });
  saveSegments(it);
  toast(tr('구간 {0} 만듦 · {1}프레임 - 칩을 더블클릭하면 이름을 붙일 수 있습니다', segIndex(it, s), segFrames(it, s)), 2600);
  return s;
}

function deleteSegment(it, id) {
  const i = it.segments.findIndex((s) => s.id === id);
  if (i < 0) return;
  const label = segName(it, it.segments[i]);
  it.segments.splice(i, 1);
  if (it.activeSeg === id) it.activeSeg = null;
  saveSegments(it);
  renderSegments(it);
  toast(tr('{0} 삭제', label));
}

// 구간 반복 시작 (id 가 null 이면 전체 재생). 구간 시작으로 이동한다
function activateSegment(it, id, { quiet = false } = {}) {
  if (!isTimed(it)) return;
  it.activeSeg = id;
  const s = segActive(it);
  it.seekSegWhenReady = !!s && !mediaDur(it);
  if (s && !it.seekSegWhenReady) {
    if (it.kind === 'video') seekFrame(it, Math.floor(s.a * fpsOf(it) + 0.01));
    else it.media.currentTime = s.a;
  }
  renderSegments(it);
  markDirty();
  if (!quiet) toast(s ? tr('{0} 반복 · {1}프레임', segName(it, s), segFrames(it, s)) : tr('전체 재생'));
}

// [ / ] (예전 이름 그대로: 다른 코드와 단축키가 이 함수를 쓴다)
function setLoopPoint(it, which, t = it.media.currentTime) {
  if (!isTimed(it)) return;
  const d = mediaDur(it) || Infinity;
  t = which === 'a' ? snapStart(it, t) : snapEnd(it, t);
  const s = segActive(it);
  if (s) {
    // 활성 구간의 시작/끝 조절
    if (which === 'a') s.a = Math.max(0, Math.min(t, (s.b ?? d) - 0.02));
    else s.b = Math.min(d, Math.max(t, s.a + 0.02));
    saveSegments(it);
    renderSegments(it);
    toast(`${segName(it, s)} ${which === 'a' ? tr('시작') : tr('끝')} = ${fmtTime(which === 'a' ? s.a : s.b)}`);
    return;
  }
  if (which === 'a') {
    it.pendingA = t;
    renderSegments(it);
    toast(tr('새 구간 시작 {0} - 끝 지점에서 ] (또는 우클릭)', fmtTime(t)), 2200);
    return;
  }
  const a = it.pendingA ?? 0;
  if (t <= a + 0.005) return toast(tr('끝은 시작보다 뒤여야 합니다'));
  addSegment(it, a, t);
}

function clearLoop(it) {
  if (!isTimed(it)) return;
  it.pendingA = null;
  activateSegment(it, null);
}

// ---------- 그리기 (진행 바의 구간 띠 · 손잡이 · 아래 구간 칩) ----------

function renderSegments(it) {
  const c = it.ctl;
  if (!c) return;
  const bar = it.ctlEl;
  const d = mediaDur(it);
  it.segDur = d;
  const pct = (x) => (x / d) * 100 + '%';
  const s = segActive(it);

  c.bands.replaceChildren(
    ...(d
      ? it.segments.map((g) => {
          const el = h('div', 'band' + (g === s ? ' on' : ''));
          el.style.left = pct(g.a);
          el.style.width = pct((g.b ?? d) - g.a);
          el.style.setProperty('--c', segColor(g));
          return el;
        })
      : [])
  );
  c.mkA.hidden = c.mkB.hidden = !(s && d);
  if (s && d) {
    c.mkA.style.left = pct(s.a);
    c.mkB.style.left = pct(s.b ?? d);
    bar.style.setProperty('--segc', segColor(s));
  }
  c.mkP.hidden = !(it.pendingA != null && d);
  if (!c.mkP.hidden) c.mkP.style.left = pct(it.pendingA);

  // 구간 칩
  const chips = [];
  const has = it.segments.length || it.pendingA != null;
  if (has) {
    const all = h('button', 'sc all' + (s ? '' : ' on'));
    all.innerHTML = tr('<span class="lb">전체</span>');
    all.title = tr('전체 재생 (0 또는 \\)');
    all.onclick = (e) => {
      e.stopPropagation();
      clearLoop(it);
    };
    chips.push(all);
    it.segments.forEach((g, i) => {
      const chip = h('button', 'sc' + (g === s ? ' on' : ''));
      chip.style.setProperty('--c', segColor(g));
      chip.dataset.id = g.id;
      chip.innerHTML = tr('<i class="dot"></i><span class="lb">{0}</span><span class="fc">{1}f</span><span class="del" title="구간 삭제">{2}</span>', i + 1, segFrames(it, g) || '', icon('x'));
      if (g.name) chip.querySelector('.lb').after(Object.assign(h('span', 'nm'), { textContent: g.name })); // 이름은 글자 그대로 (HTML 아님)
      chip.title = tr('{0}: {1} – {2} · {3}프레임\n클릭: 이 구간 반복 ({4}) · 더블클릭: 이름 · 우클릭: 메뉴', segName(it, g), fmtTime(g.a), fmtTime(g.b ?? d), segFrames(it, g), i < 9 ? i + 1 : '');
      chip.ondblclick = (e) => {
        e.stopPropagation();
        startRename(it, g.id);
      };
      chip.onclick = (e) => {
        e.stopPropagation();
        if (e.detail > 1) return; // 더블클릭(이름 붙이기)의 두 번째 클릭은 무시
        if (e.target.closest('.del')) return deleteSegment(it, g.id);
        activateSegment(it, g === s ? null : g.id);
      };
      chip.oncontextmenu = (e) => {
        e.preventDefault();
        e.stopPropagation();
        segMenu(it, g, e.clientX, e.clientY);
      };
      chips.push(chip);
    });
    if (it.pendingA != null) {
      const p = h('button', 'sc pending');
      p.innerHTML = `<span class="lb">${fmtTime(it.pendingA)} →</span>`;
      p.title = tr('새 구간 시작점. 끝 지점에서 ] 를 누르면 구간이 생깁니다. 클릭: 취소');
      p.onclick = (e) => {
        e.stopPropagation();
        it.pendingA = null;
        renderSegments(it);
      };
      chips.push(p);
    }
  }
  if (it.renaming == null) c.strip.replaceChildren(...chips);
  const changed = bar.classList.contains('has-segs') !== !!has;
  bar.classList.toggle('has-segs', !!has);
  bar.classList.toggle('looping', !!s);
  it.el.classList.toggle('looping', !!s);
  if (changed) {
    it.ctlH = null; // 바 높이가 바뀌었다
    positionCtl(it);
  }
  renderSide(it);
}

function editSeg(it, g, which) {
  const prev = it.activeSeg;
  it.activeSeg = g.id;
  setLoopPoint(it, which);
  it.activeSeg = prev;
  renderSegments(it);
}

// ---------- 구간 이름 ----------
// 칩 자리에 작은 입력칸을 띄운다. Enter 저장 · Esc 취소 · 다른 곳을 누르면 저장.
// (Electron 은 prompt() 를 지원하지 않고, 버튼 안의 입력칸은 클릭/Space 가 버튼으로 가서 칩을 따로 바꿔 끼운다)
function startRename(it, id) {
  const g = it.segments.find((s) => s.id === id);
  const chip = g && it.ctl?.strip.querySelector(`.sc[data-id="${id}"]`);
  if (!chip) return;
  if (it.renaming != null) return;
  it.renaming = id;
  it.ctlEl.classList.add('editing');
  refreshCtl(it);
  const ed = h('div', 'sc on renaming');
  ed.style.setProperty('--c', segColor(g));
  const inp = h('input', 'sc-name');
  inp.value = g.name || '';
  inp.placeholder = tr('구간 이름');
  inp.maxLength = 60;
  inp.spellcheck = false;
  ed.append(h('i', 'dot'), h('span', 'lb', String(segIndex(it, g))), inp);
  chip.replaceWith(ed);
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    it.renaming = null;
    it.ctlEl.classList.remove('editing');
    if (save) {
      const v = inp.value.trim().slice(0, 60);
      if (v !== (g.name || '')) {
        if (v) g.name = v;
        else delete g.name;
        saveSegments(it);
        toast(v ? tr('이름: {0}', segName(it, g)) : tr('{0} - 이름을 지웠습니다', segName(it, g)));
      }
    }
    renderSegments(it);
    refreshCtl(it);
    $('#board').focus();
  };
  const stop = (e) => e.stopPropagation(); // 입력하는 키가 재생·프레임 이동 단축키로 가지 않게
  inp.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  };
  inp.onkeyup = inp.onkeypress = stop;
  ed.onpointerdown = ed.onclick = ed.ondblclick = ed.oncontextmenu = stop;
  inp.onblur = () => finish(true);
  requestAnimationFrame(() => {
    inp.focus();
    inp.select();
  });
}

// F2: 선택한 레퍼런스의 반복 중인 구간 (없으면 마지막 구간) 이름
function renameCurrent(it) {
  if (!isTimed(it) || !it.segments?.length) return toast(tr('이름을 붙일 구간이 없습니다'));
  const s = segActive(it) || it.segments[it.segments.length - 1];
  startRename(it, s.id);
}

// 구간 하나의 우클릭 메뉴 (칩 · 보드 오른쪽 썸네일 공통)
function segMenu(it, g, x, y) {
  const d = mediaDur(it);
  const s = segActive(it);
  showMenu(x, y, [
    { header: tr('{0} · {1} – {2} · {3}프레임', segName(it, g), fmtTime(g.a), fmtTime(g.b ?? d), segFrames(it, g)) },
    { label: g.name ? tr('이름 바꾸기…') : tr('이름 붙이기…'), icon: 'pen', hint: 'F2', action: () => startRename(it, g.id) },
    { label: g === s ? tr('전체 재생으로') : tr('이 구간 반복'), icon: 'loop', action: () => activateSegment(it, g === s ? null : g.id) },
    { label: tr('시작을 지금 위치로'), icon: 'markA', action: () => editSeg(it, g, 'a') },
    { label: tr('끝을 지금 위치로'), icon: 'markB', action: () => editSeg(it, g, 'b') },
    'sep',
    { label: tr('구간 삭제'), icon: 'trash', danger: true, action: () => deleteSegment(it, g.id) },
  ]);
}
