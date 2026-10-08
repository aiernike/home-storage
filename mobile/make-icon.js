#!/usr/bin/env node
'use strict';

/**
 * 生成安卓应用图标
 * ---------------------------------------------------------------------------
 * 为什么不放一堆现成的 png 进来：这样图标能跟着配色变量走，
 * 以后想换主色改一个常量重新生成即可，不用去找设计文件。
 *
 * 绘制与 PNG 编码都在 icon-lib.js 里 —— PWA 的 icon-192/512 与
 * apple-touch-icon 也用同一份代码，避免两边各画一份以后改了主色只改到一处。
 */

const fs = require('fs');
const path = require('path');
const { renderIcon } = require('./icon-lib');

const OUT_ROOT = path.join(__dirname, 'android', 'res');

const DENSITIES = [
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192]
];

console.log('\n生成安卓应用图标');
console.log('='.repeat(50));

for (const [dir, size] of DENSITIES) {
  const outDir = path.join(OUT_ROOT, dir);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'ic_launcher.png');
  const png = renderIcon(size);
  fs.writeFileSync(file, png);
  console.log(`  ✓ ${dir}/ic_launcher.png  ${size}×${size}  ${(png.length / 1024).toFixed(1)} KB`);
}

console.log('='.repeat(50));
console.log('图标生成完成。\n');
