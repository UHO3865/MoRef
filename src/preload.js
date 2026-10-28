const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('rb', {
  init: invoke('app:init'),
  source: {
    save: invoke('source:save'),
    delete: invoke('source:delete'),
    test: invoke('source:test'),
    list: invoke('source:list'),
    listCached: invoke('source:listCached'),
  },
  pickFolder: invoke('dialog:pickFolder'),
  copyText: invoke('clipboard:write'),
  thumb: {
    get: invoke('thumb:get'),
    drop: (entry) => ipcRenderer.send('thumb:drop', entry),
    cancel: () => ipcRenderer.send('thumb:cancel'),
    clear: invoke('thumb:clear'),
  },
  fileUrl: invoke('file:url'),
  probe: invoke('media:probe'),
  clips: { get: invoke('clips:get'), set: invoke('clips:set'), keys: invoke('clips:keys'), all: invoke('clips:all') },
  debug: (msg) => ipcRenderer.send('debug:log', String(msg)),
  pathForFile: (file) => webUtils.getPathForFile(file),
  setSetting: invoke('settings:set'),
  setLanguage: invoke('app:setLanguage'),
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggleMaximize'),
    close: () => ipcRenderer.send('win:close'),
    onState: (cb) => ipcRenderer.on('win:state', (_e, s) => cb(s)),
  },
  addon: {
    status: invoke('addon:status'),
    install: invoke('addon:install'),
    onOffer: (cb) => ipcRenderer.on('addon:offer', (_e, v) => cb(v)),
    onUpdated: (cb) => ipcRenderer.on('addon:updated', (_e, v) => cb(v)),
  },
  blender: {
    onState: (cb) => ipcRenderer.on('blender:state', (_e, s) => cb(s)),
    onLink: (cb) => ipcRenderer.on('blender:link', (_e, l) => cb(l)),
    onToast: (cb) => ipcRenderer.on('blender:toast', (_e, t) => cb(t)),
    onBgProgress: (cb) => ipcRenderer.on('blender:bgProgress', (_e, p) => cb(p)),
    want: (what) => ipcRenderer.send('blender:want', what),
    range: (r) => ipcRenderer.send('blender:range', r),
    cameraBg: invoke('blender:cameraBg'),
    viewportRef: invoke('blender:viewportRef'),
    refMap: (j) => ipcRenderer.send('blender:refmap', j),
  },
  update: {
    onChange: (cb) => ipcRenderer.on('app:update', (_e, info) => cb(info)),
    relaunch: () => ipcRenderer.send('app:relaunch'),
  },
  board: {
    save: invoke('board:save'),
    open: invoke('board:open'),
    autosave: invoke('board:autosave'),
    restore: invoke('board:restore'),
  },
});
