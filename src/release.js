// 새 버전 알림 (설치판): GitHub 의 최신 릴리스 번호가 지금보다 높으면 화면 위쪽 띠로 알린다
//  * 켤 때 조금 뒤에 한 번, 켜 둔 동안은 12시간마다. 하루에 한 번만 묻는다 (마지막으로 물은 시각을 설정에 둔다)
//  * 설정에서 끌 수 있다 (checkUpdates: false). 보내는 것은 GitHub 공개 API 요청 하나뿐 (계정 · 기기 정보 없음)
//  * 받기는 사용자가 띠의 버튼으로 릴리스 페이지를 열어서 한다 (몰래 받거나 설치하지 않는다)
const { app, net } = require('electron');
const sources = require('./sources');

const REPO = 'UHO3865/MoRef';
const API = process.env.RB_RELEASE_URL || `https://api.github.com/repos/${REPO}/releases/latest`;
const DAY = 24 * 3600 * 1000;

// "v0.5.10" > "0.5.9"
function newer(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

async function check({ force = false } = {}) {
  const cfg = sources.loadConfig(true);
  const st = cfg.settings;
  if (st.checkUpdates === false) return null;
  if (!force && st.updateCheckedAt && Date.now() - st.updateCheckedAt < DAY) return st.updateLatest || null;
  try {
    const res = await net.fetch(API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `MoRef/${app.getVersion()}` } });
    if (!res.ok) return null;
    const j = await res.json();
    if (j.draft || j.prerelease || !j.tag_name) return null;
    const latest = { version: String(j.tag_name).replace(/^v/i, ''), url: String(j.html_url || `https://github.com/${REPO}/releases/latest`) };
    st.updateCheckedAt = Date.now();
    st.updateLatest = latest;
    sources.saveConfig();
    return latest;
  } catch {
    return null; // 오프라인 등: 다음에
  }
}

function start(win, { force = false } = {}) {
  const run = async (opts) => {
    const latest = await check(opts);
    if (latest && newer(latest.version, app.getVersion()) && win && !win.isDestroyed()) {
      win.webContents.send('app:release', { ...latest, current: app.getVersion() });
    }
  };
  setTimeout(() => run({ force }), force ? 1500 : 8000).unref?.();
  setInterval(run, DAY / 2).unref?.();
}

module.exports = { start, check, newer };
