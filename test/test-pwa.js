'use strict';
/**
 * PWA（手机版界面）验证
 * ---------------------------------------------------------------------------
 * 这一套守的是「把界面托管到 NAS，iPhone 加到主屏幕就能用」这条路。
 * 它不测业务逻辑（那些由 test-mobile / test-ui 覆盖），只测三件事：
 *
 *   1. 构建产物对不对 —— manifest 内容、图标是不是真 PNG 且尺寸正确、
 *      页面里 PWA 那几个 meta 有没有漏（漏一个 iOS 上就是个普通书签）；
 *   2. 产物是不是当前源码构建出来的 —— 和 test-mobile 一样靠 build-info.json
 *      重算哈希。构建产物和源码脱节是这套里最隐蔽的坑。
 *   3. 服务端静态托管对不对 —— MIME、404、以及**路径穿越必须挡住**
 *      （/app/../index.js 能把服务端源码读出去，这条不能只靠 URL 解析器顺手帮忙）。
 */
const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'server', 'public');
const ANDROID_OUT = path.join(ROOT, 'mobile', 'android', 'assets', 'www');

let pass = 0;
let fail = 0;
const ok = (n, c, e) => {
  if (c) {
    pass++;
    console.log('  PASS  ' + n);
  } else {
    fail++;
    console.log('  FAIL  ' + n + (e ? '  → ' + e : ''));
  }
};

const read = (p) => fs.readFileSync(p, 'utf8');

/* ---------------- 1. 产物存在 ---------------- */

console.log('\n[PWA-1] 构建产物是否齐全');

const REQUIRED = [
  'index.html',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'css/style.css',
  'css/mobile.css',
  'js/hs-core.js',
  'js/zxing.min.js',
  'js/qr.js',
  'js/icons.js',
  'js/util.js',
  'js/components.js',
  'js/views.js',
  'js/app.js'
];

if (!fs.existsSync(PUBLIC_DIR)) {
  ok('server/public 存在', false, '先执行 npm run build:mobile-assets');
} else {
  ok('server/public 存在', true);
  const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(PUBLIC_DIR, f)));
  ok(`产物齐全（${REQUIRED.length} 个文件）`, missing.length === 0, '缺少：' + missing.join('、'));
}

const html = fs.existsSync(path.join(PUBLIC_DIR, 'index.html'))
  ? read(path.join(PUBLIC_DIR, 'index.html'))
  : '';

/* ---------------- 2. manifest ---------------- */

console.log('\n[PWA-2] manifest 内容');

let manifest = null;
try {
  manifest = JSON.parse(read(path.join(PUBLIC_DIR, 'manifest.webmanifest')));
} catch (e) {
  ok('manifest 是合法 JSON', false, String(e.message));
}
if (manifest) {
  ok('manifest 是合法 JSON', true);
  ok('有应用名 name', manifest.name === '家庭收纳', String(manifest.name));
  ok('有短名 short_name（主屏幕图标下面显示的就是它）', !!manifest.short_name, String(manifest.short_name));
  ok('display 是 standalone（否则点开还是带地址栏的浏览器）',
    manifest.display === 'standalone', String(manifest.display));
  ok('start_url 指向应用自身', manifest.start_url === './', String(manifest.start_url));
  ok('scope 覆盖应用目录', manifest.scope === './', String(manifest.scope));
  ok('声明了中文语言', manifest.lang === 'zh-CN', String(manifest.lang));
  ok('有 theme_color', /^#[0-9a-f]{6}$/i.test(manifest.theme_color || ''), String(manifest.theme_color));
  ok('有 background_color（启动画面用它，不设会闪白屏）',
    /^#[0-9a-f]{6}$/i.test(manifest.background_color || ''), String(manifest.background_color));

  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  const sizes = icons.map((i) => i.sizes);
  ok('图标列表里有 192×192', sizes.indexOf('192x192') >= 0, sizes.join(','));
  ok('图标列表里有 512×512（安卓安装横幅要求至少这一档）',
    sizes.indexOf('512x512') >= 0, sizes.join(','));
  ok('图标声明为 PNG', icons.length > 0 && icons.every((i) => i.type === 'image/png'),
    icons.map((i) => i.type).join(','));
  ok('至少有一个 maskable 图标（否则安卓裁圆角会切到图形）',
    icons.some((i) => String(i.purpose || '').includes('maskable')),
    icons.map((i) => i.purpose).join(','));

  // 相对路径才能在服务端挂到任意子路径时都对
  const absPaths = icons.filter((i) => /^\//.test(i.src || '')).map((i) => i.src);
  ok('图标用的是相对路径（绝对路径换挂载点就全断）', absPaths.length === 0, absPaths.join(','));

  const missingIcons = icons
    .map((i) => i.src)
    .filter((src) => src && !fs.existsSync(path.join(PUBLIC_DIR, src)));
  ok('manifest 里声明的图标文件都真实存在', missingIcons.length === 0, missingIcons.join(','));
}

/* ---------------- 3. 图标是真 PNG 且尺寸对得上 ---------------- */

console.log('\n[PWA-3] 图标文件本身');

const PNG_MAGIC = '89504e470d0a1a0a';
const ICONS = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  // iOS 的「添加到主屏幕」只认这个文件名和这个尺寸
  ['apple-touch-icon.png', 180]
];

for (const [name, size] of ICONS) {
  const p = path.join(PUBLIC_DIR, name);
  if (!fs.existsSync(p)) {
    ok(`${name} 存在`, false, '文件不在');
    continue;
  }
  const b = fs.readFileSync(p);
  ok(`${name} 是真正的 PNG（不是改了后缀的别的格式）`,
    b.slice(0, 8).toString('hex') === PNG_MAGIC, b.slice(0, 8).toString('hex'));
  ok(`${name} 尺寸是 ${size}×${size}`,
    b.readUInt32BE(16) === size && b.readUInt32BE(20) === size,
    `${b.readUInt32BE(16)}×${b.readUInt32BE(20)}`);
}

/* ---------------- 4. 页面里的 PWA 声明 ---------------- */

console.log('\n[PWA-4] index.html 的 PWA 声明');

if (!html) {
  ok('index.html 可读', false, '文件不在');
} else {
  ok('引入了 manifest', /<link rel="manifest" href="manifest\.webmanifest">/.test(html));
  ok('引用了 apple-touch-icon',
    /<link rel="apple-touch-icon" href="apple-touch-icon\.png">/.test(html));
  // 这行才是 iOS 上「不显示地址栏」的关键，manifest 里的 display 在 iOS 上不够
  ok('声明了 apple-mobile-web-app-capable（iOS 全靠它）',
    /<meta name="apple-mobile-web-app-capable" content="yes">/.test(html));
  ok('声明了主屏幕名称', /apple-mobile-web-app-title/.test(html));
  ok('声明了 theme-color', /<meta name="theme-color" content="#[0-9a-f]{6}">/i.test(html));

  // 这三条是「手机浏览器里能用」的前提，构建时必须注入
  ok('有 viewport（没有它手机会按 980px 渲染）', /name="viewport"/.test(html));
  ok('挂载了移动端样式 mobile.css',
    /href="css\/mobile\.css"/.test(html) && html.indexOf('css/mobile.css') > html.indexOf('css/style.css'));
  ok('引入了运行内核 hs-core.js', /src="js\/hs-core\.js"/.test(html));
  ok('运行内核排在渲染层脚本之前（app.js 直接用 window.api）',
    html.indexOf('js/hs-core.js') < html.indexOf('js/util.js'));

  ok('CSP 仍然在（托管到公网也不能松）', /Content-Security-Policy/.test(html));
  ok('CSP 没有放开 eval / wasm', !/unsafe-eval|wasm-unsafe-eval/.test(html));

  // 局域网 http 下外链要么拖慢要么直接失败，页面必须自给自足
  const externals = html.match(/(?:src|href)="https?:\/\/[^"]+"/g) || [];
  ok('页面不引用任何外部地址', externals.length === 0, externals.join(', '));

  ok('页面是完整 HTML', /<\/html>\s*$/.test(html.trim()));
}

/* ---------------- 5. 产物是不是当前源码构建的 ---------------- */

console.log('\n[PWA-5] 产物与源码一致（改了源码必须先重建）');

const infoPath = path.join(PUBLIC_DIR, 'build-info.json');
if (!fs.existsSync(infoPath)) {
  ok('build-info.json 存在', false, '先执行 npm run build:mobile-assets');
} else {
  const info = JSON.parse(read(infoPath));
  const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
  const src = info.sources || {};
  const rels = Object.keys(src);
  ok('构建清单记录了源文件哈希', rels.length > 0, '清单是空的');

  const stale = rels.filter((rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return true;
    return sha(read(abs)) !== src[rel];
  });
  ok(`产物是最新源码构建出来的（比对了 ${rels.length} 个源文件）`,
    stale.length === 0,
    '以下文件改过但没重建：' + stale.join('、') + '（执行 npm run build:mobile-assets）');
}

/* ---------------- 6. 浏览器端与安卓端跑的是同一份代码 ---------------- */

console.log('\n[PWA-6] 浏览器端与安卓端不能各维护一份');

if (fs.existsSync(ANDROID_OUT)) {
  const SHARED = ['js/hs-core.js', 'js/app.js', 'js/views.js', 'js/util.js', 'js/components.js', 'js/qr.js', 'js/icons.js', 'css/style.css', 'css/mobile.css'];
  const diff = SHARED.filter((f) => {
    const a = path.join(ANDROID_OUT, f);
    const b = path.join(PUBLIC_DIR, f);
    if (!fs.existsSync(a) || !fs.existsSync(b)) return true;
    return !fs.readFileSync(a).equals(fs.readFileSync(b));
  });
  ok(`两端 ${SHARED.length} 个共享文件逐字节相同`, diff.length === 0, '不一致：' + diff.join('、'));

  const androidHtml = read(path.join(ANDROID_OUT, 'index.html'));
  // 安卓端不该有 manifest（那是浏览器的事），浏览器端必须有 —— 差异只允许在这一处
  ok('安卓端 index.html 不带 PWA 声明', !/manifest\.webmanifest/.test(androidHtml));
  const stripped = html.replace(/<!-- PWA[\s\S]*?<meta name="theme-color"[^>]*>\n/, '');
  ok('浏览器端 index.html 除了 PWA 那几行，与安卓端完全一致',
    stripped === androidHtml,
    '两端页面结构已经分叉了');
} else {
  ok('安卓端产物存在（用于比对）', false, '先执行 npm run build:mobile-assets');
}

/* ---------------- 7. 服务端静态托管 ---------------- */

console.log('\n[PWA-7] 服务端静态托管');

const fakePool = {
  async query(sql) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s === 'SELECT 1') return { rows: [{}], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'pg') return '__fake_pg__';
  return origResolve.call(this, request, ...args);
};
const origLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'pg') return { Pool: function () { return fakePool; } };
  return origLoad.call(this, request, ...args);
};

const PORT = 18789;
process.env.PORT = String(PORT);
process.env.JWT_SECRET = 'test-secret-key';
process.env.DB_HOST = 'fake';

function req(method, pathname, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method, headers: headers || {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) });
        });
      }
    );
    r.on('error', reject);
    r.end();
  });
}

const srvSrc = read(path.join(ROOT, 'server', 'index.js'));

(async () => {
  require(path.join(ROOT, 'server', 'index.js'));
  await new Promise((r) => setTimeout(r, 900));

  const appRoot = await req('GET', '/app/');
  ok('GET /app/ 返回 200', appRoot.status === 200, 'got ' + appRoot.status);
  ok('返回的是 HTML', /text\/html/.test(appRoot.headers['content-type'] || ''),
    appRoot.headers['content-type']);
  ok('返回的就是构建出来的那份页面',
    appRoot.buf.toString('utf8') === html, '内容和 server/public/index.html 对不上');

  const noSlash = await req('GET', '/app');
  ok('GET /app（没有斜杠）会跳到 /app/',
    noSlash.status === 302 && noSlash.headers.location === '/app/',
    noSlash.status + ' ' + noSlash.headers.location);

  const jsRes = await req('GET', '/app/js/hs-core.js');
  ok('/app/js/hs-core.js 返回 200', jsRes.status === 200, 'got ' + jsRes.status);
  ok('JS 的 Content-Type 是 application/javascript',
    /application\/javascript/.test(jsRes.headers['content-type'] || ''),
    jsRes.headers['content-type']);

  const cssRes = await req('GET', '/app/css/mobile.css');
  ok('CSS 的 Content-Type 是 text/css',
    cssRes.status === 200 && /text\/css/.test(cssRes.headers['content-type'] || ''),
    cssRes.status + ' ' + cssRes.headers['content-type']);

  const mfRes = await req('GET', '/app/manifest.webmanifest');
  ok('manifest 的 Content-Type 是 application/manifest+json',
    mfRes.status === 200 && /application\/manifest\+json/.test(mfRes.headers['content-type'] || ''),
    mfRes.status + ' ' + mfRes.headers['content-type']);

  const iconRes = await req('GET', '/app/icon-192.png');
  ok('图标返回 200 且 Content-Type 是 image/png',
    iconRes.status === 200 && iconRes.headers['content-type'] === 'image/png',
    iconRes.status + ' ' + iconRes.headers['content-type']);
  ok('传出去的图标和磁盘上的一致',
    iconRes.buf.equals(fs.readFileSync(path.join(PUBLIC_DIR, 'icon-192.png'))));

  // 静态文件名没有内容哈希，靠 ETag 做条件请求：没变回 304，变了立刻生效
  const etag = iconRes.headers.etag;
  ok('静态资源带 ETag', !!etag, String(etag));
  const notModified = await req('GET', '/app/icon-192.png', { 'If-None-Match': etag });
  ok('带上 If-None-Match 时返回 304（省流量又不吃旧缓存）',
    notModified.status === 304, 'got ' + notModified.status);
  const cacheCtl = String(iconRes.headers['cache-control'] || '');
  ok('没有对静态资源做长缓存（否则改了界面用户会拿到旧的）',
    cacheCtl.indexOf('max-age') < 0 || /max-age=0/.test(cacheCtl), cacheCtl);

  const notFound = await req('GET', '/app/nope.js');
  ok('不存在的文件返回 404', notFound.status === 404, 'got ' + notFound.status);

  // ---- 路径穿越：这是静态托管最容易出人命的地方 ----
  // 直接写 .. 会被 URL 解析器规范化掉，所以这里用百分号编码绕过它，
  // 专门考验服务端自己的那道守卫。
  const trav1 = await req('GET', '/app/%2e%2e%2findex.js');
  const trav1Body = trav1.buf.toString('utf8');
  ok('百分号编码的 ../ 被挡住（不是 200）', trav1.status !== 200, 'got ' + trav1.status);
  ok('挡住时没有把服务端源码吐出来',
    !/JWT_SECRET|createHmac|require\('http'\)/.test(trav1Body), trav1Body.slice(0, 120));

  const trav2 = await req('GET', '/app/..%2f..%2fpackage.json');
  ok('更深的 ../ 也被挡住', trav2.status !== 200, 'got ' + trav2.status);

  const trav3 = await req('GET', '/app/../index.js');
  ok('未编码的 ../ 也读不到服务端源码（URL 解析会先规范化，同样不是 200）',
    trav3.status !== 200 && !/JWT_SECRET/.test(trav3.buf.toString('utf8')),
    'got ' + trav3.status);

  // ---- public 没上传时的兜底 ----
  // 这条只能在源码层面锁：测试环境里 public 一定存在，跑不到那个分支。
  ok('public 目录缺失时给人话提示，而不是冷冰冰的 404',
    /if \(!fs\.existsSync\(PUBLIC_DIR\)\) return sendHtml\(res, 200, missingAppPage\(\)\)/.test(srvSrc));
  ok('提示页说明了要把 public 一起传上去',
    /server\/public/.test(srvSrc) && /传到 NAS/.test(srvSrc));

  // ---- 状态页要能引导到手机版 ----
  const home = await req('GET', '/');
  const homeText = home.buf.toString('utf8');
  // 必须精确到「地址块」里那一串。
  // 反向验证抓到的坑：状态页正文里还有一句「注意去掉 /app/」，
  // 所以只要写 includes('/app/')，把地址整块删掉断言照样是绿的。
  ok('状态页给出了手机版地址',
    homeText.includes('http://127.0.0.1:' + PORT + '/app/'),
    '状态页里没有 http://127.0.0.1:' + PORT + '/app/');
  ok('状态页提醒首次打开是空的、要去设置里填同步地址',
    /首次打开是空的/.test(homeText) && /数据同步/.test(homeText));
  ok('状态页说明了 http 下扫码不可用',
    /http 下扫码用不了/.test(homeText));
  ok('状态页没有渲染出 undefined', !/undefined/.test(homeText));
  ok('状态页没有未替换的模板占位符', !/\$\{/.test(homeText));

  /* ---------------- 8. 部署链路 ---------------- */

  console.log('\n[PWA-8] 部署链路：镜像里也得有 public');
  // 免构建版把整个 server 目录挂进容器，public 天然带上；
  // 但 build: . 那一版是靠 Dockerfile COPY 进去的 —— 漏掉那一行，镜像里就没有
  // /app/public，访问 /app/ 只会看到「手机版网页还没有上传」的提示页。
  // 这种漏法在本地怎么跑都发现不了（本地永远有 public），只能靠这条断言盯着。
  {
    const df = read(path.join(ROOT, 'server', 'Dockerfile'));
    ok('Dockerfile 把 public 打进镜像', /^COPY public \.\/public\s*$/m.test(df),
      'Dockerfile 里没有 COPY public ./public，镜像版的 /app/ 会是空的');

    const simple = read(path.join(ROOT, 'server', 'synology-compose-simple.yml'));
    ok('免构建版挂载了整个 server 目录（public 自动带上）',
      /^\s+- \/volume1\/docker\/home-storage:\/app\s*$/m.test(simple),
      '免构建版的挂载点不是整个目录，public 会漏');
  }

  console.log('\n========================================');
  console.log(`  PWA 通过 ${pass} 项，失败 ${fail} 项`);
  console.log('========================================\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
