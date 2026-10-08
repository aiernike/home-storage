#!/usr/bin/env node
'use strict';
/**
 * 列出本地 `server/public` 与线上 PWA 的差异文件。
 *
 * 为什么需要它：改完界面或数据层之后，要知道「该往 NAS 上传哪几个文件」。
 * 全部重传一遍也行，但 16 个文件里通常只变了 1~2 个 —— 传多了容易漏，
 * 而且没法确认「传完到底生效了没有」。
 *
 * 用法：
 *   node scripts/nas-diff.js                          # 默认 http://192.168.50.191:8787
 *   node scripts/nas-diff.js 192.168.50.200:8787      # 换地址
 *   HS_NAS=http://192.168.50.191:8787 node scripts/nas-diff.js
 *
 * 退出码：0 = 比对完成（哪怕有差异）；1 = 连不上或本地目录缺失。
 *
 * ⚠️ 它只回答「哪些文件不一样」，**不回答「本地是不是最新构建」**。
 * 两边都旧的时候它一样会显示「全部一致」—— 那是假阳性。
 * 要确认本地是最新的，得重建一次产物再比：只有 `build-info.json`（时间戳）会变，
 * 其余文件哈希一字不变，才说明本地产物本来就是最新的。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const LOCAL = path.join(ROOT, 'server', 'public');

function baseUrl() {
  const raw = process.argv[2] || process.env.HS_NAS || '192.168.50.191:8787';
  const withProto = /^https?:\/\//.test(raw) ? raw : 'http://' + raw;
  return withProto.replace(/\/+$/, '') + '/app/';
}

function fetchBuf(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ status: res.statusCode });
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: 200, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
  });
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) walk(p, rel, out);
    else out.push(rel);
  }
  return out;
}

(async () => {
  if (!fs.existsSync(LOCAL)) {
    console.error('找不到本地目录：' + LOCAL + '\n（要先跑 npm run build:mobile-assets 生成）');
    process.exit(1);
  }
  const BASE = baseUrl();
  const files = walk(LOCAL, '', []);
  const same = [];
  const diff = [];
  const missing = [];

  for (const rel of files) {
    const localBuf = fs.readFileSync(path.join(LOCAL, rel));
    let r;
    try {
      r = await fetchBuf(BASE + rel);
    } catch (e) {
      missing.push(rel + '（' + e.message + '）');
      continue;
    }
    if (r.status !== 200) {
      missing.push(rel + '（HTTP ' + r.status + '）');
      continue;
    }
    if (sha(localBuf) === sha(r.buf)) same.push(rel);
    else diff.push({ rel, local: localBuf.length, remote: r.buf.length });
  }

  console.log('线上地址：' + BASE);
  console.log('本地文件：' + files.length + ' 个');
  console.log('  一致      ' + same.length);
  console.log('  需要上传  ' + diff.length);
  diff.forEach((d) => {
    console.log('    ~ ' + d.rel + '   本地 ' + d.local + 'B / 线上 ' + d.remote + 'B');
  });
  console.log('  线上取不到 ' + missing.length);
  missing.forEach((m) => console.log('    ? ' + m));

  if (missing.length && same.length === 0 && diff.length === 0) {
    console.error('\n一个文件都没取到 —— 地址对不对？服务在跑吗？');
    process.exit(1);
  }
  if (diff.length) {
    console.log('\n把这 ' + diff.length + ' 个文件覆盖到 NAS 的 public 目录即可（其余不用动）。');
  } else {
    console.log('\n线上已经是最新的。');
    console.log('（注意：这只说明两边一样。要确认「本地是最新构建」，得重建产物再比一次 ——');
    console.log('  只有 build-info.json 变、其余哈希不变，才算数。）');
  }
})().catch((e) => {
  console.error('出错：' + e.message);
  process.exit(1);
});
