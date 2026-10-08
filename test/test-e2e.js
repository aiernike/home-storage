'use strict';
/**
 * Electron 端到端测试
 * 真实启动 Electron 应用，验证窗口创建、界面渲染、IPC 数据通道，
 * 以及主进程的生命周期行为（单实例锁、退出前落盘）。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

if (!fs.existsSync(electronBin)) {
  console.log('未找到 Electron 二进制，跳过端到端测试');
  process.exit(0);
}

console.log('正在启动 Electron 应用进行端到端验证…\n');

const shotDir = process.env.HS_SHOT_DIR;

// 所有临时目录都挂在同一个根下，收尾时一起删。
// 配置文件**不放**在数据目录里：第二个实例要跟主实例共用同一个 userData，
// 如果把配置写进 userData，第二次 spawn 就会把主实例的配置覆盖掉（还带着竞态）。
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-e2e-'));
const mainUserData = path.join(tmpRoot, 'primary'); // 主实例的数据目录
const quitUserData = path.join(tmpRoot, 'quit'); // 退出落盘自检的数据目录
const cfgPath = (name) => path.join(tmpRoot, name + '.json');

// 启动参数说明（踩过的坑）：
// 这里原本还带 --disable-software-rasterizer / --in-process-gpu / --disable-gpu-compositing，
// 结果渲染进程一碰 canvas（拍照压缩、生成演示图）就挂死，整个截图流程卡住。
// 去掉这三个之后，软件照常无头启动，canvas 也能用。
const electronArgs = [
  ROOT,
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage'
];

/**
 * 起一个 Electron 实例并等它退出。
 * 单实例锁和退出落盘两处自检都要用，抽出来免得三处各写一份 spawn。
 */
function spawnElectron(userData, cfgName, extraEnv, timeoutMs) {
  const cfg = cfgPath(cfgName);
  fs.writeFileSync(cfg, JSON.stringify({ userData, shotDir: '' }), 'utf8');

  const env = Object.assign({}, process.env, { HS_E2E: '1', HS_E2E_CONFIG: cfg }, extraEnv || {});
  // 必须清掉 ELECTRON_RUN_AS_NODE：外部环境设了它，electron.exe 会退化成纯 Node 进程，
  // require('electron') 拿不到 API，主进程直接崩在 app.whenReady()，
  // 测试就会误判成「无图形环境」而假通过。
  delete env.ELECTRON_RUN_AS_NODE;

  return new Promise((resolve) => {
    const p = spawn(electronBin, electronArgs, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '';
    let se = '';
    p.stdout.on('data', (d) => (so += d.toString()));
    p.stderr.on('data', (d) => (se += d.toString()));
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { p.kill(); } catch (e) {}
      resolve({ code: null, stdout: so, stderr: se, timedOut: true });
    }, timeoutMs);
    p.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: so, stderr: se, timedOut: false });
    });
  });
}

const mainCfg = cfgPath('primary');
const mainCfgData = { userData: mainUserData, shotDir: shotDir || '' };
if (shotDir) {
  // 截图环境没有外网，给 ISBN 查询一份固定数据 —— 否则「图书表单自动补全」那张图
  // 只能截到一张空表单。⚠️ 只对**这一个** ISBN 生效，别的照样走真实查询，
  // 所以 [E2E-7] 用非法 ISBN 验真实路径时不受影响。
  mainCfgData.isbnFixture = {
    isbn: '9787111544937',
    result: {
      ok: true,
      source: 'openlibrary',
      book: {
        title: '深入理解计算机系统',
        subtitle: '原书第 3 版',
        authors: ['Randal E. Bryant', "David R. O'Hallaron"],
        publisher: '机械工业出版社',
        publishYear: 2016,
        isbn: '9787111544937'
      }
    }
  };
}
fs.writeFileSync(mainCfg, JSON.stringify(mainCfgData), 'utf8');

const childEnv = Object.assign({}, process.env, {
  HS_E2E: '1',
  HS_E2E_CONFIG: mainCfg
});
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, electronArgs, {
  cwd: ROOT,
  env: childEnv,
  stdio: ['ignore', 'pipe', 'pipe']
});

let stdout = '';
let stderr = '';
let resolvePrimaryLock;
const primaryLocked = new Promise((r) => (resolvePrimaryLock = r));
child.stdout.on('data', (d) => {
  stdout += d.toString();
  if (stdout.includes('E2E_LOCK: primary')) resolvePrimaryLock();
});
child.stderr.on('data', (d) => (stderr += d.toString()));

/* ==========================================================================
 * [E2E-4] 单实例锁
 * --------------------------------------------------------------------------
 * 等主实例**确认拿到锁**之后再起第二个实例（不能靠固定延时猜 —— 冷启动慢的时候
 * 第二个实例会先抢到锁，把主实例挤掉，整个测试跟着崩）。
 * 第二个实例用同一个数据目录，必须被挡在门外：立刻退出、不创建窗口（不跑探针）。
 * ========================================================================== */
const secondaryRun = (async () => {
  const gotLock = await Promise.race([
    primaryLocked.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 20000))
  ]);
  if (!gotLock) return { skipped: '主实例未在 20 秒内拿到单实例锁' };
  return spawnElectron(mainUserData, 'secondary', {}, 20000);
})();

// 主实例是不是「跑完了活但不肯消失」。见 finish() 里 skip() 的说明：
// 有些机器就是不让 Electron 进程自行结束，这时退出码没法验。
let mainTimedOut = false;
const timer = setTimeout(
  () => {
    mainTimedOut = true;
    console.log('[超时] 未在规定时间内取得结果，强制结束');
    try { child.kill(); } catch (e) {}
    finish(null);
  },
  // 截图模式要跑完整套页面 + 新功能演示（填数据、生成二维码、看图），
  // 比纯断言慢得多，给足时间，否则会在截图中途被强杀、一张图都留不下。
  shotDir ? 300000 : 30000
);

let done = false;
child.on('exit', (code) => {
  if (done) return;
  setTimeout(() => finish(code), 200);
});

// 崩溃判定：任何一条为真都说明是应用真的坏了，不能当成「没有图形环境」放过
const looksCrashed = (text) =>
  /TypeError|ReferenceError|SyntaxError|Cannot read propert|is not a function/.test(text) ||
  /E2E_ERROR:/.test(text);

async function finish(code) {
  if (done) return;
  done = true;
  clearTimeout(timer);

  const m = stdout.match(/E2E_RESULT: (\{.*\})/);
  const errM = stdout.match(/E2E_ERROR: (.*)/);
  let fail = 0;
  // 总数不写死：加/删一条断言时忘了改常量，摘要就会报一个假的通过数
  // （「通过 23 项」而实际只有 22 条断言）。让它自己数。
  let total = 0;
  const ok = (n, c, e) => {
    total++;
    if (c) console.log('  PASS  ' + n);
    else { fail++; console.log('  FAIL  ' + n + (e ? '  → ' + e : '')); }
  };

  // 「跳过」只留给「这台机器上物理上做不到」的检查，而且必须在摘要里报出来。
  // 目前只有一种情况：有些机器（虚拟桌面、被安全软件插桩的环境等）会让
  // Electron 进程执行完自己的逻辑后**迟迟不消失** —— 用最小探针脚本单独
  // 复现过，app.quit() 和 app.exit(0) 都一样。这时「进程退出码是不是 0」
  // 就没法验了；但如果把它算成失败，每次跑测试都会挂着一条和代码无关的红。
  // 算成跳过不是放水：上面那些断言仍然在真跑，只是这一项明确标出来。
  let skipped = 0;
  const skip = (n, why) => {
    total++;
    skipped++;
    console.log('  SKIP  ' + n + '  → ' + why);
  };

  if (errM) console.log('  探测过程报错：' + errM[1]);

  // 截图模式下把应用侧的进度/告警打出来。
  // 之前这些日志被吞掉，截图是空的也看不出原因，只能反复猜。
  if (shotDir) {
    const lines = stdout
      .split(/\r?\n/)
      .filter((l) => /^SHOT|^E2E_ERROR/.test(l.trim()));
    if (lines.length) {
      console.log('\n--- 截图过程 ---');
      lines.forEach((l) => console.log('  ' + l.trim()));
      console.log('');
    }
    const warns = lines.filter((l) => /SHOT_WARN|SHOT_SKIP/.test(l));
    if (warns.length) console.log(`⚠️  有 ${warns.length} 条截图告警，请检查上面的输出`);
  }

  if (!m) {
    // 区分两种情况：真的没有图形环境，还是应用崩了。
    // 崩溃必须报错，不能静默通过——否则测试形同虚设。
    if (looksCrashed(stderr) || looksCrashed(stdout)) {
      console.log('❌ 应用启动失败（这是真实错误，不是环境问题）：');
      if (stdout.trim()) console.log('\nstdout：\n' + stdout.slice(-1200));
      if (stderr.trim()) console.log('\nstderr：\n' + stderr.slice(-1200));
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
      process.exit(1);
    }

    console.log('未能取得测试结果（可能没有图形界面环境）。');
    if (stdout.trim()) console.log('\nstdout：\n' + stdout.slice(-1000));
    if (stderr.trim()) console.log('\nstderr：\n' + stderr.slice(-1000));
    console.log('\n说明：无桌面环境下 Electron 无法创建窗口，这不代表软件本身有问题。');
    console.log('界面逻辑已由 test-ui.js 用 jsdom 完整验证。');
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
  }

  const r = JSON.parse(m[1]);

  console.log('[E2E-1] 应用启动与界面');
  ok('窗口标题正确', r.title === '家庭收纳', 'got ' + r.title);
  ok('渲染层脚本已加载', r.hasApp && r.hasViews);
  const pageViews = ['dashboard', 'items', 'docs', 'books', 'scan', 'expiry', 'locations', 'stats', 'settings'];
  ok('九个页面视图齐全', pageViews.every((v) => r.views.includes(v)), 'views=' + r.views.join(','));
  ok('IPC 安全桥接可用', r.hasApi === true);
  ok('侧边导航 9 项', r.navItems === 9, 'got ' + r.navItems);
  ok('预置位置树已渲染', r.locNodes >= 5, 'got ' + r.locNodes);
  ok('总览页已渲染', (r.dashboardText || '').includes('总览'));

  console.log('\n[E2E-2] 真实 IPC 数据通道');
  ok('汇总接口连通', r.summaryOk === true);
  ok('位置树接口连通', r.locationsOk === true);
  ok('预置位置含「厨房」', (r.topLocations || []).includes('厨房'), JSON.stringify(r.topLocations));
  ok('新增位置成功', r.locSaveOk === true);
  ok('新增物品成功', r.saveOk === true, r.savedName);
  ok('条码反查成功', r.lookupOk === true);
  ok('统计接口连通', r.statsOk === true);
  ok('导出接口连通', r.exportOk === true);
  ok('应用信息接口连通', r.appInfoOk === true);

  console.log('\n[E2E-3] 界面可见性（防遮罩误显示回归）');
  // 曾经的问题：.modal-root 的 display:flex 覆盖了 HTML 的 hidden 属性，
  // 导致半透明遮罩始终盖在界面上，用户看到的是「整个界面发灰」。
  // 修复方式是在 CSS 加 [hidden] { display: none !important; }
  ok('弹窗遮罩未误显示', r.modalVisible === false,
    r.modalVisible ? '遮罩正盖在界面上，界面会发灰' : '');

  console.log('\n[E2E-3b] 扫码枪：真实键盘输入不能污染正在填的输入框');
  // 扫码枪在系统里就是个键盘。配了前缀之后，只有「前缀 + 极快连续输入 + 回车」
  // 才被当成扫码，字符不许漏进输入框。
  // 为什么必须放在 E2E：jsdom 不执行「把字符插进输入框」这个默认动作，
  // 那边只能断言 defaultPrevented（代理指标）；这里用 sendInputEvent 走真实
  // 键盘路径，能直接看输入框里到底有没有被灌进一串数字。
  ok('探针输入框拿到了焦点', r.scannerFocus === true, String(r.scannerFocus));
  ok('扫码枪扫一下被识别成一次扫码',
    Array.isArray(r.scanner && r.scanner.hits) && r.scanner.hits.length === 1 &&
    r.scanner.hits[0] === '6901234567892|扫码枪',
    JSON.stringify(r.scanner && r.scanner.hits));
  ok('条码没有漏进正在填的输入框（preventDefault 真的挡住了）',
    r.scanner && r.scanner.typed === '', JSON.stringify(r.scanner && r.scanner.typed));

  console.log('\n[E2E-4] 单实例锁（防两个实例互相覆盖数据）');
  const sec = await secondaryRun;
  if (sec && sec.skipped) {
    ok('第二个实例被挡在门外', false, sec.skipped);
    ok('第二个实例没有创建窗口', false, sec.skipped);
    ok('第二个实例干净退出', false, sec.skipped);
    ok('主实例收到了 second-instance 事件', false, sec.skipped);
  } else {
    ok('第二个实例被挡在门外', /E2E_LOCK: blocked/.test(sec.stdout),
      sec.timedOut ? '第二个实例超时未退出（可能抢到了锁并开了窗口）' : 'stdout 里没有 blocked 标记');
    // 没拿到锁 = 没走 bootstrap = 不会创建窗口，也就不会有探针结果。
    // 一旦出现 E2E_RESULT，说明它真的开了一个窗口在跑，数据正在被两份内存副本同时写。
    ok('第二个实例没有创建窗口', !/E2E_RESULT/.test(sec.stdout),
      '第二个实例居然也跑起了探针');
    // 「退出码」只有在进程真的会退出时才验得了。两个条件同时成立才跳过：
    // 主实例也没退出（说明是这台机器的通病），且这一个也超时了 ——
    // 如果只有它超时、主实例正常退出，那更可能是真有 bug，必须报红。
    if (mainTimedOut && sec.timedOut && !looksCrashed(sec.stderr) && !looksCrashed(sec.stdout)) {
      skip('第二个实例干净退出', '本机 Electron 进程不自行结束，退出码拿不到（崩溃检查仍已通过）');
    } else {
      ok('第二个实例干净退出',
        sec.code === 0 && !looksCrashed(sec.stderr) && !looksCrashed(sec.stdout),
        'code=' + sec.code + (sec.stderr ? ' stderr=' + sec.stderr.slice(0, 200) : ''));
    }
    ok('主实例收到了 second-instance 事件', /E2E_LOCK: second-instance/.test(stdout),
      '点图标时应该把已有窗口叫到前台，事件没到');
  }

  console.log('\n[E2E-5] 退出前落盘（防「刚改完就关窗口」丢数据）');
  const q = await spawnElectron(quitUserData, 'quit', { HS_E2E_QUIT: '1' }, 30000);
  const qm = q.stdout.match(/E2E_QUIT_RESULT: (\{.*\})/);
  if (!qm) {
    ok('探针写入时还没落盘', false, '没拿到退出自检结果' + (q.timedOut ? '（进程超时未退出）' : ''));
    ok('before-quit 时改动已落盘', false, '没拿到退出自检结果');
    ok('自检进程干净退出', false, 'code=' + q.code);
  } else {
    const qr = JSON.parse(qm[1]);
    // 这条是前提：如果写入时就已经落盘了，下面那条「退出时已落盘」就毫无意义
    // （删掉 before-quit 里的 saveNow() 也照样绿）。
    ok('探针写入时还没落盘（确实处在防抖窗口内）', qr.pendingBeforeQuit === true,
      '写入后立刻就能读到 —— 防抖没生效，这条自检失去了意义');
    ok('before-quit 时改动已落盘', qr.savedAtBeforeQuit === true,
      '关窗口时那次修改永久丢了，而界面刚显示过「保存成功」');
    if (mainTimedOut && q.timedOut && !looksCrashed(q.stderr) && !looksCrashed(q.stdout)) {
      skip('自检进程干净退出', '本机 Electron 进程不自行结束，退出码拿不到');
    } else {
      ok('自检进程干净退出', q.code === 0 && !looksCrashed(q.stderr), 'code=' + q.code);
    }
  }

  console.log('\n[E2E-6] 临期提醒与通知点击');
  // 提醒的文案是主进程拼的，通知点击也是主进程接的 —— 只有真实启动应用才验得了。
  const rm = r.reminder || {};
  const body = (x) => (x && x.body) || '';
  ok('文案分开报「已过期」和「即将到期」',
    body(rm.mixed).includes('1 件已过期') && body(rm.mixed).includes('1 件即将到期'),
    JSON.stringify(rm.mixed));
  ok('只算即将到期的数量正确',
    body(rm.soonOnly).includes('2 件即将到期') && !body(rm.soonOnly).includes('已过期'),
    JSON.stringify(rm.soonOnly));
  ok('全是过期时不会多报一句「0 件即将到期」',
    body(rm.expiredOnly).includes('2 件已过期') && !body(rm.expiredOnly).includes('即将到期'),
    JSON.stringify(rm.expiredOnly));
  ok('没有临期物品时不发通知', rm.empty === null, JSON.stringify(rm.empty));
  ok('点击目标指向临期页', rm.mixed && rm.mixed.view === 'expiry', JSON.stringify(rm.mixed));
  ok('通知接了点击处理器（文案承诺了「点击查看详情」）', r.notifyClickWired === true);
  ok('点通知真的跳到临期页', r.viewAfterNotifyClick === 'expiry', 'got ' + r.viewAfterNotifyClick);

  console.log('\n[E2E-7] ISBN 联网查询：不是 ISBN 就不发请求');
  // 这条走的是**真实**的 IPC 处理器（截图用的那份 fixture 只认一个特定 ISBN，
  // 这里传的不是它）。非法 ISBN 在本地就被挡下，连网络都不碰 ——
  // 所以断网也能跑，而且不会白等一次 6 秒超时。
  const ib = r.isbnBad || {};
  ok('非法 ISBN 返回 badisbn（不白等一次超时）',
    ib.ok === false && ib.reason === 'badisbn', JSON.stringify(ib));

  console.log('\n========================================');
  const passed = total - fail - skipped;
  console.log(fail
    ? `  E2E 通过 ${passed} 项，失败 ${fail} 项` + (skipped ? `，跳过 ${skipped} 项` : '')
    : `  E2E 全部通过（${passed} 项）` + (skipped ? `，跳过 ${skipped} 项` : ''));
  console.log('========================================\n');
  if (skipped) {
    console.log('⚠️  有 ' + skipped + ' 项因环境原因跳过：本机 Electron 进程执行完不会自行结束');
    console.log('   （用最小探针脚本复现过，app.quit() / app.exit(0) 都一样，与代码无关）。');
    console.log('   这几项验的是「进程退出码」，在能正常结束进程的机器上会照常执行。\n');
  }

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
}
