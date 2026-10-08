#!/usr/bin/env node
'use strict';

/**
 * 家庭收纳 · 安卓端资源打包脚本
 * ---------------------------------------------------------------------------
 * 做三件事：
 *   1. 把桌面端的数据层（store.js / sync.js）与浏览器适配层拼成一个
 *      WebView 里可直接运行的 JS 文件（hs-core.js）；
 *   2. 把渲染层资源（index.html / css / js）复制进 Android 工程的 assets；
 *   3. 给复制过去的 index.html 打补丁：加 viewport、挂移动端样式、引入 hs-core.js。
 *
 * 设计原则：业务代码零改动。
 *   store.js / sync.js 一个字符都不动，靠适配层提供等价的 fs/path/crypto/http。
 *   这样桌面端和手机端跑的是同一份数据逻辑，不会出现「两边行为不一致」。
 *
 * 用法：node mobile/build-mobile.js
 */

const fs = require('fs');
const path = require('path');

const MOBILE = __dirname;
const ROOT = path.join(MOBILE, '..');
const PLATFORM = path.join(MOBILE, 'platform');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const MAIN = path.join(ROOT, 'src', 'main');
const ANDROID = path.join(MOBILE, 'android');
const OUT = path.join(ANDROID, 'assets', 'www');

// 浏览器端（PWA）的产物：由服务端（NAS 上的 server/index.js）静态托管。
//
// 为什么要单独再产一份，而不是让服务端去读 mobile/android/assets/www：
// 部署到群晖时只有 server/ 这一个目录会被挂进容器，安卓工程目录根本不在 NAS 上。
// 内容与安卓端逐字节相同（直接整棵树复制过来），只是多了一层 PWA 声明 ——
// 两边要是各维护一份，改界面时必然漏掉一边。
const WEB_OUT = path.join(ROOT, 'server', 'public');

const { renderIcon, THEME_COLOR } = require('./icon-lib');

function step(msg) {
  console.log('  ' + msg);
}

function ok(msg) {
  console.log('  ✓ ' + msg);
}

function die(msg) {
  console.error('  ✗ ' + msg);
  process.exit(1);
}

function read(file, label) {
  if (!fs.existsSync(file)) die(`缺少文件：${path.relative(ROOT, file)}（${label}）`);
  return fs.readFileSync(file, 'utf8');
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/**
 * 把一个 CommonJS 模块包成 __HS.define(...) 的形式。
 * 模块内部的 require 会被适配层的迷你加载器接管。
 */
function wrapModule(name, source) {
  return (
    '/* ======================= ' + name + '.js ======================= */\n' +
    "__HS.define('" + name + "', function (require, module, exports) {\n" +
    source +
    '\n});\n'
  );
}

console.log('\n家庭收纳 · 安卓端资源打包');
console.log('='.repeat(50));

/* ---------------- 1. 校验源码 ---------------- */

const shimSrc = read(path.join(PLATFORM, '01-shim.js'), '浏览器适配层');
const bootSrc = read(path.join(PLATFORM, '03-bootstrap.js'), '启动装配层');
const mobileCss = read(path.join(PLATFORM, '02-mobile.css'), '移动端样式');
const storeSrc = read(path.join(MAIN, 'store.js'), '数据层');
const syncSrc = read(path.join(MAIN, 'sync.js'), '同步层');
const isbnSrc = read(path.join(MAIN, 'isbn.js'), '图书 ISBN 查询层');
const qrSrc = read(path.join(RENDERER, 'js', 'qr.js'), '二维码模块');
const iconsSrc = read(path.join(RENDERER, 'js', 'icons.js'), '图标库');

// 适配层必须真的覆盖了业务代码用到的模块，否则装出来会在运行时报错。
const needed = [];
if (/require\('fs'\)/.test(storeSrc)) needed.push('fs');
if (/require\('path'\)/.test(storeSrc)) needed.push('path');
if (/require\('crypto'\)/.test(storeSrc)) needed.push('crypto');
if (/require\('http'\)/.test(syncSrc)) needed.push('http');
if (/require\('https'\)/.test(syncSrc)) needed.push('https');
if (/require\('url'\)/.test(syncSrc)) needed.push('url');
// isbn.js 刻意不 require 任何模块（http/https 由调用方注入），这样两端能共用同一份；
// 万一以后有人给它加了 require，这里会立刻炸出来。
const isbnNeeds = (isbnSrc.match(/require\('([^']+)'\)/g) || []).map(function (m) { return m.slice(9, -2); });
if (isbnNeeds.length) die('isbn.js 不应依赖任何模块（要保持两端可共用），却 require 了：' + isbnNeeds.join(', '));
const missing = needed.filter((m) => !new RegExp("name === '" + m + "'").test(shimSrc));
if (missing.length) die('适配层未实现这些模块：' + missing.join(', '));
ok('适配层已覆盖业务代码依赖的模块：' + needed.join(' / '));

/* ---------------- 2. 生成 hs-core.js ---------------- */

step('拼接运行内核 hs-core.js …');

// 版本号从 package.json 读取后写死进内核。
// 手机上不能像桌面端那样在主进程里读 package.json，
// 但「设置」页要显示版本号，所以必须在打包时就注入。
const pkg = JSON.parse(read(path.join(ROOT, 'package.json'), 'package.json'));
if (!pkg.version) die('package.json 里没有 version 字段');
const versionLine = "window.__HS_APP_VERSION__ = '" + pkg.version + "';\n";

const bundle =
  [
    '/* 家庭收纳 · 安卓端运行内核（由 mobile/build-mobile.js 自动生成，请勿手工修改） */',
    '/* 组成：01-shim.js（适配层） + store.js（数据层） + sync.js（同步层） + isbn.js（图书查询） + 03-bootstrap.js（装配层） */',
    '/* 对应桌面端版本：' + pkg.version + ' */',
    versionLine,
    shimSrc,
    wrapModule('store', storeSrc),
    wrapModule('sync', syncSrc),
    wrapModule('isbn', isbnSrc),
    bootSrc
  ].join('\n') + '\n';

fs.mkdirSync(path.join(OUT, 'js'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'js', 'hs-core.js'), bundle, 'utf8');
ok(`hs-core.js 已生成（${(Buffer.byteLength(bundle, 'utf8') / 1024).toFixed(1)} KB，版本 ${pkg.version}）`);

/* ---------------- 3. 复制渲染层资源 ---------------- */

step('复制渲染层资源 …');

const html = read(path.join(RENDERER, 'index.html'), '主页面');
copyFile(path.join(RENDERER, 'css', 'style.css'), path.join(OUT, 'css', 'style.css'));
// 条码识别库：纯 JS，不依赖系统组件。
// 浏览器自带的 BarcodeDetector 在安卓 WebView 和无谷歌服务的手机上识别不出来，不能当主力。
copyFile(path.join(RENDERER, 'js', 'zxing.min.js'), path.join(OUT, 'js', 'zxing.min.js'));
// 二维码生成/解析：复用 zxing.min.js 里自带的编码器，无需额外依赖。
copyFile(path.join(RENDERER, 'js', 'qr.js'), path.join(OUT, 'js', 'qr.js'));
// 内置矢量物品图标库：手绘 SVG，随包发布，不发网络请求。
copyFile(path.join(RENDERER, 'js', 'icons.js'), path.join(OUT, 'js', 'icons.js'));
copyFile(path.join(RENDERER, 'js', 'util.js'), path.join(OUT, 'js', 'util.js'));
copyFile(path.join(RENDERER, 'js', 'components.js'), path.join(OUT, 'js', 'components.js'));
copyFile(path.join(RENDERER, 'js', 'views.js'), path.join(OUT, 'js', 'views.js'));
copyFile(path.join(RENDERER, 'js', 'app.js'), path.join(OUT, 'js', 'app.js'));
fs.writeFileSync(path.join(OUT, 'css', 'mobile.css'), mobileCss, 'utf8');
ok('已复制 index.html / style.css / mobile.css / zxing.min.js / qr.js / icons.js / util.js / components.js / views.js / app.js');

/* ---------------- 4. 给 index.html 打补丁 ---------------- */

step('为移动端改写 index.html …');

let page = html;

// 4.1 viewport：没有它手机浏览器会按 980px 虚拟宽度渲染，界面会缩得很小
if (!/name="viewport"/.test(page)) {
  const anchor = '<meta charset="UTF-8">';
  if (!page.includes(anchor)) die('index.html 结构变化：找不到 <meta charset> 锚点');
  page = page.replace(
    anchor,
    anchor +
      '\n<!-- 移动端：禁止缩放，适配刘海屏 -->\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">'
  );
  ok('已注入 viewport');
} else {
  ok('viewport 已存在，跳过');
}

// 4.2 CSP：sync 走原生通道，页面自身不需要任何外部连接，保持最严格即可
if (!/Content-Security-Policy/.test(page)) {
  die('index.html 结构变化：找不到 CSP 声明（安全策略不能缺）');
}
ok('CSP 保持严格策略（脚本与样式均限定同源）');

// 4.3 移动端样式：必须排在 style.css 之后，才能覆盖桌面布局
const cssAnchor = '<link rel="stylesheet" href="css/style.css">';
if (!page.includes(cssAnchor)) die('index.html 结构变化：找不到 style.css 引用');
page = page.replace(cssAnchor, cssAnchor + '\n<link rel="stylesheet" href="css/mobile.css">');
ok('已挂载 mobile.css（在 style.css 之后，确保覆盖生效）');

// 4.4 运行内核：必须排在其他脚本之前，因为 app.js 会直接使用 window.api
const jsAnchor = '<script src="js/util.js"></script>';
if (!page.includes(jsAnchor)) die('index.html 结构变化：找不到 util.js 引用');
page = page.replace(
  jsAnchor,
  '<!-- 运行内核：提供 window.api（桌面端由 preload.js 提供） -->\n' +
    '<script src="js/hs-core.js"></script>\n' +
    jsAnchor
);
ok('已在渲染层脚本之前引入 hs-core.js');

// 4.5 标题标明端侧，避免和桌面版混淆
page = page.replace('<title>家庭收纳</title>', '<title>家庭收纳</title>');

fs.writeFileSync(path.join(OUT, 'index.html'), page, 'utf8');
ok('index.html 已写入');

/* ---------------- 5. 生成构建信息 ---------------- */
/*
 * 记下「这次构建用的是哪些源文件的哪个版本」，好让测试能确认
 * mobile/android/assets/www 里的产物确实是当前源码构建出来的。
 *
 * 为什么必须有这个东西：手机端测试跑的是**构建产物**，不是 src/ 下的源码。
 * 改完源码忘了重建，测试测的就是旧代码 —— 这个坑已经踩过两次：
 *   一次因此漏掉一个「点缩略图没反应」的真实 bug；
 *   一次是反向验证后忘了还原重建，导致 npm test 里手机端莫名红了 1 项、单跑却是绿的。
 *
 * ⚠️ 清单必须覆盖**所有参与构建的源文件**，尤其是渲染层那几个最常改的
 * （app.js / views.js / util.js / components.js）。
 * 早先这份清单只列了 store.js / sync.js / qr.js / icons.js 这几个很少动的，
 * 恰好把最常改的四个漏在外面 —— 那样即使有测试去比对，也拦不住「忘了重建」。
 */
const crypto = require('crypto');
const hash = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

const BUILD_SOURCES = [
  ['src/main/store.js', path.join(MAIN, 'store.js')],
  ['src/main/sync.js', path.join(MAIN, 'sync.js')],
  ['src/main/isbn.js', path.join(MAIN, 'isbn.js')],
  ['src/renderer/index.html', path.join(RENDERER, 'index.html')],
  ['src/renderer/css/style.css', path.join(RENDERER, 'css', 'style.css')],
  ['src/renderer/js/zxing.min.js', path.join(RENDERER, 'js', 'zxing.min.js')],
  ['src/renderer/js/qr.js', path.join(RENDERER, 'js', 'qr.js')],
  ['src/renderer/js/icons.js', path.join(RENDERER, 'js', 'icons.js')],
  ['src/renderer/js/util.js', path.join(RENDERER, 'js', 'util.js')],
  ['src/renderer/js/components.js', path.join(RENDERER, 'js', 'components.js')],
  ['src/renderer/js/views.js', path.join(RENDERER, 'js', 'views.js')],
  ['src/renderer/js/app.js', path.join(RENDERER, 'js', 'app.js')],
  ['mobile/platform/01-shim.js', path.join(PLATFORM, '01-shim.js')],
  ['mobile/platform/02-mobile.css', path.join(PLATFORM, '02-mobile.css')],
  ['mobile/platform/03-bootstrap.js', path.join(PLATFORM, '03-bootstrap.js')],
  // 图标绘制：安卓 mipmap 与 PWA 的 icon-192/512、apple-touch-icon 都出自这里
  ['mobile/icon-lib.js', path.join(MOBILE, 'icon-lib.js')]
];
const sources = {};
BUILD_SOURCES.forEach(([rel, abs]) => {
  sources[rel] = hash(read(abs, rel));
});

const info = {
  generated_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  sources,
  bundle_bytes: Buffer.byteLength(bundle, 'utf8')
};
fs.writeFileSync(path.join(OUT, 'build-info.json'), JSON.stringify(info, null, 2), 'utf8');
ok(`build-info.json 已生成（记录了 ${BUILD_SOURCES.length} 个源文件的哈希，供测试校验产物是否与源码一致）`);

/* ---------------- 6. 产出一份给浏览器用的（PWA） ---------------- */

step('产出 PWA 资源到 server/public …');

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

// 先整棵复制，保证浏览器端和安卓端跑的是同一份界面代码
copyTree(OUT, WEB_OUT);

/**
 * 手机上「添加到主屏幕」靠这几行：
 *   - iOS 认 apple-mobile-web-app-capable 和 apple-touch-icon，
 *     没有它们装出来的就是一个普通书签，点开还是会带 Safari 地址栏；
 *   - 安卓 / 桌面 Chrome 认 manifest。
 * 两套都写上，装出来的图标和名字才一致。
 *
 * ⚠️ apple-touch-icon 必须是**真实的 PNG 文件**：Safari 不吃 SVG，也不吃 data URI。
 */
const pwaHead = [
  '<!-- PWA：添加到主屏幕后按独立应用打开，不显示浏览器地址栏 -->',
  '<link rel="manifest" href="manifest.webmanifest">',
  '<link rel="apple-touch-icon" href="apple-touch-icon.png">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-title" content="家庭收纳">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="default">',
  '<meta name="theme-color" content="' + THEME_COLOR + '">'
].join('\n');

let webPage = page;
if (!/<\/head>/.test(webPage)) die('index.html 结构变化：找不到 </head>');
webPage = webPage.replace('</head>', pwaHead + '\n</head>');
fs.writeFileSync(path.join(WEB_OUT, 'index.html'), webPage, 'utf8');
ok('index.html 已写入（含 PWA 声明）');

/**
 * manifest 里的路径一律用**相对路径**：
 * 绝对路径（/icon-192.png）在服务端挂到子路径时就全断了，
 * 相对路径由浏览器按 manifest 自己的位置解析，挂在哪儿都对。
 */
const manifest = {
  name: '家庭收纳',
  short_name: '家庭收纳',
  description: '家里的东西放在哪、有多少、什么时候过期，一查就知道。',
  lang: 'zh-CN',
  start_url: './',
  scope: './',
  display: 'standalone',
  background_color: '#f5f5f3',
  theme_color: THEME_COLOR,
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    // maskable：安卓自适应图标会裁成圆形/水滴，这份保证裁剪后图形不被切到
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
};
fs.writeFileSync(
  path.join(WEB_OUT, 'manifest.webmanifest'),
  JSON.stringify(manifest, null, 2) + '\n',
  'utf8'
);
ok('manifest.webmanifest 已写入');

// 图标：和安卓端同一份绘制代码（mobile/icon-lib.js），换主色不会漏掉一边
const PWA_ICONS = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  // iOS 的「添加到主屏幕」只认这个尺寸，文件名也必须是 apple-touch-icon.png
  ['apple-touch-icon.png', 180]
];
for (const [name, size] of PWA_ICONS) {
  fs.writeFileSync(path.join(WEB_OUT, name), renderIcon(size));
}
ok('图标已写入：' + PWA_ICONS.map(([n, s]) => `${n} ${s}×${s}`).join(' / '));

// 构建信息也带一份过去，好让测试能确认 NAS 上那份产物确实是当前源码构建的
fs.copyFileSync(path.join(OUT, 'build-info.json'), path.join(WEB_OUT, 'build-info.json'));

/* ---------------- 汇总 ---------------- */

function dirSize(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else n += fs.statSync(p).size;
    }
  };
  walk(dir);
  return n;
}

console.log('='.repeat(50));
console.log(`安卓端输出：${path.relative(ROOT, OUT)}`);
console.log(`浏览器端输出：${path.relative(ROOT, WEB_OUT)}（由服务端在 /app/ 下静态托管）`);
console.log(`资源总量：${(dirSize(OUT) / 1024).toFixed(1)} KB`);
console.log('');
console.log('资源打包完成。下一步：');
console.log('  打包 APK：node mobile/build-apk.js');
console.log('  部署 PWA：把 server/ 下的 index.js / package.json / public/ 一起传到 NAS\n');
