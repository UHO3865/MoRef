// Blender 애드온과의 연결
//
// 데스크톱 RefBoard 가 127.0.0.1 의 빈 포트에서 기다리고, 포트와 일회용 토큰을
// %APPDATA%\refboard\blender-link.json 에 적어 둔다. 애드온은 이 파일을 보고 접속해 첫 줄로 "auth <토큰>" 을 보낸다.
// (어느 쪽을 먼저 켜도 된다. RefBoard 를 끄면 파일을 지운다)
//
// Blender → RefBoard (한 줄씩)
//   hello <파일 이름>                 연결됨 (제목 표시줄에 보여 준다)
//   frame <번호> <fps> <재생중 0|1> <장면 시작>   타임라인
//   focus                             RefBoard 창을 앞으로 (Blender 의 "RefBoard 열기")
//   toast <글>                        RefBoard 에 알림 띄우기
// RefBoard → Blender
//   want play                         Blender 재생 켜기/끄기 (타임라인에 맞춘 레퍼런스에서 Space)
//   range <시작> <끝> | range none     반복 구간 → Blender 미리보기 범위 (프레임)
//   bg <JSON>                         카메라 배경 영상으로 넣기 {path, name, fps, frame, flipX, sync}
//   ref <JSON>                        3D 뷰포트에 레퍼런스 이미지(Empty)로 띄우기 {path, name, key, map, flipX}
//   refmap <JSON>                     띄운 영상의 대응 규칙이 바뀜 {key, map: {b0, t0, a, b, d, rate, fps}}
const { tr } = require('./i18n');
const net = require('net');
const readline = require('readline');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, ipcMain } = require('electron');
const sources = require('./sources');

let win = null;
let sock = null;
let link = null; // { file } - 연결된 Blender 의 정보
let timeline = null;
let ctrl = null; // { port, token }

const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);
const linkFile = () => path.join(app.getPath('userData'), 'blender-link.json');

function toBlender(line) {
  if (sock && !sock.destroyed) sock.write(line.replace(/\n/g, ' ') + '\n');
}

function setLink(next) {
  link = next;
  if (!link) timeline = null;
  send('blender:link', link);
}

function onLine(line) {
  let m;
  if ((m = /^frame (-?\d+) ([\d.]+) ([01])(?: (-?\d+))?$/.exec(line))) {
    timeline = { frame: Number(m[1]), fps: Number(m[2]), playing: m[3] === '1', start: m[4] != null ? Number(m[4]) : 1 };
    if (!link) setLink({ file: '' });
    send('blender:state', timeline);
  } else if (line.startsWith('hello')) {
    setLink({ file: line.slice(6).trim() });
  } else if (line === 'focus') {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else if (line.startsWith('toast ')) {
    send('blender:toast', line.slice(6));
  }
}

function listen(w, { publish = true } = {}) {
  win = w;
  const token = crypto.randomBytes(16).toString('hex');
  const server = net.createServer((s) => {
    let authed = false;
    s.on('error', () => {});
    s.on('close', () => {
      if (sock !== s) return;
      sock = null;
      setLink(null);
    });
    readline.createInterface({ input: s }).on('line', (line) => {
      line = line.trim();
      if (!authed) {
        authed = line === `auth ${token}`;
        if (!authed) return s.destroy();
        if (sock) sock.destroy(); // Blender 를 다시 켰으면 새 연결로 바꾼다
        sock = s;
        return; // 연결됨은 바로 이어 오는 hello 로 알린다 (파일 이름과 함께)
      }
      onLine(line);
    });
  });
  server.listen(0, '127.0.0.1', () => {
    ctrl = { port: server.address().port, token };
    if (publish) {
      fs.writeFileSync(linkFile(), JSON.stringify({ port: ctrl.port, token, pid: process.pid }));
      app.on('will-quit', () => {
        try {
          const cur = JSON.parse(fs.readFileSync(linkFile(), 'utf8'));
          if (cur.pid === process.pid) fs.unlinkSync(linkFile()); // 다른 RefBoard 가 덮어쓴 것은 두기
        } catch {}
      });
    }
  });
  // 창을 새로 그리거나(새로 고침) 늦게 열렸을 때 마지막 상태를 다시 보낸다
  win.webContents.on('did-finish-load', () => {
    send('blender:link', link);
    if (timeline) send('blender:state', timeline);
  });

  ipcMain.on('blender:want', (_e, what) => what === 'play' && toBlender('want play'));
  ipcMain.on('blender:range', (_e, r) => /^(none|-?\d+ -?\d+)$/.test(r) && toBlender(`range ${r}`));
  ipcMain.handle('blender:cameraBg', (_e, ref, info) => sendClip('bg', ref, info));
  ipcMain.handle('blender:viewportRef', (_e, ref, info) => sendClip('ref', ref, info));
  ipcMain.on('blender:refmap', (_e, j) => {
    try {
      toBlender('refmap ' + JSON.stringify(JSON.parse(j)));
    } catch {}
  });
}

// ---- 카메라 배경 ----
// Blender 의 무비 클립은 로컬 파일이어야 해서, NAS 영상은 한 번 받아 둔다 (같은 크기면 다시 받지 않음)
const clipDir = () => path.join(app.getPath('userData'), 'blender-clips');

async function localFileFor(ref, onProgress) {
  if (ref.file) return ref.file;
  const src = sources.getSource(ref.sourceId);
  if (!src) throw new Error(tr('소스를 찾을 수 없습니다'));
  if (src.type !== 'dav') return sources.localFullPath(src, ref.path);
  const dir = path.join(clipDir(), crypto.createHash('sha1').update(`${src.id}|${ref.path}`).digest('hex').slice(0, 16));
  const out = path.join(dir, path.basename(ref.path));
  const res = await sources.davRequest(src, 'GET', ref.path);
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(tr('NAS 응답 {0}', res.statusCode));
  }
  const total = Number(res.headers['content-length']) || 0;
  const have = await fs.promises.stat(out).catch(() => null);
  if (have && total && have.size === total) {
    res.destroy();
    return out;
  }
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = out + '.part';
  await new Promise((resolve, reject) => {
    const f = fs.createWriteStream(tmp);
    let got = 0;
    let last = 0;
    res.on('data', (d) => {
      got += d.length;
      const now = Date.now();
      if (total && now - last > 200) {
        last = now;
        onProgress(got / total);
      }
    });
    res.on('error', reject);
    f.on('error', reject);
    f.on('finish', resolve);
    res.pipe(f);
  });
  await fs.promises.rename(tmp, out);
  return out;
}

async function sendClip(kind, ref, info) {
  if (!sock) return { ok: false, error: tr('Blender 와 연결되어 있지 않습니다') };
  try {
    const file = await localFileFor(ref, (p) => send('blender:bgProgress', p));
    toBlender(`${kind} ` + JSON.stringify({ ...info, path: file }));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { listen, ctrlInfo: () => ctrl };
