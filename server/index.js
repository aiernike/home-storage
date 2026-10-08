'use strict';

/**
 * 家庭收纳同步服务端
 * 部署在 NAS 的 Docker 中，为多个客户端提供数据集中存储与增量同步
 *
 * 环境变量：
 *   PORT          服务端口，默认 8787
 *   DB_HOST       数据库主机，默认 db
 *   DB_PORT       数据库端口，默认 5432
 *   DB_NAME       数据库名，默认 homestorage
 *   DB_USER       数据库用户，默认 home
 *   DB_PASSWORD   数据库密码
 *   JWT_SECRET    令牌签名密钥
 *   ALLOW_REGISTER 是否允许注册新账号，默认 true
 *   LOGIN_MAX_FAILS   同一账号连续登录失败多少次后锁定，默认 5
 *   LOGIN_WINDOW_MS   失败计数的统计窗口（毫秒），默认 15 分钟
 *   LOGIN_LOCK_MS     锁定时长（毫秒），默认 15 分钟
 *   REGISTER_MAX      同一来源在窗口内最多注册几个账号，默认 10
 *   REGISTER_WINDOW_MS 注册计数的统计窗口与锁定时长（毫秒），默认 1 小时
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const VERSION = '1.0.0';
const PORT = Number(process.env.PORT || 8787);
const ALLOW_REGISTER = String(process.env.ALLOW_REGISTER || 'true') !== 'false';
const JWT_SECRET = process.env.JWT_SECRET || 'home-storage-change-me';

// 一次拉取最多返回多少条。必须有上限：图片全图是 base64，几万条一次返回会把内存撑爆。
// 但**截断时必须告诉客户端**（见 /api/sync 的 truncated / pullTo）——
// 否则客户端会把同步进度推到当前时间，没拉到的记录就永远拉不到了。
// 做成可配置，测试里用一个小值就能覆盖「记录多到需要分几次拉」这条路径。
const PULL_LIMIT = Math.max(1, Number(process.env.PULL_LIMIT) || 20000);

// ---------------- 登录 / 注册频次限制 ----------------
// 这是个暴露在局域网（不少人还会通过群晖反向代理挂到公网）上的接口。
// 早先 /api/login 没有任何失败计数：拿一份字典就能无限次猜密码，而且每猜一次
// 服务端都要跑一遍 scrypt（本来就慢），撞库与拒绝服务两个风险叠在一起。
// 这里用内存计数——本项目就是单实例运行，重启即清零，对家庭自用足够。
const LOGIN_MAX_FAILS = Math.max(1, Number(process.env.LOGIN_MAX_FAILS) || 5);
const LOGIN_WINDOW_MS = Math.max(1000, Number(process.env.LOGIN_WINDOW_MS) || 15 * 60 * 1000);
const LOGIN_LOCK_MS = Math.max(1000, Number(process.env.LOGIN_LOCK_MS) || 15 * 60 * 1000);
const REGISTER_MAX = Math.max(1, Number(process.env.REGISTER_MAX) || 10);
const REGISTER_WINDOW_MS = Math.max(1000, Number(process.env.REGISTER_WINDOW_MS) || 60 * 60 * 1000);

/** key -> { count, firstAt, lastAt, lockUntil } */
const attempts = new Map();

/** 还要等多少秒才能再试；0 表示没被锁 */
function lockRemaining(key) {
  const rec = attempts.get(key);
  if (!rec || !rec.lockUntil) return 0;
  const left = rec.lockUntil - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/**
 * 记一次「不成功的尝试」，达到上限就把这个 key 锁住。
 * 窗口过期后计数重新开始——否则「每天错一次」也会慢慢攒到锁定，
 * 正常用户会被自己半个月前的失误关在门外。
 */
function noteHit(key, max, windowMs, lockMs) {
  const now = Date.now();
  let rec = attempts.get(key);
  if (!rec || now - rec.firstAt > windowMs) rec = { count: 0, firstAt: now, lockUntil: 0 };
  rec.count += 1;
  rec.lastAt = now;
  if (rec.count >= max) rec.lockUntil = now + lockMs;
  attempts.set(key, rec);
  return rec;
}

/** 记一次成功：清掉该 key 的失败计数，别让正常用户被自己的历史失败拖住 */
function clearHits(key) {
  attempts.delete(key);
}

/** 回收过期条目：否则用随机账号名就能把这张 Map 撑爆 */
function pruneAttempts() {
  const now = Date.now();
  const ttl = Math.max(LOGIN_WINDOW_MS, LOGIN_LOCK_MS, REGISTER_WINDOW_MS);
  for (const [k, rec] of attempts) {
    const locked = rec.lockUntil && rec.lockUntil > now;
    if (!locked && now - (rec.lastAt || rec.firstAt) > ttl) attempts.delete(k);
  }
}
// unref：别让这个定时器把进程钉住（测试跑完要能自己退出）
setInterval(pruneAttempts, 5 * 60 * 1000).unref();

/** 请求来源地址。群晖反向代理会带 X-Forwarded-For，没有就退回套接字地址 */
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** 统一的 429 响应，带上 Retry-After（标准客户端会据此退避） */
function sendTooMany(res, retryAfter, action) {
  const mins = Math.max(1, Math.ceil(retryAfter / 60));
  return send(res, 429, {
    error: `${action}尝试次数过多，请 ${mins} 分钟后再试`,
    retryAfter
  }, { 'Retry-After': String(retryAfter) });
}

const DB = {
  host: process.env.DB_HOST || 'db',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'homestorage',
  user: process.env.DB_USER || 'home',
  password: process.env.DB_PASSWORD || 'home123456'
};

// 启动时检查危险配置，避免用户用默认弱密钥把服务暴露在网络上
function checkSecurity() {
  const warns = [];
  if (JWT_SECRET === 'home-storage-change-me') {
    warns.push('JWT_SECRET 仍是默认值，任何人都能伪造登录令牌');
  }
  if (JWT_SECRET.length < 16) {
    warns.push('JWT_SECRET 太短，建议至少 32 位随机字符');
  }
  if (DB.password === 'home123456') {
    warns.push('数据库密码仍是默认值');
  }
  if (warns.length) {
    console.warn('');
    console.warn('  ┌─────────────────────────────────────────────────┐');
    console.warn('  │  安全提醒                                       │');
    console.warn('  └─────────────────────────────────────────────────┘');
    warns.forEach((w) => console.warn('   · ' + w));
    console.warn('');
    console.warn('   局域网自用可以先忽略；若通过公网访问，请务必修改。');
    console.warn('   编辑同目录下的 .env 文件后重启服务即可。');
    console.warn('');
  }
}

let pool = null;

// ---------------- 简易 JWT（HS256）实现，避免额外依赖 ----------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payload, expiresSec = 60 * 60 * 24 * 90) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = Object.assign({ iat: now, exp: now + expiresSec }, payload);
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + p).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${h}.${p}.${sig}`;
}

/** 定长比较：用 === 比签名，理论上能被按字节计时猜出正确签名 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function verify(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expect = crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + p).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (!safeEqual(sig, expect)) return null;
  try {
    const payload = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function checkPassword(pw, stored) {
  try {
    const [algo, salt, hash] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const calc = crypto.scryptSync(pw, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(hash, 'hex'));
  } catch (e) {
    return false;
  }
}

// ---------------- 数据库 ----------------
async function initDb() {
  let pg;
  try {
    pg = require('pg');
  } catch (e) {
    console.error('');
    console.error('  ══════════════════════════════════════════════════');
    console.error('   启动失败：缺少数据库依赖 pg');
    console.error('  ══════════════════════════════════════════════════');
    console.error('');
    console.error('   当前工作目录：' + process.cwd());
    console.error('   查找位置：' + path.join(process.cwd(), 'node_modules', 'pg'));
    console.error('');
    console.error('   在群晖 NAS 上的处理方法：');
    console.error('');
    console.error('   1) 确认 index.js 和 package.json 都在挂载目录里');
    console.error('      例如 /volume1/docker/home-storage/ 下应同时包含这两个文件');
    console.error('');
    console.error('   2) 手动安装依赖（在 NAS 的 SSH 里执行）：');
    console.error('      cd /volume1/docker/home-storage');
    console.error('      docker run --rm -v /volume1/docker/home-storage:/app \\');
    console.error('        node:20-alpine sh -c "cd /app && npm install --omit=dev \\');
    console.error('        --registry=https://registry.npmmirror.com"');
    console.error('');
    console.error('   3) 然后在 Container Manager 里重启 home-storage-api 容器');
    console.error('');
    console.error('   如果 NAS 无法访问外网，请改用带 Dockerfile 的配置，');
    console.error('   在能联网的电脑上构建好镜像再导入 NAS。');
    console.error('');
    throw e;
  }
  pool = new pg.Pool(Object.assign({ max: 10, idleTimeoutMillis: 30000 }, DB));

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id           SERIAL PRIMARY KEY,
      username     TEXT UNIQUE NOT NULL,
      password     TEXT NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS records (
      user_id      INTEGER NOT NULL,
      kind         TEXT NOT NULL,
      id           TEXT NOT NULL,
      data         JSONB NOT NULL,
      updated_at   TIMESTAMPTZ NOT NULL,
      device       TEXT,
      deleted      BOOLEAN DEFAULT false,
      PRIMARY KEY (user_id, kind, id)
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_records_updated ON records (user_id, updated_at);`);
  console.log('[db] 数据表就绪');
}

// ---------------- HTTP 辅助 ----------------
function send(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj == null ? {} : obj);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  }, extraHeaders || {}));
  res.end(body);
}

function sendHtml(res, code, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/** 数据库能不能连通（健康检查和首页状态页都用它） */
async function checkDb() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (e) {
    return false;
  }
}

// ---------------- 手机版界面（PWA）静态托管 ----------------

/**
 * 为什么应用走 /app/ 而不是根路径：根路径已经被「状态页」占着 —— 那是用户
 * 部署完第一眼要看的东西（服务正常吗、数据库连上了吗、客户端填什么地址）。
 * 换成应用界面，出问题时用户就无从下手了。所以应用在 /app/，状态页留在 /。
 *
 * 目录用 __dirname 而不是 process.cwd()：容器里的工作目录取决于 compose 怎么配的，
 * 而 __dirname 永远指向 index.js 所在的目录，也就是 public/ 的父目录。
 */
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function sendRaw(res, code, type, buf, extraHeaders) {
  res.writeHead(code, Object.assign({
    'Content-Type': type,
    'Content-Length': buf.length
  }, extraHeaders || {}));
  res.end(buf);
}

function serveStatic(req, res, urlPath) {
  // 把 /app/ 之后的部分取出来；/app 或 /app/ 都指向 index.html
  let rel = urlPath.replace(/^\/app\/?/, '');
  if (!rel || rel.endsWith('/')) rel += 'index.html';

  try {
    rel = decodeURIComponent(rel);
  } catch (e) {
    return send(res, 400, { error: '地址格式不正确' });
  }

  const base = path.resolve(PUBLIC_DIR);
  const target = path.resolve(base, rel);
  // 路径穿越防护：解析后的绝对路径必须还在 public 目录里。
  // 少了这一步，/app/../index.js 就能把服务端源码整个读出去。
  if (target !== base && !target.startsWith(base + path.sep)) {
    return send(res, 403, { error: '不允许访问该路径' });
  }

  let buf;
  try {
    buf = fs.readFileSync(target);
  } catch (e) {
    return send(res, 404, { error: '文件不存在：' + rel });
  }

  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';

  // 静态文件名里没有内容哈希，所以不能长缓存（改了界面用户会拿到旧的）。
  // 用 ETag 做条件请求：没变就回 304，变了立刻生效 —— 局域网下这点开销可以忽略。
  let stat = null;
  try {
    stat = fs.statSync(target);
  } catch (e) {}
  const etag = stat ? `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"` : '';
  if (etag && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
    return res.end();
  }

  return sendRaw(res, 200, type, buf, {
    ETag: etag,
    'Cache-Control': 'no-cache'
  });
}

/** public/ 没上传时给一个人话说明，而不是让用户对着 404 猜 */
function missingAppPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>手机版界面还没上传</title>
<style>
  body { margin:0; padding:28px 18px; background:#f5f5f3; color:#1f1f1e;
         font-family:"Microsoft YaHei UI","Microsoft YaHei",-apple-system,system-ui,sans-serif;
         font-size:14px; line-height:1.75; }
  .wrap { max-width:620px; margin:0 auto; }
  .card { background:#fff; border:1px solid #e3e2dd; border-radius:12px; padding:20px 22px; }
  h1 { font-size:19px; margin:0 0 10px; font-weight:500; }
  code { background:#f5f5f3; border:1px solid #e3e2dd; border-radius:5px;
         padding:1px 6px; font-family:ui-monospace,Consolas,monospace; font-size:13px; }
  .warn { color:#ba7517; }
</style>
</head>
<body>
<div class="wrap"><div class="card">
  <h1>手机版界面还没上传</h1>
  <p class="warn">服务本身是正常的，只是 <code>public</code> 目录不在。</p>
  <p>把项目里 <code>server/public</code> 整个文件夹一起传到 NAS 的挂载目录
     （和 <code>index.js</code>、<code>package.json</code> 放在同一层），然后重启容器即可。</p>
  <p>不需要手机版的话，忽略这条就行 —— 同步功能不受影响。</p>
</div></div>
</body>
</html>`;
}

/**
 * 首页状态页。
 *
 * 为什么需要它：这是个纯接口服务，没有网页界面。用户部署完自然会用浏览器
 * 打开 http://NAS的IP:8787 看一眼，如果只回一句 {"error":"接口不存在"}，
 * 会以为部署失败了（实际上服务完全正常）。这里给一个能看懂的页面，
 * 把「服务是否正常」「数据库是否正常」「客户端该填什么地址」直接显示出来。
 */
function statusPage(dbOk, host) {
  const base = 'http://' + (host || 'NAS的IP:8787');
  const dot = dbOk ? '#1d9e75' : '#e24b4a';
  const dbText = dbOk ? '数据库连接正常' : '数据库连接失败';
  const dbHint = dbOk
    ? ''
    : '<p class="hint">数据库没连上。请到 Container Manager 里看 <code>home-storage-db</code> 容器的日志，' +
      '常见原因是数据目录权限不足，可执行 <code>chmod -R 777 /volumeX/docker/home-storage/data</code> 后重启。</p>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>家庭收纳 · 同步服务</title>
<style>
  body { margin:0; padding:28px 18px; background:#f5f5f3; color:#1f1f1e;
         font-family:"Microsoft YaHei UI","Microsoft YaHei",-apple-system,system-ui,sans-serif;
         font-size:14px; line-height:1.75; }
  .wrap { max-width:620px; margin:0 auto; }
  .card { background:#fff; border:1px solid #e3e2dd; border-radius:12px; padding:20px 22px; margin-bottom:14px; }
  h1 { font-size:19px; margin:0 0 4px; font-weight:500; }
  .sub { color:#8f8e88; font-size:12px; }
  .row { display:flex; align-items:center; gap:8px; margin-top:14px; }
  .dot { width:9px; height:9px; border-radius:50%; background:${dot}; flex:0 0 9px; }
  .ok { color:${dot}; font-weight:500; }
  h2 { font-size:14px; margin:0 0 8px; font-weight:500; }
  ol { margin:0; padding-left:20px; }
  code { background:#f5f5f3; border:1px solid #e3e2dd; border-radius:5px;
         padding:1px 6px; font-family:ui-monospace,Consolas,monospace; font-size:13px; }
  .addr { display:inline-block; background:#eeedfe; color:#534ab7; border-radius:6px;
          padding:3px 10px; font-family:ui-monospace,Consolas,monospace; font-size:13px; }
  .hint { color:#ba7517; font-size:13px; margin:8px 0 0; }
  a { color:#534ab7; }
  .foot { color:#8f8e88; font-size:12px; text-align:center; margin-top:18px; }
</style>
</head>
<body>
<div class="wrap">

  <div class="card">
    <h1>家庭收纳 · 同步服务</h1>
    <div class="sub">版本 ${VERSION}　·　这是后台接口服务，没有网页界面</div>
    <div class="row"><span class="dot"></span><span class="ok">服务运行中</span></div>
    <div class="row"><span class="dot"></span><span class="${dbOk ? 'ok' : ''}">${dbText}</span></div>
    ${dbHint}
  </div>

  <div class="card">
    <h2>在客户端里这样填</h2>
    <p style="margin:0 0 10px">打开「家庭收纳」→ 设置 → 数据同步，服务器地址填：</p>
    <div class="addr">${base}</div>
    <p style="margin:12px 0 0; color:#5f5e5a; font-size:13px">
      然后点「注册新账号」建一个账号，再点「登录并保存」。
    </p>
  </div>

  <div class="card">
    <h2>手机 / 平板也能用（不用装 App）</h2>
    <p style="margin:0 0 10px">用手机浏览器打开下面这个地址，再「添加到主屏幕」，就得到一个独立图标：</p>
    <div class="addr">${base}/app/</div>
    <p style="margin:12px 0 0; color:#5f5e5a; font-size:13px">
      首次打开是空的。到「设置 → 数据同步」把服务器地址填成
      <code>${base}</code>（注意去掉 <code>/app/</code>），登录后同步一次就有数据了。
    </p>
    <p style="margin:8px 0 0; color:#ba7517; font-size:13px">
      局域网 http 下扫码用不了（浏览器不允许非安全源调用摄像头），
      手动输入条码或内部编码不受影响。
    </p>
  </div>

  <div class="card">
    <h2>排查用</h2>
    <p style="margin:0">接口健康检查：<a href="/api/health">/api/health</a>　
      （返回 <code>{"ok":true,"db":true}</code> 表示一切正常）</p>
  </div>

  <div class="foot">看到这个页面就说明服务部署成功了，直接关掉即可</div>

</div>
</body>
</html>`;
}

function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function authUser(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  return verify(token);
}

// ---------------- 业务处理 ----------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = u.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    return res.end();
  }

  try {
    // 首页：用户部署完会用浏览器打开 http://NAS的IP:8787 看一眼。
    // 这里返回一个能看懂的状态页，而不是冷冰冰的 {"error":"接口不存在"}。
    if ((path === '/' || path === '/index.html') && req.method === 'GET') {
      return sendHtml(res, 200, statusPage(await checkDb(), req.headers.host));
    }

    if (path === '/api/health') {
      return send(res, 200, { ok: true, name: '家庭收纳同步服务', version: VERSION, db: await checkDb() });
    }

    // 手机版界面（PWA）。装在 NAS 上，家人不装 APK 也能用；
    // iPhone 通过「添加到主屏幕」得到一个独立图标，不显示浏览器地址栏。
    if ((path === '/app' || path.startsWith('/app/')) && req.method === 'GET') {
      if (!fs.existsSync(PUBLIC_DIR)) return sendHtml(res, 200, missingAppPage());
      // 少了这个斜杠，页面里的相对路径（css/、js/）会去根目录找，全部 404
      if (path === '/app') {
        res.writeHead(302, { Location: '/app/' });
        return res.end();
      }
      return serveStatic(req, res, path);
    }

    if (path === '/api/register' && req.method === 'POST') {
      if (!ALLOW_REGISTER) return send(res, 403, { error: '服务端已关闭注册功能' });
      // 限流要在读请求体和跑 scrypt 之前做，否则限流本身又成了新的开销入口
      const regKey = 'register:' + clientIp(req);
      const regWait = lockRemaining(regKey);
      if (regWait) return sendTooMany(res, regWait, '注册');
      const b = await readBody(req);
      const username = String(b.username || '').trim();
      const password = String(b.password || '');
      if (username.length < 2) return send(res, 400, { error: '账号至少 2 个字符' });
      if (password.length < 4) return send(res, 400, { error: '密码至少 4 个字符' });
      const exists = await pool.query('SELECT 1 FROM users WHERE username = $1', [username]);
      if (exists.rowCount) return send(res, 409, { error: '该账号已存在' });
      await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, hashPassword(password)]);
      // 只统计「真的建出了账号」的次数：填错格式、重名不算滥用
      noteHit(regKey, REGISTER_MAX, REGISTER_WINDOW_MS, REGISTER_WINDOW_MS);
      return send(res, 200, { ok: true });
    }

    if (path === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      const username = String(b.username || '').trim();
      const password = String(b.password || '');
      // 按账号计数，大小写归一：换个大小写不能绕过限流
      const loginKey = 'login:' + username.toLowerCase();
      const loginWait = lockRemaining(loginKey);
      if (loginWait) return sendTooMany(res, loginWait, '登录');
      const r = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
      if (!r.rowCount || !checkPassword(password, r.rows[0].password)) {
        const rec = noteHit(loginKey, LOGIN_MAX_FAILS, LOGIN_WINDOW_MS, LOGIN_LOCK_MS);
        // 刚刚触顶：直接回 429，让用户当场就知道要等，而不是再试一次才发现
        const nowLocked = lockRemaining(loginKey);
        if (nowLocked) return sendTooMany(res, nowLocked, '登录');
        const left = Math.max(0, LOGIN_MAX_FAILS - rec.count);
        // 账号不存在与密码错误回同一句话，不泄露账号是否存在
        return send(res, 401, { error: `账号或密码不正确（还可尝试 ${left} 次）`, remaining: left });
      }
      clearHits(loginKey);
      const token = sign({ uid: r.rows[0].id, username });
      return send(res, 200, { ok: true, token, username, device: b.device || '' });
    }

    if (path === '/api/sync' && req.method === 'POST') {
      const auth = authUser(req);
      if (!auth) return send(res, 401, { error: '登录状态已失效，请重新登录' });
      const uid = auth.uid;
      // 图片同步会带 base64 全图，请求体比纯文本大，这里单独放宽上限
      // （仅在通过登录校验之后才读取，不影响未鉴权接口的默认上限）
      const b = await readBody(req, 64 * 1024 * 1024);
      const since = b.since || '1970-01-01T00:00:00.000Z';
      const device = String(b.device || req.headers['x-device'] || '').slice(0, 64);
      const push = b.push || {};
      const serverTime = new Date().toISOString();

      let pushedCount = 0;

      if (push && typeof push === 'object') {
        const kinds = [
          ['locations', 'location'],
          ['items', 'item'],
          ['categories', 'category'],
          // 物品图片：整条记录（含 base64 全图）作为 JSONB 存下来，随增量同步收发
          ['images', 'image']
        ];
        for (const [key, kind] of kinds) {
          const arr = Array.isArray(push[key]) ? push[key] : [];
          for (const rec of arr) {
            if (!rec || !rec.id) continue;
            const updatedAt = rec.updated_at || serverTime;
            // 使用 updated_at 做冲突判定：只有更新的版本才会覆盖服务端
            const r = await pool.query(
              `INSERT INTO records (user_id, kind, id, data, updated_at, device, deleted)
               VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (user_id, kind, id) DO UPDATE
                 SET data = EXCLUDED.data,
                     updated_at = EXCLUDED.updated_at,
                     device = EXCLUDED.device,
                     deleted = EXCLUDED.deleted
                 WHERE records.updated_at < EXCLUDED.updated_at`,
              [uid, kind, rec.id, JSON.stringify(rec), updatedAt, device, !!rec.deleted]
            );
            pushedCount += r.rowCount;
          }
        }
      }

      // 注意是 >= 而不是 >：一批记录的时间戳常常完全相同（批量导入、一次性录入）。
      // 用 > 的话，截断后拿 pullTo 继续拉会跳过同时间戳的其余记录，照样丢数据。
      // 客户端合并是按 id + updated_at 幂等的，重复拉到同一条不会出问题。
      const pullRes = await pool.query(
        `SELECT kind, data, updated_at FROM records
         WHERE user_id = $1 AND updated_at >= $2
         ORDER BY updated_at ASC
         LIMIT ${PULL_LIMIT}`,
        [uid, since]
      );

      const pull = { locations: [], items: [], categories: [], images: [] };
      const KIND_KEY = { location: 'locations', item: 'items', category: 'categories', image: 'images' };
      pullRes.rows.forEach((row) => {
        const key = KIND_KEY[row.kind] || 'items';
        pull[key].push(row.data);
      });

      // 被截断说明还有没拉完的。把「本批最后一条的时间」交回客户端，
      // 让它下一次从这里接着拉，而不是把进度直接推到 serverTime。
      const truncated = pullRes.rows.length >= PULL_LIMIT;
      const pullTo = truncated ? pullRes.rows[pullRes.rows.length - 1].updated_at : null;

      return send(res, 200, {
        ok: true,
        serverTime,
        pushed: pushedCount,
        pull,
        truncated,
        pullTo,
        stats: {
          locations: pull.locations.length,
          items: pull.items.length,
          categories: pull.categories.length,
          images: pull.images.length
        }
      });
    }

    if (path === '/api/stats' && req.method === 'GET') {
      const auth = authUser(req);
      if (!auth) return send(res, 401, { error: '未登录' });
      const r = await pool.query(
        `SELECT kind, COUNT(*)::int AS n, MAX(updated_at) AS last
         FROM records WHERE user_id = $1 AND deleted = false GROUP BY kind`,
        [auth.uid]
      );
      return send(res, 200, { ok: true, stats: r.rows });
    }

    send(res, 404, { error: '接口不存在' });
  } catch (e) {
    console.error('[error]', e);
    send(res, 500, { error: String(e.message || e) });
  }
});

async function main() {
  console.log('[boot] 家庭收纳同步服务启动中…');
  checkSecurity();
  let retry = 0;
  while (retry < 30) {
    try {
      await initDb();
      break;
    } catch (e) {
      retry++;
      console.log(`[db] 等待数据库就绪（第 ${retry} 次）…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  server.listen(PORT, () => {
    console.log(`[boot] 服务已就绪：http://0.0.0.0:${PORT}`);
    console.log(`[boot] 注册功能：${ALLOW_REGISTER ? '开启' : '关闭'}`);
  });
}

main();
