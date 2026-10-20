'use strict';

/**
 * 手机界面验证 · Electron 主进程
 * ---------------------------------------------------------------------------
 * 用真实的 Chromium 以手机尺寸加载打包好的手机端页面，验证：
 *   · 运行内核在真实浏览器环境里能起来（不只是 Node 沙箱里能跑）
 *   · 数据层读写正常
 *   · 布局真的变成了「底部标签栏」，而不是把桌面侧栏硬塞进窄屏
 *   · 弹窗、表单在窄屏下没有溢出，点击区域够大
 *   · 控制台没有报错
 *
 * 为什么要用本地 http 服务而不是直接开文件：
 *   真机上页面跑在 https://hs.local 这个同源环境里，localStorage 和 CSP 的
 *   'self' 都依赖「同源」这个前提。用 file:// 打开会引入假问题（CSP 拦截、
 *   存储不可用），测出来的结论没有参考价值。
 *
 * 这个文件由 test/test-mobile-ui.js 启动，不单独运行。
 */

const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'mobile', 'android', 'assets', 'www');
const SHOT_DIR = process.env.HS_MUI_SHOT_DIR || '';

// 手机竖屏尺寸（接近主流机型），deviceScaleFactor 2 让截图更清晰
const PHONE_W = 390;
const PHONE_H = 844;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/' || p === '') p = '/index.html';

      // ---- 假的同步后端 ----
      // 只为验证「界面拿到结果之后有没有反应」。
      // 响应形状必须和 server/index.js 一致：登录成功 200 {ok,token}、
      // 密码错 401 {error}。地址用 location.origin，所以是**同源**请求，
      // 和真机上「PWA 由 NAS 自己托管」的部署方式一致（不需要 CORS）。
      if (p.indexOf('/api/') === 0) {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          const send = (code, obj) => {
            const text = JSON.stringify(obj);
            res.writeHead(code, {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Length': Buffer.byteLength(text, 'utf8')
            });
            res.end(text);
          };
          if (p === '/api/health') {
            return send(200, { ok: true, name: '家庭收纳同步服务', version: '1.1.0' });
          }
          if (p === '/api/login' && req.method === 'POST') {
            let b = {};
            try { b = JSON.parse(raw || '{}'); } catch (e) {}
            if (b.password === 'goodpw') {
              return send(200, { ok: true, token: 'tok-mui', username: b.username, device: b.device || '' });
            }
            return send(401, { error: '账号或密码不正确（还可尝试 4 次）', remaining: 4 });
          }
          if (p === '/api/register' && req.method === 'POST') {
            return send(200, { ok: true });
          }
          if (p === '/api/sync' && req.method === 'POST') {
            return send(200, {
              serverTime: '2026-09-20T02:00:00.000Z',
              pull: { locations: [], items: [], categories: [], images: [] }
            });
          }
          return send(404, { error: '没有这个接口' });
        });
        return;
      }

      const file = path.join(WWW, p);
      // 防止路径穿越
      if (!file.startsWith(WWW)) {
        res.writeHead(403);
        return res.end('forbidden');
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('找不到 ' + p);
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** 在页面里跑的探测脚本，返回一个可序列化的结果对象 */
const PROBE = `(async () => {
  const out = {};
  const errs = [];
  window.addEventListener('error', (e) => errs.push('error: ' + (e.message || '')));
  window.addEventListener('unhandledrejection', (e) => errs.push('reject: ' + String((e.reason && e.reason.message) || e.reason)));

  const tick = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    /* ---- 1. 内核与渲染层是否就绪 ---- */
    out.hasKernel = typeof window.__HS === 'object' && window.__HS !== null;
    out.hasApi = typeof window.api === 'object' && window.api !== null;
    out.hasApp = typeof window.App !== 'undefined';
    out.hasViews = typeof window.Views !== 'undefined';
    out.hasUtil = typeof window.U !== 'undefined';
    out.navItems = document.querySelectorAll('.nav-item').length;
    out.views = Array.from(document.querySelectorAll('.view')).map((v) => v.id);
    const info = await window.api.appInfo();
    out.appVersion = info.version;
    out.platform = info.platform;
    out.userData = info.userData;

    /* ---- 2. 数据层在真实浏览器里能不能用 ---- */
    const tree = await window.api.call('locations.tree');
    out.treeOk = tree.ok === true;
    out.topLocations = tree.ok ? tree.data.map((n) => n.name) : [];
    out.treeHasPath = tree.ok && tree.data.every((n) => typeof n.path === 'string' && n.path);

    const cats = await window.api.call('categories.list');
    out.categoryCount = cats.ok ? cats.data.length : -1;

    const saved = await window.api.call('items.save', {
      name: '手机自检物品', barcodes: ['6901111111111'], quantity: 2
    });
    out.saveOk = saved.ok === true;

    const found = await window.api.call('items.byBarcode', { barcode: '6901111111111' });
    out.lookupOk = !!(found.ok && found.data && found.data.name === '手机自检物品');

    const stats = await window.api.call('items.stats');
    out.statsOk = stats.ok === true;
    const exported = await window.api.call('app.export');
    out.exportOk = exported.ok === true;

    // 数据真的落到 localStorage 了。
    // 注意要先 saveNow()：数据层平时是 120ms 防抖写盘，直接数会数到 0，
    // 那是测试写法的问题，不是应用的问题。
    window.__hsStore.saveNow();
    let keys = 0;
    for (let i = 0; i < localStorage.length; i++) {
      if (String(localStorage.key(i)).startsWith('hs:file:')) keys++;
    }
    out.storageKeys = keys;

    /* ---- 3. 布局：侧栏应该落在屏幕底部 ---- */
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    out.vw = vw;
    out.vh = vh;

    const sb = document.querySelector('.sidebar');
    const sbr = sb.getBoundingClientRect();
    out.sidebarTop = Math.round(sbr.top);
    out.sidebarHeight = Math.round(sbr.height);
    out.sidebarAtBottom = sbr.top > vh * 0.6;

    const isHidden = (sel) => {
      const el = document.querySelector(sel);
      return !el || getComputedStyle(el).display === 'none';
    };
    out.brandHidden = isHidden('.brand');
    out.locPanelHidden = isHidden('.loc-panel');
    out.sideFootHidden = isHidden('.side-foot');

    const tabs = Array.from(document.querySelectorAll('.nav-item'));
    out.minTabHeight = tabs.length ? Math.min.apply(null, tabs.map((el) => Math.round(el.getBoundingClientRect().height))) : 0;
    out.tabRowDir = getComputedStyle(document.querySelector('.nav')).flexDirection;

    // 7 个标签必须全部落在屏幕内。
    // 这条断言是补上来的：曾经桌面版的 width:100% 没被覆盖，
    // 每个标签被撑成整屏宽，7 个排出去 2700 多像素，屏幕上只看得到第一个。
    // 光检查「标签栏在底部」「标签够高」是发现不了这个问题的。
    const tabRects = tabs.map((el) => el.getBoundingClientRect());
    out.tabWidths = tabRects.map((r) => Math.round(r.width));
    out.tabsAllOnScreen = tabRects.length > 0 && tabRects.every((r) => r.left >= -1 && r.right <= vw + 1);
    out.tabLabels = tabs.map((el) => {
      const t = [];
      for (let i = 0; i < el.childNodes.length; i++) {
        const n = el.childNodes[i];
        if (n.nodeType === 3 && String(n.nodeValue).replace(/\\s/g, '') !== '') t.push(String(n.nodeValue).trim());
      }
      return t.join('');
    });
    const navEl = document.querySelector('.nav');
    out.navScrollWidth = navEl.scrollWidth;
    out.navNoOverflow = navEl.scrollWidth <= vw + 1;

    // 主内容区不能被标签栏挤没，也不能反过来盖住标签栏。
    // 桌面版是横向布局，主区只需 min-width:0；改成纵向后必须补 min-height:0，
    // 否则 flex 项不会被压缩，主区会溢出把标签栏顶出屏幕。
    const mainEl = document.querySelector('.main');
    const mr2 = mainEl.getBoundingClientRect();
    out.mainTop = Math.round(mr2.top);
    out.mainHeight = Math.round(mr2.height);
    out.mainBottom = Math.round(mr2.bottom);
    out.mainNoOverlap = mr2.bottom <= sbr.top + 1;

    // 标签栏必须完整落在屏幕内
    out.sidebarInsideScreen = sbr.bottom <= vh + 1;

    // 不能出现横向滚动条
    out.scrollWidth = document.documentElement.scrollWidth;
    out.noHScroll = document.documentElement.scrollWidth <= vw + 1;

    // 弹窗遮罩不能误显示（桌面端出过这个问题）
    const mr = document.getElementById('modalRoot');
    const mrr = mr.getBoundingClientRect();
    out.modalVisible = mrr.width > 0 && mrr.height > 0;

    /* ---- 4. 新增物品弹窗在窄屏下的表现 ---- */
    window.App.openItemEditor(null);
    await tick(150);
    out.itemModalOpen = document.getElementById('modalRoot').hidden === false;

    const box = document.getElementById('modalBox');
    const grid = box.querySelector('.form-grid');
    out.formCols = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : -1;

    const br = box.getBoundingClientRect();
    out.modalWidth = Math.round(br.width);
    out.modalNearFullWidth = br.width >= vw * 0.95;
    out.modalBottomAligned = br.bottom >= vh - 6;
    out.modalFitsHeight = br.height <= vh * 0.95;

    // 弹窗里的输入框要够大才好点（排除隐藏控件，如选图片用的 hidden file input，它高度为 0）
    const inputs = Array.from(box.querySelectorAll('input, select, textarea')).filter((el) => el.offsetHeight > 0);
    out.minInputHeight = inputs.length ? Math.min.apply(null, inputs.map((el) => Math.round(el.getBoundingClientRect().height))) : 0;

    document.getElementById('modalRoot').hidden = true;

    /* ---- 5. 新增位置弹窗：上级位置下拉（桌面端曾显示 undefined） ---- */
    window.App.openLocEditor(null);
    await tick(150);
    const sel = document.querySelector('#modalBox select[data-k="parent_id"]');
    out.locSelectOk = !!sel;
    if (sel) {
      const opts = Array.from(sel.options);
      out.locOptionCount = opts.length;
      out.locNoUndefined = opts.every((o) => o.text.trim().length > 0 && o.text.indexOf('undefined') < 0);
      out.locHasIndent = opts.slice(1).some((o) => o.text.indexOf('\\u3000') === 0);
    }
    document.getElementById('modalRoot').hidden = true;

    /* ---- 5b. 位置管理页的操作按钮必须真的看得见 ---- */
    // ⚠️ 这段代码是**注入到浏览器里执行的模板字符串**，所以注释里绝对不能出现反引号，
    //    也不能出现「美元符号紧跟左花括号」那种插值写法 —— 两者都会提前结束模板字符串，
    //    把后面的内容当成 JS 解析 → 主进程 SyntaxError 崩掉。
    //    要引用选择器就用「」包起来。（这个坑真踩过：写注释提醒"别用反引号"的时候，
    //    顺手在注释里写了反引号，反而把测试搞崩了。）
    //
    // 桌面版靠「.tree-row:hover」才把按钮的 opacity 从 0 提到 1。
    // 手机上没有 hover —— 如果原样继承，按钮就永远不可见，
    // 但 opacity:0 的元素仍然可以点，于是用户看不见却会盲点误触（里面有删除！）。
    // 所以这里量计算样式，不看源码里写了什么。
    await window.App.goto('locations');
    await tick(250);
    const treeRow = document.querySelector('#view-locations .tree-row');
    out.treeRowFound = !!treeRow;
    if (treeRow) {
      const acts = treeRow.querySelector('.tree-actions');
      out.treeActionsFound = !!acts;
      if (acts) {
        const cs = getComputedStyle(acts);
        const ab = acts.getBoundingClientRect();
        out.treeActionsOpacity = cs.opacity;
        out.treeActionsW = Math.round(ab.width);
        out.treeActionsVisible = cs.opacity === '1' && ab.width > 0;
        const btns = Array.from(acts.querySelectorAll('.icon-btn'));
        out.treeBtnCount = btns.length;
        out.treeBtnMinSize = btns.length
          ? Math.min.apply(null, btns.map((b) => {
            const r = b.getBoundingClientRect();
            return Math.round(Math.min(r.width, r.height));
          }))
          : 0;
      }
    }

    /* ---- 5c. 底栏只留 5 项；被摘掉的页面仍能打开，且底栏要有高亮 ---- */
    // 手机端把「办公资料 / 图书 / 保质期 / 统计」从底栏摘掉了：
    // 前三项在物品页有一模一样的筛选 chip，统计的数字总览页都有。
    // 但页面本身必须还在、还得进得去；进去之后底栏不能一个都不亮
    // （底栏全灭，用户会以为点了没反应）。
    out.navViews = Array.from(document.querySelectorAll('.nav-item')).map((b) => b.dataset.view);

    await window.App.goto('dashboard');
    await tick(250);
    const statsEntry = document.querySelector('#view-dashboard [data-goto="stats"]');
    out.dashHasStats = !!statsEntry;
    if (statsEntry) {
      statsEntry.click();
      await tick(400);
      const statsView = document.getElementById('view-stats');
      out.statsReachable = window.App.state.view === 'stats' && !!statsView && !statsView.hidden;
      const actives = Array.from(document.querySelectorAll('.nav-item'))
        .filter((b) => b.classList.contains('active'));
      out.statsActiveTabCount = actives.length;
      out.statsActiveTabView = actives.length ? actives[0].dataset.view : '';
    }

    // 被摘掉的另外三个页面照样要能直接打开
    const stillOpen = ['docs', 'books', 'expiry'];
    out.hiddenViewsStillWork = true;
    for (let i = 0; i < stillOpen.length; i++) {
      await window.App.goto(stillOpen[i]);
      await tick(200);
      const v = document.getElementById('view-' + stillOpen[i]);
      if (!v || v.hidden) out.hiddenViewsStillWork = false;
    }

    /* ---- 6. 新功能：物品图片 + 二维码（手机端也要能用） ---- */
    // 手机端 fs 是 localStorage 适配层（约 5MB），全图必须走独立文件，
    // 这里顺带验证「列表只带缩略图、全图按需取」这条路在手机端也通。
    const THUMB = 'data:image/jpeg;base64,/9j/4MUITHUMB' + 'A'.repeat(80);
    const FULL = 'data:image/jpeg;base64,/9j/4MUIFULL' + 'B'.repeat(400);
    const imgItem = await window.api.call('items.save', { name: '手机带图物品', quantity: 1 });
    out.imgSaveItemOk = imgItem.ok === true;
    if (imgItem.ok) {
      const sv = await window.api.call('images.save', {
        item_id: imgItem.data.id, full: FULL, thumb: THUMB, w: 640, h: 480
      });
      out.imgSaveOk = sv.ok === true && !!sv.data.image_id;

      const got = await window.api.call('images.data', { id: sv.data.image_id });
      out.imgFullOk = got.ok === true && got.data.full === FULL;

      await window.App.goto('items');
      await tick(200);
      const row = document.querySelector('#view-items [data-item="' + imgItem.data.id + '"]');
      const th = row && row.querySelector('[data-thumb]');
      out.thumbShown = !!th;
      out.thumbIsThumb = !!th && th.getAttribute('src') === THUMB;
      // 缩略图上挂的必须是「图片 id」，挂成物品 id 的话点开就是一片空白
      out.thumbIdIsImageId = !!th && th.getAttribute('data-thumb') === sv.data.image_id;
      out.thumbBoxOk = false;
      if (th) {
        const r = th.getBoundingClientRect();
        // 缩略图不能把行撑高，也不能小到看不见
        out.thumbBoxOk = r.width >= 20 && r.width <= 80 && r.height >= 20 && r.height <= 80;
      }
      if (th) {
        th.click();
        // viewImage 是异步的（要按 id 取全图），轮询等它把弹窗填好
        for (let i = 0; i < 20; i++) {
          await tick(100);
          if (document.querySelector('#modalRoot .img-view img')) break;
        }
        const big = document.querySelector('#modalRoot .img-view img');
        out.imgViewerOk = !!big && big.getAttribute('src') === FULL;
      }
      document.getElementById('modalRoot').hidden = true;
    }

    // 位置页的二维码按钮 + 弹窗
    await window.App.goto('locations');
    await tick(200);
    const qb = document.querySelector('#treeEditor [data-qr]');
    out.locQrBtnOk = !!qb;
    if (qb) {
      qb.click();
      await tick(250);
      const box = document.querySelector('#modalRoot .qr-box');
      out.qrModalOk = !!box;
      const svg = box && box.querySelector('svg');
      out.qrSvgOk = !!svg && svg.querySelectorAll('rect').length > 50;
      const r2 = box ? box.getBoundingClientRect() : null;
      // 二维码要完整落在屏幕里，不能被裁掉
      out.qrFitsOk = !!r2 && r2.left >= 0 && r2.right <= vw + 1 && r2.bottom <= vh + 1;
    }
    document.getElementById('modalRoot').hidden = true;

    // 扫码页的手电筒按钮（暗处扫条码用得上）
    await window.App.goto('scan');
    await tick(250);
    const torch = document.getElementById('btnTorch');
    out.torchBtnOk = !!torch;
    out.torchHiddenWhenUnsupported = !torch || torch.hidden === true;
    // 手压输入框在手机上是主要的备用录入方式，必须还在
    out.manualInputOk = !!document.getElementById('manualCode');

    /* ---- 同步登录：界面必须对结果有反应 ---- */
    // 涛哥报过「浏览器登录账号没反应」。根因是适配层（03-bootstrap.js）没把
    // 结果包成 {ok,data}，渲染层取 r.ok 拿到的是 undefined → 永远走失败分支，
    // 而 r.error 也是 undefined → 连一句错误提示都弹不出来；登录失败那条更是
    // 直接抛异常冒到 onclick 外面。两条路的表现都是「点了没反应」。
    //
    // 这一段测的不是「请求发出去没有」（test-mobile.js 已经验过形状了），
    // 而是「点完之后屏幕上到底出现了什么」—— 少了这一步就测不出「没反应」。
    await window.App.goto('settings');
    await tick(300);
    const toastRoot = document.getElementById('toastRoot');
    const clearToasts = () => { if (toastRoot) toastRoot.innerHTML = ''; };
    const syncMsg = () => (document.getElementById('syncMsg') || {}).textContent || '';

    // 地址填 location.origin：和真机上「PWA 由 NAS 自己托管」一样是同源请求
    document.getElementById('setSyncUrl').value = location.origin;
    document.getElementById('setSyncUser').value = 'taoge';
    document.getElementById('setDeviceName').value = '手机';

    // 1) 密码正确 → 必须提示成功，并且把令牌存下来
    document.getElementById('setSyncPass').value = 'goodpw';
    clearToasts();
    document.getElementById('btnLoginSync').click();
    await tick(800);
    out.syncOkToast = toastRoot ? toastRoot.textContent : '';
    out.syncOkToken = ((await window.api.call('app.settings.get')).data || {}).syncToken || '';

    // 2) 密码错 → 必须把服务端那句话原样说出来，而不是静默
    document.getElementById('setSyncPass').value = 'badpw';
    clearToasts();
    document.getElementById('btnLoginSync').click();
    await tick(800);
    out.syncErrToast = toastRoot ? toastRoot.textContent : '';
    out.syncErrMsg = syncMsg();

    // 3) 「测试连接」也要有反馈
    clearToasts();
    document.getElementById('btnTestSync').click();
    await tick(800);
    out.syncTestMsg = syncMsg();

    // 4) 「立即同步」在已登录状态下要跑完并报出条数
    clearToasts();
    document.getElementById('btnSyncNow2').click();
    await tick(1000);
    out.syncRunToast = toastRoot ? toastRoot.textContent : '';

    out.errors = errs;
  } catch (e) {
    out.fatal = String((e && e.message) || e);
    out.errors = errs;
  }
  return out;
})()`;

app.whenReady().then(async () => {
  const { server, port } = await serve();
  const base = `http://127.0.0.1:${port}`;

  const win = new BrowserWindow({
    width: PHONE_W,
    height: PHONE_H,
    show: true,
    autoHideMenuBar: true,
    backgroundColor: '#f5f5f3',
    webPreferences: {
      // 跟真机保持一致：页面里没有任何 Node 能力
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      zoomFactor: 1,
      // 真机上 MainActivity 会把 HSAndroid 注入页面，页面据此判断自己是
      // 安卓应用还是浏览器。不挂这个替身，下面「识别为安卓端」就只是在
      // 核对 03-bootstrap.js 里写死的字符串 —— 那是假测试。
      preload: path.join(__dirname, 'mobile-ui-preload.js')
    }
  });

  const pageErrors = [];
  // 测「存储写满告警」时会主动触发一次 console.error（那是告警的正常输出，
  // 用户看不到控制台，但技术支持要看得到）。触发期间临时关掉收集，
  // 免得把预期日志误判成页面报错 —— 不是按内容白名单过滤，那样会掩盖真问题。
  let consoleCollectPaused = false;
  win.webContents.on('console-message', (_e, level, message) => {
    if (consoleCollectPaused) return;
    // level 3 = error
    if (level >= 2) pageErrors.push(message);
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log('MUI_ERROR: 渲染进程崩溃 ' + JSON.stringify(d));
  });

  // 窗口不可见时 Chromium 会节流渲染，capturePage 只能拿到上一帧
  // （表现为后面几张 PNG 字节数完全一样）。关掉节流并显式把窗口亮出来。
  try { win.webContents.setBackgroundThrottling(false); } catch (e) {}
  try { win.show(); win.focus(); } catch (e) {}

  // 统一截图入口：强制合成一帧再抓，避免抓到旧帧
  const shot = async (w, file) => {
    try { w.webContents.invalidate(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 180));
    let buf = null;
    try { buf = (await w.webContents.capturePage()).toPNG(); } catch (e) {}
    if (buf && buf.length > 1000) {
      fs.writeFileSync(file, buf);
      console.log('MUI_SHOT: ' + path.basename(file) + ' (' + buf.length + ' bytes)');
    } else {
      console.log('MUI_SHOT_SKIP: ' + path.basename(file) + ' (画面为空)');
    }
  };

  try {
    await win.loadURL(base + '/index.html');
    // 等 App.init() 完成（它是 DOMContentLoaded 里跑的，还要等几帧渲染）
    await new Promise((r) => setTimeout(r, 1200));

    const result = await win.webContents.executeJavaScript(PROBE);
    result.consoleErrors = pageErrors;

    // 截图
    if (SHOT_DIR) {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const shots = [
        ['01-总览', 'dashboard'],
        ['02-物品清单', 'items'],
        ['03-保质期', 'expiry'],
        ['04-位置管理', 'locations'],
        ['05-统计', 'stats'],
        ['06-设置', 'settings']
      ];
      for (const [label, view] of shots) {
        await win.webContents.executeJavaScript(`App.goto('${view}')`);
        await new Promise((r) => setTimeout(r, 450));
        await shot(win, path.join(SHOT_DIR, `手机-${label}.png`));
      }
      // 再补一张新增物品弹窗。
      // 注意前面的 void：openItemEditor 返回的 Promise 要等弹窗提交或取消才 resolve，
      // 直接返回给 executeJavaScript 会一直等到天荒地老（这正是之前卡住的原因）。
      await win.webContents.executeJavaScript(`void App.openItemEditor(null)`);
      await new Promise((r) => setTimeout(r, 600));
      await shot(win, path.join(SHOT_DIR, '手机-07-新增物品弹窗.png'));

      // ---- 新功能截图：物品图片 + 二维码 ----
      // 先在页面里造一张「照片」（canvas，不依赖外部文件），存进一个物品
      await win.webContents.executeJavaScript(`(async () => {
        document.getElementById('modalRoot').hidden = true;
        const mk = (label, bg) => {
          const c = document.createElement('canvas');
          c.width = 640; c.height = 480;
          const g = c.getContext('2d');
          g.fillStyle = bg; g.fillRect(0, 0, 640, 480);
          g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(30, 30, 580, 420);
          g.fillStyle = '#2b2b2b'; g.font = 'bold 46px sans-serif';
          g.fillText(label, 80, 240);
          g.font = '26px sans-serif'; g.fillStyle = '#666';
          g.fillText('示例照片', 80, 292);
          const full = c.toDataURL('image/jpeg', 0.8);
          const t = document.createElement('canvas');
          t.width = 160; t.height = 120;
          t.getContext('2d').drawImage(c, 0, 0, 160, 120);
          return { full, thumb: t.toDataURL('image/jpeg', 0.6), w: 640, h: 480 };
        };
        const list = (await window.api.call('items.list')).data;
        const target = list[0];
        if (target) {
          await window.api.call('images.save', Object.assign({ item_id: target.id }, mk('收纳盒', '#d8f0e0')));
          const list2 = (await window.api.call('items.list')).data;
          const t2 = list2.find(i => i.name === '手机带图物品') || list2[0];
          if (t2) await window.api.call('images.save', Object.assign({ item_id: t2.id }, mk('带图物品', '#e6dcff')));
        }
        return true;
      })()`);

      await win.webContents.executeJavaScript(`App.goto('items')`);
      await new Promise((r) => setTimeout(r, 700));
      await shot(win, path.join(SHOT_DIR, '手机-08-物品清单-缩略图.png'));

      await win.webContents.executeJavaScript(`(async () => {
        const t = document.querySelector('#view-items [data-thumb]');
        if (t) t.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 800));
      await shot(win, path.join(SHOT_DIR, '手机-09-查看大图.png'));
      await win.webContents.executeJavaScript(`C.close()`);
      await new Promise((r) => setTimeout(r, 300));

      await win.webContents.executeJavaScript(`(async () => {
        await App.goto('locations');
        await new Promise(r => setTimeout(r, 500));
        const b = document.querySelector('#treeEditor [data-qr]');
        if (b) b.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 700));
      await shot(win, path.join(SHOT_DIR, '手机-10-位置二维码.png'));
      await win.webContents.executeJavaScript(`C.close()`);
      await new Promise((r) => setTimeout(r, 300));

      await win.webContents.executeJavaScript(`(async () => {
        await App.goto('items');
        await new Promise(r => setTimeout(r, 500));
        const list = (await window.api.call('items.list')).data;
        const w = list.find(i => i.has_image);
        if (w) App.openItemEditor(w.id);
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 900));
      await shot(win, path.join(SHOT_DIR, '手机-11-物品图片编辑.png'));

      await win.webContents.executeJavaScript(`(async () => {
        C.close();
        await App.goto('scan');
        await new Promise(r => setTimeout(r, 600));
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 400));
      await shot(win, path.join(SHOT_DIR, '手机-12-扫码页.png'));

      // ---- 办公资料 / 图书：新增的两个栏目在手机上的样子 ----
      // 顺便验证 9 个底部标签在窄屏下有没有被挤掉或换行。
      await win.webContents.executeJavaScript(`(async () => {
        const cats = (await window.api.call('categories.list')).data;
        const cOf = (n) => cats.find(c => c.name === n);
        const locs = (await window.api.call('locations.list')).data;
        const loc = locs[0] || null;
        const docs = [
          ['房屋租赁合同', cOf('合同协议'), 'contract',
            { doc_no: 'HT-2026-018', year: '2026', org: '某某物业', amount: '48000', keep_until: '2031-12-31' }],
          ['2026年3月记账凭证', cOf('记账凭证'), 'ledger',
            { doc_no: 'JZ-2026-03', year: '2026', amount: '18650.5', keep_until: '2046-03-31' }],
          ['不动产权证书复印件', cOf('资质证照'), 'certificate',
            { doc_no: 'ZZ-2019-0071', year: '2019', keep_until: '2039-06-30' }]
        ];
        for (const [name, cat, icon, extra] of docs) {
          await window.api.call('items.save', {
            name, kind: 'doc', icon, unit: '份', quantity: 1,
            category_id: cat ? cat.id : null,
            location_id: loc ? loc.id : null, extra
          });
        }
        const books = [
          ['深入理解计算机系统', '9787111544937', cOf('图书'), 'book',
            { author: 'Randal E. Bryant', publisher: '机械工业出版社', pub_year: '2016', status: '在读' }, 139],
          ['人类简史', '9787508647357', cOf('图书'), 'book',
            { author: '尤瓦尔·赫拉利', publisher: '中信出版社', pub_year: '2014', status: '已读' }, 68],
          ['线性代数（第六版）', '9787040396614', cOf('教材教辅'), 'textbook',
            { author: '同济大学数学系', publisher: '高等教育出版社', pub_year: '2014', status: '未读' }, 42.5]
        ];
        for (const [name, barcode, cat, icon, extra, price] of books) {
          await window.api.call('items.save', {
            name, kind: 'book', icon, barcodes: [barcode], unit: '本', quantity: 1,
            category_id: cat ? cat.id : null,
            location_id: loc ? loc.id : null, price, extra
          });
        }
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 400));

      for (const [label, view] of [['13-办公资料', 'docs'], ['14-图书', 'books']]) {
        await win.webContents.executeJavaScript(`App.goto('${view}')`);
        await new Promise((r) => setTimeout(r, 550));
        await shot(win, path.join(SHOT_DIR, `手机-${label}.png`));
      }

      // 扫到书背 ISBN 之后自动补全：手机端跑的是同一套渲染层，但窄屏下单列排布，
      // 末尾那行提示会不会挤出边界得亲眼看。
      // lookupIsbn 在这里是打桩的（手机端 window.api 是普通对象，可以直接换）——
      // 截图环境没有外网。补全的行为在 test-ui 的 [UI-17b] 里逐条测。
      await win.webContents.executeJavaScript(`(async () => {
        window.api.lookupIsbn = async () => ({
          ok: true, source: 'openlibrary',
          book: { title: '深入理解计算机系统', subtitle: '原书第 3 版',
            authors: ['Randal E. Bryant', "David R. O'Hallaron"],
            publisher: '机械工业出版社', publishYear: 2016, isbn: '9787111544937' }
        });
        App.openItemEditor(null, {
          kind: 'book', barcode: '9787111544937', barcodes: ['9787111544937'],
          lookupIsbn: '9787111544937'
        });
        await new Promise(r => setTimeout(r, 1500));
        const body = document.querySelector('#modalRoot .modal-body');
        if (body) body.scrollTop = body.scrollHeight;
        await new Promise(r => setTimeout(r, 300));
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 500));
      await shot(win, path.join(SHOT_DIR, '手机-14b-图书自动填全.png'));
      await win.webContents.executeJavaScript(`C.close()`);
      await new Promise((r) => setTimeout(r, 300));

      // 图标选择器（手机上是全屏弹窗，要确认图标网格没被挤成一列）
      await win.webContents.executeJavaScript(`(async () => {
        await App.goto('items');
        await new Promise(r => setTimeout(r, 450));
        const list = (await window.api.call('items.list')).data;
        if (list[0]) App.openItemEditor(list[0].id);
        await new Promise(r => setTimeout(r, 700));
        const b = document.querySelector('#modalRoot #btnPickIcon');
        if (b) b.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 800));
      await shot(win, path.join(SHOT_DIR, '手机-15-图标选择器.png'));
      await win.webContents.executeJavaScript(`C.close()`);
      await new Promise((r) => setTimeout(r, 300));

      // 存储写满时的兜底提示条。它只在界面组件（components.js）没就绪时出现 ——
      // 正常路径永远看不到，所以更要亲眼确认一次：它是 fixed 钉在顶部的，
      // 长歪了就会把搜索框盖住，而那正是用户要去点「导出备份」的时候。
      // 这里摘掉 C.toast 强制走 DOM 兜底分支（测完立刻装回去）。
      consoleCollectPaused = true;
      await win.webContents.executeJavaScript(`(() => {
        var saved = window.C && window.C.toast;
        try { if (window.C) delete window.C.toast; } catch (e) {}
        if (typeof window.__HS_STORAGE_ERROR__ === 'function') {
          window.__HS_STORAGE_ERROR__('手机存储空间不足，新数据没能保存。请先「导出备份」，再清理部分物品记录。');
        }
        try { if (window.C && saved) window.C.toast = saved; } catch (e) {}
        return true;
      })()`);
      consoleCollectPaused = false;
      await new Promise((r) => setTimeout(r, 450));
      await shot(win, path.join(SHOT_DIR, '手机-16-存储写满提示条.png'));

      result.shotDir = SHOT_DIR;
    }

    // 底部标签栏实测：9 个标签必须一行排下、不换行、不溢出。
    // 刻意放在截图分支外面 —— 这是布局回归的关键断言，
    // 不开截图（npm test / CI）时同样要跑，否则等于没测。
    // 先把界面恢复到一个「没有弹窗、停在列表页」的干净状态再量，
    // 不然量到的是弹窗下的尺寸，结论不可信。
    await win.webContents.executeJavaScript(`(async () => {
      try { C.close(); } catch (e) {}
      await App.goto('items');
      await new Promise(r => setTimeout(r, 350));
      return true;
    })()`);
    result.navFit = await win.webContents.executeJavaScript(`(() => {
      const bar = document.querySelector('.nav');
      const items = [...document.querySelectorAll('.nav-item')];
      const rect = bar ? bar.getBoundingClientRect() : null;
      return {
        count: items.length,
        labels: items.map(b => (b.textContent || '').trim()),
        barWidth: rect ? Math.round(rect.width) : 0,
        barHeight: rect ? Math.round(rect.height) : 0,
        sumWidth: Math.round(items.reduce((s, b) => s + b.getBoundingClientRect().width, 0)),
        overflowing: items.some(b => {
          const r = b.getBoundingClientRect();
          return rect ? (r.left < rect.left - 1 || r.right > rect.right + 1) : false;
        }),
        wrapped: items.some(b => b.getBoundingClientRect().height > 90)
      };
    })()`);

    // 存储告警兜底提示条的实测。刻意放在截图分支外面：
    // 不开截图（npm test）时同样要跑，否则这条可用性回归等于没测。
    consoleCollectPaused = true;
    result.storageWarnBar = await win.webContents.executeJavaScript(`(() => {
      var out = {};
      var bar = document.getElementById('hs-storage-warn');
      if (!bar) {
        // 没开截图时上面那段没跑，这里补触发一次（同样摘掉 C.toast 走兜底分支）
        var saved = window.C && window.C.toast;
        try { if (window.C) delete window.C.toast; } catch (e) {}
        if (typeof window.__HS_STORAGE_ERROR__ === 'function') {
          window.__HS_STORAGE_ERROR__('手机存储空间不足，新数据没能保存。请先「导出备份」，再清理部分物品记录。');
        }
        try { if (window.C && saved) window.C.toast = saved; } catch (e) {}
        bar = document.getElementById('hs-storage-warn');
      }
      out.shown = !!bar;
      if (!bar) return out;
      var r = bar.getBoundingClientRect();
      out.height = Math.round(r.height);
      out.width = Math.round(r.width);
      out.viewportWidth = window.innerWidth;
      out.text = (bar.textContent || '').trim().slice(0, 60);
      var btn = document.getElementById('hs-storage-warn-close');
      out.hasClose = !!btn;
      if (btn) {
        var br = btn.getBoundingClientRect();
        out.btnW = Math.round(br.width);
        out.btnH = Math.round(br.height);
        btn.click();
        out.closedAfterClick = !document.getElementById('hs-storage-warn');
      }
      return out;
    })()`);
    consoleCollectPaused = false;

    // 同步冲突清单在手机上的排布。
    // 桌面版一行放「名字 + 打开/用副本覆盖/保留/删掉副本」，手机上照搬会把名字挤成一条竖线
    // （踩过同类：导航标签被撑成整屏宽）。这里量真实矩形，别只看 CSS 写没写。
    // 刻意放在截图分支外面 —— 这是布局回归的关键断言，不开截图（npm test）时同样要跑。
    // 放在存储告警条之后：那一段结尾会把提示条关掉，否则它会一直盖在截图上。
    await win.webContents.executeJavaScript(`(async () => {
      try { C.close(); } catch (e) {}
      App.showConflictDialog([
        { id: 'a', name: '海天金标生抽 500ml', scope: 'items', kind: 'goods',
          conflictId: 'a-conflict-1', localAt: '2026-09-14T09:12:00.000Z', remoteAt: '2026-09-15T11:30:00.000Z' },
        { id: 'b', name: '房屋租赁合同', scope: 'items', kind: 'doc',
          conflictId: 'b-conflict-1', localAt: '2026-09-13T20:05:00.000Z', remoteAt: '2026-09-15T11:30:00.000Z' }
      ]);
      await new Promise(r => setTimeout(r, 500));
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    result.conflictFit = await win.webContents.executeJavaScript(`(() => {
      const row = document.querySelector('#modalRoot .conflict-row');
      const main = document.querySelector('#modalRoot .conflict-main');
      const acts = document.querySelector('#modalRoot .conflict-acts');
      if (!row || !main || !acts) return { found: false };
      const r = row.getBoundingClientRect();
      const m = main.getBoundingClientRect();
      const a = acts.getBoundingClientRect();
      const btns = [...acts.querySelectorAll('button')].map(b => b.getBoundingClientRect());
      return {
        found: true,
        rowW: Math.round(r.width),
        rowRight: Math.round(r.right),
        mainW: Math.round(m.width),
        mainBottom: Math.round(m.bottom),
        actsTop: Math.round(a.top),
        actsBelow: a.top >= m.bottom - 1,
        mainFills: m.width >= r.width * 0.85,
        btnCount: btns.length,
        minBtnW: btns.length ? Math.round(Math.min(...btns.map(b => b.width))) : 0,
        // 四个按钮挤不下时不能顶出行外（顶出去就被裁掉，用户根本点不到）
        maxBtnRight: btns.length ? Math.round(Math.max(...btns.map(b => b.right))) : 0
      };
    })()`);
    if (SHOT_DIR) await shot(win, path.join(SHOT_DIR, '手机-17-同步冲突清单.png'));
    await win.webContents.executeJavaScript(`C.close()`);
    await new Promise((r) => setTimeout(r, 300));

    // 物品行第二行（方案 C）：位置 · 字段 · 标签 三层，在真机尺寸下必须**只有一行**。
    // 桌面版靠 flex + nowrap + 省略号保证，但 jsdom 不做布局，测不出来 ——
    // 只能在真实 Chromium 里量高度。第二行一旦折成两三行，整个列表就没法扫了。
    // 顺带验一件 jsdom 验不了的事：标签在手机上还是不是「胶囊」
    // （曾经被 `.item-meta span { display:inline }` 拍成普通文字，桌面有底色、手机没有）。
    await win.webContents.executeJavaScript(`(async () => {
      try { C.close(); } catch (e) {}
      const locs = (await window.api.call('locations.list')).data;
      await window.api.call('items.save', {
        name: '分层测量样本', barcodes: ['6901234567890'], code: 'HS-TEST-0001',
        quantity: 1, unit: '瓶', expiry_date: '2030-01-01',
        location_id: locs[0] ? locs[0].id : null,
        note: '备注也算中间那段字段，看它会不会把整行撑成两行'
      });
      await App.goto('items');
      await new Promise(r => setTimeout(r, 450));
      return true;
    })()`);
    result.metaFit = await win.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll('#view-items .item-row')]
        .find(r => r.textContent.includes('分层测量样本'));
      if (!row) return { found: false };
      const m = row.querySelector('.item-meta');
      if (!m) return { found: false, reason: 'no .item-meta' };
      const loc = m.querySelector('.item-meta-loc');
      const fields = m.querySelector('.item-meta-fields');
      const tag = m.querySelector('.tag');
      const mRect = m.getBoundingClientRect();
      // 用「位置那一行」的高度当一行文字的高度：line-height 可能是 normal，
      // parseFloat 会得到 NaN，拿它算行数会永远「通过」（假绿）。
      const locH = loc ? loc.getBoundingClientRect().height : 0;
      const cs = tag ? getComputedStyle(tag) : null;
      return {
        found: true,
        metaHeight: Math.round(mRect.height),
        locHeight: Math.round(locH),
        lines: locH > 0 ? Math.round(mRect.height / locH) : -1,
        locFirst: m.firstElementChild === loc,
        locDimmer: !!loc && getComputedStyle(loc).color !== getComputedStyle(m).color,
        locColor: loc ? getComputedStyle(loc).color : '',
        metaColor: getComputedStyle(m).color,
        // 旧的那条「.item-meta span { margin-right: 10px }」会加在每一段上。
        // 它的优先级比 .item-meta-loc / .item-meta-fields 高，会**静默**盖掉它们的 display，
        // 所以「有没有被加回来」只能靠量真实外边距（display 测不出来：
        // flex 子项会被 blockify，inline 和 inline-flex 算出来都可能是 block）。
        locMargin: loc ? getComputedStyle(loc).marginRight : '',
        fieldsMargin: fields ? getComputedStyle(fields).marginRight : '',
        tagBg: cs ? cs.backgroundColor : '',
        hasSeparator: /·/.test(fields ? fields.textContent : ''),
        tagDisplay: cs ? cs.display : '',
        tagRadius: cs ? cs.borderRadius : '',
        tagW: tag ? Math.round(tag.getBoundingClientRect().width) : 0,
        rowRight: Math.round(row.getBoundingClientRect().right),
        viewW: document.documentElement.clientWidth
      };
    })()`);

    console.log('MUI_RESULT: ' + JSON.stringify(result));
  } catch (e) {
    console.log('MUI_ERROR: ' + String((e && e.message) || e));
  }

  // 收工。
  // 注意：本机 Electron 上，只要主进程起过本地 http 服务、页面又真的连过它，
  // 这两个调用之后进程往往不会真的退出（探针脚本单独复现过：before-quit /
  // will-quit / quit 三个事件全都打出来了，electron.exe 仍然留在进程表里）。
  // 所以父进程（test/test-mobile-ui.js）**不等这个进程退出**，它一看到
  // MUI_RESULT 就收工并把它杀掉 —— 否则整套测试要白等 120 秒超时，
  // 而机器一慢，超时还可能先到，那就会被当成「没有图形环境」放过（假绿）。
  server.close();
  app.quit();
});
