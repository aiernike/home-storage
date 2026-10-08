'use strict';
/**
 * 渲染层烟雾测试：用 jsdom 加载界面并模拟 Electron API，
 * 验证各页面能否正常渲染、控件是否正确绑定。
 * 无需启动 Electron 即可发现语法/引用类错误。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
let JSDOM;
try {
  JSDOM = require(path.join(ROOT, 'node_modules', 'jsdom')).JSDOM;
} catch (e) {
  console.log('未安装 jsdom，跳过渲染层测试（不影响软件使用）');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-ui-'));
const { createStore } = require(path.join(ROOT, 'src', 'main', 'store.js'));
const store = createStore(tmp);

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (e ? '  → ' + e : '')); }
};

(async () => {
  // 准备一些测试数据
  const locs = (await store.handle('locations.tree'));
  const kitchen = locs.find((n) => n.name === '厨房');
  const fridge = kitchen.children.find((n) => n.name === '冰箱');
  const cold = fridge.children.find((n) => n.name === '冷藏室');
  const cats = await store.handle('categories.list');

  const today = new Date();
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const past = new Date(today); past.setDate(past.getDate() - 3);
  const soon = new Date(today); soon.setDate(soon.getDate() + 4);

  await store.handle('items.save', { name: '海天酱油', barcodes: ['6901234567892'], category_id: cats[0].id, location_id: cold.id, quantity: 1, unit: '瓶', expiry_date: fmt(past), price: 15 });
  await store.handle('items.save', { name: '全麦面包', barcodes: ['6909876543210'], category_id: cats[0].id, location_id: cold.id, quantity: 2, unit: '袋', expiry_date: fmt(soon), price: 9.9 });
  await store.handle('items.save', { name: '5号电池', category_id: cats[4].id, location_id: kitchen.children.find(n => n.name === '橱柜').children[0].id, quantity: 8, unit: '节', price: 2 });

  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  // 注入 Electron API 模拟
  window.api = {
    call: async (action, payload) => {
      try {
        const data = await store.handle(action, payload || {});
        return { ok: true, data };
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      }
    },
    appInfo: async () => ({ version: '1.0.0', userData: tmp, platform: process.platform }),
    // 记下最后一次导出的内容，好让测试真的去检查导出的东西对不对
    exportFile: async (p) => {
      window.__lastExport = p || {};
      return { ok: true, filePath: path.join(tmp, (p && p.defaultName) || 'out.json') };
    },
    importFile: async () => ({ ok: false }),
    notify: async () => ({ ok: true }),
    openPath: async () => ({ ok: true }),
    sync: {
      test: async () => ({ ok: false, error: '测试环境未启动服务' }),
      login: async () => ({ ok: false, error: '测试环境未启动服务' }),
      register: async () => ({ ok: false, error: '测试环境未启动服务' }),
      run: async () => ({ ok: false, error: '测试环境未启动服务' })
    }
  };

  // 加载渲染层脚本（顺序必须与 index.html 一致）
  const files = ['zxing.min.js', 'qr.js', 'icons.js', 'util.js', 'components.js', 'views.js', 'app.js'];
  for (const f of files) {
    const code = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', f), 'utf8');
    try {
      window.eval(code);
    } catch (e) {
      console.log(`  FAIL  加载 ${f} 出错: ${e.message}`);
      fail++;
    }
  }

  console.log('\n[UI-1] 脚本加载与全局对象');
  ok('U 工具对象存在', !!window.U);
  ok('C 组件对象存在', !!window.C);
  ok('Views 对象存在', !!window.Views);
  ok('App 对象存在', !!window.App);
  ok('BarcodeScanner 类存在', !!window.BarcodeScanner);
  ok('QR 二维码工具存在', !!window.QR);
  ok('ZXing 识别/生成库已加载', !!window.ZXing);
  ok('物品图标库存在', !!window.ITEM_ICONS && window.ITEM_ICONS.all.length > 0);
  ok('九个页面视图齐全', ['dashboard','items','docs','books','scan','expiry','locations','stats','settings'].every(v => typeof window.Views[v] === 'function'));

  // views.js 里通过 App.xxx() 调用的方法必须真实存在。
  // 少了任何一个，页面点了按钮就会抛 TypeError，而且界面上毫无反应，很难排查。
  const viewsSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'views.js'), 'utf8');
  const appCalls = new Set([...viewsSrc.matchAll(/\bApp\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
  const missingApp = [...appCalls].filter((n) => typeof window.App[n] !== 'function');
  ok('views.js 调用的 App 方法都真实存在', missingApp.length === 0, '缺失：' + missingApp.join('、'));
  ok('确实扫描到了足够多的方法调用', appCalls.size >= 5, String(appCalls.size));

  window.App.toast('测试提示', 'ok', 30);
  ok('App.toast 能真正弹出提示', window.document.querySelectorAll('#toastRoot .toast').length > 0);

  console.log('\n[UI-2] 工具函数');
  ok('HTML 转义防注入', window.U.esc('<img src=x onerror=1>') === '&lt;img src=x onerror=1&gt;');
  ok('日期加天数正确', window.U.addDays('2026-09-01', 30) === '2026-10-01', window.U.addDays('2026-09-01', 30));
  ok('跨月加天数正确', window.U.addDays('2026-01-31', 1) === '2026-02-01', window.U.addDays('2026-01-31', 1));
  ok('跨年加天数正确', window.U.addDays('2026-12-31', 1) === '2027-01-01', window.U.addDays('2026-12-31', 1));
  ok('识别 EAN-13', window.U.barcodeType('6901234567892') === 'EAN-13');
  ok('识别 EAN-8', window.U.barcodeType('12345670') === 'EAN-8');
  const v13 = window.U.validateEan('6901234567892');
  ok('EAN-13 校验位验证可用', typeof v13.valid === 'boolean', JSON.stringify(v13));
  const bad = window.U.validateEan('6901234567890');
  ok('错误校验位能识别出来', bad.valid === false, JSON.stringify(bad));
  // 内部编码 / ISBN：扫自己发的号和扫书背条码是两条不同的处理路径，
  // 类型判断错了就会走到「条码录入」上，所以这里逐个钉死。
  ok('认得内部编码', window.U.isInternalCode('HS-2026-0001') === true);
  ok('内部编码小写也认', window.U.isInternalCode('hs-2026-0001') === true);
  ok('普通条码不会被当成内部编码', window.U.isInternalCode('6901234567892') === false);
  ok('缺段的不算内部编码', window.U.isInternalCode('HS-2026') === false);
  ok('认得 ISBN', window.U.isIsbn('9787111544937') === true && window.U.isIsbn('9791234567896') === true);
  ok('EAN-13 不会被当成 ISBN', window.U.isIsbn('6901234567892') === false);
  ok('认得期刊条码（977 开头）', window.U.isIssnCode('9771009633018') === true);
  ok('期刊条码的类型名是 ISSN', window.U.barcodeType('9771009633018') === 'ISSN', window.U.barcodeType('9771009633018'));
  ok('ISBN 与期刊条码都算图书码',
    window.U.isBookCode('9787111544937') === true && window.U.isBookCode('9771009633018') === true);
  ok('普通 EAN-13 不算图书码', window.U.isBookCode('6901234567892') === false);
  ok('内部编码的类型名是「内部编码」', window.U.barcodeType('HS-2026-0001') === '内部编码', window.U.barcodeType('HS-2026-0001'));
  ok('ISBN 的类型名是「ISBN」而不是 EAN-13', window.U.barcodeType('9787111544937') === 'ISBN', window.U.barcodeType('9787111544937'));
  ok('普通 13 位仍是 EAN-13', window.U.barcodeType('6901234567892') === 'EAN-13');
  // 内部编码没有校验位这回事，绝不能报「长度不符合标准条码规则」去吓用户
  const iv = window.U.validateEan('HS-2026-0001');
  ok('内部编码不报长度错误', iv.valid === null && /内部编码/.test(iv.reason), JSON.stringify(iv));
  const isbnOk = window.U.validateEan('9787111544937');
  ok('ISBN 校验位文案说的是 ISBN', isbnOk.valid === true && /ISBN/.test(isbnOk.reason), JSON.stringify(isbnOk));
  const isbnBad = window.U.validateEan('9787111544930');
  ok('错误的 ISBN 校验位能识别出来', isbnBad.valid === false && /ISBN/.test(isbnBad.reason), JSON.stringify(isbnBad));
  ok('剩余天数文案-已过期', window.U.daysLeftText(-3) === '已过期 3 天', window.U.daysLeftText(-3));
  ok('剩余天数文案-今天', window.U.daysLeftText(0) === '今天到期');
  ok('剩余天数文案-正常', window.U.daysLeftText(12) === '还有 12 天');

  // ---- 日期速记（Grocy 那套）----
  // 保质期/保管期限这种字段，用户脑子里是「一年后」「明年 5 月」，不是「2027-05-17」。
  // 解析函数全部注入固定的「今天」，否则断言会跟着系统日期漂。
  const parseDS = window.U.parseDateShorthand;
  const DS_TODAY = '2026-09-19';
  const dsAt = (s) => { const r = parseDS(s, DS_TODAY); return r.ok ? r.date : '✗' + r.reason; };

  ok('空输入是「没有日期」，不是错误', parseDS('', DS_TODAY).ok === true && parseDS('', DS_TODAY).date === '');
  ok('完整日期原样通过', dsAt('2026-05-17') === '2026-05-17', dsAt('2026-05-17'));
  ok('斜杠 / 点 / 中文年月日都认',
    dsAt('2026/5/17') === '2026-05-17' && dsAt('2026.5.17') === '2026-05-17' && dsAt('2026年5月17日') === '2026-05-17',
    [dsAt('2026/5/17'), dsAt('2026.5.17'), dsAt('2026年5月17日')].join(','));
  ok('8 位连写也认', dsAt('20260517') === '2026-05-17', dsAt('20260517'));
  ok('只有月日时，已经过去的算明年（写 0517 想的是「下次 5 月 17」）',
    dsAt('0517') === '2027-05-17', dsAt('0517'));
  ok('只有月日时，还没到的算今年', dsAt('1231') === '2026-12-31', dsAt('1231'));
  ok('月日也支持 5-17 / 5月17日', dsAt('5-17') === '2027-05-17' && dsAt('5月17日') === '2027-05-17',
    dsAt('5-17') + ',' + dsAt('5月17日'));
  ok('+1m 是「一个月后」', dsAt('+1m') === '2026-10-19', dsAt('+1m'));
  ok('中文「3个月」等价于 +3m', dsAt('3个月') === '2026-12-19' && dsAt('+3m') === '2026-12-19', dsAt('3个月'));
  ok('+30d 与「30天」等价', dsAt('+30d') === '2026-10-19' && dsAt('30天') === '2026-10-19', dsAt('30天'));
  ok('+2w 是 14 天后', dsAt('+2w') === '2026-10-03' && dsAt('2周') === '2026-10-03', dsAt('2周'));
  ok('+1y 与「1年」等价', dsAt('+1y') === '2027-09-19' && dsAt('1年') === '2027-09-19', dsAt('1年'));
  ok('负号是往前算（生产日期要填过去）', dsAt('-30天') === '2026-08-20' && dsAt('-1m') === '2026-08-19',
    dsAt('-30天') + ',' + dsAt('-1m'));
  ok('单位大小写不敏感', dsAt('+1M') === '2026-10-19' && dsAt('+30D') === '2026-10-19', dsAt('+1M'));
  ok('今天 / 明天 / 昨天 也能写',
    dsAt('今天') === '2026-09-19' && dsAt('明天') === '2026-09-20' && dsAt('昨天') === '2026-09-18',
    [dsAt('今天'), dsAt('明天'), dsAt('昨天')].join(','));
  ok('x 表示「没有期限」', parseDS('x', DS_TODAY).ok === true && parseDS('x', DS_TODAY).date === '', JSON.stringify(parseDS('x', DS_TODAY)));
  ok('「无」「没有」也当作清空', dsAt('无') === '' && dsAt('没有') === '', dsAt('无') + '/' + dsAt('没有'));
  ok('「x」与「空」要能区分：都是没有日期，但都不是报错',
    parseDS('x', DS_TODAY).ok === true && parseDS('', DS_TODAY).ok === true, '');
  ok('不存在的日期要报错，不能静默滚到下个月',
    parseDS('2026-02-30', DS_TODAY).ok === false && parseDS('2026-13-01', DS_TODAY).ok === false,
    JSON.stringify(parseDS('2026-02-30', DS_TODAY)));
  ok('看不懂的输入报错（而不是当成空值悄悄吞掉）',
    parseDS('abc', DS_TODAY).ok === false && /看不懂/.test(parseDS('abc', DS_TODAY).reason), JSON.stringify(parseDS('abc', DS_TODAY)));
  ok('报错信息带上具体是哪一天不存在', /2 月 30 日/.test(parseDS('2026-02-30', DS_TODAY).reason),
    parseDS('2026-02-30', DS_TODAY).reason);
  ok('解析结果基于传入的「今天」，不是系统日期',
    dsAt('明天') === '2026-09-20' && parseDS('明天', '2030-01-01').date === '2030-01-02',
    parseDS('明天', '2030-01-01').date);

  // addMonths 的月末夹取：1 月 31 日 + 1 个月不能变成 3 月 3 日
  ok('加一个月时月末会夹到目标月最后一天', window.U.addMonths('2026-01-31', 1) === '2026-02-28',
    window.U.addMonths('2026-01-31', 1));
  ok('闰年的 2 月夹到 29 日', window.U.addMonths('2024-01-31', 1) === '2024-02-29',
    window.U.addMonths('2024-01-31', 1));
  ok('减一个月同样夹月末', window.U.addMonths('2026-03-31', -1) === '2026-02-28',
    window.U.addMonths('2026-03-31', -1));
  ok('普通日期加月不受影响', window.U.addMonths('2026-09-19', 12) === '2027-09-19',
    window.U.addMonths('2026-09-19', 12));

  /* ---- 扫码枪前缀识别 ----
     扫码枪在系统里就是个键盘，判据只能是「相邻按键的时间间隔」。所以 feed 把时间
     当参数收进来，测试里想传多少传多少 —— 不用等真实时间，也不用打桩 setTimeout。 */
  const mkScanner = (prefix, gapMs) =>
    window.U.createScannerWatcher({ prefix: prefix === undefined ? '$' : prefix, gapMs: gapMs });
  // 把一串按键按固定间隔喂进去，返回每次的结果
  const feedKeys = (w, keys, step, t0) => {
    let t = t0 || 1000;
    return keys.map((k) => {
      const r = w.feed(k, t);
      t += step;
      return r;
    });
  };
  // 「$690123456789」+ 回车 这种整体写法 → 最后一次的结果
  const scanText = (text, o) => {
    o = o || {};
    const w = mkScanner(o.prefix, o.gapMs);
    const rs = feedKeys(w, String(text).split('').concat(o.suffix || 'Enter'),
      o.step === undefined ? 5 : o.step, o.t0);
    return rs[rs.length - 1];
  };

  ok('扫码枪：前缀 + 条码 + 回车 = 认出一整条',
    scanText('$690123456789').hit === true && scanText('$690123456789').code === '690123456789',
    JSON.stringify(scanText('$690123456789')));
  ok('扫码枪：内部编码也能扫', scanText('$HS-2026-0001').code === 'HS-2026-0001',
    JSON.stringify(scanText('$HS-2026-0001')));
  ok('扫码枪：本应用二维码的内容（含冒号）照样认',
    scanText('$HOMESTORAGE:ITEM:abc-123').code === 'HOMESTORAGE:ITEM:abc-123',
    JSON.stringify(scanText('$HOMESTORAGE:ITEM:abc-123')));
  ok('扫码枪：Tab 后缀也认', scanText('$690123456789', { suffix: 'Tab' }).hit === true,
    JSON.stringify(scanText('$690123456789', { suffix: 'Tab' })));
  ok('扫码枪：没配前缀就彻底关闭', (() => {
    const w = mkScanner('');
    const rs = feedKeys(w, '$690123456789'.split('').concat('Enter'), 5);
    return rs.every((r) => r.hit === false && r.armed === false);
  })(), '');
  ok('扫码枪：前缀可以换成别的字符', scanText('~690123456789', { prefix: '~' }).hit === true,
    JSON.stringify(scanText('~690123456789', { prefix: '~' })));
  ok('扫码枪：两字符前缀也能配', scanText('$$690123456789', { prefix: '$$' }).code === '690123456789',
    JSON.stringify(scanText('$$690123456789', { prefix: '$$' })));

  ok('扫码枪：没有前缀的条码不认（不能抢输入框的活）',
    scanText('690123456789').hit === false, JSON.stringify(scanText('690123456789')));
  ok('扫码枪：前缀后面空空如也就按回车 → 不认',
    scanText('$').hit === false, JSON.stringify(scanText('$')));
  ok('扫码枪：太短的内容不认（$ab 是手滑不是条码）',
    scanText('$ab').hit === false && scanText('$abc').hit === false, '');
  ok('扫码枪：内容里有中文不认', scanText('$你好世界').hit === false, JSON.stringify(scanText('$你好世界')));
  ok('扫码枪：内容里有空格不认', scanText('$6901 2345').hit === false, JSON.stringify(scanText('$6901 2345')));
  // 超长和「前缀对不上」这两个分支，光看 hit 是看不出来的 —— 它们就算不生效，
  // 后面还有 gotPrefix / isScannerCode 兜底，结果一样是不命中。真正会变的是
  // 「有没有及早放弃收集」：不放弃的话按键会一直被拦着（用户打不了字）。
  ok('扫码枪：超长内容不认，并且放弃之后不再拦按键', (() => {
    const w = mkScanner('$');
    const rs = feedKeys(w, ('$' + '9'.repeat(200)).split(''), 5);
    const last = rs[rs.length - 1];
    return last.hit === false && last.armed === false;
  })(), JSON.stringify(scanText('$' + '9'.repeat(200))));
  ok('扫码枪：多字符前缀对不上就作废，并且不再拦按键', (() => {
    const w = mkScanner('$$');
    const rs = feedKeys(w, '$a6901'.split(''), 5);
    const last = rs[rs.length - 1];
    return last.hit === false && last.armed === false;
  })(), JSON.stringify(scanText('$a690123456789', { prefix: '$$' })));

  // 「人手打字 vs 扫码枪」就是靠这个间隔判的 —— 这是整套机制的核心，
  // 所以阈值两侧都要钉住，不能只测「快的时候能认出来」。
  ok('扫码枪：按键间隔极短 → 认定是扫码枪', scanText('$690123456789', { step: 2 }).hit === true, '');
  ok('扫码枪：间隔 70ms（仍快于阈值 80）→ 认',
    scanText('$690123456789', { step: 70 }).hit === true, '');
  ok('扫码枪：间隔 200ms（人手打字）→ 不认',
    scanText('$690123456789', { step: 200 }).hit === false,
    JSON.stringify(scanText('$690123456789', { step: 200 })));
  ok('扫码枪：间隔可以自己调',
    scanText('$690123456789', { step: 200, gapMs: 500 }).hit === true, '');

  // armed 决定调用方要不要 preventDefault —— 拦错了用户就打不出那个字符，
  // 拦漏了条码就漏进输入框，所以每个分支都要钉。
  ok('扫码枪：按下前缀那一刻就该拦（armed=true）',
    feedKeys(mkScanner('$'), ['$'], 5)[0].armed === true, '');
  ok('扫码枪：收集条码内容时一直拦着', (() => {
    const w = mkScanner('$');
    const rs = feedKeys(w, '$6901'.split(''), 5);
    return rs.every((r) => r.armed === true);
  })(), '');
  ok('扫码枪：普通字母不该被拦（否则输入框打不了字）',
    feedKeys(mkScanner('$'), ['a'], 5)[0].armed === false, '');
  ok('扫码枪：不命中时的回车要放行（用户可能只是想提交表单）',
    scanText('$ab').armed === false, JSON.stringify(scanText('$ab')));
  ok('扫码枪：Shift 这类修饰键不打断收集', (() => {
    const w = mkScanner('$');
    const rs = feedKeys(w, ['$', 'Shift', '6', '9', '0', '1', 'Enter'], 5);
    return rs[rs.length - 1].hit === true && rs[rs.length - 1].code === '6901';
  })(), '');
  ok('扫码枪：连扫两条都能认（命中后状态要清干净）', (() => {
    const w = mkScanner('$');
    const a = feedKeys(w, '$690123456789'.split('').concat('Enter'), 5);
    // 中间隔了很久（比如用户去点了别的地方），下一串仍然是独立的一次扫码
    const b = feedKeys(w, '$9787111544937'.split('').concat('Enter'), 5, 999999);
    return a[a.length - 1].code === '690123456789' && b[b.length - 1].code === '9787111544937';
  })(), '');
  ok('扫码枪：reset() 之后残留不会拼到下一串里', (() => {
    const w = mkScanner('$');
    feedKeys(w, '$6901'.split(''), 5);
    w.reset();
    const rs = feedKeys(w, ['1', '2', '3', '4', 'Enter'], 5, 999999);
    return rs[rs.length - 1].hit === false;
  })(), '');
  ok('扫码枪：喂进奇怪的键不会崩', (() => {
    const w = mkScanner('$');
    w.feed('', 1000);
    w.feed(null, 1001);
    w.feed(undefined, 1002);
    w.feed('$', 1003);
    return true;
  })(), '');

  ok('条码内容校验：长度不足 4 不算', window.U.isScannerCode('abc') === false && window.U.isScannerCode('abcd') === true, '');
  ok('条码内容校验：中文不算', window.U.isScannerCode('你好世界') === false, '');
  ok('条码内容校验：带空格的（人手误触）不算', window.U.isScannerCode('6901 2345') === false, '');
  ok('条码内容校验：内部编码算', window.U.isScannerCode('HS-2026-0001') === true, '');
  ok('条码内容校验：ISBN 算', window.U.isScannerCode('9787111544937') === true, '');
  ok('条码内容校验：超长不算', window.U.isScannerCode('9'.repeat(129)) === false, '');
  ok('条码内容校验：前后空白不影响', window.U.isScannerCode('  690123456789  ') === true, '');

  console.log('\n[UI-3] 页面渲染');
  await window.App.init();
  const $ = (s) => window.document.querySelector(s);
  const viewText = (id) => (window.document.getElementById(id) || {}).textContent || '';

  ok('总览页渲染成功', viewText('view-dashboard').includes('总览'));
  ok('总览显示物品总数 3', viewText('view-dashboard').includes('3'));
  ok('侧栏位置树已渲染', window.document.querySelectorAll('#locTree .loc-node').length > 0);
  ok('侧栏预置位置节点数 >= 5', window.document.querySelectorAll('#locTree .loc-node').length >= 5, String(window.document.querySelectorAll('#locTree .loc-node').length));

  await window.App.goto('items');
  ok('物品页渲染成功', viewText('view-items').includes('物品清单'));
  ok('物品行渲染 3 条', window.document.querySelectorAll('#view-items .item-row').length === 3, String(window.document.querySelectorAll('#view-items .item-row').length));
  ok('物品行显示位置路径', viewText('view-items').includes('厨房 / 冰箱 / 冷藏室'));
  ok('过期物品带过期标签', viewText('view-items').includes('已过期'));
  ok('临期物品带临期标签', viewText('view-items').includes('还有 4 天'));
  // 分类扩充到 27 个以后，chips 不能全铺出来（窄屏会把列表顶出屏幕），
  // 所以「物品清单」只显示普通物品类的前 9 个，其余收进「更多分类」。
  const catChipEls = [...window.document.querySelectorAll('#catChips .chip')];
  const goodsCats = cats.filter((c) => window.U.catKindOf(c.key) === 'goods');
  const expectChips = 1 + Math.min(goodsCats.length, 9) + (goodsCats.length > 9 ? 1 : 0);
  ok('分类筛选按钮已渲染（按栏目过滤 + 超 9 个收起）', catChipEls.length === expectChips,
    `${catChipEls.length} vs ${expectChips}（普通物品类 ${goodsCats.length} 个）`);
  ok('分类筛选含「全部分类」入口', catChipEls.some((c) => c.textContent.trim() === '全部分类'));
  ok('分类超出上限时出现「更多分类」',
    goodsCats.length <= 9 || catChipEls.some((c) => /更多分类/.test(c.textContent)),
    catChipEls.map((c) => c.textContent).join('|'));
  ok('类型筛选按钮已渲染（全部/普通/资料/图书）',
    window.document.querySelectorAll('#kindChips .chip').length === 4,
    String(window.document.querySelectorAll('#kindChips .chip').length));
  ok('保质期筛选按钮已渲染', window.document.querySelectorAll('#expChips .chip').length === 5);

  await window.App.goto('expiry');
  ok('保质期页渲染成功', viewText('view-expiry').includes('保质期管理'));
  ok('保质期页显示已过期分区', viewText('view-expiry').includes('已过期'));
  ok('保质期页显示即将到期分区', viewText('view-expiry').includes('即将到期'));
  ok('阈值提示正确', viewText('view-expiry').includes('7 天'));

  await window.App.goto('locations');
  ok('位置管理页渲染成功', viewText('view-locations').includes('位置管理'));
  ok('位置表格行数 >= 10', window.document.querySelectorAll('#treeEditor .tree-row').length >= 10, String(window.document.querySelectorAll('#treeEditor .tree-row').length));
  ok('位置行显示物品数', viewText('view-locations').includes('件物品'));

  await window.App.goto('scan');
  ok('扫码页渲染成功', viewText('view-scan').includes('扫码录入'));
  ok('扫码页有摄像头区域', !!$('#scanVideo'));
  ok('扫码页有手动输入框', !!$('#manualCode'));
  ok('扫码页有四种方式', viewText('view-scan').includes('摄像头扫码') && viewText('view-scan').includes('手动录入'));

  await window.App.goto('stats');
  ok('统计页渲染成功', viewText('view-stats').includes('统计'));
  // 卡片统计的是三类记录的合集，不能笼统写成「物品种类」——
  // 那会让人以为家里有 300 件东西，其实里面混着合同和书。
  ok('统计页叫「记录总数」而不是「物品种类」', viewText('view-stats').includes('记录总数'));
  const statsText = viewText('view-stats');
  ok('统计页按三类拆开显示',
    /物品 \d+/.test(statsText) && /资料 \d+/.test(statsText) && /图书 \d+/.test(statsText),
    statsText.match(/物品 \d+ · 资料 \d+ · 图书 \d+/) || '没找到拆分文案');
  ok('统计页显示总价值', viewText('view-stats').includes('估算总价值'));
  ok('统计页有分类分布', window.document.querySelectorAll('#view-stats .bar-row').length > 0);
  ok('统计页有趋势图', window.document.querySelectorAll('#view-stats .trend-col').length === 6, String(window.document.querySelectorAll('#view-stats .trend-col').length));

  // 桌面端 9 个标签齐全：goto 到哪页就点亮哪页自己的标签，不走父标签回退。
  // （手机端会摘掉 4 个标签并回退点亮父标签，那条路在 test-mobile-ui 的 5c 段
  //   用真实浏览器验 —— 这里 jsdom 里模拟摘除会把 App.init 绑的 onclick 一起弄丢。）
  const navTab = (v) => window.document.querySelector('.nav-item[data-view="' + v + '"]');
  ok('桌面端导航仍是 9 项（只有手机端才砍到 5）',
    window.document.querySelectorAll('.nav-item').length === 9,
    String(window.document.querySelectorAll('.nav-item').length));
  ok('桌面端进统计页高亮「统计」标签本身（不回退到总览）',
    !!navTab('stats') && navTab('stats').classList.contains('active'));

  await window.App.goto('settings');
  ok('设置页渲染成功', viewText('view-settings').includes('设置'));
  ok('设置页有同步地址输入', !!$('#setSyncUrl'));
  ok('设置页有账号密码输入', !!$('#setSyncUser') && !!$('#setSyncPass'));
  ok('设置页有导出按钮', !!$('#btnExportJson'));
  ok('设置页有导入按钮', !!$('#btnImport'));
  ok('设置页写清了注册顺序', viewText('view-settings').includes('注册新账号'));

  // ---- 表单里的速记输入框 ----
  // 纯函数对不代表界面接上了：这里走真实的 C.form，验「输入 → 提交」整条路。
  console.log('\n[UI-3b] 日期速记输入框');
  const dsTick = (ms) => new Promise((r) => setTimeout(r, ms || 20));
  const dsBox = () => window.document.getElementById('modalBox');
  const dsOpen = () => !window.document.getElementById('modalRoot').hidden;

  let dsVals = null;
  let dsSubmitCount = 0;
  let dsP = window.C.form({
    title: '测试',
    fields: [
      { key: 'expiry_date', label: '到期日期', type: 'dateshort', value: '' },
      { key: 'name', label: '名称', value: 'x' }
    ],
    onSubmit: async (vals) => { dsSubmitCount++; dsVals = vals; }
  });
  await dsTick();
  const dsEl = dsBox().querySelector('input[data-k="expiry_date"]');
  ok('速记字段渲染出来了', !!dsEl);
  ok('速记字段是文本输入框（原生日期框根本敲不进 +1m）', !!dsEl && dsEl.type === 'text',
    dsEl && dsEl.type);
  ok('占位文字里给了例子，用户不用猜', !!dsEl && /\+1m|0517/.test(dsEl.placeholder),
    dsEl && dsEl.placeholder);

  // 离开输入框时归一化，让用户当场看见「我写的变成了哪天」
  dsEl.value = '+30d';
  dsEl.dispatchEvent(new window.Event('blur'));
  await dsTick(10);
  const dsHint = dsBox().querySelector('[data-ds-hint="expiry_date"]');
  ok('blur 后把速记解析成了真实日期',
    dsEl.value === window.U.addDays(window.U.today(), 30),
    dsEl.value + ' vs ' + window.U.addDays(window.U.today(), 30));
  ok('并且当场告诉用户它理解成了哪天', !!dsHint && /已理解为/.test(dsHint.textContent),
    dsHint && dsHint.textContent);

  // 关键路径：用户填完直接点保存（没有离开输入框），速记也必须在提交时被解析
  dsEl.value = '+1y';
  dsBox().querySelector('[data-act="ok"]').click();
  await dsP;
  ok('没离开输入框就直接保存，速记照样被解析成日期',
    !!dsVals && dsVals.expiry_date === window.U.addMonths(window.U.today(), 12),
    dsVals && dsVals.expiry_date);
  ok('同一张表单里的普通字段没被牵连', !!dsVals && dsVals.name === 'x', dsVals && dsVals.name);

  // 看不懂的输入必须拦住：静默存成空值 = 用户以为填了保质期，其实没有
  dsVals = null;
  dsSubmitCount = 0;
  dsP = window.C.form({
    title: '测试',
    fields: [{ key: 'expiry_date', label: '到期日期', type: 'dateshort', value: '' }],
    onSubmit: async (vals) => { dsSubmitCount++; dsVals = vals; }
  });
  await dsTick();
  const dsEl2 = dsBox().querySelector('input[data-k="expiry_date"]');
  dsEl2.value = '下个月吧';
  dsBox().querySelector('[data-act="ok"]').click();
  await dsTick(30);
  ok('看不懂的日期不会提交（不能静默变成空值）', dsSubmitCount === 0, String(dsSubmitCount));
  ok('并且把原因写在表单里', /看不懂/.test(dsBox().querySelector('#formErr').textContent),
    dsBox().querySelector('#formErr').textContent);
  ok('弹窗还开着，用户能改（不能让他以为存上了）', dsOpen(), String(dsOpen()));
  ok('错误提示里给了能用的写法', /\+1m|2026-05-17/.test(dsBox().querySelector('[data-ds-hint="expiry_date"]').textContent),
    dsBox().querySelector('[data-ds-hint="expiry_date"]').textContent);

  // 改对了就能提交
  dsEl2.value = '0517';
  dsBox().querySelector('[data-act="ok"]').click();
  await dsP;
  ok('改成能认的写法后可以正常提交', dsSubmitCount === 1 && /-05-17$/.test(dsVals.expiry_date),
    dsVals && dsVals.expiry_date);

  // 留空不算错：到期日期本来就可以不填
  dsVals = null;
  dsSubmitCount = 0;
  dsP = window.C.form({
    title: '测试',
    fields: [{ key: 'expiry_date', label: '到期日期', type: 'dateshort', value: '' }],
    onSubmit: async (vals) => { dsSubmitCount++; dsVals = vals; }
  });
  await dsTick();
  dsBox().querySelector('[data-act="ok"]').click();
  await dsP;
  ok('留空能正常提交，值就是空（不设期限）',
    dsSubmitCount === 1 && dsVals.expiry_date === '', JSON.stringify(dsVals));

  // 真实表单必须真的用上这个字段类型 —— 否则做了个没人用的控件
  window.App.openItemEditor(null, { kind: 'goods' });
  await dsTick(60);
  const goodsPd = dsBox().querySelector('input[data-k="production_date"]');
  const goodsEd = dsBox().querySelector('input[data-k="expiry_date"]');
  ok('物品编辑器的「生产日期」用上了速记输入', !!goodsPd && goodsPd.type === 'text',
    goodsPd && goodsPd.type);
  ok('物品编辑器的「到期日期」用上了速记输入', !!goodsEd && goodsEd.type === 'text',
    goodsEd && goodsEd.type);
  // 保质期联动：生产日期敲速记、还没离开输入框时也要算得出来
  if (goodsPd && goodsEd) {
    const daysEl = dsBox().querySelector('input[data-k="shelf_life_days"]');
    goodsPd.value = '+0d';
    daysEl.value = '10';
    daysEl.dispatchEvent(new window.Event('input'));
    await dsTick(10);
    ok('生产日期还是速记状态时，保质期联动也能算出到期日',
      goodsEd.value === window.U.addDays(window.U.today(), 10),
      goodsEd.value + ' vs ' + window.U.addDays(window.U.today(), 10));
  }
  dsBox().querySelector('[data-act="cancel"]').click();
  await dsTick(30);

  window.App.openItemEditor(null, { kind: 'doc' });
  await dsTick(60);
  const docKeep = dsBox().querySelector('input[data-k="x_keep_until"]');
  ok('资料编辑器的「保管期限至」用上了速记输入', !!docKeep && docKeep.type === 'text',
    docKeep && docKeep.type);
  dsBox().querySelector('[data-act="cancel"]').click();
  await dsTick(30);

  /* ---- 扫码枪前缀 ----
     扫码枪就是个键盘，条码会直接灌进当前焦点所在的输入框。配了前缀之后，
     只有「前缀 + 极快连续输入 + 回车」这一整串才被当成扫码，其余一概不碰。
     纯函数测过之后，这里验「真的挂在键盘事件上、真的拦住了字符」。 */
  console.log('\n[UI-3c] 扫码枪前缀（全局键盘识别）');

  await window.App.goto('settings');
  await dsTick(30);
  const spEl = window.document.getElementById('setScanPrefix');
  ok('设置页有扫码枪前缀输入框', !!spEl);
  ok('扫码枪默认是关的（绝大多数家庭没有扫码枪，不该默认占掉一个字符）',
    !spEl.value, '「' + spEl.value + '」');

  spEl.value = '$';
  // 真实环境里 IPC 会把设置序列化一份再交给渲染层，App.state.settings 和 store 里
  // 那个对象**不是同一个**。测试的 window.api.call 是直接返回引用的，不在这里手动
  // 断开的话，「保存后要把新前缀写回本地状态」这件事会被「它俩本来就是同一个对象」
  // 蒙过去 —— 那句赋值删掉都测不出来。
  window.App.state.settings = Object.assign({}, window.App.state.settings);
  window.document.getElementById('btnSaveScanPrefix').click();
  await dsTick(60);
  ok('保存后本地状态跟着变（keydown 那边靠它决定要不要拦）',
    window.App.state.settings.scannerPrefix === '$',
    String(window.App.state.settings.scannerPrefix));
  const savedPrefix = (await store.handle('app.settings.get')).scannerPrefix;
  ok('前缀真的落进了设置（重启后还在）', savedPrefix === '$', String(savedPrefix));

  // 不合法的前缀必须挡住：收下了只会变成一个永远匹配不上的死前缀
  spEl.value = '中';
  window.document.getElementById('btnSaveScanPrefix').click();
  await dsTick(40);
  ok('中文前缀会被拒绝（扫码枪根本配不出这种前缀）',
    window.App.state.settings.scannerPrefix === '$',
    String(window.App.state.settings.scannerPrefix));

  // ---- 事件层 ----
  const key = (k, target) => {
    const e = new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    (target || window.document).dispatchEvent(e);
    return e;
  };
  // 先敲一个普通键热身：jsdom 第一次派发键盘事件有额外的编译开销，
  // 不热身的话第一串扫码的「按键间隔」会被算得偏大，误判成人手打字。
  key('a');
  const type = (s, target) => {
    let last = null;
    for (const c of s) last = key(c, target);
    return last;
  };

  const realHandle = window.Views._handleCode;
  const handled = [];
  window.Views._handleCode = async (el, state, code, format, from) => {
    handled.push({ code, from });
  };

  handled.length = 0;
  type('$6901234567892');
  const eEnter = key('Enter');
  await dsTick(20);
  ok('扫码枪扫一下就被识别（不必先切到扫码页）',
    handled.length === 1 && handled[0].code === '6901234567892', JSON.stringify(handled));
  ok('来源标成「扫码枪」，好跟摄像头、手动输入区分开',
    handled[0] && handled[0].from === '扫码枪', JSON.stringify(handled[0]));
  ok('结尾的回车被拦下（否则会顺带提交你正在填的表单）',
    eEnter.defaultPrevented === true);

  handled.length = 0;
  const eDollar = key('$');
  ok('按下前缀那一刻就拦住（不拦的话 $ 会漏进输入框）',
    eDollar.defaultPrevented === true);

  handled.length = 0;
  type('$ab'); // 太短，不像条码
  const eShort = key('Enter');
  await dsTick(20);
  ok('前缀后面不像条码 → 不认，回车也放行',
    handled.length === 0 && eShort.defaultPrevented === false,
    JSON.stringify(handled) + ' / ' + eShort.defaultPrevented);

  handled.length = 0;
  type('$6901234567892');
  // 真实时间等 150ms 再回车：模拟「手打了个 $ 又过半天才敲回车」，
  // 这是两个独立动作，不能拼成一次扫码
  await dsTick(150);
  const eLate = key('Enter');
  await dsTick(20);
  ok('前缀和回车之间隔太久 → 不认（这就是「人手打字 vs 扫码枪」的判据）',
    handled.length === 0 && eLate.defaultPrevented === false,
    JSON.stringify(handled) + ' / ' + eLate.defaultPrevented);

  const ePlain = key('a');
  ok('普通按键完全不碰（输入框该能正常打字）', ePlain.defaultPrevented === false);

  // 命中之后回车不能再往下传：扫码页的手动输入框也有个回车处理，
  // 不拦住的话它会拿着（已被拦下、其实是空的）输入框再查一次。
  const probe = window.document.createElement('input');
  window.document.body.appendChild(probe);
  let probeEnter = 0;
  probe.addEventListener('keydown', (e) => { if (e.key === 'Enter') probeEnter++; });
  handled.length = 0;
  type('$6901234567892', probe);
  key('Enter', probe);
  await dsTick(20);
  ok('命中时的回车不再往下传（否则输入框会拿着空值再查一遍）',
    probeEnter === 0, String(probeEnter));
  probe.remove();

  // init 里的全局监听器只能挂一次。真实运行里 init 由 DOMContentLoaded 触发一次，
  // 但测试会手动再 await 一次 —— 挂两遍的话一次扫码会被处理两次（扫一条出两条）。
  // 这条断言就是为那个 bug 加的：不挡的话它只在测试里现形，线上看不见。
  await window.App.init();
  await window.App.init();
  handled.length = 0;
  type('$6901234567892');
  key('Enter');
  await dsTick(20);
  ok('重复调用 init 不会重复挂键盘监听（否则扫一下出两条记录）',
    handled.length === 1, String(handled.length));

  // ---- 接回真实处理流程：扫一条库里没有的条码，应该直接弹新建窗口 ----
  window.Views._handleCode = realHandle;
  handled.length = 0;
  type('$4001234567890');
  key('Enter');
  await dsTick(150);
  const codeEl = dsBox() && dsBox().querySelector('input[data-k="barcodes"]');
  ok('扫到库里没有的条码 → 直接打开新建窗口并预填条码',
    !!codeEl && String(codeEl.value).includes('4001234567890'),
    codeEl ? codeEl.value : '没找到条码输入框');
  ok('扫码枪的这次扫码也进了扫码日志（回头打开扫码页能看到）',
    (window.App.state.scanLog || []).some((r) => r.from === '扫码枪' && r.code === '4001234567890'),
    JSON.stringify((window.App.state.scanLog || [])[0] || null));
  const spCancel = dsBox() && dsBox().querySelector('[data-act="cancel"]');
  if (spCancel) spCancel.click();
  await dsTick(40);

  // 改前缀要立刻生效，不能等重启 —— 用户换了一把扫码枪就得能马上用
  window.Views._handleCode = async (el, state, code, format, from) => { handled.push({ code, from }); };
  await window.App.goto('settings');
  await dsTick(30);
  window.document.getElementById('setScanPrefix').value = '~';
  window.document.getElementById('btnSaveScanPrefix').click();
  await dsTick(60);
  handled.length = 0;
  type('$6901234567892');
  key('Enter');
  await dsTick(20);
  ok('换了前缀之后，旧前缀不再被识别', handled.length === 0, JSON.stringify(handled));
  handled.length = 0;
  type('~6901234567892');
  key('Enter');
  await dsTick(20);
  ok('新前缀立刻生效（不用重启软件）',
    handled.length === 1 && handled[0].code === '6901234567892', JSON.stringify(handled));
  window.Views._handleCode = realHandle;

  // 关掉前缀后，键盘就还给用户了 —— 这个「关得掉」很重要，
  // 否则那个字符在输入框里就永远打不出来，用户还没法自救。
  await window.App.goto('settings');
  await dsTick(30);
  const spEl2 = window.document.getElementById('setScanPrefix');
  spEl2.value = '';
  window.document.getElementById('btnSaveScanPrefix').click();
  await dsTick(60);
  ok('清空前缀就关掉了（那个字符能正常打出来了）',
    window.App.state.settings.scannerPrefix === '' &&
    (await store.handle('app.settings.get')).scannerPrefix === '',
    String(window.App.state.settings.scannerPrefix));

  handled.length = 0;
  window.Views._handleCode = async (el, state, code, format, from) => { handled.push({ code, from }); };
  type('$6901234567892');
  key('Enter');
  await dsTick(20);
  ok('关掉之后扫码枪的整串输入不再被当成扫码',
    handled.length === 0, JSON.stringify(handled));
  window.Views._handleCode = realHandle;

  console.log('\n[UI-4] 同步注册/登录真的把账号密码发了出去');
  // 背景：设置里存的字段叫 syncUrl / syncUser，而同步接口的参数叫 url / username。
  // 名字不同，渲染层如果直接把表单对象往下传，服务端就会收到空账号，
  // 表现是「明明都填了，却提示请先填写同步地址」。
  // 这里用真的同步客户端 + 一个会记录请求的本地服务，验证整条链路。
  const httpMod = require('http');
  const seen = [];
  let syncReply = null; // 由下面的用例控制 /api/sync 的返回内容
  const srv = httpMod.createServer((rq, rs) => {
    const chunks = [];
    rq.on('data', (c) => chunks.push(c));
    rq.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch (e) { body = {}; }
      seen.push({ path: rq.url, method: rq.method, body });
      rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (rq.url === '/api/sync' && syncReply) return rs.end(JSON.stringify(syncReply));
      rs.end(JSON.stringify({ ok: true, token: 'tok-test-abc', username: body.username || '' }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const srvPort = srv.address().port;

  const { createSync } = require(path.join(ROOT, 'src', 'main', 'sync.js'));
  const realSync = createSync(store);
  const wrapSync = (fn) => async (o) => {
    try { return { ok: true, data: await fn(o) }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  };
  window.api.sync = {
    test: wrapSync((o) => realSync.test(o.url)),
    login: wrapSync((o) => realSync.login(o.url, o.username, o.password, o.deviceName)),
    register: wrapSync((o) => realSync.register(o.url, o.username, o.password)),
    run: async () => ({ ok: true, data: {} })
  };

  const waitReq = async (ms = 1500) => {
    for (let i = 0; i < ms / 20; i++) {
      if (seen.length) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  };

  $('#setSyncUrl').value = `http://127.0.0.1:${srvPort}`;
  $('#setSyncUser').value = 'zhangsan';
  $('#setSyncPass').value = 'secret123';
  $('#setDeviceName').value = '测试电脑';

  seen.length = 0;
  $('#btnRegister').click();
  ok('点「注册新账号」真的发出了请求', await waitReq(), '一个请求都没发出去');
  ok('请求打到了 /api/register', seen[0] && seen[0].path === '/api/register', seen[0] && seen[0].path);
  ok('服务端收到了账号', seen[0] && seen[0].body.username === 'zhangsan', JSON.stringify(seen[0] && seen[0].body));
  ok('服务端收到了密码', seen[0] && seen[0].body.password === 'secret123', JSON.stringify(seen[0] && seen[0].body));
  ok('注册成功后界面有提示', ($('#syncMsg') || {}).textContent === '注册成功，现在可以登录了',
    ($('#syncMsg') || {}).textContent);

  seen.length = 0;
  $('#btnLoginSync').click();
  ok('点「登录并保存」真的发出了请求', await waitReq(), '一个请求都没发出去');
  ok('请求打到了 /api/login', seen[0] && seen[0].path === '/api/login', seen[0] && seen[0].path);
  ok('登录也带上了账号', seen[0] && seen[0].body.username === 'zhangsan', JSON.stringify(seen[0] && seen[0].body));
  ok('登录带上了设备名', seen[0] && seen[0].body.device === '测试电脑', JSON.stringify(seen[0] && seen[0].body));

  // 一次拉不完时，同步进度不能推到 serverTime
  // —— 否则中间那些没拉到的记录永远拉不到，而用户看到的只有一句「同步完成」。
  const rawDb = store.raw;
  rawDb.settings.syncUrl = `http://127.0.0.1:${srvPort}`;
  rawDb.settings.syncToken = 'tok-test-abc';
  rawDb.settings.lastSyncAt = '1970-01-01T00:00:00.000Z';

  syncReply = {
    ok: true, serverTime: '2026-01-01T00:00:00.000Z', pushed: 0,
    pull: { locations: [], items: [], categories: [], images: [] },
    truncated: true, pullTo: '2025-06-01T00:00:00.000Z'
  };
  const truncRes = await realSync.sync();
  ok('被截断时同步进度停在 pullTo，而不是推到 serverTime',
    rawDb.settings.lastSyncAt === '2025-06-01T00:00:00.000Z', rawDb.settings.lastSyncAt);
  ok('被截断时返回值带 hasMore，界面才有机会提示用户',
    truncRes.hasMore === true, JSON.stringify(truncRes.hasMore));

  syncReply = {
    ok: true, serverTime: '2026-01-01T00:00:00.000Z', pushed: 0,
    pull: { locations: [], items: [], categories: [], images: [] },
    truncated: false, pullTo: null
  };
  const fullRes = await realSync.sync();
  ok('没被截断时进度正常推进到 serverTime',
    rawDb.settings.lastSyncAt === '2026-01-01T00:00:00.000Z', rawDb.settings.lastSyncAt);
  ok('没被截断时 hasMore 为 false', fullRes.hasMore === false, JSON.stringify(fullRes.hasMore));

  // 恢复干净状态，别影响后面的用例
  rawDb.settings.syncUrl = '';
  rawDb.settings.syncToken = '';
  rawDb.settings.lastSyncAt = '';
  srv.close();

  // 上面这一节会改设置并重新渲染，恢复成原来的同步桩，避免影响后续用例
  window.api.sync = {
    test: async () => ({ ok: false, error: '测试环境未启动服务' }),
    login: async () => ({ ok: false, error: '测试环境未启动服务' }),
    register: async () => ({ ok: false, error: '测试环境未启动服务' }),
    run: async () => ({ ok: false, error: '测试环境未启动服务' })
  };

  // 拉不完时界面必须说清楚。用户看不到控制台，只看到那句提示；
  // 如果提示写成「同步完成」，用户会以为数据已经全了。
  const origToast = window.C.toast;
  let toastMsg = '', toastKind = '';
  window.C.toast = (m, k) => { toastMsg = m; toastKind = k; };
  rawDb.settings.syncEnabled = true;
  rawDb.settings.syncToken = 'tok';
  rawDb.settings.syncUrl = 'http://127.0.0.1:1';
  window.api.sync.run = async () => ({
    ok: true, data: { pushed: 3, pulled: 20, conflicts: [], hasMore: true }
  });
  await window.App.doSync();
  ok('拉不完时提示里说清「还有数据没拉完」', /还有数据没拉完/.test(toastMsg), toastMsg);
  ok('拉不完时用警示样式，别让用户以为已经同步完', toastKind === 'warn', toastKind);

  window.api.sync.run = async () => ({
    ok: true, data: { pushed: 3, pulled: 20, conflicts: [], hasMore: false }
  });
  toastMsg = ''; toastKind = '';
  await window.App.doSync();
  ok('正常同步完时提示不带「还有数据」', !/还有数据/.test(toastMsg), toastMsg);
  ok('正常同步完时用成功样式', toastKind === 'ok', toastKind);

  // 图片没能落到本地也要单独说：否则用户看到「同步完成」、点开图却是空白，
  // 对不上，查不出真正的原因是本地空间不够。
  window.api.sync.run = async () => ({
    ok: true, data: { pushed: 1, pulled: 5, conflicts: [], hasMore: false, imagesFailed: 2 }
  });
  toastMsg = ''; toastKind = '';
  await window.App.doSync();
  ok('有图片没存上时提示里说清张数', /2 张图片没能保存/.test(toastMsg), toastMsg);
  ok('有图片没存上时用警示样式', toastKind === 'warn', toastKind);

  window.api.sync.run = async () => ({
    ok: true, data: { pushed: 1, pulled: 5, conflicts: [], hasMore: false, imagesFailed: 0 }
  });
  toastMsg = ''; toastKind = '';
  await window.App.doSync();
  ok('图片都存上时提示里不提图片', !/图片/.test(toastMsg), toastMsg);
  ok('图片都存上时用成功样式', toastKind === 'ok', toastKind);

  // 导入备份时图片写不进去，也要说清楚有几张没进来
  const origCall = window.api.call;
  const origImportFile = window.api.importFile;
  const origConfirm2 = window.C.confirm;
  window.api.importFile = async () => ({
    ok: true,
    content: JSON.stringify({ locations: [], items: [{ id: 'imp-1', name: '导入的物品' }], images: [] })
  });
  window.C.confirm = async () => true;
  window.api.call = async (action, payload) =>
    action === 'app.import'
      ? { ok: true, data: { items: 1, imagesFailed: 3 } }
      : origCall(action, payload);
  toastMsg = ''; toastKind = '';
  await window.App.importData();
  ok('导入时图片没存上要提示张数', /3 张图片没能保存/.test(toastMsg), toastMsg);
  ok('导入有图片失败时用警示样式', toastKind === 'warn', toastKind);

  window.api.call = async (action, payload) =>
    action === 'app.import'
      ? { ok: true, data: { items: 1, imagesFailed: 0 } }
      : origCall(action, payload);
  toastMsg = ''; toastKind = '';
  await window.App.importData();
  ok('导入全部成功时提示就是「导入完成」', /^导入完成$/.test(toastMsg), toastMsg);
  ok('导入全部成功时用成功样式', toastKind === 'ok', toastKind);

  window.api.call = origCall;
  window.api.importFile = origImportFile;
  window.C.confirm = origConfirm2;

  window.C.toast = origToast;
  rawDb.settings.syncEnabled = false;
  rawDb.settings.syncToken = '';
  rawDb.settings.syncUrl = '';

  // [UI-20] 同步冲突处理
  // 同一条记录两台设备都改过时，本机改的那份会被另存成「（冲突副本）」。
  // 不告诉用户的话：他以为自己的修改丢了，或者库里凭空多出一堆副本不知道哪来的。
  // 这里测的是「清单有没有摊开、三个动作有没有接对」——
  // 接错了不会报错，只会点了没反应或者删错东西。
  console.log('\n[UI-20] 同步冲突处理');

  const cfBox = () => window.document.getElementById('modalBox');
  const cfIsOpen = () => !window.document.getElementById('modalRoot').hidden;
  const cfTick = () => new Promise((r) => setTimeout(r, 20));
  const cfWait = async (fn, ms = 1000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fn()) return true;
      await new Promise((r) => setTimeout(r, 5));
    }
    return !!fn();
  };

  const origToast20 = window.C.toast;
  const origCall20 = window.api.call;
  const origOpenItem20 = window.App.openItemEditor;
  const origOpenLoc20 = window.App.openLocEditor;
  let cfToast = '';
  let cfDeleted = [];
  let cfOpened = [];

  const cfMk = (over) =>
    Object.assign(
      {
        id: 'it-1',
        name: '海天酱油',
        scope: 'items',
        kind: 'goods',
        conflictId: 'it-1-conflict-1700000000000',
        localAt: '2026-09-13T09:00:00.000Z',
        remoteAt: '2026-09-13T10:00:00.000Z'
      },
      over || {}
    );
  const cfBegin = (list) => {
    window.C.toast = (m) => {
      cfToast = m;
    };
    cfToast = '';
    return window.App.showConflictDialog(list);
  };

  // 场景 1：清单要列出来，并且每条都给「打开 / 用副本覆盖 / 保留 / 删掉副本」
  let cfP = cfBegin([
    cfMk({ localName: '海天酱油（本机改的）' }),
    cfMk({
      id: 'loc-1', name: '阳台柜', scope: 'locations', kind: '',
      conflictId: 'loc-1-conflict-1700000000001', localName: '阳台柜'
    })
  ]);
  await cfTick();
  ok('同步有冲突时会弹出清单', cfIsOpen(), String(cfIsOpen()));
  ok('标题写清了有几条冲突', /同步冲突（2 条）/.test(cfBox().innerHTML), '');
  ok('每条冲突都列出来了', cfBox().querySelectorAll('.conflict-row').length === 2,
    String(cfBox().querySelectorAll('.conflict-row').length));
  const cfNames = Array.from(cfBox().querySelectorAll('.conflict-name')).map((n) => n.textContent);
  ok('清单里能看到条目名称', /海天酱油/.test(cfNames[0] || '') && /阳台柜/.test(cfNames[1] || ''),
    JSON.stringify(cfNames));
  const cfTags = Array.from(cfBox().querySelectorAll('.conflict-name .tag')).map((n) => n.textContent);
  ok('清单里标了类型，用户才分得清是物品还是位置',
    cfTags[0] === '普通物品' && cfTags[1] === '位置', JSON.stringify(cfTags));
  ok('四条动作都在：打开 / 用副本覆盖 / 保留 / 删掉副本',
    cfBox().querySelectorAll('[data-cf-open]').length === 2 &&
      cfBox().querySelectorAll('[data-cf-restore]').length === 2 &&
      cfBox().querySelectorAll('[data-cf-keep]').length === 2 &&
      cfBox().querySelectorAll('[data-cf-del]').length === 2,
    '');
  // 「用副本覆盖」到底会覆盖成什么，用户得看得见 —— 两份改了不同名字时要写出来
  const cfLocalNameHits = (cfBox().innerHTML.match(/本机那份的名字是/g) || []).length;
  ok('两份改了不同的名字时，把本机那份的名字也写出来',
    cfLocalNameHits === 1 && /海天酱油（本机改的）/.test(cfBox().innerHTML),
    String(cfLocalNameHits));
  ok('名字一样时不重复写一遍（否则每条都多一行废话）', cfLocalNameHits === 1, String(cfLocalNameHits));

  // 场景 2：「打开」必须开对编辑器，而且开的是副本那条
  window.App.openItemEditor = async (id) => {
    cfOpened.push(['items', id]);
  };
  window.App.openLocEditor = async (id) => {
    cfOpened.push(['locations', id]);
  };
  cfBox().querySelector('[data-cf-open="0"]').click();
  await cfTick();
  ok('物品冲突点「打开」开的是物品编辑器，且开的是副本',
    cfOpened.length === 1 && cfOpened[0][0] === 'items' && cfOpened[0][1] === 'it-1-conflict-1700000000000',
    JSON.stringify(cfOpened));
  ok('看完之后清单还在（副本没被偷偷删掉）', cfBox().querySelectorAll('.conflict-row').length === 2,
    String(cfBox().querySelectorAll('.conflict-row').length));
  cfBox().querySelector('[data-cf-open="1"]').click();
  await cfTick();
  ok('位置冲突点「打开」开的是位置编辑器，且开的是副本',
    cfOpened.length === 2 && cfOpened[1][0] === 'locations' && cfOpened[1][1] === 'loc-1-conflict-1700000000001',
    JSON.stringify(cfOpened));

  // 场景 3：「保留」只是把这条从清单里划掉，不该动任何数据
  cfDeleted = [];
  window.api.call = async (action, payload) => {
    if (/^(items|locations|categories)\.delete$/.test(action)) {
      cfDeleted.push([action, payload && payload.id]);
      return { ok: true, data: {} };
    }
    return origCall20(action, payload);
  };
  cfBox().querySelector('[data-cf-keep="0"]').click();
  await cfTick();
  ok('点「保留」后这条从清单里划掉', cfBox().querySelectorAll('.conflict-row').length === 1,
    String(cfBox().querySelectorAll('.conflict-row').length));
  ok('点「保留」不会去删副本', cfDeleted.length === 0, JSON.stringify(cfDeleted));

  // 场景 4：「删掉副本」要先确认，确认后调对接口、删对 id
  cfBox().querySelector('[data-cf-del="0"]').click();
  await cfTick();
  ok('删副本前先弹确认', /删除冲突副本/.test(cfBox().innerHTML), '');
  ok('确认文案里说清本机这份找不回来了', /无法找回/.test(cfBox().innerHTML), '');
  ok('还没点确认时不会就把副本删了', cfDeleted.length === 0, JSON.stringify(cfDeleted));
  cfBox().querySelector('[data-act="ok"]').click();
  await cfWait(() => cfDeleted.length > 0);
  ok('确认后调的是位置删除接口（不是物品的）',
    cfDeleted.length === 1 && cfDeleted[0][0] === 'locations.delete', JSON.stringify(cfDeleted));
  ok('删的是冲突副本的 id，不是正本的',
    cfDeleted.length === 1 && cfDeleted[0][1] === 'loc-1-conflict-1700000000001', JSON.stringify(cfDeleted));
  await cfP;
  ok('全部处理完后清单自动关闭', !cfIsOpen(), String(cfIsOpen()));
  ok('全部处理完后给一句反馈', /冲突已处理/.test(cfToast), cfToast);

  // 场景 4b：「用副本覆盖」把本机那份换回来
  // 这一步会盖掉 NAS 上较新的改动、还要同步给所有设备，所以必须先二次确认；
  // 确认后要调对接口、把 scope / 正本 id / 副本 id 三个参数都传对
  // ——传错了不报错，只会「点了没反应」或者拿别的记录去盖这一条。
  let cfRestored = [];
  const cfDelBefore = cfDeleted.length;
  window.api.call = async (action, payload) => {
    if (action === 'conflict.restore') {
      cfRestored.push(payload);
      return { ok: true, data: { ok: true } };
    }
    if (/^(items|locations|categories)\.delete$/.test(action)) {
      cfDeleted.push([action, payload && payload.id]);
      return { ok: true, data: {} };
    }
    return origCall20(action, payload);
  };
  cfP = cfBegin([cfMk({})]);
  await cfTick();
  ok('冲突清单里有「用副本覆盖」这个动作',
    cfBox().querySelectorAll('[data-cf-restore]').length === 1,
    String(cfBox().querySelectorAll('[data-cf-restore]').length));

  // 先走一遍取消：点错了不能真去覆盖
  cfBox().querySelector('[data-cf-restore="0"]').click();
  await cfTick();
  ok('覆盖前先弹确认（这一步不可逆）', /用本机这份覆盖/.test(cfBox().innerHTML), '');
  ok('确认文案说清了 NAS 上那份会被替换掉', /会被替换掉/.test(cfBox().innerHTML), '');
  ok('确认文案说清了其他设备也会跟着变', /其他设备/.test(cfBox().innerHTML), '');
  ok('还没确认时不会就去覆盖', cfRestored.length === 0, JSON.stringify(cfRestored));
  cfBox().querySelector('[data-act="cancel"]').click();
  await cfTick();
  ok('点「取消」不会覆盖（不可逆的操作必须给后悔的机会）',
    cfRestored.length === 0, JSON.stringify(cfRestored));
  ok('点「取消」后这条还留在清单里', cfBox().querySelectorAll('.conflict-row').length === 1,
    String(cfBox().querySelectorAll('.conflict-row').length));

  cfBox().querySelector('[data-cf-restore="0"]').click();
  await cfTick();
  cfBox().querySelector('[data-act="ok"]').click();
  await cfWait(() => cfRestored.length > 0);
  ok('确认后调的是 conflict.restore', cfRestored.length === 1, JSON.stringify(cfRestored));
  ok('覆盖时把 scope / 正本 id / 副本 id 都传对了',
    cfRestored.length === 1 && cfRestored[0].scope === 'items' &&
      cfRestored[0].id === 'it-1' && cfRestored[0].conflictId === 'it-1-conflict-1700000000000',
    JSON.stringify(cfRestored));
  ok('覆盖不会顺手去删副本（收尾是数据层一个原子动作做的）',
    cfDeleted.length === cfDelBefore, JSON.stringify(cfDeleted));
  await cfP;
  ok('覆盖完这条也从清单里划掉', !cfIsOpen(), String(cfIsOpen()));

  // 场景 4c：覆盖失败要说清楚，不能静默划过（用户会以为换成功了）
  cfRestored = [];
  window.api.call = async (action, payload) => {
    if (action === 'conflict.restore') {
      cfRestored.push(payload);
      return { ok: false, error: '找不到冲突副本，可能已经被删掉了' };
    }
    return origCall20(action, payload);
  };
  cfP = cfBegin([cfMk({})]);
  await cfTick();
  cfBox().querySelector('[data-cf-restore="0"]').click();
  await cfTick();
  cfBox().querySelector('[data-act="ok"]').click();
  await cfWait(() => /找不到冲突副本/.test(cfToast));
  await cfTick();
  ok('覆盖失败时把原因告诉用户', /找不到冲突副本/.test(cfToast), cfToast);
  ok('覆盖失败后这条仍留在清单里（不能当成处理过了）',
    cfBox().querySelectorAll('.conflict-row').length === 1,
    String(cfBox().querySelectorAll('.conflict-row').length));
  if (cfIsOpen()) cfBox().querySelector('[data-act="close"]').click();
  await cfP;
  window.api.call = origCall20;

  // 场景 5：分类没有编辑界面，就不能给一个点了没反应的「打开」
  cfP = cfBegin([
    cfMk({ id: 'cat-1', name: '食品', scope: 'categories', kind: '', conflictId: 'cat-1-conflict-1700000000002' })
  ]);
  await cfTick();
  ok('分类冲突照样列出来', cfBox().querySelectorAll('.conflict-row').length === 1,
    String(cfBox().querySelectorAll('.conflict-row').length));
  ok('分类没有编辑器，就不给「打开」按钮（免得点了没反应）',
    cfBox().querySelector('[data-cf-open]') === null, String(cfBox().querySelector('[data-cf-open]')));
  ok('分类照样能给「用副本覆盖」（没有编辑器，这是它唯一的挽回手段）',
    cfBox().querySelectorAll('[data-cf-restore]').length === 1,
    String(cfBox().querySelectorAll('[data-cf-restore]').length));
  ok('分类冲突仍然可以删掉副本', cfBox().querySelectorAll('[data-cf-del]').length === 1, '');
  cfBox().querySelector('[data-act="close"]').click();
  await cfP;
  ok('关掉弹窗时不会顺手删掉没处理的那条', cfDeleted.length === 1, JSON.stringify(cfDeleted));

  // 场景 6：没有冲突就不该弹窗
  cfP = cfBegin([]);
  await cfP;
  ok('没有冲突时不弹窗', !cfIsOpen(), String(cfIsOpen()));

  // 场景 7：doSync 里真的接了这条线（光有弹窗、同步完不调它等于没做）
  rawDb.settings.syncEnabled = true;
  rawDb.settings.syncToken = 'tok';
  rawDb.settings.syncUrl = 'http://127.0.0.1:1';
  window.api.sync.run = async () => ({
    ok: true,
    data: { pushed: 1, pulled: 1, conflicts: [cfMk({})], hasMore: false, imagesFailed: 0 }
  });
  const cfSyncP = window.App.doSync();
  const cfPopped = await cfWait(() => cfIsOpen());
  ok('同步完成后有冲突就自动把清单弹出来', cfPopped, String(cfIsOpen()));
  ok('同步提示里也说清了有几条冲突待处理', /1 条待处理/.test(cfToast), cfToast);
  if (cfIsOpen()) cfBox().querySelector('[data-act="close"]').click();
  await cfSyncP;

  window.api.sync.run = async () => ({ ok: false, error: '测试环境未启动服务' });
  window.api.call = origCall20;
  window.App.openItemEditor = origOpenItem20;
  window.App.openLocEditor = origOpenLoc20;
  window.C.toast = origToast20;
  rawDb.settings.syncEnabled = false;
  rawDb.settings.syncToken = '';
  rawDb.settings.syncUrl = '';

  console.log('\n[UI-5] 搜索交互');
  const search = $('#globalSearch');
  search.value = '酱油';
  window.App.state.keyword = '酱油';
  await window.App.renderItemsFiltered(window.document.getElementById('view-items'));
  ok('搜索「酱油」得到 1 条', window.document.querySelectorAll('#view-items .item-row').length === 1, String(window.document.querySelectorAll('#view-items .item-row').length));

  window.App.state.keyword = '';
  await window.App.goto('items', { keepFilters: true });
  ok('清空搜索后恢复 3 条', window.document.querySelectorAll('#view-items .item-row').length === 3);

  console.log('\n[UI-6] 位置筛选联动');
  window.App.state.filters = { location_id: cold.id };
  await window.App.goto('items', { keepFilters: true });
  ok('按冷藏室筛选得 2 条', window.document.querySelectorAll('#view-items .item-row').length === 2, String(window.document.querySelectorAll('#view-items .item-row').length));

  window.App.state.filters = { location_id: fridge.id };
  await window.App.goto('items', { keepFilters: true });
  ok('按冰箱筛选（含下级）得 2 条', window.document.querySelectorAll('#view-items .item-row').length === 2);

  window.App.state.filters = { location_id: kitchen.id };
  await window.App.goto('items', { keepFilters: true });
  ok('按厨房筛选（含所有下级）得 3 条', window.document.querySelectorAll('#view-items .item-row').length === 3, String(window.document.querySelectorAll('#view-items .item-row').length));

  window.App.state.filters = {};

  console.log('\n[UI-7] 分类筛选');
  window.App.state.filters = { category_id: cats[4].id };
  await window.App.goto('items', { keepFilters: true });
  ok('按「五金」分类筛选得 1 条', window.document.querySelectorAll('#view-items .item-row').length === 1);

  window.App.state.filters = { category_id: cats[0].id };
  await window.App.goto('items', { keepFilters: true });
  ok('按「食品」分类筛选得 2 条', window.document.querySelectorAll('#view-items .item-row').length === 2);
  window.App.state.filters = {};

  console.log('\n[UI-8] 保质期筛选');
  window.App.state.filters = { expiry: 'expired' };
  await window.App.goto('items', { keepFilters: true });
  ok('筛选已过期得 1 条', window.document.querySelectorAll('#view-items .item-row').length === 1);

  window.App.state.filters = { expiry: 'soon' };
  await window.App.goto('items', { keepFilters: true });
  ok('筛选即将到期得 1 条', window.document.querySelectorAll('#view-items .item-row').length === 1);

  window.App.state.filters = { expiry: 'none' };
  await window.App.goto('items', { keepFilters: true });
  ok('筛选无保质期得 1 条', window.document.querySelectorAll('#view-items .item-row').length === 1);
  window.App.state.filters = {};

  console.log('\n[UI-9] 数量增减');
  const before = (await store.handle('items.list', {})).find((i) => i.name === '全麦面包').quantity;
  await window.App.consume((await store.handle('items.list', {})).find((i) => i.name === '全麦面包').id, -1);
  const after = (await store.handle('items.list', {})).find((i) => i.name === '全麦面包').quantity;
  ok('点击减号数量减少', after === before - 1, `${before} → ${after}`);

  console.log('\n[UI-10] 排序');
  window.App.state.filters = { sort: 'name_asc' };
  await window.App.goto('items', { keepFilters: true });
  const names = Array.from(window.document.querySelectorAll('#view-items .item-name')).map((n) => n.textContent.trim().slice(0, 2));
  ok('按名称排序生效', names.length === 3, names.join(','));
  window.App.state.filters = {};

  console.log('\n[UI-11] 新增位置对话框的「上级位置」下拉');
  // 回归：树节点曾缺 path 字段，导致除「作为顶层位置」外所有选项都显示 undefined。
  // 注意 C.form 返回的 Promise 要等用户提交/取消才 resolve，所以这里不能 await。
  window.App.openLocEditor(null);
  await new Promise((r) => setTimeout(r, 60));
  const sel = window.document.querySelector('#modalBox select[data-k="parent_id"]');
  ok('对话框已弹出且有上级位置下拉', !!sel);
  if (sel) {
    const opts = Array.from(sel.options);
    ok('首个选项是「作为顶层位置」', opts[0] && opts[0].text.includes('顶层'), opts[0] && opts[0].text);
    const rest = opts.slice(1);
    ok('存在可选的位置选项', rest.length > 0, 'got ' + rest.length);
    const bad = rest.filter((o) => o.text.includes('undefined') || !o.text.trim());
    ok('没有 undefined 选项', bad.length === 0, bad.map((o) => '"' + o.text + '"').join(', '));
    // 注意：trim() 会把全角空格 U+3000 也去掉，缩进检查必须用原始 text
    const texts = rest.map((o) => o.text.trim());
    ok('选项显示完整层级路径', texts.some((t) => t.includes('厨房 / 冰箱 / 冷藏室')),
      texts.slice(0, 3).join(' | '));
    const rawTexts = rest.map((o) => o.text);
    ok('子位置有缩进层级', rawTexts.some((t) => t.startsWith('\u3000')),
      '没有任何选项带缩进');
    // 选中一个真实位置，确认 value 是有效 id
    const sample = rest.find((o) => o.text.includes('厨房 / 冰箱 / 冷藏室'));
    ok('选项 value 是位置 id', !!sample && !!sample.value && sample.value.length > 0,
      sample && sample.value);
  }
  // 关掉对话框，避免影响后续
  window.document.getElementById('modalRoot').hidden = true;

  // ============================================================
  // [UI-12] 二维码：生成 + 识别
  // ============================================================
  console.log('\n[UI-12] 二维码生成与识别');
  ok('QR.parse 存在', typeof window.QR.parse === 'function');
  const locP = window.QR.locPayload('loc-abc');
  const itemP = window.QR.itemPayload('item-xyz');
  ok('位置载荷带应用前缀', locP === 'HOMESTORAGE:LOC:loc-abc', locP);
  ok('物品载荷带应用前缀', itemP === 'HOMESTORAGE:ITEM:item-xyz', itemP);
  const pl = window.QR.parse(locP);
  ok('能解析出位置二维码', pl && pl.type === 'loc' && pl.id === 'loc-abc', JSON.stringify(pl));
  const pi = window.QR.parse(itemP);
  ok('能解析出物品二维码', pi && pi.type === 'item' && pi.id === 'item-xyz', JSON.stringify(pi));
  ok('前缀大小写不敏感', !!window.QR.parse('homestorage:loc:x1'));
  ok('普通条码不会被误判成二维码', window.QR.parse('6901234567892') === null);
  ok('乱码不会被误判成二维码', window.QR.parse('https://example.com') === null);
  ok('空值不会崩', window.QR.parse(null) === null && window.QR.parse('') === null);
  // 识别结果里的 id 不能带多余空白
  ok('解析结果去掉首尾空白', window.QR.parse('  HOMESTORAGE:ITEM:abc  ').id === 'abc');

  // 真正生成一次二维码：SVG 里必须有方块，且能被解码回原文
  ok('QR.supported 报告可用', window.QR.supported() === true);
  let svg = '';
  try { svg = window.QR.svg(itemP, 200); } catch (e) { svg = ''; console.log('      生成失败：' + e.message); }
  ok('能生成二维码 SVG', svg.indexOf('<svg') === 0 && svg.length > 500, 'len=' + svg.length);
  ok('生成的 SVG 里有二维码模块', (svg.match(/<rect/g) || []).length > 50,
    'rect 数=' + (svg.match(/<rect/g) || []).length);
  ok('SVG 带 xmlns（可单独当图片用）', svg.indexOf('xmlns') > 0);
  const durl = window.QR.dataUrl(itemP, 200);
  ok('能生成 data URL 直接放进 img', durl.indexOf('data:image/svg+xml') === 0);

  // 位置行要有「二维码」按钮，点了能弹出码
  await window.App.goto('locations');
  const qrBtn = window.document.querySelector('#treeEditor [data-qr]');
  ok('位置列表里有生成二维码的按钮', !!qrBtn);
  if (qrBtn) {
    qrBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const box = window.document.querySelector('#modalRoot .qr-box');
    ok('点按钮弹出二维码', !!box);
    const cap = window.document.querySelector('#modalRoot .qr-caption');
    ok('二维码下面写着这是哪个位置', !!cap && cap.textContent.trim().length > 0,
      cap && cap.textContent.trim());
  }
  window.document.getElementById('modalRoot').hidden = true;

  // ============================================================
  // [UI-13] 物品图片：列表缩略图 + 查看大图
  // ============================================================
  console.log('\n[UI-13] 物品图片');
  const THUMB = 'data:image/jpeg;base64,/9j/4THUMB' + 'A'.repeat(60);
  const FULLIMG = 'data:image/jpeg;base64,/9j/4FULL' + 'B'.repeat(300);
  const imgItem = await store.handle('items.save', { name: '带图的收纳盒', location_id: cold.id });
  const imgSaved = await store.handle('images.save', { item_id: imgItem.id, full: FULLIMG, thumb: THUMB, w: 800, h: 600 });
  ok('保存图片后返回 image_id', typeof imgSaved.image_id === 'string' && imgSaved.image_id.length > 0);

  await window.App.goto('items');
  // 缩略图挂在物品所在那一行上
  const imgRowEl = window.document.querySelector('#view-items [data-item="' + imgItem.id + '"]');
  ok('列表里有这件带图的物品', !!imgRowEl);
  const thumbEl = imgRowEl && imgRowEl.querySelector('[data-thumb]');
  ok('物品列表显示缩略图', !!thumbEl);
  ok('缩略图用的是保存的缩略图数据', thumbEl && thumbEl.getAttribute('src') === THUMB);
  ok('缩略图挂的是图片 id（不是物品 id）', thumbEl && thumbEl.getAttribute('data-thumb') === imgSaved.image_id,
    thumbEl && thumbEl.getAttribute('data-thumb'));
  if (thumbEl) {
    thumbEl.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    // viewImage 是异步的（要按 id 取全图），等一拍再看 DOM
    await new Promise((r) => setTimeout(r, 30));
    const viewer = window.document.querySelector('#modalRoot .img-view');
    ok('点缩略图弹出大图', !!viewer);
    const bigImg = window.document.querySelector('#modalRoot .img-view img');
    ok('大图用全图（不是缩略图）', bigImg && bigImg.getAttribute('src') === FULLIMG,
      bigImg ? String(bigImg.getAttribute('src')).slice(0, 40) : 'null');
  }
  window.document.getElementById('modalRoot').hidden = true;

  // 物品编辑器里要有图片行
  const editorHtml = window.App.openItemEditor ? true : false;
  ok('App.openItemEditor 存在', editorHtml);
  ok('App.viewImage 存在', typeof window.App.viewImage === 'function');
  ok('App.showQr 存在', typeof window.App.showQr === 'function');
  ok('App._compressImage 存在（拍照后压图）', typeof window.App._compressImage === 'function');
  ok('views 能处理扫码进来的二维码', typeof window.Views._handleQrCode === 'function');

  // ============================================================
  // [UI-14] 扫码的实际行为（这是整个需求的核心）
  // 扫到本应用的二维码时，要能「跳过去看到里面有什么」，而不是当普通条码去查商品。
  // ============================================================
  console.log('\n[UI-14] 扫二维码 → 打开位置/物品');
  await window.App.goto('scan');
  const scanEl = window.document.getElementById('view-scan');

  // 扫位置码：应跳到物品页，并且只显示这个位置里的东西
  await window.Views._handleCode(scanEl, window.App.state, window.QR.locPayload(cold.id), 'QR_CODE', 'test');
  await new Promise((r) => setTimeout(r, 120));
  const itemsView = window.document.getElementById('view-items');
  ok('扫位置码后跳到了物品页', itemsView && itemsView.hidden === false);
  ok('位置筛选已设为被扫的位置', window.App.state.filters.location_id === cold.id,
    String(window.App.state.filters.location_id));
  const coldRows = [...window.document.querySelectorAll('#view-items .item-row')];
  ok('列出了该位置里的物品', coldRows.length >= 2, 'got ' + coldRows.length);
  ok('列出的都是这个位置里的东西',
    coldRows.length > 0 && coldRows.every((r) => r.textContent.includes('冷藏室')),
    coldRows.map((r) => r.textContent.slice(0, 30)).join(' | '));
  // 扫码记录里要标成「二维码 · 位置」，不能混进普通条码里
  const lastLog = (window.App.state.scanLog || [])[0];
  ok('扫码记录标注了是位置二维码', !!lastLog && /二维码/.test(lastLog.format) && /位置/.test(lastLog.format),
    lastLog && lastLog.format);

  // 扫物品码：应直接打开这件物品
  await window.App.goto('scan');
  const someItem = (await store.handle('items.list')).find((i) => i.name === '海天酱油');
  await window.Views._handleCode(scanEl, window.App.state, window.QR.itemPayload(someItem.id), 'QR_CODE', 'test');
  await new Promise((r) => setTimeout(r, 150));
  const modalBox = window.document.querySelector('#modalRoot .modal-box');
  ok('扫物品码后打开了物品详情', !!modalBox);
  // 名称在 input 的 value 里，不在 textContent 里
  const nameInput = window.document.querySelector('#modalRoot input[data-k="name"]');
  ok('打开的正是那件物品', !!nameInput && nameInput.value === '海天酱油',
    nameInput ? nameInput.value : '没找到名称输入框');
  window.document.getElementById('modalRoot').hidden = true;

  // 扫一个不存在的二维码 id：要给提示，不能白屏或静默失败
  await window.App.goto('scan');
  await window.Views._handleCode(scanEl, window.App.state, window.QR.locPayload('no-such-loc'), 'QR_CODE', 'test');
  await new Promise((r) => setTimeout(r, 120));
  const toastText = window.document.getElementById('toastRoot').textContent || '';
  ok('扫到失效二维码会提示（不静默失败）', /不存在/.test(toastText), toastText.slice(0, 60));

  // 还原筛选，避免影响后续
  window.App.state.filters = { location_id: null };
  window.document.getElementById('modalRoot').hidden = true;

  // [UI-16] 办公资料页 / 图书页
  // 需求里新增的两个栏目。它们和物品清单共用一张表，靠 kind 区分，
  // 所以这里重点验「会不会串台」——资料页不能冒出图书，图书页不能冒出资料。
  console.log('\n[UI-16] 办公资料页与图书页');

  const THIS_YEAR = String(new Date().getFullYear());
  const catOf = (key) => cats.find((c) => c.key === key);
  await store.handle('items.save', {
    name: '房屋租赁合同', kind: 'doc', icon: 'contract', category_id: catOf('合同').id,
    extra: { doc_no: 'HT-2026-018', year: THIS_YEAR, org: '某某物业', amount: '48000', keep_until: '2031-12-31' }
  });
  await store.handle('items.save', {
    name: '2025年记账凭证', kind: 'doc', category_id: catOf('记账').id,
    extra: { year: '2025', amount: '1200', keep_until: '2020-01-01' }
  });
  await store.handle('items.save', {
    name: '深入理解计算机系统', kind: 'book', icon: 'book', barcode: '9787111544937',
    category_id: catOf('图书').id,
    extra: { author: 'Bryant', publisher: '机械工业出版社', pub_year: '2016', status: '在读' }
  });
  await store.handle('items.save', {
    name: '线性代数教材', kind: 'book', category_id: catOf('教材').id, extra: { status: '未读' }
  });

  await window.App.goto('docs');
  const docsEl = window.document.getElementById('view-docs');
  const docRows = () => window.document.querySelectorAll('#view-docs .item-row');
  ok('办公资料页渲染成功', docsEl.textContent.includes('办公资料'));
  ok('办公资料页只列资料', docRows().length === 2, 'got ' + docRows().length);
  ok('办公资料页不串入图书', !docsEl.textContent.includes('深入理解计算机系统'));
  ok('资料行显示文件编号', docsEl.textContent.includes('HT-2026-018'));
  ok('资料行显示金额', docsEl.textContent.includes('48000'));
  ok('资料行显示年度', docsEl.textContent.includes(THIS_YEAR + ' 年度'));
  ok('资料页有资料总数卡片', docsEl.textContent.includes('资料总数'));
  ok('资料页有涉及金额卡片', docsEl.textContent.includes('涉及金额'));
  const docCatText = docsEl.querySelector('#catChips').textContent;
  ok('资料页分类含合同协议', docCatText.includes('合同协议'));
  ok('资料页分类含记账凭证', docCatText.includes('记账凭证'));
  ok('资料页分类不含生活类分类', !docCatText.includes('宠物用品') && !docCatText.includes('清洁用品'));
  ok('资料页有年度筛选条', docsEl.querySelector('#facetChips').textContent.includes('全部年度'));
  ok('资料页年度筛选含本年', docsEl.querySelector('#facetChips').textContent.includes(THIS_YEAR + ' 年'));
  ok('资料页有「已过保管期」筛选', docsEl.querySelector('#facetChips').textContent.includes('已过保管期'));
  ok('资料页新增按钮是「新增资料」', docsEl.textContent.includes('新增资料'));

  // 年度筛选：选 2025 年只剩那条记账凭证
  window.App.state.filters = { facet: 'y:2025' };
  await window.App.goto('docs', { keepFilters: true });
  ok('按年度筛选生效', docRows().length === 1, 'got ' + docRows().length);
  ok('筛选出的正是 2025 年那条', window.document.getElementById('view-docs').textContent.includes('2025年记账凭证'));

  // 已过保管期：keep_until 早于今天就该被筛出来
  window.App.state.filters = { facet: 'keep:over' };
  await window.App.goto('docs', { keepFilters: true });
  ok('按已过保管期筛选生效', docRows().length === 1, 'got ' + docRows().length);
  window.App.state.filters = {};

  await window.App.goto('books');
  const booksEl = window.document.getElementById('view-books');
  const bookRows = () => window.document.querySelectorAll('#view-books .item-row');
  ok('图书页渲染成功', booksEl.textContent.includes('图书'));
  ok('图书页只列图书', bookRows().length === 2, 'got ' + bookRows().length);
  ok('图书页不串入资料', !booksEl.textContent.includes('房屋租赁合同'));
  ok('图书行显示作者', booksEl.textContent.includes('Bryant'));
  ok('图书行显示出版社', booksEl.textContent.includes('机械工业出版社'));
  ok('图书行把条码显示成 ISBN', booksEl.textContent.includes('ISBN 9787111544937'));
  ok('图书行显示阅读状态', booksEl.textContent.includes('在读'));
  ok('图书页新增按钮是「新增图书」', booksEl.textContent.includes('新增图书'));
  const bookCatText = booksEl.querySelector('#catChips').textContent;
  ok('图书页分类含教材教辅', bookCatText.includes('教材教辅'));
  ok('图书页分类不含办公类分类', !bookCatText.includes('合同协议'));

  // 阅读状态筛选
  window.App.state.filters = { facet: '未读' };
  await window.App.goto('books', { keepFilters: true });
  ok('按阅读状态筛选生效', bookRows().length === 1, 'got ' + bookRows().length);
  window.App.state.filters = {};

  // 全局搜索在资料页就地生效，不把用户弹到物品清单
  window.App.state.keyword = 'Bryant';
  await window.App.renderItemsFiltered(window.document.getElementById('view-books'), 'books');
  ok('图书页搜索就地生效', window.document.querySelectorAll('#view-books .item-row').length === 1,
    String(window.document.querySelectorAll('#view-books .item-row').length));
  ok('搜索后仍停在图书页', window.App.state.view === 'books', window.App.state.view);
  window.App.state.keyword = '';

  // 物品清单的类型筛选：选「图书」只剩那 2 本
  window.App.state.filters = {};
  await window.App.goto('items');
  window.App.state.filters = { kind: 'book' };
  await window.App.goto('items', { keepFilters: true });
  ok('物品清单按类型筛选生效', window.document.querySelectorAll('#view-items .item-row').length === 2,
    String(window.document.querySelectorAll('#view-items .item-row').length));
  ok('按类型筛选后分类条只列图书类',
    window.document.querySelector('#view-items #catChips').textContent.includes('杂志期刊'));
  window.App.state.filters = {};

  // 新增资料：编辑器要按 kind 换字段（有「文件编号」，没有「生产日期」）
  window.App.openItemEditor(null, { kind: 'doc' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 80));
  const docBox = window.document.querySelector('#modalRoot .modal-box');
  ok('新增资料弹窗标题正确', !!docBox && docBox.textContent.includes('新增资料'),
    docBox ? docBox.textContent.slice(0, 40) : 'no modal');
  ok('资料编辑器有「文件名称」', !!window.document.querySelector('#modalRoot [data-k="name"]') &&
    docBox.textContent.includes('文件名称'));
  ok('资料编辑器有「文件编号」', !!window.document.querySelector('#modalRoot [data-k="x_doc_no"]'));
  ok('资料编辑器有「保管期限至」', !!window.document.querySelector('#modalRoot [data-k="x_keep_until"]'));
  ok('资料编辑器没有「生产日期」', !window.document.querySelector('#modalRoot [data-k="production_date"]'));
  ok('资料编辑器有内部编码字段', !!window.document.querySelector('#modalRoot [data-k="code"]'));
  ok('资料编辑器有图标选择区', !!window.document.querySelector('#modalRoot #iconField'));
  ok('资料编辑器分类下拉不含生活类',
    !docBox.querySelector('[data-k="category_id"]').textContent.includes('宠物用品'));
  window.C.close();

  // 新增图书：字段换成作者/出版社/阅读状态
  window.App.openItemEditor(null, { kind: 'book' }).catch(() => {});
  await new Promise((r) => setTimeout(r, 80));
  const bookBox = window.document.querySelector('#modalRoot .modal-box');
  ok('新增图书弹窗标题正确', !!bookBox && bookBox.textContent.includes('新增图书'));
  ok('图书编辑器有「书名」', bookBox.textContent.includes('书名'));
  ok('图书编辑器有「作者」', !!window.document.querySelector('#modalRoot [data-k="x_author"]'));
  ok('图书编辑器有「出版社」', !!window.document.querySelector('#modalRoot [data-k="x_publisher"]'));
  ok('图书编辑器有「阅读状态」', !!window.document.querySelector('#modalRoot [data-k="x_status"]'));
  ok('图书编辑器把条码叫 ISBN', bookBox.textContent.includes('ISBN'));
  window.C.close();

  // 图标选择器：能弹出、能选中、能选「用分类默认」、能取消
  const pickP = window.App.pickIcon('');
  await new Promise((r) => setTimeout(r, 60));
  const pickBox = window.document.querySelector('#modalRoot .modal-box');
  ok('图标选择器弹出', !!pickBox && pickBox.textContent.includes('选择图标'));
  ok('图标选择器列出了分组', window.document.querySelectorAll('#modalRoot .icon-group-title').length >= 9,
    String(window.document.querySelectorAll('#modalRoot .icon-group-title').length));
  ok('图标选择器列出了图标格子', window.document.querySelectorAll('#modalRoot .icon-cell').length >= 80,
    String(window.document.querySelectorAll('#modalRoot .icon-cell').length));
  window.document.querySelector('#modalRoot .icon-cell[data-ic="book"]').click();
  ok('点图标后返回该 key', (await pickP) === 'book');

  const pickP2 = window.App.pickIcon('');
  await new Promise((r) => setTimeout(r, 60));
  const sb = window.document.querySelector('#modalRoot #iconSearch');
  sb.value = '发票';
  sb.dispatchEvent(new window.Event('input'));
  await new Promise((r) => setTimeout(r, 40));
  const filtered = window.document.querySelectorAll('#modalRoot .icon-cell').length;
  ok('图标搜索能过滤', filtered > 0 && filtered < 80, String(filtered));
  window.document.querySelector('#modalRoot #btnIconAuto').click();
  ok('「用分类默认」返回空串（不是取消）', (await pickP2) === '');

  const pickP3 = window.App.pickIcon('book');
  await new Promise((r) => setTimeout(r, 60));
  window.document.querySelector('#modalRoot [data-act="close"]').click();
  ok('取消图标选择返回 null', (await pickP3) === null);

  // 自动编号：界面在保存前调用 nextCode 拿号
  const nc = await store.handle('items.nextCode');
  ok('可拿到待分配的内部编码', /^HS-\d{4}-\d{4}$/.test(nc.code), nc.code);

  window.App.state.filters = {};
  window.App.state.keyword = '';

  // [UI-15] 内置矢量图标库
  // 需求「给物品配图片」不引入任何图片文件：全部用手绘 SVG，靠 key 取用。
  // 这里守住几条不能退化的约束，否则界面会出现空白格子或张冠李戴的图标。
  console.log('\n[UI-15] 物品图标库');

  const IC = window.ITEM_ICONS;
  ok('图标库已加载且暴露 groups/all/get/name/svg',
    !!(IC && IC.groups && IC.all && IC.get && IC.name && IC.svg));

  ok('图标分组不少于 9 组', IC.groups.length >= 9, `实际 ${IC.groups.length}`);
  ok('图标总数不少于 80 个', IC.all.length >= 80, `实际 ${IC.all.length}`);

  // key 唯一：重复会让后面的图标把前面的覆盖掉，是静默错误
  const keys = IC.all.map((i) => i.key);
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  ok('图标 key 无重复', dup.length === 0, dup.join(','));

  // 每个图标都要有非空 body，否则界面上就是一个空占位
  const emptyBody = IC.all.filter((i) => !i.body || !i.body.trim());
  ok('没有空图标', emptyBody.length === 0, emptyBody.map((i) => i.key).join(','));

  const noName = IC.all.filter((i) => !i.name || !i.name.trim());
  ok('每个图标都有中文名', noName.length === 0, noName.map((i) => i.key).join(','));

  // 分组内图标数之和必须等于 all，防止分组遍历时漏掉
  const sum = IC.groups.reduce((n, g) => n + g.icons.length, 0);
  ok('分组图标数之和等于总数', sum === IC.all.length, `${sum} vs ${IC.all.length}`);

  // 未知 key 必须安全返回空串：渲染层会直接把它塞进 innerHTML
  ok('未知 key 返回空串（不抛错）', IC.svg('__no_such_icon__') === '' && IC.get('__no_such_icon__') === null);

  // 生成的 SVG 必须自带尺寸和 currentColor，否则会撑破布局或变黑
  const sample = IC.svg('book', 20);
  ok('svg 带 viewBox 与 24 基网格', /viewBox="0 0 24 24"/.test(sample));
  ok('svg 尺寸可指定', /width="20"/.test(sample) && /height="20"/.test(sample));
  ok('svg 用 currentColor 描边（跟随主题色）',
    /stroke="currentColor"/.test(sample) && /fill="none"/.test(sample));
  ok('不指定尺寸时默认 24', /width="24"/.test(IC.svg('book')));
  ok('图标名可按 key 查到中文', IC.name('book') === '图书', IC.name('book'));

  // 图标 body 里不允许出现图片/外链，必须纯矢量（离线可用、无网络请求）
  const badBody = IC.all.filter((i) => /<image|href|url\(|http/i.test(i.body));
  ok('图标不含外链或位图引用（纯矢量）', badBody.length === 0, badBody.map((i) => i.key).join(','));

  // 物品行渲染时若拿到非法 key，不能抛错（数据里可能存着旧版本的 key）
  ok('渲染层对未知图标 key 不抛错', (() => {
    try { return IC.svg(undefined) === '' && IC.svg(null) === ''; } catch (e) { return false; }
  })());

  // 图标映射表的两层引用必须都指得实。这两处是「隐性契约」，错了不会报错：
  //   第一层：预置分类的 key 在 CAT_ICON 里没有对应项 → 该分类的物品只能靠类型兜底，
  //          「图书」和「合同」会显示成同一个图标，自动配图标就白做了；
  //   第二层：CAT_ICON / KIND_ICON 指向了不存在的图标 key → svg() 返回空串，
  //          界面上图标静默消失（不崩，所以没人会发现）。
  const catNoIcon = cats.filter((c) => !IC.catIcon(c.key));
  ok('每个预置分类都有分类默认图标', catNoIcon.length === 0,
    catNoIcon.map((c) => c.key + '/' + c.name).join(','));
  const catIconBroken = cats.filter((c) => {
    const k = IC.catIcon(c.key);
    return k && !IC.get(k);
  });
  ok('分类默认图标都指向真实存在的图标', catIconBroken.length === 0,
    catIconBroken.map((c) => c.key + '→' + IC.catIcon(c.key)).join(','));
  const kindBroken = ['goods', 'doc', 'book'].filter((kind) => !IC.get(IC.forItem({ kind })));
  ok('类型兜底图标都真实存在', kindBroken.length === 0, kindBroken.join(','));
  // 三类的兜底图标必须互不相同，否则列表里分不出哪条是资料、哪条是书
  const kindKeys = ['goods', 'doc', 'book'].map((kind) => IC.forItem({ kind }));
  ok('三类兜底图标互不相同', new Set(kindKeys).size === 3, kindKeys.join(','));

  // 用户手选的图标哪天被从图标库里删掉了，必须回退到分类默认，不能变成空白
  ok('手选图标失效时回退到分类默认',
    IC.forItem({ icon: '__已删掉的图标__', cat_key: '图书', kind: 'book' }) === IC.catIcon('图书'),
    IC.forItem({ icon: '__已删掉的图标__', cat_key: '图书', kind: 'book' }));
  // 连分类都没有（或分类被删了）的时候，回退到类型兜底
  ok('分类失效时回退到类型兜底',
    IC.forItem({ kind: 'book', cat_key: '__不存在的分类__' }) === IC.forItem({ kind: 'book' }),
    IC.forItem({ kind: 'book', cat_key: '__不存在的分类__' }));

  console.log('\n[UI-17] 扫码入口：内部编码与 ISBN');
  // 「没有条码的东西自动生成条码」这条需求，闭环的最后一环就是扫码入口：
  // 扫自己贴的内部编码要直接打开那条记录，扫书背的 ISBN 要按图书录入。
  // 这两条分支走错，用户扫自己贴的标签就会变成「新建一条空记录」。
  const scanBox = window.document.createElement('div');
  scanBox.innerHTML = '<div id="scanLog"></div>';
  const scanState = {};
  const origOpen = window.App.openItemEditor;
  const origConfirm = window.C.confirm;
  let openedArgs = null;
  let confirmMsg = '';
  window.App.openItemEditor = (id, preset) => {
    openedArgs = { id: id || null, preset: preset || {} };
    return Promise.resolve();
  };
  window.C.confirm = (msg) => {
    confirmMsg = msg;
    return Promise.resolve(true);
  };

  const coded = await store.handle('items.save', { name: '无条码插排', kind: 'goods', code: 'HS-2026-0001' });
  ok('造一条带内部编码的物品成功', !!(coded && coded.id && coded.code === 'HS-2026-0001'), JSON.stringify(coded));

  // 1) 扫到自己发的内部编码 → 直接打开那条记录
  openedArgs = null; confirmMsg = '';
  await window.Views._handleCode(scanBox, scanState, 'HS-2026-0001', '', '手动');
  ok('扫内部编码直接打开对应记录', !!(openedArgs && openedArgs.id === coded.id), JSON.stringify(openedArgs));
  ok('内部编码命中时不会再问「要不要新建」', !/还没有对应/.test(confirmMsg), confirmMsg);
  ok('内部编码记进了扫描日志',
    scanState.scanLog.length === 1 && scanState.scanLog[0].code === 'HS-2026-0001' && scanState.scanLog[0].matched === true,
    JSON.stringify(scanState.scanLog[0]));

  // 2) 扫到查不到的内部编码 → 问一句再用这个号新建（不是默默丢一条新记录）
  openedArgs = null; confirmMsg = '';
  await window.Views._handleCode(scanBox, scanState, 'HS-2026-8888', '', '手动');
  ok('查不到的内部编码会先问要不要新建', /还没有对应/.test(confirmMsg), confirmMsg);
  ok('确认后带着这个编码开新建表单',
    !!(openedArgs && openedArgs.id === null && openedArgs.preset.code === 'HS-2026-8888'),
    JSON.stringify(openedArgs));
  // 内部编码不是商品条码：塞进「条码」字段会让编辑器实时校验报「非数字条码」，
  // 同一条记录还会同时挂两个身份标识。
  ok('内部编码不会被同时填进「条码」字段',
    !(openedArgs.preset.barcodes || []).length && !openedArgs.preset.barcode,
    JSON.stringify(openedArgs.preset));
  ok('日志里记为未命中', scanState.scanLog[0].matched === false);

  // 3) 扫到书背 ISBN → 按图书录入，不让用户纠结「这算不算物品」
  //    用一本库里没有的书（9787532751631《设计中的设计》）
  openedArgs = null; confirmMsg = '';
  await window.Views._handleCode(scanBox, scanState, '9787532751631', '', '手动');
  ok('扫到 ISBN 会问是否按图书录入', /ISBN/.test(confirmMsg) && /图书/.test(confirmMsg), confirmMsg);
  ok('确认后按图书类型开新建表单',
    !!(openedArgs && openedArgs.id === null && openedArgs.preset.kind === 'book' && openedArgs.preset.barcode === '9787532751631'),
    JSON.stringify(openedArgs));
  ok('ISBN 写进了条码字段', !!(openedArgs.preset.barcodes || []).includes('9787532751631'));

  // 3a) 已经录过的书再扫一次 → 不能又建一条重复的
  openedArgs = null; confirmMsg = '';
  await window.Views._handleCode(scanBox, scanState, '9787111544937', '', '手动');
  ok('扫到已录过的书会提示「已属于」', /已属于/.test(confirmMsg), confirmMsg);
  ok('不会把已录过的书当成新书', !/按图书录入/.test(confirmMsg), confirmMsg);
  await Promise.resolve();
  ok('确认后打开已有的那本书', !!(openedArgs && openedArgs.id), JSON.stringify(openedArgs));
  ok('已录过的书记进了日志（matched=true）', scanState.scanLog[0].matched === true);

  // 3b) 扫到杂志封面上的期刊条码（977）→ 同样按图书录入
  openedArgs = null; confirmMsg = '';
  await window.Views._handleCode(scanBox, scanState, '9771009633018', '', '手动');
  ok('扫到期刊条码会问是否按图书录入', /ISSN/.test(confirmMsg) && /图书/.test(confirmMsg), confirmMsg);
  ok('期刊条码也按图书类型开新建表单',
    !!(openedArgs && openedArgs.preset.kind === 'book' && openedArgs.preset.barcode === '9771009633018'),
    JSON.stringify(openedArgs));

  // 4) 普通条码仍然走原来的流程，没被新分支抢走
  openedArgs = null; confirmMsg = '';
  await window.Views._handleCode(scanBox, scanState, '6901234567892', '', '手动');
  ok('已知条码仍问是否查看该物品', /已属于/.test(confirmMsg), confirmMsg);
  await Promise.resolve();
  ok('确认后打开已有的那件物品', !!(openedArgs && openedArgs.id), JSON.stringify(openedArgs));

  openedArgs = null; confirmMsg = '';
  await window.Views._handleCode(scanBox, scanState, '6909876543212', '', '手动');
  ok('全新条码直接开新建表单（不问）',
    !!(openedArgs && openedArgs.id === null && openedArgs.preset.barcode === '6909876543212' && confirmMsg === ''),
    JSON.stringify(openedArgs) + ' / ' + confirmMsg);

  window.App.openItemEditor = origOpen;
  window.C.confirm = origConfirm;

  console.log('\n[UI-17b] 扫到 ISBN 联网补全图书信息');
  // 上一段把 openItemEditor 和 confirm 都桩掉了，这里先还原 ——
  // 这一段必须走**真实的** C.form，否则验不了「结果有没有填进输入框」。
  const waitFor = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 1500)) {
      if (fn()) return true;
      await dsTick(20);
    }
    return false;
  };
  const boxField = (k) => {
    const b = dsBox();
    return b ? b.querySelector(`[data-k="${k}"]`) : null;
  };
  const closeBox = async () => {
    const b = dsBox();
    const btn = b && b.querySelector('[data-act="cancel"]');
    if (btn) btn.click();
    await dsTick(30);
  };

  // 「按图书录入吗」一律点确定
  window.C.confirm = () => Promise.resolve(true);

  // 联网查询桩：每个用例自己决定回什么，还能把返回「挂住」以便精确控制时序
  let lookupCalls = [];
  let lookupReply = null;
  let holdLookup = false;
  let releaseLookup = null;
  window.api.lookupIsbn = async (isbn) => {
    lookupCalls.push(isbn);
    if (holdLookup) await new Promise((r) => { releaseLookup = r; });
    return lookupReply;
  };

  // A) 查到 → 自动填进表单
  lookupCalls = []; holdLookup = false;
  lookupReply = {
    ok: true, source: 'openlibrary',
    book: { title: '设计中的设计', authors: ['原研哉'], publisher: '广西师范大学出版社', publishYear: 2010, pages: 240 }
  };
  await window.Views._handleCode(scanBox, scanState, '9787532751631', '', '手动');
  await waitFor(() => !!boxField('name'), 2000);
  ok('扫 ISBN 后打开了图书表单', !!boxField('name'), '');
  ok('联网查询带着 ISBN 发出去了', lookupCalls.length === 1 && lookupCalls[0] === '9787532751631',
    JSON.stringify(lookupCalls));
  await waitFor(() => boxField('name') && boxField('name').value, 1500);
  ok('书名自动填上了', boxField('name') && boxField('name').value === '设计中的设计',
    boxField('name') && boxField('name').value);
  ok('作者自动填上了', boxField('x_author') && boxField('x_author').value === '原研哉',
    boxField('x_author') && boxField('x_author').value);
  ok('出版社自动填上了', boxField('x_publisher') && boxField('x_publisher').value === '广西师范大学出版社',
    boxField('x_publisher') && boxField('x_publisher').value);
  ok('出版年自动填上了', boxField('x_pub_year') && String(boxField('x_pub_year').value) === '2010',
    boxField('x_pub_year') && boxField('x_pub_year').value);
  const hintA = dsBox() && dsBox().querySelector('#isbnLookupHint');
  ok('提示行说明了信息来源，用户知道这些字是哪来的',
    !!hintA && /Open Library/.test(hintA.textContent) && /书名/.test(hintA.textContent),
    hintA && hintA.textContent);
  ok('提示行说的是「可自行修改」，不是「已保存」之类会误导的话',
    !!hintA && /可自行修改/.test(hintA.textContent), hintA && hintA.textContent);
  await closeBox();

  // B) 用户先自己填了 → 联网结果不许覆盖
  //    这是最容易做错的一条：查询要几百毫秒，用户完全可能先动手填了书名，
  //    结果回来一把盖掉他刚打的字。
  lookupCalls = []; holdLookup = true; releaseLookup = null;
  lookupReply = {
    ok: true, source: 'openlibrary',
    book: { title: '联网给的书名', authors: ['联网给的作者'], publisher: '联网给的出版社', publishYear: 1999 }
  };
  await window.Views._handleCode(scanBox, scanState, '9780132350884', '', '手动');
  await waitFor(() => !!boxField('name'), 2000);
  boxField('name').value = '我自己敲的书名';
  ok('查询还在路上时，用户已经先填了书名', boxField('name').value === '我自己敲的书名');
  if (releaseLookup) releaseLookup();
  await dsTick(120);
  ok('联网结果不会覆盖用户已经填的字段',
    boxField('name').value === '我自己敲的书名', boxField('name').value);
  ok('但空着的字段照样会被补上（只是不覆盖，不是整个放弃）',
    boxField('x_author') && boxField('x_author').value === '联网给的作者',
    boxField('x_author') && boxField('x_author').value);
  await closeBox();

  // C) 连上了但网上没这本书
  lookupCalls = []; holdLookup = false;
  lookupReply = { ok: false, reason: 'notfound' };
  await window.Views._handleCode(scanBox, scanState, '9780132350884', '', '手动');
  await waitFor(() => !!boxField('name'), 2000);
  await dsTick(120);
  const hintC = dsBox() && dsBox().querySelector('#isbnLookupHint');
  ok('网上没这本书时说明一句（解释为什么没自动填）',
    !!hintC && /没有这本书/.test(hintC.textContent), hintC && hintC.textContent);
  ok('查不到时表单照常可用，书名不会被乱填',
    boxField('name') && boxField('name').value === '', boxField('name') && boxField('name').value);
  await closeBox();

  // D) 断网 → 安静收场，一个字都不说
  //    这是「断网必须能用」的核心：可选增强失败不能变成一条错误信息，
  //    否则用户会以为软件坏了。
  lookupCalls = []; lookupReply = { ok: false, reason: 'offline' };
  await window.Views._handleCode(scanBox, scanState, '9780132350884', '', '手动');
  await waitFor(() => !!boxField('name'), 2000);
  await dsTick(120);
  const hintD = dsBox() && dsBox().querySelector('#isbnLookupHint');
  ok('断网时提示行是空的（不报错、不吓唬用户）',
    !!hintD && hintD.textContent === '', hintD && JSON.stringify(hintD.textContent));
  ok('断网时表单照常能填能存（核心功能不受影响）',
    !!boxField('name') && !!boxField('x_author'), '');
  await closeBox();

  // E) 期刊条码（977）不该去联网查 —— 图书库里根本没有期刊
  lookupCalls = [];
  lookupReply = { ok: false, reason: 'notfound' };
  await window.Views._handleCode(scanBox, scanState, '9771009633018', '', '手动');
  await waitFor(() => !!boxField('name'), 2000);
  await dsTick(120);
  ok('期刊条码不发起联网查询（不白等一次超时）', lookupCalls.length === 0, JSON.stringify(lookupCalls));
  ok('期刊照样能按图书录入，表单里有 ISSN 字段',
    !!(boxField('barcodes') && String(boxField('barcodes').value).indexOf('9771009633018') >= 0), '');
  await closeBox();

  // F) 别端没有这个能力时（老版本 preload / 精简环境）不能崩
  const savedLookup = window.api.lookupIsbn;
  delete window.api.lookupIsbn;
  await window.Views._handleCode(scanBox, scanState, '9780132350884', '', '手动');
  await waitFor(() => !!boxField('name'), 2000);
  await dsTick(120);
  ok('没有联网能力时安静跳过（表单照常打开，不抛错）',
    !!boxField('name') && !!boxField('x_author'), '');
  window.api.lookupIsbn = savedLookup;
  await closeBox();

  window.C.confirm = origConfirm;

  console.log('\n[UI-18] CSV 导出（用户要拿去 Excel 看，不能丢字段）');
  // 这个功能之前一条测试都没有，结果三类记录的专属字段被静默丢掉了：
  // 导出一本书，Excel 里只有名字和位置，作者出版社全没了。
  await window.App.exportData('csv');
  const exp = window.__lastExport || {};
  const csvText = String(exp.content || '');
  ok('CSV 导出被调用', !!csvText, JSON.stringify(exp).slice(0, 120));
  ok('导出文件名体现了「全部记录」', /全部记录/.test(String(exp.defaultName || '')), String(exp.defaultName));
  // Excel 打开 UTF-8 CSV 必须靠 BOM 才不乱码
  ok('CSV 带 UTF-8 BOM（Excel 打开不乱码）', csvText.charCodeAt(0) === 0xfeff);

  // 带引号的最小 CSV 解析器：备注里可能有逗号，不能用 split(',') 硬切
  const parseCsv = (text) => {
    const s = text.replace(/^\ufeff/, '');
    const rows = [];
    let row = [];
    let cell = '';
    let inQ = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQ) {
        if (ch === '"') {
          if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
        } else cell += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (ch !== '\r') cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  };

  const table = parseCsv(csvText);
  const header = table[0] || [];
  const body = table.slice(1);
  const col = (name) => header.indexOf(name);

  ok('表头有「类型」列', col('类型') >= 0, header.join('|'));
  ok('表头有「内部编码」列', col('内部编码') >= 0);
  ok('表头含资料的专属字段',
    ['文件编号', '会计年度', '来文归档单位', '涉及金额', '保管期限至'].every((c) => col(c) >= 0),
    header.join('|'));
  ok('表头含图书的专属字段',
    ['作者', '出版社', '出版年', '阅读状态'].every((c) => col(c) >= 0),
    header.join('|'));
  ok('每行列数与表头一致（不会串列）',
    body.every((r) => r.length === header.length),
    `表头 ${header.length} 列，行数 ${body.map((r) => r.length).join('/')}`);

  const rowOf = (name) => body.find((r) => r[col('名称')] === name);
  const docRow = rowOf('房屋租赁合同');
  const bookRow = rowOf('深入理解计算机系统');
  const goodsRow = rowOf('海天酱油');
  ok('三类记录都出现在 CSV 里', !!(docRow && bookRow && goodsRow),
    `资料 ${!!docRow} / 图书 ${!!bookRow} / 物品 ${!!goodsRow}`);
  ok('资料行标成「资料」', docRow && docRow[col('类型')] === '资料', docRow && docRow[col('类型')]);
  ok('图书行标成「图书」', bookRow && bookRow[col('类型')] === '图书');
  ok('物品行标成「物品」', goodsRow && goodsRow[col('类型')] === '物品');
  ok('资料行带出了文件编号', docRow && docRow[col('文件编号')] === 'HT-2026-018', docRow && docRow[col('文件编号')]);
  ok('资料行带出了保管期限', docRow && docRow[col('保管期限至')] === '2031-12-31');
  ok('资料行带出了金额', docRow && docRow[col('涉及金额')] === '48000');
  ok('图书行带出了作者', bookRow && bookRow[col('作者')] === 'Bryant', bookRow && bookRow[col('作者')]);
  ok('图书行带出了出版社', bookRow && bookRow[col('出版社')] === '机械工业出版社');
  ok('图书行带出了阅读状态', bookRow && bookRow[col('阅读状态')] === '在读');
  // 资料/图书不该出现保质期数据，物品该有
  ok('资料行不填保质期字段',
    docRow && docRow[col('到期日期')] === '' && docRow[col('保质期状态')] === '');
  ok('图书行不填保质期字段', bookRow && bookRow[col('到期日期')] === '');
  ok('物品行填了到期日期', goodsRow && goodsRow[col('到期日期')] !== '', goodsRow && goodsRow[col('到期日期')]);
  ok('物品行有保质期状态', goodsRow && goodsRow[col('保质期状态')] === '已过期', goodsRow && goodsRow[col('保质期状态')]);
  ok('带内部编码的记录把编码导了出来',
    body.some((r) => /^HS-\d{4}-\d{4}$/.test(r[col('内部编码')])),
    body.map((r) => r[col('内部编码')]).filter(Boolean).join('|'));

  /* ====================================================================== *
   * [UI-19] 扫码页的生命周期
   *
   * 两个都是「手机上看不见、但一直在耗电 / 一直在捣乱」的问题：
   *
   *  1. 摄像头流泄漏：在扫码页上重新渲染（扫码后保存记录、同步完成都会触发）
   *     会把旧的 <video> 换掉，但 getUserMedia 的流不会因为元素被移除而关闭。
   *     漏一个流 = 摄像头和指示灯一直开着，再点「启动摄像头」还会失败。
   *
   *  2. 弹窗开着还在识别：摄像头一直在跑，同一条码 1.5 秒后会被再次识别，
   *     于是提示反复弹、扫描记录刷重复行、对话框被重建（点下去落空）、
   *     录入表单被下一个条码整个替换掉（正在输入的内容无声消失）。
   *
   * 这里不用桩去数「谁调用了谁」，而是造一个**真的会拒绝第二次占用**的假摄像头
   * （安卓上同一个摄像头同时只能被一个客户端打开），把整条链路跑通 ——
   * 流没关掉时，下一步的「启动摄像头」会真的失败。
   * ====================================================================== */
  console.log('\n[UI-19] 扫码页的生命周期（摄像头不能被漏掉）');

  const cam = { opened: 0, stopped: 0, live: 0 };
  function makeFakeStream() {
    const track = {
      kind: 'video',
      stop() { cam.stopped++; cam.live--; },
      getCapabilities() { return {}; },
      applyConstraints() { return Promise.resolve(); }
    };
    return { getTracks: () => [track], getVideoTracks: () => [track] };
  }
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => {
        // 摄像头已经被占着 → 像真机一样拒绝，而不是默默再给一路
        if (cam.live > 0) {
          const err = new Error('Could not start video source');
          err.name = 'NotReadableError';
          throw err;
        }
        cam.opened++;
        cam.live++;
        return makeFakeStream();
      }
    }
  });
  // jsdom 的 video 不会真的出画面，这里把「有画面」这件事伪造出来
  window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
  Object.defineProperty(window.HTMLVideoElement.prototype, 'readyState', {
    configurable: true, get: () => 4
  });
  Object.defineProperty(window.HTMLVideoElement.prototype, 'videoWidth', {
    configurable: true, get: () => 640
  });
  Object.defineProperty(window.HTMLVideoElement.prototype, 'videoHeight', {
    configurable: true, get: () => 480
  });

  // 识别器换成假的：每帧都返回同一个条码，模拟「用户扫到之后没把手机移开」
  const RealReader = window.ZXing.BrowserMultiFormatReader;
  window.ZXing.BrowserMultiFormatReader = function () {
    this.decodeFromVideoElement = async () => ({
      getText: () => '6901234567892',
      getBarcodeFormat: () => 'EAN_13'
    });
    this.reset = () => {};
  };

  window.document.getElementById('modalRoot').hidden = true;
  window.App.state.scanLog = [];
  await window.App.goto('scan');
  let sEl = window.document.getElementById('view-scan');
  ok('扫码页在假摄像头下认为可以启动',
    sEl.querySelector('#btnStartScan').disabled === false);

  sEl.querySelector('#btnStartScan').click();
  await new Promise((r) => setTimeout(r, 500));

  ok('摄像头被打开了', cam.opened === 1, '实际 ' + cam.opened);
  ok('识别到的条码进了扫描记录',
    window.App.state.scanLog.length === 1, '实际 ' + window.App.state.scanLog.length);
  ok('识别后弹出了确认框（已属于某件物品）',
    window.document.getElementById('modalRoot').hidden === false);
  // 记下按钮的节点身份：弹窗被重建时这个引用会失效（用户正好点下去的那一下会落空）
  const okBtnBefore = window.document.querySelector('#modalRoot [data-act="ok"]');
  ok('确认框里确实有「确定」按钮', !!okBtnBefore);

  // 用户没移开手机 → 1.5 秒后同一条码会被再次识别。弹窗还开着，必须忽略。
  await new Promise((r) => setTimeout(r, 2200));
  ok('弹窗开着时不再重复处理识别结果',
    window.App.state.scanLog.length === 1,
    '扫描记录被刷成了 ' + window.App.state.scanLog.length + ' 条');
  ok('弹窗没有被重建（用户要点的按钮还是原来那个）',
    !!okBtnBefore && window.document.querySelector('#modalRoot [data-act="ok"]') === okBtnBefore);

  // 关键场景：在扫码页上重新渲染 —— 扫码后保存记录就会走到这里
  const stoppedBefore = cam.stopped;
  await window.App.goto('scan');
  ok('重新渲染扫码页时会停掉上一个摄像头',
    cam.stopped > stoppedBefore,
    `停掉前 ${stoppedBefore}，停掉后 ${cam.stopped}`);
  ok('旧摄像头流确实被释放了', cam.live === 0, '还有 ' + cam.live + ' 路流活着');

  // 旧流没释放的话，这里会因为摄像头被自己占着而启动失败
  window.document.getElementById('modalRoot').hidden = true;
  sEl = window.document.getElementById('view-scan');
  sEl.querySelector('#btnStartScan').click();
  await new Promise((r) => setTimeout(r, 300));
  ok('重新渲染后还能再次启动摄像头（说明旧流已释放）',
    cam.opened === 2, '实际打开次数 ' + cam.opened);
  const st = sEl.querySelector('#scanState').textContent || '';
  ok('界面上显示的是「识别中」而不是启动失败',
    /识别中/.test(st) && !/失败/.test(st), st);

  // 收尾：停掉扫码器、还原识别器，别影响后面的用例
  if (window.App.state._stopScanner) {
    await window.App.state._stopScanner();
    window.App.state._stopScanner = null;
  }
  window.ZXing.BrowserMultiFormatReader = RealReader;
  window.document.getElementById('modalRoot').hidden = true;
  window.App.state.view = 'items';
  await window.App.goto('items');

  console.log('\n========================================');
  console.log(`  渲染层通过 ${pass} 项，失败 ${fail} 项`);
  console.log('========================================\n');

  dom.window.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
