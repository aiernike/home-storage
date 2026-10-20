'use strict';

/**
 * 手机界面验证 · 测试入口
 * ---------------------------------------------------------------------------
 * 在真实 Chromium 里以手机尺寸（390×844）加载打包好的手机端页面，
 * 检查布局、数据层、弹窗表现，并截图。
 *
 * 为什么这一步不能省：
 *   前面的 test-mobile.js 是在 Node 沙箱里跑内核，能验证逻辑，但验证不了
 *   「界面在窄屏上长什么样」。手机端最容易翻车的地方恰恰是布局——
 *   桌面侧栏硬塞进手机竖屏会挤成一团，只有真的用窄屏渲染一遍才知道行不行。
 *
 * 用法：
 *   node test/test-mobile-ui.js
 *   截图目录：HS_MUI_SHOT_DIR=xxx node test/test-mobile-ui.js
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const mainScript = path.join(__dirname, 'mobile-ui-main.js');

if (!fs.existsSync(electronBin)) {
  console.log('未找到 Electron 二进制，跳过手机界面验证');
  process.exit(0);
}

console.log('正在用手机尺寸（390×844）启动界面进行验证…\n');

const shotDir = process.env.HS_MUI_SHOT_DIR || '';

// 启动参数说明（踩过的坑）：
// 这里原本还带 --disable-software-rasterizer / --in-process-gpu / --disable-gpu-compositing，
// 结果渲染进程一碰 canvas（拍物品照片、生成演示图）就挂死，整个截图流程卡住。
// 去掉这三个之后，软件照常无头启动，canvas 也能用。
const args = [
  mainScript,
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage'
];

// 必须清掉 ELECTRON_RUN_AS_NODE，否则 electron 会退化成纯 Node，
// 拿不到 app/BrowserWindow，测试会误判成「无图形环境」而假通过。
const env = Object.assign({}, process.env, {
  HS_MUI_SHOT_DIR: shotDir
});
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBin, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });

let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => {
  stdout += d.toString();

  // 结果一出来就收工，不等子进程自己退出。
  //
  // 为什么不能等：本机 Electron 上，只要主进程起过本地 http 服务、页面又真的
  // 连过它，app.quit() 之后进程常常不会消失（单独用探针脚本复现过：quit 系列
  // 事件全都触发了，electron.exe 仍留在进程表里）。干等的代价有两层：
  //   1) 白等 120 秒超时才收场 —— 断言其实 15 秒就跑完了；
  //   2) 机器一慢，超时可能先到，那时会被当成「没有图形环境」而放过（假绿）。
  // 所以判据必须是「结果有没有出来」，不是「进程有没有退」。
  //
  // 正则里必须带换行：MUI_RESULT 后面是一整行 JSON，只匹配到 "MUI_RESULT: {"
  // 会在 JSON 还没收全时就抢跑，解析必然失败。
  if (done) return;
  if (/MUI_RESULT: \{.*\}\n/.test(stdout) || /MUI_ERROR: .*\n/.test(stdout)) {
    // 稍等一下再收，让同一批输出里排在后面的内容也到齐
    setTimeout(() => {
      try { child.kill(); } catch (e) {}
      finish();
    }, 120);
  }
});
child.stderr.on('data', (d) => (stderr += d.toString()));

// 超时是最后一道兜底：正常情况下上面「结果一到就收工」早就把测试结束了
// （实测整套跑完约 5 秒）。也就是说，能走到这里基本等于「子进程卡住了」——
// 所以它按失败算，不再按「没有图形环境」放过（那会把真实故障伪装成环境问题）。
const TIMEOUT_MS = 120000;
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.log('[超时] 子进程迟迟没有输出结果，强制结束');
  try { child.kill(); } catch (e) {}
  finish();
}, TIMEOUT_MS);

let done = false;
child.on('exit', () => {
  if (done) return;
  setTimeout(finish, 200);
});

function finish() {
  if (done) return;
  done = true;
  clearTimeout(timer);

  let fail = 0;
  let pass = 0;
  const ok = (n, c, e) => {
    if (c) { pass++; console.log('  PASS  ' + n); }
    else { fail++; console.log('  FAIL  ' + n + (e ? '  → ' + e : '')); }
  };

  const m = stdout.match(/MUI_RESULT: (\{.*\})/);
  const errM = stdout.match(/MUI_ERROR: (.*)/);

  if (errM) console.log('  运行时报错：' + errM[1]);

  if (!m) {
    const crashed =
      /TypeError|ReferenceError|SyntaxError|Cannot read propert|is not a function/.test(stderr) ||
      /MUI_ERROR:/.test(stdout);

    if (crashed) {
      console.log('❌ 界面启动失败（这是真实错误，不是环境问题）：');
      if (stdout.trim()) console.log('\nstdout：\n' + stdout.slice(-1500));
      if (stderr.trim()) console.log('\nstderr：\n' + stderr.slice(-1500));
      process.exit(1);
    }

    // 超时说明子进程卡住了 —— 这是故障，不是「没有图形环境」。
    // 真正的无桌面环境里 Electron 会直接启动失败（上面 crashed 分支），
    // 而不是「跑着但一句话都不说」。
    if (timedOut) {
      console.log('❌ 子进程卡住：' + Math.round(TIMEOUT_MS / 1000) + ' 秒内没有输出任何结果。');
      if (stdout.trim()) console.log('\nstdout：\n' + stdout.slice(-1500));
      if (stderr.trim()) console.log('\nstderr：\n' + stderr.slice(-1500));
      process.exit(1);
    }

    console.log('未能取得测试结果（可能没有图形界面环境）。');
    if (stdout.trim()) console.log('\nstdout：\n' + stdout.slice(-1200));
    if (stderr.trim()) console.log('\nstderr：\n' + stderr.slice(-1200));
    console.log('\n说明：无桌面环境下 Electron 无法创建窗口，这不代表界面本身有问题。');
    console.log('内核逻辑已由 test-mobile.js 验证。');
    process.exit(0);
  }

  const r = JSON.parse(m[1]);

  if (r.fatal) {
    console.log('❌ 探测过程出错：' + r.fatal);
    process.exit(1);
  }

  console.log('[MUI-1] 运行内核与渲染层');
  ok('运行内核已加载', r.hasKernel === true);
  ok('window.api 已装配', r.hasApi === true);
  ok('渲染层脚本齐全', r.hasApp && r.hasViews && r.hasUtil);
  ok('九个页面视图齐全',
    ['dashboard', 'items', 'docs', 'books', 'scan', 'expiry', 'locations', 'stats', 'settings']
      .every((v) => (r.views || []).includes('view-' + v)),
    'views=' + (r.views || []).join(','));
  ok('底部导航只留 5 项（重复的一级入口已收进物品页/总览）', r.navItems === 5, 'got ' + r.navItems);
  // 这条以前是假测试：模拟环境里根本没挂原生桥，它只是在核对
  // 03-bootstrap.js 里写死的 'android'。现在 mobile-ui-preload.js 会把
  // HSAndroid 挂上（跟真机 addJavascriptInterface 同一时序），页面必须
  // 据此把自己认成安卓端；「没桥时报 web」那条在 test-mobile.js 里。
  ok('识别为安卓端', r.platform === 'android', 'got ' + r.platform);
  ok('数据目录说明与环境一致（不能报成浏览器那句）',
    typeof r.userData === 'string' && r.userData !== '' && r.userData !== '浏览器本地存储',
    'got ' + r.userData);
  ok('版本号已注入', !!r.appVersion && r.appVersion !== '', 'got ' + r.appVersion);

  console.log('\n[MUI-2] 数据层在真实浏览器里可用');
  ok('位置树可读', r.treeOk === true);
  ok('位置树含 path 字段', r.treeHasPath === true);
  ok('预置位置含「厨房」', (r.topLocations || []).includes('厨房'), JSON.stringify(r.topLocations));
  ok('预置分类已扩充（>= 24 个）', r.categoryCount >= 24, 'got ' + r.categoryCount);
  ok('新增物品成功', r.saveOk === true);
  ok('条码反查命中', r.lookupOk === true);
  ok('统计可用', r.statsOk === true);
  ok('导出可用', r.exportOk === true);
  ok('数据已写入浏览器存储', r.storageKeys > 0, 'got ' + r.storageKeys);

  console.log('\n[MUI-3] 窄屏布局');
  ok('侧栏已移到屏幕底部', r.sidebarAtBottom === true,
    `侧栏顶部 y=${r.sidebarTop}，屏高 ${r.vh}`);
  ok('底部标签栏高度合理', r.sidebarHeight > 0 && r.sidebarHeight < r.vh * 0.2,
    `标签栏高 ${r.sidebarHeight}px`);
  ok('品牌区已隐藏', r.brandHidden === true);
  ok('位置树面板已隐藏', r.locPanelHidden === true);
  ok('同步状态区已隐藏', r.sideFootHidden === true);
  ok('标签横向排列', r.tabRowDir === 'row', 'got ' + r.tabRowDir);
  ok('标签高度够手指点（≥48px）', r.minTabHeight >= 48, 'got ' + r.minTabHeight + 'px');
  // 这条是关键回归项：曾经每个标签都被撑成整屏宽，屏幕上看得到第一个而已。
  // 现在 5 个标签每格约 78px，仍要确认它们全落在屏幕内、没有溢出。
  ok('5 个标签全部在屏幕内', r.tabsAllOnScreen === true,
    `标签宽度 ${(r.tabWidths || []).join('/')}，屏宽 ${r.vw}`);
  ok('标签栏没有横向溢出', r.navNoOverflow === true,
    `标签栏内容宽 ${r.navScrollWidth} > 屏宽 ${r.vw}`);
  // 标签文字一律 ≤2 字：3 字标签在窄格子里会换行，把标签栏撑高一倍
  ok('标签文字已缩短为手机版（≤2 字）', (r.tabLabels || []).every((t) => t.length <= 2),
    JSON.stringify(r.tabLabels));
  // 底栏只留互不重复的一级去处。办公资料/图书（=物品页的类型筛选）、
  // 保质期（=物品页的保质期筛选）、统计（总览页已有全部数字）都不该再占一格。
  ok('标签文字与页面一一对应',
    JSON.stringify(r.tabLabels) === JSON.stringify(['总览', '物品', '扫码', '位置', '设置']),
    JSON.stringify(r.tabLabels));
  ok('底栏里没有「办公资料/图书/保质期/统计」（它们在手机上不占一级标签）',
    ['docs', 'books', 'expiry', 'stats'].every((v) => (r.navViews || []).indexOf(v) < 0),
    'navViews=' + JSON.stringify(r.navViews));
  ok('底栏保留的 5 个 view 正确',
    JSON.stringify(r.navViews) === JSON.stringify(['dashboard', 'items', 'scan', 'locations', 'settings']),
    'navViews=' + JSON.stringify(r.navViews));
  // 摘掉标签不等于砍掉页面：总览上必须有「统计」入口，点了要真的到统计页
  ok('总览页有「统计」入口（底栏没了它，得从这儿进）', r.dashHasStats === true);
  ok('点总览的「统计」能打开统计页', r.statsReachable === true,
    'view=' + r.statsActiveTabView);
  // 关键：落到没有自己标签的页面时，底栏要回退点亮父标签，不能一个都不亮
  ok('打开统计页后底栏仍有高亮（回退到总览）',
    r.statsActiveTabCount === 1 && r.statsActiveTabView === 'dashboard',
    `亮着 ${r.statsActiveTabCount} 个，是「${r.statsActiveTabView}」`);
  ok('被摘掉标签的页面仍能直接打开（办公资料/图书/保质期）',
    r.hiddenViewsStillWork === true);
  // 实测宽度：5 个标签要真的平分，不能有某一个被压成 0 宽
  const nav = r.navFit || {};
  ok('底部标签实测 5 个', nav.count === 5, 'got ' + nav.count);
  ok('每个标签都有可见宽度', (nav.labels || []).length === 5 && (r.tabWidths || []).every((w) => w > 20),
    `宽度 ${(r.tabWidths || []).join('/')}`);
  ok('标签没有溢出标签栏边界', nav.overflowing !== true);
  ok('标签没有换行（高度未翻倍）', nav.wrapped !== true,
    `标签栏高 ${nav.barHeight}px`);
  ok('没有横向溢出', r.noHScroll === true, `内容宽 ${r.scrollWidth} > 屏宽 ${r.vw}`);
  ok('主内容区仍有足够高度', r.mainHeight > r.vh * 0.6,
    `主区高 ${r.mainHeight}px / 屏高 ${r.vh}px`);
  // 主区溢出会把底部标签栏顶出屏幕，用户就点不到导航了
  ok('主内容区没有盖住标签栏', r.mainNoOverlap === true,
    `主区底部 ${r.mainBottom}，标签栏顶部 ${r.sidebarTop}`);
  ok('标签栏完整在屏幕内', r.sidebarInsideScreen === true,
    `标签栏底部 ${r.sidebarTop + r.sidebarHeight} / 屏高 ${r.vh}`);
  ok('弹窗遮罩未误显示', r.modalVisible === false,
    r.modalVisible ? '遮罩正盖在界面上' : '');

  // 存储写满时的兜底提示条（界面组件没就绪时才会走到这条路，正常运行时看不到）。
  // 它是 fixed 钉在顶部的：长歪了就会盖住搜索框和顶部按钮 ——
  // 而那正是用户要去点「导出备份」的时候。
  const warn = r.storageWarnBar || {};
  ok('存储告警兜底提示条能出现', warn.shown === true, JSON.stringify(warn));
  ok('提示条文案说清是存储不足', /存储空间不足/.test(warn.text || ''), warn.text);
  ok('提示条横向铺满屏幕', (warn.width || 0) >= (warn.viewportWidth || 0) - 2,
    `条宽 ${warn.width} / 屏宽 ${warn.viewportWidth}`);
  // 太高会把整个顶部盖住，用户连搜索框都够不着
  ok('提示条没占掉太多屏幕（不超过屏高 15%）', (warn.height || 0) <= (r.vh || 844) * 0.15,
    `条高 ${warn.height}px / 屏高 ${r.vh}px`);
  ok('提示条带关闭按钮', warn.hasClose === true);
  ok('关闭按钮点得准（触摸目标够大）', (warn.btnW || 0) >= 32 && (warn.btnH || 0) >= 28,
    `按钮 ${warn.btnW}×${warn.btnH}`);

  // 同步冲突清单在手机上的排布：必须是「名字一行、按钮一行」。
  // 照搬桌面版的横排会把名字挤成一条竖线，用户根本看不出是哪个条目冲突了 ——
  // 而看不出是哪个，这个清单就等于没做。
  const cf = r.conflictFit || {};
  ok('手机端冲突清单能弹出来', cf.found === true, JSON.stringify(cf));
  ok('冲突条目的按钮在文字下方（纵向堆叠，没挤在右边）', cf.actsBelow === true,
    `文字底 ${cf.mainBottom} / 按钮顶 ${cf.actsTop}`);
  ok('冲突条目名称没被按钮挤扁（占满整行宽）', cf.mainFills === true,
    `文字宽 ${cf.mainW} / 行宽 ${cf.rowW}`);
  ok('冲突条目四个动作都在（打开 / 用副本覆盖 / 保留 / 删掉副本）', cf.btnCount === 4, 'got ' + cf.btnCount);
  ok('冲突条目的按钮触摸目标够大', (cf.minBtnW || 0) >= 34, `最窄按钮 ${cf.minBtnW}px`);
  // 四个按钮比三个宽，最容易顶出行外被裁掉 —— 裁掉就等于「这个动作没有」
  ok('按钮没有顶出条目右边界（顶出去会被裁掉，用户点不到）',
    (cf.maxBtnRight || 0) <= (cf.rowRight || 0) + 1,
    `最右按钮 ${cf.maxBtnRight} / 条目右边 ${cf.rowRight}`);
  ok('点「知道了」能把提示条关掉', warn.closedAfterClick === true,
    warn.hasClose ? '' : '没有关闭按钮，用户只能看着它一直挡在上面');

  // 物品行第二行（方案 C）：位置 · 字段 · 标签。
  // 这几条只能在真实浏览器里量 —— jsdom 不做布局，flex/nowrap/省略号全都测不出来。
  console.log('\n[MUI-3b] 物品行第二行（信息分层）');
  const mf = r.metaFit || {};
  ok('带条码+备注的物品行渲染出来了', mf.found === true, JSON.stringify(mf));
  ok('第二行只有一行（折成两三行的话列表就没法扫了）',
    mf.lines === 1, `${mf.metaHeight}px 高 / 单行 ${mf.locHeight}px → 约 ${mf.lines} 行`);
  ok('位置排在最前面', mf.locFirst === true);
  // 这条是「位置颜色更深一档」的**真实**验证（test-ui 里只能对 CSS 文本做正则）
  ok('位置的颜色确实比其余字段深（取的是计算后的颜色）', mf.locDimmer === true,
    `位置 ${mf.locColor} / 整行 ${mf.metaColor}`);
  ok('多个字段用「·」连成一段', mf.hasSeparator === true);
  ok('标签在屏幕上真的占到了宽度（没被挤成 0）', mf.tagW > 0, `宽 ${mf.tagW}px`);
  ok('标签有底色（没底色就看不出是个标签）',
    !!mf.tagBg && mf.tagBg !== 'rgba(0, 0, 0, 0)' && mf.tagBg !== 'transparent',
    `background=${mf.tagBg}`);
  // 手机上曾经有一条 `.item-meta span { display: inline; margin-right: 10px }`。
  // 它的优先级比 .item-meta-loc / .item-meta-fields 高，会**静默**盖掉它们的 display。
  // 这条规则「有没有被加回来」在 display 上看不出来（flex 子项会被 blockify），
  // 但 10px 外边距一定会出现在计算样式里 —— 所以量的是它。
  ok('信息行各段没有多余的 10px 外边距（那条宽泛规则没被加回来）',
    mf.locMargin === '0px' && mf.fieldsMargin === '0px',
    `位置 ${mf.locMargin} / 字段 ${mf.fieldsMargin}`);
  ok('整行没有被撑出屏幕', (mf.rowRight || 0) <= (mf.viewW || 0) + 1,
    `行右边 ${mf.rowRight} / 屏宽 ${mf.viewW}`);

  // 位置管理页的操作按钮：桌面版靠 `.tree-row:hover` 才把 opacity 从 0 提到 1。
  // 手机上没有 hover —— 原样继承的话按钮**永远看不见**，但 opacity:0 的元素**仍然能点**，
  // 于是用户看不见却会盲点误触，而里面第一个就是「删除位置」。
  ok('位置管理页有位置行', r.treeRowFound === true);
  ok('位置行带操作按钮组', r.treeActionsFound === true);
  ok('操作按钮在手机上是可见的（不能依赖 hover）', r.treeActionsVisible === true,
    `opacity=${r.treeActionsOpacity} 宽=${r.treeActionsW}px —— 手机上没有 hover，靠 hover 显示等于永远不显示`);
  ok('位置行的四个动作都在', r.treeBtnCount === 4, 'got ' + r.treeBtnCount);
  ok('位置行动作按钮够手指点（≥40px）', r.treeBtnMinSize >= 40, 'got ' + r.treeBtnMinSize + 'px');

  console.log('\n[MUI-4] 弹窗在窄屏下的表现');
  ok('新增物品弹窗能打开', r.itemModalOpen === true);
  ok('表单单列排布', r.formCols === 1, 'got ' + r.formCols + ' 列');
  ok('弹窗接近满宽', r.modalNearFullWidth === true, `宽 ${r.modalWidth} / 屏宽 ${r.vw}`);
  ok('弹窗贴底弹出', r.modalBottomAligned === true);
  ok('弹窗高度不超屏', r.modalFitsHeight === true);
  ok('输入控件高度够手指点（≥34px）', r.minInputHeight >= 34, 'got ' + r.minInputHeight + 'px');
  ok('上级位置下拉存在', r.locSelectOk === true);
  ok('下拉没有 undefined 选项', r.locNoUndefined === true,
    `${r.locOptionCount} 个选项中存在空值或 undefined`);
  ok('下拉子项有层级缩进', r.locHasIndent === true);

  console.log('\n[MUI-5] 物品图片（拍照 → 缩略图 → 看大图）');
  ok('手机端能保存图片', r.imgSaveOk === true);
  ok('手机端能取回全图', r.imgFullOk === true);
  ok('物品列表显示缩略图', r.thumbShown === true);
  ok('列表用的是缩略图而不是全图', r.thumbIsThumb === true);
  ok('缩略图挂的是图片 id（不是物品 id）', r.thumbIdIsImageId === true,
    '挂错 id 的话点开大图会是一片空白');
  ok('缩略图尺寸合适（不撑高行、也看得见）', r.thumbBoxOk === true);
  ok('点缩略图能看大图（用的是全图）', r.imgViewerOk === true);

  console.log('\n[MUI-6] 二维码（生成 + 扫码入口）');
  ok('位置页有生成二维码的按钮', r.locQrBtnOk === true);
  ok('点按钮弹出二维码', r.qrModalOk === true);
  ok('二维码真的画出来了（SVG 模块数够）', r.qrSvgOk === true);
  ok('二维码完整落在手机屏幕内', r.qrFitsOk === true);

  console.log('\n[MUI-7] 扫码页');
  ok('扫码页有手电筒按钮', r.torchBtnOk === true);
  ok('不支持手电筒时按钮隐藏（不乱显示）', r.torchHiddenWhenUnsupported === true);
  ok('手动输入条码的入口还在', r.manualInputOk === true);

  console.log('\n[MUI-9] 同步登录：点完按钮界面上必须真的有反应');
  // 涛哥报过「浏览器登录账号没反应」。适配层没把结果包成 {ok,data} 时，
  // 渲染层取 r.ok 拿到 undefined → 走失败分支、r.error 也是 undefined →
  // 连提示都弹不出来；登录失败那条直接抛异常冒到 onclick 外面，同样静默。
  // 所以这里断言的是**屏幕上出现了什么**，不是「请求发出去没有」。
  ok('密码正确时弹出「登录成功」', /登录成功/.test(r.syncOkToast || ''), r.syncOkToast || '（没有提示）');
  ok('登录成功后令牌已保存', r.syncOkToken === 'tok-mui', 'got ' + r.syncOkToken);
  ok('密码错时把服务端的话原样说出来',
    /账号或密码不正确/.test(r.syncErrToast || ''), r.syncErrToast || '（没有提示）');
  ok('密码错时设置页上也留下文字（不只是弹一下）',
    /登录失败/.test(r.syncErrMsg || '') && /账号或密码不正确/.test(r.syncErrMsg || ''),
    r.syncErrMsg || '（没有文字）');
  ok('「测试连接」给出连接结果', /连接成功/.test(r.syncTestMsg || ''), r.syncTestMsg || '（没有文字）');
  ok('「立即同步」报出同步条数', /同步完成/.test(r.syncRunToast || ''), r.syncRunToast || '（没有提示）');

  console.log('\n[MUI-8] 控制台');
  const errs = r.consoleErrors || [];
  ok('没有页面报错', errs.length === 0, errs.slice(0, 3).join(' | '));
  ok('没有未捕获异常', (r.errors || []).length === 0, (r.errors || []).slice(0, 3).join(' | '));

  if (r.shotDir) {
    console.log('\n截图已保存到：' + r.shotDir);
    const files = fs.readdirSync(r.shotDir).filter((f) => f.endsWith('.png'));
    files.forEach((f) => console.log('  · ' + f));
  }

  console.log('\n========================================');
  console.log(fail ? `  手机界面验证：通过 ${pass} 项，失败 ${fail} 项` : `  手机界面验证全部通过（${pass} 项）`);
  console.log('========================================\n');

  process.exit(fail ? 1 : 0);
}
