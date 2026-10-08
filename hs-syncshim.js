'use strict';
/* 临时工具（仅本沙箱用）：把异步 spawn 包成 spawnSync 的替身。
 * 原因：本环境 spawnSync/execSync/execFileSync 一律 EBUSY，只有异步 spawn 可用。
 * 用法：require('./hs-syncshim.js').patch(); 然后再 require 目标脚本。
 * 交付物不应依赖它 —— 涛哥本机 spawnSync 正常，直接 node mobile/build-apk.js 即可。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_SRC = `
const { workerData } = require('worker_threads');
const { spawn } = require('child_process');
const fs = require('fs');
const { exe, args, opts, outFile, ctrl } = workerData;
const flag = new Int32Array(ctrl);
let finished = false;
function done(payload) {
  if (finished) return;   // error 与 close 会先后触发，只认第一次，否则主线程读到写了一半的文件
  finished = true;
  fs.writeFileSync(outFile, JSON.stringify(payload));
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
}
let p = null;
try {
  p = spawn(exe, args, {
    cwd: opts.cwd,
    windowsHide: opts.windowsHide !== false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
} catch (e) {
  done({ error: { message: String(e && e.message || e), code: e && e.code } });
}
if (p) {
  let stdout = '', stderr = '';
  p.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
  p.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
  p.on('error', (e) => { done({ error: { message: String(e && e.message || e), code: e && e.code } }); });
  p.on('close', (code) => { done({ status: code, stdout: stdout, stderr: stderr }); });
}
`;

function spawnSyncShim(exe, args, opts = {}) {
  const ctrl = new SharedArrayBuffer(8);
  const flag = new Int32Array(ctrl);
  const outFile = path.join(
    os.tmpdir(),
    'hs-shim-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json'
  );
  const w = new Worker(WORKER_SRC, {
    eval: true,
    workerData: {
      exe: exe,
      args: args || [],
      opts: { cwd: opts.cwd, windowsHide: opts.windowsHide },
      outFile: outFile,
      ctrl: ctrl
    }
  });
  // 阻塞主线程直到 worker 通知（Node 主线程允许 Atomics.wait）
  const r = Atomics.wait(flag, 0, 0, 600000);
  let res;
  if (r === 'timed-out') {
    res = { error: { message: '同步外壳等待超时（600s）' } };
  } else {
    try {
      res = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    } catch (e) {
      res = { error: { message: '同步外壳读结果失败：' + e.message } };
    }
  }
  try { fs.unlinkSync(outFile); } catch (e) {}
  w.terminate();
  return res;
}

/** 劫持 child_process.spawnSync，必须在 require 目标脚本之前调用 */
function patch() {
  const cp = require('child_process');
  cp.spawnSync = spawnSyncShim;
  return cp;
}

module.exports = { spawnSyncShim, patch };
