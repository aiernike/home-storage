'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  call: (action, payload) => ipcRenderer.invoke('db:call', action, payload),
  exportFile: (opts) => ipcRenderer.invoke('dialog:export', opts),
  importFile: () => ipcRenderer.invoke('dialog:import'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  notify: (opts) => ipcRenderer.invoke('notify', opts),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  // 联网查图书信息。走主进程是因为渲染层不碰网络：
  // 桌面端渲染进程是 file:// 源，直接 fetch 外部 https 会被 CORS/CSP 拦。
  // 失败一律返回 { ok:false, reason }，绝不抛 —— 这是可选增强，断网必须能用。
  lookupIsbn: (isbn) => ipcRenderer.invoke('isbn:lookup', { isbn }),
  sync: {
    test: (url) => ipcRenderer.invoke('sync:test', { url }),
    login: (opts) => ipcRenderer.invoke('sync:login', opts),
    register: (opts) => ipcRenderer.invoke('sync:register', opts),
    run: () => ipcRenderer.invoke('sync:run')
  }
});
