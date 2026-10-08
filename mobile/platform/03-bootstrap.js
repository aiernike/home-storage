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
