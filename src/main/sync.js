'use strict';

/**
 * 同步客户端：把本地变更推送到 NAS 上的后端
 *
 * 同步策略（家庭场景最实用的方案）：
 *  - 每条记录带 updated_at + deleted（软删除），支持增量识别
 *  - 推送：只发本地比 lastSyncAt 新的记录
 *  - 拉取：只取服务端比 lastSyncAt 新的记录，按 updated_at 做后写覆盖
 *  - 冲突：同一 id 双方都改过 → 比较 updated_at，新者胜；同时保留一份冲突副本
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

function request(url, { method = 'GET', headers = {}, body = null, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error('同步地址格式不正确'));
    }
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: Object.assign(
          {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': payload ? payload.length : 0
          },
          headers
        ),
        timeout
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (e) {
            /* 非 JSON 响应 */
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json === null ? { raw: text } : json);
          } else {
            const msg = (json && (json.error || json.message)) || `HTTP ${res.statusCode}`;
            reject(new Error(msg));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('连接超时，请检查 NAS 地址与网络')));
    req.on('error', (e) => reject(new Error(friendly(e))));
    if (payload) req.write(payload);
    req.end();
  });
}

function friendly(e) {
  const m = String((e && e.message) || e);
  if (m.includes('ECONNREFUSED')) return 'NAS 拒绝连接，请确认后端服务已启动、端口正确';
  if (m.includes('ENOTFOUND') || m.includes('EAI_AGAIN')) return '找不到 NAS 主机，请检查地址填写是否正确';
  if (m.includes('ETIMEDOUT')) return '连接超时，请确认设备与 NAS 在同一网络';
  if (m.includes('CERT')) return 'HTTPS 证书校验失败，可改用 http 或检查证书';
  return m;
}

function normBase(url) {
  let base = String(url || '').trim();
  if (!base) throw new Error('请先填写同步地址');
  if (!/^https?:\/\//i.test(base)) base = 'http://' + base;
  return base.replace(/\/+$/, '');
}

/**
 * 按 updated_at 合并两个集合，新者胜；败者另存为「（冲突副本）」。
 *
 * @param {Array} localArr  本机记录
 * @param {Array} remoteArr 从 NAS 拉回来的记录
 * @param {string} [scope]  这批记录属于哪张表（items / locations / categories）。
 *                          必须由调用方传进来：界面要拿冲突去「打开 / 删掉副本」，
 *                          只给一个 id 它不知道该开哪个编辑器、该调哪个删除接口。
 *                          这里不靠 id 前缀猜，猜错了会静默走错分支。
 * @returns {{merged: Array, conflicts: Array}}
 *   conflicts 每项：{ id, name, localName, scope, kind, conflictId, localAt, remoteAt }
 *   —— id 是胜出的那条（服务器版本）的 id，conflictId 才是副本的 id。
 *   —— localName 是「本机改的那份」原来的名字（没加后缀），
 *      界面用它告诉用户「用副本覆盖正本」到底会覆盖成什么。
 */
function mergeByUpdatedAt(localArr, remoteArr, scope) {
  const map = new Map();
  localArr.forEach((x) => map.set(x.id, x));
  const conflicts = [];
  remoteArr.forEach((r) => {
    const l = map.get(r.id);
    if (!l) {
      map.set(r.id, r);
      return;
    }
    const lt = l.updated_at || '';
    const rt = r.updated_at || '';
    if (rt > lt) {
      // 保留本地版本作为冲突副本，避免用户改动被静默覆盖
      // conflict_name 记住副本「原来的名字」：用户要是选择「用副本覆盖正本」，
      // 覆盖回去的名字必须不带「（冲突副本）」这个后缀，否则后缀会被同步到所有设备。
      const copy = Object.assign({}, l, {
        id: l.id + '-conflict-' + Date.now(),
        name: (l.name || '') + '（冲突副本）',
        conflict_name: l.name || '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      map.set(copy.id, copy);
      map.set(r.id, r);
      conflicts.push({
        id: r.id,
        name: r.name || l.name || '',
        localName: l.name || '',
        scope: scope || '',
        kind: r.kind || l.kind || '',
        conflictId: copy.id,
        localAt: lt,
        remoteAt: rt
      });
    }
  });
  return { merged: Array.from(map.values()), conflicts };
}

function createSync(store) {
  async function test(url) {
    const base = normBase(url);
    const info = await request(base + '/api/health');
    return info;
  }

  async function login(url, username, password, deviceName) {
    const base = normBase(url);
    const res = await request(base + '/api/login', {
      method: 'POST',
      body: { username, password, device: deviceName || '' }
    });
    if (!res.token) throw new Error('登录失败：未返回令牌');
    return res;
  }

  async function register(url, username, password) {
    const base = normBase(url);
    return request(base + '/api/register', { method: 'POST', body: { username, password } });
  }

  async function sync(payload) {
    const db = store.raw;
    const s = db.settings;
    const base = normBase(s.syncUrl);
    if (!s.syncToken) throw new Error('尚未登录，请先在同步设置中登录');

    const since = s.lastSyncAt || '1970-01-01T00:00:00.000Z';
    const isNew = (rec) => (rec.updated_at || '') > since;

    // 图片带全图（base64）单独取，平时不放在 db 里，避免 storage.json 变臃肿
    const pushImages = store.imagesSince ? store.imagesSince(since) : [];

    const push = {
      locations: db.locations.filter(isNew),
      items: db.items.filter(isNew),
      categories: db.categories.filter(isNew),
      images: pushImages
    };

    const res = await request(base + '/api/sync', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + s.syncToken,
        'X-Device': encodeURIComponent(s.deviceName || 'unknown')
      },
      body: {
        since,
        device: s.deviceName || '',
        push
      }
    });

    let conflicts = [];
    let imagesFailed = 0;
    if (res.pull) {
      const lr = mergeByUpdatedAt(db.locations, res.pull.locations || [], 'locations');
      const ir = mergeByUpdatedAt(db.items, res.pull.items || [], 'items');
      const cr = mergeByUpdatedAt(db.categories, res.pull.categories || [], 'categories');
      db.locations = lr.merged;
      db.items = ir.merged;
      db.categories = cr.merged;
      conflicts = [].concat(lr.conflicts, ir.conflicts, cr.conflicts);
      // 从服务端拉回来的墓碑可能是完整版（老版本客户端推的），顺手瘦一遍。
      // 放在这里而不是每次落盘 —— 只有这条路会引入外来墓碑，
      // 每次落盘都全表遍历一遍是白花的开销（见 store 里 compactTombstones 的说明）。
      if (store.compactTombstones) store.compactTombstones();
      // 图片按 updated_at 后写覆盖，并把全图落到本地文件。
      // 落盘失败的张数要带回给界面：只报「同步完成」的话，用户会看到
      // 一堆点开是空白的图，却不知道是本地空间不够。
      if (store.applyImages) {
        const ar = store.applyImages(res.pull.images || []);
        imagesFailed = ar && ar.failed ? ar.failed : 0;
      }
    }

    // 服务端一次最多返回 PULL_LIMIT 条。被截断时**不能**把进度推到 serverTime——
    // 中间那些没拉到的记录会永远拉不到（静默丢数据，用户只看到「同步成功」）。
    // 改成推进到「本批最后一条的时间」，下次同步从这里接着拉。
    const truncated = !!res.truncated;
    if (truncated && res.pullTo) {
      db.settings.lastSyncAt = res.pullTo;
    } else {
      db.settings.lastSyncAt = res.serverTime || new Date().toISOString();
    }
    store.saveNow();

    const pulledImages = res.pull && res.pull.images ? res.pull.images.length : 0;
    return {
      pushed: push.locations.length + push.items.length + push.categories.length + push.images.length,
      pulled:
        (res.pull ? (res.pull.locations || []).length + (res.pull.items || []).length + (res.pull.categories || []).length : 0) +
        pulledImages,
      images: { pushed: push.images.length, pulled: pulledImages },
      conflicts,
      // 有图片没能落到本地（一般是本地存储写满）：界面要单独提示，
      // 否则「同步完成」和「点开是空白图」对不上，用户查不出原因。
      imagesFailed,
      // 还有没拉完的数据，界面要提示用户再同步一次（不然用户以为已经全了）
      hasMore: truncated,
      serverTime: db.settings.lastSyncAt
    };
  }

  return { test, login, register, sync };
}

// mergeByUpdatedAt 单独导出，只为让测试能直接验证「合并后新字段不丢」。
// 它是纯函数（不进网络、不碰磁盘），没必要为了测它去起一个假服务端。
module.exports = { createSync, request, normBase, mergeByUpdatedAt };
