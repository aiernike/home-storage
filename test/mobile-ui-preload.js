'use strict';

/**
 * 手机界面验证 · 原生桥替身（preload）
 * ---------------------------------------------------------------------------
 * 真机上 MainActivity 用 addJavascriptInterface 把 HSAndroid 注入页面，
 * 页面从第一行代码起就能看到它。这里用 preload + contextBridge 复刻同样的
 * 时序和契约，否则 test-mobile-ui 里那条「识别为安卓端」只是在核对
 * 03-bootstrap.js 里写死的字符串，测不出「页面真的按原生桥判断环境」。
 *
 * 两条分支各有归属：
 *   · 有原生桥 → platform:'android'   —— 本文件 + test-mobile-ui.js [MUI-1]
 *   · 无原生桥 → platform:'web'       —— test-mobile.js（native:false 的沙箱）
 * 少任何一条，改坏 appInfo() 都可能全绿。
 *
 * 不单独运行，由 test/mobile-ui-main.js 通过 webPreferences.preload 加载。
 */

const { contextBridge, webFrame } = require('electron');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 把响应打回页面。
 *
 * 必须借 webFrame 发进去：preload 跑在隔离世界里，
 * 页面挂在主世界的 window.__HS_HTTP_DONE 在这里根本看不见。
 */
function done(id, res) {
  const code =
    'window.__HS_HTTP_DONE && window.__HS_HTTP_DONE(' +
    JSON.stringify(id) +
    ',' +
    JSON.stringify(res) +
    ')';
  try {
    webFrame.executeJavaScript(code);
  } catch (e) {
    /* 页面已经卸载，丢掉即可 */
  }
}

/**
 * 契约与 MainActivity.Bridge.http 一致：
 * 页面传 id，原生完成后回调 window.__HS_HTTP_DONE(id, { ok, status, body })。
 */
function httpRequest(id, method, url, headersJson, body, timeout) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return done(id, { ok: false, error: '地址格式不正确' });
  }

  const lib = u.protocol === 'https:' ? https : http;
  const headers = JSON.parse(headersJson || '{}');
  // 真机的 HttpURLConnection 自己算 Content-Length，先删掉避免重复
  delete headers['Content-Length'];
  delete headers['content-length'];

  const req = lib.request(
    {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers,
      timeout: timeout || 15000
    },
    (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => done(id, { ok: true, status: res.statusCode, body: text }));
    }
  );
  req.on('timeout', () => {
    req.destroy();
    done(id, { ok: false, error: '连接超时' });
  });
  req.on('error', (e) => done(id, { ok: false, error: String((e && e.message) || e) }));
  if (body) req.write(body);
  req.end();
}

contextBridge.exposeInMainWorld('HSAndroid', {
  http: httpRequest,

  /** 导出文件：真机写「下载」目录，这里写系统临时目录，返回路径即可 */
  saveFile(name, content) {
    try {
      const file = path.join(os.tmpdir(), 'hs-mui-' + name);
      fs.writeFileSync(file, String(content == null ? '' : content));
      return file;
    } catch (e) {
      return null;
    }
  },

  notify() {},

  /** 桌面/模拟环境没有 NFC，跟真机「设备不支持」的表现一致 */
  nfcSupported() {
    return false;
  }
});
