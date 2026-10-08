'use strict';

/**
 * 应用图标绘制库
 * ---------------------------------------------------------------------------
 * 为什么单独抽一层：同一个图标现在有两个去处 —— 安卓的 mipmap（make-icon.js）
 * 和 PWA 的 icon-192/512 + apple-touch-icon（build-mobile.js 打进 server/public）。
 * 两边各画一份的话，改主色时必然只改到一处，用户会看到两个不一样的图标。
 *
 * 只用 Node 内置的 zlib 手写 PNG 编码，不引入任何图形库（保持零依赖）。
 *
 * 设计说明：背景铺满整个画布而不是留圆角，因为 Android 8 以上系统会自己按
 * 厂商形状（圆形/方形/水滴）裁剪图标，留了圆角反而会被切掉；iOS 的
 * apple-touch-icon 也是自己加圆角。中间的图形控制在画布中央 60% 范围内，
 * 任何裁剪形状都不会伤到它。
 */

const zlib = require('zlib');

// 与界面主色一致（src/renderer/css/style.css 里的 --accent）
const BG = [0x53, 0x4a, 0xb7, 0xff];
const FG = [0xff, 0xff, 0xff, 0xff];

/* ---------------- 画布 ---------------- */

function createCanvas(w, h) {
  const px = new Uint8Array(w * h * 4); // 默认全透明
  return {
    w,
    h,
    px,
    set(x, y, c, a) {
      if (x < 0 || y < 0 || x >= w || y >= h || a <= 0) return;
      const i = (y * w + x) * 4;
      const alpha = a > 1 ? 1 : a;
      const inv = 1 - alpha;
      px[i] = Math.round(c[0] * alpha + px[i] * inv);
      px[i + 1] = Math.round(c[1] * alpha + px[i + 1] * inv);
      px[i + 2] = Math.round(c[2] * alpha + px[i + 2] * inv);
      px[i + 3] = Math.round(255 * alpha + px[i + 3] * inv);
    }
  };
}

/* ---------------- 几何 ---------------- */

/** 点是否落在圆角矩形内（坐标为 0..1 的相对值） */
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  if (cx === x || cy === y) return true;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/**
 * 用 4×4 超采样把图形画上去，边缘就是平滑的。
 * 直接按像素中心判断的话，小尺寸图标（48px）边缘会有明显锯齿。
 */
function fillShape(canvas, color, test) {
  const SS = 4;
  for (let y = 0; y < canvas.h; y++) {
    for (let x = 0; x < canvas.w; x++) {
      let hit = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / canvas.w;
          const v = (y + (sy + 0.5) / SS) / canvas.h;
          if (test(u, v)) hit++;
        }
      }
      if (hit) canvas.set(x, y, color, hit / (SS * SS));
    }
  }
}

/* ---------------- PNG 编码 ---------------- */

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(canvas) {
  const { w, h, px } = canvas;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 每通道 8 位
  ihdr[9] = 6; // 颜色类型 6 = RGBA
  ihdr[10] = 0; // 压缩方式
  ihdr[11] = 0; // 过滤方式
  ihdr[12] = 0; // 非隔行

  // 每行前面加一个过滤字节（0 = 不过滤），这是 PNG 的规定
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    const rowStart = y * (w * 4 + 1);
    raw[rowStart] = 0;
    Buffer.from(px.buffer, y * w * 4, w * 4).copy(raw, rowStart + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ---------------- 图标绘制 ---------------- */

/**
 * 画一个「收纳箱」：箱体 + 箱盖 + 中间的把手。
 * 不用文字，因为矢量图形在任何尺寸下都清晰，而文字在小图标上会糊。
 */
function drawIcon(size) {
  const c = createCanvas(size, size);

  // 背景铺满整个画布（系统会自己按厂商形状裁剪）
  fillShape(c, BG, () => true);

  // 箱盖：扁一点的长条
  fillShape(c, FG, (x, y) => inRoundRect(x, y, 0.22, 0.30, 0.78, 0.395, 0.035));

  // 箱体
  fillShape(c, FG, (x, y) => inRoundRect(x, y, 0.26, 0.425, 0.74, 0.72, 0.055));

  // 把手：挖成背景色，形成「扣手」的样子
  fillShape(c, BG, (x, y) => inRoundRect(x, y, 0.44, 0.50, 0.56, 0.545, 0.02));

  return c;
}

/** 一步到位：给定边长，返回 PNG 二进制 */
function renderIcon(size) {
  return encodePNG(drawIcon(size));
}

/** 主色，供 manifest 的 theme_color / background_color 使用 */
const THEME_COLOR = '#' + BG.slice(0, 3).map((n) => n.toString(16).padStart(2, '0')).join('');

module.exports = { renderIcon, encodePNG, drawIcon, THEME_COLOR, BG, FG };
