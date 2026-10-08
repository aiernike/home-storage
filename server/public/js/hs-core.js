/* 家庭收纳 · 安卓端运行内核（由 mobile/build-mobile.js 自动生成，请勿手工修改） */
/* 组成：01-shim.js（适配层） + store.js（数据层） + sync.js（同步层） + isbn.js（图书查询） + 03-bootstrap.js（装配层） */
/* 对应桌面端版本：1.1.0 */
window.__HS_APP_VERSION__ = '1.1.0';

/* ==========================================================================
 * 家庭收纳 · 安卓端运行环境适配层
 * --------------------------------------------------------------------------
 * 目标：让桌面端的 store.js / sync.js 原封不动地跑在 Android WebView 里。
 *
 * 做法：这两份源码依赖 Node 的 fs / path / crypto / http / https，
 *       这里提供等价实现，再用一个迷你模块加载器把它们包起来。
 *       业务代码一行都不用改，桌面端行为也不受任何影响。
 *
 * 数据存在 localStorage（键名统一加 hs:file: 前缀）。
 * 家庭收纳的数据量级（几千条）远低于 5MB 上限。
 * ========================================================================== */

(function () {
  'use strict';

  /* ==================== 1. 虚拟文件系统（localStorage 承载） ==================== */

  var FILE_PREFIX = 'hs:file:';
  var QUOTA_HINT =
    '手机存储空间不足，数据保存失败。\n' +
    '请到「设置 → 导出备份」先备份数据，然后清理部分不用的物品记录。';

  /**
   * 存储写入失败的告警通道。
   *
   * 为什么需要它：数据层（store.js）的 flush() 会把写入异常捕获后只打一条
   * console.error，界面上完全看不出来。桌面端磁盘写失败是极少数情况，
   * 但手机的 localStorage 只有 5MB，写满是完全可能发生的——
   * 如果不管，用户会以为保存成功了，实际数据已经丢了（静默丢失最难排查）。
   * 所以这里额外走一条通道，把问题直接推到界面上。
   */
  function reportStorageError(message) {
    try {
      if (typeof window.__HS_STORAGE_ERROR__ === 'function') {
        window.__HS_STORAGE_ERROR__(message);
      }
    } catch (e) {
      /* 告警通道本身出错不能影响主流程 */
    }
    try {
      console.error('[家庭收纳] 数据写入失败：' + message);
    } catch (e) {}
  }

  var fs = {
    existsSync: function (p) {
      try {
        return localStorage.getItem(FILE_PREFIX + p) !== null;
      } catch (e) {
        return false;
      }
    },

    readFileSync: function (p) {
      var v = localStorage.getItem(FILE_PREFIX + p);
      if (v === null) {
        var err = new Error('ENOENT: no such file, open ' + p);
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },

    writeFileSync: function (p, data) {
      try {
        localStorage.setItem(FILE_PREFIX + p, String(data));
      } catch (e) {
        // 配额超限是可恢复的：用户导出备份后清理即可
        reportStorageError(QUOTA_HINT);
        var err = new Error(QUOTA_HINT);
        err.code = 'ENOSPC';
        throw err;
      }
    },

    copyFileSync: function (from, to) {
      var v = localStorage.getItem(FILE_PREFIX + from);
      if (v === null) throw new Error('ENOENT: ' + from);
      try {
        localStorage.setItem(FILE_PREFIX + to, v);
      } catch (e) {
        reportStorageError(QUOTA_HINT);
        var err = new Error(QUOTA_HINT);
        err.code = 'ENOSPC';
        throw err;
      }
    },

    renameSync: function (from, to) {
      var v = localStorage.getItem(FILE_PREFIX + from);
      if (v === null) throw new Error('ENOENT: ' + from);
      try {
        localStorage.setItem(FILE_PREFIX + to, v);
      } catch (e) {
        reportStorageError(QUOTA_HINT);
        var err = new Error(QUOTA_HINT);
        err.code = 'ENOSPC';
        throw err;
      }
      localStorage.removeItem(FILE_PREFIX + from);
    },

    unlinkSync: function (p) {
      localStorage.removeItem(FILE_PREFIX + p);
    },

    // 虚拟目录，无需真正创建
    mkdirSync: function () {},
    readdirSync: function () {
      return [];
    },
    statSync: function () {
      return { size: 0 };
    }
  };

  /* ==================== 2. path 适配 ==================== */

  var path = {
    join: function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        if (arguments[i]) parts.push(String(arguments[i]));
      }
      return parts.join('/').replace(/\/{2,}/g, '/');
    },
    resolve: function () {
      return path.join.apply(null, arguments);
    },
    dirname: function (p) {
      var s = String(p);
      var i = s.lastIndexOf('/');
      return i <= 0 ? '/' : s.slice(0, i);
    },
    basename: function (p) {
      var s = String(p);
      return s.slice(s.lastIndexOf('/') + 1);
    },
    sep: '/'
  };

  /* ==================== 3. crypto 适配 ==================== */

  function uuidFallback() {
    var b = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(b);
    } else {
      for (var i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0;
    }
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant
    var hex = '';
    for (var j = 0; j < 16; j++) hex += ('0' + b[j].toString(16)).slice(-2);
    return (
      hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) +
      '-' + hex.slice(16, 20) + '-' + hex.slice(20)
    );
  }

  var cryptoShim = {
    randomUUID: function () {
      // crypto.randomUUID 需要 Chrome 92+，老 WebView 上用降级实现
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
      return uuidFallback();
    }
  };

  /* ==================== 4. Buffer 适配（sync.js 用到） ==================== */

  function utf8Length(s) {
    // 计算 UTF-8 字节长度，用于 Content-Length
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  function Buf(str) {
    this._s = String(str);
    this.length = utf8Length(this._s);
  }
  Buf.prototype.toString = function () {
    return this._s;
  };

  var BufferShim = {
    from: function (data) {
      return new Buf(typeof data === 'string' ? data : String(data));
    },
    concat: function (arr) {
      var s = '';
      for (var i = 0; i < arr.length; i++) {
        var x = arr[i];
        s += x && typeof x.toString === 'function' ? x.toString() : String(x);
      }
      return new Buf(s);
    },
    isBuffer: function (x) {
      return x instanceof Buf;
    }
  };

  /* ==================== 5. http / https 适配 ==================== */
  /*
   * sync.js 只用了 Node http 的一个很小的子集：
   *   mod.request(options, cb) → req.on('timeout'|'error') / req.write() / req.end() / req.destroy()
   *   res.on('data') / res.on('end') / res.statusCode
   * 这里复刻这套事件接口，从而完整复用 sync.js 里的冲突合并逻辑。
   *
   * 为什么优先走原生通道（HSAndroid.http）而不是页面里的 fetch：
   *   页面本身跑在 https://hs.local 这个虚拟源上，而 NAS 后端是局域网 http://ip:port。
   *   直接用 fetch 会同时踩两个坑——
   *     1) 跨域：浏览器会先发 OPTIONS 预检，要求 NAS 返回 CORS 头；
   *     2) 混合内容：https 页面请求 http 资源会被 WebView 默认拦掉。
   *   交给原生 HttpURLConnection 发请求，这两个限制都不存在，
   *   局域网 http 也无需给 NAS 加任何证书或跨域配置。
   *   fetch 分支保留给「浏览器里直接打开调试」的场景。
   */

  var httpSeq = 0;
  var httpPending = {};

  // 原生回调入口：Java 侧拿到响应后调用它
  window.__HS_HTTP_DONE = function (id, res) {
    var cb = httpPending[id];
    if (!cb) return;
    delete httpPending[id];
    cb(res);
  };

  function makeHttpShim() {
    return {
      request: function (options, callback) {
        var listeners = { error: [], timeout: [] };
        var body = null;
        var finished = false;

        var port = options.port;
        var host = options.hostname + (port ? ':' + port : '');
        var target = options.protocol + '//' + host + (options.path || '/');

        function emit(name, arg) {
          var arr = listeners[name] || [];
          for (var i = 0; i < arr.length; i++) {
            try {
              arr[i](arg);
            } catch (e) {
              /* 单个监听器出错不影响其它 */
            }
          }
        }

        // 把「一段文本 + 状态码」包装成 Node 的 res 事件流
        function deliver(text, status) {
          var resShim = {
            statusCode: status,
            headers: {},
            on: function (ev, fn) {
              if (ev === 'data') {
                fn(text);
              } else if (ev === 'end') {
                setTimeout(fn, 0);
              }
              return resShim;
            }
          };
          callback(resShim);
        }

        // 把各种网络报错归类成 sync.js 的 friendly() 认识的错误码。
        //
        // 为什么不能只判断一句话：浏览器只给一句笼统的 "Failed to fetch"，
        // 真正的原因藏在 error.cause 里；而原生通道直接返回 Java 的异常文本。
        // 如果一律当成「拒绝连接」，用户地址填错时会看到「NAS 拒绝连接，
        // 请确认后端服务已启动」——方向完全错了，反而更难排查。
        function classifyNetworkError(text) {
          var all = String(text || '');
          if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|Unable to resolve host|找不到主机/i.test(all)) {
            return 'ENOTFOUND';
          }
          if (/ETIMEDOUT|timed? ?out|连接超时/i.test(all)) {
            return 'ETIMEDOUT';
          }
          if (/ECONNREFUSED|refused|拒绝连接/i.test(all)) {
            return 'ECONNREFUSED';
          }
          if (/Failed to fetch|NetworkError|Load failed|fetch failed|网络请求失败/i.test(all)) {
            return 'ECONNREFUSED';
          }
          return null;
        }

        function fail(text) {
          var code = classifyNetworkError(text);
          emit('error', new Error(code || String(text || '网络请求失败')));
        }

        var req = {
          on: function (ev, fn) {
            if (!listeners[ev]) listeners[ev] = [];
            listeners[ev].push(fn);
            return req;
          },
          write: function (chunk) {
            body = (body || '') + String(chunk);
            return true;
          },
          end: function () {
            if (finished) return;
            finished = true;

            var native = window.HSAndroid && typeof window.HSAndroid.http === 'function';

            if (native) {
              var id = 'h' + ++httpSeq;
              httpPending[id] = function (res) {
                if (!res) return fail('网络请求失败');
                if (!res.ok) return fail(res.error || '网络请求失败');
                deliver(res.body, res.status);
              };
              try {
                window.HSAndroid.http(
                  id,
                  options.method || 'GET',
                  target,
                  JSON.stringify(options.headers || {}),
                  body || '',
                  options.timeout || 15000
                );
              } catch (e) {
                delete httpPending[id];
                fail(String((e && e.message) || e));
              }
              return;
            }

            // —— 浏览器兜底：用 fetch 复刻同样的接口 ——
            var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            var timedOut = false;
            var timer = setTimeout(function () {
              timedOut = true;
              if (ctrl) ctrl.abort();
              emit('timeout');
            }, options.timeout || 15000);

            fetch(target, {
              method: options.method || 'GET',
              headers: options.headers || {},
              body: body || undefined,
              signal: ctrl ? ctrl.signal : undefined
            })
              .then(function (res) {
                clearTimeout(timer);
                return res.text().then(function (text) {
                  deliver(text, res.status);
                });
              })
              .catch(function (e) {
                clearTimeout(timer);
                if (timedOut) return; // 已经发过 timeout 事件
                // 浏览器把真实原因放在 cause 里（例如 ECONNREFUSED），要一起带上
                var raw = String((e && e.message) || 'network error');
                var cause = e && e.cause ? String(e.cause.message || e.cause.code || '') : '';
                fail(cause ? raw + ' ' + cause : raw);
              });
          },
          destroy: function (err) {
            finished = true;
            if (err) emit('error', err);
          },
          setTimeout: function () {}
        };
        return req;
      }
    };
  }

  /* ==================== 6. URL 适配 ==================== */

  var urlShim = { URL: window.URL };

  /* ==================== 7. 迷你模块加载器 ==================== */

  var __modules = {};   // name → 工厂函数
  var __cache = {};     // name → { exports }

  function __define(name, factory) {
    __modules[name] = factory;
  }

  function __require(name) {
    // 内置适配模块
    if (name === 'fs') return fs;
    if (name === 'path') return path;
    if (name === 'crypto') return cryptoShim;
    if (name === 'url') return urlShim;
    if (name === 'http' || name === 'https') return makeHttpShim();
    if (name === 'buffer') return { Buffer: BufferShim };

    // 业务模块
    if (__cache[name]) return __cache[name].exports;
    if (__modules[name]) {
      var m = { exports: {} };
      __cache[name] = m;
      __modules[name](__require, m, m.exports);
      return m.exports;
    }

    throw new Error('模块不可用：' + name);
  }

  // 暴露给后续片段使用
  window.__HS = {
    define: __define,
    require: __require,
    Buffer: BufferShim,
    FILE_PREFIX: FILE_PREFIX
  };

  /* ==================== 8. 补上业务代码依赖的全局对象 ==================== */
  /*
   * sync.js 里用的是「全局」Buffer（Buffer.from / Buffer.concat），
   * 而不是 require('buffer')，所以必须挂到全局作用域上，
   * 否则一执行登录或同步就会因为 Buffer 未定义而报错。
   * WebView 本身没有 Buffer，这里补上不会覆盖任何原生实现。
   */
  if (typeof window.Buffer === 'undefined') {
    window.Buffer = BufferShim;
  }
})();

/* ======================= store.js ======================= */
__HS.define('store', function (require, module, exports) {
'use strict';

/**
 * 纯 JS 轻量数据存储层
 * 设计要点：
 *  1. 零原生依赖 —— 不依赖 better-sqlite3，避免 Windows 编译问题
 *  2. 全量数据常驻内存（家庭收纳量级 < 5 万条，完全够用）
 *  3. 写入即落盘（原子写：先写 .tmp 再 rename）
 *  4. 每条记录带 updated_at / deleted / uuid，为增量同步做准备
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 2;

/**
 * 物品类型（kind）。三类共用同一张 items 表和同一套同步/搜索/统计逻辑，
 * 只是界面呈现的字段不同 —— 办公资料看「文件名称/类别/年度/金额」，书籍看「书名/作者/ISBN」。
 * 之所以不拆成三张表：拆了就要三套同步、三套搜索、三套统计，而它们的 90% 逻辑是一样的。
 */
const KINDS = ['goods', 'doc', 'book'];

function normalizeKind(k) {
  const v = String(k == null ? '' : k).trim();
  return KINDS.indexOf(v) >= 0 ? v : 'goods';
}

/**
 * 预置分类。第一个元素 key 是稳定标识：升级时按 key 判断「这个分类有没有」，
 * 缺了就补，已有的绝不覆盖 —— 用户改过的名字和颜色必须留住。
 * 所以 key 一旦发布就不能再改，改名字只改第二个元素。
 */
const PRESET_CATEGORIES = [
  // —— 生活基础（原有 8 个，顺序和 key 都不能动，否则老用户的分类顺序会乱）——
  ['食品', '食品饮料', '#D85A30'],
  ['药品', '药品保健', '#E24B4A'],
  ['日化', '洗护日化', '#378ADD'],
  ['清洁', '清洁用品', '#1D9E75'],
  ['五金', '五金工具', '#888780'],
  ['文具', '文具办公', '#7F77DD'],
  ['衣物', '衣物服饰', '#D4537E'],
  ['其他', '其他杂物', '#BA7517'],
  // —— 办公资料 ——
  ['合同', '合同协议', '#4A5BB5'],
  ['公文', '公文函件', '#5B7CC4'],
  ['人事', '人事档案', '#805AD5'],
  ['证照', '资质证照', '#2C7A7B'],
  ['培训', '培训资料', '#3E8FB0'],
  // —— 会计专用 ——
  ['记账', '记账凭证', '#3B6FD4'],
  ['账簿', '账簿报表', '#2F5FA8'],
  ['发票', '发票票据', '#C05621'],
  ['报税', '报税资料', '#8C6D1F'],
  ['银行', '银行单据', '#1A4E7A'],
  ['报销', '报销单据', '#A0522D'],
  // —— 书籍阅读 ——
  ['图书', '图书', '#6B5BD2'],
  ['教材', '教材教辅', '#9F7AEA'],
  ['期刊', '杂志期刊', '#B83280'],
  // —— 生活扩展 ——
  ['母婴', '母婴用品', '#ED64A6'],
  ['宠物', '宠物用品', '#D69E2E'],
  ['运动', '运动户外', '#38A169'],
  ['数码', '数码配件', '#2B6CB0'],
  ['手工', '手工艺品', '#DD6B20']
];

function uid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function createStore(userDataDir) {
  const dataDir = path.join(userDataDir, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'storage.json');
  const imagesDir = path.join(dataDir, 'images');

  // ---------------- 物品图片 ----------------
  // 设计：图片的「全图」单独存文件（体积大，不塞进 storage.json），
  // 只有小缩略图留在 db 里供列表显示。这样 storage.json 不会因为图片变臃肿，
  // 每次落盘也不用重写几 MB 的图片数据。
  // 手机端 fs 是 localStorage 适配层，路径同样有效（键名带前缀）。
  function imageFile(id) {
    return path.join(imagesDir, id + '.txt');
  }
  function readImageFull(id) {
    try {
      return fs.readFileSync(imageFile(id), 'utf8');
    } catch (e) {
      return '';
    }
  }
  /**
   * 写全图，返回是否成功。
   *
   * 为什么必须把结果交回调用方：全图在独立文件里，缩略图在 db 里。
   * 如果文件没写进去、db 里却记了一条，界面会显示缩略图、点开大图却是空白，
   * 而保存动作照样提示「已添加」——用户以为照片存上了，其实没有（静默半成功）。
   * 手机的 localStorage 只有 5MB，一张照片就可能写满，这不是理论问题。
   */
  function writeImageFull(id, dataUrl) {
    try {
      if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
      fs.writeFileSync(imageFile(id), String(dataUrl || ''), 'utf8');
      return true;
    } catch (e) {
      console.error('图片写入失败', e);
      return false;
    }
  }
  function removeImageFile(id) {
    try {
      fs.unlinkSync(imageFile(id));
    } catch (e) {
      /* 文件不存在就算了 */
    }
  }

  // ---------------- 墓碑（已删除的记录） ----------------

  /**
   * 墓碑只保留这几个字段。
   *
   * 为什么删除必须是软删除：同步靠「deleted:true 的记录」把删除动作带给其他设备，
   * 硬删的话对方永远不知道要删，下次同步还会把它推回来。
   *
   * 但整条留着会让数据文件永远缩不回去 —— 用户按「存储空间不足」的提示去删记录时，
   * 会发现空间几乎没释放（实测删掉 200 条，数据文件只少了 0.2%，
   * 因为本质上只是把 `"deleted":false` 改成了 `"deleted":true`）。
   * 所以删除时顺手瘦身：只留 id / name / updated_at / deleted。
   *
   * 语义完全不变：其他设备收到墓碑一样是软删，不会去读它的备注、条码、图片；
   * 保留 name 是为了用户导出备份时还能看出删掉的是什么。
   *
   * ⚠️ `key` 必须留着（分类的稳定标识）：升级时靠它判断「这个预置分类用户是不是
   * 已经删过了」，key 一丢，用户删掉的预置分类就会在下次升级时自己长回来。
   */
  const TOMBSTONE_KEEP = ['id', 'name', 'key', 'updated_at', 'deleted'];

  function tombstone(rec) {
    if (!rec || typeof rec !== 'object') return rec;
    Object.keys(rec).forEach((k) => {
      if (TOMBSTONE_KEEP.indexOf(k) < 0) delete rec[k];
    });
    return rec;
  }

  /**
   * 把库里还留着的「完整版」老墓碑瘦一遍。
   * 升级前删掉的记录是整条留下的，不清理的话它们会一直占着地方。
   * 返回瘦身过的条数。
   */
  function compactTombstones(d) {
    let n = 0;
    [d.items, d.locations, d.categories, d.images].forEach((arr) => {
      if (!Array.isArray(arr)) return;
      arr.forEach((rec) => {
        if (!rec || !rec.deleted) return;
        if (Object.keys(rec).length > TOMBSTONE_KEEP.length) {
          tombstone(rec);
          n++;
        }
      });
    });
    return n;
  }

  /**
   * 把读不动的数据文件改名留档，绝不静默丢弃。
   * 解析不了不等于没价值 —— 用户或技术支持还能从里面手工捞数据出来，
   * 而如果放任它留在原处，下一次落盘就会把它整个覆盖掉。
   */
  function quarantineCorrupt(file) {
    try {
      if (!fs.existsSync(file)) return '';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dest = file + '.corrupt-' + stamp;
      fs.renameSync(file, dest);
      return dest;
    } catch (e) {
      return '';
    }
  }

  function load() {
    const bak = dbFile + '.bak';

    // 主文件不见了但备份还在：多半是被误删、被同步软件搬走、被杀软隔离。
    // 这时候直接拿备份接着用，别默默开一个空库、把备份晾在一边。
    if (!fs.existsSync(dbFile)) {
      if (fs.existsSync(bak)) {
        try {
          const restored = migrate(JSON.parse(fs.readFileSync(bak, 'utf8')));
          console.error('主数据文件不存在，已从备份恢复');
          return restored;
        } catch (e) {
          console.error('主数据文件不存在且备份读取失败，新建空库', e);
          quarantineCorrupt(bak);
        }
      }
      return fresh();
    }

    try {
      return migrate(JSON.parse(fs.readFileSync(dbFile, 'utf8')));
    } catch (e) {
      console.error('数据库读取失败，尝试从备份恢复', e);
      if (fs.existsSync(bak)) {
        try {
          const restored = migrate(JSON.parse(fs.readFileSync(bak, 'utf8')));
          // 备份是好的、主文件是坏的：把坏文件挪走。
          // 留着它，下一次 flush 会「备份当前主文件」，把好不容易救回来的好备份盖坏。
          const kept = quarantineCorrupt(dbFile);
          console.error('已从备份恢复数据，损坏的主文件已留档为 ' + kept);
          return restored;
        } catch (e2) {
          console.error('备份也读取失败，新建空库', e2);
        }
      }
      // 两份都读不动：都留档，让用户还有机会人工挽救，绝不能覆盖
      quarantineCorrupt(dbFile);
      quarantineCorrupt(bak);
      console.error('主文件与备份都无法读取，已留档为 .corrupt-* 文件，本次以空库启动');
    }
    return fresh();
  }

  let db = load();

  function fresh() {
    const d = {
      schema: SCHEMA_VERSION,
      locations: [],
      items: [],
      categories: [],
      images: [],
      settings: {
        expiryWarnDays: 7,
        syncEnabled: false,
        syncUrl: '',
        syncToken: '',
        syncUser: '',
        deviceName: '',
        lastSyncAt: '',
        // 扫码枪前缀。默认留空 = 不启用：绝大多数家庭用户没有扫码枪，
        // 而启用后那个字符就没法在输入框里正常打出来了（见 util.js 的 createScannerWatcher），
        // 不该替用户默认开上。用的人自己到「设置」里填一个字符即可。
        scannerPrefix: ''
      },
      meta: { createdAt: now() }
    };
    seed(d);
    return d;
  }

  function migrate(raw) {
    if (!raw || typeof raw !== 'object') return fresh();
    const from = raw.schema || 1;
    raw.schema = from;
    raw.locations = raw.locations || [];
    raw.items = raw.items || [];
    raw.categories = raw.categories || [];
    raw.images = raw.images || [];
    raw.settings = Object.assign(
      {
        expiryWarnDays: 7,
        syncEnabled: false,
        syncUrl: '',
        syncToken: '',
        syncUser: '',
        deviceName: '',
        lastSyncAt: '',
        scannerPrefix: ''
      },
      raw.settings || {}
    );
    raw.meta = raw.meta || { createdAt: now() };
    if (!raw.locations.length && !raw.items.length) seed(raw);

    // v1 → v2：物品增加 类型(kind) / 图标(icon) / 内部编码(code) / 类型专属字段(extra)。
    // 老数据没有这些字段，就地补默认值，不迁移数据本身（都是可空字段，补默认即可）。
    if (from < 2) {
      raw.items.forEach((it) => {
        if (!it || typeof it !== 'object') return;
        it.kind = normalizeKind(it.kind);
        if (it.icon == null) it.icon = '';
        if (it.code == null) it.code = '';
        if (!it.extra || typeof it.extra !== 'object') it.extra = {};
      });
    }

    // 分类按 key 补齐（新增的办公/会计/书籍/生活分类）
    addMissingCategories(raw);

    raw.schema = SCHEMA_VERSION;
    return raw;
  }

  // 首次使用预置一套常见的家庭位置结构与分类，降低上手成本
  function seed(d) {
    const t = now();
    const mk = (name, parentId, icon, sort) => {
      const loc = {
        id: uid(),
        name,
        parent_id: parentId || null,
        icon: icon || '',
        note: '',
        sort: sort || 0,
        created_at: t,
        updated_at: t,
        deleted: false
      };
      d.locations.push(loc);
      return loc.id;
    };

    const kitchen = mk('厨房', null, 'kitchen', 0);
    const fridge = mk('冰箱', kitchen, 'fridge', 1);
    mk('冷藏室', fridge, '', 0);
    mk('冷冻室', fridge, '', 1);
    const cupboard = mk('橱柜', kitchen, 'cabinet', 2);
    mk('上层', cupboard, '', 0);
    mk('下层', cupboard, '', 1);

    const bath = mk('卫生间', null, 'bath', 10);
    const bathCab = mk('镜柜', bath, 'cabinet', 0);
    mk('第一层', bathCab, '', 0);
    mk('第二层', bathCab, '', 1);

    const store = mk('储藏室', null, 'storage', 20);
    const shelf = mk('置物架', store, 'shelf', 0);
    mk('A 区', shelf, '', 0);
    mk('B 区', shelf, '', 1);

    const bedroom = mk('卧室', null, 'bed', 30);
    mk('衣柜', bedroom, 'cabinet', 0);
    mk('床头柜', bedroom, 'drawer', 1);

    const living = mk('客厅', null, 'sofa', 40);
    mk('电视柜', living, 'drawer', 0);

    const cats = PRESET_CATEGORIES;
    cats.forEach(([key, name, color], i) => {
      d.categories.push({
        id: uid(),
        key,
        name,
        color,
        sort: i,
        created_at: t,
        updated_at: t,
        deleted: false
      });
    });
  }

  // 老库补齐：只补「还没有的 key」，已存在的（包括用户删掉的）一律不碰。
  // 这样升级后新增的办公/会计/书籍分类会自动出现，用户的自定义也不会被冲掉。
  function addMissingCategories(d) {
    if (!Array.isArray(d.categories)) d.categories = [];
    const have = new Set(d.categories.map((c) => c && c.key).filter(Boolean));
    const t = now();
    let sort = d.categories.reduce((m, c) => Math.max(m, (c && c.sort) || 0), -1) + 1;
    let added = 0;
    PRESET_CATEGORIES.forEach(([key, name, color]) => {
      if (have.has(key)) return;
      d.categories.push({
        id: uid(),
        key,
        name,
        color,
        sort: sort++,
        created_at: t,
        updated_at: t,
        deleted: false
      });
      added++;
    });
    return added;
  }

  let saveTimer = null;

  function save() {
    // 合并短时间内的多次写入，避免频繁 IO
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 120);
  }

  function flush() {
    saveTimer = null;
    try {
      // 落盘前统一瘦一遍墓碑。删除时已经瘦过了，这里是兜底：
      // 从服务端拉回来的墓碑可能是完整版（老版本客户端推的），
      // 不在这里清掉的话它们会一直占着地方。
      compactTombstones(db);
      const tmp = dbFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
      // 坏的主文件在 load() 里已经被挪走了，这里只会备份「可信的」主文件
      if (fs.existsSync(dbFile)) {
        fs.copyFileSync(dbFile, dbFile + '.bak');
      }
      fs.renameSync(tmp, dbFile);
    } catch (e) {
      console.error('数据保存失败', e);
    }
  }

  function saveNow() {
    if (saveTimer) clearTimeout(saveTimer);
    flush();
  }

  // ---------------- 工具函数 ----------------

  const live = (arr) => arr.filter((x) => !x.deleted);

  function touch(obj) {
    obj.updated_at = now();
    return obj;
  }

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const target = new Date(dateStr + 'T00:00:00');
    if (isNaN(target.getTime())) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((target - today) / 86400000);
  }

  function decorateItem(it) {
    const loc = it.location_id ? db.locations.find((l) => l.id === it.location_id) : null;
    const cat = it.category_id ? db.categories.find((c) => c.id === it.category_id) : null;
    const img = it.image_id ? db.images.find((x) => x.id === it.image_id && !x.deleted) : null;
    const dl = daysUntil(it.expiry_date);
    return Object.assign({}, it, {
      location_name: loc && !loc.deleted ? loc.name : '',
      location_path: loc && !loc.deleted ? locationPath(loc.id) : '',
      category_name: cat && !cat.deleted ? cat.name : '',
      category_color: cat && !cat.deleted ? cat.color : '#888780',
      // 分类的稳定 key：界面拿它给「没单独挑过图标」的物品兜底配一个图标。
      // 数据层不认识图标长什么样，只把 key 交出去，映射表在渲染层（icons.js）。
      cat_key: cat && !cat.deleted ? cat.key || '' : '',
      // 类型与图标：老数据可能没有，兜底成普通物品
      kind: normalizeKind(it.kind),
      icon: it.icon || '',
      code: it.code || '',
      // 类型专属字段（办公资料 / 书籍）：界面按 kind 决定渲染哪些
      extra: it.extra && typeof it.extra === 'object' ? it.extra : {},
      // 图片：只把「有没有图」和小缩略图带给界面，全图按需再取（images.data）
      image_id: img ? img.id : '',
      has_image: !!img,
      thumb: img ? img.thumb || '' : '',
      days_left: dl,
      expiry_state: dl === null ? 'none' : dl < 0 ? 'expired' : dl <= (db.settings.expiryWarnDays || 7) ? 'soon' : 'ok'
    });
  }

  function locationPath(id, sep) {
    sep = sep || ' / ';
    const names = [];
    let cur = db.locations.find((l) => l.id === id);
    let guard = 0;
    while (cur && guard++ < 20) {
      names.unshift(cur.name);
      cur = cur.parent_id ? db.locations.find((l) => l.id === cur.parent_id) : null;
    }
    return names.join(sep);
  }

  function barcodeList(item) {
    if (!item) return [];
    if (Array.isArray(item.barcodes) && item.barcodes.length) return item.barcodes;
    return item.barcode ? [item.barcode] : [];
  }

  // ---------------- 动作路由 ----------------

  const actions = {
    // ---- 总体 ----
    'app.summary': () => ({
      items: live(db.items).length,
      locations: live(db.locations).length,
      expired: live(db.items).filter((i) => daysUntil(i.expiry_date) !== null && daysUntil(i.expiry_date) < 0).length,
      soon: live(db.items).filter((i) => {
        const d = daysUntil(i.expiry_date);
        return d !== null && d >= 0 && d <= (db.settings.expiryWarnDays || 7);
      }).length,
      noLocation: live(db.items).filter((i) => !i.location_id).length,
      docs: live(db.items).filter((i) => normalizeKind(i.kind) === 'doc').length,
      books: live(db.items).filter((i) => normalizeKind(i.kind) === 'book').length,
      settings: db.settings
    }),

    'app.settings.get': () => db.settings,

    'app.settings.set': (p) => {
      Object.assign(db.settings, p || {});
      save();
      return db.settings;
    },

    'app.export': () => ({
      version: SCHEMA_VERSION,
      exported_at: now(),
      locations: db.locations,
      items: db.items,
      categories: db.categories,
      // 图片随备份一起导出（含全图），保证备份可完整恢复
      images: db.images.map((img) =>
        Object.assign({}, img, { full: img.deleted ? '' : readImageFull(img.id) })
      ),
      settings: db.settings
    }),

    'app.import': (p) => {
      const raw = p && p.data ? p.data : p;
      if (!raw || typeof raw !== 'object') throw new Error('数据格式不正确');
      const mode = p && p.mode === 'merge' ? 'merge' : 'replace';

      const ingestImages = (list, replace) => {
        const incoming = Array.isArray(list) ? list : [];
        if (replace) db.images = [];
        const seen = new Set(db.images.map((x) => x.id));
        let failed = 0;
        incoming.forEach((r) => {
          if (!r || !r.id) return;
          const rec = {
            id: r.id,
            item_id: r.item_id || null,
            thumb: r.thumb || '',
            w: Number(r.w) || 0,
            h: Number(r.h) || 0,
            created_at: r.created_at || now(),
            updated_at: r.updated_at || now(),
            deleted: !!r.deleted
          };
          if (replace || !seen.has(rec.id)) {
            db.images.push(rec);
            seen.add(rec.id);
          }
          // 全图写不进去就记一笔：导入完成后必须告诉用户有几张没进来。
          // 否则界面上有缩略图、点开是空白，用户只会以为「备份文件坏了」。
          if (!rec.deleted && r.full && !writeImageFull(rec.id, r.full)) failed++;
        });
        return failed;
      };

      let imagesFailed = 0;
      if (mode === 'replace') {
        // 先记下旧图片 id：replace 会把 db.images 整个换掉，
        // 不清理的话旧图片文件会永远留在 images 目录里（一张全图可能好几 MB，
        // 手机上还有存储配额，攒多了会写不进去）。
        const staleImageIds = db.images.map((x) => x.id);
        db.locations = raw.locations || [];
        db.items = raw.items || [];
        db.categories = raw.categories && raw.categories.length ? raw.categories : db.categories;
        imagesFailed = ingestImages(raw.images, true);
        if (raw.settings) Object.assign(db.settings, raw.settings);
        // 只删「旧库里不再被引用」的；刚导入进来的文件不能碰
        const keepImageIds = new Set(db.images.map((x) => x.id));
        staleImageIds.forEach((id) => {
          if (!keepImageIds.has(id)) removeImageFile(id);
        });
      } else {
        const seenLoc = new Set(db.locations.map((l) => l.id));
        (raw.locations || []).forEach((l) => {
          if (!seenLoc.has(l.id)) db.locations.push(l);
        });
        const seenItem = new Set(db.items.map((i) => i.id));
        (raw.items || []).forEach((i) => {
          if (!seenItem.has(i.id)) db.items.push(i);
        });
        imagesFailed = ingestImages(raw.images, false);
      }
      saveNow();
      // imagesFailed 要带出去：导入是用户主动发起的，图片没进来必须让他知道
      return Object.assign({}, actions['app.summary'](), { imagesFailed });
    },

    'app.wipe': () => {
      db = fresh();
      // 图片文件不在 db 里，要单独清理，否则会残留在数据目录
      try {
        if (fs.existsSync(imagesDir)) {
          fs.readdirSync(imagesDir).forEach((f) => {
            try {
              fs.unlinkSync(path.join(imagesDir, f));
            } catch (e) {}
          });
        }
      } catch (e) {}
      saveNow();
      return { ok: true };
    },

    // ---- 同步冲突：用副本覆盖正本 ----
    /**
     * 冲突是「两台设备各改了一份」。服务端按 updated_at 取了新的那份，本机改的
     * 那份另存成了「（冲突副本）」——但有时候本机这份才是用户想要的，只是它当时
     * 的时间戳比较旧。这个动作让他把副本的内容整份盖回正本。
     *
     * 必须是原子动作：拆成「删副本 + 存正本」两步的话，中间失败就会出现
     * 「副本没了、正本也没改」——用户的改动直接蒸发。所以这里只落一次盘。
     *
     * 覆盖是「整份替换」，不是增量合并：用户点的是「用这一份」，半合并出来的
     * 第三条记录他认不出来（extra 里混着两边的字段）。
     */
    'conflict.restore': (p) => {
      const scope = String((p && p.scope) || '');
      const arr =
        scope === 'locations' ? db.locations :
        scope === 'categories' ? db.categories :
        scope === 'items' ? db.items : null;
      if (!arr) throw new Error('未知的数据类型');

      const target = arr.find((x) => x.id === p.id);
      if (!target) throw new Error('找不到要覆盖的记录，可能已经被删掉了');
      const copy = arr.find((x) => x.id === p.conflictId);
      if (!copy || copy.deleted) throw new Error('找不到冲突副本，可能已经被删掉了');
      // 只认自己造出来的副本，否则这个动作会变成通用的「整条覆盖」接口，
      // 界面上一处参数接错就能悄悄拿别的记录盖掉这条。
      // 两个信号认一个就行：id 是正本 id 派生的，或者身上带着副本标记。
      // 只认 id 前缀太脆 —— sync.js 哪天换了命名，这个动作会整体失灵，
      // 而界面上按钮还在，用户点下去只会得到一句莫名其妙的报错。
      const looksLikeCopy =
        String(copy.id).indexOf(String(target.id) + '-conflict-') === 0 || !!copy.conflict_name;
      if (!looksLikeCopy) throw new Error('这不是冲突副本');

      // 名字要还原成副本记下的原名，不能把「（冲突副本）」后缀带回正本
      // ——否则下次同步，全设备都会看到一条叫「XX（冲突副本）」的正常记录。
      const restoredName = copy.conflict_name || String(copy.name || '').replace(/（冲突副本）$/, '');
      // 图片要先记下旧的：盖完就问不出「正本原来用的是哪张图」了
      const oldImageId = scope === 'items' ? target.image_id || '' : '';
      // 被覆盖那位的 updated_at 也要先记下：盖完就成了副本的时间戳，再问就晚了
      const prevAt = target.updated_at || '';

      Object.keys(target).forEach((k) => {
        if (k !== 'id' && k !== 'created_at') delete target[k];
      });
      Object.keys(copy).forEach((k) => {
        if (k !== 'id' && k !== 'created_at') target[k] = copy[k];
      });
      target.name = restoredName;
      delete target.conflict_name;
      target.deleted = false;
      /**
       * 覆盖后的时间戳必须严格新于被覆盖的那份。只写 now() 是不够的：
       * 服务端按 updated_at 判「谁更新」，两台设备的时钟不一定对得齐
       * （NAS 快几分钟很常见），本地时钟落后时，用户刚点的覆盖下次同步
       * 会被再判一次冲突、又冒出一个副本 —— 看起来就是「覆盖没生效」。
       */
      let t = now();
      const prevMs = Date.parse(prevAt);
      if (!isNaN(prevMs) && prevMs >= Date.parse(t)) {
        t = new Date(prevMs + 1).toISOString();
      }
      target.updated_at = t;

      // 副本用完就收掉：留着的话下次同步又会上传一份「（冲突副本）」
      copy.deleted = true;
      touch(copy);
      tombstone(copy);

      // 正本换了一张图，原来那张要是没人再引用，文件得跟着删
      // ——全图一张好几 MB，留着就是纯占地方
      if (oldImageId && oldImageId !== target.image_id) {
        const stillUsed = live(db.items).some((i) => i.image_id === oldImageId);
        if (!stillUsed) {
          const img = db.images.find((x) => x.id === oldImageId);
          if (img && !img.deleted) {
            img.deleted = true;
            img.thumb = '';
            touch(img);
            tombstone(img);
          }
          removeImageFile(oldImageId);
        }
      }

      save();
      return { ok: true, scope, id: target.id, name: target.name };
    },

    // ---- 位置 ----
    'locations.list': () => {
      const list = live(db.locations).map((l) => {
        const path = locationPath(l.id);
        const direct = live(db.items).filter((i) => i.location_id === l.id).length;
        return Object.assign({}, l, {
          path,
          depth: path.split(' / ').length - 1,
          item_count: direct,
          nfc_tag: l.nfc_tag || ''
        });
      });
      return list.sort((a, b) => {
        if (a.path === b.path) return 0;
        return a.path.localeCompare(b.path, 'zh-CN');
      });
    },

    'locations.tree': () => {
      const all = live(db.locations).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name, 'zh-CN'));
      const byParent = new Map();
      all.forEach((l) => {
        const key = l.parent_id || '__root__';
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(l);
      });
      const items = live(db.items);
      const build = (parentId, depth) => {
        const list = byParent.get(parentId || '__root__') || [];
        const out = [];
        list.forEach((l) => {
          const children = build(l.id, depth + 1);
          const direct = items.filter((i) => i.location_id === l.id).length;
          const total = direct + children.reduce((s, c) => s + c.total_count, 0);
          out.push(
            Object.assign({}, l, {
              depth,
              // path 供「上级位置」下拉等场景显示完整层级路径。
              // 不能省：渲染层从树上构建扁平列表，缺了它标签会变成 undefined。
              path: locationPath(l.id),
              direct_count: direct,
              total_count: total,
              nfc_tag: l.nfc_tag || '',
              children
            })
          );
        });
        return out;
      };
      return build(null, 0);
    },

    'locations.save': (p) => {
      const t = now();
      if (p.id) {
        const loc = db.locations.find((l) => l.id === p.id);
        if (!loc) throw new Error('位置不存在');
        if (p.parent_id && wouldCycle(p.id, p.parent_id)) throw new Error('不能移动到自己的下级位置');
        loc.name = p.name != null ? String(p.name).trim() : loc.name;
        loc.parent_id = p.parent_id !== undefined ? p.parent_id || null : loc.parent_id;
        loc.icon = p.icon !== undefined ? p.icon : loc.icon;
        loc.note = p.note !== undefined ? p.note : loc.note;
        if (p.sort !== undefined) loc.sort = Number(p.sort) || 0;
        touch(loc);
        save();
        return Object.assign({}, loc, { nfc_tag: loc.nfc_tag || '' });
      }
      if (!p.name || !String(p.name).trim()) throw new Error('请填写位置名称');
      const loc = {
        id: uid(),
        name: String(p.name).trim(),
        parent_id: p.parent_id || null,
        icon: p.icon || '',
        note: p.note || '',
        sort: Number(p.sort) || (live(db.locations).filter((l) => (l.parent_id || null) === (p.parent_id || null)).length),
        created_at: t,
        updated_at: t,
        deleted: false
      };
      db.locations.push(loc);
      save();
      return Object.assign({}, loc, { nfc_tag: loc.nfc_tag || '' });
    },

    'locations.delete': (p) => {
      const id = p.id;
      const loc = db.locations.find((l) => l.id === id);
      if (!loc) throw new Error('位置不存在');
      const child = live(db.locations).find((l) => l.parent_id === id);
      if (child) throw new Error(`该位置下有子位置「${child.name}」，请先处理`);
      const used = live(db.items).filter((i) => i.location_id === id);
      if (used.length && !p.force) {
        throw new Error(`该位置下还有 ${used.length} 件物品`);
      }
      if (used.length) {
        used.forEach((i) => {
          i.location_id = p.moveTo || null;
          touch(i);
        });
      }
      loc.deleted = true;
      touch(loc);
      tombstone(loc);
      save();
      return { ok: true, moved: used.length };
    },

    // ---- 位置与 NFC 标签绑定 ----
    // 设计：标签只是「位置的手柄」，用 UID 当标识，不往标签里写任何数据，
    // 所以最便宜的空白卡也能用；一个标签只能绑一个位置。
    'locations.bindNfc': (p) => {
      const loc = db.locations.find((l) => l.id === p.id);
      if (!loc) throw new Error('位置不存在');
      const tag = String(p.nfc_tag || '').trim().toUpperCase();
      if (!tag) throw new Error('标签 UID 不能为空');
      const clash = live(db.locations).find(
        (l) => l.id !== p.id && (l.nfc_tag || '').toUpperCase() === tag
      );
      if (clash) throw new Error(`该标签已绑定到「${locationPath(clash.id)}」，请先解绑`);
      loc.nfc_tag = tag;
      touch(loc);
      save();
      return Object.assign({}, loc, { nfc_tag: loc.nfc_tag });
    },

    'locations.unbindNfc': (p) => {
      const loc = db.locations.find((l) => l.id === p.id);
      if (!loc) throw new Error('位置不存在');
      loc.nfc_tag = '';
      touch(loc);
      save();
      return { ok: true };
    },

    'locations.byNfc': (p) => {
      const tag = String(p.nfc_tag || '').trim().toUpperCase();
      if (!tag) return null;
      const loc = live(db.locations).find((l) => (l.nfc_tag || '').toUpperCase() === tag);
      if (!loc) return null;
      const path = locationPath(loc.id);
      const direct = live(db.items).filter((i) => i.location_id === loc.id).length;
      return Object.assign({}, loc, {
        path,
        depth: path.split(' / ').length - 1,
        item_count: direct,
        nfc_tag: loc.nfc_tag || ''
      });
    },

    'locations.move': (p) => {
      const loc = db.locations.find((l) => l.id === p.id);
      if (!loc) throw new Error('位置不存在');
      if (p.parent_id && wouldCycle(p.id, p.parent_id)) throw new Error('不能移动到自己的下级位置');
      loc.parent_id = p.parent_id || null;
      touch(loc);
      save();
      return loc;
    },

    // ---- 分类 ----
    'categories.list': () => live(db.categories).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0)),

    'categories.save': (p) => {
      const t = now();
      if (p.id) {
        const c = db.categories.find((x) => x.id === p.id);
        if (!c) throw new Error('分类不存在');
        if (p.name != null) c.name = String(p.name).trim();
        if (p.color != null) c.color = p.color;
        touch(c);
        save();
        return c;
      }
      const c = {
        id: uid(),
        key: p.key || '',
        name: String(p.name || '').trim() || '新分类',
        color: p.color || '#888780',
        sort: live(db.categories).length,
        created_at: t,
        updated_at: t,
        deleted: false
      };
      db.categories.push(c);
      save();
      return c;
    },

    'categories.delete': (p) => {
      const c = db.categories.find((x) => x.id === p.id);
      if (!c) throw new Error('分类不存在');
      live(db.items).forEach((i) => {
        if (i.category_id === c.id) {
          i.category_id = null;
          touch(i);
        }
      });
      c.deleted = true;
      touch(c);
      tombstone(c);
      save();
      return { ok: true };
    },

    // ---- 物品 ----
    'items.list': (p) => {
      let list = live(db.items).map(decorateItem);
      const f = p || {};
      if (f.keyword) {
        const k = String(f.keyword).toLowerCase();
        list = list.filter(
          (i) =>
            (i.name || '').toLowerCase().includes(k) ||
            (i.barcode || '').toLowerCase().includes(k) ||
            (i.barcodes || []).some((b) => String(b).toLowerCase().includes(k)) ||
            (i.code || '').toLowerCase().includes(k) ||
            (i.note || '').toLowerCase().includes(k) ||
            (i.category_name || '').toLowerCase().includes(k) ||
            (i.location_path || '').toLowerCase().includes(k) ||
            // 类型专属字段也要能搜到：搜「张老师」「人民邮电」「2026」都要有结果
            Object.keys(i.extra || {}).some((key) => String(i.extra[key] || '').toLowerCase().includes(k))
        );
      }
      if (f.kind) {
        const kinds = Array.isArray(f.kind) ? f.kind : [f.kind];
        list = list.filter((i) => kinds.indexOf(i.kind) >= 0);
      }
      if (f.location_id) {
        const ids = subtreeIds(f.location_id);
        list = list.filter((i) => i.location_id && ids.has(i.location_id));
      }
      if (f.category_id) list = list.filter((i) => i.category_id === f.category_id);
      if (f.expiry === 'expired') list = list.filter((i) => i.expiry_state === 'expired');
      else if (f.expiry === 'soon') list = list.filter((i) => i.expiry_state === 'soon');
      else if (f.expiry === 'has') list = list.filter((i) => !!i.expiry_date);
      else if (f.expiry === 'none') list = list.filter((i) => !i.expiry_date);

      const sort = f.sort || 'updated_desc';
      const cmp = {
        updated_desc: (a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''),
        created_desc: (a, b) => (b.created_at || '').localeCompare(a.created_at || ''),
        name_asc: (a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN'),
        expiry_asc: (a, b) => {
          if (!a.expiry_date && !b.expiry_date) return 0;
          if (!a.expiry_date) return 1;
          if (!b.expiry_date) return -1;
          return a.expiry_date.localeCompare(b.expiry_date);
        },
        qty_desc: (a, b) => (Number(b.quantity) || 0) - (Number(a.quantity) || 0)
      }[sort];
      if (cmp) list.sort(cmp);
      return list;
    },

    'items.get': (p) => {
      const it = db.items.find((x) => x.id === p.id);
      if (!it || it.deleted) throw new Error('物品不存在');
      return decorateItem(it);
    },

    'items.byBarcode': (p) => {
      const code = String(p.barcode || '').trim();
      if (!code) return null;
      const it = live(db.items).find((i) => barcodeList(i).includes(code));
      return it ? decorateItem(it) : null;
    },

    // 按内部编码查（HS-2026-0001）。扫自己生成的二维码/条码时走这里。
    'items.byCode': (p) => {
      const code = String(p.code || '').trim().toUpperCase();
      if (!code) return null;
      const it = live(db.items).find((i) => String(i.code || '').toUpperCase() === code);
      return it ? decorateItem(it) : null;
    },

    // 生成下一个内部编码：HS-<年>-<4位流水>。
    // 流水号从当年已有的编码里推最大值 +1，删掉的记录也算（避免号码被复用后扫出旧记录）。
    'items.nextCode': (p) => {
      const prefix = String((p && p.prefix) || 'HS').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'HS';
      const year = new Date().getFullYear();
      const head = `${prefix}-${year}-`;
      const taken = new Set();
      let max = 0;
      live(db.items).forEach((i) => {
        const c = String(i.code || '').toUpperCase();
        if (!c) return;
        taken.add(c);
        if (c.startsWith(head)) {
          const n = parseInt(c.slice(head.length), 10);
          if (Number.isFinite(n) && n > max) max = n;
        }
      });
      let n = max + 1;
      let code = head + String(n).padStart(4, '0');
      // 兜底：万一有人手填过同号，继续往后找
      while (taken.has(code)) {
        n++;
        code = head + String(n).padStart(4, '0');
      }
      return { code, prefix, year, seq: n };
    },

    'items.save': (p) => {
      const t = now();
      const codes = normalizeBarcodes(p.barcodes, p.barcode);
      if (!p.id && !String(p.name || '').trim()) throw new Error('请填写物品名称');

      // 条码唯一性校验
      if (codes.length) {
        const dup = live(db.items).find(
          (i) => i.id !== p.id && barcodeList(i).some((b) => codes.includes(b))
        );
        if (dup) throw new Error(`条码已被「${dup.name}」占用`);
      }

      const code = p.code != null ? String(p.code).trim() : undefined;
      if (code) {
        const dupCode = live(db.items).find(
          (i) => i.id !== p.id && String(i.code || '').toUpperCase() === code.toUpperCase()
        );
        if (dupCode) throw new Error(`内部编码 ${code} 已被「${dupCode.name}」占用`);
      }

      const base = {
        name: p.name != null ? String(p.name).trim() : undefined,
        barcode: codes[0] || '',
        barcodes: codes,
        code: code,
        kind: p.kind != null ? normalizeKind(p.kind) : undefined,
        icon: p.icon != null ? String(p.icon) : undefined,
        category_id: p.category_id || null,
        location_id: p.location_id || null,
        quantity: p.quantity != null && p.quantity !== '' ? Number(p.quantity) || 0 : 1,
        unit: p.unit || '件',
        production_date: p.production_date || '',
        expiry_date: p.expiry_date || '',
        shelf_life_days: p.shelf_life_days != null ? Number(p.shelf_life_days) || 0 : 0,
        price: p.price != null && p.price !== '' ? Number(p.price) || 0 : 0,
        note: p.note || '',
        tags: Array.isArray(p.tags) ? p.tags : []
      };

      if (p.id) {
        const it = db.items.find((x) => x.id === p.id);
        if (!it) throw new Error('物品不存在');
        Object.keys(base).forEach((k) => {
          if (base[k] !== undefined) it[k] = base[k];
        });
        // extra 是增量合并：界面只改了「作者」，不能把「出版社」一起冲掉
        if (p.extra && typeof p.extra === 'object') {
          it.extra = Object.assign({}, it.extra || {}, p.extra);
        }
        if (!it.extra || typeof it.extra !== 'object') it.extra = {};
        it.kind = normalizeKind(it.kind);
        if (it.icon == null) it.icon = '';
        if (it.code == null) it.code = '';
        touch(it);
        save();
        return decorateItem(it);
      }

      const it = Object.assign(
        {
          id: uid(),
          created_at: t,
          updated_at: t,
          deleted: false
        },
        base
      );
      it.name = base.name || '未命名物品';
      it.kind = normalizeKind(base.kind);
      it.icon = base.icon || '';
      it.code = base.code || '';
      it.extra = p.extra && typeof p.extra === 'object' ? Object.assign({}, p.extra) : {};
      db.items.push(it);
      save();
      return decorateItem(it);
    },

    'items.delete': (p) => {
      const ids = Array.isArray(p.ids) ? p.ids : [p.id];
      let n = 0;
      ids.forEach((id) => {
        const it = db.items.find((x) => x.id === id);
        if (it && !it.deleted) {
          it.deleted = true;
          // 物品删了，它的图片也一并软删除并清理文件（同步会把删除动作带出去）
          if (it.image_id) {
            const img = db.images.find((x) => x.id === it.image_id);
            if (img) {
              img.deleted = true;
              img.thumb = '';
              touch(img);
              tombstone(img);
            }
            // 必须先删文件再瘦身 —— tombstone 会把 image_id 一起清掉
            removeImageFile(it.image_id);
          }
          touch(it);
          tombstone(it);
          n++;
        }
      });
      save();
      return { ok: true, count: n };
    },

    'items.consume': (p) => {
      const it = db.items.find((x) => x.id === p.id);
      if (!it || it.deleted) throw new Error('物品不存在');
      const delta = Number(p.delta) || -1;
      it.quantity = Math.max(0, (Number(it.quantity) || 0) + delta);
      if (!Array.isArray(it.logs)) it.logs = [];
      it.logs.push({ at: now(), delta, note: p.note || '' });
      touch(it);
      save();
      return decorateItem(it);
    },

    'items.move': (p) => {
      const ids = Array.isArray(p.ids) ? p.ids : [p.id];
      let n = 0;
      ids.forEach((id) => {
        const it = db.items.find((x) => x.id === id);
        if (it && !it.deleted) {
          it.location_id = p.location_id || null;
          touch(it);
          n++;
        }
      });
      save();
      return { ok: true, count: n };
    },

    'items.expiringSoon': (p) => {
      const days = p && p.days != null ? Number(p.days) : db.settings.expiryWarnDays || 7;
      return live(db.items)
        .map(decorateItem)
        .filter((i) => i.days_left !== null && i.days_left <= days)
        .sort((a, b) => a.days_left - b.days_left);
    },

    'items.stats': () => {
      const items = live(db.items).map(decorateItem);
      const byCat = {};
      items.forEach((i) => {
        const k = i.category_name || '未分类';
        byCat[k] = (byCat[k] || 0) + 1;
      });
      const byLoc = {};
      items.forEach((i) => {
        const k = i.location_path || '未指定位置';
        byLoc[k] = (byLoc[k] || 0) + 1;
      });
      const top = (obj, n) =>
        Object.entries(obj)
          .map(([name, value]) => ({ name, value }))
          .sort((a, b) => b.value - a.value)
          .slice(0, n);
      const totalValue = items.reduce((s, i) => s + (Number(i.price) || 0) * (Number(i.quantity) || 1), 0);

      // 按类型拆分：办公资料 / 书籍 是独立页面，统计里也要能单独看到体量
      const kinds = { goods: 0, doc: 0, book: 0 };
      items.forEach((i) => {
        const k = i.kind || 'goods';
        kinds[k] = (kinds[k] || 0) + 1;
      });

      // 近 6 个月的入库趋势
      const trend = [];
      const base = new Date();
      for (let m = 5; m >= 0; m--) {
        const d = new Date(base.getFullYear(), base.getMonth() - m, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        trend.push({ name: key.slice(5) + '月', value: live(db.items).filter((i) => (i.created_at || '').startsWith(key)).length });
      }
      return {
        total: items.length,
        totalQty: items.reduce((s, i) => s + (Number(i.quantity) || 0), 0),
        totalValue: Math.round(totalValue * 100) / 100,
        expired: items.filter((i) => i.expiry_state === 'expired').length,
        soon: items.filter((i) => i.expiry_state === 'soon').length,
        kinds,
        categories: top(byCat, 8),
        locations: top(byLoc, 8),
        trend
      };
    },

    // ---- 物品图片 ----
    // 一个物品最多一张图。全图写文件，缩略图留在 db（列表显示用）。
    'images.save': (p) => {
      const it = db.items.find((x) => x.id === p.item_id);
      if (!it || it.deleted) throw new Error('物品不存在');
      const full = String(p.full || '');
      const thumb = String(p.thumb || '');
      if (!full) throw new Error('图片数据为空');
      let img = it.image_id ? db.images.find((x) => x.id === it.image_id) : null;
      if (img && img.deleted) img = null;

      // 先把全图写进文件，写成功了再动数据库。
      // 顺序反过来（先改 db 再写文件）的话，写失败会留下「有缩略图、没有全图」的
      // 残缺记录：列表里看着有图、点开却是空白，保存还提示成功。宁可整条不保存。
      const id = img ? img.id : uid();
      if (!writeImageFull(id, full)) {
        // 这里不要带「图片保存失败」前缀，界面会自己加
        throw new Error('存储空间可能已满，请先导出备份并清理不用的图片');
      }

      const t = now();
      if (img) {
        img.thumb = thumb || img.thumb;
        img.w = Number(p.w) || img.w || 0;
        img.h = Number(p.h) || img.h || 0;
        img.deleted = false;
        touch(img);
      } else {
        img = {
          id,
          item_id: it.id,
          thumb,
          w: Number(p.w) || 0,
          h: Number(p.h) || 0,
          created_at: t,
          updated_at: t,
          deleted: false
        };
        db.images.push(img);
      }
      it.image_id = img.id;
      touch(it);
      save();
      return decorateItem(it);
    },

    'images.remove': (p) => {
      const it = db.items.find((x) => x.id === p.item_id);
      if (!it) throw new Error('物品不存在');
      if (it.image_id) {
        const img = db.images.find((x) => x.id === it.image_id);
        if (img) {
          img.deleted = true;
          img.thumb = '';
          touch(img);
          tombstone(img);
        }
        removeImageFile(it.image_id);
        it.image_id = null;
        touch(it);
        save();
      }
      return decorateItem(it);
    },

    // 取全图（按需加载，列表不带全图，避免响应过大）
    'images.data': (p) => {
      const img = db.images.find((x) => x.id === p.id);
      if (!img || img.deleted) throw new Error('图片不存在');
      return { id: img.id, full: readImageFull(img.id), thumb: img.thumb || '' };
    }
  };

  function normalizeBarcodes(list, single) {
    const out = [];
    const push = (v) => {
      const s = String(v == null ? '' : v).trim();
      if (s && !out.includes(s)) out.push(s);
    };
    if (Array.isArray(list)) list.forEach(push);
    if (single) push(single);
    return out;
  }

  function subtreeIds(rootId) {
    const set = new Set([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      live(db.locations).forEach((l) => {
        if (l.parent_id && set.has(l.parent_id) && !set.has(l.id)) {
          set.add(l.id);
          changed = true;
        }
      });
    }
    return set;
  }

  function wouldCycle(id, newParentId) {
    let cur = newParentId;
    let guard = 0;
    while (cur && guard++ < 50) {
      if (cur === id) return true;
      const p = db.locations.find((l) => l.id === cur);
      cur = p ? p.parent_id : null;
    }
    return false;
  }

  async function handle(action, payload) {
    const fn = actions[action];
    if (!fn) throw new Error('未知操作: ' + action);
    return fn(payload);
  }

  // 从老版本升上来的库里可能还留着「完整版」的老墓碑（以前删除时把整条记录都留下了），
  // 启动时清一次并落盘 —— 否则数据文件永远缩不回去，用户删了半天空间也不动。
  if (compactTombstones(db) > 0) saveNow();

  return {
    handle,
    get raw() {
      return db;
    },
    saveNow,
    reload() {
      db = load();
      return db;
    },
    dataFile: dbFile,

    // ---- 图片同步用：带全图的变更集 / 应用远端图片 ----
    // 图片的二进制（base64）只在同步时读取，平时不占 storage.json。
    imagesSince(since) {
      const out = [];
      db.images.forEach((img) => {
        if ((img.updated_at || '') <= since) return;
        out.push(Object.assign({}, img, { full: img.deleted ? '' : readImageFull(img.id) }));
      });
      return out;
    },

    applyImages(list) {
      let changed = false;
      let failed = 0;
      (list || []).forEach((r) => {
        if (!r || !r.id) return;
        const rt = r.updated_at || '';
        const cur = db.images.find((x) => x.id === r.id);
        if (cur && (cur.updated_at || '') >= rt) return;
        const rec = {
          id: r.id,
          item_id: r.item_id || null,
          thumb: r.thumb || '',
          w: Number(r.w) || 0,
          h: Number(r.h) || 0,
          created_at: r.created_at || now(),
          updated_at: rt || now(),
          deleted: !!r.deleted
        };
        if (cur) Object.assign(cur, rec);
        else db.images.push(rec);
        if (rec.deleted) removeImageFile(rec.id);
        else if (r.full && !writeImageFull(rec.id, r.full)) failed++;
        changed = true;
      });
      if (changed) saveNow();
      // failed 交回同步层：从 NAS 拉下来的图片存不上，用户也必须知道，
      // 不能只报「同步完成」然后留下一堆点开是空白的图。
      return { changed, failed };
    }
  };
}

module.exports = { createStore };

});

/* ======================= sync.js ======================= */
__HS.define('sync', function (require, module, exports) {
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

});

/* ======================= isbn.js ======================= */
__HS.define('isbn', function (require, module, exports) {
'use strict';
/**
 * ISBN 联网查询：扫到书背条码之后，把书名 / 作者 / 出版社 / 出版年补上。
 *
 * 这是**可选增强**，不是必需功能。断网、超时、接口改了、这本书网上就没有 ——
 * 任何一种都必须安静收场，绝不能挡住用户手动填表。所以这里一个异常都不往外抛，
 * 统一返回 `{ok:false, reason}`，让调用方自己决定要不要说点什么。
 *
 * 两个数据源，按顺序试：
 *   1. Open Library  —— 免费、无需 key、无速率限制。首选。
 *   2. Google Books  —— 1000 次/天无需 key，但请求太频繁会返回 429。兜底。
 *
 * 为什么没有中国本地的图书接口：国内没有可用的免费 ISBN 库（调研记录见 REFERENCE.md）。
 * 这两个源对中文书覆盖得也一般，所以「查到算赚、查不到很正常」是预期内的状态，
 * 界面上不会因为查不到而报错。
 */

/* ---------------- 纯函数：把两个源的响应规范化成同一个形状 ---------------- */

const str = (v) =>
  typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';

const num = (v) => {
  const n = Number(v);
  return isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/**
 * 读「人名/社名列表」。
 *
 * 为什么要同时认两种形式：Open Library 的两个端点格式不一样 ——
 * `api/books?jscmd=data` 给的是 `[{name:"..."}]`，而 `isbn/<isbn>.json` 给的是
 * `[{key:"/authors/OL...A"}]`（名字要再查一次）和 `["出版社"]`。写成只认一种，
 * 哪天换了端点就会「查到了却填不上」——而且不会报错，只是字段空着，很难发现。
 */
function names(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => {
      if (typeof x === 'string') return x;
      if (x && typeof x === 'object') return x.name || x.title || '';
      return '';
    })
    .map((s) => String(s).trim())
    .filter(Boolean);
}

/**
 * 从出版日期里取年份。
 * 实际见到的写法有 `2016` / `2016-05` / `2016-05-01` / `c2016` / `[2016]`，
 * 一律取一个**独立的**四位数字。
 *
 * 为什么要求「独立」（前后不能再挨着数字）：`12345` 这种串取前四位会得到 1234，
 * 看着像个年份，其实是别的编号。所以正则要求四位数字的两侧不是数字。
 */
function publishYear(s) {
  const m = String(s == null ? '' : s).match(/(?:^|[^\d])(\d{4})(?:[^\d]|$)/);
  if (!m) return 0;
  const y = Number(m[1]);
  // 明显不可能是出版年的（比如 ISBN 里的数字被误当成日期），宁可不要
  return y >= 1000 && y <= 2999 ? y : 0;
}

/**
 * 把用户输入/扫到的字符串整理成标准 ISBN。
 * 条码里有时带连字符或空格，也有扫成大写 X 的（ISBN-10 的校验位）。
 *
 * 不是 ISBN 就返回空串 —— 拿一个畸形字符串去请求只是白等一次超时。
 * 13 位只认 978 / 979 开头：977 开头的是**期刊条码（ISSN）**，图书库里根本没有，
 * 拿去查是白费一次请求，还会让用户以为「网上没这本书」。
 */
function normalizeIsbn(v) {
  const s = String(v == null ? '' : v)
    .replace(/[^0-9Xx]/g, '')
    .toUpperCase();
  if (s.length === 10) return s;
  if (s.length === 13 && (s.slice(0, 3) === '978' || s.slice(0, 3) === '979')) return s;
  return '';
}

/**
 * Open Library `api/books?bibkeys=ISBN:xxx&format=json&jscmd=data` 的响应。
 * 形状是 `{ "ISBN:9787...": { title, authors:[{name}], publishers:[{name}],
 * publish_date, number_of_pages } }`；**查不到时返回空对象 `{}`**。
 */
function parseOpenLibrary(json, isbn) {
  if (!json || typeof json !== 'object') return null;
  const rec = json['ISBN:' + isbn] || json['ISBN' + isbn];
  if (!rec || typeof rec !== 'object') return null;
  const title = str(rec.title);
  if (!title) return null;
  const publishDate = str(rec.publish_date);
  return {
    title,
    subtitle: str(rec.subtitle),
    authors: names(rec.authors),
    publisher: names(rec.publishers).join('、'),
    publishDate,
    publishYear: publishYear(publishDate),
    pages: num(rec.number_of_pages),
    isbn
  };
}

/**
 * Google Books `books/v1/volumes?q=isbn:xxx` 的响应。
 * 形状是 `{ totalItems, items:[{ volumeInfo:{ title, authors:[], publisher,
 * publishedDate, pageCount } }] }`；**查不到时 `items` 不存在**。
 */
function parseGoogleBooks(json, isbn) {
  const items = json && json.items;
  if (!Array.isArray(items) || !items.length) return null;
  const vi = items[0] && items[0].volumeInfo;
  if (!vi || typeof vi !== 'object') return null;
  const title = str(vi.title);
  if (!title) return null;
  const publishDate = str(vi.publishedDate);
  return {
    title,
    subtitle: str(vi.subtitle),
    authors: names(vi.authors),
    publisher: str(vi.publisher),
    publishDate,
    publishYear: publishYear(publishDate),
    pages: num(vi.pageCount),
    isbn
  };
}

const openLibraryUrl = (isbn) =>
  'https://openlibrary.org/api/books?bibkeys=ISBN:' + encodeURIComponent(isbn) + '&format=json&jscmd=data';

const googleBooksUrl = (isbn) =>
  'https://www.googleapis.com/books/v1/volumes?q=isbn:' + encodeURIComponent(isbn);

/* ---------------- 带外发的部分 ---------------- */

/**
 * 给错误分类。为什么要分：
 *   - `network` 才是「断网/超时」，用户该去查网络；
 *   - `http`    是「连上了，服务端说没有/出错」，跟网络无关；
 *   - `parse`   是「连上了，但回来的不是 JSON」（接口被网关拦了之类）。
 * 混在一起会让用户看到「网络有问题」而跑去重启路由器 —— 方向完全错了。
 */
function httpError(status) {
  const e = new Error('HTTP ' + status);
  e.status = status;
  e.kind = 'http';
  return e;
}
function parseError() {
  const e = new Error('返回的不是 JSON');
  e.kind = 'parse';
  return e;
}
function networkError(e) {
  const x = new Error(String((e && e.message) || e || '网络请求失败'));
  x.kind = 'network';
  return x;
}

/**
 * 建一个查询器。
 *
 * @param {{http: Object, https: Object, timeout?: number}} opts
 *   http/https 由调用方注入：桌面端是 Node 原生的，手机端是 01-shim.js 里那套
 *   （它复刻了 Node 的事件接口，所以这份代码两端共用，不用写两遍）。
 *   ⚠️ 这也意味着**这个文件不能依赖任何 Node 内置模块**（fs、path 之类），
 *   否则手机端加载不了 —— `mobile/build-mobile.js` 里有一条检查专门盯这个。
 * @returns {{lookup: (isbn: string) => Promise<{ok: boolean, reason?: string, book?: Object, source?: string}>}}
 *   reason 取值：'badisbn'（不是 ISBN）/ 'notfound'（连上了但没这本书）/ 'offline'（没连上）
 */
function createIsbnLookup(opts) {
  opts = opts || {};
  const http = opts.http;
  const https = opts.https;
  const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : 6000;

  function getJson(url) {
    return new Promise((resolve, reject) => {
      let req;
      try {
        const u = new URL(url);
        const mod = u.protocol === 'http:' ? http : https;
        req = mod.request(
          {
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port || null,
            path: u.pathname + u.search,
            method: 'GET',
            timeout,
            headers: {
              // 带上 UA：Open Library 对没有 UA 的请求会限流
              'User-Agent': 'home-storage/1.0',
              Accept: 'application/json'
            }
          },
          (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              // 把响应读完再拒，否则某些实现会卡住连接不放
              res.on('data', () => {});
              res.on('end', () => reject(httpError(res.statusCode)));
              return;
            }
            let body = '';
            res.on('data', (c) => {
              body += c;
            });
            res.on('end', () => {
              try {
                resolve(JSON.parse(body));
              } catch (e) {
                reject(parseError());
              }
            });
          }
        );
      } catch (e) {
        return reject(networkError(e));
      }
      req.on('error', (e) => reject(networkError(e)));
      req.on('timeout', () => {
        try {
          req.destroy();
        } catch (e) {
          /* 已经断了 */
        }
        reject(networkError(new Error('超时')));
      });
      req.end();
    });
  }

  // 什么才算「断网」：
  //   network    —— 连不上/超时，显然是网络问题
  //   http 5xx   —— 服务端故障，同样不是「这本书不存在」，不该让用户以为书没收录
  //   http 4xx   —— 连上了、服务端说没有 → 算「没这本书」
  //   parse      —— 连上了但回来的不是 JSON（网关拦截之类）→ 也算没拿到结果
  const isOffline = (e) =>
    !!e && (e.kind === 'network' || (e.kind === 'http' && e.status >= 500));

  return {
    async lookup(isbn) {
      const code = normalizeIsbn(isbn);
      if (!code) return { ok: false, reason: 'badisbn' };

      let offline = false;

      try {
        const book = parseOpenLibrary(await getJson(openLibraryUrl(code)), code);
        if (book) return { ok: true, book, source: 'openlibrary' };
      } catch (e) {
        // 连不上就**别再试第二个源** —— 那只会让用户白等第二个超时（6 秒 + 6 秒）。
        // 只有「连上了、只是没有这本书」才值得换个源再问一次。
        if (e && e.kind === 'network') return { ok: false, reason: 'offline' };
        if (isOffline(e)) offline = true;
      }

      try {
        const book = parseGoogleBooks(await getJson(googleBooksUrl(code)), code);
        if (book) return { ok: true, book, source: 'googlebooks' };
      } catch (e) {
        if (e && e.kind === 'network') return { ok: false, reason: 'offline' };
        if (isOffline(e)) offline = true;
      }

      // 断网时两个源都连不上，用户看到「没找到这本书」会以为是书的问题，
      // 所以这两种情况必须分开报（虽然界面上都不会弹错）。
      return { ok: false, reason: offline ? 'offline' : 'notfound' };
    }
  };
}

module.exports = {
  createIsbnLookup,
  // 纯函数也导出，方便单测直接喂 JSON
  parseOpenLibrary,
  parseGoogleBooks,
  publishYear,
  normalizeIsbn,
  names,
  openLibraryUrl,
  googleBooksUrl
};

});

/* ==========================================================================
 * 家庭收纳 · 安卓端引导层
 * --------------------------------------------------------------------------
 * 职责：把 store / sync 组装成渲染层认识的 window.api。
 *       桌面端是 Electron IPC，手机端是本地直调 + fetch。
 *       接口形状与 src/main/preload.js 完全一致，渲染层无需改动。
 * ========================================================================== */

(function () {
  'use strict';

  var HS = window.__HS;
  var require = HS.require;
  var VERSION = window.__HS_APP_VERSION__ || '1.0.0';

  // 虚拟数据目录（真实数据在 localStorage，路径仅用于展示）
  var VIRTUAL_HOME = '/home-storage';

  /* ==================== 1. 建数据层 ==================== */

  var store;
  try {
    store = require('store').createStore(VIRTUAL_HOME);
  } catch (e) {
    // 数据损坏时给出可操作的提示，而不是白屏
    document.body.innerHTML =
      '<div style="padding:28px;font-family:sans-serif;line-height:1.9;color:#1f1f1e">' +
      '<h2 style="margin:0 0 12px">数据读取失败</h2>' +
      '<p style="color:#5f5e5a">应用内部存储的数据可能已损坏。</p>' +
      '<pre style="background:#f5f5f3;padding:12px;border-radius:8px;overflow:auto;font-size:12px">' +
      String(e && e.message ? e.message : e) +
      '</pre>' +
      '<p style="color:#8f8e88;font-size:12px">如需帮助，请把上面这段信息发给我。</p>' +
      '</div>';
    return;
  }

  var sync;
  try {
    sync = require('sync').createSync(store);
  } catch (e) {
    sync = null;
    console.warn('同步模块加载失败：', e);
  }

  /* ==================== 2. 原生桥（由 MainActivity 注入） ==================== */

  function nativeBridge() {
    return window.HSAndroid || null;
  }

  /**
   * 弹一条提示，返回「是否真的送到了用户眼前」。
   *
   * 为什么要返回送达与否：存储告警靠它做节流（见下）。如果提示其实没送出去，
   * 节流窗口却已经被消耗，接下来 5 分钟就全是静默失败——手机 WebView
   * 没有控制台，用户永远查不出数据为什么没存上。
   */
  function toast(msg, kind, ms) {
    if (window.C && typeof window.C.toast === 'function') {
      window.C.toast(msg, kind || 'warn', ms || 4000);
      return true;
    }
    // 界面组件（components.js）还没就绪时不能只打日志：手机上看不到控制台。
    // 直接在页面上钉一条提示条，保证这类消息一定可见。
    // 必须带「知道了」按钮 —— 它是 position:fixed 钉在顶部的，没有关闭入口
    // 就会把搜索框和顶部按钮永久挡住，用户连「导出备份」都点不到。
    try {
      var bar = document.getElementById('hs-storage-warn');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'hs-storage-warn';
        bar.style.cssText =
          'position:fixed;left:0;right:0;top:0;z-index:99999;display:flex;' +
          'align-items:center;gap:12px;background:#c0392b;color:#fff;' +
          'padding:12px 16px;font-size:14px;line-height:1.6;';
        bar.innerHTML =
          '<span id="hs-storage-warn-text" style="flex:1"></span>' +
          '<button type="button" id="hs-storage-warn-close" style="flex:none;background:#fff;' +
          'color:#c0392b;border:0;border-radius:6px;padding:6px 12px;font-size:13px;' +
          'font-weight:600">知道了</button>';
        document.body.appendChild(bar);
        var closeBtn = document.getElementById('hs-storage-warn-close');
        if (closeBtn) {
          closeBtn.onclick = function () {
            try {
              document.body.removeChild(bar);
            } catch (e) {}
          };
        }
      }
      // 真实 DOM 里能拿到 span；测试沙箱的假 DOM 不解析 innerHTML，退回整条赋值
      var textEl = document.getElementById('hs-storage-warn-text');
      if (textEl) textEl.textContent = msg;
      else bar.textContent = msg;
      return true;
    } catch (e) {
      console.log(msg);
      return false;
    }
  }

  /**
   * 存储写满时的告警出口。
   * 适配层在 localStorage 写入失败时会调用它——因为数据层内部的 flush()
   * 会吞掉异常，不从这里冒出来用户根本不知道数据没存上。
   * 这里做一次节流，避免连续写入时提示刷屏。
   */
  var storageWarnedAt = 0;
  window.__HS_STORAGE_ERROR__ = function (detail) {
    var now = Date.now();
    if (now - storageWarnedAt < 5 * 60 * 1000) return;
    // 只有真的弹给用户看了才记账（理由见 toast 的注释）
    var delivered = toast(
      '手机存储空间不足，新数据没能保存。请先「导出备份」，再清理部分物品记录。',
      'err',
      8000
    );
    if (delivered) storageWarnedAt = now;
    console.error(detail);
  };

  /* ==================== 3. 组装 window.api ==================== */

  /**
   * 图书 ISBN 查询器。懒建一次就够了，不用每次扫书都重建。
   * http/https 用适配层那一套：它会优先走原生通道（HSAndroid.http），
   * 从而绕开 WebView 对「https 页面请求外部 http」的混合内容限制和跨域预检。
   */
  var isbnLookup = null;
  function getIsbnLookup() {
    if (!isbnLookup) {
      var mod = require('isbn');
      isbnLookup = mod.createIsbnLookup({
        http: require('http'),
        https: require('https'),
        timeout: 6000
      });
    }
    return isbnLookup;
  }

  /**
   * 把同步层的调用包成渲染层认识的形状（成功 `{ok:true, data}`、失败 `{ok:false, error}`）。
   * 等价于桌面端 main.js 里的 wrap()。细节与踩坑见下面 sync 那一段的注释。
   *
   * 用 `.then(onOk, onErr)` 而不是 `.catch()`：只兜住同步层自己的异常，
   * 万一 onOk 里再抛（不该发生），不该被误报成「同步失败」。
   */
  function wrapSync(fn) {
    return Promise.resolve()
      .then(fn)
      .then(
        function (data) {
          return { ok: true, data: data };
        },
        function (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      );
  }

  window.api = {
    call: async function (action, payload) {
      try {
        var data = await store.handle(action, payload || {});
        return { ok: true, data: data };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    },

    /**
     * 导出文件。优先交给安卓原生层写入「下载」目录，
     * 拿不到桥时退化为浏览器下载。
     */
    exportFile: async function (opts) {
      var name = (opts && opts.defaultName) || 'home-storage-backup.json';
      var content = (opts && opts.content) || '';
      var br = nativeBridge();

      if (br && typeof br.saveFile === 'function') {
        try {
          var path = br.saveFile(name, content);
          if (path) return { ok: true, filePath: path };
        } catch (e) {
          /* 落到下面的降级方案 */
        }
      }

      try {
        var blob = new Blob([content], { type: 'application/octet-stream' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () {
          URL.revokeObjectURL(url);
        }, 3000);
        return { ok: true, filePath: '下载目录 / ' + name };
      } catch (e) {
        return { ok: false, error: '导出失败：' + ((e && e.message) || e) };
      }
    },

    /** 选文件导入：WebView 里用原生文件选择器 */
    importFile: function () {
      return new Promise(function (resolve) {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.style.display = 'none';
        document.body.appendChild(input);

        var settled = false;
        function done(v) {
          if (settled) return;
          settled = true;
          try {
            document.body.removeChild(input);
          } catch (e) {}
          resolve(v);
        }

        input.onchange = function () {
          var f = input.files && input.files[0];
          if (!f) return done({ ok: false });
          var reader = new FileReader();
          reader.onload = function () {
            done({ ok: true, content: String(reader.result || '') });
          };
          reader.onerror = function () {
            done({ ok: false, error: '文件读取失败' });
          };
          reader.readAsText(f, 'utf-8');
        };

        // 用户点了取消：change 不会触发，用窗口重新获得焦点来兜底
        window.addEventListener(
          'focus',
          function () {
            setTimeout(function () {
              if (!input.files || !input.files.length) done({ ok: false });
            }, 800);
          },
          { once: true }
        );

        input.click();
      });
    },

    appInfo: async function () {
      // 同一份代码既跑在安卓 WebView 里，也跑在（PWA 的）普通浏览器里。
      // 报错平台名不会崩，但「设置」页会显示给用户看，所以按环境如实报。
      var onAndroid = !!(window.HSAndroid);
      return {
        version: VERSION,
        userData: onAndroid ? '手机应用内部存储' : '浏览器本地存储',
        platform: onAndroid ? 'android' : 'web'
      };
    },

    /** 手机上没有「打开文件夹」的概念，改为提示导出 */
    openPath: function () {
      toast('数据保存在手机应用内部存储中。要取出数据，请用「导出备份」。');
      return Promise.resolve();
    },

    notify: async function (opts) {
      var br = nativeBridge();
      if (br && typeof br.notify === 'function') {
        try {
          br.notify((opts && opts.title) || '家庭收纳', (opts && opts.body) || '');
          return { ok: true };
        } catch (e) {
          /* 降级 */
        }
      }
      try {
        if (window.Notification && Notification.permission === 'granted') {
          new Notification((opts && opts.title) || '家庭收纳', {
            body: (opts && opts.body) || ''
          });
          return { ok: true };
        }
      } catch (e) {}
      return { ok: false };
    },

    /**
     * 图书 ISBN 联网查询（可选增强）。
     *
     * 桌面端走主进程的原生 http/https；这里走 01-shim.js 那套适配层
     * （优先原生通道 HSAndroid.http，浏览器里退化为 fetch）。
     * 两边注入的是**同一份** src/main/isbn.js，逻辑不用写两遍。
     *
     * 失败一律返回 { ok:false, reason }，绝不抛 —— 断网必须能用。
     */
    lookupIsbn: async function (isbn) {
      try {
        return await getIsbnLookup().lookup(isbn);
      } catch (e) {
        return { ok: false, reason: 'offline' };
      }
    },

    /**
     * 同步四件套。形状必须和桌面端**一模一样**：成功 `{ok:true, data}`、
     * 失败 `{ok:false, error}`。
     *
     * 为什么非要包一层（涛哥报过「浏览器登录账号没反应」）：
     * 渲染层（views.js / app.js）两端共用，一律按 `r.ok` / `r.data` / `r.error` 取值。
     * 桌面端有 main.js 的 wrap() 兜着，手机/PWA 端原来是直接把 sync.js 的裸 Promise
     * 透出去，于是两条路都是「点了没反应」：
     *   登录成功 → 响应是 `{token}`，`r.ok` 是 undefined → 走失败分支，
     *              而 `r.error` 也是 undefined → 弹了个空提示，用户什么都看不到；
     *   登录失败 → sync.js 是**抛异常**，渲染层的 onclick 里没有 try/catch → 静默失败。
     * 顺带一提，/api/health 的响应体自己就带 `ok:true`，所以「健康检查」那条
     * 断言就算不包也照样绿 —— 是个假绿，别被它骗了。
     */
    sync: {
      test: function (url) {
        if (!sync) return Promise.resolve({ ok: false, error: '同步模块不可用' });
        return wrapSync(function () {
          return sync.test(url);
        });
      },
      login: function (opts) {
        if (!sync) return Promise.resolve({ ok: false, error: '同步模块不可用' });
        opts = opts || {};
        return wrapSync(function () {
          return sync.login(opts.url, opts.username, opts.password, opts.deviceName);
        });
      },
      register: function (opts) {
        if (!sync) return Promise.resolve({ ok: false, error: '同步模块不可用' });
        opts = opts || {};
        return wrapSync(function () {
          return sync.register(opts.url, opts.username, opts.password);
        });
      },
      run: function () {
        if (!sync) return Promise.resolve({ ok: false, error: '同步模块不可用' });
        return wrapSync(function () {
          return sync.sync();
        });
      }
    }
  };

  // 同步模块内部要读设置，把它挂到全局方便调试
  window.__hsStore = store;

  /* ==================== 4. NFC 桥接 ==================== */

  /**
   * 手机端「碰一碰」定位收纳位置。
   * 原生层（MainActivity）每次碰到标签都会调用 window.__hsOnNfc(json)，
   * 这里负责路由：如果页面正在「等待绑标签」就回传给编辑器，
   * 否则当作「碰一下看里面有什么」，按标签查到位置后跳到它的物品列表。
   *
   * 桌面端没有 NFC，nfc.supported() 永远返回 false，相关按钮不会显示。
   */
  window.api.nfc = {
    supported: function () {
      var br = nativeBridge();
      if (!br || typeof br.nfcSupported !== 'function') return false;
      try {
        return !!br.nfcSupported();
      } catch (e) {
        return false;
      }
    },
    // 进入「等待贴标签」模式：下一个碰到的标签会回传 cb(tag)
    waitForTag: function (cb) {
      window.__hsNfcPending = cb;
    },
    cancelWait: function () {
      window.__hsNfcPending = null;
    }
  };

  window.__hsOnNfc = function (payload) {
    var p;
    try {
      p = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch (e) {
      return;
    }
    if (!p || !p.uid) return;

    // 编辑器正在等标签 → 直接回传，不触发定位
    if (window.__hsNfcPending) {
      var cb = window.__hsNfcPending;
      window.__hsNfcPending = null;
      try {
        cb(p);
      } catch (e) {
        console.error(e);
      }
      return;
    }

    // 否则：碰一下 = 看这个位置里有什么
    if (window.__hsNfcLookup) {
      try {
        window.__hsNfcLookup(p);
      } catch (e) {
        console.error(e);
      }
    }
  };

  window.__hsNfcLookup = async function (p) {
    var r = await window.api.call('locations.byNfc', { nfc_tag: p.uid });
    if (!r.ok || !r.data) {
      if (window.App) App.toast('这个标签还没绑定收纳位置', 'warn', 3000);
      return;
    }
    if (window.App) {
      App.toast('已识别位置：' + r.data.path, 'ok', 2000);
      App.state.filters = Object.assign({}, App.state.filters, { location_id: r.data.id });
      App.goto('items', { keepFilters: true });
    }
  };

  /* ==================== 5. 移动端体验增强 ==================== */

  /*
   * 底部标签栏只放 5 个入口：总览 / 物品 / 扫码 / 位置 / 设置。
   *
   * 为什么从 9 个砍到 5 个：桌面版侧栏那 9 项里有 4 项在手机上**是重复的**——
   *   · 「办公资料」「图书」在数据层就是 kind 的取值，
   *     「保质期」就是 expiry_date 的筛选条件，
   *     这三项在物品页顶部都有一模一样的筛选 chip（类型 / 保质期），
   *     单独占一个底部标签纯属重复；
   *   · 「统计」的数字总览页已经全有了（物品总数/已过期/临期/未归位），
   *     总览页头部留了「统计」入口，降一级不影响可达性。
   * 剩下 5 项是真正互不重复的一级去处：总览（家底）、物品（清单）、
   * 扫码（录入）、位置（管理收纳位置，这是唯一入口）、设置（同步等）。
   *
   * 为什么是「从 DOM 里摘掉」而不是 CSS 隐藏：App.goto 靠遍历 .nav-item
   * 打高亮，元素还在的话，落到隐藏页时会去点亮一个看不见的标签，
   * 底栏一个都不亮，用户会以为没点动。摘掉之后 App.goto 会回退到父标签
   * （见 app.js 的 NAV_PARENT）。
   *
   * 摘掉的 4 个页面本身没删：data-view 和 Views 都还在，从总览/物品页
   * 的入口进去照常打开，桌面端更是原样保留 9 项。
   */
  var MOBILE_HIDDEN_VIEWS = ['docs', 'books', 'expiry', 'stats'];

  function pruneNavForMobile() {
    MOBILE_HIDDEN_VIEWS.forEach(function (v) {
      var el = document.querySelector('.nav-item[data-view="' + v + '"]');
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
  }

  /*
   * 剩下的 5 个标签也要换成短标签：桌面版的「物品清单」「扫码录入」「位置管理」
   * 在手机宽度下太挤。换成两三个字后 390px 屏宽 5 等分每格有 78px，
   * 比原来 9 等分每格 43px 宽松得多。
   *
   * 只改显示文字，data-view 不动，所以点击跳转和桌面端完全一致。
   * 标签一律控制在 2 个字以内，避免系统字体放大后换行把标签栏撑高一倍。
   */
  var SHORT_LABELS = {
    dashboard: '总览',
    items: '物品',
    docs: '资料',
    books: '图书',
    scan: '扫码',
    expiry: '效期',
    locations: '位置',
    stats: '统计',
    settings: '设置'
  };

  function shortenNavLabels() {
    var items = document.querySelectorAll('.nav-item');
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      var short = SHORT_LABELS[el.getAttribute('data-view')];
      if (!short) continue;
      // 标签文字是 .ni 图标之后那个文本节点，从后往前找第一个非空的
      for (var j = el.childNodes.length - 1; j >= 0; j--) {
        var node = el.childNodes[j];
        if (node.nodeType === 3 && String(node.nodeValue).replace(/\s/g, '') !== '') {
          node.nodeValue = short;
          break;
        }
      }
    }
  }

  /*
   * 极窄屏（320px 以下）或系统字体放大时，标签栏仍可能溢出变成可滑动。
   * 那时如果当前标签在屏幕外，用户点了「设置」却看不到高亮变化，会以为没生效。
   * 所以切换后把当前标签滚进可见区域——正常情况下这行是空操作。
   */
  function keepActiveTabVisible() {
    var el = document.querySelector('.nav-item.active');
    if (!el || typeof el.scrollIntoView !== 'function') return;
    try {
      el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    } catch (e) {
      /* 老版本 WebView 不支持带参数的 scrollIntoView，跳过即可 */
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    // 先摘掉手机端用不到的 4 个标签，再换短标签 —— 顺序反了会白改一遍
    pruneNavForMobile();
    shortenNavLabels();

    var nav = document.querySelector('.nav');
    if (nav) nav.addEventListener('click', function () { setTimeout(keepActiveTabVisible, 0); });
  });

  /* ==================== 6. 启动自检钩子 ==================== */

  // 供自动化测试使用：在浏览器/WebView 里注入 __HS_TEST=1 即可拿到结果
  if (window.__HS_TEST__) {
    window.__hsProbe = async function () {
      var out = {};
      try {
        var sum = await window.api.call('app.summary');
        out.summaryOk = sum.ok;
        out.items = sum.ok ? sum.data.items : -1;
        var tree = await window.api.call('locations.tree');
        out.treeOk = tree.ok;
        out.topLocations = tree.ok ? tree.data.map(function (n) { return n.name; }) : [];
        out.treeHasPath = tree.ok
          ? tree.data.every(function (n) { return typeof n.path === 'string' && n.path; })
          : false;
        var saved = await window.api.call('items.save', {
          name: '安卓自检物品',
          barcodes: ['6900000000001'],
          quantity: 2
        });
        out.saveOk = saved.ok;
        out.savedId = saved.ok ? saved.data.id : null;
        var found = await window.api.call('items.byBarcode', { barcode: '6900000000001' });
        out.lookupOk = !!(found.ok && found.data && found.data.name === '安卓自检物品');
        var stats = await window.api.call('items.stats');
        out.statsOk = stats.ok;
        var exp = await window.api.call('app.export');
        out.exportOk = exp.ok;
        out.appInfo = await window.api.appInfo();
        out.hasViews = typeof window.Views !== 'undefined';
        out.navItems = document.querySelectorAll('.nav-item').length;
        out.locNodes = document.querySelectorAll('#locTree .loc-node').length;
      } catch (e) {
        out.error = String((e && e.message) || e);
      }
      return out;
    };
  }
})();

