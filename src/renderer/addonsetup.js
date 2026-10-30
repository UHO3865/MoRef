'use strict';
/* global app, rb, $, h, icon, toast */
// Blender 애드온 설치 안내 (src/addoninstall.js)
//  * 처음 실행 때 애드온이 없는 Blender 가 있으면 위쪽 띠로 한 번 묻는다: [설치] [나중에] [다시 묻지 않기]
//  * 설정(⚙)의 "Blender 애드온 설치 / 업데이트" 버튼
//  * MoRef 를 켤 때 오래된 애드온을 바꿨으면 알려 준다

const fmtVer = (v) => (v ? v.join('.') : '');

function initAddonSetup() {
  const bar = h('div', 'update-bar addon-bar');
  bar.hidden = true;
  document.body.append(bar);

  rb.addon.onOffer((versions) => {
    const ic = h('span', 'ic-wrap');
    ic.innerHTML = icon('link');
    bar.replaceChildren(ic, h('span', 'msg', tr('Blender {0} 에 MoRef 애드온을 설치할까요? (타임라인 동기화 · 뷰포트에 영상 띄우기)', versions.join(', '))));
    const btn = (label, cls, fn) => {
      const b = h('button', cls, label);
      b.onclick = fn;
      bar.append(b);
    };
    btn(tr('설치'), 'primary', async () => {
      bar.hidden = true;
      await installBlenderAddon();
    });
    btn(tr('나중에'), '', () => (bar.hidden = true));
    btn(tr('다시 묻지 않기'), '', () => {
      bar.hidden = true;
      rb.setSetting('addonPrompt', 'never');
    });
    bar.hidden = false;
  });

  rb.addon.onUpdated((versions) => toast(tr('Blender {0} 의 MoRef 애드온을 새 버전으로 바꿨습니다 - Blender 를 다시 켜면 적용됩니다', versions.join(', ')), 4000));

  $('#btnAddon').onclick = () => installBlenderAddon();
  initLanguagePicker();
}

// 언어 바꾸기: 보드를 자동 저장한 뒤 메인 프로세스가 화면을 새 언어로 다시 연다
function initLanguagePicker() {
  const sel = $('#langSelect');
  sel.value = app.settings.languageNow || 'ko';
  sel.onchange = async () => {
    await saveBeforeReload();
    rb.setLanguage(sel.value);
  };
}

async function installBlenderAddon() {
  const { results, running } = await rb.addon.install();
  const ok = results.filter((r) => r.ok).map((r) => r.version);
  const bad = results.filter((r) => !r.ok);
  if (!results.length) toast(tr('이 PC 에서 Blender 4.2 이상을 찾지 못했습니다'), 3500);
  else if (ok.length)
    toast(
      tr('Blender {0} 에 애드온을 설치했습니다 - {1} 자동으로 켜집니다', ok.join(', '), running ? tr('Blender 를 껐다가 다시 켜면') : tr('다음에 Blender 를 켜면')),
      5000
    );
  if (bad.length) toast(tr('설치하지 못했습니다: {0}', bad.map((r) => `${r.version} (${r.error})`).join(', ')), 5000);
  refreshAddonStatus();
}

// 설정 창의 상태 줄
async function refreshAddonStatus() {
  const el = $('#addonStatus');
  if (!el) return;
  const st = await rb.addon.status();
  if (!st.blenders.length) {
    el.textContent = tr('Blender 4.2 이상을 찾지 못했습니다');
    return;
  }
  el.textContent = st.blenders
    .map((b) => `Blender ${b.version}: ${b.installed ? (b.outdated ? tr('{0} (새 버전 {1} 있음)', fmtVer(b.installed), fmtVer(st.bundled)) : tr('설치됨 {0}', fmtVer(b.installed))) : tr('설치 안 됨')}`)
    .join(' · ');
}
