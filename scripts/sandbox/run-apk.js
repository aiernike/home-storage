'use strict';
/* 受限环境专用的 APK 构建运行器：把 build-apk.js 原样跑起来。
 *
 * 为什么需要它：某些受限环境（本项目开发时遇到的沙箱）里
 * spawnSync / execSync / execFileSync 一律返回 EBUSY，只有异步 spawn 可用，
 * 而 build-apk.js 全程用 spawnSync。这里先劫持 spawnSync 再加载它，
 * 于是 build-apk.js 一行都不用改。
 *
 * 用法：node scripts/sandbox/run-apk.js
 *
 * ⚠️ 正常环境**不需要**它 —— 直接 `node mobile/build-apk.js` 即可。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
require('./sync-shim.js').patch();
require(path.join(ROOT, 'mobile', 'build-apk.js'));
