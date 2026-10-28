'use strict';
/* global app, rb, $, h, icon, toast */
// Blender 애드온 설치 안내 (src/addoninstall.js)
//  * 처음 실행 때 애드온이 없는 Blender 가 있으면 위쪽 띠로 한 번 묻는다: [설치] [나중에] [다시 묻지 않기]
//  * 설정(⚙)의 "Blender 애드온 설치 / 업데이트" 버튼
//  * RefBoard 를 켤 때 오래된 애드온을 바꿨으면 알려 준다

const fmtVer = (v) => (v ? v.join('.') : '');

function initAddonSetup() {
  const bar = h('div', 'update-bar addon-bar');
  bar.hidden = true;
  document.body.append(bar);

  rb.addon.onOffer((versions) => {
    const ic = h('span', 'ic-wrap');
    ic.innerHTML = icon('link');
    bar.replaceChildren(ic, h('span', 'msg', `Blender ${versions.join(', ')} 에 RefBoard 애드온을 설치할까요? (타임라인 동기화 · 뷰포트에 영상 띄우기)`));
    const btn = (label, cls, fn) => {
      const b = h('button', cls, label);
      b.onclick = fn;
      bar.append(b);
    };
    btn('설치', 'primary', async () => {
      bar.hidden = true;
      await installBlenderAddon();
    });
    btn('나중에', '', () => (bar.hidden = true));
    btn('다시 묻지 않기', '', () => {
      bar.hidden = true;
      rb.setSetting('addonPrompt', 'never');
    });
    bar.hidden = false;
  });

  rb.addon.onUpdated((versions) => toast(`Blender ${versions.join(', ')} 의 RefBoard 애드온을 새 버전으로 바꿨습니다 — Blender 를 다시 켜면 적용됩니다`, 4000));

  $('#btnAddon').onclick = () => installBlenderAddon();
}

async function installBlenderAddon() {
  const { results, running } = await rb.addon.install();
  const ok = results.filter((r) => r.ok).map((r) => r.version);
  const bad = results.filter((r) => !r.ok);
  if (!results.length) toast('이 PC 에서 Blender 4.2 이상을 찾지 못했습니다', 3500);
  else if (ok.length)
    toast(
      `Blender ${ok.join(', ')} 에 애드온을 설치했습니다 — ${running ? 'Blender 를 껐다가 다시 켜면' : '다음에 Blender 를 켜면'} 자동으로 켜집니다`,
      5000
    );
  if (bad.length) toast(`설치하지 못했습니다: ${bad.map((r) => `${r.version} (${r.error})`).join(', ')}`, 5000);
  refreshAddonStatus();
}

// 설정 창의 상태 줄
async function refreshAddonStatus() {
  const el = $('#addonStatus');
  if (!el) return;
  const st = await rb.addon.status();
  if (!st.blenders.length) {
    el.textContent = 'Blender 4.2 이상을 찾지 못했습니다';
    return;
  }
  el.textContent = st.blenders
    .map((b) => `Blender ${b.version}: ${b.installed ? (b.outdated ? `${fmtVer(b.installed)} (새 버전 ${fmtVer(st.bundled)} 있음)` : `설치됨 ${fmtVer(b.installed)}`) : '설치 안 됨'}`)
    .join(' · ');
}
