const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const sources = require('./sources');
const proxy = require('./proxy');
const thumbs = require('./thumbs');
const probe = require('./probe');
const clips = require('./clips');
const blender = require('./blender');
const addonInstall = require('./addoninstall');
const i18n = require('./i18n');

const SELFTEST = process.argv.includes('--selftest');
if (SELFTEST) {
  app.setPath('userData', path.join(app.getPath('temp'), 'refboard-selftest'));
  // 테스트 창이 다른 창에 가려져도 렌더링/애니메이션이 멈추지 않게
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
} else {
  useUserData();
}

// 설정 / 캐시 폴더: %APPDATA%\MoRef. 이름을 바꾸기 전(RefBoard)의 폴더가 있으면 그대로 옮겨 쓴다.
// 옮기지 못하면(파일이 잡혀 있는 등) 예전 폴더를 계속 쓴다 (Blender 애드온도 두 곳을 모두 찾는다)
function useUserData() {
  const dir = path.join(app.getPath('appData'), 'MoRef');
  const old = path.join(app.getPath('appData'), 'RefBoard');
  let use = dir;
  if (!fs.existsSync(dir) && fs.existsSync(old)) {
    try {
      fs.renameSync(old, dir);
    } catch {
      use = old;
    }
  }
  app.setPath('userData', use);
}

let win;
const lastBoardPath = () => path.join(app.getPath('userData'), 'last-board.refboard');

function createWindow() {
  const { settings } = sources.loadConfig();
  const b = settings.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1280,
    height: b.height || 800,
    x: b.x,
    y: b.y,
    minWidth: 320,
    minHeight: 200,
    frame: false,
    backgroundColor: '#1b1b1d',
    alwaysOnTop: !!settings.alwaysOnTop,
    title: 'MoRef',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.setOpacity(settings.opacity || 1);
  i18n.setLang(i18n.resolveLang(settings));
  loadUi();
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('close', () => setSetting('bounds', win.getNormalBounds()));
  win.on('maximize', () => win.webContents.send('win:state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('win:state', { maximized: false }));
  if (SELFTEST) win.webContents.once('did-finish-load', () => require('./selftest').run(win));
  blender.listen(win, { publish: !SELFTEST || !!process.env.RB_TEST_LINK });
}

// 화면 언어는 주소(?lang=)로 넘긴다: 화면 코드가 실행되기 전에 정해진다 (renderer/i18n.js)
function loadUi() {
  const query = { lang: i18n.getLang() };
  if (process.env.RB_I18N_DUMP) query.i18nDump = '1';
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query });
}

function setSetting(key, value) {
  const cfg = sources.loadConfig(true);
  cfg.settings[key] = value;
  sources.saveConfig();
}

function registerIpc() {
  ipcMain.handle('app:init', () => {
    const cfg = sources.loadConfig();
    return {
      proxyBase: proxy.getBase(),
      sources: cfg.sources.map(sources.publicSource),
      settings: cfg.settings,
      debugSync: !!process.env.RB_DEBUG_SYNC,
      language: i18n.getLang(),
    };
  });

  ipcMain.handle('source:save', (_e, input) => sources.upsertSource(input));
  ipcMain.handle('source:delete', (_e, id) => sources.deleteSource(id));
  ipcMain.handle('source:test', (_e, input) => sources.testSource(input));
  // 폴더 목록은 디스크에도 저장해 두고, 다음에 열 때 먼저 보여 준 뒤 새로 받아 온다
  const listingFile = (id, rel) =>
    path.join(app.getPath('userData'), 'listings', crypto.createHash('sha1').update(`${id}|${rel}`).digest('hex') + '.json');
  ipcMain.handle('source:list', async (_e, id, rel) => {
    try {
      const entries = await sources.list(id, rel);
      const f = listingFile(id, rel);
      fs.promises.mkdir(path.dirname(f), { recursive: true }).then(() => fs.promises.writeFile(f, JSON.stringify(entries))).catch(() => {});
      return { entries };
    } catch (e) {
      return { error: e.code ? `${e.code} ${e.message}` : e.message };
    }
  });
  ipcMain.handle('source:listCached', async (_e, id, rel) => {
    try {
      return JSON.parse(await fs.promises.readFile(listingFile(id, rel), 'utf8'));
    } catch {
      return null;
    }
  });
  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('thumb:get', async (_e, entry, pri) => {
    const r = await thumbs.get(entry, pri === 'low' ? 'low' : 'high');
    return r.file ? { url: require('url').pathToFileURL(r.file).toString() } : r;
  });
  ipcMain.on('thumb:drop', (_e, entry) => thumbs.drop(entry));
  ipcMain.on('thumb:cancel', () => thumbs.cancelQueued());
  ipcMain.handle('thumb:clear', () => thumbs.clearCache());

  ipcMain.handle('file:url', (_e, abs) => proxy.fileUrl(abs));
  ipcMain.handle('media:probe', (_e, ref) => probe.probe(ref));
  ipcMain.handle('clips:get', (_e, key) => clips.get(key));
  ipcMain.handle('clips:set', (_e, key, segs, meta) => clips.set(key, segs, meta));
  ipcMain.handle('clips:update', (_e, key, id, patch) => clips.update(key, id, patch));
  ipcMain.handle('clips:library', () => clips.library());
  ipcMain.handle('clips:folders', () => clips.getFolders());
  ipcMain.handle('clips:setFolders', (_e, list) => clips.setFolders(list));
  ipcMain.handle('clips:clearFolders', (_e, ids) => clips.clearFolders(ids));
  ipcMain.handle('clips:keys', () => clips.keys());
  ipcMain.handle('clips:all', () => clips.all());
  ipcMain.handle('addon:status', () => addonInstall.status());
  ipcMain.handle('addon:install', async () => ({ results: addonInstall.install(), running: await addonInstall.blenderRunning() }));
  ipcMain.on('debug:log', (_e, msg) => process.env.RB_DEBUG_SYNC && process.stdout.write(`RB_DBG ${msg}
`));

  ipcMain.handle('settings:set', (_e, key, value) => {
    setSetting(key, value);
    if (key === 'alwaysOnTop') win.setAlwaysOnTop(!!value, 'floating');
    if (key === 'opacity') win.setOpacity(Math.min(1, Math.max(0.15, value)));
  });

  ipcMain.on('win:minimize', () => win.minimize());
  ipcMain.on('win:toggleMaximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  ipcMain.on('win:close', () => win.close());
  // 언어 바꾸기: 저장하고 화면을 새 언어로 다시 연다 (보드는 화면이 미리 자동 저장한다)
  ipcMain.handle('app:setLanguage', (_e, lang) => {
    if (!i18n.LANGS.includes(lang)) return;
    setSetting('language', lang);
    i18n.setLang(lang);
    loadUi();
  });
  ipcMain.on('app:relaunch', () => {
    app.relaunch({ args: process.argv.slice(1) });
    app.exit(0);
  });

  // ---- 보드 파일 ----
  const filters = [{ name: i18n.tr('MoRef 보드'), extensions: ['moref', 'refboard'] }]; // .refboard: 이름을 바꾸기 전에 저장한 보드

  ipcMain.handle('board:save', async (_e, json, filePath) => {
    if (!filePath) {
      const r = await dialog.showSaveDialog(win, { filters, defaultPath: 'board.moref' });
      if (r.canceled) return null;
      filePath = r.filePath;
    }
    fs.writeFileSync(filePath, JSON.stringify(json, null, 1));
    setSetting('lastBoardFile', filePath);
    return filePath;
  });
  ipcMain.handle('board:open', async () => {
    const r = await dialog.showOpenDialog(win, { filters, properties: ['openFile'] });
    if (r.canceled) return null;
    const filePath = r.filePaths[0];
    setSetting('lastBoardFile', filePath);
    return { filePath, json: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
  });
  ipcMain.handle('board:autosave', (_e, json, filePath, dirty) => {
    fs.writeFileSync(lastBoardPath(), JSON.stringify({ filePath, json, dirty: !!dirty }));
  });
  ipcMain.handle('board:restore', () => {
    try {
      return JSON.parse(fs.readFileSync(lastBoardPath(), 'utf8'));
    } catch {
      return null;
    }
  });
}

// 작업 표시줄에서 electron.exe 가 아니라 MoRef 로 묶이게
app.setAppUserModelId('MoRef');

// 하나만 띄운다: 이미 켜져 있으면 (바로 가기 / Blender 의 MoRef 열기) 그 창을 앞으로 가져오고 끝낸다
const firstInstance = SELFTEST || app.requestSingleInstanceLock();
if (!firstInstance) app.quit();
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

if (firstInstance) app.whenReady().then(async () => {
  if (SELFTEST) {
    for (const f of ['config.json', 'last-board.refboard', 'blender-clips', 'thumbs', 'listings', 'probe-cache.json', 'clips.json', 'range-folders.json']) {
      fs.rmSync(path.join(app.getPath('userData'), f), { recursive: true, force: true });
    }
    sources.upsertSource({
      name: '테스트 NAS',
      type: process.env.RB_TEST_TYPE || 'dav',
      url: process.env.RB_TEST_URL,
      username: process.env.RB_TEST_USER,
      password: process.env.RB_TEST_PASS,
    });
  }
  await proxy.start();
  thumbs.init();
  registerIpc();
  createWindow();
  // 새 버전 알림은 소스 폴더에서 실행할 때만 (설치판은 코드가 바뀌지 않는다)
  if ((!SELFTEST && !app.isPackaged) || process.env.RB_WATCH) watchForUpdates();
  if (!SELFTEST) rememberAppPath();
  if (!SELFTEST || process.env.RB_ADDON_TEST) win.webContents.once('did-finish-load', checkBlenderAddon);
});

// Blender 애드온이 MoRef 를 켤 수 있게, 실행 파일 위치를 적어 둔다 (설치판 / 소스 폴더 모두)
function rememberAppPath() {
  const info = { exe: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] };
  fs.promises.writeFile(path.join(app.getPath('userData'), 'app-path.json'), JSON.stringify(info)).catch(() => {});
}

// Blender 애드온: 오래된 것은 조용히 바꾸고, 설치 안 된 Blender 가 있으면 한 번 묻는다 (renderer 의 안내 막대)
function checkBlenderAddon() {
  try {
    const updated = addonInstall.updateOutdated().filter((r) => r.ok);
    if (updated.length) win.webContents.send('addon:updated', updated.map((r) => r.version));
    const st = addonInstall.status();
    const missing = st.blenders.filter((b) => !b.installed).map((b) => b.version);
    if (missing.length && sources.loadConfig().settings.addonPrompt !== 'never') win.webContents.send('addon:offer', missing);
  } catch (e) {
    console.error('Blender 애드온 확인 실패', e);
  }
}

// ---- 새 버전 알림 ----
// src 폴더의 코드가 바뀌면 창에 알린다.
//  renderer: 화면 파일(renderer/, preload.js) → 창만 다시 불러오면 된다
//  main:     메인 프로세스 파일 → 앱을 다시 시작해야 한다
function watchForUpdates() {
  const dir = __dirname;
  const pending = new Set();
  let timer = null;
  const norm = (rel) => rel.split(path.sep).join('/');
  const kindOf = (rel) => {
    rel = norm(rel);
    if (!/\.(js|css|html)$/.test(rel) || rel === 'selftest.js') return null;
    return rel.startsWith('renderer/') || rel === 'preload.js' ? 'renderer' : 'main';
  };
  try {
    fs.watch(dir, { recursive: true }, (_ev, rel) => {
      if (!rel || !kindOf(rel)) return;
      pending.add(norm(rel));
      clearTimeout(timer);
      timer = setTimeout(() => {
        const files = [...pending];
        pending.clear();
        const kind = files.some((f) => kindOf(f) === 'main') ? 'main' : 'renderer';
        if (win && !win.isDestroyed()) win.webContents.send('app:update', { kind, files });
      }, 600); // 저장이 여러 번 연달아 일어나도 한 번만
    });
  } catch (e) {
    console.warn('코드 변경 감시를 시작하지 못함', e.message);
  }
}

app.on('window-all-closed', () => app.quit());
