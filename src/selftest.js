// `npm run selftest` - 실제 창을 띄워 탐색 → 보드에 열기 → 구간반복/속도 → 저장 → 닫기 → 다시 불러오기를
// 자동으로 수행하고 단계별 스크린샷을 남긴다. 소스는 환경변수로 받는다:
//   RB_TEST_URL, RB_TEST_TYPE(dav|local), RB_TEST_USER, RB_TEST_PASS, RB_TEST_OUT(스크린샷 폴더)
// 시험 파일(fps · GIF · 반전 · 썸네일 단계에 필요한 것)은 scripts/make-test-media.js 로 만든다.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const jsonfile = require('./jsonfile');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(win) {
  const out = process.env.RB_TEST_OUT || path.join(app.getPath('temp'), 'refboard-shots');
  fs.mkdirSync(out, { recursive: true });
  const js = (code) =>
    win.webContents.executeJavaScript(code).catch((e) => {
      console.log('[selftest] JS FAILED:', code.replace(/\s+/g, ' ').slice(0, 220));
      throw e;
    });
  // 스크린샷이 실패해도(드물게 GPU 쪽 오류) 점검은 이어간다 - 화면 픽셀로 확인하는 단계가 따로 있다
  const shot = async (name) => {
    try {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(out, name + '.png'), img.toPNG());
    } catch (e) {
      console.log('[selftest] screenshot failed', name, e.message);
    }
  };
  const log = (...a) => console.log('[selftest]', ...a);
  win.webContents.on('console-message', (e) => log('console:', e.message));
  win.on('minimize', () => log('window minimized (화면 캡처가 실패한다)'));

  // RB_TEST_SCRIPT=<파일>: 전체 점검 대신 그 파일의 시나리오만 실행 (module.exports = async ({ win, js, shot, log, wait }) => …)
  if (process.env.RB_TEST_SCRIPT) {
    try {
      await wait(2500);
      await require(process.env.RB_TEST_SCRIPT)({ win, js, shot, log, wait, out });
    } catch (e) {
      log('FAILED', e.stack || e);
    }
    jsonfile.flushAll();
    return app.exit(0);
  }

  try {
    await wait(4000); // 목록 + 썸네일
    await shot('1-browse');
    const fps = () => js(`new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < 1000 ? requestAnimationFrame(f) : r(n); }; requestAnimationFrame(f); })`);
    log('fps empty board', await fps(), 'visible', await js('document.visibilityState'), 'focused', win.isFocused(), 'minimized', win.isMinimized());

    // 썸네일 크기 슬라이더: 실제 마우스로 끌기 → 자석 스냅 / 중간에서 놓기 → 가까운 단계 / 아이콘 클릭
    {
      const send = (ev) => win.webContents.sendInputEvent(ev);
      const sr = JSON.parse(await js(`JSON.stringify($('#thumbSize').getBoundingClientRect())`));
      const knob = 16;
      const xAt = (step) => Math.round(sr.left + knob / 2 + ((sr.width - knob) * step) / 3);
      const y = Math.round(sr.top + sr.height / 2);
      const state = () => js(`JSON.stringify({ v: Math.round(RB.app.thumbVal), step: RB.app.thumbStep, cols: getComputedStyle($('#grid')).gridTemplateColumns.split(' ').length })`);
      send({ type: 'mouseMove', x: xAt(1), y });
      send({ type: 'mouseDown', x: xAt(1), y, button: 'left', clickCount: 1 });
      for (let k = 1; k <= 10; k++) {
        send({ type: 'mouseMove', x: Math.round(xAt(1) + ((xAt(2.15) - xAt(1)) * k) / 10), y, button: 'left', modifiers: ['leftButtonDown'] });
        await wait(16);
      }
      await wait(100);
      log('slider: dragged to 2.15 (should stick to 200)', await state());
      for (let k = 1; k <= 6; k++) {
        send({ type: 'mouseMove', x: Math.round(xAt(2.15) + ((xAt(2.6) - xAt(2.15)) * k) / 6), y, button: 'left', modifiers: ['leftButtonDown'] });
        await wait(16);
      }
      send({ type: 'mouseUp', x: xAt(2.6), y, button: 'left', clickCount: 1 });
      await wait(400);
      log('slider: released at 2.6 (should glide to 300, 1 col)', await state());
      await shot('1b-thumbs-1col');
      await js(`$('#gridIcons').children[0].click()`);
      await wait(400);
      log('slider: clicked 4-col icon', await state());
      await shot('1c-thumbs-4col');
      await js(`$('#gridIcons').children[1].click()`);
      await wait(300);
    }
    log('root entries', await js('JSON.stringify(RB.app.entries.map(e=>e.kind+":"+e.name))'));

    // 하위 폴더로 들어가서 썸네일 확인
    const dir = await js('(RB.app.entries.find(e=>e.kind==="dir")||{}).path||""');
    if (dir) {
      await js(`RB.openFolder(${JSON.stringify(dir)})`);
      await wait(4000);
      await shot('2-subfolder');
      log('subfolder', dir, 'count', await js('RB.app.entries.length'));
      // 하위 폴더 영상(.mov 포함)도 보드에 올린다
      await js(`(async () => { let y = 400; for (const e of RB.app.entries.filter(e => e.kind === 'video')) {
        await RB.addItem({ kind: e.kind, ref: { sourceId: RB.app.sourceId, path: e.path }, name: e.name, x: 0, y }); y += 600; } })()`);
      const t0 = Date.now();
      await js('RB.openFolder("many")');
      log('many: entries', await js('RB.app.entries.length'), 'ms', Date.now() - t0);
      await wait(5000);
      await shot('2b-many');
      log('many: thumbs done/pending/none', await js(`(() => { const c = [...document.querySelectorAll('#grid .card.video')]; const n = (s) => c.filter(x => x.thumbState === s).length; return [n('done'), n('pending'), c.length - n('done') - n('pending')].join('/'); })()`));

      // 썸네일 품질/실패 기억: 검게 시작하는 영상은 1초 지점으로, 깨진 파일은 오류로 기억
      await js('RB.openFolder("thumbtest")');
      await wait(4000);
      log('thumbtest', await js(`(async () => {
        const out = {};
        for (const card of document.querySelectorAll('#grid .card')) {
          const name = card._entry.name;
          const bg = card.querySelector('.th').style.backgroundImage;
          if (!bg) { out[name] = card.thumbState + ' ' + (card.querySelector('.th').title || ''); continue; }
          const img = new Image(); img.src = bg.slice(5, -2); await img.decode();
          const c = document.createElement('canvas'); c.width = 16; c.height = 9;
          const g = c.getContext('2d'); g.drawImage(img, 0, 0, 16, 9);
          const d = g.getImageData(0, 0, 16, 9).data; let sum = 0;
          for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
          out[name] = 'mean brightness ' + Math.round(sum / (d.length / 4));
        }
        return JSON.stringify(out);
      })()`));
      const failedPath = path.join(app.getPath('userData'), 'thumbs', 'failed.json');
      await wait(1200);
      log('failed.json entries', fs.existsSync(failedPath) ? Object.keys(JSON.parse(fs.readFileSync(failedPath, 'utf8'))).length : 'none');

      // 목록 캐시: 두 번째 열기는 메모리에서 즉시, 디스크에도 저장됨
      let t1 = Date.now();
      await js('RB.openFolder("many")');
      log('many: 2nd open ms', Date.now() - t1, '| listing files on disk', fs.readdirSync(path.join(app.getPath('userData'), 'listings')).length);
      await js('RB.openFolder("")');
      await wait(1500);
    }

    // 미디어 전부 보드에 올리기
    await js(`(async () => {
      const list = RB.app.entries.filter(e => e.kind !== 'dir');
      let x = 0;
      for (const e of list) {
        await RB.addItem({ kind: e.kind, ref: { sourceId: RB.app.sourceId, path: e.path }, name: e.name, x, y: (x % 1500) ? 0 : 0 });
        x += 520;
      }
    })()`);
    await wait(5000);
    await js('RB.select(null, false); RB.fitView()');
    await wait(500);
    const state = await js(`JSON.stringify([...RB.app.items.values()].map(it => ({
      name: it.name, kind: it.kind,
      w: it.media.videoWidth || it.media.naturalWidth, h: it.media.videoHeight || it.media.naturalHeight,
      t: it.media.currentTime, paused: it.media.paused, err: it.media.error && it.media.error.code,
      overlay: !!it.el.querySelector('.err') })))`);
    log('items', state);
    await shot('3-board');

    // 모든 영상: 반복 구간 0.5~1.5초, 속도 0.5x
    await js(`(() => {
      for (const it of RB.app.items.values()) {
        if (it.kind !== 'video') continue;
        it.media.currentTime = 0.5; RB.setLoopPoint(it, 'a');
        it.media.currentTime = 1.5; RB.setLoopPoint(it, 'b');
        RB.changeSpeed(it, -1); RB.changeSpeed(it, -1);
        it.media.currentTime = 0.5; it.media.play().catch(() => {});
        RB.select(it, true);
      }
    })()`);
    log('fps during loop', await js(`new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < 1000 ? requestAnimationFrame(f) : r(n); }; requestAnimationFrame(f); })`));
    const samples = [];
    for (let i = 0; i < 10; i++) {
      await wait(400);
      samples.push(await js(`[...RB.app.items.values()].filter(i => i.kind === 'video').map(it => { const m = it.media;
        return m.currentTime.toFixed(2) + (m.paused ? 'p' : '') + (m.seeking ? 's' : ''); }).join(',')`));
    }
    log('loop check (a=0.5 b=1.5 @0.5x)', await js(`[...RB.app.items.values()].filter(i => i.kind === 'video').map(i => i.name).join(',')`), samples.join(' | '));
    await shot('4-loop');

    // (시험 폴더에 '점프 01.mp4' 가 없으면 첫 영상으로)
    // 재생 UI 클로즈업: 한 영상에 맞추고 진행 바에 마우스 올리기 → 속도 목록 열기
    await js(`(() => { const it = ([...RB.app.items.values()].find(i => i.name === '점프 01.mp4') || [...RB.app.items.values()].find(i => i.kind === 'video')); RB.select(it, false); RB.fitView(); })()`);
    await wait(400);
    const sr = JSON.parse(await js(`JSON.stringify([...RB.app.selected][0].ctlEl.querySelector('.scrub').getBoundingClientRect())`));
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(sr.left + sr.width * 0.62), y: Math.round(sr.top + sr.height / 2) });
    await wait(400);
    await shot('4b-controls');
    await js(`[...RB.app.selected][0].ctl.speed.click()`);
    await wait(200);
    await shot('4c-speed-menu');
    log('ui: menu open', await js(`[...RB.app.selected][0].ctl.menu.classList.contains('open')`));
    win.webContents.sendInputEvent({ type: 'mouseDown', x: 5, y: 300, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: 5, y: 300, button: 'left', clickCount: 1 });
    await wait(150);
    log('ui: menu closed by outside click', !(await js(`[...RB.app.selected][0].ctl.menu.classList.contains('open')`)));

    // ---- 패널 표시 / 우클릭 바로가기 / 우클릭 구간 지정 (실제 마우스) ----
    {
      const send = (ev) => win.webContents.sendInputEvent(ev);
      const click = async (x, y, button = 'left') => {
        x = Math.round(x);
        y = Math.round(y);
        send({ type: 'mouseMove', x, y });
        send({ type: 'mouseDown', x, y, button, clickCount: 1 });
        send({ type: 'mouseUp', x, y, button, clickCount: 1 });
        await wait(250);
      };
      const rect = (sel) => js(`JSON.stringify(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect())`).then(JSON.parse);
      const menuLabels = () => js(`JSON.stringify([...document.querySelectorAll('.ctx .ctx-item, .ctx .ctx-head')].map(b => (b.disabled ? '(x)' : '') + b.textContent))`);

      log('panel marks', await js(`JSON.stringify([...document.querySelectorAll('#grid .card.on-board')].map(c => c._entry.name))`), '| info:', await js(`$('#listInfo').textContent`));

      // 보드를 먼 곳으로 옮겨 두고 → 카드 우클릭 → "보드에서 보기"
      await js(`RB.select(null, false); RB.app.view = { x: -5000, y: -5000, s: 0.3 }; layoutAll();`);
      const cr = await rect(`#grid .card.on-board`);
      const cardName = await js(`document.querySelector('#grid .card.on-board')._entry.name`);
      await click(cr.left + cr.width / 2, cr.top + cr.height / 2, 'right');
      log('card menu', await menuLabels());
      await shot('10-card-menu');
      const go = await rect('.ctx .ctx-item.primary');
      await click(go.left + 20, go.top + go.height / 2);
      await wait(700);
      log('go to item', await js(`(() => { const it = [...RB.app.selected][0]; if (!it) return 'nothing selected';
        const b = it.el.getBoundingClientRect(), bb = $('#board').getBoundingClientRect();
        return JSON.stringify({ selected: it.name, centerOffset: [Math.round(b.left + b.width / 2 - (bb.left + bb.width / 2)), Math.round(b.top + b.height / 2 - (bb.top + bb.height / 2))], widthShare: +(b.width / bb.width).toFixed(2) }); })()`), 'expected', cardName);
      await shot('11-went-to-item');

      // 영상 진행 바 30% 지점 우클릭 → A, 영상 화면 우클릭 → 현재 위치를 B
      const it = `([...RB.app.items.values()].find(i => i.name === '점프 01.mp4') || [...RB.app.items.values()].find(i => i.kind === 'video'))`;
      await js(`(() => { const it = ${it}; it.a = it.b = null; goToItem(it); })()`);
      await wait(700);
      await js(`(() => { const it = ${it}; it.media.pause(); it.media.currentTime = 4.2; })()`);
      await wait(300);
      const sr = JSON.parse(await js(`JSON.stringify((${it}).ctlEl.querySelector('.rail').getBoundingClientRect())`));
      await click(sr.left + sr.width * 0.3, sr.top + sr.height / 2, 'right');
      log('scrub menu', await menuLabels());
      await shot('12-item-menu');
      let mi = JSON.parse(await js(`JSON.stringify(document.querySelectorAll('.ctx .ctx-item')[0].getBoundingClientRect())`));
      await click(mi.left + 20, mi.top + mi.height / 2);
      const vr = JSON.parse(await js(`JSON.stringify((${it}).el.getBoundingClientRect())`));
      await click(vr.left + vr.width / 2, vr.top + vr.height * 0.4, 'right');
      log('video menu', await menuLabels());
      mi = JSON.parse(await js(`JSON.stringify(document.querySelectorAll('.ctx .ctx-item')[1].getBoundingClientRect())`));
      await click(mi.left + 20, mi.top + mi.height / 2);
      log('loop via right-click', await js(`(() => { const it = ${it}; return JSON.stringify({ a: +it.a.toFixed(2), b: +it.b.toFixed(2), duration: it.media.duration }); })()`), 'expected a≈1.8 (30% of 6s), b=4.2');

      // 음소거: 소리를 켠 채 저장해도 다시 열면 음소거
      await js(`(() => { const it = ${it}; if (it.muted) RB.app.items.get(it.id) && it.ctlEl.querySelector('.ib:last-child').click(); })()`);
      log('unmuted before save', await js(`(${it}).muted === false`));
    }

    // ---- 재생 바 위치 + GIF (실제 마우스/키보드) ----
    {
      const send = (ev) => win.webContents.sendInputEvent(ev);
      const click = async (x, y, button = 'left') => {
        x = Math.round(x);
        y = Math.round(y);
        send({ type: 'mouseMove', x, y });
        send({ type: 'mouseDown', x, y, button, clickCount: 1 });
        send({ type: 'mouseUp', x, y, button, clickCount: 1 });
        await wait(250);
      };
      const key = async (keyCode) => {
        send({ type: 'keyDown', keyCode });
        send({ type: 'keyUp', keyCode });
        await wait(150);
      };
      const R = (expr) => js(`JSON.stringify((${expr}).getBoundingClientRect())`).then(JSON.parse);

      // 영상: 바가 항목 바로 아래에 있는지
      const vid = `([...RB.app.items.values()].find(i => i.name === '점프 01.mp4') || [...RB.app.items.values()].find(i => i.kind === 'video'))`;
      await js(`goToItem(${vid})`);
      await wait(600);
      const ir = await R(`(${vid}).el`);
      const br = await R(`(${vid}).ctlEl`);
      log('video bar below item', JSON.stringify({ gap: Math.round(br.top - ir.bottom), sameCenter: Math.abs((br.left + br.width / 2) - (ir.left + ir.width / 2)) < 2, overlapsItem: br.top < ir.bottom, shown: await js(`(${vid}).ctlEl.classList.contains('show')`) }));
      await shot('13-video-bar-below');

      // GIF 올리기 (프레임마다 길이가 다른 GIF: 50,100,…,400ms)
      await js(`(async () => { const e = { path: 'thumbtest/vardelay.gif', name: 'vardelay.gif' };
        const it = await RB.addItem({ kind: 'gif', ref: { sourceId: RB.app.sourceId, path: e.path }, name: e.name, x: 3000, y: 0, paused: true });
        window.__gif = it; })()`);
      await wait(1500);
      const G = `window.__gif`;
      await js(`goToItem(${G})`);
      await wait(700);
      log('gif loaded', await js(`JSON.stringify({ frames: ${G}.media.frameCount, duration: +${G}.media.duration.toFixed(3), delays: ${G}.media.delays.map(d => Math.round(d * 1000)), size: [${G}.media.videoWidth, ${G}.media.videoHeight], hasMute: !!${G}.ctl.mute, hasFrames: !!${G}.ctl.frames })`));

      // → ← : 한 프레임씩
      await key('Right');
      await key('Right');
      const afterRight = await js(`${G}.media.frameIndex`);
      await key('Left');
      log('frame step (→ → ←)', afterRight, '→', await js(`${G}.media.frameIndex`), '| counter:', await js(`${G}.ctl.fr.textContent`));

      // 재생 버튼 클릭 → 0.9초 뒤 위치 (1x)
      await js(`${G}.media.currentTime = 0`);
      const pb = await R(`${G}.ctl.play`);
      const t0 = Date.now(); // click() 이 누른 뒤 잠깐 기다리므로 누르기 전부터 잰다
      await click(pb.left + pb.width / 2, pb.top + pb.height / 2);
      await wait(Math.max(0, 900 - (Date.now() - t0)));
      const s1 = JSON.parse(await js(`JSON.stringify({ t: ${G}.media.currentTime, f: ${G}.media.frameIndex, paused: ${G}.media.paused })`));
      log('play 1x after', Date.now() - t0, 'ms →', JSON.stringify({ t: +s1.t.toFixed(2), frame: s1.f + 1, paused: s1.paused }), '(1x: t≈0.9 → frame 6)');

      // 속도: 속도 버튼 → 목록에서 0.5× 클릭
      const sp = await R(`${G}.ctl.speed`);
      await click(sp.left + sp.width / 2, sp.top + sp.height / 2);
      const opt = await js(`JSON.stringify([...${G}.ctl.menu.children].find(o => o.dataset.rate === '0.5').getBoundingClientRect())`).then(JSON.parse);
      await click(opt.left + opt.width / 2, opt.top + opt.height / 2);
      const a0 = await js(`${G}.media.currentTime`);
      await wait(1000);
      const a1 = await js(`${G}.media.currentTime`);
      const adv = ((a1 - a0 + 1.8) % 1.8).toFixed(2);
      log('speed 0.5x: advanced', adv, 's in 1s (expect ≈0.5) | rate', await js(`${G}.media.playbackRate`), '| label', await js(`${G}.ctl.speed.textContent`));

      // Space 로 멈춤
      await js(`RB.select(${G}, false)`);
      await key('Space');
      log('space pauses gif', await js(`${G}.media.paused`));

      // 모든 프레임 보기 → 3번째 프레임 클릭
      const fb = await R(`${G}.ctl.frames`);
      await click(fb.left + fb.width / 2, fb.top + fb.height / 2);
      await wait(500);
      log('all frames on', await js(`${G}.media.grid`), '| layout', await js(`JSON.stringify((({ cols, rows }) => ({ cols, rows }))(${G}.media.gridLayout()))`));
      await shot('14-gif-all-frames');
      const cell = JSON.parse(await js(`(() => { const m = ${G}.media, r = m.canvas.getBoundingClientRect(), L = m.gridLayout(), i = 2;
        const cx = (L.ox + (i % L.cols + 0.5) * L.cw) / m.canvas.width, cy = (L.oy + (Math.floor(i / L.cols) + 0.5) * L.ch) / m.canvas.height;
        return JSON.stringify({ x: r.left + cx * r.width, y: r.top + cy * r.height }); })()`));
      await click(cell.x, cell.y);
      await wait(300);
      log('clicked cell 3 →', JSON.stringify({ grid: await js(`${G}.media.grid`), frame: (await js(`${G}.media.frameIndex`)) + 1 }));
      await shot('15-gif-frame3');
    }

    // ---- 실제 프레임 레이트: 화면에 나온 프레임 == 프레임 번호 표시 (실제 키 입력) ----
    // 테스트 영상은 프레임 n 의 밝기가 Y = 16 + 7·(n mod 30) → 화면 회색값 ≈ 8.15·(n mod 30)
    {
      const send = (ev) => win.webContents.sendInputEvent(ev);
      const key = async (keyCode, modifiers = []) => {
        send({ type: 'keyDown', keyCode, modifiers });
        send({ type: 'keyUp', keyCode, modifiers });
        await wait(220);
      };
      const shownFrame = async (expr) => {
        const r = JSON.parse(await js(`JSON.stringify((${expr}).el.getBoundingClientRect())`));
        const area = { x: Math.round(r.left + r.width * 0.25) - 2, y: Math.round(r.top + r.height * 0.6) - 2, width: 4, height: 4 };
        const img = await win.webContents.capturePage(area).catch((e) => {
          throw new Error(`${e.message} capturing ${JSON.stringify(area)} of ${JSON.stringify(r)} in ${JSON.stringify(win.getContentBounds())}`);
        });
        const px = img.toBitmap(); // BGRA
        return Math.round(px[1] / 8.15); // 회색이라 G 만 봐도 된다
      };
      for (const f of ['f24.mp4', 'f2997.mp4', 'f60.mp4', 'f25.webm']) {
        await js(`(async () => { window.__fv = await RB.addItem({ kind: 'video', ref: { sourceId: RB.app.sourceId, path: 'fpstest/${f}' }, name: '${f}', x: 6000, y: 0, paused: true }); })()`);
        await wait(1800);
        const V = 'window.__fv';
        await js(`goToItem(${V})`);
        await wait(600);
        await js(`seekFrame(${V}, 0)`);
        await wait(300);
        const rows = [];
        const check = async (label) => {
          const counter = await js(`${V}.ctl.fr.textContent`);
          const n = Number(counter.split(' / ')[0]) - 1;
          const shown = await shownFrame(V);
          rows.push(`${label}:${n}${n % 30 === shown ? '' : `≠화면${shown}`}`);
          return n;
        };
        await check('start');
        for (let k = 1; k <= 5; k++) {
          await key('Right');
          await check('→');
        }
        await key('Right', ['shift']);
        await check('⇧→(1s)');
        await key('Left');
        await key('Left');
        await check('←←');
        const info = JSON.parse(await js(`JSON.stringify({ fps: ${V}.fps, frames: ${V}.frames, total: totalFrames(${V}), label: fpsLabel(${V}) })`));
        log(`fps ${f}`, JSON.stringify(info), '|', rows.join(' '));
        await js(`RB.removeItem(${V})`);
      }
      log('probe cache entries', Object.keys(JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'probe-cache.json'), 'utf8'))).length);
    }

    // ---- 반전 · 흑백 · 자르기 (실제 키/마우스, 화면 픽셀로 확인) ----
    // quad.png: 왼쪽 위 빨강, 오른쪽 위 초록, 왼쪽 아래 파랑, 오른쪽 아래 흰색
    {
      const send = (ev) => win.webContents.sendInputEvent(ev);
      const key = async (keyCode, modifiers = []) => {
        send({ type: 'keyDown', keyCode, modifiers });
        send({ type: 'keyUp', keyCode, modifiers });
        await wait(250);
      };
      const drag = async (x0, y0, x1, y1) => {
        send({ type: 'mouseMove', x: Math.round(x0), y: Math.round(y0) });
        send({ type: 'mouseDown', x: Math.round(x0), y: Math.round(y0), button: 'left', clickCount: 1 });
        for (let k = 1; k <= 12; k++) {
          send({ type: 'mouseMove', x: Math.round(x0 + ((x1 - x0) * k) / 12), y: Math.round(y0 + ((y1 - y0) * k) / 12), button: 'left', modifiers: ['leftButtonDown'] });
          await wait(16);
        }
        send({ type: 'mouseUp', x: Math.round(x1), y: Math.round(y1), button: 'left', clickCount: 1 });
        await wait(200);
      };
      const click = async (x, y, button = 'left') => {
        send({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
        send({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button, clickCount: 1 });
        send({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button, clickCount: 1 });
        await wait(250);
      };
      const Q = 'window.__q';
      const rect = async () => JSON.parse(await js(`JSON.stringify(${Q}.el.getBoundingClientRect())`));
      const color = async (u, v) => {
        const r = await rect();
        const img = await win.webContents.capturePage({ x: Math.round(r.left + r.width * u) - 1, y: Math.round(r.top + r.height * v) - 1, width: 2, height: 2 });
        const [b, g, rr] = img.toBitmap();
        if (Math.abs(rr - g) < 14 && Math.abs(g - b) < 14) return rr > 200 ? 'white' : `gray${rr}`;
        return rr > 150 && g < 100 ? 'red' : g > 150 && rr < 100 ? 'green' : b > 150 && rr < 100 ? 'blue' : `?${rr},${g},${b}`;
      };
      const corners = async () => `${await color(0.25, 0.25)}/${await color(0.75, 0.25)}/${await color(0.25, 0.75)}/${await color(0.75, 0.75)}`;

      await js(`(async () => { window.__q = await RB.addItem({ kind: 'image', ref: { sourceId: RB.app.sourceId, path: 'thumbtest/quad.png' }, name: 'quad.png', x: 9000, y: 0 }); })()`);
      await wait(1200);
      await js(`goToItem(${Q})`);
      await wait(700);
      log('view: start (TL/TR/BL/BR)', await corners());
      await key('H', ['shift']);
      log('view: Shift+H mirror', await corners(), '| badge', await js(`${Q}.el.classList.contains('has-view')`));
      await key('V', ['shift']);
      log('view: + Shift+V flip', await corners());
      await key('V', ['shift']);
      await key('H', ['shift']);
      await key('G', ['shift']);
      log('view: Shift+G gray', await corners());
      await key('G', ['shift']);
      log('view: all back', await corners(), '| badge', await js(`${Q}.el.classList.contains('has-view')`));

      // 빨강 칸 가운데에 점 하나 그려 두고 → 자른 뒤에도 같은 내용 위에 있는지
      await js(`(() => { const it = ${Q}; it.shapes = [{ t: 'pen', c: '#00ffff', w: 0.02, p: [[0.1, 0.1 * it.h / it.w]] }]; renderShapes(it); })()`);
      const before = await rect();

      // C → 오른쪽 아래 손잡이를 가운데까지 끌기 → Enter
      await key('C');
      log('crop: mode', await js(`!!${Q}.cropEdit`), '| ui', await js(`!!${Q}.el.querySelector('.cropbox')`));
      const se = JSON.parse(await js(`JSON.stringify(${Q}.el.querySelector('.ch.se').getBoundingClientRect())`));
      await drag(se.left + se.width / 2, se.top + se.height / 2, before.left + before.width / 2, before.top + before.height / 2);
      await shot('16-crop-mode');
      await key('Return');
      await wait(200);
      const after = await rect();
      log('crop: applied', JSON.stringify({
        crop: await js(`JSON.stringify(${Q}.crop)`),
        sameTopLeft: Math.abs(after.left - before.left) < 2 && Math.abs(after.top - before.top) < 2,
        widthRatio: +(after.width / before.width).toFixed(3),
        shown: await corners(),
        dot: await js(`JSON.stringify(${Q}.shapes[0].p[0].map(n => +n.toFixed(3)))`),
        dotExpected: await js(`JSON.stringify([0.2, +(0.2 * ${Q}.h / ${Q}.w).toFixed(3)])`),
      }));
      await shot('17-cropped');

      // 저장 → 다시 불러오기에도 유지
      const saved = await js('RB.serialize()');
      await js(`RB.loadBoard(${JSON.stringify(saved)}, null)`);
      await wait(2500);
      await js(`window.__q = [...RB.app.items.values()].find(i => i.name === 'quad.png'); goToItem(${Q})`);
      await wait(700);
      log('crop: after reload', await js(`JSON.stringify(${Q}.crop)`), await corners());

      // 우클릭 → 자르기 해제
      const r = await rect();
      await click(r.left + r.width / 2, r.top + r.height / 2, 'right');
      const labels = await js(`JSON.stringify([...document.querySelectorAll('.ctx .ctx-item')].map(b => b.textContent))`);
      const reset = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('.ctx .ctx-item')].find(b => b.textContent.startsWith('자르기 해제')).getBoundingClientRect())`));
      await click(reset.left + 20, reset.top + reset.height / 2);
      await js(`goToItem(${Q})`);
      await wait(700);
      log('crop: menu', labels);
      log('crop: reset', await js(`String(${Q}.crop)`), await corners(), '| aspect', await js(`(${Q}.w / ${Q}.h).toFixed(3)`));
    }

    // ---- Blender 타임라인 동기화: 애드온이 보내는 상태를 흉내 내고, 화면에 나온 프레임으로 확인 ----
    {
      const send = (ev) => win.webContents.sendInputEvent(ev);
      const key = async (keyCode) => {
        send({ type: 'keyDown', keyCode });
        send({ type: 'keyUp', keyCode });
        await wait(250);
      };
      const V = 'window.__sv';
      const shown = async () => {
        const r = JSON.parse(await js(`JSON.stringify(${V}.el.getBoundingClientRect())`));
        const img = await win.webContents.capturePage({ x: Math.round(r.left + r.width * 0.25) - 2, y: Math.round(r.top + r.height * 0.6) - 2, width: 4, height: 4 });
        return Math.round(img.toBitmap()[1] / 8.15);
      };
      const B = (frame, fps = 24, playing = false) => js(`onBlenderState(${JSON.stringify({ frame, fps, playing })})`);
      const check = async (label, expect) => {
        await wait(300);
        const n = Number((await js(`${V}.ctl.fr.textContent`)).split(' / ')[0]) - 1;
        const px = await shown();
        return `${label}:${n}${n === expect ? '' : `(기대${expect})`}${n % 30 === px ? '' : `≠화면${px}`}`;
      };

      await js(`(async () => { window.__sv = await RB.addItem({ kind: 'video', ref: { sourceId: RB.app.sourceId, path: 'fpstest/f24.mp4' }, name: 'f24.mp4', x: 12000, y: 0, paused: true }); })()`);
      await wait(1800);
      await js(`goToItem(${V})`);
      await wait(600);
      await js(`seekFrame(${V}, 0)`);
      await B(100);
      await js(`toggleSync(${V})`);
      const rows = [];
      await B(105);
      await wait(900); // 불러온 뒤 첫 이동은 화면에 나오기까지 조금 더 걸린다
      rows.push(await check('B105', 5));
      rows.push((await B(112), await check('B112', 12)));
      rows.push((await B(130), await check('B130', 30)));
      rows.push((await B(130, 30), await check('B130@30fps', 24))); // Blender 가 30fps 면 30프레임 = 1초 = 레퍼런스 24프레임
      rows.push((await B(140), await check('B140', 40)));
      log('sync: scrub', rows.join(' '));

      // 연결된 채로 → → : 레퍼런스가 2프레임 앞으로, 기준점이 다시 잡힘 → Blender 141 = 43
      await key('Right');
      await key('Right');
      const re = [await check('→→', 42)];
      re.push((await B(141), await check('B141', 43)));
      log('sync: realign with arrows', re.join(' '), '| anchor', await js(`JSON.stringify({ b0: ${V}.sync.b0, f0: Math.floor(${V}.sync.t0 * 24) })`));

      // Blender 재생: 24fps 로 2초 동안 프레임을 보낸다 → 영상도 재생, 끝에서 어긋남 확인 → 멈추면 정확히
      const drift = await js(`(async () => {
        const t0 = performance.now();
        for (let i = 1; i <= 48; i++) {
          onBlenderState({ frame: 141 + i, fps: 24, playing: true });
          await new Promise((r) => setTimeout(r, t0 + (i * 1000) / 24 - performance.now()));
        }
        const it = ${V};
        return JSON.stringify({ playing: !it.media.paused, shownFrame: currentFrame(it), expected: 43 + 48 });
      })()`);
      log('sync: during playback', drift);
      log('sync: after stop', (await B(189), await check('B189 stop', 91)));

      // A-B 반복 구간 안에서 돈다 (1.0~2.0초 = 24~47프레임)
      await js(`addSegment(${V}, 1, 2)`);
      const n = await js(`(onBlenderState({ frame: 400, fps: 24, playing: false }), new Promise(r => setTimeout(() => r(currentFrame(${V})), 300)))`);
      log('sync: wraps inside A-B', n, n >= 24 && n < 48 ? 'ok' : 'OUT OF RANGE');
      await js(`(() => { const it = ${V}; it.a = it.b = null; RB.removeItem(it); })()`);

      // GIF: 시각 기준 (vardelay: 프레임 시작 0,50,150,300,500ms…) → Blender 12프레임@24fps = 0.5초 = 5번째 프레임
      await js(`(async () => { window.__sg = await RB.addItem({ kind: 'gif', ref: { sourceId: RB.app.sourceId, path: 'thumbtest/vardelay.gif' }, name: 'vardelay.gif', x: 14000, y: 0, paused: true }); })()`);
      await wait(1500);
      await js(`goToItem(window.__sg)`); // 화면 밖의 항목은 맞추지 않는다 (보일 때 맞춤 - media.js)
      await wait(600);
      await B(500);
      await js(`(() => { const g = window.__sg; g.media.currentTime = 0; toggleSync(g); })()`);
      await B(512);
      await wait(200);
      log('sync: gif B512 → frame', (await js(`window.__sg.media.frameIndex`)) + 1, '(기대 5)', '| badge', await js(`window.__sg.el.classList.contains('has-view')`));
      await js(`RB.removeItem(window.__sg)`);
    }

    // ---- 패널 미리 보기 (꾹 누르기 · 마우스 올려 두기) / 어니언 스킨 / 멈춘 보드의 갱신 횟수 ----
    {
      const send = (ev) => win.webContents.sendInputEvent(ev);
      await js('RB.openFolder("")');
      await wait(1500);
      const c = JSON.parse(await js(`(() => { const c = document.querySelector('#grid .card.video'); if (!c) return 'null'; const r = c.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 3, name: c._entry.name }); })()`));
      if (c) {
        const peekState = () => js(`JSON.stringify({ shown: !$('.peek').hidden, name: $('.peek .nm')?.textContent || '', t: +($('.peek video')?.currentTime || 0).toFixed(1) })`);
        send({ type: 'mouseMove', x: c.x, y: c.y });
        send({ type: 'mouseDown', x: c.x, y: c.y, button: 'left', clickCount: 1 });
        await wait(1500);
        log('peek: hold 1.5s', await peekState());
        send({ type: 'mouseUp', x: c.x, y: c.y, button: 'left', clickCount: 1 });
        await wait(200);
        log('peek: released', await peekState());
        // 마우스를 올려 두면 예고편 8장면
        send({ type: 'mouseMove', x: c.x + 2, y: c.y });
        let shots = '0';
        for (let i = 0; i < 60 && shots !== '8'; i++) {
          await wait(250);
          shots = await js(`String(document.querySelectorAll('.card .trailer .tbar i.ok').length)`);
        }
        log('trailer: shots', shots);
        send({ type: 'mouseMove', x: 900, y: 500 });
        await wait(200);
        log('trailer: gone after leaving', await js(`!document.querySelector('.card .trailer')`));
      }
      // 어니언 스킨: 영상 / GIF. 겹쳐 그린 점 수 (0 이면 실패)
      const ghost = (it) => js(`(() => { const cv = (${it}).onionCv; if (!cv) return 'no canvas'; const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++; return JSON.stringify({ hidden: cv.hidden, size: cv.width + 'x' + cv.height, ghostPx: n, gpu: !!onionGlState }); })()`);
      const V = `([...RB.app.items.values()].find(i => i.name === '점프 01.mp4') || [...RB.app.items.values()].find(i => i.kind === 'video'))`;
      await js(`(() => { const it = ${V}; it.media.pause(); seekFrame(it, 30); goToItem(it); return 1; })()`);
      await wait(1500);
      await js(`toggleOnion(${V}); 1`);
      await wait(1500);
      log('onion: video', await ghost(V));
      await js(`toggleOnion(${V}); 1`);
      // (자르기 점검에서 보드를 다시 불러와 항목이 새로 만들어졌다: 보드에서 찾는다)
      const GIF = `[...RB.app.items.values()].find(i => i.kind === 'gif')`;
      if (!(await js(`!!${GIF}`))) log('onion: gif skipped (no gif on board)');
      else {
        await js(`(() => { const g = ${GIF}; g.media.pause(); g.media.stepFrame(1); goToItem(g); setOnion(g, 2); return 1; })()`);
        await wait(1200);
        log('onion: gif', await ghost(GIF));
        await js(`setOnion(${GIF}, 0); 1`);
      }
      // 모두 멈춘 보드: 1초에 4번만 갱신 (재생 중이면 매 화면)
      await js(`(() => { for (const it of RB.app.items.values()) if (it.media?.pause) { it.autoPaused = false; it.media.pause(); } return 1; })()`);
      await wait(800);
      log('idle board: ticks in 1s', await js(`new Promise((r) => { let n = 0; const o = tick; tick = function () { n++; return o(); }; setTimeout(() => { tick = o; r(n); }, 1000); })`));
    }

    // 저장 → 전부 닫기 → 다시 불러오기
    const json = await js('RB.serialize()');
    const boardFile = path.join(out, 'test.refboard');
    fs.writeFileSync(boardFile, JSON.stringify(json));
    await js(`[...RB.app.items.values()].forEach(RB.removeItem)`);
    await wait(500);
    log('after close', await js('RB.app.items.size'));
    await shot('5-closed');
    await js(`RB.loadBoard(${JSON.stringify(json)}, ${JSON.stringify(boardFile)})`);
    await wait(3000);
    log('after reload', await js(`JSON.stringify({ n: RB.app.items.size, first: (() => { const it=[...RB.app.items.values()].find(i=>i.a!=null); return it && { a: it.a, b: it.b, rate: it.rate }; })(), allMuted: [...RB.app.items.values()].filter(i => i.kind === 'video').every(i => i.muted && i.media.muted), marks: document.querySelectorAll('#grid .card.on-board').length, gif: (() => { const g = [...RB.app.items.values()].find(i => i.kind === 'gif'); return g && { kind: g.kind, rate: g.rate, frames: g.media.frameCount, frame: g.media.frameIndex + 1, bar: !!g.ctlEl.isConnected }; })() })`));
    await shot('6-reloaded');

    // 그리기: 실제 마우스/키보드 입력으로 펜 → 화살표 → 원 → 되돌리기/다시 → 지우개
    win.focus();
    win.webContents.focus();
    const send = (ev) => win.webContents.sendInputEvent(ev);
    const key = async (keyCode, modifiers = []) => {
      send({ type: 'keyDown', keyCode, modifiers });
      send({ type: 'keyUp', keyCode, modifiers });
      await wait(120);
    };
    const drag = async (pts) => {
      const [x0, y0] = pts[0];
      send({ type: 'mouseMove', x: x0, y: y0 });
      send({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1 });
      for (const [x, y] of pts.slice(1)) {
        send({ type: 'mouseMove', x, y, button: 'left', modifiers: ['leftButtonDown'] });
        await wait(16);
      }
      const [x1, y1] = pts[pts.length - 1];
      send({ type: 'mouseUp', x: x1, y: y1, button: 'left', clickCount: 1 });
      await wait(150);
    };
    await key('D');
    await js(`goToItem(([...RB.app.items.values()].find(i => i.name === 'hevc_test.mp4') || [...RB.app.items.values()].find(i => i.kind === 'video'))); RB.select(null, false);`);
    await wait(700);
    const r = JSON.parse(await js(`(() => { const it = ([...RB.app.items.values()].find(i => i.name === 'hevc_test.mp4') || [...RB.app.items.values()].find(i => i.kind === 'video'));
      const b = it.el.getBoundingClientRect(); return JSON.stringify({ x: b.left, y: b.top, w: b.width, h: b.height }); })()`));
    const P = (fx, fy) => [Math.round(r.x + r.w * fx), Math.round(r.y + r.h * fy)];
    const shapesOf = () => js(`([...RB.app.items.values()].find(i => i.name === 'hevc_test.mp4') || [...RB.app.items.values()].find(i => i.kind === 'video')).shapes.map(s => s.t).join(',')`);
    log('draw: mode after D', await js('RB.app.draw.on + " " + RB.app.draw.tool'));
    await drag(Array.from({ length: 12 }, (_, i) => P(0.15 + i * 0.03, 0.3 + Math.sin(i / 2) * 0.1))); // 펜
    log('draw: after pen', await shapesOf(), await js(`(() => { const b = ([...RB.app.items.values()].find(i => i.name === 'hevc_test.mp4') || [...RB.app.items.values()].find(i => i.kind === 'video')).el.getBoundingClientRect(); return b.left + ',' + b.top; })()`), JSON.stringify(r));
    await key('A');
    await drag([P(0.55, 0.75), P(0.65, 0.6), P(0.8, 0.4)]); // 화살표
    log('draw: after arrow', await shapesOf(), await js('RB.app.draw.tool'));
    await key('O');
    log('draw: tool after O', await js('RB.app.draw.tool'));
    await drag([P(0.6, 0.15), P(0.7, 0.3), P(0.9, 0.45)]); // 원
    log('draw: after 3 strokes', await shapesOf());
    await key('Z', ['control']);
    log('draw: after Ctrl+Z', await shapesOf());
    await key('Y', ['control']);
    log('draw: after Ctrl+Y', await shapesOf());
    await shot('8-drawn');
    await key('E');
    await drag([P(0.27, 0.1), P(0.27, 0.5), P(0.27, 0.7)]); // 펜 선을 가로질러 지우기
    log('draw: after eraser', await shapesOf());
    // 영상 크기를 바꿔도 그림이 따라오는지 + 저장/복원
    await js(`(() => { const it = ([...RB.app.items.values()].find(i => i.name === 'hevc_test.mp4') || [...RB.app.items.values()].find(i => i.kind === 'video')); it.w *= 0.6; it.h *= 0.6; RB.fitView(); })()`);
    const drawn = await js('RB.serialize()');
    await js(`RB.loadBoard(${JSON.stringify(drawn)}, null)`);
    await wait(2500);
    log('draw: after reload', await shapesOf());
    await key('Escape');
    log('draw: mode after Esc', await js('RB.app.draw.on'));
    // 프레임별 그림: 그 프레임에서만 보이고, 배경을 숨겨도 그림은 보인다
    {
      const FV = `([...RB.app.items.values()].find(i => i.kind === 'video'))`;
      const shown = () => js(`[...(${FV}).svg.children].filter((n) => !n.classList.contains('ghost') && n.getAttribute('stroke') === '#ff00aa').length`);
      await js(`(() => { const it = ${FV}; it.media.pause(); seekFrame(it, 10); return 1; })()`);
      await wait(900);
      await js(`(() => { const it = ${FV}; it.shapes.push({ t: 'pen', c: '#ff00aa', w: 0.01, p: [[0.1, 0.1], [0.3, 0.2]], f: 10 }); renderShapes(it); setBackground(it, 'hidden'); return 1; })()`);
      const at10 = await shown();
      await js(`seekFrame(${FV}, 11)`);
      await wait(900);
      log('frame draw: shown at f10', at10, '| at f11', await shown(), '| video hidden', await js(`(${FV}).vis.style.opacity === '0'`));
      await js(`(() => { const it = ${FV}; it.shapes = it.shapes.filter((s) => s.c !== '#ff00aa'); setBackground(it, 'normal'); renderShapes(it); return 1; })()`);
    }
    await shot('9-drawn-reloaded');

    await js(`rb.setSetting('opacity', 0.6); rb.setSetting('alwaysOnTop', true)`);
    await wait(300);
    log('window', JSON.stringify({ opacity: win.getOpacity(), onTop: win.isAlwaysOnTop() }));
    await js(`rb.setSetting('opacity', 1); rb.setSetting('alwaysOnTop', false)`);
    await js('RB.openSettings()');
    await wait(300);
    await shot('7-settings');
    log('done', out);
  } catch (e) {
    log('FAILED', e.stack || e);
  }
  jsonfile.flushAll();
  app.exit(0);
}

module.exports = { run };
