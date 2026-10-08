'use strict';
/**
 * 图标预览：把 icons.js 里的图标全部渲染出来，用 Electron 截成一张图。
 *
 * 为什么要这个工具：图标的「画得像不像」是**看**出来的，不是断言出来的。
 * 之前定稿图标时踩过的坑 —— 面包画得像柜子、香肠画得像甜甜圈、钥匙和胶带在
 * 20px 下撞脸 —— 断言全部通过，只有盯着截图才看得出来。
 * 所以**每次改 icons.js 都要跑一遍这个脚本，亲眼看结果**。
 *
 * 输出（默认写到系统临时目录，可用 HS_ICON_SHOT 指定）：
 *   icons.png        —— 全部图标按分组铺开，每格 26px，看整体观感
 *   icons-zoom.png   —— 重点图标 64px 和 20px 并排，看细节和缩小后是否还认得出
 *
 * 用法：
 *   npm run icon:preview
 *   HS_ICON_SHOT=D:/tmp/icons.png node scripts/icon-preview.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_PNG = process.env.HS_ICON_SHOT || path.join(os.tmpdir(), 'hs-icon-preview', 'icons.png');
const TMP = path.dirname(OUT_PNG);

// 放大对比区里要重点盯的图标：容易画歪或容易撞脸的
const ZOOM_KEYS = [
  'bread', 'meat', 'soap', 'tape', 'key', 'ruler', 'egg', 'drink',
  'book', 'folder', 'contract', 'invoice', 'receipt', 'certificate'
];

const iconsJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'icons.js'), 'utf8');
fs.mkdirSync(TMP, { recursive: true });
const previewHtml = path.join(TMP, 'preview.html');

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  body { margin:0; padding:18px; background:#f5f5f3; color:#1f1f1d;
         font-family: "Microsoft YaHei", system-ui, sans-serif; }
  h2 { font-size:14px; margin:16px 0 8px; color:#6b6b66; font-weight:600; }
  .grid { display:flex; flex-wrap:wrap; gap:6px; }
  .cell { width:76px; padding:8px 4px 6px; background:#fff; border:1px solid #e6e6e2;
          border-radius:8px; text-align:center; }
  .cell svg { color:#2b2b28; }
  .cell .n { font-size:10px; color:#8a8a84; margin-top:4px;
             white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .zoom { display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end; }
  .zcell { text-align:center; background:#fff; border:1px solid #e6e6e2;
           border-radius:8px; padding:8px 10px 6px; }
  .zcell .n { font-size:10px; color:#8a8a84; margin-top:6px; }
</style></head>
<body>
<div id="zoom" class="zoom"></div>
<div id="root"></div>
<script>${iconsJs}</script>
<script>
  var ZOOM_KEYS = ${JSON.stringify(ZOOM_KEYS)};
  var zroot = document.getElementById('zoom');
  ZOOM_KEYS.forEach(function (k) {
    var c = document.createElement('div');
    c.className = 'zcell';
    c.innerHTML = ITEM_ICONS.svg(k, 64) + ITEM_ICONS.svg(k, 20) + '<div class="n">' + k + '</div>';
    zroot.appendChild(c);
  });
  var root = document.getElementById('root');
  ITEM_ICONS.groups.forEach(function (g) {
    var h = document.createElement('h2');
    h.textContent = g.name + '（' + g.icons.length + '）';
    root.appendChild(h);
    var grid = document.createElement('div');
    grid.className = 'grid';
    g.icons.forEach(function (ic) {
      var c = document.createElement('div');
      c.className = 'cell';
      c.innerHTML = ITEM_ICONS.svg(ic.key, 26) + '<div class="n">' + ic.name + '</div>';
      grid.appendChild(c);
    });
    root.appendChild(grid);
  });
  document.title = '图标预览 ' + ITEM_ICONS.all.length;
</script>
</body></html>`;
fs.writeFileSync(previewHtml, html, 'utf8');

// 截图用一个独立的最小 Electron 工程：不依赖主程序的窗口逻辑，
// 也避免把开发机的用户数据目录搅乱。
const mainJs = path.join(TMP, 'main.js');
fs.writeFileSync(mainJs, `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900, height: 1400, show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false }
  });
  // 窗口不可见时 capturePage 会拿到旧帧，关掉后台节流也一样要等一等
  try { win.webContents.setBackgroundThrottling(false); } catch (e) {}
  await win.loadFile(${JSON.stringify(previewHtml)});
  await new Promise(r => setTimeout(r, 1200));
  const h = await win.webContents.executeJavaScript('document.body.scrollHeight');
  win.setContentSize(900, Math.min(h + 20, 2400));
  await new Promise(r => setTimeout(r, 900));
  try { win.webContents.invalidate(); } catch (e) {}
  await new Promise(r => setTimeout(r, 300));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(${JSON.stringify(OUT_PNG)}, img.toPNG());
  console.log('SHOT_DONE ' + img.getSize().width + 'x' + img.getSize().height);
  app.exit(0);
});
`, 'utf8');
fs.writeFileSync(path.join(TMP, 'package.json'), JSON.stringify({ name: 'icon-preview', main: 'main.js' }), 'utf8');

const bin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const env = Object.assign({}, process.env);
// 这个变量会让 electron.exe 变成纯 Node，窗口就开不起来了
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(bin, [TMP, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  { cwd: TMP, env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => (out += d.toString()));
child.stderr.on('data', (d) => (out += d.toString()));
const timer = setTimeout(() => {
  console.log('截图超时（90 秒）');
  child.kill();
  process.exit(1);
}, 90000);
child.on('exit', (code) => {
  clearTimeout(timer);
  console.log(out.trim().slice(-500));
  if (code === 0) console.log('\n图标预览已生成：' + OUT_PNG);
  else console.log('\n生成失败，退出码 ' + code);
  process.exit(code === 0 ? 0 : 1);
});
