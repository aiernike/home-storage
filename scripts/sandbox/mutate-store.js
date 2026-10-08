'use strict';
/* 变异验证（反向验证）：把 store.js 改坏，确认新加的断言会红、且只红该红的。
 * 依赖同目录的 sync-shim.js 绕过受限环境里 spawnSync=EBUSY 的限制。
 * 用法：node scripts/sandbox/mutate-store.js（从任意目录执行都行）
 */
const path = require('path');
const fs = require('fs');
const { spawnSyncShim } = require('./sync-shim.js');

const ROOT = path.join(__dirname, '..', '..');
const FILE = path.join(ROOT, 'src/main/store.js');
const orig = fs.readFileSync(FILE, 'utf8');

const MUTS = [
  {
    name: 'M1a categories.save 改名分支不 trim 名字',
    from: 'if (p.name != null) c.name = String(p.name).trim();',
    to: 'if (p.name != null) c.name = String(p.name);',
    expect: '改分类名也会去掉首尾空格'
  },
  {
    name: 'M1b categories.save 新建分支不 trim 名字',
    from: "        name: String(p.name || '').trim() || '新分类',",
    to: "        name: String(p.name || '') || '新分类',",
    expect: '新建的分类名会去掉首尾空格'
  },
  {
    name: 'M2 categories.save 改不存在时静默新建',
    from: '        if (!c) throw new Error(\'分类不存在\');',
    to: '        if (!c) { db.categories.push({ id: uid(), key: \'\', name: String(p.name || \'\'), color: \'#888780\', sort: 0, created_at: now(), updated_at: now(), deleted: false }); save(); return db.categories[db.categories.length - 1]; }',
    expect: 'categories.save 改不存在的分类会报错'
  },
  {
    name: 'M3 items.move 不真的改 location_id',
    from: '          it.location_id = p.location_id || null;\n          touch(it);\n          n++;',
    to: '          touch(it);\n          n++;',
    expect: '三件都真的挪到了新位置'
  },
  {
    name: 'M4 items.move 把不存在的 id 也算进 count',
    from: '        if (it && !it.deleted) {\n          it.location_id = p.location_id || null;\n          touch(it);\n          n++;\n        }',
    to: '        if (it && !it.deleted) {\n          it.location_id = p.location_id || null;\n          touch(it);\n        }\n        n++;',
    expect: 'items.move 跳过不存在的 id'
  }
];

let bad = 0;
MUTS.forEach((m, i) => {
  if (!orig.includes(m.from)) {
    console.log(`  ✗ ${m.name} —— 变异目标没找到（变异没生效，不能算通过）`);
    bad++;
    return;
  }
  fs.writeFileSync(FILE, orig.replace(m.from, m.to), 'utf8');
  const r = spawnSyncShim(process.execPath, ['test/test-store.js'], { cwd: ROOT });
  fs.writeFileSync(FILE, orig, 'utf8');
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.split(/\r?\n/);
  const failLine = lines.find((l) => l.trim().startsWith('FAIL'));
  const hit = lines.some((l) => l.trim().startsWith('FAIL') && l.includes(m.expect));
  const fails = lines.filter((l) => l.trim().startsWith('FAIL')).length;
  console.log(`  ${hit ? '✓' : '✗'} ${m.name}`);
  console.log(`      期望红：「${m.expect}」`);
  console.log(`      实际：${fails} 条红${failLine ? '，第一条 ' + failLine.trim() : ''}`);
  if (!hit) bad++;
});
console.log('\n' + (bad === 0 ? '变异验证通过：每条断言都咬得住' : `有 ${bad} 个变异没被抓住`));
process.exit(bad ? 1 : 0);
