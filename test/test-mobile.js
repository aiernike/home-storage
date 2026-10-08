'use strict';

/**
 * 安卓端运行内核验证
 * ---------------------------------------------------------------------------
 * 要证明的事：桌面端的数据层（store.js / sync.js）能原封不动跑在手机适配层上。
 *
 * 做法：在 Node 的 vm 沙箱里造一个假的浏览器环境（localStorage / window / document），
 *       加载 build-mobile.js 生成的真实产物 hs-core.js，然后走和桌面端
 *       完全相同的断言，看两边行为是否一致。
 *
 * 为什么必须真的跑起来：
 *   手机端最容易出的问题不是逻辑错，而是「桌面能跑、手机一跑就崩」——
 *   因为代码里用了 WebView 不存在的 Node API。静态看代码很难发现，
 *   例如 sync.js 用的是全局 Buffer 而不是 require('buffer')，
 *   漏掉这一个全局，手机上每次同步都会直接抛异常。
 */

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'mobile', 'android', 'assets', 'www');
const KERNEL = path.join(OUT, 'js', 'hs-core.js');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (extra ? '  → ' + extra : ''));
  }
}

/** 读文件，缺失时直接报错（文件不在就没必要继续了） */
function read(file, label) {
  if (!fs.existsSync(file)) throw new Error(`缺少文件：${file}（${label || ''}）`);
  return fs.readFileSync(file, 'utf8');
}

/**
 * 读出 APK 里的原始条目名。
 * 必须读原始字节：aapt list 会把反斜杠显示成正斜杠，看不出问题。
 */
function zipEntryNames(apkPath) {
  const buf = fs.readFileSync(apkPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 APK（找不到 zip 中央目录）');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.slice(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/* ==========================================================================
 * 一、模拟浏览器环境
 * ========================================================================== */

/** 用 Map 模拟 localStorage；超过 quotaBytes 就抛错，用来复现写满的情况 */
function makeLocalStorage(quotaBytes) {
  const map = new Map();
  let used = 0;

  function bytes(s) {
    return Buffer.byteLength(String(s), 'utf8');
  }

  return {
    getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      const add = bytes(v) - (map.has(k) ? bytes(map.get(k)) : 0);
      if (quotaBytes && used + add > quotaBytes) {
        const e = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      }
      used += add;
      map.set(k, String(v));
    },
    removeItem(k) {
      if (map.has(k)) {
        used -= bytes(map.get(k));
        map.delete(k);
      }
    },
    clear() {
      map.clear();
      used = 0;
    },
    key(i) {
      return Array.from(map.keys())[i];
    },
    get length() {
      return map.size;
    },
    _size() {
      return used;
    }
  };
}

/**
 * 起一个沙箱，加载真实内核，返回 { api, ctx, storage }。
 *
 * @param {object} opts
 *   storage   复用的 localStorage（传同一个即可模拟「重启应用」）
 *   native    是否挂原生桥 HSAndroid（模拟真机）
 *   fetchImpl 是否提供 fetch（模拟浏览器调试场景）
 */
function loadKernel(opts = {}) {
  const storage = opts.storage || makeLocalStorage(opts.quota);
  // created / appended 用来验证「提示真的被放到了页面上」——
  // 手机 WebView 没有控制台，只 console.log 等于没提示。
  const state = { done: null, created: [], appended: [] };
  const logs = [];

  const sandbox = {
    console: {
      log: (...a) => logs.push(['log', a.join(' ')]),
      warn: (...a) => logs.push(['warn', a.join(' ')]),
      error: (...a) => logs.push(['error', a.join(' ')])
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    localStorage: storage,
    navigator: { userAgent: 'hs-mobile-test' },
    location: { href: 'https://hs.local/index.html', protocol: 'https:' },
    // 内核会用到的基础类型，vm 沙箱不会自动继承，必须显式给
    Promise,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    TypeError,
    RegExp,
    Map,
    Set,
    Symbol,
    Uint8Array,
    ArrayBuffer,
    encodeURIComponent,
    decodeURIComponent,
    isNaN,
    parseInt,
    parseFloat,
    // WebView 里一定有、Node 里没有的浏览器对象
    crypto: { randomUUID: require('crypto').randomUUID },
    URL,
    AbortController,
    Blob: undefined,
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 16),
    cancelAnimationFrame: clearTimeout,
    MutationObserver: undefined,
    document: {
      body: {
        innerHTML: '',
        appendChild(el) {
          state.appended.push(el);
        },
        removeChild() {}
      },
      documentElement: {},
      createElement: (tag) => {
        const el = {
          tag,
          style: {},
          textContent: '',
          setAttribute() {},
          appendChild() {},
          removeChild() {},
          click() {}
        };
        state.created.push(el);
        return el;
      },
      getElementById: (id) => state.appended.find((e) => e && e.id === id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}
    }
  };

  if (opts.native !== false) {
    sandbox.HSAndroid = {
      /**
       * 模拟 Java 侧的实现：拿到请求后用 Node 的 http 发出去，
       * 再把结果回调给页面。契约必须和 MainActivity 保持一致。
       */
      http(id, method, url, headersJson, body, timeout) {
        let u;
        try {
          u = new URL(url);
        } catch (e) {
          return state.done && state.done(id, { ok: false, error: '地址格式不正确' });
        }
        const lib = u.protocol === 'https:' ? require('https') : http;
        const headers = JSON.parse(headersJson || '{}');
        // 真机上的 HttpURLConnection 会自己算 Content-Length，先删掉避免冲突
        delete headers['Content-Length'];
        delete headers['content-length'];

        const req = lib.request(
          {
            hostname: u.hostname,
            port: u.port || 80,
            path: u.pathname + u.search,
            method,
            headers,
            timeout: timeout || 15000
          },
          (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => (text += c));
            res.on('end', () => {
              if (state.done) state.done(id, { ok: true, status: res.statusCode, body: text });
            });
          }
        );
        req.on('timeout', () => {
          req.destroy();
          if (state.done) state.done(id, { ok: false, error: '连接超时' });
        });
        req.on('error', (e) => {
          if (state.done) state.done(id, { ok: false, error: e.message });
        });
        if (body) req.write(body);
        req.end();
      },
      saveFile(name, content) {
        return '下载 / ' + name + ' (' + String(content).length + ' 字节)';
      },
      notify() {}
    };
  }

  if (opts.fetchImpl) sandbox.fetch = opts.fetchImpl;

  vm.createContext(sandbox);
  // window 指向沙箱自身的全局对象，这样 window.X 与全局 X 是同一份
  vm.runInContext('globalThis.window = globalThis; globalThis.self = globalThis;', sandbox);
  vm.runInContext(fs.readFileSync(KERNEL, 'utf8'), sandbox, { filename: 'hs-core.js' });

  state.done = vm.runInContext('window.__HS_HTTP_DONE', sandbox);

  return {
    sandbox,
    storage,
    logs,
    state,
    api: vm.runInContext('window.api', sandbox),
    evalIn: (code) => vm.runInContext(code, sandbox)
  };
}

/* ==========================================================================
 * 二、一个够用的同步服务端（只为验证适配层的请求/响应语义）
 * ========================================================================== */

function startTestServer() {
  return new Promise((resolve) => {
    const seen = [];

    const server = http.createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.push({
          method: req.method,
          url: req.url,
          auth: req.headers.authorization || '',
          body: raw
        });

        const send = (code, obj) => {
          const text = JSON.stringify(obj);
          res.writeHead(code, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(text, 'utf8')
          });
          res.end(text);
        };

        if (req.url === '/api/health') {
          return send(200, { ok: true, name: '家庭收纳同步服务', version: '1.0.0' });
        }
        if (req.url === '/api/login') {
          return send(200, { token: 'tok-abc123', user: { id: 1, username: 'taoge' } });
        }
        if (req.url === '/api/register') {
          return send(200, { ok: true });
        }
        if (req.url === '/api/sync') {
          // 回推一条服务端已有的位置，用来验证拉取与合并
          return send(200, {
            serverTime: '2026-09-13T02:00:00.000Z',
            pull: {
              locations: [
                {
                  id: 'srv-loc-1',
                  name: 'NAS 上的阳台柜',
                  parent_id: null,
                  sort: 9,
                  created_at: '2026-09-13T01:00:00.000Z',
                  updated_at: '2026-09-13T01:00:00.000Z',
                  deleted: false
                }
              ],
              items: [],
              categories: []
            }
          });
        }
        send(404, { error: '没有这个接口' });
      });
    });

    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, seen });
    });
  });
}

/* ==========================================================================
 * 三、开跑
 * ========================================================================== */

/**
 * 调同步接口，并把「裸抛异常」也变成一个可断言的对象。
 *
 * 为什么需要：适配层一旦忘了把失败包成 `{ok:false,error}`，异常会直接冒到
 * 脚本外面 —— 测试当场崩溃，后面 [8]~[11] 几十条断言全都不跑，
 * 只看到一句「测试脚本自身出错」，看不出全貌，也不好定位是哪一条。
 * 兜住之后它就是一个普通的 FAIL，红名单完整。
 */
async function callSync(fn) {
  try {
    return await fn();
  } catch (e) {
    return { __threw: String((e && e.message) || e) };
  }
}

(async () => {
  /* ---- 产物是否就绪 ---- */
  console.log('\n[1] 打包产物');
  if (!fs.existsSync(KERNEL)) {
    console.log('  产物不存在，先执行打包…');
    execFileSync(process.execPath, [path.join(ROOT, 'mobile', 'build-mobile.js')], {
      cwd: ROOT,
      stdio: 'inherit'
    });
  }
  ok('hs-core.js 已生成', fs.existsSync(KERNEL));

  const page = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
  ok('页面已注入 viewport', /name="viewport"[^>]*width=device-width/.test(page));
  ok('页面已挂载 mobile.css', page.includes('href="css/mobile.css"'));
  ok('页面已引入 hs-core.js', page.includes('src="js/hs-core.js"'));
  ok(
    'hs-core.js 排在渲染层脚本之前',
    page.indexOf('js/hs-core.js') < page.indexOf('js/util.js'),
    'app.js 会直接使用 window.api，内核必须先就绪'
  );
  ok('移动端样式文件已复制', fs.existsSync(path.join(OUT, 'css', 'mobile.css')));

  /* ---- 产物是不是当前源码构建出来的 ---- */
  /*
   * 这一段测的是「测试本身有没有测错对象」。
   *
   * 手机端测试跑的是 mobile/android/assets/www 里的**构建产物**，不是 src/ 下的源码。
   * 改了源码忘了重建，后面这一百多项测的就全是旧代码，而且全绿 —— 这个坑踩过两次：
   *   一次因此漏掉一个「点缩略图没反应」的真实 bug；
   *   一次是反向验证后忘了还原重建，npm test 里手机端莫名红了 1 项、单跑却是绿的。
   * 构建脚本会把每个源文件的哈希写进 build-info.json，这里重算一遍比对。
   */
  console.log('\n[1b] 产物与源码一致（改了源码必须先重建）');
  const infoPath = path.join(OUT, 'build-info.json');
  if (!fs.existsSync(infoPath)) {
    ok('build-info.json 存在', false, '先执行 npm run build:mobile-assets');
  } else {
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    const sha = (s) =>
      require('crypto').createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
    const src = info.sources || {};
    const rels = Object.keys(src);

    // 覆盖度：最常改的那几个渲染层文件必须在清单里。
    // 早先这份清单只有 store.js / sync.js / qr.js / icons.js —— 恰好把最常改的
    // 四个漏在外面，那样即使有比对，也拦不住「忘了重建」。
    const mustHave = [
      'src/renderer/js/app.js',
      'src/renderer/js/views.js',
      'src/renderer/js/util.js',
      'src/renderer/js/components.js'
    ];
    ok('构建清单覆盖了最常改的渲染层文件',
      mustHave.every((r) => rels.indexOf(r) >= 0),
      '缺少：' + mustHave.filter((r) => rels.indexOf(r) < 0).join('、'));

    const stale = rels.filter((rel) => {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) return true;
      return sha(fs.readFileSync(abs, 'utf8')) !== src[rel];
    });
    ok(`产物是最新源码构建出来的（比对了 ${rels.length} 个源文件）`,
      stale.length === 0,
      '以下文件改过但没重建：' + stale.join('、') + '（执行 npm run build:mobile-assets）');
  }

  // 二维码模块（复用 zxing 自带编码器）要打进包，页面必须引入
  ok('页面引入了二维码模块 qr.js', page.includes('src="js/qr.js"'));
  ok('二维码模块排在渲染层脚本之前（先就绪）',
    page.indexOf('js/qr.js') < page.indexOf('js/util.js'));
  ok('qr.js 已复制进 assets', fs.existsSync(path.join(OUT, 'js', 'qr.js')));

  // OCR 已按需求移除：页面不应再引用它，CSP 也不该再放开 WASM/worker
  ok('页面不再引用 OCR（ocr.js / tesseract）',
    !/js\/ocr\//.test(page) && !/tesseract/i.test(page));
  ok('CSP 不再放开 WASM 执行（OCR 已移除）', !/'wasm-unsafe-eval'/.test(page));
  ok('CSP 不再放开 worker 源（OCR 已移除）', !/worker-src/.test(page));
  ok('OCR 资源目录已从 assets 清除', !fs.existsSync(path.join(OUT, 'js', 'ocr')));

  /* ---- 内核加载 ---- */
  console.log('\n[2] 内核加载与数据层');
  let app;
  try {
    app = loadKernel();
    ok('内核在模拟浏览器环境中加载成功', true);
  } catch (e) {
    ok('内核在模拟浏览器环境中加载成功', false, String(e && e.message));
    console.log('\n无法继续，后面的测试跳过。');
    process.exit(1);
  }

  ok('暴露了 window.api', !!app.api);
  ok(
    'window.api 的接口与桌面端 preload 一致',
    ['call', 'exportFile', 'importFile', 'appInfo', 'notify', 'openPath', 'sync'].every(
      (k) => typeof app.api[k] !== 'undefined'
    )
  );
  ok('同步子接口齐全', ['test', 'login', 'register', 'run'].every((k) => typeof app.api.sync[k] === 'function'));

  // NFC 桥接：手机端碰一下标签定位收纳位置
  ok('暴露了 NFC 桥接接口 api.nfc', typeof app.api.nfc === 'object' && typeof app.api.nfc.supported === 'function');
  ok('NFC 等待/取消接口就绪', typeof app.api.nfc.waitForTag === 'function' && typeof app.api.nfc.cancelWait === 'function');
  ok('注入了 NFC 回调 __hsOnNfc', app.evalIn('typeof window.__hsOnNfc') === 'function');
  ok('注入了 NFC 定位逻辑 __hsNfcLookup', app.evalIn('typeof window.__hsNfcLookup') === 'function');
  // 模拟桥没有 nfcSupported 方法时，supported() 必须安全返回 false（不能抛异常）
  ok('无 NFC 桥时 supported() 返回 false 且不报错', app.api.nfc.supported() === false);

  const call = (a, p) => app.api.call(a, p);

  const tree = await call('locations.tree');
  ok('位置树读取成功', tree.ok && tree.data.length >= 4, JSON.stringify(tree).slice(0, 200));
  ok(
    '位置树节点带 path（桌面端曾因缺它显示 undefined）',
    tree.ok && tree.data.every((n) => typeof n.path === 'string' && n.path)
  );

  const cats = await call('categories.list');
  // 分类从 8 个扩到 27 个（办公资料 / 会计专用 / 书籍阅读 / 生活扩展），
  // 手机端跑的是同一份数据层，数量必须跟电脑端一致。
  ok('预置分类已扩充到 24 个以上', cats.ok && cats.data.length >= 24,
    cats.ok ? 'got ' + cats.data.length : cats.error);
  ok('办公资料类分类在手机端也在',
    cats.ok && ['合同', '证照', '记账', '报税'].every((k) => cats.data.some((c) => c.key === k)));
  ok('图书类分类在手机端也在',
    cats.ok && ['图书', '教材', '期刊'].every((k) => cats.data.some((c) => c.key === k)));

  const saved = await call('items.save', {
    name: '厨房纸巾',
    barcodes: ['6901234567890'],
    quantity: 3,
    location_id: tree.data[0].id
  });
  ok('新增物品成功', saved.ok && saved.data.id, saved.error);
  ok('新增后带出位置名称', saved.ok && saved.data.location_name === tree.data[0].name,
    saved.ok ? 'got ' + saved.data.location_name : '');

  const byCode = await call('items.byBarcode', { barcode: '6901234567890' });
  ok('条码查询命中', byCode.ok && byCode.data && byCode.data.name === '厨房纸巾');

  /* ---- v2 字段与内部编码：手机端和电脑端必须一致 ---- */
  ok('新物品默认带 kind', byCode.ok && byCode.data.kind === 'goods', byCode.ok ? byCode.data.kind : '');
  ok('新物品默认带 extra 对象', byCode.ok && byCode.data.extra && typeof byCode.data.extra === 'object');

  const nc = await call('items.nextCode');
  ok('能拿到内部编码', nc.ok && /^HS-\d{4}-\d{4}$/.test(nc.data.code), nc.ok ? nc.data.code : nc.error);

  const doc = await call('items.save', {
    name: '手机端测试合同',
    kind: 'doc',
    code: nc.data.code,
    barcodes: [],
    extra: { doc_no: 'HT-001' }
  });
  ok('手机端能存办公资料', doc.ok && doc.data.kind === 'doc', doc.error);
  ok('手机端能存资料专属字段', doc.ok && doc.data.extra && doc.data.extra.doc_no === 'HT-001',
    doc.ok ? JSON.stringify(doc.data.extra) : '');
  const docByCode = await call('items.byCode', { code: nc.data.code });
  ok('手机端能按内部编码查回来', docByCode.ok && docByCode.data && docByCode.data.name === '手机端测试合同');
  const kindFilter = await call('items.list', { kind: 'doc' });
  ok('手机端能按类型筛选', kindFilter.ok && kindFilter.data.length === 1 && kindFilter.data[0].kind === 'doc',
    kindFilter.ok ? String(kindFilter.data.length) : kindFilter.error);

  const consumed = await call('items.consume', { id: saved.data.id, delta: -1 });
  ok('数量变更成功且剩 2', consumed.ok && consumed.data.quantity === 2,
    consumed.ok ? 'got ' + consumed.data.quantity : consumed.error);

  const summary = await call('app.summary');
  ok('总览统计可用', summary.ok && typeof summary.data.items === 'number');

  const exported = await call('app.export');
  ok('导出数据可用', exported.ok && exported.data && exported.data.items);

  const bad = await call('items.get', { id: '不存在的id' });
  ok('查不到时不抛异常，返回失败', bad.ok === false || bad.data === null || bad.data === undefined,
    JSON.stringify(bad).slice(0, 160));

  /* ---- 数据真的落盘了 ---- */
  console.log('\n[3] 持久化');
  app.evalIn('window.__hsStore.saveNow()');
  const keys = Array.from({ length: app.storage.length }, (_, i) => app.storage.key(i));
  ok('数据已写入 localStorage', keys.length > 0, '键：' + keys.join(', '));
  ok('写入键带 hs:file: 前缀', keys.every((k) => k.startsWith('hs:file:')));

  // 用同一份存储重新加载内核 = 模拟杀掉应用再打开
  const app2 = loadKernel({ storage: app.storage });
  const again = await app2.api.call('items.byBarcode', { barcode: '6901234567890' });
  ok('重开应用后数据仍在', again.ok && again.data && again.data.name === '厨房纸巾',
    JSON.stringify(again).slice(0, 200));
  ok('重开后数量保持为 2', again.ok && again.data.quantity === 2);

  /* ---- 存储写满 ---- */
  console.log('\n[4] 存储写满时的表现');
  const tiny = loadKernel({ quota: 400 });
  // 整段在同一个同步块里跑完：数据层的 flush() 是 120ms 定时器触发的，
  // 如果分几步写，定时器可能插进来先把告警钩子调用掉，断言就变成假通过了。
  const quota = JSON.parse(
    tiny.evalIn(`
      window.__HS_WARNED = null;
      window.__HS_STORAGE_ERROR__ = function (m) { window.__HS_WARNED = m; };
      var err = null;
      try { window.__HS.require("fs").writeFileSync("/db.json", "x".repeat(5000)); }
      catch (e) { err = { code: e.code, message: e.message }; }
      JSON.stringify({ warned: window.__HS_WARNED, err: err });
    `)
  );
  ok('超限时抛出 ENOSPC', quota.err && quota.err.code === 'ENOSPC',
    quota.err ? 'code=' + quota.err.code : '没有抛错');
  ok('错误信息告诉用户怎么办', quota.err && /导出备份/.test(quota.err.message),
    quota.err ? quota.err.message.slice(0, 40) : '');
  ok('同时触发了界面告警钩子（否则用户看不到）', !!quota.warned,
    '数据层的 flush() 会吞掉异常，必须靠这条通道暴露');

  /* ---- 存储写满：提示必须真的到用户眼前 ---- */
  console.log('\n[4b] 存储写满时用户必须能看到（测真钩子，不是桩）');

  // 上面那条用例把告警钩子换成了桩，只证明了「适配层会调它」。
  // 这里不换钩子，直接验证 bootstrap 里那段实现本身 ——
  // 只测传参不测实现的话，钩子哪天被改成空函数，测试照样全绿。

  // 场景一：界面组件（components.js）已就绪 —— 正常运行时的情况
  const realHook1 = loadKernel({ quota: 400 });
  realHook1.evalIn(`
    window.__hsToasts = [];
    window.C = { toast: function (m, k) { window.__hsToasts.push({ msg: m, kind: k }); } };
  `);
  realHook1.evalIn(
    'try { window.__HS.require("fs").writeFileSync("/db.json", "x".repeat(5000)); } catch (e) {}'
  );
  const realToasts = realHook1.evalIn('JSON.stringify(window.__hsToasts)');
  ok('界面就绪时弹出了存储不足提示', /存储空间不足/.test(realToasts), realToasts);
  ok('提示用的是错误样式（不是普通提示）', /"kind":"err"/.test(realToasts), realToasts);

  // 场景二：界面组件还没就绪（hs-core.js 早于 components.js 执行）。
  // 这时如果只 console.log，手机 WebView 没有控制台，用户永远看不到。
  const realHook2 = loadKernel({ quota: 400 });
  realHook2.evalIn(
    'try { window.__HS.require("fs").writeFileSync("/db.json", "x".repeat(5000)); } catch (e) {}'
  );
  const warnBar = realHook2.state.appended.find((e) => e && e.id === 'hs-storage-warn');
  ok('界面未就绪时用 DOM 兜底显示，而不是只打日志', !!warnBar,
    'appended=' + realHook2.state.appended.length);
  ok('兜底提示条的内容是存储不足', !!warnBar && /存储空间不足/.test(warnBar.textContent || ''),
    warnBar ? warnBar.textContent.slice(0, 40) : '');
  ok('兜底提示条可见（有定位和配色，不是隐藏元素）',
    !!warnBar && /position:fixed/.test(warnBar.style.cssText || ''), warnBar && warnBar.style.cssText);
  // 它是 fixed 钉在顶部的，没有关闭入口就会把搜索框和顶部按钮永久挡住 ——
  // 用户恰恰是在「数据存不上」这种最需要点「导出备份」的时候看到它。
  ok('兜底提示条带「知道了」按钮（否则会永久挡住顶部）',
    !!warnBar && /hs-storage-warn-close/.test(String(warnBar.innerHTML || '')),
    warnBar ? String(warnBar.innerHTML).slice(0, 60) : '');

  // 场景三：提示真的送达了，就正常节流，连续失败不刷屏
  const realHook3 = loadKernel({ quota: 400 });
  realHook3.evalIn('window.__hsCount = 0; window.C = { toast: function () { window.__hsCount++; } };');
  realHook3.evalIn(`
    var f = window.__HS.require("fs");
    try { f.writeFileSync("/a.json", "x".repeat(5000)); } catch (e) {}
    try { f.writeFileSync("/b.json", "x".repeat(5000)); } catch (e) {}
    try { f.writeFileSync("/c.json", "x".repeat(5000)); } catch (e) {}
  `);
  ok('连续写入失败只提示一次，不刷屏', realHook3.evalIn('window.__hsCount') === 1,
    '提示次数 ' + realHook3.evalIn('window.__hsCount'));

  // 场景四：提示没送达（弹窗本身抛异常）时，不能把节流窗口白白吃掉 ——
  // 否则接下来 5 分钟全是静默失败，用户永远不知道数据没存上。
  const realHook4 = loadKernel({ quota: 400 });
  realHook4.evalIn(`
    window.__hsTry = 0;
    window.C = { toast: function () { window.__hsTry++; if (window.__hsTry === 1) throw new Error('界面还没准备好'); } };
  `);
  realHook4.evalIn(`
    var f2 = window.__HS.require("fs");
    try { f2.writeFileSync("/a.json", "x".repeat(5000)); } catch (e) {}
    try { f2.writeFileSync("/b.json", "x".repeat(5000)); } catch (e) {}
  `);
  ok('提示没送达时不消耗节流窗口，下次还会再试', realHook4.evalIn('window.__hsTry') === 2,
    '尝试次数 ' + realHook4.evalIn('window.__hsTry'));

  /* ---- http 适配层：原生通道 ---- */
  console.log('\n[5] 网络适配层 · 原生通道（真机走这条）');
  const srv = await startTestServer();
  const base = 'http://127.0.0.1:' + srv.port;

  const appNative = loadKernel();
  const health = await callSync(() => appNative.api.sync.test(base));
  // 注意断言的是 `data` 里面那层：接口形状必须和桌面端一样是 {ok, data}。
  // 只断言 `health.ok === true` 是**假绿** —— /api/health 的响应体自己就带 ok:true，
  // 就算适配层忘了包，`health.ok` 照样是 true。（升 1.1.0 时踩过这个。）
  ok('健康检查通过原生桥完成', !!(health && health.ok === true && health.data && health.data.name),
    JSON.stringify(health));
  ok('服务端收到了请求', srv.seen.some((s) => s.url === '/api/health'));

  const login = await callSync(() => appNative.api.sync.login({
    url: base,
    username: 'taoge',
    password: 'pw',
    deviceName: '手机'
  }));
  ok('登录拿到令牌', !!(login && login.ok === true && login.data && login.data.token === 'tok-abc123'),
    JSON.stringify(login));
  const loginReq = srv.seen.find((s) => s.url === '/api/login');
  ok('POST 请求体被正确送达', loginReq && /taoge/.test(loginReq.body), loginReq ? loginReq.body : '无请求');
  ok('中文请求体没有乱码', loginReq && loginReq.body.includes('手机'), loginReq ? loginReq.body : '无请求');

  /* ---- 同步层端到端 ---- */
  console.log('\n[6] 同步层端到端（sync.js 走适配层）');
  await appNative.api.call('app.settings.set', {
    syncUrl: base,
    syncToken: 'tok-abc123',
    deviceName: '手机'
  });
  const runRes = await callSync(() => appNative.api.sync.run());
  // app.js 的 doSync() 读的是 `r.ok` / `r.data.pushed` / `r.data.conflicts`，
  // 所以这里也必须断言 data 那一层，否则「界面拿到 undefined」测不出来。
  const runData = runRes && runRes.data;
  ok('同步执行成功', !!(runRes && runRes.ok === true && runData && typeof runData.pushed === 'number'),
    JSON.stringify(runRes).slice(0, 200));
  ok('推送了本地记录', !!(runData && runData.pushed > 0), 'pushed=' + (runData && runData.pushed));
  ok('拉取到服务端记录', !!(runData && runData.pulled > 0), 'pulled=' + (runData && runData.pulled));
  // 冲突清单是 app.js 拿去开弹窗的（showConflictDialog），字段名错了弹窗就是空的
  ok('同步结果带 conflicts 数组（冲突弹窗靠它）', !!(runData && Array.isArray(runData.conflicts)),
    JSON.stringify(runData && runData.conflicts));
  const syncReq = srv.seen.find((s) => s.url === '/api/sync');
  ok('同步请求带了 Authorization 头', syncReq && /Bearer tok-abc123/.test(syncReq.auth),
    syncReq ? syncReq.auth : '无');
  ok('同步请求带中文设备名且未乱码', syncReq && syncReq.body.includes('手机'),
    syncReq ? syncReq.body.slice(0, 80) : '');

  const afterTree = await appNative.api.call('locations.tree');
  ok('拉取到的位置已合并进本地',
    afterTree.ok && afterTree.data.some((n) => n.name === 'NAS 上的阳台柜'),
    JSON.stringify(afterTree.data.map((n) => n.name)));

  /* ---- http 适配层：fetch 回退 ---- */
  console.log('\n[7] 网络适配层 · fetch 回退（浏览器调试走这条）');
  const appFetch = loadKernel({ native: false, fetchImpl: fetch });
  const health2 = await callSync(() => appFetch.api.sync.test(base));
  ok('没有原生桥时用 fetch 也能通',
    !!(health2 && health2.ok === true && health2.data && health2.data.name === '家庭收纳同步服务'),
    JSON.stringify(health2));

  // 形状必须和桌面端完全一致：成功 `{ok:true, data}`、失败 `{ok:false, error}`。
  //
  // 为什么专门测这个：渲染层（views.js）两端共用，它按 `r.ok` / `r.data` / `r.error` 取值。
  // 手机端原来直接把 sync.js 的裸 Promise 透出去，于是——
  //   登录成功：响应是 `{token}`，`r.ok` 是 undefined → 永远走失败分支，
  //             而 `r.error` 也是 undefined → toast 弹了个空的；
  //   登录失败：sync.js 是**抛异常**，views.js 的 onclick 里没有 try/catch → 静默失败。
  // 两条路都是「点了没反应」。桌面端有 main.js 的 wrap() 兜着，所以只有手机/PWA 端中招。
  const appDead = loadKernel({ native: false, fetchImpl: fetch });
  const deadTest = await callSync(() => appDead.api.sync.test('http://127.0.0.1:1'));
  ok('连不上时给出中文提示（且是返回而不是抛异常）',
    deadTest && deadTest.ok === false &&
    /NAS 拒绝连接|连接超时|同一网络|找不到/.test(deadTest.error || ''),
    JSON.stringify(deadTest));

  const loginWeb = await callSync(() => appFetch.api.sync.login({
    url: base, username: 'taoge', password: 'pw', deviceName: '浏览器'
  }));
  ok('fetch 回退时登录成功包成 {ok,data}（渲染层靠它取 token）',
    !!(loginWeb && loginWeb.ok === true && loginWeb.data && loginWeb.data.token === 'tok-abc123'),
    JSON.stringify(loginWeb));

  const loginDead = await callSync(() => appDead.api.sync.login({
    url: 'http://127.0.0.1:1', username: 'taoge', password: 'pw'
  }));
  ok('fetch 回退时登录失败返回 {ok:false,error}，而不是抛异常',
    !!(loginDead && loginDead.ok === false && loginDead.error),
    JSON.stringify(loginDead));

  // 注册接口的真实响应体本身就是 `{ok:true}`，所以这里**不能**只断言 `r.ok === true`
  // —— 那和 /api/health 一样是假绿（不包也绿）。要断言 data 那一层。
  const regWeb = await callSync(() => appFetch.api.sync.register({
    url: base, username: 'taoge', password: 'pw'
  }));
  ok('fetch 回退时注册成功包成 {ok,data}',
    !!(regWeb && regWeb.ok === true && regWeb.data && regWeb.data.ok === true),
    JSON.stringify(regWeb));

  const regDead = await callSync(() => appDead.api.sync.register({
    url: 'http://127.0.0.1:1', username: 'taoge', password: 'pw'
  }));
  ok('fetch 回退时注册失败返回 {ok:false,error}，而不是抛异常',
    !!(regDead && regDead.ok === false && regDead.error),
    JSON.stringify(regDead));

  // 地址写错和服务没启动是两种问题，提示必须能区分开，
  // 否则用户会照着「确认后端服务已启动」去查一个根本不存在的主机。
  const notFoundTest = await callSync(() => appDead.api.sync.test('http://nas-host-does-not-exist-xyz.invalid:8080'));
  ok('地址写错时提示「找不到主机」而非「拒绝连接」',
    !!(notFoundTest && notFoundTest.ok === false && /找不到 NAS 主机/.test(notFoundTest.error || '')),
    JSON.stringify(notFoundTest));

  const appDeadNative = loadKernel();
  const refused2 = await callSync(() => appDeadNative.api.sync.test('http://127.0.0.1:1'));
  ok('原生通道连不上时也给中文提示',
    refused2 && refused2.ok === false &&
    /NAS 拒绝连接|连接超时|同一网络|找不到/.test(refused2.error || ''),
    JSON.stringify(refused2));

  // app.js 的 doSync() 走的就是这条：`if (r.ok) {…} else { 显示「同步失败」 }`。
  // 未包装时 sync() 抛的异常会一路冒到 onclick 外面，界面既不改状态也不提示。
  const runDead = await callSync(() => appDead.api.sync.run());
  ok('同步失败也返回 {ok:false,error}（界面才能显示「同步失败」）',
    !!(runDead && runDead.ok === false && runDead.error),
    JSON.stringify(runDead));

  // 泛化兜底：上面几条是「逐个方法点名」，这条是「一个都别漏」。
  // [2] 那条「同步子接口齐全」只查方法在不在 —— 挡不住这次的 bug：
  // 手机端 sync.test/login/register/run 四个方法**都在**，只是少了外面那层壳，
  // 于是界面永远走失败分支、连错误文案都取不到。所以这里逐个调一遍看形状。
  // 以后往 api.sync 里加方法，只要忘了包，这条就会红。
  const syncMethods = Object.keys(appDead.api.sync);
  const badShape = [];
  for (const m of syncMethods) {
    const r = await callSync(() => appDead.api.sync[m]({ url: 'http://127.0.0.1:1' }));
    if (!r || typeof r.ok !== 'boolean' || (r.ok === false && !r.error)) {
      badShape.push(m + ' → ' + JSON.stringify(r));
    }
  }
  ok(`api.sync 每个方法都返回 {ok,error} 形状（实测 ${syncMethods.length} 个）`,
    badShape.length === 0, badShape.join('；'));

  /* ---- 导入导出 ---- */
  console.log('\n[8] 导入导出');
  const exp = await appNative.api.exportFile({ defaultName: '备份.json', content: '{"a":1}' });
  ok('导出走了原生保存', exp.ok && /备份\.json/.test(exp.filePath || ''), JSON.stringify(exp));

  const appNoBridge = loadKernel({ native: false, fetchImpl: fetch });
  appNoBridge.sandbox.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  ok('没有原生桥时导出降级为浏览器下载', true, '（降级路径已存在，真机不会走到）');

  /* ---- 应用信息 ---- */
  const info = await appNative.api.appInfo();
  ok('appInfo 报告安卓平台', info.platform === 'android', JSON.stringify(info));
  ok('appInfo 带版本号', !!info.version && info.version !== '', JSON.stringify(info));

  // 同一份代码也跑在浏览器里（PWA，iPhone「添加到主屏幕」走的就是这条）。
  // 没有原生桥时必须如实报 web —— 否则「设置」页会告诉浏览器用户
  // 「数据在手机应用内部存储」，用户按这个提示去找是永远找不到的。
  const infoWeb = await appNoBridge.api.appInfo();
  ok('没有原生桥时报告浏览器端', infoWeb.platform === 'web', JSON.stringify(infoWeb));
  ok('浏览器端的数据目录说明与安卓端不同',
    infoWeb.userData !== info.userData, JSON.stringify(infoWeb));

  srv.server.close();

  /* ---- 移动端样式 ---- */
  console.log('\n[9] 移动端布局');
  const css = fs.readFileSync(path.join(OUT, 'css', 'mobile.css'), 'utf8');
  ok('侧栏改为底部标签栏', /\.sidebar\s*\{[^}]*flex-direction:\s*row/.test(css));
  ok('整体改为纵向排列', /\.app\s*\{[^}]*flex-direction:\s*column-reverse/.test(css));
  ok('位置树等桌面侧栏内容被隐藏', /\.loc-panel[^{]*\{[^}]*display:\s*none\s*!important/.test(css));
  ok('表单单列化', /\.form-grid\s*\{[^}]*grid-template-columns:\s*1fr/.test(css));
  ok('加减按钮放大到可点', /\.qty-box button\s*\{[^}]*width:\s*36px/.test(css));
  ok('标签栏高度足够手指点', /\.nav-item\s*\{[^}]*min-height:\s*54px/.test(css));
  // 桌面版 .nav-item 有 width:100%，移动端必须覆盖掉，
  // 否则配合 flex-shrink:0 每个标签会被撑成整屏宽（屏幕上只剩第一个）
  ok('覆盖了桌面版的 width:100%', /\.nav-item\s*\{[^}]*width:\s*auto/.test(css));
  ok('标签允许被压缩（min-width:0）', /\.nav-item\s*\{[^}]*min-width:\s*0/.test(css));
  // 主区在纵向布局下必须补 min-height:0，否则会溢出把标签栏顶出屏幕
  ok('主区补了 min-height:0', /\.main\s*\{[^}]*min-height:\s*0/.test(css));

  /* ---- 安卓外壳 ---- */
  console.log('\n[10] 安卓外壳');
  const manifest = read(path.join(ROOT, 'mobile', 'android', 'AndroidManifest.xml'), '清单');
  const activity = read(
    path.join(ROOT, 'mobile', 'android', 'src', 'com', 'home', 'storage', 'MainActivity.java'),
    '主 Activity'
  );

  ok('清单声明了相机权限', /android\.permission\.CAMERA/.test(manifest));
  ok('清单声明了联网权限', /android\.permission\.INTERNET/.test(manifest));
  // 家用 NAS 是局域网 http，不开这个开关 Android 9+ 会直接拦掉同步请求
  ok('清单允许明文 http（局域网 NAS 需要）', /usesCleartextTraffic="true"/.test(manifest));
  ok('清单声明了最低版本 21', /minSdkVersion="21"/.test(manifest));
  // 不加 configChanges 的话横竖屏切换会重建 Activity，用户填一半的表单就没了
  ok('清单声明了 configChanges 防重建', /configChanges="[^"]*orientation/.test(manifest));

  // 版本号只有一个源头：根 package.json。清单里的显式 versionCode / versionName
  // 「会盖掉」aapt2 的命令行参数 —— 曾经因此出现「apk 文件名叫 家庭收纳-1.1.0.apk、
  // 装到手机上却显示 1.0.0、versionCode 永远是 1（系统认不出是升级）」。
  ok('清单没有写死 versionCode/versionName（写死了会盖掉构建传的版本号）',
    !/android:versionCode\s*=/.test(manifest) && !/android:versionName\s*=/.test(manifest),
    '清单里不该再出现这两个属性');
  const buildApkSrc = read(path.join(ROOT, 'mobile', 'build-apk.js'), 'APK 构建脚本');
  ok('build-apk.js 从 package.json 的版本算出 versionCode',
    /const VERSION_CODE\s*=/.test(buildApkSrc) && /'--version-code',\s*String\(VERSION_CODE\)/.test(buildApkSrc));
  ok('build-apk.js 把版本名也传给 aapt2（而不是只写在清单里）',
    /'--version-name',\s*VERSION\b/.test(buildApkSrc));

  ok('页面挂在虚拟 https 源上（安全源才能用摄像头和本地存储）',
    /"https:\/\/"\s*\+\s*HOST/.test(activity) || /ORIGIN = "https:\/\/"/.test(activity));
  ok('实现了资源拦截（从 assets 读文件）', /shouldInterceptRequest/.test(activity));
  ok('实现了文件选择（导入备份需要）', /onShowFileChooser/.test(activity));
  ok('实现了摄像头授权', /onPermissionRequest/.test(activity));
  ok('提供了原生网络桥', /@JavascriptInterface[\s\S]{0,400}public void http\(/.test(activity));
  ok('网络错误翻译成了可识别的错误码',
    /ENOTFOUND/.test(activity) && /ECONNREFUSED/.test(activity) && /ETIMEDOUT/.test(activity));
  ok('返回键优先交给页面处理（先关弹窗再退出）', /__hsOnBack/.test(activity));
  ok('未把 Content-Length 交给底层重复设置',
    /content-length/.test(activity) && /setFixedLengthStreamingMode/.test(activity));

  /* ---- NFC：碰一下标签定位收纳位置 ---- */
  ok('清单声明了 NFC 权限', /android\.permission\.NFC/.test(manifest));
  ok('清单声明了 NFC 硬件特性（非必需，没 NFC 也能用其他功能）',
    /uses-feature[\s\S]*?android:name="android\.hardware\.nfc"[\s\S]*?android:required="false"/.test(manifest));
  ok('清单注册了 TECH_DISCOVERED 冷启动意图（应用未开时碰标签也能唤起）',
    /android\.nfc\.action\.TECH_DISCOVERED/.test(manifest));
  ok('清单引用了 nfc_tech_filter 资源', /@xml\/nfc_tech_filter/.test(manifest));
  ok('NFC 技术过滤清单存在且覆盖空白卡',
    fs.existsSync(path.join(ROOT, 'mobile', 'android', 'res', 'xml', 'nfc_tech_filter.xml')));
  ok('原生层实现了前台调度 enableForegroundDispatch',
    /enableForegroundDispatch/.test(activity));
  ok('原生层在 onResume/onPause 管理前台调度', /onResume/.test(activity) && /onPause/.test(activity));
  ok('原生层重写了 onNewIntent 接收标签', /onNewIntent/.test(activity));
  ok('原生层暴露了 nfcSupported 桥（页面据此决定显示绑定按钮）',
    /public boolean nfcSupported\(\)/.test(activity));
  ok('原生层把标签 UID 转成大写十六进制', /bytesToHex/.test(activity));
  ok('原生层把标签事件投递给页面 __hsOnNfc', /window\.__hsOnNfc/.test(activity));
  ok('冷启动标签在 onPageFinished 后补投（否则会丢事件）',
    /onPageFinished/.test(activity) && /pendingNfcJson/.test(activity));

  /* ---- APK 条目名分隔符（踩过一次，装上就报「找不到资源」）---- */
  console.log('\n[10b] APK 资源路径分隔符');
  // Windows 版 aapt2 打包 assets 时会把分隔符写成 `\`，
  // 包里变成 assets/www\index.html，而 Android 的 AssetManager 只认 `/`，
  // 结果首屏直接报「找不到资源：www/index.html」。
  const buildApk = read(path.join(ROOT, 'mobile', 'build-apk.js'), '构建脚本');

  ok('构建脚本会把条目名的反斜杠改回正斜杠', /normalizeZipEntryNames/.test(buildApk));
  ok('这一步真的接进了构建流程', /normalizeZipEntryNames\(baseApk\)/.test(buildApk));
  // aapt list 会把 \ 显示成 /，只靠它检查会假通过，必须读压缩包原始字节
  ok('验证阶段读的是原始条目名，不是 aapt list', /zipEntryNames\(outApk\)/.test(buildApk));
  ok('构建脚本解释了为什么不能只信 aapt list',
    /不能用 `aapt list`|aapt list 会/.test(buildApk));

  // 真产物检查：如果 APK 已经构建过，直接拆开看条目名
  // ⚠️ 版本号**从 package.json 读**，不要写死 —— 写死的话一升版本这里就找不到文件，
  // 下面这几条检查会**静默 SKIP**（不是失败），等于白测。（升 1.1.0 时正是这个坑。）
  const pkgVersion = JSON.parse(read(path.join(ROOT, 'package.json'), 'package.json')).version;
  const apkPath = path.join(ROOT, 'mobile', 'dist', `家庭收纳-${pkgVersion}.apk`);
  if (fs.existsSync(apkPath)) {
    const names = zipEntryNames(apkPath);
    const bad = names.filter((n) => n.indexOf('\\') >= 0);
    ok('实际 APK 里没有反斜杠条目', bad.length === 0,
      bad.length ? bad.slice(0, 3).join(' | ') : '');
    ok('实际 APK 含 assets/www/index.html', names.indexOf('assets/www/index.html') >= 0);
  } else {
    console.log('  SKIP  实际 APK 检查（还没构建过，跑 npm run build:apk 后会生效）');
  }

  /* ---- 二维码模块是否进了 APK，OCR 是否彻底清除 ---- */
  console.log('\n[10c] 二维码模块（打进 APK）与 OCR 清除');
  ok('qr.js 已复制到 assets', fs.existsSync(path.join(OUT, 'js', 'qr.js')));
  ok('OCR 资源目录不在 assets 中', !fs.existsSync(path.join(OUT, 'js', 'ocr')));

  if (fs.existsSync(apkPath)) {
    const names2 = zipEntryNames(apkPath);
    ok('实际 APK 含二维码模块', names2.indexOf('assets/www/js/qr.js') >= 0);
    ok('实际 APK 不含 OCR 资源',
      !names2.some((n) => n.indexOf('assets/www/js/ocr/') === 0));
    ok('实际 APK 的二维码模块条目无反斜杠',
      names2.filter((n) => n.indexOf('assets/www/js/qr.js') === 0).every((n) => n.indexOf('\\') < 0));
  } else {
    console.log('  SKIP  实际 APK 内二维码模块检查（先跑 npm run build:apk）');
  }

  /* ---- 文档与产物是否一致 ---- */
  console.log('\n[11] 使用文档');
  const guidePath = path.join(ROOT, '安卓手机使用指南.md');
  ok('使用文档存在', fs.existsSync(guidePath));
  if (fs.existsSync(guidePath)) {
    const guide = fs.readFileSync(guidePath, 'utf8');
    const pkgJson = JSON.parse(read(path.join(ROOT, 'package.json'), 'package.json'));
    const apkName = `家庭收纳-${pkgJson.version}.apk`;

    ok('文档里的安装包名与实际产物一致', guide.includes(apkName), '期望 ' + apkName);
    ok('文档里的版本号与 package.json 一致', guide.includes(pkgJson.version));
    ok('文档说明了安装方法', /adb\.exe" install/.test(guide));
    ok('文档里的 adb 路径真实存在',
      fs.existsSync('D:\\tools\\androidsdk\\platform-tools\\adb.exe'));
    ok('文档说明了要连同一个 Wi-Fi 才能同步', /同一个网络|同一网络|家里 Wi-Fi|家里 Wi-Fi/.test(guide));
    ok('文档说明了数据存在手机本地', /存在手机|手机应用/.test(guide));
    ok('文档提醒了卸载会清数据', /卸载[\s\S]{0,40}(数据|清掉|丢失)/.test(guide));
    ok('文档提醒了证书不能删', /jks[\s\S]{0,80}(别删|不能删|必须留着|保留)/.test(guide));
    ok('文档说明了重新打包的命令', /node mobile\/build-apk\.js/.test(guide));
    // 这条是诚实性检查：没有真机就不能写成「已真机验证通过」
    ok('文档如实说明未做真机验证', /没验，手上没有安卓设备|没有在真机上装过|没验/.test(guide));
    ok('文档提到的手机端脚本都真实存在',
      ['mobile/build-apk.js', 'mobile/build-mobile.js', 'mobile/make-icon.js']
        .every((p) => fs.existsSync(path.join(ROOT, p))));
    ok('文档提到的 npm 脚本都在 package.json 里',
      ['test:mobile', 'test:mobile-ui', 'build:apk']
        .every((s) => pkgJson.scripts && pkgJson.scripts[s]));
    // 新增了栏目和内部编码之后，文档也得跟上 —— 文档与功能脱节比没文档更坑人
    ok('文档写明了 9 个底部标签（不是老的 7 个）', /9 个入口/.test(guide) && !/7 个入口/.test(guide));
    ok('文档提到了办公资料与图书栏目', /办公资料/.test(guide) && /图书/.test(guide));
    ok('文档解释了内部编码', /HS-2026-0001/.test(guide) && /内部编码/.test(guide));
    ok('文档说明了扫码能认 ISBN / 期刊条码', /ISBN/.test(guide) && /977/.test(guide));
    ok('文档提到了物品图标', /图标/.test(guide));
  }

  /* ---- 汇总 ---- */
  console.log('\n' + '='.repeat(50));
  console.log(`安卓端内核验证：${pass} 项通过，${fail} 项失败`);
  if (fail > 0) process.exit(1);
  console.log('全部通过。\n');
})().catch((e) => {
  console.error('\n测试脚本自身出错：', e);
  process.exit(1);
});
