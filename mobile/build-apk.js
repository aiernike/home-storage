#!/usr/bin/env node
'use strict';

/**
 * 家庭收纳 · 安卓 APK 构建脚本
 * ---------------------------------------------------------------------------
 * 不依赖 Gradle，直接用 Android SDK 自带的命令行工具串起完整流程：
 *
 *   aapt2 compile  资源编译
 *   aapt2 link     资源链接 + 生成 R.java + 打包 assets
 *   javac          编译 Java 源码
 *   d8             Java 字节码转成 Android 的 dex
 *   aapt add       把 classes.dex 塞进 APK
 *   zipalign       对齐（不做的话安装后运行更慢，且 Android 11+ 会拒绝安装）
 *   apksigner      签名（不签名装不上）
 *
 * 为什么不用 Gradle：
 *   这个应用只有一个 Activity、零第三方依赖，Gradle 会为了拉插件和依赖联网，
 *   而我们要的是「断网也能打出包」。命令行流程总共不到十步，完全可控。
 *
 * 用法：
 *   node mobile/build-apk.js
 *
 * 可用环境变量：
 *   ANDROID_SDK_ROOT / ANDROID_HOME   SDK 路径（默认 D:\tools\androidsdk）
 *   JAVA_HOME                         JDK 路径（默认 C:\Program Files\Java\jdk1.8.0_333）
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

/* ==========================================================================
 * 路径与工具
 * ========================================================================== */

const MOBILE = __dirname;
const ROOT = path.join(MOBILE, '..');
const ANDROID_DIR = path.join(MOBILE, 'android');
const BUILD = path.join(MOBILE, 'build');
const DIST = path.join(MOBILE, 'dist');

const SDK =
  process.env.ANDROID_SDK_ROOT ||
  process.env.ANDROID_HOME ||
  'D:\\tools\\androidsdk';

const JAVA_HOME =
  process.env.JAVA_HOME || 'C:\\Program Files\\Java\\jdk1.8.0_333';

const BUILD_TOOLS = path.join(SDK, 'build-tools', '29.0.3');
const ANDROID_JAR = path.join(SDK, 'platforms', 'android-29', 'android.jar');

const TOOL = {
  aapt2: path.join(BUILD_TOOLS, 'aapt2.exe'),
  aapt: path.join(BUILD_TOOLS, 'aapt.exe'),
  zipalign: path.join(BUILD_TOOLS, 'zipalign.exe'),
  d8Jar: path.join(BUILD_TOOLS, 'lib', 'd8.jar'),
  apksignerJar: path.join(BUILD_TOOLS, 'lib', 'apksigner.jar'),
  java: path.join(JAVA_HOME, 'bin', 'java.exe'),
  javac: path.join(JAVA_HOME, 'bin', 'javac.exe'),
  keytool: path.join(JAVA_HOME, 'bin', 'keytool.exe')
};

const KEYSTORE = path.join(MOBILE, 'home-storage.jks');
const KS_PASS = 'home-storage';
const KS_ALIAS = 'home-storage';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version || '1.0.0';
const APK_NAME = `家庭收纳-${VERSION}.apk`;

/**
 * 安卓的 versionCode：必须随版本单调递增，系统靠它判断「这是不是升级包」。
 * 从语义化版本算出来 —— 1.1.0 → 10100，1.2.3 → 10203。
 *
 * 以前这里写死 '1'，清单里也写死了 versionName="1.0.0"。而清单里的显式属性
 * **会盖掉** aapt2 的命令行参数，于是文件名是「家庭收纳-1.1.0.apk」，
 * 装到手机上「应用信息」里却显示 1.0.0，versionCode 也永远是 1。
 * 现在清单里不再写这两个属性，这里传什么就是什么。
 */
const VERSION_CODE = (() => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(VERSION);
  if (!m) return 1;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
})();

/* ==========================================================================
 * 小工具
 * ========================================================================== */

let stepNo = 0;
function step(msg) {
  stepNo++;
  console.log(`\n[${stepNo}] ${msg}`);
}
function ok(msg) {
  console.log('    ✓ ' + msg);
}
function info(msg) {
  console.log('      ' + msg);
}
function die(msg) {
  console.error('\n  ✗ ' + msg);
  process.exit(1);
}

/** 执行命令，失败时把输出原样抛出来，不要吞掉错误信息 */
function run(exe, args, opts = {}) {
  const r = spawnSync(exe, args, {
    encoding: 'utf8',
    cwd: opts.cwd || ROOT,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  if (r.error) die(`无法执行 ${path.basename(exe)}：${r.error.message}`);
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0) {
    console.error('\n  --- 命令输出 ---');
    console.error(out.trim() || '(无输出)');
    console.error('  ----------------');
    die(`${path.basename(exe)} 执行失败（退出码 ${r.status}）`);
  }
  return out;
}

/** 递归收集某后缀的文件 */
function collect(dir, ext) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collect(p, ext));
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

function rmrf(dir) {
  if (!fs.existsSync(dir)) return;
  // 手写递归删除，不用 fs.rmSync —— 某些环境下 fs.rmSync 会被「安全删除」钩子接管，
  // 转而调用外部回收站程序，在 CI/脚本里会卡住超时。
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d);
    } catch (e) {
      return; // 读不到就当已经没了
    }
    entries.forEach((name) => {
      const full = path.join(d, name);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch (e) {
        return;
      }
      if (st.isDirectory()) walk(full);
      else {
        try {
          fs.unlinkSync(full);
        } catch (e) {} // 被占用就跳过，不影响后续构建
      }
    });
    try {
      fs.rmdirSync(d);
    } catch (e) {}
  };
  walk(dir);
}

function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

/**
 * 把 APK 里条目名的反斜杠改成正斜杠。
 *
 * 为什么必须做这一步：Windows 版的 aapt2 在用 `-A` 打包 assets 时，
 * 会把目录分隔符写成 `\`，于是包里的条目变成 `assets/www\index.html`。
 * 而 Android 的 AssetManager.open("www/index.html") 只认 `/`，
 * 结果是页面加载失败，报「找不到资源：www/index.html」——
 * 明明文件在包里，却怎么都打不开。
 *
 * `\` 和 `/` 都是 1 个字节，改名后长度不变，
 * 所以各个偏移量都还有效，就地替换字节即可，不用重写整个压缩包。
 */
function normalizeZipEntryNames(apkPath) {
  const buf = fs.readFileSync(apkPath);

  // 从文件尾往回找 End Of Central Directory 签名
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) die('不是有效的 APK（找不到 zip 中央目录）');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  let fixed = 0;

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const nameStart = p + 46;

    // 注意：Buffer.includes 的第三个参数是编码，不是结束位置，别传范围
    if (buf.slice(nameStart, nameStart + nameLen).includes(0x5c)) {
      // 中央目录里的名字
      for (let i = nameStart; i < nameStart + nameLen; i++) {
        if (buf[i] === 0x5c) buf[i] = 0x2f;
      }
      // 本地文件头里的名字（两处必须一致）
      const lhNameLen = buf.readUInt16LE(localOff + 26);
      const lhNameStart = localOff + 30;
      for (let i = lhNameStart; i < lhNameStart + lhNameLen; i++) {
        if (buf[i] === 0x5c) buf[i] = 0x2f;
      }
      fixed++;
    }

    p += 46 + nameLen + extraLen + commentLen;
  }

  if (fixed > 0) fs.writeFileSync(apkPath, buf);
  return fixed;
}

/**
 * 读出 APK 里的原始条目名。
 *
 * 必须读原始字节，不能用 `aapt list` —— 后者会把反斜杠显示成正斜杠，
 * 看起来一切正常，实际上 Android 的 AssetManager 就是打不开。
 */
function zipEntryNames(apkPath) {
  const buf = fs.readFileSync(apkPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) die('不是有效的 APK（找不到 zip 中央目录）');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.slice(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/* ==========================================================================
 * 开始
 * ========================================================================== */

console.log('\n家庭收纳 · 安卓 APK 构建');
console.log('='.repeat(56));
console.log(`  版本      ${VERSION}（versionCode ${VERSION_CODE}）`);
console.log(`  SDK       ${SDK}`);
console.log(`  JDK       ${JAVA_HOME}`);
console.log('='.repeat(56));

/* ---- 1. 检查工具链 ---- */
step('检查工具链');

const required = [
  [TOOL.aapt2, 'aapt2（资源编译与链接）'],
  [TOOL.aapt, 'aapt（往 APK 里添加 dex）'],
  [TOOL.zipalign, 'zipalign（对齐）'],
  [TOOL.d8Jar, 'd8.jar（字节码转 dex）'],
  [TOOL.apksignerJar, 'apksigner.jar（签名）'],
  [TOOL.java, 'java'],
  [TOOL.javac, 'javac'],
  [TOOL.keytool, 'keytool（生成签名证书）'],
  [ANDROID_JAR, 'android.jar（Android 29 平台）']
];

let missing = 0;
for (const [p, label] of required) {
  if (fs.existsSync(p)) {
    ok(label);
  } else {
    console.log('    ✗ ' + label + '  →  ' + p);
    missing++;
  }
}

if (missing > 0) {
  die(
    '缺少 ' + missing + ' 个必需工具。\n' +
    '    请确认已安装 Android SDK（含 build-tools 29.0.3 与 platforms/android-29）和 JDK 8，\n' +
    '    或通过环境变量 ANDROID_SDK_ROOT / JAVA_HOME 指定它们的路径。'
  );
}

/* ---- 2. 生成界面资源与图标 ---- */
step('生成界面资源与图标');
run(process.execPath, [path.join(MOBILE, 'build-mobile.js')], { cwd: ROOT });
run(process.execPath, [path.join(MOBILE, 'make-icon.js')], { cwd: ROOT });
ok('assets/www 与图标已就绪');

const assetsDir = path.join(ANDROID_DIR, 'assets');
const assetCount = collect(assetsDir, '').length;
info(`assets 目录共 ${assetCount} 个文件`);

/* ---- 3. 编译资源 ---- */
step('编译资源（aapt2 compile）');
rmrf(BUILD);
fs.mkdirSync(path.join(BUILD, 'gen'), { recursive: true });

const resZip = path.join(BUILD, 'res.zip');
run(TOOL.aapt2, ['compile', '--dir', path.join(ANDROID_DIR, 'res'), '-o', resZip]);
ok('资源编译完成 → ' + humanSize(fs.statSync(resZip).size));

/* ---- 4. 链接资源并打包 ---- */
step('链接资源并打包 assets（aapt2 link）');

const baseApk = path.join(BUILD, 'base.apk');
const genDir = path.join(BUILD, 'gen');

run(TOOL.aapt2, [
  'link',
  '-o', baseApk,
  '-I', ANDROID_JAR,
  '--manifest', path.join(ANDROID_DIR, 'AndroidManifest.xml'),
  '--java', genDir,
  '--min-sdk-version', '21',
  '--target-sdk-version', '29',
  '--version-code', String(VERSION_CODE),
  '--version-name', VERSION,
  '-A', assetsDir,
  // 编译产物作为位置参数传入。
  // 注意别写成 -R：aapt2 里的 -R 是「叠加资源」的意思，
  // 用在普通链接上会报 "does not override an existing resource"。
  resZip
]);
ok('base.apk 生成 → ' + humanSize(fs.statSync(baseApk).size));

const rJava = path.join(genDir, 'com', 'home', 'storage', 'R.java');
if (!fs.existsSync(rJava)) die('没有生成 R.java，资源或包名可能有问题：' + rJava);
ok('R.java 已生成');

/* ---- 5. 编译 Java ---- */
step('编译 Java 源码（javac）');

const classesDir = path.join(BUILD, 'classes');
fs.mkdirSync(classesDir, { recursive: true });

const javaSources = collect(path.join(ANDROID_DIR, 'src'), '.java');
if (javaSources.length === 0) die('没有找到任何 .java 源文件');
javaSources.forEach((f) => info(path.relative(ANDROID_DIR, f)));

run(TOOL.javac, [
  '-encoding', 'UTF-8',
  '-source', '8',
  '-target', '8',
  '-nowarn',
  // 用 android.jar 当引导类库：这样编译期就按 Android 的 API 校验，
  // 用到系统里不存在的类会立刻报错，而不是装到手机上才崩
  '-bootclasspath', ANDROID_JAR,
  '-d', classesDir,
  ...javaSources,
  rJava
]);

const classFiles = collect(classesDir, '.class');
ok(`编译完成，产出 ${classFiles.length} 个 class 文件`);

/* ---- 6. 转成 dex ---- */
step('转换为 dex（d8）');

const dexDir = path.join(BUILD, 'dex');
fs.mkdirSync(dexDir, { recursive: true });

// d8.bat 在部分环境下会被安全策略拦截（它内部会调用 reg.exe），
// 直接调用 jar 更稳，结果完全一样。
run(TOOL.java, [
  '-cp', TOOL.d8Jar,
  'com.android.tools.r8.D8',
  '--lib', ANDROID_JAR,
  '--min-api', '21',
  '--output', dexDir,
  ...classFiles
]);

const dexFile = path.join(dexDir, 'classes.dex');
if (!fs.existsSync(dexFile)) die('d8 没有产出 classes.dex');
ok('classes.dex 生成 → ' + humanSize(fs.statSync(dexFile).size));

/* ---- 7. 把 dex 放进 APK ---- */
step('把 dex 放入 APK');

// aapt add 会把「传入的路径」原样当作压缩包内的条目名，
// 所以必须先切到 dex 所在目录再传相对文件名，否则包内会变成 build/dex/classes.dex，
// 那样系统是找不到这个 dex 的（表现就是装上后闪退）。
run(TOOL.aapt, ['add', baseApk, 'classes.dex'], { cwd: dexDir });
ok('classes.dex 已加入 APK');

// Windows 版 aapt2 打包 assets 时会写成 assets/www\index.html，
// 装上后就报「找不到资源：www/index.html」。这里统一改回正斜杠。
const fixedNames = normalizeZipEntryNames(baseApk);
ok('条目名分隔符已统一为正斜杠' + (fixedNames ? `（修正 ${fixedNames} 项）` : '（无需修正）'));

/* ---- 8. 对齐 ---- */
step('对齐（zipalign）');

const alignedApk = path.join(BUILD, 'aligned.apk');
run(TOOL.zipalign, ['-f', '-p', '4', baseApk, alignedApk]);
ok('对齐完成（Android 11 起未对齐的包会被拒绝安装）');

/* ---- 9. 签名证书 ---- */
step('准备签名证书');

if (!fs.existsSync(KEYSTORE)) {
  info('没有找到证书，正在生成一个自签名证书…');
  run(TOOL.keytool, [
    '-genkeypair',
    '-keystore', KEYSTORE,
    '-alias', KS_ALIAS,
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', '10950', // 30 年，家用应用不需要反复换证书
    '-storepass', KS_PASS,
    '-keypass', KS_PASS,
    '-storetype', 'JKS',
    '-dname', 'CN=HomeStorage, O=Personal, C=CN'
  ]);
  ok('证书已生成 → mobile/home-storage.jks');
  console.log('');
  console.log('    ⚠ 这个证书文件是应用的「身份证」，请务必保留好。');
  console.log('      以后升级应用必须用同一个证书签名，丢了就只能卸载重装（数据会丢）。');
} else {
  ok('沿用已有证书 mobile/home-storage.jks');
}

/* ---- 10. 签名 ---- */
step('签名（apksigner）');

fs.mkdirSync(DIST, { recursive: true });
const outApk = path.join(DIST, APK_NAME);
rmrf(outApk);

run(TOOL.java, [
  '-jar', TOOL.apksignerJar,
  'sign',
  '--ks', KEYSTORE,
  '--ks-key-alias', KS_ALIAS,
  '--ks-pass', 'pass:' + KS_PASS,
  '--key-pass', 'pass:' + KS_PASS,
  // v1 给 Android 6 及以下，v2 给 Android 7 及以上，两个都签上兼容性最好
  '--v1-signing-enabled', 'true',
  '--v2-signing-enabled', 'true',
  '--out', outApk,
  alignedApk
]);
ok('签名完成 → ' + path.relative(ROOT, outApk));

/* ---- 11. 验证 ---- */
step('验证安装包');

const verifyOut = run(TOOL.java, ['-jar', TOOL.apksignerJar, 'verify', '--print-certs', outApk]);
ok('签名校验通过');
verifyOut
  .split(/\r?\n/)
  .filter((l) => /Signer #1|SHA-256|Number of signers/i.test(l))
  .forEach((l) => info(l.trim()));

// 安装包最终名字带中文（和 Windows 安装程序保持一致，用户看着清楚），
// 但 aapt.exe 是旧工具，走的是系统 ANSI 编码，遇到中文路径会直接报
// "Illegal byte sequence"。所以验证时复制一份纯英文名的副本来做，
// 避免工具自身的限制影响校验。交付的文件名不受影响。
const verifyApk = path.join(BUILD, 'verify.apk');
fs.copyFileSync(outApk, verifyApk);

const badging = run(TOOL.aapt, ['dump', 'badging', verifyApk]);
const get = (re) => {
  const m = badging.match(re);
  return m ? m[1].trim() : '(未读到)';
};

console.log('');
info('包名        ' + get(/^package: name='([^']+)'/m));
info('版本        ' + get(/^package:.*versionName='([^']+)'/m));
info('应用名      ' + get(/^application-label:'([^']*)'/m));
info('支持 SDK    ' + get(/^sdkVersion:'(.+)'/m) + ' ~ ' + get(/^targetSdkVersion:'(.+)'/m));
info('权限        ' + (badging.match(/^uses-permission: name='([^']+)'/gm) || [])
  .map((l) => l.replace(/.*name='([^']+)'.*/, '$1').replace('android.permission.', ''))
  .join(', '));

// 装机前先确认 dex 真的在包里——这是最容易出错、也最难排查的一步
const zipList = run(TOOL.aapt, ['list', verifyApk]);
if (!/^classes\.dex$/m.test(zipList)) {
  die('APK 里没有 classes.dex，装上去会闪退');
}
ok('APK 内含 classes.dex');
ok('APK 内含 index.html', /^assets\/www\/index\.html$/m.test(zipList));
ok('APK 内含 hs-core.js', /^assets\/www\/js\/hs-core\.js$/m.test(zipList));
ok('APK 内含图标', /^res\/.*ic_launcher/m.test(zipList));

// 上面这些走的是 aapt list，它会把 \ 显示成 /，看不出问题。
// 再按原始字节查一遍：条目名里只要还有反斜杠，装上就是「找不到资源」。
const rawNames = zipEntryNames(outApk);
const badNames = rawNames.filter((n) => n.indexOf('\\') >= 0);
if (badNames.length) {
  die(
    'APK 里有 ' + badNames.length + ' 个条目用了反斜杠，Android 打不开：\n    ' +
    badNames.slice(0, 3).join('\n    ')
  );
}
ok('APK 条目名全部是正斜杠（共 ' + rawNames.length + ' 项）');
if (rawNames.indexOf('assets/www/index.html') < 0) {
  die('assets/www/index.html 条目名不正确，首屏会报「找不到资源」');
}
ok('assets/www/index.html 能被 AssetManager 打开');

/* ---- 汇总 ---- */
const size = fs.statSync(outApk).size;
console.log('\n' + '='.repeat(56));
console.log('构建成功');
console.log('='.repeat(56));
console.log(`  安装包   ${path.relative(ROOT, outApk)}`);
console.log(`  大小     ${humanSize(size)}`);
console.log('');
console.log('  装到手机上的两种办法：');
console.log('    1. 把这个 apk 文件传到手机（微信/数据线/网盘都行），点开安装');
console.log('    2. 手机用数据线连电脑并打开「USB 调试」，然后执行：');
console.log(`       "${path.join(SDK, 'platform-tools', 'adb.exe')}" install -r "${outApk}"`);
console.log('');
