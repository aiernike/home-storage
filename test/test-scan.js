'use strict';
/**
 * 条码识别测试
 *
 * 用代码画出真实的 EAN-13 条码，再交给识别库去认，验证「能不能认出来」。
 * 这样不用真机也能确认解码链路是通的——之前正是这条链路坏了：
 * 浏览器自带的 BarcodeDetector 在很多环境里识别不出来，而失败又被静默吞掉，
 * 表现就是「摄像头能打开，对着条码半天没反应」。
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (e ? '  → ' + e : '')); }
};

/* ------------------------------------------------------------------ *
 * EAN-13 编码：把数字变成黑白条
 * ------------------------------------------------------------------ */

// 左侧奇排列（L / A）
const L = [
  '0001101', '0011001', '0010011', '0111101', '0100011',
  '0110001', '0101111', '0111011', '0110111', '0001011'
];
// 左侧偶排列（G / B）
const G = [
  '0100111', '0110011', '0011011', '0100001', '0011101',
  '0111001', '0000101', '0010001', '0001001', '0010111'
];
// 右侧（R / C）
const R = [
  '1110010', '1100110', '1101100', '1000010', '1011100',
  '1001110', '1010000', '1000100', '1001000', '1110100'
];

// 首位数字决定左侧 6 位用哪些排列
const PARITY = [
  'LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
  'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'
];

/** 算出 EAN-13 的校验位 */
function ean13Check(d12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(d12[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return String((10 - (sum % 10)) % 10);
}

/** 把 13 位数字编成 95 个模块的 0/1 串（1 表示黑条） */
function ean13Bits(code13) {
  const d = code13.split('').map(Number);
  const parity = PARITY[d[0]];
  let bits = '101'; // 起始符
  for (let i = 1; i <= 6; i++) {
    bits += (parity[i - 1] === 'L' ? L : G)[d[i]];
  }
  bits += '01010'; // 中间分隔符
  for (let i = 7; i <= 12; i++) {
    bits += R[d[i]];
  }
  bits += '101'; // 结束符
  return bits;
}

/**
 * 画成灰度像素。返回 { data, width, height }
 *
 * 注意：ZXing 的 RGBLuminanceSource 要的是**单通道灰度**数组（1 字节一个像素），
 * 只在传入 Int32Array 时才按 RGB 打包处理。传 RGBA 会被当成 1 字节/像素，
 * 图像被横向拉窄四倍，自然什么都认不出来。
 */
function renderBarcode(code13, moduleWidth = 4, height = 120, quietModules = 10) {
  const bits = ean13Bits(code13);
  const barWidth = bits.length * moduleWidth;
  // 静区按模块数算，不能写死像素：模块越宽，需要的留白也越宽。
  // EAN-13 规范要求左右各留 9 个模块以上，少了识别率会明显下降。
  const quiet = quietModules * moduleWidth;
  const width = barWidth + quiet * 2;

  const data = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 255; // 静区是白的
      if (x >= quiet && x < quiet + barWidth) {
        v = bits[Math.floor((x - quiet) / moduleWidth)] === '1' ? 0 : 255;
      }
      data[y * width + x] = v;
    }
  }
  return { data, width, height };
}

/* ------------------------------------------------------------------ *
 * 测试
 * ------------------------------------------------------------------ */

let ZXing;
try {
  ZXing = require(path.join(ROOT, 'node_modules', '@zxing', 'library', 'cjs'));
} catch (e) {
  // ⚠️ 这里**不能静默跳过**：@zxing/library 是本套件的参照解码器，
  //    它不在的话下面所有断言会凭空消失，而退出码仍是 0（看起来"通过"）。
  //    "静默少跑测试"比"测试失败"危险得多 —— 失败至少有人会去看。
  console.error('\n[致命] 缺少 @zxing/library —— 条码识别测试无法进行。');
  console.error('       它是本套件的参照解码器，用来交叉验证 zxing.min.js 生成的条码。');
  console.error('       修复：在项目根目录执行 npm install');
  process.exit(1);
}

const {
  MultiFormatReader,
  RGBLuminanceSource,
  HybridBinarizer,
  BinaryBitmap,
  DecodeHintType,
  BarcodeFormat
} = ZXing;

function decode(bitmap, tryHarder) {
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
    BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93,
    BarcodeFormat.ITF, BarcodeFormat.CODABAR, BarcodeFormat.QR_CODE
  ]);
  if (tryHarder) hints.set(DecodeHintType.TRY_HARDER, true);
  const reader = new MultiFormatReader();
  reader.setHints(hints);
  const src = new RGBLuminanceSource(bitmap.data, bitmap.width, bitmap.height);
  return reader.decode(new BinaryBitmap(new HybridBinarizer(src)));
}

console.log('条码识别验证\n');
console.log('[SCAN-1] EAN-13 编码本身正确');
ok('校验位算法正确（690123456789 → 2）', ean13Check('690123456789') === '2', ean13Check('690123456789'));
ok('编码出 95 个模块', ean13Bits('6901234567892').length === 95, String(ean13Bits('6901234567892').length));
ok('以起始符 101 开头', ean13Bits('6901234567892').startsWith('101'));
ok('以结束符 101 结尾', ean13Bits('6901234567892').endsWith('101'));
ok('中间是分隔符 01010', ean13Bits('6901234567892').slice(45, 50) === '01010');

console.log('\n[SCAN-2] 真实条码能认出来');
// 注意：条码最后一位是校验位，不能随便编。
// 应用早期测试数据里的 6909876543210 / 6912345678901 校验位其实是错的
// （正确应分别是 ...212 和 ...902），正规识别器会拒绝，这里用算出来的合法码。
// 最后一条 6926515422011 是用户实际拍照的条码，确认这条能认。
const cases = [
  ['6901234567892', '海天酱油'],
  ['6909876543212', '伊利牛奶'],
  ['6923456789012', '五常大米'],
  ['6912345678902', '药品'],
  ['6926515422011', '用户实拍条码']
];
cases.forEach(([code, name]) => {
  const bmp = renderBarcode(code);
  try {
    const res = decode(bmp, true);
    const text = res.getText();
    ok(`识别出 ${code}（${name}）`, text === code, 'got ' + text);
  } catch (e) {
    ok(`识别出 ${code}（${name}）`, false, String((e && e.message) || e));
  }
});

console.log('\n[SCAN-3] 不同清晰度下都能认');
// 模块宽度越小越糊，2px 已经接近手机扫远景的极限
[6, 4, 3, 2].forEach((mw) => {
  const bmp = renderBarcode('6901234567892', mw);
  try {
    const res = decode(bmp);
    ok(`模块宽度 ${mw}px 时能识别`, res.getText() === '6901234567892', res.getText());
  } catch (e) {
    ok(`模块宽度 ${mw}px 时能识别`, false, String((e && e.message) || e));
  }
});

console.log('\n[SCAN-3b] 快速模式（实时扫码用的就是它）也要认得出来');
// 实时扫码为了流畅不开 TRY_HARDER，必须确认这样也能扫出来，
// 否则界面会一直「识别中」——正是这次要修的那个毛病。
['6901234567892', '6909876543212', '6923456789012', '6912345678902'].forEach((code) => {
  try {
    const res = decode(renderBarcode(code), false);
    ok(`快速模式识别出 ${code}`, res.getText() === code, res.getText());
  } catch (e) {
    ok(`快速模式识别出 ${code}`, false, String((e && e.message) || e));
  }
});

console.log('\n[SCAN-4] 没条码时不该乱认');
const blank = (() => {
  const w = 300, h = 120;
  const d = new Uint8ClampedArray(w * h);
  d.fill(255);
  return { data: d, width: w, height: h };
})();
let threw = false;
try {
  decode(blank, true);
} catch (e) {
  threw = true;
}
ok('纯白图不会误识别出条码', threw);

// 校验位不对的条码应当被拒绝，而不是硬猜一个结果出来
let wrongRejected = false;
try {
  decode(renderBarcode('6909876543210'), true); // 校验位应为 2，这里故意写成 0
} catch (e) {
  wrongRejected = true;
}
ok('校验位错误的条码不会被误认', wrongRejected);

console.log('\n[SCAN-5] 应用代码不再依赖 BarcodeDetector');
const util = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'util.js'), 'utf8');
ok('识别逻辑里不再出现 BarcodeDetector 作为主力',
  !/new window\.BarcodeDetector/.test(util),
  '还在 new window.BarcodeDetector');
ok('使用了 ZXing 解码器', /BrowserMultiFormatReader/.test(util));
ok('识别出错会上报，不再静默吞掉', /onError/.test(util) && /failures/.test(util));
ok('摄像头播放失败会报错，不再 .catch 吞掉',
  !/\.play\(\)\.catch\(\(\) => \{\}\)/.test(util),
  'play() 的失败仍被吞掉');
ok('会等画面真正出来再开始识别', /_waitForFrame/.test(util));
ok('实时识别用自家的循环，不再调用实验性的 continuous 接口',
  !/\.decodeFromVideoElementContinuously\(/.test(util),
  '还在调用 decodeFromVideoElementContinuously()');
ok('自家循环每帧先检查 readyState 和画面尺寸',
  /readyState < 2/.test(util) && /videoWidth/.test(util));
ok('自家循环有最小扫描间隔，不会把 CPU 跑满', /SCAN_INTERVAL/.test(util));

const views = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'views.js'), 'utf8');
ok('扫码页传了错误回调', /new BarcodeScanner\([\s\S]{0,300}onError|new BarcodeScanner\([\s\S]*?\n    \(msg\) =>/.test(views));

console.log('\n[SCAN-6] 识别库随包发布');
const zxingPath = path.join(ROOT, 'src', 'renderer', 'js', 'zxing.min.js');
ok('识别库已放进项目', fs.existsSync(zxingPath));
ok('识别库体积合理（<600KB）',
  fs.existsSync(zxingPath) && fs.statSync(zxingPath).size < 600 * 1024,
  fs.existsSync(zxingPath) ? String(fs.statSync(zxingPath).size) : '缺失');

const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
ok('index.html 引入了识别库', /js\/zxing\.min\.js/.test(html));

const buildMobile = fs.readFileSync(path.join(ROOT, 'mobile', 'build-mobile.js'), 'utf8');
ok('手机端打包会带上识别库', /zxing\.min\.js/.test(buildMobile));

console.log('\n[SCAN-7] 内置数据里的条码都得是合法的');
// 演示/种子数据里的条码如果校验位是随手编的，用户拿去验证或复现时会看到「无效条码」，
// 排查起来很浪费时间。这里把源码里出现的所有 13 位条码都验一遍。
const scanSrc = (file, label) => {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return [];
  const txt = fs.readFileSync(p, 'utf8');
  return [...txt.matchAll(/'(\d{13})'/g)].map((m) => ({ code: m[1], label, file }));
};
const found = [].concat(
  scanSrc(path.join('src', 'main', 'main.js'), '演示数据'),
  scanSrc(path.join('src', 'main', 'store.js'), '种子数据')
);
if (found.length === 0) {
  console.log('  SKIP  源码里没有 13 位条码');
} else {
  const bad = found.filter((x) => ean13Check(x.code.slice(0, 12)) !== x.code[12]);
  ok(`内置的 ${found.length} 个条码校验位都正确`, bad.length === 0,
    bad.map((b) => `${b.code}（${b.label}，应为 ${b.code.slice(0, 12) + ean13Check(b.code.slice(0, 12))}）`).join('；'));
}

console.log('\n[SCAN-8] 扫码能认出内部编码与 ISBN');
// 需求里的「没有条码的物品自动生成条码」，闭环最后一环就在这里：
// 生成的内部编码（HS-2026-0001）印成二维码贴上去，再扫回来必须能打开那条记录；
// 书背的 ISBN 则要按图书录入，而不是让用户纠结「这算不算物品」。
const utilSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'util.js'), 'utf8');
ok('util 提供内部编码判断', /isInternalCode\s*\(/.test(utilSrc));
ok('util 提供 ISBN 判断', /isIsbn\s*\(/.test(utilSrc));
ok('util 提供期刊条码判断', /isIssnCode\s*\(/.test(utilSrc));
ok('util 把 ISBN 与期刊条码统一成图书码', /isBookCode\s*\(/.test(utilSrc));
ok('条码类型里区分出「内部编码」', /'内部编码'/.test(utilSrc));
ok('条码类型里区分出「ISBN」', /'ISBN'/.test(utilSrc));
ok('条码类型里区分出「ISSN」', /'ISSN'/.test(utilSrc));
ok('内部编码不按条码规则报长度错误', /内部编码，无需校验位/.test(utilSrc));

const viewsSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'views.js'), 'utf8');
ok('扫码处理里判断了内部编码', /U\.isInternalCode\(code\)/.test(viewsSrc));
ok('内部编码走 items.byCode 查询', /isInternalCode[\s\S]{0,400}items\.byCode/.test(viewsSrc));
ok('扫码处理里判断了图书码（ISBN / ISSN）', /U\.isBookCode\(code\)/.test(viewsSrc));
ok('图书码按图书类型打开录入', /isBookCode[\s\S]{0,1200}kind:\s*'book'/.test(viewsSrc));
ok('扫图书码前先查有没有录过（避免重复建条）',
  /isBookCode[\s\S]{0,600}items\.byBarcode/.test(viewsSrc));
ok('普通条码流程仍然保留', /items\.byBarcode/.test(viewsSrc));
ok('手动输入框的提示已涵盖新类型', /ISBN[\s\S]{0,40}内部编码/.test(viewsSrc));

const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'app.js'), 'utf8');
ok('编辑器支持用预设的内部编码开表单', /code:\s*preset\.code/.test(appSrc));
ok('二维码标签上会印出内部编码', /qr-code/.test(appSrc) && /opts\.code/.test(appSrc));

console.log('\n========================================');
console.log(`  条码识别通过 ${pass} 项，失败 ${fail} 项`);
console.log('========================================\n');
process.exit(fail ? 1 : 0);
