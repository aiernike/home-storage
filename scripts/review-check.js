#!/usr/bin/env node
'use strict';
/**
 * 代码规范自检 —— 《代码规范.md》的可执行版本。
 *
 * 为什么需要它：
 *   这个项目没有 git、没有 lint，唯一的防线是测试。
 *   但有一类问题**测试抓不到**：产物忘了重建、行尾被改乱、Node API 泄漏到渲染层、
 *   写死的版本号（会让测试静默 SKIP）……它们都不表现为「测试失败」。
 *   这个脚本专查这一类。
 *
 * 用法：
 *   npm run review             # 全部检查
 *   npm run review -- --quiet  # 只打印 FAIL 和汇总
 *
 * 退出码：0 = 无 FAIL（可能有 WARN）；1 = 有 FAIL。
 *
 * 每条检查都标注了《代码规范.md》里的对应章节 —— 改规则时两边一起改。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const QUIET = process.argv.includes('--quiet');

let fail = 0;
let warn = 0;
let pass = 0;

function section(title) {
  if (!QUIET) console.log('\n' + title);
}
function ok(name) {
  pass++;
  if (!QUIET) console.log('  PASS  ' + name);
}
function bad(name, detail) {
  fail++;
  console.log('  FAIL  ' + name + (detail ? '\n         → ' + detail : ''));
}
function warnIt(name, detail) {
  warn++;
  console.log('  WARN  ' + name + (detail ? '\n         → ' + detail : ''));
}
function note(text) {
  if (!QUIET) console.log('  ' + text);
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/** 遍历目录下所有匹配的文件（跳过依赖与生成物）。 */
function walk(dir, filter, out) {
  out = out || [];
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  fs.readdirSync(abs, { withFileTypes: true }).forEach((e) => {
    if (['node_modules', 'dist', 'build', '.git', 'assets'].includes(e.name)) return;
    const rel = dir + '/' + e.name;   // 统一用正斜杠：基线表是正斜杠，Windows 上 path.join 会返回反斜杠导致比对永远不中
    if (e.isDirectory()) walk(rel, filter, out);
    else if (filter(e.name)) out.push(rel);
  });
  return out;
}

const pkg = JSON.parse(read('package.json'));

/* ==========================================================================
 * 1. 产物与源码是否同步（规范 §1.1 / §4.1）
 * ======================================================================== */
section('[1] 产物与源码同步（规范 §1.1）');
{
  const infoPath = 'server/public/build-info.json';
  if (!exists(infoPath)) {
    bad('build-info.json 存在', '先跑 npm run build:mobile-assets');
  } else {
    const info = JSON.parse(read(infoPath));
    const sources = info.sources || {};
    const stale = [];
    Object.keys(sources).forEach((rel) => {
      if (!exists(rel)) {
        stale.push(rel + '（源文件不见了）');
        return;
      }
      // ⚠️ build-mobile.js 的 hash 是 `digest('hex').slice(0, 16)` —— 只取前 16 位。
      // 这里必须跟它一致，否则永远不相等（我第一版就踩了这个，全量误报）。
      const h = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(ROOT, rel), 'utf8'), 'utf8')
        .digest('hex').slice(0, 16);
      if (h !== sources[rel]) stale.push(rel);
    });
    if (stale.length === 0) {
      ok('产物是最新的（' + Object.keys(sources).length + ' 个源文件哈希一致）');
    } else {
      bad('产物与源码一致',
        stale.length + ' 个源文件改过但没重建：\n           ' + stale.slice(0, 8).join('\n           ') +
        (stale.length > 8 ? '\n           ……还有 ' + (stale.length - 8) + ' 个' : '') +
        '\n         修：npm run build:mobile-assets');
    }
  }
}

/* ==========================================================================
 * 2. 业务代码零 Node 依赖（规范 §1.2）
 * ======================================================================== */
section('[2] 业务代码只用适配层实现了的模块（规范 §1.2）');
{
  // 白名单 = mobile/platform/01-shim.js 真的注册了的模块。
  // ⚠️ 不是「一个 require 都不许有」—— store.js 本来就 require fs/path/crypto，
  //    build-mobile.js 会按需注入对应 shim。（我第一版把规则写成了「禁止」，
  //    结果 6 条误报 —— 规范本身要贴代码，不能凭印象。）
  const WHITELIST = {
    'src/main/store.js': ['fs', 'path', 'crypto'],
    'src/main/sync.js': ['http', 'https', 'url'],
    'src/main/isbn.js': []   // 一个都不许：要保持两端可共用，http/https 由调用方注入
  };
  let violations = 0;
  Object.keys(WHITELIST).forEach((rel) => {
    if (!exists(rel)) return;
    const allow = WHITELIST[rel];
    read(rel).split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      [...line.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].forEach((m) => {
        const mod = m[1];
        if (!allow.includes(mod)) {
          violations++;
          bad('只能用适配层实现了的模块', rel + ':' + (i + 1) + '  require(\'' + mod + '\')' +
            '\n         这个文件允许的模块是：' + (allow.length ? allow.join(' / ') : '（无 —— 一个都不许）') +
            '\n         01-shim.js 没注册的模块，装到手机上会运行时报错');
        }
      });
      // 动态 require 构建脚本扫不到 → 不会注入 shim → 运行时崩
      const total = (line.match(/require\s*\(/g) || []).length;
      const literal = (line.match(/require\s*\(\s*['"][^'"]*['"]\s*\)/g) || []).length;
      if (total > literal) {
        violations++;
        bad('require 必须是字符串字面量', rel + ':' + (i + 1) + '  ' + t.slice(0, 80) +
          '\n         build-mobile.js 靠静态扫描注入 shim，动态 require 扫不到');
      }
    });
  });
  if (violations === 0) ok('store.js / sync.js / isbn.js 只用了白名单里的模块');
}

/* ==========================================================================
 * 3. 渲染层不许碰 Node / 不该有 console.log（规范 §C）
 * ======================================================================== */
section('[3] 渲染层卫生（规范 §C）');
{
  const files = walk('src/renderer', (n) => n.endsWith('.js') && !n.endsWith('.min.js'));
  const nodeApi = /(^|[^.\w])(require\(|process\.|__dirname|__filename|Buffer\.)/;
  let leaks = 0;
  let logs = 0;
  files.forEach((rel) => {
    read(rel).split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*')) return;
      if (nodeApi.test(line)) {
        leaks++;
        bad('渲染层没有 Node API', rel + ':' + (i + 1) + '  ' + t.slice(0, 90));
      }
      if (/console\.log\(/.test(line)) {
        logs++;
        warnIt('渲染层残留 console.log', rel + ':' + (i + 1) + '  ' + t.slice(0, 90));
      }
    });
  });
  if (leaks === 0) ok('渲染层没有 Node API（' + files.length + ' 个文件）');
  if (logs === 0) ok('渲染层没有 console.log');
}

/* ==========================================================================
 * 4. 两端接口形状一致：api.sync 每个方法都要包 wrapSync（规范 §1.3）
 * ======================================================================== */
section('[4] api.sync 形状一致（规范 §1.3）');
{
  const rel = 'mobile/platform/03-bootstrap.js';
  if (!exists(rel)) {
    bad('找到 mobile/platform/03-bootstrap.js', '文件不存在');
  } else {
    const src = read(rel);
    if (!/function wrapSync\s*\(/.test(src)) {
      bad('wrapSync() 存在', rel + ' 里找不到 wrapSync —— 渲染层靠 {ok,data}/{ok:false,error} 取值');
    } else {
      ok('wrapSync() 已定义');
      // 切出 `sync: { ... }` 块，逐个方法看有没有包
      const start = src.indexOf('sync: {');
      if (start < 0) {
        bad('找到 window.api 的 sync 块', '没有 sync: { ？');
      } else {
        // 从 sync: { 开始做括号配平
        let depth = 0;
        let end = -1;
        for (let i = src.indexOf('{', start); i < src.length; i++) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') {
            depth--;
            if (depth === 0) { end = i; break; }
          }
        }
        const block = src.slice(start, end + 1);
        // 抓 `名字: function` 到下一个同级键之间的片段
        const methods = [];
        const re = /(\w+)\s*:\s*function\s*\(/g;
        let m;
        while ((m = re.exec(block))) methods.push({ name: m[1], at: m.index });
        let unwrapped = [];
        methods.forEach((meth, idx) => {
          const seg = block.slice(meth.at, idx + 1 < methods.length ? methods[idx + 1].at : block.length);
          if (!/wrapSync\s*\(/.test(seg)) unwrapped.push(meth.name);
        });
        if (methods.length === 0) {
          warnIt('解析 sync 块里的方法', '一个都没抓到，脚本可能跟不上代码结构了');
        } else if (unwrapped.length) {
          bad('api.sync 每个方法都包了 wrapSync',
            '没包的方法：' + unwrapped.join(', ') +
            '\n         渲染层按 r.ok / r.data / r.error 取值，不包就是「点了没反应」');
        } else {
          ok('api.sync 的 ' + methods.length + ' 个方法都包了 wrapSync（' + methods.map((x) => x.name).join(', ') + '）');
        }
      }
    }
  }
}

/* ==========================================================================
 * 5. 行尾一致性（规范 §二 · 行尾）
 * ======================================================================== */
section('[5] 行尾（规范 §二 · 行尾）');
{
  // ⚠️ 改这份基线要同步改《代码规范.md》第二节的表格。
  const CRLF_BASELINE = [
    'src/renderer/js/app.js',
    'README.md',
    'Windows11使用指南.md',
    '安卓手机使用指南.md'
  ];
  const files = [
    ...walk('src', (n) => /\.(js|css|html)$/.test(n) && !n.endsWith('.min.js')),
    ...walk('mobile/platform', (n) => /\.(js|css)$/.test(n)),
    ...walk('test', (n) => n.endsWith('.js')),
    ...walk('scripts', (n) => n.endsWith('.js')),
    // ⚠️ 基线文件必须显式加进来 —— 它们是 .md，走不到上面按扩展名的 walk。
    //    漏掉的话「基线仍是 CRLF」这条检查实际只覆盖了 app.js（假绿，变异验证抓到的）。
    ...CRLF_BASELINE,
    'server/index.js',
    'package.json',
    '代码规范.md',
    '工程实践参考.md',
    '群晖部署指南.md'
  ].filter(exists);

  const missingBaseline = CRLF_BASELINE.filter((f) => !exists(f));
  if (missingBaseline.length) {
    bad('基线文件都还在', '不见了：' + missingBaseline.join(', ') +
      '\n         （不存在就查不到行尾，这条检查会静默少覆盖一个文件）');
  }

  const mixed = [];
  const flipped = [];
  const extraCrlf = [];
  files.forEach((rel) => {
    const b = fs.readFileSync(path.join(ROOT, rel));
    let crlf = 0;
    let lf = 0;
    for (let i = 0; i < b.length; i++) {
      if (b[i] === 10) { if (b[i - 1] === 13) crlf++; else lf++; }
    }
    const isCrlf = crlf > 0 && lf === 0;
    if (crlf > 0 && lf > 0) mixed.push(rel + '（CRLF ' + crlf + ' / LF ' + lf + '）');
    const shouldBeCrlf = CRLF_BASELINE.includes(rel);
    if (shouldBeCrlf && !isCrlf && lf > 0) flipped.push(rel + '（应为 CRLF，实际 LF）');
    if (!shouldBeCrlf && isCrlf && !CRLF_BASELINE.includes(rel)) extraCrlf.push(rel);
  });

  if (mixed.length === 0) ok('没有文件混用行尾（' + files.length + ' 个文件）');
  else bad('行尾不混用', mixed.join('\n           '));

  if (flipped.length === 0) ok('基线里的 ' + CRLF_BASELINE.length + ' 个 CRLF 文件仍是 CRLF');
  else bad('基线 CRLF 文件没被转成 LF', flipped.join('\n           ') +
    '\n         整体转行尾会让 diff 显示「全文都改了」，真实改动被淹没');

  if (extraCrlf.length === 0) ok('基线之外的文件都是 LF');
  else warnIt('这些文件用了 CRLF（基线之外）', extraCrlf.join(', ') + '\n         不是错，但和多数文件不一致；新建文档建议用 LF');

  // ---- .gitattributes 与基线必须一致 ----
  // Windows 版 Git 默认 core.autocrlf=true，检出时会把所有 LF 文件转成 CRLF。
  // .gitattributes 里的 eol 属性优先级更高，是唯一能压住它的东西 ——
  // 所以这份文件和 CRLF_BASELINE 是同一份知识的两个副本，漂移了本地看不出来，
  // 只有别人克隆下来才会发现行尾全乱。
  if (!exists('.gitattributes')) {
    warnIt('没有 .gitattributes',
      'core.autocrlf=true 的机器上检出会把所有 LF 文件变成 CRLF，行尾基线当场失效');
  } else {
    const declared = read('.gitattributes').split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith('#'))
      .filter((l) => /\beol=crlf\b/.test(l))
      .map((l) => l.trim().split(/\s+/)[0])
      .sort();
    const expected = [...CRLF_BASELINE].sort();
    if (JSON.stringify(declared) === JSON.stringify(expected)) {
      ok('.gitattributes 声明的 CRLF 文件与基线一致（' + declared.length + ' 个）');
    } else {
      bad('.gitattributes 与行尾基线不一致',
        '声明：' + declared.join(', ') +
        '\n         基线：' + expected.join(', ') +
        '\n         两处必须一致 —— 只改一边，别人克隆下来行尾就乱了');
    }
  }
}

/* ==========================================================================
 * 6. 没有写死的版本号 / 产物路径（规范 §3.3）
 * ======================================================================== */
section('[6] 没有写死的版本号（规范 §3.3）');
{
  const V = pkg.version;
  const files = [
    ...walk('test', (n) => n.endsWith('.js')),
    ...walk('scripts', (n) => n.endsWith('.js')),
    ...walk('src', (n) => n.endsWith('.js') && !n.endsWith('.min.js')),
    ...walk('mobile', (n) => n.endsWith('.js') && !/assets|dist/.test(n))
  ].filter(exists);

  const hits = [];
  files.forEach((rel) => {
    read(rel).split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      // 注释里举例说明不算「写死」（比如 test-packaging.js 里那条解释为什么不该写死的注释）
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      // 只抓「产物文件名里写死的版本号」—— 这是会让测试静默 SKIP 的那种
      const m = line.match(/家庭收纳[^\s'"`]*?(\d+\.\d+\.\d+)\.(apk|exe)/);
      if (m) hits.push(rel + ':' + (i + 1) + '  写死了 ' + m[1] + '（当前 ' + V + '）  ' + t.slice(0, 70));
    });
  });
  if (hits.length === 0) ok('源码与测试里没有写死的产物版本号');
  else bad('产物路径从 package.json 读版本号', hits.join('\n           ') +
    '\n         写死的话，升版本后文件找不到 → 那几条检查会**静默 SKIP**（不是失败！）');

  // 安卓清单里写死 versionCode / versionName 会「盖掉」aapt2 的命令行参数，
  // 表现为「apk 文件名叫家庭收纳-1.1.0.apk、装到手机上应用信息里却显示 1.0.0」。
  // 版本号只该有根 package.json 一个源头（规范 §1.16）。
  const manifestRel = 'mobile/android/AndroidManifest.xml';
  if (exists(manifestRel)) {
    const mf = read(manifestRel);
    const hard = [];
    if (/android:versionCode\s*=/.test(mf)) hard.push('android:versionCode');
    if (/android:versionName\s*=/.test(mf)) hard.push('android:versionName');
    if (hard.length) {
      bad('安卓清单里没有写死的版本号',
        manifestRel + ' 里有 ' + hard.join(' / ') +
        '\n         清单里的显式属性会盖掉 aapt2 的版本参数，' +
        '\n         结果是「apk 文件名叫 x.y.z、应用信息里显示的是另一个版本」。');
    } else {
      ok('安卓清单里没有写死的版本号（不会盖掉构建传的版本号）');
    }
  }

  // 顺带确认文档里的产物名与当前版本一致（test-packaging 也查，这里给个即时反馈）
  const docs = ['README.md', 'Windows11使用指南.md', '安卓手机使用指南.md'].filter(exists);
  const docBad = [];
  let docCount = 0;
  docs.forEach((rel) => {
    const txt = read(rel);
    [...txt.matchAll(/家庭收纳[^\s'"`]*?(\d+\.\d+\.\d+)\.(apk|exe)/g)].forEach((m) => {
      docCount++;
      if (m[1] !== V) docBad.push(rel + '：' + m[0] + '（应为 ' + V + '）');
    });
  });
  if (docCount === 0) warnIt('文档里提到了产物名', '三份文档里一个都没找到');
  else if (docBad.length === 0) ok('三份文档里的产物名与 package.json 一致（' + docCount + ' 处）');
  else bad('文档里的产物名版本号一致', docBad.join('\n           '));
}

/* ==========================================================================
 * 7. 每个 action 都有测试覆盖（规范 §B）
 * ======================================================================== */
section('[7] store 的 action 覆盖率（规范 §B）');
{
  const src = read('src/main/store.js');
  const table = src.slice(src.indexOf('const actions = {'));
  // ⚠️ 名字里可能有**不止一个点**（app.settings.set / app.settings.get）。
  //    原来写成 [a-z]+\.[a-zA-Z]+ 只认一个点，那两个 action 直接被漏掉，
  //    于是「全部 N 个 action 都有测试引用」是假绿 —— 数量本身就少算了 2 个。
  const names = [...new Set([...table.matchAll(/^\s{4}'([a-z]+(?:\.[a-zA-Z]+)+)':/gm)].map((m) => m[1]))];

  const tests = walk('test', (n) => n.endsWith('.js')).map((rel) => read(rel)).join('\n');
  const untested = names.filter((a) => !tests.includes("'" + a + "'") && !tests.includes('"' + a + '"'));

  if (names.length === 0) {
    warnIt('解析 actions 表', '一个 action 都没抓到，脚本可能跟不上代码结构了');
  } else if (untested.length === 0) {
    ok('全部 ' + names.length + ' 个 action 都有测试引用');
  } else {
    warnIt(untested.length + '/' + names.length + ' 个 action 在测试里找不到引用',
      untested.join(', ') + '\n         可能是：新加的没测 / 只测了别的入口（如界面层）。自己确认一下');
  }
}

/* ==========================================================================
 * 8. 杂项：BOM、TODO（规范 §A）
 * ======================================================================== */
section('[8] 杂项（规范 §A）');
{
  const files = [
    ...walk('src', (n) => /\.(js|css|html)$/.test(n) && !n.endsWith('.min.js')),
    ...walk('mobile/platform', (n) => /\.(js|css)$/.test(n)),
    ...walk('test', (n) => n.endsWith('.js')),
    ...walk('scripts', (n) => n.endsWith('.js')),
    'server/index.js'
  ].filter(exists);

  const bom = files.filter((rel) => {
    const b = fs.readFileSync(path.join(ROOT, rel));
    return b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF;
  });
  if (bom.length === 0) ok('没有文件带 BOM 头');
  else warnIt('这些文件带 BOM 头', bom.join(', '));

  const todos = [];
  files.forEach((rel) => {
    if (rel === 'scripts/review-check.js') return;   // 别扫自己 —— 检测用的正则里就有这几个词
    read(rel).split(/\r?\n/).forEach((line, i) => {
      if (/\b(TODO|FIXME|XXX)\b/.test(line)) todos.push(rel + ':' + (i + 1) + '  ' + line.trim().slice(0, 80));
    });
  });
  if (todos.length === 0) ok('没有 TODO / FIXME 残留');
  else warnIt(todos.length + ' 处 TODO / FIXME', todos.slice(0, 10).join('\n           ') +
    (todos.length > 10 ? '\n           ……还有 ' + (todos.length - 10) + ' 处' : ''));
}

/* ==========================================================================
 * 9. 注入型测试代码的转义（规范 §C）
 * ======================================================================== */
section('[9] 注入型测试代码的转义（规范 §C）');
{
  const rel = 'test/mobile-ui-main.js';
  if (!exists(rel)) {
    warnIt('找到 ' + rel, '文件不存在，跳过');
  } else {
    const src = read(rel);
    // PROBE 是一整块模板字符串，会被注入到浏览器里执行。
    // 里面的注释如果出现反引号、或者「美元符号 + 左花括号」那种插值写法，
    // 会**提前结束模板字符串** → 后面的内容被当成 JS 解析 → 主进程 SyntaxError 崩掉，
    // 而且报错行号指向一个看起来毫无问题的注释行（极难定位）。
    // 真踩过：写注释提醒「别用反引号」，顺手在注释里写了反引号，把测试搞崩了。
    const start = src.indexOf('const PROBE = `');
    const end = src.indexOf('})()`;', start);
    if (start < 0 || end < 0) {
      warnIt('定位 PROBE 字符串', '找不到 const PROBE = ` … })()`; 的结构，脚本该更新了');
    } else {
      const body = src.slice(start + 15, end);
      const lineOf = (idx) => src.slice(0, start + 15 + idx).split('\n').length;
      const ticks = [...body.matchAll(/`/g)];
      const holes = [...body.matchAll(/\$\{/g)];
      if (ticks.length === 0 && holes.length === 0) {
        ok('PROBE 字符串里没有裸反引号 / 插值（' + body.length + ' 字符）');
      } else {
        const hits = []
          .concat(ticks.map((m) => '第 ' + lineOf(m.index) + ' 行：反引号'))
          .concat(holes.map((m) => '第 ' + lineOf(m.index) + ' 行：美元符号+左花括号'));
        bad('PROBE 字符串里不能有裸反引号 / 插值', hits.join('\n           ') +
          '\n         PROBE 是注入到浏览器执行的模板字符串，这两样都会提前结束它 →\n' +
          '         主进程 SyntaxError 崩掉，报错行号还指向无关位置。引用选择器请用「」包起来');
      }
    }

    /**
     * ⚠️ 上面那条只盯 PROBE —— 但这个文件里还有二十多处**内联**的注入模板：
     *   win.webContents.executeJavaScript(`...`)
     * 它们有一模一样的风险，却完全没有护栏。真踩过第二次：
     * 在一个新加的探针注释里写了反引号（引用一条 CSS 规则），
     * PROBE 那条检查照样 PASS，而 electron 一启动就弹 SyntaxError。
     * 所以这里把**所有**内联模板都扫一遍。
     */
    const inline = [];
    const re = /executeJavaScript\(\s*`/g;
    let m;
    let scanned = 0;
    while ((m = re.exec(src))) {
      const bodyStart = m.index + m[0].length;
      const close = src.indexOf('`)', bodyStart);
      if (close < 0) {
        inline.push('第 ' + src.slice(0, bodyStart).split('\n').length + ' 行：找不到模板结束符（`)）');
        break;
      }
      scanned++;
      const body = src.slice(bodyStart, close);
      const lines = body.split('\n');
      const lineOf = (idx) => src.slice(0, bodyStart + idx).split('\n').length;
      // 反引号：只要出现就一定提前结束模板，无条件报
      [...body.matchAll(/`/g)].forEach((t) => inline.push('第 ' + lineOf(t.index) + ' 行：反引号'));
      // ⚠️「美元符号 + 左花括号」只在**注释里**才算 bug。
      //    模板体里合法地用插值是很正常的（例如 executeJavaScript 里传 `App.goto('…')` 的变量），
      //    第一版把这类也报了出来 —— 2 处误报，规则本身写错了。
      //    注释里的插值一样会被求值：变量在 Node 侧不存在就 ReferenceError，所以必须报。
      lines.forEach((ln, i) => {
        const t = ln.trim();
        if (!t.startsWith('//') && !t.startsWith('*')) return;
        if (t.includes('${')) {
          inline.push('第 ' + (src.slice(0, bodyStart).split('\n').length + i) + ' 行：注释里的美元符号+左花括号');
        }
      });
    }
    if (scanned === 0) {
      warnIt('扫描内联注入模板', '一处 executeJavaScript(`…`) 都没抓到，脚本可能跟不上代码结构了');
    } else if (inline.length === 0) {
      ok('另外 ' + scanned + ' 处内联注入模板也干净');
    } else {
      bad('内联注入模板里不能有裸反引号 / 插值', inline.join('\n           ') +
        '\n         这些也是注入到浏览器执行的模板字符串，同样会提前结束 →\n' +
        '         主进程 SyntaxError 崩掉（报错行号指向无关的注释行）。引用选择器请用「」包起来');
    }
  }
}

/* ==========================================================================
 * 10. 设计令牌（规范 §二 · 设计令牌）
 * ======================================================================== */
section('[10] 设计令牌（规范 §二 · 设计令牌）');
{
  const cssRel = 'src/renderer/css/style.css';
  const mobileCssRel = 'mobile/platform/02-mobile.css';
  const NEED = ['--fs-xs', '--fs-sm', '--fs-md', '--fs-lg', '--fs-xl', '--fs-2xl',
    '--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-5'];
  const css = read(cssRel);
  const rootBlock = css.slice(0, css.indexOf('}'));
  const missing = NEED.filter((k) => !new RegExp(k + '\\s*:').test(rootBlock));
  if (missing.length === 0) {
    ok(':root 里 ' + NEED.length + ' 个设计令牌都在');
  } else {
    bad('设计令牌定义齐全', '缺：' + missing.join(', ') +
      '\n         令牌是「新样式不用再猜该写 12 还是 13」的唯一依据，缺了等于没有');
  }

  /**
   * 硬编码字号的**棘轮**。
   *
   * 方案 F 的执行策略是渐进式的：新写的样式一律用 var(--fs-*)，
   * 旧的在改到那一块时顺手换 —— 一次性重写 500 多行 CSS 风险太高。
   * 所以这里盯的不是「必须为 0」，而是「**不许变多**」：数字只许往下走。
   *
   * ⚠️ 真需要新增硬编码字号时，先想清楚能不能并到最近的一档；
   *    确有必要再调大基线，并在这里补一句为什么。
   */
  const FS_BASELINE = 62;   // 方案 F 落地时的存量：style.css 51 + 02-mobile.css 11
  let hard = 0;
  let tok = 0;
  const offenders = [];
  [cssRel, mobileCssRel].filter(exists).forEach((rel) => {
    const src = read(rel);
    tok += (src.match(/font-size:\s*var\(--fs-/g) || []).length;
    src.split(/\r?\n/).forEach((line, i) => {
      const m = line.match(/font-size:\s*([^;]+);/);
      if (!m) return;
      const val = m[1].trim();
      if (/^[\d.]+px$/.test(val)) offenders.push(rel + ':' + (i + 1) + '  font-size: ' + val);
    });
  });
  hard = offenders.length;
  if (hard <= FS_BASELINE) {
    ok('硬编码字号没有变多（' + hard + ' / 基线 ' + FS_BASELINE + '，已改用令牌 ' + tok + ' 处）');
  } else {
    bad('新增样式要用字号令牌', '硬编码字号 ' + hard + ' 处，超过基线 ' + FS_BASELINE + '：\n           ' +
      offenders.slice(FS_BASELINE).join('\n           ') +
      '\n         新样式请用 var(--fs-xs / sm / md / lg / xl / 2xl)；' +
      '\n         确有必要再调大 FS_BASELINE，并在注释里说明原因');
  }
}

/* ==========================================================================
 * 汇总
 * ======================================================================== */
console.log('\n' + '─'.repeat(58));
console.log('规范自检：' + pass + ' 项通过，' + fail + ' 项失败，' + warn + ' 项提示');
if (fail > 0) {
  console.log('详见《代码规范.md》对应章节。');
  process.exit(1);
}
if (warn > 0) console.log('提示项不阻塞，自己判断要不要处理。');
else console.log('全部通过。');
process.exit(0);
