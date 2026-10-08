// test-packaging.js
// 校验 Windows 打包相关的文件配置正确，避免以后改坏。
// 重点验证「符号链接问题」的解决方案没有被误删。

'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    console.log('  PASS  ' + name);
    pass++;
  } else {
    console.log('  FAIL  ' + name + (detail ? '  → ' + detail : ''));
    fail++;
  }
}

function read(p) {
  return fs.readFileSync(path.join(root, p), 'utf8');
}

function exists(p) {
  return fs.existsSync(path.join(root, p));
}

console.log('\n=== 打包配置校验 ===\n');

// ---- 1. package.json 的 build 配置 ----
const pkg = JSON.parse(read('package.json'));

ok('package.json 有 build 配置', !!pkg.build);
ok('appId 已设置', pkg.build.appId === 'com.home.storage');
ok('产品名为「家庭收纳」', pkg.build.productName === '家庭收纳');
ok('输出目录为 dist', pkg.build.directories.output === 'dist');
ok('打包目标为 nsis', JSON.stringify(pkg.build.win.target).includes('nsis'));
ok('架构为 x64', JSON.stringify(pkg.build.win.target).includes('x64'));
ok('不自动安装（可选路径）', pkg.build.nsis.oneClick === false);
ok('允许更改安装目录', pkg.build.nsis.allowToChangeInstallationDirectory === true);
ok('创建桌面快捷方式', pkg.build.nsis.createDesktopShortcut === true);
ok('创建开始菜单快捷方式', pkg.build.nsis.createStartMenuShortcut === true);
ok('快捷方式名为「家庭收纳」', pkg.build.nsis.shortcutName === '家庭收纳');
ok('安装包文件名含中文', String(pkg.build.nsis.artifactName).includes('家庭收纳'));

// ---- 2. files / extraResources ----
const filesStr = JSON.stringify(pkg.build.files);
ok('files 含 src 源码', filesStr.includes('src/**/*'));
ok('files 含 package.json', filesStr.includes('package.json'));

const extra = JSON.stringify(pkg.build.extraResources);
ok('extraResources 打包 server 目录', extra.includes('"server"'));
ok('extraResources 含服务端入口', extra.includes('index.js'));
ok('extraResources 含群晖配置', extra.includes('synology-compose'));

// ---- 3. 依赖分类 ----
ok('运行时不依赖原生模块（dependencies 为空）',
  !pkg.dependencies || Object.keys(pkg.dependencies).length === 0);
const devDeps = pkg.devDependencies || {};
// server 端要用的包必须声明在 devDependencies：放 dependencies 会被 electron-builder
// 打进安装包，而服务端是单独部署到 NAS 的（目前只有 pg 一个）。
ok('server 用依赖（pg）放在 devDependencies', !!devDeps.pg);
// bcryptjs / jsonwebtoken 曾经声明过，但全项目没有一处 require ——
// 服务端用的是内置 crypto 的 scrypt 加自制 HMAC-SHA256 JWT。
// 留着只会让人误以为在用它们，这条防止被"顺手加回来"。
ok('没有残留的无用依赖（bcryptjs / jsonwebtoken）',
  !devDeps.bcryptjs && !devDeps.jsonwebtoken);
// ⚠️ @zxing/library 必须保留：它是 test-scan.js 的**独立参照解码器**，
//    用来交叉验证仓库里那份 vendored 的 zxing.min.js 生成的条码是对的。
//    它一旦不在，test-scan 会直接 process.exit(0) 跳过整套断言 ——
//    静默少跑测试比测试失败危险得多。
ok('@zxing/library 保留（test-scan 的参照解码器，删了会静默少跑一套）',
  !!devDeps['@zxing/library']);

// ---- 4. 打包脚本 ----
ok('打包.bat 存在', exists('打包.bat'));
ok('scripts/fetch-tool.js 存在', exists('scripts/fetch-tool.js'));

if (exists('打包.bat')) {
  const bat = read('打包.bat');
  // 关键：-snl 参数是解决符号链接问题的核心，不能被误删
  ok('打包.bat 使用 -snl 参数（符号链接解决方案）', bat.includes('-snl'));
  ok('打包.bat 指向 winCodeSign-2.6.0 缓存', bat.includes('winCodeSign-2.6.0'));
  ok('打包.bat 检查 rcedit-x64.exe', bat.includes('rcedit-x64.exe'));
  ok('打包.bat 配置了 npmmirror 镜像', bat.includes('npmmirror.com'));
  ok('打包.bat 检查 Node.js', bat.includes('where node'));
  ok('打包.bat 设置了 ELECTRON_BUILDER_BINARIES_MIRROR',
    bat.includes('ELECTRON_BUILDER_BINARIES_MIRROR'));
  ok('打包.bat 关闭代码签名', bat.includes('CSC_IDENTITY_AUTO_DISCOVERY'));
  ok('打包.bat 有中文错误提示', bat.includes('以管理员身份运行'));
  // 确认没有遗留会触发 spawn EINVAL 的 .cmd 包装逻辑
  ok('打包.bat 不含 HS_7ZA_PATH（会导致 spawn EINVAL）', !bat.includes('HS_7ZA_PATH'));
}

if (exists('scripts/fetch-tool.js')) {
  const ft = read('scripts/fetch-tool.js');
  ok('fetch-tool 支持重定向跟随', ft.includes('location'));
  ok('fetch-tool 含版本映射表', ft.includes('VERSIONS'));
  ok('fetch-tool 映射 winCodeSign 版本', ft.includes("winCodeSign: 'winCodeSign-2.6.0'"));
  ok('fetch-tool 校验下载大小', ft.includes('下载内容过小'));
}

// ---- 5. 已生成的产物 ----
if (exists('dist')) {
  const distFiles = fs.readdirSync(path.join(root, 'dist'));
  const installer = distFiles.find((f) => f.startsWith('家庭收纳-安装程序-') && f.endsWith('.exe'));
  if (installer) {
    const size = fs.statSync(path.join(root, 'dist', installer)).size;
    ok('安装程序已生成', true);
    ok('安装程序大小合理（>50MB）', size > 50 * 1024 * 1024,
      (size / 1048576).toFixed(1) + ' MB');
    // 校验 PE 头
    const fd = fs.openSync(path.join(root, 'dist', installer), 'r');
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    ok('安装程序是有效 PE 文件', head[0] === 0x4d && head[1] === 0x5a);
  } else {
    console.log('  SKIP  安装程序尚未生成（运行 打包.bat 后会生成）');
  }
}

// ---- 6. 文档同步 ----
if (exists('Windows11使用指南.md')) {
  const guide = read('Windows11使用指南.md');
  ok('指南提到打包.bat', guide.includes('打包.bat'));
  ok('指南解释了符号链接问题', guide.includes('符号链接'));
  ok('指南给出管理员运行方案', guide.includes('以管理员身份运行'));
  ok('指南提到 -snl 参数', guide.includes('-snl'));
  ok('指南提到开发者模式方案', guide.includes('开发者'));
  // 新增栏目/内部编码/图标之后，指南得跟上——文档与功能脱节比没文档更坑人
  ok('指南提到了办公资料与图书栏目', guide.includes('办公资料') && guide.includes('图书'));
  ok('指南解释了内部编码', /HS-2026-0001/.test(guide) && guide.includes('内部编码'));
  ok('指南说明了扫码能认 ISBN / 期刊条码', /ISBN/.test(guide) && /977/.test(guide));
  ok('指南提到了物品图标', guide.includes('图标'));
}

// ---- 6b. 文档里写的测试总数必须三处一致 ----
/*
 * 三份文档都向用户报了「npm test 会跑多少项」，这个数字非常容易漂：
 * 加测试时顺手改了 README，另外两份就忘在脑后。本轮就撞上了 ——
 * README 写着 969、安卓手机使用指南还停在 350、Windows 指南停在 200，
 * 而实际是 995。用户按文档去数，只会觉得「这文档没人维护」。
 *
 * 这一条只保证「三处说的是同一个数」，**不保证这个数就是真实项数** ——
 * 后者得把所有套件跑完才知道，在这里做成本太高。但最常见的错法
 * （改一处、漏两处）它正好能拦住。加测试时请同步改这三个数。
 */
{
  const picks = [
    ['README.md', [/共 (\d+) 项/, /跑全部测试（(\d+) 项）/]],
    ['安卓手机使用指南.md', [/会跑全部 \*\*(\d+) 项\*\*/]],
    ['Windows11使用指南.md', [/会依次跑 (\d+) 项测试/]]
  ];
  const found = [];
  picks.forEach(([file, res]) => {
    if (!exists(file)) return;
    const txt = read(file);
    res.forEach((re) => {
      const m = txt.match(re);
      found.push({ file, n: m ? m[1] : null });
    });
  });
  const missing = found.filter((f) => !f.n);
  ok('三份文档都写了测试总数',
    missing.length === 0,
    '没找到数字：' + missing.map((f) => f.file).join('、'));
  const nums = found.map((f) => f.n).filter(Boolean);
  const allSame = nums.length >= 3 && nums.every((n) => n === nums[0]);
  const shown = [];
  found.forEach((f) => {
    const k = `${f.file}=${f.n || '缺失'}`;
    if (shown.indexOf(k) < 0) shown.push(k);
  });
  ok(`文档里的测试总数三处一致（当前 ${nums[0] || '?'}）`,
    allSame,
    shown.join('，') + '　→ 加/删测试后请同步更新这三处');

  // 手机指南里还单独报了手机相关的两个套件，也得对得上
  const mg = exists('安卓手机使用指南.md') ? read('安卓手机使用指南.md') : '';
  const m1 = mg.match(/test:mobile`?[^\n]*?（(\d+) 项）/);
  const m2 = mg.match(/test:mobile-ui`?[^\n]*?（(\d+) 项）/);
  ok('手机指南里的两个套件项数都写出来了', !!(m1 && m2),
    `test:mobile=${m1 && m1[1]}，test:mobile-ui=${m2 && m2[1]}`);
}

// ---- 6b-2. 文档里的产物名版本号必须与 package.json 一致 ----
/*
 * 文档里写死了安装包的文件名（`家庭收纳-安装程序-1.1.0.exe` / `家庭收纳-1.1.0.apk`），
 * 一升版本这些名字就全变了 —— 漏改一处，用户按文档去 dist 目录里找只会找不到。
 * 这里只校验**版本号那一段**跟 package.json 一致，不管它在文档里出现几次。
 *
 * ⚠️ 服务端的版本号是独立的（server/package.json），文档里 /api/health 的示例响应
 * 写的是服务端那个版本 —— 所以这里只挑「家庭收纳-安装程序-x.y.z.exe」和
 * 「家庭收纳-x.y.z.apk」这两种**客户端产物名**，不会误伤服务端示例。
 */
{
  const docs = ['README.md', 'Windows11使用指南.md', '安卓手机使用指南.md'];
  const bad = [];
  let checked = 0;
  docs.forEach((file) => {
    if (!exists(file)) return;
    const txt = read(file);
    const names = [
      ...txt.matchAll(/家庭收纳-安装程序-(\d+\.\d+\.\d+)\.exe/g),
      ...txt.matchAll(/家庭收纳-(\d+\.\d+\.\d+)\.apk/g)
    ];
    names.forEach((m) => {
      checked++;
      if (m[1] !== pkg.version) bad.push(`${file}: ${m[0]}（应为 ${pkg.version}）`);
    });
  });
  ok('文档里提到了客户端产物名', checked > 0,
    '三份文档里都没找到 家庭收纳-x.y.z.exe / .apk');
  ok(`文档里的产物名版本号与 package.json 一致（当前 ${pkg.version}）`,
    bad.length === 0,
    bad.slice(0, 5).join('；') + '　→ 升版本后要同步改这些名字');
}

// ---- 6c. Windows 通知的应用标识（AUMID）必须和 appId 对上 ----
//
// electron-builder 的 NSIS 安装器把「开始菜单快捷方式」的 AUMID 设成 build.appId，
// 应用侧必须自己调 app.setAppUserModelId(同一个值) —— Electron 只在检测到
// Squirrel 安装器时才会自动设，NSIS 不在自动处理范围内。
// 两边对不上时：Windows 10/11 的通知不显示应用图标、顶着 electron.app.Electron 出现，
// 而且**点击通知回不到本应用**（Windows 靠 AUMID 认是谁发的）；Windows 8/8.1 干脆不显示。
// 临期提醒正是靠通知送达的，所以这一对值必须锁住。
if (exists('src/main/main.js')) {
  const mainSrc = read('src/main/main.js');
  const aumid = /const APP_USER_MODEL_ID = '([^']*)'/.exec(mainSrc);
  ok('主进程声明了 Windows 通知的应用标识', !!aumid, '没找到 APP_USER_MODEL_ID');
  ok('应用标识与 build.appId 完全一致',
    !!aumid && aumid[1] === pkg.build.appId,
    aumid ? `main.js=${aumid[1]}　package.json=${pkg.build.appId}` : '');
  // 用「真实调用」的形状去定位，别用裸字符串 —— 注释里提到 API 名字会先被匹配到，
  // 断言就会因为一句注释而误判（第一次写就踩了：注释里的 `new BrowserWindow` 排在前面）。
  const atSet = mainSrc.search(/app\.setAppUserModelId\s*\(/);
  const atWin = mainSrc.search(/=\s*new BrowserWindow\s*\(/);
  ok('应用标识在任何窗口创建之前设置',
    atSet >= 0 && atWin >= 0 && atSet < atWin,
    `setAppUserModelId@${atSet}　new BrowserWindow@${atWin}　（必须更早）`);
}

// ---- 7. 界面可见性（防止「整个界面发灰」回归）----
// 背景：HTML 的 hidden 属性只是默认样式，任何显式 display 规则都会覆盖它。
// 本项目 .modal-root 设了 display:flex，导致遮罩始终盖在界面上。
// 必须有 [hidden] { display: none !important } 兜底。
if (exists('src/renderer/css/style.css')) {
  const css = read('src/renderer/css/style.css');
  ok('CSS 有 [hidden] 兜底规则', /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css),
    '缺少 [hidden]{display:none!important}，遮罩可能盖住界面');

  // 确认带 hidden 属性的元素中，没有会被显式 display 覆盖的
  const html = read('src/renderer/index.html');
  const hiddenEls = [...html.matchAll(/<[a-z]+[^>]*\bhidden\b[^>]*>/g)].map((m) => m[0]);
  const hiddenIds = hiddenEls
    .map((tag) => (tag.match(/id="([^"]+)"/) || [])[1])
    .filter(Boolean);
  // 这些 id 对应的 class 若有 display 规则，就依赖兜底规则生效
  const atRisk = hiddenIds.filter((id) => {
    const classMatch = html.match(new RegExp('<[a-z]+[^>]*id="' + id + '"[^>]*>'));
    const cls = classMatch ? (classMatch[0].match(/class="([^"]+)"/) || [])[1] : '';
    if (!cls) return false;
    return cls
      .split(/\s+/)
      .some((c) => new RegExp('\\.' + c + '\\s*\\{[^}]*display:').test(css));
  });
  ok('带 hidden 的元素均有兜底保护', atRisk.length === 0 || /\[hidden\][^}]*display:\s*none\s*!important/.test(css),
    '这些元素设置了 display 却依赖 hidden 控制显隐：' + atRisk.join(', '));
}

// ---- 8. 打包产物能真正启动 ----
// 前面几节都是「配置和文件对不对」，这一节真的把 dist/win-unpacked 里的应用跑一遍。
// 光验证「安装包文件存在、是有效 PE」是不够的：asar 打错、资源漏带这类问题
// 只有真启动才会暴露。没打包过就跳过，不阻塞日常开发。
(async () => {
  const exe = path.join(root, 'dist', 'win-unpacked', '家庭收纳.exe');
  if (process.platform !== 'win32' || !fs.existsSync(exe)) {
    console.log('\n[8] 打包产物启动验证 —— 跳过（还没打包过，或不在 Windows 上）');
  } else {
    console.log('\n[8] 打包产物启动验证（真的跑一遍打包后的应用）');
    const os = require('os');
    const { spawn } = require('child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-pkg-'));
    const cfg = path.join(tmp, 'cfg.json');
    fs.writeFileSync(cfg, JSON.stringify({ userData: tmp, shotDir: '' }), 'utf8');

    const env = Object.assign({}, process.env, { HS_E2E: '1', HS_E2E_CONFIG: cfg });
    delete env.ELECTRON_RUN_AS_NODE; // 不清掉的话 exe 会退化成纯 Node，拿不到窗口 API

    const child = spawn(exe, ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      { cwd: path.dirname(exe), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    // 判据是「结果有没有出来」，不是「进程有没有退出」。
    // 有些机器上 Electron 进程执行完自己的逻辑后不会自行消失（用最小探针脚本
    // 复现过，app.quit() / app.exit(0) 都一样），原来干等 exit 会白等 90 秒超时；
    // 更糟的是超时分支把已收到的输出丢掉了，失败信息只剩一句
    // 「没拿到结果，输出末尾：」—— 等于没有信息。
    const done = await new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const settle = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { child.kill(); } catch (e) {}
        resolve(out);
      };
      timer = setTimeout(settle, 90000);
      child.stdout.on('data', (d) => {
        out += d.toString();
        // 正则带换行：只匹配到 "E2E_RESULT: {" 会在 JSON 还没收全时就抢跑
        if (/E2E_RESULT: \{.*\}\n/.test(out)) settle();
      });
      child.stderr.on('data', (d) => (out += d.toString()));
      child.on('exit', settle);
    });

    const m = done && done.match(/E2E_RESULT: (\{.*\})/);
    if (!m) {
      ok('打包后的应用能启动并返回结果', false, '没拿到结果，输出末尾：' + String(done || '').slice(-300));
    } else {
      const r = JSON.parse(m[1]);
      ok('打包后的应用能启动并返回结果', true);
      ok('打包后窗口标题正确', r.title === '家庭收纳', 'got ' + r.title);
      ok('打包后渲染层脚本齐全', r.hasApp === true && r.hasViews === true);
      ok('打包后 IPC 桥接可用', r.hasApi === true);
      ok('打包后七个页面齐全',
        ['dashboard', 'items', 'scan', 'expiry', 'locations', 'stats', 'settings'].every((v) => r.views.includes(v)),
        (r.views || []).join(','));
      ok('打包后数据层连通', r.summaryOk === true && r.saveOk === true && r.exportOk === true);
      ok('打包后没有遮罩误显示', r.modalVisible === false);
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n打包配置校验：通过 ' + pass + ' 项，失败 ' + fail + ' 项\n');
  process.exit(fail === 0 ? 0 : 1);
})();
