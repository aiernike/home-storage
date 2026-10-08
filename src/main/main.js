'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = process.argv.includes('--dev');

/* ==========================================================================
 * Windows 通知的应用标识（AppUserModelID）
 * --------------------------------------------------------------------------
 * 这个值必须和 package.json 里的 build.appId 完全一致 —— electron-builder 的
 * NSIS 安装器把「开始菜单快捷方式」的 AUMID 设成 appId。两边对不上时：
 *   · Windows 10/11：通知不显示应用图标，顶着 electron.app.Electron 的身份出现
 *   · 点击通知回不到本应用 —— Windows 是靠 AUMID 认「这条通知是谁发的」
 *   · Windows 8/8.1：通知干脆不显示
 * 而临期提醒正是靠通知送达的。
 *
 * Electron 只在检测到 **Squirrel** 安装器时才会自动设好这个值，NSIS 不在自动处理
 * 范围内，必须自己调；而且要在主进程里、**任何窗口打开之前**调（官方文档的说法是
 * 「通常是第一段执行的代码」）。
 *
 * test-packaging.js 有三条断言盯着这里：值要和 build.appId 一致、且必须排在
 * new BrowserWindow 之前。改一处会红。
 * ========================================================================== */
const APP_USER_MODEL_ID = 'com.home.storage';
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

// 端到端测试模式：从配置文件读取独立数据目录与截图目录
const isE2E = process.env.HS_E2E === '1';
let e2eConfig = null;
if (isE2E && process.env.HS_E2E_CONFIG) {
  try {
    e2eConfig = JSON.parse(require('fs').readFileSync(process.env.HS_E2E_CONFIG, 'utf8'));
  } catch (e) {
    console.error('读取 E2E 配置失败', e);
  }
}

let mainWindow = null;
let store = null;

/**
 * 端到端测试用独立的数据目录，避免污染用户的真实数据。
 *
 * 这个方法必须在模块作用域调用（也就是在 app ready 之前），
 * 因为紧接着要取的单实例锁是**按 userData 路径分区**的 ——
 * 如果等 ready 之后再改 userData，锁已经按默认目录取过了，
 * 跑测试时就会去跟用户正在用的那个实例抢锁，测试直接起不来。
 *
 * （`app.setPath` / `app.getPath` 在模块作用域是能用的，已实测。）
 */
function applyE2EPaths() {
  if (e2eConfig && e2eConfig.userData) {
    app.setPath('userData', e2eConfig.userData);
  }
}

applyE2EPaths();

/* ==========================================================================
 * 只允许跑一个实例
 * --------------------------------------------------------------------------
 * 为什么必须有：数据是「整个库常驻内存 + 全量落盘」，两个实例各持一份内存副本，
 * 谁后落盘谁覆盖 —— 在 A 里加的东西会被 B 的落盘悄悄抹掉，而两边界面上都看不出来
 * （列表里就是少了一条，没有任何提示）。它们还会同时写同一个 storage.json.tmp
 * （先写 tmp 再 rename），存在写坏的可能。
 *
 * 用户很容易撞上：双击图标没反应就再点一下、反复点任务栏图标、
 * 装完之后从安装器启动一次又从桌面启动一次。
 *
 * 第二个实例不开新窗口，而是把已有窗口叫到前台 —— 这才是用户点图标时的预期。
 * ========================================================================== */
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // 端到端测试靠这行判断「第二个实例确实被挡在外面了」。
  // 它是 Electron 真的返回了 false 才会打出来的，不是把代码回显一遍。
  if (isE2E) console.log('E2E_LOCK: blocked');
  app.quit();
} else {
  if (isE2E) console.log('E2E_LOCK: primary');
  app.on('second-instance', () => {
    if (isE2E) console.log('E2E_LOCK: second-instance');
    focusView();
  });
}

/**
 * 把主窗口叫到前台，可选地跳到某个页面。
 *
 * 「用户又点了一次图标」和「用户点了临期通知」都要走这里 —— 两处各写一遍迟早会漂。
 * 以前就是只有前者：通知文案写着「点击查看详情」，点下去什么都不会发生。
 */
function focusView(view) {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (!view) return;
  // 渲染层可能还没加载完，App 不存在时安静跳过 —— 不要让异常冒到主进程。
  const js = `(typeof App !== 'undefined' && App.goto) ? App.goto(${JSON.stringify(view)}) : null`;
  try {
    const p = mainWindow.webContents.executeJavaScript(js);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 620,
    title: '家庭收纳',
    backgroundColor: '#f5f5f3',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

let sync = null;

function bootstrap() {
  const { createStore } = require('./store');
  const { createSync } = require('./sync');
  store = createStore(app.getPath('userData'));
  sync = createSync(store);
  registerIpc();

  createWindow();
  startExpiryWatcher();

  if (isE2E) {
    // HS_E2E_QUIT 是「退出前落盘」的专项自检，走另一条探针（见 runE2EQuitProbe）。
    if (process.env.HS_E2E_QUIT === '1') runE2EQuitProbe();
    else runE2EProbe();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

if (gotSingleInstanceLock) {
  app.whenReady().then(bootstrap);
}

// 端到端自检：在真实 Electron 环境里验证界面与数据通道
function runE2EProbe() {
  const go = async () => {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const result = await mainWindow.webContents.executeJavaScript(`(async () => {
        const out = {};
        out.hasApp = typeof App !== 'undefined';
        out.hasViews = typeof Views !== 'undefined';
        out.views = typeof Views !== 'undefined' ? Object.keys(Views).filter(k => typeof Views[k] === 'function') : [];
        out.hasApi = typeof window.api !== 'undefined';
        out.locNodes = document.querySelectorAll('#locTree .loc-node').length;
        out.navItems = document.querySelectorAll('.nav-item').length;
        out.dashboardText = (document.getElementById('view-dashboard') || {}).textContent || '';
        out.title = document.title;
        // 可见性检查：确保弹窗遮罩没有误显示（曾因 .modal-root 的 display:flex
        // 覆盖 HTML 的 hidden 属性，导致整个界面被灰色遮罩盖住）
        const mr = document.getElementById('modalRoot');
        if (mr) {
          const r = mr.getBoundingClientRect();
          out.modalVisible = r.width > 0 && r.height > 0;
        }
        if (out.hasApi) {
          const r1 = await window.api.call('app.summary');
          out.summaryOk = r1.ok;
          out.summaryItems = r1.ok ? r1.data.items : -1;
          const r2 = await window.api.call('locations.tree');
          out.locationsOk = r2.ok;
          out.topLocations = r2.ok ? r2.data.map(n => n.name) : [];
          const r3 = await window.api.call('items.save', { name: 'E2E测试物品', barcodes: ['1234567890128'], quantity: 3 });
          out.saveOk = r3.ok;
          out.savedName = r3.ok ? r3.data.name : (r3.error || '');
          const r4 = await window.api.call('items.byBarcode', { barcode: '1234567890128' });
          out.lookupOk = r4.ok && r4.data && r4.data.name === 'E2E测试物品';
          const r5 = await window.api.appInfo();
          out.appInfoOk = !!r5.version;
          const r6 = await window.api.call('locations.save', { name: 'E2E位置' });
          out.locSaveOk = r6.ok;
          const r7 = await window.api.call('items.stats');
          out.statsOk = r7.ok;
          const r8 = await window.api.call('app.export');
          out.exportOk = r8.ok;
        }
        return out;
      })()`);

      // ---- 主进程侧：临期提醒的文案与通知点击 ----
      // 这几项只有主进程验得了：文案是主进程拼的，通知点击也是主进程接的。
      result.reminder = {
        mixed: buildExpiryReminder([{ days_left: -3 }, { days_left: 2 }]),
        expiredOnly: buildExpiryReminder([{ days_left: -1 }, { days_left: -10 }]),
        soonOnly: buildExpiryReminder([{ days_left: 1 }, { days_left: 5 }]),
        empty: buildExpiryReminder([])
      };

      // 造一条通知但**不 show**（免得测试时真的弹到桌面上），直接点它一下，
      // 看渲染层有没有真的跳到临期页 —— 文案承诺了「点击查看详情」。
      const notif = buildExpiryNotification({ title: '探针', body: '探针', view: 'expiry' });
      result.notifyClickWired = !!(notif && notif.listenerCount('click') > 0);
      if (notif) notif.emit('click');

      // 跳页是异步的，轮询等它到位（不靠固定 sleep 猜）
      let viewAfter = '';
      for (let i = 0; i < 15; i++) {
        viewAfter = await mainWindow.webContents.executeJavaScript(
          '(typeof App !== "undefined" && App.state) ? App.state.view : ""'
        );
        if (viewAfter === 'expiry') break;
        await new Promise((r) => setTimeout(r, 200));
      }
      result.viewAfterNotifyClick = viewAfter;

      // ---- 扫码枪：真实的键盘输入不能污染正在填的输入框 ----
      //
      // 这一段只有真实 Electron 验得了。jsdom 不会执行「把字符插进输入框」这个
      // 默认动作，所以那边只能断言 defaultPrevented === true（一个代理指标）；
      // 这里用 sendInputEvent 走真实的键盘输入路径，能直接看出输入框里到底有没有
      // 被灌进一串数字 —— 这正是「扫码枪会污染表单」这个问题的全部要害。
      result.scannerFocus = await mainWindow.webContents.executeJavaScript(`(() => {
        App.state.settings.scannerPrefix = '$';
        window.__scanHits = [];
        window.Views._handleCode = async (el, state, code, format, from) => {
          window.__scanHits.push(code + '|' + from);
        };
        const inp = document.createElement('input');
        inp.id = 'e2eScanProbe';
        inp.value = '';
        document.body.appendChild(inp);
        inp.focus();
        return document.activeElement === inp;
      })()`);

      // 扫码枪就是「飞快地敲一串字符，最后补一个回车」
      for (const ch of '$6901234567892') {
        mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch });
        mainWindow.webContents.sendInputEvent({ type: 'char', keyCode: ch });
        mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch });
      }
      mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

      await new Promise((r) => setTimeout(r, 600));
      result.scanner = await mainWindow.webContents.executeJavaScript(`(() => {
        const inp = document.getElementById('e2eScanProbe');
        const typed = inp ? inp.value : '<没有输入框>';
        if (inp) inp.remove();
        return { hits: window.__scanHits || [], typed: typed };
      })()`);

      // ---- ISBN 联网查询：非法 ISBN 在本地就被挡下，连网络都不碰 ----
      // 走的是**真实**的 handler（截图用的 fixture 只认一个特定 ISBN，这里传的不是它）。
      // 所以这条断网也能跑，而且不会白等 6 秒超时。
      result.isbnBad = await mainWindow.webContents.executeJavaScript(
        "window.api.lookupIsbn('123')"
      );

      console.log('E2E_RESULT: ' + JSON.stringify(result));
      const shotDir = e2eConfig && e2eConfig.shotDir;
      if (shotDir) {
        await captureScreenshots(shotDir);
      }
    } catch (e) {
      console.log('E2E_ERROR: ' + e.message);
    }
    setTimeout(() => app.exit(0), 400);
  };

  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', go);
  } else {
    go();
  }
}

// 退出落盘自检（HS_E2E_QUIT=1）
//
// 验的是「改完一条记录立刻关窗口，改动还在不在」。store 的落盘是 120ms 防抖，
// 所以「写内存」和「写文件」之间有一个窗口期；如果退出时不等定时器醒，那次修改
// 就永久丢了，而界面刚才明明显示过「保存成功」。
//
// 为什么不在外面「写完等一会儿再看文件」：那样测的是定时器自己会醒，跟退出路径
// 一点关系都没有，把 before-quit 里的 saveNow() 删掉照样绿。
// 这里必须证明两件事，而且都要在同一个同步块里：
//   1) 调 app.quit() 之前，改动**还没**落盘（证明我们真的处在防抖窗口内）
//   2) before-quit 处理器跑起来时，改动**已经**落盘（证明退出路径把它写下去了）
// 因为中间没有任何 await/定时器机会，这两条不受机器快慢影响。
function runE2EQuitProbe() {
  const out = { probe: 'quit-save' };
  // 用 store 自己暴露的路径，别自己拼 —— 数据文件在 <userData>/data/storage.json，
  // 拼错了会得到一个「读不到任何东西」的空文件，两条断言都会变成假绿。
  const file = store.dataFile;
  const read = () => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (e) {
      return '';
    }
  };
  const MARK = '退出落盘探针';

  const go = async () => {
    try {
      await store.handle('items.save', { name: MARK, kind: 'goods', quantity: 1 });
    } catch (e) {
      out.saveError = String((e && e.message) || e);
    }

    // (1) 此刻应当还没落盘。落盘了说明防抖没生效，这条自检就没有意义了。
    out.pendingBeforeQuit = !read().includes(MARK);

    // 这个处理器注册得比上面那个（模块作用域里的 before-quit）晚，
    // 所以一定在它之后执行 —— 轮到我们时，saveNow() 已经跑过了。
    app.on('before-quit', () => {
      out.savedAtBeforeQuit = read().includes(MARK);
      console.log('E2E_QUIT_RESULT: ' + JSON.stringify(out));
    });

    app.quit();
  };

  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', go);
  } else {
    go();
  }
}

// 截取各页面截图，用于展示实际界面
//
// 稳定性说明（踩过的坑）：
// 1) 无可见桌面 / 关闭 GPU 时 requestAnimationFrame 可能永远不触发，
//    直接 await 它会把整个截图流程卡死，一张图都留不下 → 必须有超时兜底。
// 2) 同理，任何 executeJavaScript 都可能因为渲染进程卡住而不返回，
//    所以统一走 js() 包装，超时就跳过这一步继续往下走。
// 3) 窗口不可见时 Chromium 不产帧，capturePage 会拿到上一帧
//    （表现为两个页面的 PNG 字节数完全相同）→ 截图前 invalidate() 强制合成。
async function captureScreenshots(dir) {
  const fsx = require('fs');
  const pathx = require('path');
  if (!fsx.existsSync(dir)) fsx.mkdirSync(dir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // 窗口不可见时 Chromium 会节流渲染，capturePage 只能拿到上一帧
  // （表现为后面几张 PNG 字节数完全一样）。关掉节流并显式把窗口亮出来。
  try { mainWindow.webContents.setBackgroundThrottling(false); } catch (e) {}
  try { mainWindow.show(); mainWindow.focus(); } catch (e) {}
  await wait(400);

  // 带超时的 executeJavaScript：渲染进程卡住时不让整个流程陪葬
  const js = async (code, ms) => {
    ms = ms || 8000;
    let timer = null;
    const timeout = new Promise((r) => { timer = setTimeout(() => r('__TIMEOUT__'), ms); });
    try {
      const v = await Promise.race([mainWindow.webContents.executeJavaScript(code), timeout]);
      if (v === '__TIMEOUT__') console.log('SHOT_WARN: 脚本超时（' + ms + 'ms），跳过');
      return v;
    } catch (e) {
      console.log('SHOT_WARN: 脚本报错 ' + ((e && e.message) || e));
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  // 截图并落盘；返回是否拿到非空画面
  const shot = async (file) => {
    try { mainWindow.webContents.invalidate(); } catch (e) {}
    await wait(180);
    let buf = null;
    try { buf = (await mainWindow.webContents.capturePage()).toPNG(); } catch (e) {}
    if (buf && buf.length > 1000) {
      fsx.writeFileSync(pathx.join(dir, file), buf);
      console.log('SHOT: ' + file + ' (' + buf.length + ' bytes)');
      return true;
    }
    console.log('SHOT_SKIP: ' + file + ' (画面为空)');
    return false;
  };

  // 等页面真正渲染出来（有内容、不是「加载中」）
  const waitReady = async (view) => {
    for (let i = 0; i < 20; i++) {
      await wait(250);
      const ready = await js(`(() => {
        const el = document.getElementById('view-${view}');
        if (!el || el.hidden) return false;
        const t = el.textContent || '';
        return t.length > 40 && t.indexOf('加载中') < 0;
      })()`, 4000);
      if (ready === true) return;
    }
  };

  console.log('SHOT_DEBUG: 填充演示数据');
  await js(`(async () => {
    const locs = (await window.api.call('locations.list')).data;
    const cats = (await window.api.call('categories.list')).data;
    const find = (n) => locs.find(l => l.path.endsWith(n));
    const cold = find('冷藏室');
    const shelf = find('A 区');
    const bath = find('第一层');
    const tv = find('电视柜');
    const cab = find('橱柜');
    const drawer = find('床头柜');
    const food = cats.find(c => c.name === '食品饮料');
    const med = cats.find(c => c.name === '药品保健');
    const daily = cats.find(c => c.name === '洗护日化');
    const clean = cats.find(c => c.name === '清洁用品');
    const fm = (d) => { const x = new Date(); x.setDate(x.getDate() + d);
      return x.getFullYear() + '-' + String(x.getMonth()+1).padStart(2,'0') + '-' + String(x.getDate()).padStart(2,'0'); };
    const data = [
      ['海天金标生抽 500ml','6901234567892',food,cold,2,'瓶',fm(-3),18.8],
      ['伊利纯牛奶 250ml*12','6909876543212',food,cold,1,'箱',fm(4),49.9],
      ['五常大米 5kg','6923456789012',food,shelf,3,'袋',fm(210),59.0],
      ['布洛芬缓释胶囊','6912345678902',med,bath,2,'盒',fm(28),22.5],
      ['云南白药创可贴','6924567890123',med,bath,1,'盒',fm(365),15.0],
      ['蓝月亮洗衣液 3kg','6934567890122',daily,tv,1,'瓶',fm(540),39.9],
      ['威露士消毒液 1.5L','6945678901232',clean,shelf,2,'瓶',fm(300),35.0],
      ['7号南孚电池 8粒','6956789012342',null,tv,4,'排',fm(1000),19.9],
      ['舒肤佳沐浴露 1L','6967890123452',daily,bath,1,'瓶',fm(-1),29.9],
      ['洁云抽纸 3层*24包','6978901234562',daily,tv,2,'提',fm(900),45.0]
    ];
    for (const [name, barcode, cat, loc, qty, unit, expiry, price] of data) {
      await window.api.call('items.save', {
        name, barcodes: [barcode],
        category_id: cat ? cat.id : null,
        location_id: loc ? loc.id : null,
        quantity: qty, unit, expiry_date: expiry, price
      });
    }

    // 办公资料 / 图书：这两个栏目靠 kind 区分，截图里要有真实数据才看得出效果
    const cOf = (n) => cats.find(c => c.name === n);
    const docs = [
      ['房屋租赁合同', cOf('合同协议'), cab, '份',
        { doc_no: 'HT-2026-018', year: '2026', org: '某某物业管理公司', amount: '48000', keep_until: '2031-12-31' }, 'contract'],
      ['2026年3月记账凭证', cOf('记账凭证'), drawer, '册',
        { doc_no: 'JZ-2026-03', year: '2026', org: '本公司财务', amount: '18650.5', keep_until: '2046-03-31' }, 'ledger'],
      ['2025年度企业所得税申报表', cOf('报税资料'), drawer, '份',
        { year: '2025', org: '国家税务总局', amount: '3200', keep_until: '2035-12-31' }, 'tax'],
      ['不动产权证书复印件', cOf('资质证照'), cab, '份',
        { doc_no: 'ZZ-2019-0071', year: '2019', org: '市不动产登记中心', keep_until: '2039-06-30' }, 'certificate'],
      ['员工入职登记表（2024）', cOf('人事档案'), drawer, '份',
        { year: '2024', org: '人力资源部' }, 'folder']
    ];
    for (const [name, cat, loc, unit, extra, icon] of docs) {
      await window.api.call('items.save', {
        name, kind: 'doc', icon, unit, quantity: 1,
        category_id: cat ? cat.id : null,
        location_id: loc ? loc.id : null,
        extra
      });
    }
    const books = [
      ['深入理解计算机系统', '9787111544937', cOf('图书'), cab, { author: 'Randal E. Bryant', publisher: '机械工业出版社', pub_year: '2016', status: '在读' }, 'book', 139],
      ['人类简史', '9787508647357', cOf('图书'), cab, { author: '尤瓦尔·赫拉利', publisher: '中信出版社', pub_year: '2014', status: '已读' }, 'book', 68],
      ['线性代数（第六版）', '9787040396614', cOf('教材教辅'), drawer, { author: '同济大学数学系', publisher: '高等教育出版社', pub_year: '2014', status: '未读' }, 'textbook', 42.5],
      // 杂志没有 ISBN，封面印的是 977 开头的期刊条码（ISSN 1009-6337 的中国国家地理）
      ['中国国家地理 2026年第8期', '9771009633018', cOf('杂志期刊'), tv, { publisher: '中国国家地理杂志社', pub_year: '2026', status: '在读' }, 'magazine', 30],
      ['设计中的设计', '9787532751631', cOf('图书'), drawer, { author: '原研哉', publisher: '上海译文出版社', pub_year: '2011', status: '借出' }, 'bookopen', 58]
    ];
    for (const [name, barcode, cat, loc, extra, icon, price] of books) {
      await window.api.call('items.save', {
        name, kind: 'book', icon, barcodes: [barcode], unit: '本', quantity: 1,
        category_id: cat ? cat.id : null,
        location_id: loc ? loc.id : null,
        price, extra
      });
    }
    return true;
  })()`, 30000);

  const shots = [
    ['dashboard', '01-总览.png'],
    ['items', '02-物品清单.png'],
    ['docs', '03-办公资料.png'],
    ['books', '04-图书.png'],
    ['scan', '05-扫码录入.png'],
    ['expiry', '06-保质期.png'],
    ['locations', '07-位置管理.png'],
    ['stats', '08-统计.png'],
    ['settings', '09-设置.png']
  ];

  for (const [view, file] of shots) {
    await js(`App.goto('${view}')`);
    await waitReady(view);
    await wait(500);
    await shot(file);
  }

  // 物品编辑弹窗。
  // 注意：openItemEditor 返回的 Promise 要等弹窗「关闭」才 resolve，
  // await 它会把流程卡住直到超时，所以这里不 await。
  await js(`(async () => {
    await App.goto('items');
    await new Promise(r => setTimeout(r, 500));
    const rows = document.querySelectorAll('#view-items .item-row');
    if (rows.length) App.openItemEditor(rows[0].dataset.item);
    await new Promise(r => setTimeout(r, 700));
    return !!document.querySelector('#modalRoot .modal-box .form-row');
  })()`, 15000);
  await wait(900);
  await shot('10-物品详情.png');
  // 关掉弹窗，否则后面几张截到的还是这个弹窗
  await js(`C.close()`);
  await wait(400);

  // 图标选择器：物品编辑器里的「选择图标」
  const iconPickOk = await js(`(async () => {
    await App.goto('items');
    await new Promise(r => setTimeout(r, 600));
    const rows = document.querySelectorAll('#view-items .item-row');
    if (rows.length) App.openItemEditor(rows[0].dataset.item);
    await new Promise(r => setTimeout(r, 800));
    const b = document.querySelector('#modalRoot #btnPickIcon');
    if (!b) return false;
    b.click();
    await new Promise(r => setTimeout(r, 800));
    return !!document.querySelector('#modalRoot .icon-picker-grid');
  })()`, 15000);
  await wait(700);
  if (iconPickOk) await shot('11-图标选择器.png');
  else console.log('SHOT_SKIP: 11-图标选择器.png (图标选择器没弹出)');
  await js(`C.close()`);
  await wait(300);

  // 新增资料：验证编辑器按 kind 换字段（文件编号 / 保管期限，没有生产日期）
  const docEditorOk = await js(`(async () => {
    App.openItemEditor(null, { kind: 'doc' });
    await new Promise(r => setTimeout(r, 900));
    return !!document.querySelector('#modalRoot [data-k="x_keep_until"]');
  })()`, 15000);
  await wait(700);
  if (docEditorOk) await shot('12-新增资料.png');
  else console.log('SHOT_SKIP: 12-新增资料.png (资料编辑器没弹出)');
  await js(`C.close()`);
  await wait(300);

  // 新增图书：字段换成作者/出版社/ISBN
  const bookEditorOk = await js(`(async () => {
    App.openItemEditor(null, { kind: 'book' });
    await new Promise(r => setTimeout(r, 900));
    return !!document.querySelector('#modalRoot [data-k="x_status"]');
  })()`, 15000);
  await wait(700);
  if (bookEditorOk) await shot('13-新增图书.png');
  else console.log('SHOT_SKIP: 13-新增图书.png (图书编辑器没弹出)');
  await js(`C.close()`);
  await wait(300);

  // 扫到书背 ISBN 之后，联网把书名 / 作者 / 出版社 / 出版年补上。
  // 截图环境没有外网，所以查询结果来自主进程里那份 fixture —— 这一张只为看界面。
  // 补全的行为在 test-ui 的 [UI-17b] 里逐条测，主进程那条 IPC 由 [E2E-7] 盯着。
  const isbnShotOk = await js(`(async () => {
    App.openItemEditor(null, {
      kind: 'book',
      barcode: '9787111544937',
      barcodes: ['9787111544937'],
      lookupIsbn: '9787111544937'
    });
    await new Promise(r => setTimeout(r, 1500));
    // 补全的是靠后的字段（作者 / 出版社 / 出版年）和末尾的提示行，
    // 表单默认停在顶部，不滚下去就截不到 —— 那样这张图等于白截。
    const body = document.querySelector('#modalRoot .modal-body');
    if (body) body.scrollTop = body.scrollHeight;
    await new Promise(r => setTimeout(r, 300));
    return !!document.querySelector('#modalRoot #isbnLookupHint');
  })()`, 15000);
  await wait(700);
  if (isbnShotOk) await shot('13b-图书自动填全.png');
  else console.log('SHOT_SKIP: 13b-图书自动填全.png (表单没打开)');
  await js(`C.close()`);
  await wait(300);

  // 同步冲突清单：同一条记录两台设备都改过时弹出来的那个窗口。
  // 这里的数据是造的（真造一条冲突要走一遍同步 + 起一个假服务端），只为截界面；
  // 弹窗的行为本身在 test-ui 的 [UI-20] 里逐条测。
  // 同样不能 await —— 它的 Promise 要等用户点掉弹窗才 resolve。
  const cfOk = await js(`(async () => {
    App.showConflictDialog([
      { id: 'a', name: '海天金标生抽 500ml', scope: 'items', kind: 'goods',
        conflictId: 'a-conflict-1', localAt: '2026-09-14T09:12:00.000Z', remoteAt: '2026-09-15T11:30:00.000Z' },
      { id: 'b', name: '房屋租赁合同', scope: 'items', kind: 'doc',
        conflictId: 'b-conflict-1', localAt: '2026-09-13T20:05:00.000Z', remoteAt: '2026-09-15T11:30:00.000Z' },
      { id: 'c', name: '阳台柜', scope: 'locations', kind: '',
        conflictId: 'c-conflict-1', localAt: '2026-09-15T08:00:00.000Z', remoteAt: '2026-09-15T11:30:00.000Z' }
    ]);
    await new Promise(r => setTimeout(r, 800));
    return document.querySelectorAll('#modalRoot .conflict-row').length;
  })()`, 15000);
  await wait(800);
  if (cfOk === 3) await shot('18-同步冲突清单.png');
  else console.log('SHOT_SKIP: 18-同步冲突清单.png (清单没弹出，拿到 ' + cfOk + ')');
  await js(`C.close()`);
  await wait(300);

  // ---- 新功能截图：物品图片 + 二维码 ----
  // 用 canvas 造一张「照片」（不依赖外部图片文件），存进物品，
  // 再分别截「列表缩略图 / 点开看大图 / 位置二维码 / 编辑器里的图片行」。
  console.log('SHOT_DEBUG: 造演示图片');
  const madeImg = await js(`(async () => {
    const mk = (label, bg) => {
      const c = document.createElement('canvas');
      c.width = 640; c.height = 480;
      const g = c.getContext('2d');
      g.fillStyle = bg; g.fillRect(0, 0, 640, 480);
      g.fillStyle = 'rgba(255,255,255,.85)';
      g.fillRect(40, 40, 560, 400);
      g.fillStyle = '#2b2b2b'; g.font = 'bold 44px sans-serif';
      g.fillText(label, 90, 250);
      g.font = '26px sans-serif'; g.fillStyle = '#666';
      g.fillText('示例照片', 90, 300);
      const full = c.toDataURL('image/jpeg', 0.8);
      const t = document.createElement('canvas');
      t.width = 160; t.height = 120;
      t.getContext('2d').drawImage(c, 0, 0, 160, 120);
      return { full, thumb: t.toDataURL('image/jpeg', 0.6), w: 640, h: 480 };
    };
    const list = (await window.api.call('items.list')).data;
    const milk = list.find(i => i.name.indexOf('牛奶') >= 0) || list[0];
    const rice = list.find(i => i.name.indexOf('大米') >= 0) || list[1];
    if (milk) await window.api.call('images.save', Object.assign({ item_id: milk.id }, mk('牛奶', '#cfe8ff')));
    if (rice) await window.api.call('images.save', Object.assign({ item_id: rice.id }, mk('大米', '#ffe9c9')));
    const after = (await window.api.call('items.list')).data;
    return after.filter(i => i.has_image).length;
  })()`, 20000);
  console.log('SHOT_DEBUG: 带图物品数 = ' + madeImg);

  await js(`App.goto('items')`);
  await waitReady('items');
  await wait(600);
  await shot('14-物品清单-缩略图.png');

  // 点缩略图 → 看大图
  const opened = await js(`(async () => {
    const t = document.querySelector('#view-items [data-thumb]');
    if (!t) return false;
    t.click();
    await new Promise(r => setTimeout(r, 700));
    return !!document.querySelector('#modalRoot .img-view');
  })()`, 12000);
  await wait(400);
  if (opened) await shot('15-查看大图.png');
  else console.log('SHOT_SKIP: 15-查看大图.png (缩略图没打开)');
  await js(`C.close()`);
  await wait(300);

  // 位置二维码
  const qrOk = await js(`(async () => {
    await App.goto('locations');
    await new Promise(r => setTimeout(r, 700));
    const b = document.querySelector('#treeEditor [data-qr]');
    if (!b) return false;
    b.click();
    await new Promise(r => setTimeout(r, 700));
    return !!document.querySelector('#modalRoot .qr-box');
  })()`, 15000);
  await wait(400);
  if (qrOk) await shot('16-位置二维码.png');
  else console.log('SHOT_SKIP: 16-位置二维码.png (二维码没弹出)');
  await js(`C.close()`);
  await wait(300);

  // 物品编辑器里的图片行（同样不要 await 弹窗 Promise）
  await js(`(async () => {
    await App.goto('items');
    await new Promise(r => setTimeout(r, 700));
    const list = (await window.api.call('items.list')).data;
    const withImg = list.find(i => i.has_image) || list[0];
    if (withImg) App.openItemEditor(withImg.id);
    await new Promise(r => setTimeout(r, 800));
    return !!document.querySelector('#modalRoot .img-edit');
  })()`, 15000);
  await wait(1000);
  await shot('17-物品图片编辑.png');
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/**
 * 退出前把还没落盘的数据写下去。
 *
 * store 的落盘是 120ms 防抖（合并短时间内的多次写入），所以「刚改完就关窗口」
 * 有一个 120 毫秒的窗口期：定时器还没醒，进程已经没了，那次修改永远写不进去 ——
 * 而且用户完全看不出来（界面刚才明明显示保存成功了）。
 * 触发路径很平常：改完一条记录顺手 Alt+F4 / 点右上角叉。
 *
 * 关窗口 → window-all-closed → app.quit() → before-quit，挂在这里能覆盖
 * Windows / Linux 的关窗口退出；macOS 关窗口不退进程，定时器本来就会醒。
 */
app.on('before-quit', () => {
  try {
    if (store && typeof store.saveNow === 'function') store.saveNow();
  } catch (e) {
    console.error('退出前保存失败', e);
  }
});

function registerIpc() {
  ipcMain.handle('db:call', async (_e, action, payload) => {
    try {
      const data = await store.handle(action, payload || {});
      return { ok: true, data };
    } catch (err) {
      console.error('[db:call]', action, err);
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle('dialog:export', async (_e, { defaultName, content }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath: defaultName || 'home-storage-backup.json',
      filters: [
        { name: 'JSON 备份', extensions: ['json'] },
        { name: 'CSV 表格', extensions: ['csv'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true, filePath };
  });

  ipcMain.handle('dialog:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'JSON 备份', extensions: ['json'] },
        { name: 'CSV 表格', extensions: ['csv'] }
      ]
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };
    const content = fs.readFileSync(filePaths[0], 'utf8');
    return { ok: true, filePath: filePaths[0], content };
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    userData: app.getPath('userData'),
    platform: process.platform
  }));

  ipcMain.handle('notify', (_e, { title, body }) => {
    if (!Notification.isSupported()) return { ok: false };
    new Notification({ title, body }).show();
    return { ok: true };
  });

  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));

  // ---- 图书 ISBN 联网查询（可选增强）----
  //
  // 放在主进程是因为渲染进程不碰网络：它是 file:// 源，直接 fetch 外部 https
  // 会被 CORS/CSP 拦掉；而且主进程本来就有原生 http/https 可用。
  //
  // 这里**一个异常都不往外抛**：断网、超时、接口挂了都只是「没查到」。
  // 这是可选增强，绝不能因为它让渲染层的扫码流程报错。
  const isbnLookup = (() => {
    let mod = null;
    return () => {
      if (!mod) {
        mod = require('./isbn').createIsbnLookup({
          http: require('http'),
          https: require('https'),
          timeout: 6000
        });
      }
      return mod;
    };
  })();
  ipcMain.handle('isbn:lookup', async (_e, { isbn } = {}) => {
    try {
      // 截图环境没有外网，用一份固定数据顶上（只在带 HS_SHOT_DIR 跑的时候由测试写进配置）。
      // ⚠️ 只对 fixture 里指定的那**一个** ISBN 生效，其余一律走真实查询 ——
      // 这样「真实路径」在自动化里仍然是活的（探针里的 isbnBad 就是走它验的）。
      const fx = e2eConfig && e2eConfig.isbnFixture;
      if (fx && isbn === fx.isbn) return fx.result;
      return await isbnLookup().lookup(isbn);
    } catch (e) {
      return { ok: false, reason: 'offline' };
    }
  });

  // ---- 同步相关 ----
  const wrap = (fn) => async (_e, payload) => {
    try {
      return { ok: true, data: await fn(payload || {}) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  };

  ipcMain.handle(
    'sync:test',
    wrap(async (p) => sync.test(p.url))
  );
  ipcMain.handle(
    'sync:login',
    wrap(async (p) => {
      const res = await sync.login(p.url, p.username, p.password, p.deviceName);
      return res;
    })
  );
  ipcMain.handle(
    'sync:register',
    wrap(async (p) => sync.register(p.url, p.username, p.password))
  );
  ipcMain.handle(
    'sync:run',
    wrap(async () => sync.sync())
  );
}

/**
 * 临期提醒的文案与点击目标（纯函数，单独可验证）。
 *
 * 没有临期物品时返回 null —— 调用方据此决定「不发通知」，
 * 而不是发一条「0 件即将到期」的空通知。
 */
function buildExpiryReminder(list) {
  const rows = list || [];
  const expired = rows.filter((i) => i.days_left < 0).length;
  const soon = rows.length - expired;
  const parts = [];
  if (expired) parts.push(`${expired} 件已过期`);
  if (soon) parts.push(`${soon} 件即将到期`);
  if (!parts.length) return null;
  return {
    title: '家庭收纳 · 保质期提醒',
    body: parts.join('，') + '，点击查看详情',
    view: 'expiry'
  };
}

/**
 * 造一条临期提醒通知（**不 show**，方便测试里 emit('click') 验证点击行为）。
 * 之前这里只 show() 没接 click —— 文案写着「点击查看详情」，点下去什么都不会发生。
 */
function buildExpiryNotification(plan) {
  if (!plan || !Notification.isSupported()) return null;
  const n = new Notification({ title: plan.title, body: plan.body });
  n.on('click', () => focusView(plan.view));
  return n;
}

function showExpiryNotification(plan) {
  const n = buildExpiryNotification(plan);
  if (n) n.show();
  return n;
}

// 启动后检查一次临期与过期物品，之后每 6 小时一次
function startExpiryWatcher() {
  const run = async () => {
    try {
      const list = await store.handle('items.expiringSoon', { days: 7 });
      showExpiryNotification(buildExpiryReminder(list));
    } catch (e) {
      console.error('expiry watcher failed', e);
    }
  };
  setTimeout(run, 6000);
  setInterval(run, 1000 * 60 * 60 * 6);
}
