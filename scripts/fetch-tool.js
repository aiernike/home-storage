// 下载 electron-builder 工具包到指定位置
// 用法: node _fetch.js <包名> <输出文件路径>
// 例:   node _fetch.js winCodeSign C:\Temp\wcs.7z
//
// 说明：这个脚本配合项目根目录的「打包.bat」使用。
// 打包 bat 会调用它下载 winCodeSign / nsis / nsis-resources 三个工具包，
// 然后用 7za 的 -snl 参数解压到 electron-builder 的缓存目录，
// 从而绕开 Windows 普通账户无法创建符号链接的限制。

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const pkg = process.argv[2];
const out = process.argv[3];

if (!pkg || !out) {
  console.error('用法: node _fetch.js <包名> <输出文件路径>');
  process.exit(1);
}

// 版本号映射：包名 → 下载目录里的完整名称
const VERSIONS = {
  winCodeSign: 'winCodeSign-2.6.0',
  nsis: 'nsis-3.0.4.1',
  'nsis-resources': 'nsis-resources-3.4.1',
};

const dirName = VERSIONS[pkg] || pkg;
const base =
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
  'https://npmmirror.com/mirrors/electron-builder-binaries/';
const url = `${base}${dirName}/${dirName}.7z`;

function download(u, depth = 0) {
  if (depth > 8) {
    console.error('重定向次数过多');
    process.exit(1);
  }
  const client = u.startsWith('https') ? https : http;
  client
    .get(u, { headers: { 'User-Agent': 'node' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        return download(next, depth + 1);
      }
      if (res.statusCode !== 200) {
        console.error('HTTP ' + res.statusCode + ' - ' + u);
        process.exit(1);
      }
      const dir = path.dirname(out);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const f = fs.createWriteStream(out);
      res.pipe(f);
      f.on('finish', () => {
        const size = fs.statSync(out).size;
        if (size < 1024) {
          console.error('下载内容过小，可能失败：' + size + ' 字节');
          process.exit(1);
        }
        console.log('下载完成 ' + (size / 1048576).toFixed(1) + ' MB');
        process.exit(0);
      });
      f.on('error', (e) => {
        console.error('写入失败: ' + e.message);
        process.exit(1);
      });
    })
    .on('error', (e) => {
      console.error('网络错误: ' + e.message);
      process.exit(1);
    });
}

download(url);
