'use strict';
/**
 * 二维码测试
 *
 * 关键点：不满足于「生成了个方块」，而是做**真实往返**——
 * 生成二维码 → 把 SVG 还原成模块矩阵 → 交给 ZXing 解码器认 → 断言认回来的是原文。
 * 这样才算证明「打印出来真能扫」，而不是只证明「有个图形」。
 *
 * 复用 zxing.min.js 自带的 BrowserQRCodeSvgWriter，不需要额外二维码库。
 */
const path = require('path');
const fs = require('fs');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (e ? '  → ' + e : '')); }
};

/* ---- 在 jsdom 里加载 zxing + qr.js ---- */
const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
const { window } = dom;
window.eval(fs.readFileSync(path.join(ROOT, 'src/renderer/js/zxing.min.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(ROOT, 'src/renderer/js/qr.js'), 'utf8'));
const QR = window.QR;
const Z = window.ZXing;

/* ---- 把生成的 SVG 还原成 0/1 模块矩阵 ---- */
function svgToMatrix(svgStr) {
  const doc = new JSDOM(svgStr, { contentType: 'image/svg+xml' }).window.document;
  const rects = Array.from(doc.querySelectorAll('rect')).map((r) => ({
    x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width')
  }));
  const mod = Math.min.apply(null, rects.map((r) => r.w));
  const minX = Math.min.apply(null, rects.map((r) => r.x));
  const minY = Math.min.apply(null, rects.map((r) => r.y));
  const n = Math.round((Math.max.apply(null, rects.map((r) => r.x + r.w)) - minX) / mod);
  const m = [];
  for (let i = 0; i < n; i++) m.push(new Array(n).fill(0));
  rects.forEach((r) => { m[(r.y - minY) / mod][(r.x - minX) / mod] = 1; });
  return m;
}

/* ---- 把模块矩阵栅格化，交给 ZXing 解码（和真机扫码同一条解码链路） ---- */
function decodeMatrix(matrix) {
  const n = matrix.length, S = 4, QZ = 4, W = (n + 2 * QZ) * S;
  const lum = new Uint8ClampedArray(W * W).fill(255);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!matrix[y][x]) continue;
    for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) {
      lum[((y + QZ) * S + dy) * W + (x + QZ) * S + dx] = 0;
    }
  }
  const src = new Z.RGBLuminanceSource(lum, W, W);
  const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(src));
  return new Z.QRCodeReader().decode(bmp).getText();
}

console.log('\n[QR-1] 模块与载荷格式');
ok('window.QR 已定义', !!QR);
ok('QR.svg 是函数', typeof QR.svg === 'function');
ok('QR.parse 是函数', typeof QR.parse === 'function');
ok('位置载荷格式正确', QR.locPayload('abc') === 'HOMESTORAGE:LOC:abc', QR.locPayload('abc'));
ok('物品载荷格式正确', QR.itemPayload('xyz') === 'HOMESTORAGE:ITEM:xyz', QR.itemPayload('xyz'));

console.log('\n[QR-2] 解析扫码结果');
const p1 = QR.parse('HOMESTORAGE:LOC:loc-1');
ok('位置码解析为 loc', p1 && p1.type === 'loc' && p1.id === 'loc-1', JSON.stringify(p1));
const p2 = QR.parse('HOMESTORAGE:ITEM:item-9');
ok('物品码解析为 item', p2 && p2.type === 'item' && p2.id === 'item-9', JSON.stringify(p2));
ok('前后有空格也能解析', (function () { const p = QR.parse('  HOMESTORAGE:LOC:x  '); return p && p.id === 'x'; })());
ok('大小写不敏感', (function () { const p = QR.parse('homestorage:loc:y'); return p && p.type === 'loc' && p.id === 'y'; })());
ok('普通条码不误判为二维码', QR.parse('6901234567890') === null);
ok('普通网址不误判为二维码', QR.parse('https://example.com') === null);
ok('空字符串返回 null', QR.parse('') === null);

console.log('\n[QR-3] 生成（结构）');
const svg = QR.svg('HOMESTORAGE:LOC:test-123', 200);
ok('生成的是 SVG', /^<svg[\s>]/.test(svg.trim()));
ok('SVG 带 xmlns（可当独立图片用）', svg.indexOf('xmlns="http://www.w3.org/2000/svg"') >= 0);
const rectCount = (svg.match(/<rect/g) || []).length;
ok('SVG 含足量模块方块', rectCount > 50, 'rect=' + rectCount);
ok('dataUrl 前缀正确', QR.dataUrl('HOMESTORAGE:LOC:z').indexOf('data:image/svg+xml') === 0);

console.log('\n[QR-4] 真实往返：生成 → 解码器认回来（证明能扫）');
[
  ['位置码', QR.locPayload('loc-abc-123')],
  ['物品码', QR.itemPayload('9f8e7d6c-1234-4abc-8def-000000000001')],
  ['中文内容', 'HOMESTORAGE:LOC:厨房-冰箱-冷藏室']
].forEach(([label, payload]) => {
  try {
    const back = decodeMatrix(svgToMatrix(QR.svg(payload, 240)));
    ok(label + '能解码回原文', back === payload, 'got ' + JSON.stringify(back));
    const parsed = QR.parse(back);
    ok(label + '解析出的 id 与原文一致',
      parsed && payload.slice('HOMESTORAGE:LOC:'.length) === parsed.id
        ? true
        : (parsed && payload.indexOf(parsed.id) >= 0),
      JSON.stringify(parsed));
  } catch (e) {
    ok(label + '能解码回原文', false, String(e && e.message));
  }
});

console.log('\n========================================');
console.log(`  二维码通过 ${pass} 项，失败 ${fail} 项`);
console.log('========================================\n');
process.exit(fail ? 1 : 0);
