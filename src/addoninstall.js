// Blender 애드온 설치 / 업데이트
//
// 애드온은 RefBoard 안에 함께 들어 있다 (설치판: resources/blender-addon, 소스: blender/).
//  * 찾기: %APPDATA%\Blender Foundation\Blender\<버전> (써 본 Blender) + Program Files 의 Blender <버전> (설치된 Blender)
//    중 애드온이 지원하는 버전(4.2 이상).
//  * 설치: <설정>\scripts\addons\refboard_dock 에 복사한다.
//  * 켜기: Blender 가 켜져 있으면 설정을 직접 바꿀 수 없어서(끌 때 덮어씀), 시작 스크립트를 하나 넣어 둔다.
//    다음에 Blender 를 켤 때 애드온을 켜고 설정을 저장한 뒤 스스로 지워진다.
//  * 업데이트: 이미 설치된 애드온이 더 오래됐으면 RefBoard 를 켤 때 자동으로 바꾼다.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MODULE = 'refboard_dock';
const MIN_VERSION = [4, 2];
const ENABLER = 'refboard_enable_addon.py';

const sourceDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'blender-addon', MODULE) : path.join(__dirname, '..', 'blender', MODULE));
const configRoot = () => process.env.RB_BLENDER_CONFIG || path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'), 'Blender Foundation', 'Blender');

const verKey = (v) => v.split('.').map(Number);
const verOk = (v) => {
  const [a, b] = verKey(v);
  return a > MIN_VERSION[0] || (a === MIN_VERSION[0] && b >= MIN_VERSION[1]);
};
const cmp = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  return 0;
};

// bl_info 의 "version": (0, 3, 0)
function addonVersion(file) {
  try {
    const m = /"version"\s*:\s*\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)\)/.exec(fs.readFileSync(file, 'utf8'));
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch {
    return null;
  }
}

const bundledVersion = () => addonVersion(path.join(sourceDir(), '__init__.py'));

// 이 PC 의 Blender 버전들 (예: ['4.2', '5.2'])
function blenderVersions() {
  const found = new Set();
  const isVer = (n) => /^\d+\.\d+$/.test(n);
  try {
    for (const n of fs.readdirSync(configRoot())) if (isVer(n)) found.add(n);
  } catch {}
  const bases = process.env.RB_BLENDER_CONFIG ? [] : [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]; // 점검할 때는 설정 폴더만
  for (const base of bases.filter(Boolean)) {
    try {
      for (const n of fs.readdirSync(path.join(base, 'Blender Foundation'))) {
        const m = /^Blender (\d+\.\d+)$/.exec(n);
        if (m) found.add(m[1]);
      }
    } catch {}
  }
  return [...found].filter(verOk).sort((a, b) => cmp(verKey(a), verKey(b)));
}

const addonDir = (ver) => path.join(configRoot(), ver, 'scripts', 'addons', MODULE);

// [{ version, installed: [0,3,0] | null }]
function status() {
  const bundled = bundledVersion();
  return {
    bundled,
    blenders: blenderVersions().map((v) => {
      const installed = addonVersion(path.join(addonDir(v), '__init__.py'));
      return { version: v, installed, outdated: !!(installed && bundled && cmp(installed, bundled) < 0) };
    }),
  };
}

// 다음에 Blender 를 켤 때 애드온을 켜고 지워지는 시작 스크립트
const ENABLER_SOURCE = `# RefBoard 가 넣은 일회용 스크립트: "RefBoard 연결" 애드온을 켜고 설정을 저장한 뒤 스스로 지운다
import os

import bpy


def _enable():
    try:
        import addon_utils

        addon_utils.enable("${MODULE}", default_set=True, persistent=True)
        bpy.ops.wm.save_userpref()
        print("RefBoard: '${MODULE}' 애드온을 켰습니다")
    except Exception as e:
        print("RefBoard: 애드온을 켜지 못했습니다", e)
    try:
        os.remove(__file__)
    except OSError:
        pass
    return None


# 시작 스크립트는 Blender 가 저장된 설정을 읽기 전에 실행된다. 여기서 켜면 설정을 읽으며 덮어써지므로,
# 처음 파일을 연 뒤(load_post: 설정을 다 읽은 뒤)에 켠다
@bpy.app.handlers.persistent
def _on_load(*_args):
    if _on_load in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.remove(_on_load)
    _enable()


def register():
    bpy.app.handlers.load_post.append(_on_load)


def unregister():
    pass
`;

// 버전마다: 애드온 복사 (+ 켜기 스크립트). 결과: [{ version, ok, error? }]
function install(versions = blenderVersions(), { enable = true } = {}) {
  const src = sourceDir();
  const results = [];
  for (const v of versions) {
    try {
      const dst = addonDir(v);
      fs.mkdirSync(dst, { recursive: true });
      fs.copyFileSync(path.join(src, '__init__.py'), path.join(dst, '__init__.py'));
      fs.rmSync(path.join(dst, '__pycache__'), { recursive: true, force: true }); // 예전 버전의 컴파일 결과
      if (enable) {
        const startup = path.join(configRoot(), v, 'scripts', 'startup');
        fs.mkdirSync(startup, { recursive: true });
        fs.writeFileSync(path.join(startup, ENABLER), ENABLER_SOURCE);
      }
      results.push({ version: v, ok: true });
    } catch (e) {
      results.push({ version: v, ok: false, error: e.message });
    }
  }
  return results;
}

// RefBoard 를 켤 때: 설치돼 있지만 오래된 애드온은 조용히 바꾼다 (켜기 상태는 그대로 — 같은 모듈 이름)
function updateOutdated() {
  const st = status();
  const old = st.blenders.filter((b) => b.outdated).map((b) => b.version);
  return old.length ? install(old, { enable: false }) : [];
}

// Blender 가 지금 켜져 있는지 (켜져 있으면 "다시 켜면 켜집니다" 로 안내)
function blenderRunning() {
  return new Promise((resolve) => {
    require('child_process').execFile('tasklist', ['/FI', 'IMAGENAME eq blender.exe', '/NH'], { windowsHide: true }, (err, out) =>
      resolve(!err && /blender\.exe/i.test(out))
    );
  });
}

module.exports = { status, install, updateOutdated, blenderVersions, blenderRunning };
