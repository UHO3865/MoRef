'use strict';
/* global app, rb, $, h, icon, serialize, applyCrop */
// 새 버전 알림: 메인 프로세스가 src 폴더의 코드 변경을 알려 주면 위쪽에 띠를 띄운다.
//  화면 코드만 바뀜  → [다시 불러오기]: 보드를 자동 저장하고 창만 새로 고친다 (보드·패널 위치 그대로)
//  핵심 코드가 바뀜  → [다시 시작]: 보드를 자동 저장하고 앱을 다시 시작한다
//  Blender 도킹 중   → 다시 시작하면 애드온과 연결이 끊겨서, 분리 후 다시 붙이도록 안내한다

function initUpdateNotice() {
  const bar = h('div', 'update-bar');
  bar.hidden = true;
  document.body.append(bar);

  rb.update.onChange(({ kind, files }) => {
    // 한 번이라도 핵심 코드가 바뀌었으면 다시 시작해야 한다
    if (app.updateKind === 'main') kind = 'main';
    app.updateKind = kind;
    const btns = [];
    let msg;
    if (kind === 'renderer') {
      msg = '새 버전이 있습니다';
      btns.push(['다시 불러오기', 'primary', reloadKeepingBoard]);
    } else {
      msg = '새 버전이 있습니다 — 다시 시작하면 적용됩니다';
      btns.push(['다시 시작', 'primary', relaunchKeepingBoard]);
    }
    btns.push(['나중에', '', () => (bar.hidden = true)]);

    const ic = h('span', 'ic-wrap');
    ic.innerHTML = icon('refresh');
    bar.replaceChildren(ic, h('span', 'msg', msg));
    for (const [label, cls, fn] of btns) {
      const b = h('button', cls, label);
      b.onclick = fn;
      bar.append(b);
    }
    bar.title = '바뀐 파일:\n' + files.join('\n');
    bar.dataset.kind = kind;
    bar.hidden = false;
  });
}

async function saveBeforeReload() {
  if (app.cropping) applyCrop(app.cropping);
  await rb.board.autosave(serialize(), app.boardFile, app.dirty);
}

async function reloadKeepingBoard() {
  await saveBeforeReload();
  location.reload();
}

async function relaunchKeepingBoard() {
  await saveBeforeReload();
  rb.update.relaunch();
}
