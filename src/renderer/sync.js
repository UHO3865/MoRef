'use strict';
/* global app, $, h, icon, toast, isTimed, fpsOf, currentFrame, seekFrame, markDirty, updateViewBadges */
// Blender 타임라인 동기화 (Blender 애드온과 연결됐을 때 — src/blender.js)
//
// 애드온이 보내는 상태 { frame, fps, playing } 에 맞춰, "Blender 타임라인에 맞추기"를 켠 레퍼런스를 움직인다.
//  * 켜는 순간의 (Blender 프레임 b0 ↔ 레퍼런스 시각 t0) 를 기준점으로 삼는다 = 오프셋.
//    레퍼런스 시각 = t0 + (Blender 프레임 − b0) / Blender fps × 재생 속도
//  * A-B 반복 구간이 있으면 그 안에서, 없으면 영상 전체를 돌며 반복한다.
//  * Blender 가 멈춰 있을 때(스크럽/프레임 이동): 해당 프레임으로 정확히 이동.
//  * Blender 가 재생 중일 때: 영상도 재생하고, 3프레임 넘게 어긋나면 다시 맞춘다
//    (매 프레임 이동시키면 키프레임 간격이 긴 영상에서 끊긴다).
//  * 연결된 상태에서 ← → 로 레퍼런스를 움직이거나 진행 바를 끌면, 그 위치로 기준점이 다시 잡힌다.


function syncTarget(it, st) {
  const d = durOf(it);
  if (!isFinite(d) || !d) return null;
  let t = it.sync.t0 + ((st.frame - it.sync.b0) / st.fps) * it.rate;
  const a = it.a ?? 0;
  const len = (it.b ?? d) - a;
  if (len > 0) t = a + ((((t - a) % len) + len) % len);
  return t;
}

function applySync(it, st) {
  if (it.onScreen === false) return; // 화면 밖: 돌아올 때 맞춘다 (media.js)
  const t = syncTarget(it, st);
  if (t == null) return;
  const v = it.media;
  if (st.playing) {
    it.syncShown = null;
    if (v.paused) v.play().catch(() => {});
    // 어긋남(초): +면 레퍼런스가 뒤처짐. 이동(seek)은 끝나는 동안 Blender 가 또 앞서가서 따라잡지 못하므로,
    // 작은 차이는 재생 속도를 ±10% 까지 살짝 바꿔 따라잡고, 크게 어긋날 때만 조금 앞을 겨냥해 이동한다.
    const lag = t - v.currentTime;
    if (!v.seeking && Math.abs(lag) > 0.6) {
      v.currentTime = t + 0.15 * it.rate;
      v.playbackRate = it.rate;
    } else {
      const k = Math.abs(lag) < 0.5 / fpsOf(it) ? 0 : Math.max(-0.1, Math.min(0.1, lag * 0.5));
      v.playbackRate = it.rate * (1 + k);
    }
  } else {
    if (v.playbackRate !== it.rate) v.playbackRate = it.rate;
    if (!v.paused) v.pause();
    if (it.kind === 'video') {
      const n = Math.floor(t * fpsOf(it) + 1e-6);
      if (n !== it.syncShown) {
        it.syncShown = n;
        seekFrame(it, n);
      }
    } else {
      v.currentTime = t; // GIF: 프레임마다 길이가 달라 시각으로 바로
    }
  }
  updateSyncUi(it);
}

function initBlenderLink() {
  rb.blender.onLink(onBlenderLink);
  rb.blender.onState(onBlenderState);
  rb.blender.onToast((t) => toast(t, 3200));
  rb.blender.onBgProgress((p) => toast(`Blender 로 보낼 영상 받는 중… ${Math.round(p * 100)}%`, 800));
}

// 연결됨 / 끊김. link = { file } | null
function onBlenderLink(link) {
  const was = !!app.linked;
  app.linked = !!link;
  document.body.classList.toggle('blender-linked', app.linked);
  const info = $('#blenderInfo');
  if (!app.linked) {
    app.blender = null;
    if (was) toast('Blender 와 연결이 끊겼습니다');
  } else {
    app.blenderRangeSent = undefined; // 다시 연결되면 구간을 다시 보낸다
    info.title = `Blender 와 연결됨${link.file ? ' — ' + link.file : ''}`;
    if (!was) {
      info.textContent = 'Blender 연결됨';
      toast(`Blender 와 연결됐습니다${link.file ? ' (' + link.file + ')' : ''} — 영상의 🔗 로 타임라인에 맞출 수 있습니다`, 2600);
    }
  }
  for (const it of app.items.values()) updateSyncUi(it);
}

function onBlenderState(st) {
  app.blender = st;
  const info = $('#blenderInfo');
  if (info) {
    const f = Math.abs(st.fps - Math.round(st.fps)) < 0.01 ? Math.round(st.fps) : st.fps.toFixed(2);
    info.textContent = `Blender ${st.frame} · ${f}fps${st.playing ? ' ▶' : ''}`;
    info.classList.add('on');
  }
  for (const it of app.items.values()) if (it.sync && isTimed(it)) applySync(it, st);
  if (app.debugSync) {
    const it = [...app.items.values()].find((i) => i.sync);
    if (it) {
      const v = it.media;
      rb.debug(`state f=${st.frame} p=${st.playing ? 1 : 0} | ref frame=${currentFrame(it)} ct=${v.currentTime.toFixed(3)} paused=${v.paused} seeking=${v.seeking} rate=${v.playbackRate.toFixed(3)} pend=${it.pendingSeek ?? '-'}`);
    }
  }
}

function toggleSync(it) {
  if (!isTimed(it)) return;
  if (it.sync) {
    it.sync = null;
    toast('Blender 동기화 끔');
  } else {
    if (!app.blender) {
      return toast(app.linked ? 'Blender 타임라인 정보를 기다리는 중입니다' : 'Blender 와 연결되어 있지 않습니다 — Blender 에서 RefBoard 애드온을 켜세요');
    }
    it.sync = { b0: app.blender.frame, t0: it.media.currentTime };
    toast(`Blender ${app.blender.frame} 프레임 = 레퍼런스 ${currentFrame(it) + 1} 프레임으로 맞췄습니다`, 2400);
  }
  it.syncShown = null;
  updateSyncUi(it);
  updateViewBadges(it);
  markDirty();
}

// 연결된 레퍼런스를 직접 움직였을 때: 지금 Blender 프레임 = 레퍼런스의 새 위치
function realignSync(it, t = it.media.currentTime) {
  if (!it.sync || !app.blender) return;
  it.sync = { b0: app.blender.frame, t0: t };
  it.syncShown = null;
  updateSyncUi(it);
  markDirty();
}

// 반복 구간 → Blender 미리보기 범위: 맞춘 레퍼런스에 구간이 있으면 Blender 재생도 그 구간을 돈다.
// 레퍼런스 시각 t ↔ Blender 프레임 = b0 + (t − t0) × Blender fps / 재생 속도  (syncTarget 의 거꾸로)
function blenderRangeFor(it) {
  const st = app.blender;
  const d = durOf(it);
  if (!isFinite(d) || !d) return null;
  const a = it.a ?? 0;
  const b = it.b ?? d;
  const k = st.fps / it.rate;
  let start = Math.round(it.sync.b0 + (a - it.sync.t0) * k);
  // 구간 시작이 장면 시작(보통 1)보다 앞이면 (예: Blender 1 = 영상 5초로 맞추고 0~2초 구간 → −119)
  // 기준점을 "구간 시작 = 장면 시작 프레임"으로 다시 잡는다
  const s0 = st.start ?? 1;
  if (start < s0) {
    it.sync = { b0: s0, t0: a };
    it.syncShown = null;
    start = s0;
    updateSyncUi(it);
    markDirty();
    toast(`구간 시작을 Blender ${s0} 프레임에 맞췄습니다`, 2200);
  }
  const n = Math.max(1, Math.round((b - a) * k));
  return [start, start + n - 1];
}

// tick 에서 불린다. 바뀌었을 때만 보낸다 (고른 레퍼런스가 먼저, 없으면 구간이 있는 첫 레퍼런스)
function updateBlenderRange() {
  if (!app.linked || !app.blender) return;
  const synced = [...app.items.values()].filter((it) => it.sync && isTimed(it) && (it.a != null || it.b != null));
  const lead = synced.find((it) => app.selected.has(it)) || synced[0];
  const r = lead ? blenderRangeFor(lead) : null;
  const key = r ? r.join(' ') : 'none';
  updateViewportRefs();
  if (key === app.blenderRangeSent) return;
  app.blenderRangeSent = key;
  rb.blender.range(key);
}

function updateSyncUi(it) {
  const b = it.ctl?.sync;
  if (!b) return;
  b.classList.toggle('on', !!it.sync);
  b.title = it.sync
    ? `Blender 타임라인에 맞춤 — 기준: Blender ${it.sync.b0} 프레임 = 레퍼런스 ${Math.floor(it.sync.t0 * fpsOf(it)) + 1} 프레임\n← → 로 이 레퍼런스를 움직이면 기준이 다시 잡힙니다. 클릭: 끄기`
    : 'Blender 타임라인에 맞추기 (지금 Blender 프레임 = 지금 이 프레임)';
}

// ---- Blender 로 보내기: 카메라 배경 / 뷰포트 레퍼런스 ----

const refKey = (it) => (it.ref.file ? 'f|' + it.ref.file : `${it.ref.sourceId}|${it.ref.path}`);

// Blender 가 매 프레임 같은 영상 프레임을 고르도록 RefBoard 의 대응 규칙을 그대로 보낸다 (syncTarget 과 같은 식)
// 맞추지 않은 영상은 "지금 Blender 프레임 = 지금 영상 시각" 으로 한 번 정한다
function refMap(it) {
  const d = durOf(it) || 0;
  const s = it.sync || { b0: app.blender.frame, t0: it.media.currentTime };
  return { b0: s.b0, t0: +s.t0.toFixed(4), a: it.a ?? 0, b: it.b ?? d, d, rate: it.rate, fps: fpsOf(it) };
}

// 3D 뷰포트에 레퍼런스 이미지(Empty)로 띄운다 (3D 커서 자리, 정면을 봄)
async function sendToViewport(it) {
  if (!app.blender) return toast('Blender 타임라인 정보를 기다리는 중입니다');
  toast('Blender 로 보내는 중…', 1200);
  const map = refMap(it);
  const r = await rb.blender.viewportRef(it.ref, { name: it.name, key: refKey(it), map, flipX: !!it.flipH });
  if (!r.ok) return toast('보내지 못했습니다: ' + r.error, 3200);
  (app.viewportRefs ??= new Map()).set(it.id, JSON.stringify(map));
}

// tick: 뷰포트에 띄운 영상 중 타임라인에 맞춘 것은 기준점 / 구간 / 속도가 바뀌면 Blender 에 다시 알린다
function updateViewportRefs() {
  if (!app.viewportRefs?.size || !app.linked || !app.blender) return;
  for (const [id, sent] of app.viewportRefs) {
    const it = app.items.get(id);
    if (!it) {
      app.viewportRefs.delete(id);
      continue;
    }
    if (!it.sync) continue;
    const map = refMap(it);
    const json = JSON.stringify(map);
    if (json === sent) continue;
    app.viewportRefs.set(id, json);
    rb.blender.refMap(JSON.stringify({ key: refKey(it), map }));
  }
}

async function sendToCameraBg(it) {
  const fps = fpsOf(it);
  const info = {
    name: it.name,
    fps,
    frame: currentFrame(it), // 지금 이 프레임 = 지금 Blender 프레임
    flipX: !!it.flipH,
    sync: it.sync ? { b0: it.sync.b0, frame0: Math.floor(it.sync.t0 * fps + 1e-6) } : null,
  };
  toast('Blender 로 보내는 중…', 1200);
  const r = await rb.blender.cameraBg(it.ref, info);
  if (!r.ok) toast('보내지 못했습니다: ' + r.error, 3200);
}
