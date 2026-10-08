'use strict';
// 校验部署指南中引用的配置与实际文件保持同步
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let bad = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('  PASS  ' + name);
  else {
    console.log('  FAIL  ' + name + (detail ? '  → ' + detail : ''));
    bad++;
  }
};

const guide = fs.readFileSync(path.join(ROOT, '群晖部署指南.md'), 'utf8');

console.log('\n[指南-1] 文档结构');
check('标题正确', guide.includes('# 群晖 Container Manager 部署指南'));
check('适用版本说明', guide.includes('DSM 7.2'));
check('两种方式都有', guide.includes('方式一：界面操作') && guide.includes('方式二：SSH 命令行'));
check('包含客户端连接章节', guide.includes('## 客户端连接'));
check('包含故障排查章节', guide.includes('## 故障排查'));
check('包含维护章节', guide.includes('## 日常维护'));
check('包含公网访问方案', guide.includes('Tailscale'));

console.log('\n[指南-2] 从指南中提取的 compose 配置有效性');
// 提取所有 yaml 代码块
const blocks = [...guide.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
check('指南中至少有一个 compose 配置块', blocks.length > 0, 'got ' + blocks.length);

const composeBlocks = blocks.filter((b) => b.includes('services:'));
check('找到 ' + composeBlocks.length + ' 个 compose 配置', composeBlocks.length >= 2);

composeBlocks.forEach((b, i) => {
  const no = i + 1;
  check(`配置 ${no}：包含 db 服务`, /^\s{2}db:/m.test(b));
  check(`配置 ${no}：包含 api 服务`, /^\s{2}api:/m.test(b));
  check(`配置 ${no}：包含 networks`, b.includes('networks:'));
  check(`配置 ${no}：无 tab 字符`, !b.includes('\t'));
  check(`配置 ${no}：无变量引用（群晖界面不加载 .env）`, !/\$\{[A-Z_]+\}/.test(b), (b.match(/\$\{[A-Z_]+\}/g) || []).join(','));
  check(`配置 ${no}：端口 8787 已映射`, b.includes('8787'));
  check(`配置 ${no}：有 restart 策略`, b.includes('restart: unless-stopped'));
  check(`配置 ${no}：有数据库健康检查`, b.includes('healthcheck:'));
  // 挂载路径应为群晖绝对路径
  const vols = [...b.matchAll(/^\s+- (\/\S+?):/gm)].map((m) => m[1]);
  check(`配置 ${no}：挂载路径为群晖绝对路径`, vols.every((v) => v.startsWith('/volume')), vols.join(', '));
});

console.log('\n[指南-3] 与 server 目录实际文件的一致性');
const simpleFile = fs.readFileSync(path.join(ROOT, 'server', 'synology-compose-simple.yml'), 'utf8');
const apiBlock = composeBlocks.find((b) => b.includes('node:20-alpine'));
check('指南中的 node 镜像版本与实际文件一致', simpleFile.includes('image: node:20-alpine') && !!apiBlock);
check('指南的 npm 源与实际文件一致', simpleFile.includes('registry.npmmirror.com') && apiBlock.includes('registry.npmmirror.com'));
check('指南的 postgres 版本与主配置一致',
  fs.readFileSync(path.join(ROOT, 'server', 'docker-compose.yml'), 'utf8').includes('postgres:16-alpine'));

console.log('\n[指南-4] 关键操作步骤完整性');
const mustHave = [
  ['安装 Container Manager', '套件中心'],
  ['创建数据目录', 'home-storage'],
  ['上传文件说明', 'index.js'],
  ['修改密码提示', 'POSTGRES_PASSWORD'],
  ['修改密钥提示', 'JWT_SECRET'],
  ['健康检查地址', '/api/health'],
  ['客户端连接步骤', '测试连接'],
  ['日志查看方法', 'compose logs'],
  ['备份方法', 'pg_dump'],
  ['权限修复', 'chmod'],
  ['端口冲突处理', '18787']
];
mustHave.forEach(([label, kw]) => {
  check('包含' + label, guide.includes(kw), '缺少关键字 ' + kw);
});

console.log('\n[指南-5] 危险操作的警告');
check('提醒改默认密钥', /务必|必须|一定要/.test(guide) && guide.includes('JWT_SECRET'));
check('清理用户数据有警告', guide.includes('会清空所有同步数据'));
check('公网访问有安全提醒', guide.includes('暴露到公网前务必'));

console.log('\n[指南-6] 目录创建步骤必须覆盖配置里的挂载路径');
// 这条是补上来的回归项，踩过的坑：
// 指南原来只让用户建 data 文件夹，而配置挂载的是 data/postgres，
// 群晖又不会自动创建绑定挂载的宿主目录，
// 结果构建时直接报 "Bind mount failed: ... does not exist" 中断。
const prepStart = guide.indexOf('创建数据目录');
const prepEnd = guide.indexOf('上传服务端文件', prepStart);
const prepSection = prepStart >= 0 && prepEnd > prepStart ? guide.slice(prepStart, prepEnd) : '';
check('能找到「创建数据目录」章节', prepSection.length > 0);

// 从配置里提取宿主挂载路径，取出 home-storage 之后的部分
const requiredDirs = new Set();
composeBlocks.forEach((b) => {
  [...b.matchAll(/^\s+- (\/volume\d+\/docker\/home-storage\/\S*?):/gm)].forEach((m) => {
    const rel = m[1].replace(/^\/volume\d+\/docker\/home-storage\/?/, '');
    if (rel) requiredDirs.add(rel);
  });
});
check('从配置中提取到需要预建的目录', requiredDirs.size > 0, [...requiredDirs].join(', '));

// 每个挂载路径都必须在准备阶段被明确要求创建
[...requiredDirs].forEach((dir) => {
  check(`准备阶段要求创建 ${dir}`, prepSection.includes(dir),
    `准备阶段没提到 ${dir}，用户构建时会报 Bind mount failed`);
});

check('说明了群晖不会自动创建宿主目录', /不会自动创建|不会自动建立/.test(guide));
check('给出了该错误的原始报错文本', /Bind mount failed/.test(guide));
check('故障排查里有独立条目', /### 问题：构建时报 Bind mount failed/.test(guide));
check('给出了 File Station 建目录的办法', /File Station[\s\S]{0,300}新建文件夹/.test(guide));
check('快速参考里有 mkdir 命令',
  /mkdir -p \/volume1\/docker\/home-storage\/data\/postgres/.test(guide));
check('说明了存储空间编号可能是 volume2 等', /volume2/.test(guide));

// 随项目提供的群晖配置里如果有 build: . ，指南就必须说明要上传 Dockerfile，
// 否则用户会撞上 "Cannot locate specified Dockerfile"。
// 踩过的坑：server/synology-compose.yml 用 build: .，但指南只让上传
// index.js 和 package.json，从没提过 Dockerfile。
const serverDir = path.join(ROOT, 'server');
const ymlsUsingBuild = fs
  .readdirSync(serverDir)
  .filter((f) => f.endsWith('.yml'))
  .filter((f) => /build:\s*\./.test(fs.readFileSync(path.join(serverDir, f), 'utf8')));
if (ymlsUsingBuild.length) {
  check(`使用了 build 的配置（${ymlsUsingBuild.join('、')}）需上传 Dockerfile，指南有说明`,
    /Dockerfile/.test(guide), '指南没提 Dockerfile，用户会报 Cannot locate specified Dockerfile');
  check('指南给出了该报错的原文', /Cannot locate specified Dockerfile/.test(guide));
  check('指南说明了两种配置不要混用', /不要混用/.test(guide));
} else {
  check('没有使用 build 的配置，无需说明 Dockerfile', true);
}

console.log('\n[指南-7] 登录失败次数限制要写到文档里');
// 服务端加了限流，用户却不知道「为什么密码明明是对的却登不上」，
// 会以为服务坏了。文档必须把这条讲清楚，并给出放宽的办法。
check('说明了内置的登录失败次数限制', guide.includes('登录失败次数限制'));
check('给出了限流可调参数（否则用户不知道怎么放宽）',
  guide.includes('LOGIN_MAX_FAILS') && guide.includes('LOGIN_LOCK_MS'),
  '指南没提到 LOGIN_MAX_FAILS / LOGIN_LOCK_MS');
check('提醒锁定期间正确密码也会被拒（否则用户以为服务坏了）',
  /即使密码正确也会被拒/.test(guide));
check('故障排查里有独立条目', /### 问题：提示「登录尝试次数过多」/.test(guide));
check('公网安全提醒里提到这道防线', /5 次失败锁 15 分钟/.test(guide));

console.log('\n[指南-8] 手机版网页（PWA）的部署说明要写到文档里');
// 服务端多了一个 /app/ 入口，但它要靠 public 文件夹才有内容。
// 文档不写「public 要一起传上去」，用户按老步骤部署完只会看到一个提示页，
// 而状态页上那个「手机 / 平板也能用」的入口点不开 —— 会以为是坏的。
check('有独立章节讲手机版网页', guide.includes('## 手机 / 平板不装 App 直接用（PWA）'));
check('目录里列了这一节', /\[手机 \/ 平板不装 App 直接用（PWA）\]\(#/.test(guide));
check('给出了 /app/ 地址的写法', /:8787\/app\//.test(guide));
check('说明了末尾斜杠不能省', /末尾那个 `\/` \*\*别省\*\*/.test(guide));
check('说明了要「添加到主屏幕」', guide.includes('添加到主屏幕'));
check('说明了首次打开是空的、要先去登录同步', /首次打开是\*\*空的\*\*/.test(guide));
check('提醒了局域网 http 下扫码不可用（否则用户以为坏了）',
  /局域网 `http:\/\/` 会被直接拒绝/.test(guide));
check('给出了扫码不可用时的替代做法（手动输入 / 扫码枪）',
  guide.includes('手动输入条码') && guide.includes('扫码枪'));
check('说明了 public 文件夹要一起上传',
  /`public` \*\*整个文件夹\*\*/.test(guide));
check('说明了 public 是怎么生成的',
  guide.includes('npm run build:mobile-assets'));
// 指南里提到的 npm 脚本必须真实存在。这条是踩出来的：文档里写 `npm run build:mobile`，
// 而 package.json 里实际叫 `build:mobile-assets` —— 用户照抄直接报 missing script。
// 所以不逐个盯着，而是把指南里出现的所有 `npm run xxx` 都对着 package.json 核一遍。
{
  const scripts = Object.keys(require(path.join(ROOT, 'package.json')).scripts || {});
  const mentioned = [...guide.matchAll(/npm run ([a-z0-9:_-]+)/g)].map((m) => m[1]);
  const unknown = [...new Set(mentioned)].filter((s) => scripts.indexOf(s) < 0);
  check('指南里提到的 npm 脚本都真实存在', unknown.length === 0,
    'package.json 里没有：' + unknown.join('、'));
}
check('更新代码章节也提到了 public', /如果改了手机版网页/.test(guide));
check('说明了需构建版要把 public 打进镜像',
  /`public` 是打进镜像的|public` 会被 Dockerfile 一起打进镜像/.test(guide));
check('提醒了浏览器数据不是备份（清网站数据会丢）',
  /清理「网站数据」会把本地数据一起清掉/.test(guide));

console.log('\n' + (bad ? `  ${bad} 项有问题` : '  部署指南校验通过'));
process.exit(bad ? 1 : 0);
