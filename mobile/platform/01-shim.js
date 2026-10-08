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
