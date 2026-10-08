'use strict';
/**
 * 服务端接口测试
 * 用内存版 pg 替身验证服务端的账号、令牌、增量同步逻辑，
 * 无需真实 PostgreSQL 即可确认协议正确。
 */
const path = require('path');
const http = require('http');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (e ? '  → ' + e : '')); }
};

// ---- 用内存表替换 pg ----
const users = [];
// 服务端一次拉取的上限（默认 20000）。测试里设成小值，
// 才能用几十条记录覆盖「数据多到一次拉不完」这条路径 —— 这条路径以前没人走过。
process.env.PULL_LIMIT = '20';

const records = [];
let uid = 1;

const fakePool = {
  async query(sql, params) {
    if (fakePool.__fail) throw new Error('模拟数据库不可用');
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s === 'SELECT 1') return { rows: [{}], rowCount: 1 };

    if (/^CREATE TABLE/i.test(s) || /^CREATE INDEX/i.test(s)) return { rows: [], rowCount: 0 };

    if (/^SELECT 1 FROM users WHERE username/i.test(s)) {
      const u = users.find((x) => x.username === params[0]);
      return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
    }
    if (/^SELECT \* FROM users WHERE username/i.test(s)) {
      const u = users.find((x) => x.username === params[0]);
      return { rows: u ? [u] : [], rowCount: u ? 1 : 0 };
    }
    if (/^INSERT INTO users/i.test(s)) {
      users.push({ id: uid++, username: params[0], password: params[1] });
      return { rows: [], rowCount: 1 };
    }
    if (/^INSERT INTO records/i.test(s)) {
      const [user_id, kind, id, data, updated_at, device, deleted] = params;
      const exist = records.find((r) => r.user_id === user_id && r.kind === kind && r.id === id);
      if (exist) {
        // 只有更新的版本才覆盖
        if (new Date(exist.updated_at) < new Date(updated_at)) {
          Object.assign(exist, { data: JSON.parse(data), updated_at, device, deleted });
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      records.push({ user_id, kind, id, data: JSON.parse(data), updated_at, device, deleted });
      return { rows: [], rowCount: 1 };
    }
    if (/^SELECT kind, data(, updated_at)? FROM records/i.test(s)) {
      const [userId, since] = params;
      // 比较运算符要**跟着 SQL 走**，不能在替身里写死：
      // 写死的话，把服务端的 >= 改成 > 测试照样全绿，反向验证就成了假的。
      const useGe = /updated_at\s*>=\s*\$2/.test(s);
      const rows = records
        .filter((r) => {
          if (r.user_id !== userId) return false;
          const a = new Date(r.updated_at).getTime();
          const b = new Date(since).getTime();
          return useGe ? a >= b : a > b;
        })
        .sort((a, b) => new Date(a.updated_at) - new Date(b.updated_at));
      // 真 pg 会按 SQL 里的 LIMIT 截断。替身以前忽略它，于是「拉取被截断」
      // 这条路径在测试里根本不存在 —— 而 bug 恰恰藏在这里。
      const m = /LIMIT (\d+)/i.exec(s);
      const limited = m ? rows.slice(0, Number(m[1])) : rows;
      return {
        rows: limited.map((r) => ({ kind: r.kind, data: r.data, updated_at: r.updated_at })),
        rowCount: limited.length
      };
    }
    if (/^SELECT kind, COUNT/i.test(s)) {
      const rows = [];
      const kinds = {};
      records.filter((r) => r.user_id === params[0] && !r.deleted).forEach((r) => {
        kinds[r.kind] = kinds[r.kind] || { n: 0, last: r.updated_at };
        kinds[r.kind].n++;
        if (new Date(r.updated_at) > new Date(kinds[r.kind].last)) kinds[r.kind].last = r.updated_at;
      });
      Object.entries(kinds).forEach(([kind, v]) => rows.push({ kind, n: v.n, last: v.last }));
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  }
};

// 拦截 require('pg')
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'pg') return '__fake_pg__';
  return origResolve.call(this, request, ...args);
};
const origLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'pg') return { Pool: function () { return fakePool; } };
  return origLoad.call(this, request, ...args);
};

const PORT = 18787;
process.env.PORT = String(PORT);
process.env.JWT_SECRET = 'test-secret-key';
process.env.DB_HOST = 'fake';

function req(method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (payload) headers['Content-Length'] = payload.length;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let j = null;
        try { j = JSON.parse(text); } catch (e) { j = { raw: text }; }
        resolve({ status: res.statusCode, body: j, headers: res.headers, text });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

(async () => {
  console.log('启动测试服务…\n');
  require(path.join(ROOT, 'server', 'index.js'));
  await new Promise((r) => setTimeout(r, 900));

  console.log('[S-1] 健康检查');
  const h = await req('GET', '/api/health');
  ok('健康检查返回 200', h.status === 200, 'got ' + h.status);
  ok('返回服务名称', h.body.name === '家庭收纳同步服务', JSON.stringify(h.body));
  ok('数据库连接正常', h.body.db === true);

  console.log('\n[S-2] 注册与登录');
  const reg = await req('POST', '/api/register', { username: 'testuser', password: 'pass1234' });
  ok('注册成功', reg.status === 200 && reg.body.ok, JSON.stringify(reg.body));

  const reg2 = await req('POST', '/api/register', { username: 'testuser', password: 'pass1234' });
  ok('重复注册被拒绝', reg2.status === 409, 'got ' + reg2.status);

  const regBad = await req('POST', '/api/register', { username: 'a', password: '1' });
  ok('弱密码被拒绝', regBad.status === 400, 'got ' + regBad.status);

  const login = await req('POST', '/api/login', { username: 'testuser', password: 'pass1234', device: 'PC-A' });
  ok('登录成功', login.status === 200 && !!login.body.token);
  const token = login.body.token;
  ok('返回令牌为三段式 JWT', (token || '').split('.').length === 3, token);

  const loginBad = await req('POST', '/api/login', { username: 'testuser', password: 'wrong' });
  ok('错误密码被拒绝', loginBad.status === 401, 'got ' + loginBad.status);

  console.log('\n[S-3] 鉴权保护');
  const noAuth = await req('POST', '/api/sync', { since: '1970-01-01T00:00:00.000Z' });
  ok('无令牌访问被拒绝', noAuth.status === 401, 'got ' + noAuth.status);

  const badAuth = await req('POST', '/api/sync', { since: '1970-01-01T00:00:00.000Z' }, 'abc.def.ghi');
  ok('伪造令牌被拒绝', badAuth.status === 401, 'got ' + badAuth.status);

  console.log('\n[S-4] 首次同步（推送数据）');
  const t1 = new Date(Date.now() - 60000).toISOString();
  const pushRes = await req('POST', '/api/sync', {
    since: '1970-01-01T00:00:00.000Z',
    device: 'PC-A',
    push: {
      locations: [{ id: 'loc-1', name: '厨房', parent_id: null, updated_at: t1, deleted: false }],
      items: [
        { id: 'item-1', name: '酱油', barcode: '6901234567892', quantity: 1, location_id: 'loc-1', updated_at: t1, deleted: false },
        { id: 'item-2', name: '面包', barcode: '6909876543210', quantity: 2, location_id: 'loc-1', updated_at: t1, deleted: false }
      ],
      categories: [{ id: 'cat-1', name: '食品', updated_at: t1, deleted: false }]
    }
  }, token);
  ok('同步请求成功', pushRes.status === 200 && pushRes.body.ok);
  ok('服务端记录了推送条数', pushRes.body.pushed === 4, 'pushed=' + pushRes.body.pushed);
  ok('返回服务器时间', !!pushRes.body.serverTime);
  const serverTime = pushRes.body.serverTime;

  console.log('\n[S-5] 增量拉取（模拟第二台设备）');
  const pullRes = await req('POST', '/api/sync', {
    since: '1970-01-01T00:00:00.000Z',
    device: 'PC-B',
    push: { locations: [], items: [], categories: [] }
  }, token);
  ok('新设备拉到全部数据', pullRes.body.pull.items.length === 2, 'got ' + pullRes.body.pull.items.length);
  ok('拉到位置数据', pullRes.body.pull.locations.length === 1);
  ok('拉到分类数据', pullRes.body.pull.categories.length === 1);
  ok('物品内容完整', pullRes.body.pull.items[0].name === '酱油' || pullRes.body.pull.items[1].name === '酱油');
  ok('条码字段保留', pullRes.body.pull.items.some((i) => i.barcode === '6901234567892'));

  console.log('\n[S-6] 真正增量（无变更时不重复拉取）');
  const noChange = await req('POST', '/api/sync', {
    since: serverTime,
    push: { locations: [], items: [], categories: [] }
  }, token);
  ok('无新变更时拉取为空', noChange.body.pull.items.length === 0, 'got ' + noChange.body.pull.items.length);

  console.log('\n[S-7] 冲突处理（旧版本不覆盖新版本）');
  const tOld = new Date(Date.now() - 120000).toISOString();
  const tNew = new Date(Date.now() - 10000).toISOString();
  await req('POST', '/api/sync', {
    since: serverTime,
    push: { locations: [], items: [{ id: 'item-1', name: '酱油（新版）', quantity: 5, updated_at: tNew, deleted: false }], categories: [] }
  }, token);
  const pullAfter = await req('POST', '/api/sync', {
    since: '1970-01-01T00:00:00.000Z',
    push: { locations: [], items: [], categories: [] }
  }, token);
  const item1 = pullAfter.body.pull.items.find((i) => i.id === 'item-1');
  ok('新版本已保存', item1.name === '酱油（新版）', item1.name);
  ok('数量已更新', item1.quantity === 5, String(item1.quantity));

  // 用旧时间戳推送，应被忽略
  const stalePush = await req('POST', '/api/sync', {
    since: '1970-01-01T00:00:00.000Z',
    push: { locations: [], items: [{ id: 'item-1', name: '酱油（旧版）', quantity: 99, updated_at: tOld, deleted: false }], categories: [] }
  }, token);
  ok('旧版本推送被服务端忽略', stalePush.body.pushed === 0, 'pushed=' + stalePush.body.pushed);
  const item1b = (await req('POST', '/api/sync', {
    since: '1970-01-01T00:00:00.000Z',
    push: { locations: [], items: [], categories: [] }
  }, token)).body.pull.items.find((i) => i.id === 'item-1');
  ok('数据未被旧版本覆盖', item1b.name === '酱油（新版）' && item1b.quantity === 5, `${item1b.name}/${item1b.quantity}`);

  console.log('\n[S-8] 软删除同步');
  const tDel = new Date().toISOString();
  await req('POST', '/api/sync', {
    since: '1970-01-01T00:00:00.000Z',
    push: { locations: [], items: [{ id: 'item-2', name: '面包', updated_at: tDel, deleted: true }], categories: [] }
  }, token);
  const afterDel = await req('POST', '/api/sync', {
    since: '1970-01-01T00:00:00.000Z',
    push: { locations: [], items: [], categories: [] }
  }, token);
  const item2 = afterDel.body.pull.items.find((i) => i.id === 'item-2');
  ok('删除标记已同步', item2 && item2.deleted === true, JSON.stringify(item2));

  console.log('\n[S-9] 数据隔离（不同账号互不可见）');
  await req('POST', '/api/register', { username: 'other', password: 'pass5678' });
  const login2 = await req('POST', '/api/login', { username: 'other', password: 'pass5678' });
  const token2 = login2.body.token;
  const otherPull = await req('POST', '/api/sync', {
    since: '1970-01-01T00:00:00.000Z',
    push: { locations: [], items: [], categories: [] }
  }, token2);
  ok('新账号看不到别人的数据', otherPull.body.pull.items.length === 0, 'got ' + otherPull.body.pull.items.length);
  ok('新账号位置也为空', otherPull.body.pull.locations.length === 0);

  console.log('\n[S-10] 统计接口');
  const stats = await req('GET', '/api/stats', null, token);
  ok('统计接口返回成功', stats.status === 200 && stats.body.ok);
  const itemStat = (stats.body.stats || []).find((s) => s.kind === 'item');
  // item-2 已在 S-8 标记为软删除，故未删除的只有 1 条
  ok('统计只计入未删除记录', itemStat && itemStat.n === 1, JSON.stringify(stats.body.stats));

  console.log('\n[S-10b] 图片同步');
  // 图片全图是 base64，单张就可能有几百 KB ~ 几 MB。
  // 1) 必须能推上去、拉下来；2) 请求体上限不能把图片卡掉。
  const bigFull = 'data:image/jpeg;base64,' + 'A'.repeat(1.5 * 1024 * 1024);
  const imgPush = await req('POST', '/api/sync', {
    since: '1970-01-01T00:00:00.000Z',
    push: {
      locations: [], items: [], categories: [],
      images: [{
        id: 'img-1', item_id: 'item-1', thumb: 'data:image/jpeg;base64,QQ==',
        w: 1024, h: 768, full: bigFull,
        created_at: '2026-09-13T01:00:00.000Z', updated_at: '2026-09-13T01:00:00.000Z', deleted: false
      }]
    }
  }, token);
  ok('大体积图片推送未被请求体上限拦截', imgPush.status === 200 && imgPush.body.ok,
    'status=' + imgPush.status + ' ' + JSON.stringify(imgPush.body).slice(0, 120));
  ok('服务端记录了图片推送条数', imgPush.body.pushed === 1, 'pushed=' + imgPush.body.pushed);
  ok('响应里的条数统计单独列出图片', imgPush.body.stats && imgPush.body.stats.images === 1,
    JSON.stringify(imgPush.body.stats));

  const imgPull = await req('POST', '/api/sync', {
    since: '1970-01-01T00:00:00.000Z',
    push: { locations: [], items: [], categories: [], images: [] }
  }, token);
  const pulled = (imgPull.body.pull.images || []).find((x) => x.id === 'img-1');
  ok('另一台设备能拉到图片记录', !!pulled);
  ok('拉到的图片全图完整', pulled && pulled.full === bigFull);
  ok('拉到的图片缩略图保留', pulled && pulled.thumb === 'data:image/jpeg;base64,QQ==');
  ok('拉到的图片保留了关联物品', pulled && pulled.item_id === 'item-1');
  ok('图片不会被当成物品混进 items', !(imgPull.body.pull.items || []).some((i) => i.id === 'img-1'));

  const stats2 = await req('GET', '/api/stats', null, token);
  const imgStat = (stats2.body.stats || []).find((s) => s.kind === 'image');
  ok('统计接口把图片单独归类', imgStat && imgStat.n === 1, JSON.stringify(stats2.body.stats));

  console.log('\n[S-10c] 三类记录与新字段原样往返');
  // 三类东西（物品 / 资料 / 图书）共用一张 items 表，靠 kind 区分；
  // 内部编码存在 code，办公资料与图书的专属字段存在 extra。
  // 服务端是把整条记录 JSON.stringify 后塞进 JSONB 的，理论上不会丢字段——
  // 但必须有断言锁住，否则哪天有人加了「只存已知字段」的裁剪，这些字段会静默变空。
  const tV2 = new Date(Date.now() - 20000).toISOString();
  const pushV2 = await req('POST', '/api/sync', {
    since: '1970-01-01T00:00:00.000Z',
    device: 'PC-A',
    push: {
      locations: [], categories: [],
      items: [
        {
          id: 'item-doc-1', name: '房屋租赁合同', kind: 'doc', code: 'HS-2026-0001',
          category_key: '合同协议', quantity: 1, location_id: 'loc-1',
          extra: { doc_no: 'HT-2026-018', fiscal_year: '2026', amount: '48000', keeper_until: '2036-12-31' },
          tags: ['重要', '已归档'], updated_at: tV2, deleted: false
        },
        {
          id: 'item-book-1', name: '深入理解计算机系统', kind: 'book', barcode: '9787111544937',
          category_key: '图书', quantity: 1,
          extra: { author: 'Bryant', publisher: '机械工业出版社', pub_year: '2016', status: '在读' },
          updated_at: tV2, deleted: false
        }
      ]
    }
  }, token);
  ok('含新字段的记录推送成功', pushV2.status === 200 && pushV2.body.pushed === 2,
    'status=' + pushV2.status + ' pushed=' + pushV2.body.pushed);

  const pullV2 = await req('POST', '/api/sync', {
    since: '1970-01-01T00:00:00.000Z',
    device: 'PC-B',
    push: { locations: [], items: [], categories: [] }
  }, token);
  const docBack = (pullV2.body.pull.items || []).find((i) => i.id === 'item-doc-1');
  const bookBack = (pullV2.body.pull.items || []).find((i) => i.id === 'item-book-1');
  ok('资料记录的 kind 原样往返', docBack && docBack.kind === 'doc', JSON.stringify(docBack && docBack.kind));
  ok('资料记录的内部编码原样往返', docBack && docBack.code === 'HS-2026-0001', docBack && docBack.code);
  ok('资料记录的 extra 原样往返',
    docBack && docBack.extra && docBack.extra.doc_no === 'HT-2026-018',
    JSON.stringify(docBack && docBack.extra));
  ok('资料记录的 extra 其余字段不丢',
    docBack && docBack.extra && docBack.extra.fiscal_year === '2026' &&
      docBack.extra.amount === '48000' && docBack.extra.keeper_until === '2036-12-31',
    JSON.stringify(docBack && docBack.extra));
  ok('资料记录的标签数组原样往返',
    docBack && Array.isArray(docBack.tags) && docBack.tags.join(',') === '重要,已归档',
    JSON.stringify(docBack && docBack.tags));
  ok('图书记录的 kind 原样往返', bookBack && bookBack.kind === 'book', JSON.stringify(bookBack && bookBack.kind));
  ok('图书记录的 ISBN 原样往返', bookBack && bookBack.barcode === '9787111544937', bookBack && bookBack.barcode);
  ok('图书记录的作者出版社原样往返',
    bookBack && bookBack.extra && bookBack.extra.author === 'Bryant' &&
      bookBack.extra.publisher === '机械工业出版社' && bookBack.extra.pub_year === '2016' &&
      bookBack.extra.status === '在读',
    JSON.stringify(bookBack && bookBack.extra));
  ok('extra 是对象而不是被序列化成字符串',
    docBack && typeof docBack.extra === 'object' && typeof docBack.extra !== 'string',
    typeof (docBack && docBack.extra));

  console.log('\n[S-10d] 一次拉不完时必须告诉客户端（不能静默截断）');
  // 拉取有 LIMIT（默认 20000，测试里设成 20）。被截断却不告诉客户端的话，
  // 客户端会把同步进度推到 serverTime，那些没拉到的记录就永远拉不到了 ——
  // 而用户看到的只有一句「同步完成」。
  const bulk = [];
  const t0 = Date.now() - 60000;
  for (let i = 0; i < 25; i++) {
    bulk.push({
      id: 'bulk-' + String(i).padStart(2, '0'),
      name: '批量记录 ' + i,
      updated_at: new Date(t0 + i).toISOString(),
      deleted: false
    });
  }
  const bulkPush = await req('POST', '/api/sync', {
    since: '1970-01-01T00:00:00.000Z', device: 'PC-A',
    push: { locations: [], items: bulk, categories: [] }
  }, token);
  ok('批量记录推送成功', bulkPush.body.pushed === 25, 'pushed=' + bulkPush.body.pushed);

  const first = await req('POST', '/api/sync', {
    since: '1970-01-01T00:00:00.000Z', device: 'PC-B',
    push: { locations: [], items: [], categories: [] }
  }, token);
  const firstIds = (first.body.pull.items || []).map((i) => i.id);
  // 上限是「所有 kind 加起来」的条数，不能只看 items
  const fs2 = first.body.stats;
  const firstTotal = fs2.locations + fs2.items + fs2.categories + fs2.images;
  ok('单次拉取受上限约束', firstTotal === 20, 'got ' + firstTotal);
  ok('被截断时明确告诉客户端 truncated=true', first.body.truncated === true, JSON.stringify(first.body.truncated));
  ok('被截断时返回本批最后一条的时间供接着拉', !!first.body.pullTo, String(first.body.pullTo));

  const second = await req('POST', '/api/sync', {
    since: first.body.pullTo, device: 'PC-B',
    push: { locations: [], items: [], categories: [] }
  }, token);
  const secondIds = (second.body.pull.items || []).map((i) => i.id);
  ok('用 pullTo 能接着拉到后面的记录', secondIds.length > 0, 'got ' + secondIds.length);
  const unionIds = new Set(firstIds.concat(secondIds));
  const missed = bulk.filter((b) => !unionIds.has(b.id)).map((b) => b.id);
  ok('两批合起来覆盖全部批量记录（没有静默丢失）', missed.length === 0, '缺 ' + missed.join(','));
  ok('拉完之后 truncated 变回 false', second.body.truncated === false, JSON.stringify(second.body.truncated));

  // 时间戳完全相同的记录：用「恰好等于该时刻」的 since 也必须能拉到。
  // 这就是 SQL 用 >= 而不是 > 的原因 —— 否则截断后同刻的其余记录会被跳过，
  // 而批量导入恰恰会产生大量同刻记录。
  const tSame = new Date(Date.now() - 3000).toISOString();
  await req('POST', '/api/sync', {
    since: '1970-01-01T00:00:00.000Z', device: 'PC-A',
    push: {
      locations: [], categories: [],
      items: [
        { id: 'same-1', name: '同刻记录1', updated_at: tSame, deleted: false },
        { id: 'same-2', name: '同刻记录2', updated_at: tSame, deleted: false }
      ]
    }
  }, token);
  const samePull = await req('POST', '/api/sync', {
    since: tSame, device: 'PC-B',
    push: { locations: [], items: [], categories: [] }
  }, token);
  const sameIds = (samePull.body.pull.items || []).map((i) => i.id);
  ok('since 恰好等于记录时刻时也能拉到（同刻记录不会被跳过）',
    sameIds.indexOf('same-1') >= 0 && sameIds.indexOf('same-2') >= 0, JSON.stringify(sameIds));

  console.log('\n[S-11] 未知接口');
  const nf = await req('GET', '/api/nothing');
  ok('未知接口返回 404', nf.status === 404, 'got ' + nf.status);

  console.log('\n[S-12] 首页状态页（浏览器直接打开根路径）');
  // 背景：用户部署完会用浏览器打开 http://NAS的IP:8787 看一眼。
  // 早先这里回的是 {"error":"接口不存在"}，用户会误以为部署失败。
  const home = await req('GET', '/');
  ok('根路径返回 200', home.status === 200, 'got ' + home.status);
  ok('根路径返回 HTML 而不是 JSON',
    /text\/html/.test(home.headers['content-type'] || ''), home.headers['content-type']);
  ok('页面明确写着服务在运行', home.text.includes('服务运行中'));
  ok('页面显示数据库状态', home.text.includes('数据库连接正常'));
  ok('页面告诉用户客户端该填什么地址',
    home.text.includes('127.0.0.1:' + PORT), '没找到 127.0.0.1:' + PORT);
  ok('页面指向健康检查接口', home.text.includes('/api/health'));
  ok('页面是完整 HTML', /<\/html>\s*$/.test(home.text.trim()));
  // 模板里若有未定义变量，页面会渲染出 "undefined" 或直接 500
  ok('页面没有渲染出 undefined', !/undefined/.test(home.text),
    (home.text.match(/.{0,40}undefined.{0,40}/) || [''])[0]);
  ok('页面没有未替换的模板占位符', !/\$\{/.test(home.text));
  ok('页面字符集是 UTF-8，中文不乱码', home.text.includes('家庭收纳'));

  // 版本号应与 /api/health 保持一致，避免两处各写一份以后漂移
  const healthVer = (await req('GET', '/api/health')).body.version;
  ok('状态页版本号与健康检查一致', home.text.includes('版本 ' + healthVer),
    `health=${healthVer}`);

  console.log('\n[S-13] 数据库不可用时，状态页要能指出问题');
  fakePool.__fail = true;
  const homeBad = await req('GET', '/');
  const healthBad = await req('GET', '/api/health');
  ok('数据库挂了页面仍能打开（不能白屏）', homeBad.status === 200, 'got ' + homeBad.status);
  ok('页面提示数据库连接失败', homeBad.text.includes('数据库连接失败'));
  ok('页面给出可操作的排查提示', homeBad.text.includes('chmod'));
  ok('健康检查如实报告 db:false', healthBad.body.db === false);
  ok('服务本身仍判定为 ok', healthBad.body.ok === true);
  fakePool.__fail = false;

  console.log('\n[S-14] 根路径之外的未知地址仍按接口规范返回 JSON');
  const nfHtml = await req('GET', '/nope');
  ok('未知地址返回 404', nfHtml.status === 404, 'got ' + nfHtml.status);
  ok('未知地址返回 JSON 错误体', nfHtml.body.error === '接口不存在', JSON.stringify(nfHtml.body));

  console.log('\n[S-15] 登录频次限制');
  // 背景：/api/login 早先没有任何失败计数。这是个挂在局域网（不少人还通过
  // 群晖反向代理暴露到公网）上的接口，拿一份字典就能无限次猜密码；而且每猜
  // 一次服务端都要跑一遍 scrypt（本来就慢），撞库与拒绝服务两个风险叠在一起。
  await req('POST', '/api/register', { username: 'victim', password: 'pass1234' });
  const preFails = [];
  for (let i = 1; i <= 4; i++) {
    preFails.push(await req('POST', '/api/login', { username: 'victim', password: 'nope' + i }));
  }
  ok('未达上限时仍是普通的 401（不能一上来就锁）',
    preFails.every((r) => r.status === 401), preFails.map((r) => r.status).join(','));
  ok('401 里告诉用户还剩几次机会',
    preFails[0].body.remaining === 4, JSON.stringify(preFails[0].body));

  const fifth = await req('POST', '/api/login', { username: 'victim', password: 'nope5' });
  ok('第 5 次失败后锁定，返回 429',
    fifth.status === 429, 'got ' + fifth.status + ' ' + JSON.stringify(fifth.body));
  ok('429 带上 Retry-After 头（标准客户端据此退避）',
    Number(fifth.headers['retry-after']) > 0, String(fifth.headers['retry-after']));
  ok('429 文案是给人看的中文，带剩余分钟数',
    /分钟/.test(fifth.body.error || '') && Number(fifth.body.retryAfter) > 0,
    JSON.stringify(fifth.body));

  // 这一条是「锁」的关键：锁定期间密码正确也必须被挡住。
  // 否则所谓锁定只是个提示语，攻击者照样能登进来。
  const rightDuringLock = await req('POST', '/api/login', { username: 'victim', password: 'pass1234' });
  ok('锁定期间即使密码正确也拒绝（锁不是提示语）',
    rightDuringLock.status === 429, 'got ' + rightDuringLock.status + ' ' + JSON.stringify(rightDuringLock.body));

  const upperCase = await req('POST', '/api/login', { username: 'VICTIM', password: 'pass1234' });
  ok('换个大小写不能绕过锁定', upperCase.status === 429, 'got ' + upperCase.status);

  const bystander = await req('POST', '/api/login', { username: 'testuser', password: 'pass1234' });
  ok('锁定只针对该账号，不连坐别人',
    bystander.status === 200 && !!bystander.body.token, 'got ' + bystander.status);

  // 登录成功要清零：否则正常用户会被自己几周前的几次失误慢慢攒到锁定
  await req('POST', '/api/register', { username: 'resetme', password: 'pass1234' });
  for (let i = 0; i < 4; i++) await req('POST', '/api/login', { username: 'resetme', password: 'bad' + i });
  const goodLogin = await req('POST', '/api/login', { username: 'resetme', password: 'pass1234' });
  ok('失败 4 次后仍能用正确密码登录（未达上限不锁）',
    goodLogin.status === 200 && !!goodLogin.body.token, 'got ' + goodLogin.status);
  const afterReset = [];
  for (let i = 0; i < 4; i++) {
    afterReset.push(await req('POST', '/api/login', { username: 'resetme', password: 'bad2-' + i }));
  }
  ok('登录成功后失败计数被清零（否则会累积到锁定）',
    afterReset.every((r) => r.status === 401), afterReset.map((r) => r.status).join(','));

  const ghost = await req('POST', '/api/login', { username: 'no-such-user-xyz', password: 'whatever' });
  ok('账号不存在与密码错误返回同一句话（不泄露账号是否存在）',
    ghost.status === 401 && /账号或密码不正确/.test(ghost.body.error || ''), JSON.stringify(ghost.body));

  console.log('\n[S-16] 注册频次限制');
  const regStatuses = [];
  let firstBlocked = null;
  for (let i = 0; i < 20; i++) {
    const r = await req('POST', '/api/register', { username: 'bulk' + i, password: 'pass1234' });
    regStatuses.push(r.status);
    if (r.status === 429 && !firstBlocked) firstBlocked = r;
  }
  ok('同一来源注册过多账号会被拒绝',
    regStatuses.indexOf(429) >= 0, regStatuses.join(','));
  ok('注册的 429 也带 Retry-After',
    firstBlocked && Number(firstBlocked.headers['retry-after']) > 0,
    firstBlocked && String(firstBlocked.headers['retry-after']));
  ok('一旦被限流，后续注册持续被拒（不是只挡一次）',
    regStatuses.slice(regStatuses.indexOf(429)).every((s) => s === 429), regStatuses.join(','));

  console.log('\n[S-17] 令牌签名用定长比较');
  // 用 === 比签名，理论上能被按字节计时逐位猜出正确签名。定长比较本身测不出
  // 「快慢」，只能静态锁住实现；但它的**长度守卫**是能行为验证的：
  // 少了长度判断，timingSafeEqual 会抛 RangeError，请求直接变 500。
  const srvSrc = require('fs').readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  ok('verify() 用定长比较签名，而不是 ===',
    /function verify[\s\S]*?safeEqual\(sig, expect\)/.test(srvSrc), '没找到 safeEqual(sig, expect)');
  ok('safeEqual 先比长度再定长比较',
    /function safeEqual[\s\S]*?\.length !== [\s\S]*?timingSafeEqual/.test(srvSrc));

  const shortSig = token.split('.').slice(0, 2).join('.') + '.x';
  const shortSigRes = await req('POST', '/api/sync', {
    since: '1970-01-01T00:00:00.000Z', push: { locations: [], items: [], categories: [] }
  }, shortSig);
  ok('长度不对的签名被当成未登录（401），而不是抛异常变 500',
    shortSigRes.status === 401, 'got ' + shortSigRes.status);

  console.log('\n========================================');
  console.log(`  服务端通过 ${pass} 项，失败 ${fail} 项`);
  console.log('========================================\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
