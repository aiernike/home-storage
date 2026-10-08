'use strict';

/*
 * 手机端底栏只有 5 个标签（总览/物品/扫码/位置/设置），
 * 「办公资料 / 图书 / 保质期 / 统计」被 03-bootstrap.js 从 DOM 里摘掉了 ——
 * 前三项在物品页有一模一样的筛选 chip，统计的数字总览页都有。
 *
 * 这几个页面本身还在，从总览/物品页的入口照样能打开。打开时底栏要有个亮着，
 * 否则用户会以为「点了没反应」。这张表就是「没有自己标签的页面 → 点亮哪个标签」。
 * 桌面端 9 个标签齐全，这张表用不上。
 */
const NAV_PARENT = {
  docs: 'items',      // 办公资料 = 物品页的类型筛选
  books: 'items',     // 图书     = 物品页的类型筛选
  expiry: 'items',    // 保质期   = 物品页的保质期筛选
  stats: 'dashboard'  // 统计     = 总览的数字展开
};

const App = {
  // 各页面（views.js）统一用 App.toast 弹提示，这里转发到组件层的实现。
  // 少了这一层，views.js 里那二十多处 App.toast 会直接抛 TypeError，
  // 表现为「点了按钮什么反应都没有」，且控制台报错。
  toast: (msg, type, ms) => C.toast(msg, type, ms),

  state: {
    view: 'dashboard',
    filters: {},
    keyword: '',
    locTreeOpen: {},
    locTree: [],
    locFlat: [],
    scanLog: []
  },

  /**
   * 启动。**只跑一次**，重复调用等的是同一份。
   *
   * 为什么必须挡住第二次：init 里挂的全是**全局**监听器（body 的点击委托、
   * document 的键盘）。这些跟 `el.onclick = ...` 不一样 —— 赋值是覆盖、幂等，
   * 而 addEventListener 是累积。挂两遍的后果是：点一次侧栏导航跳两次页、
   * 扫码枪扫一下出两条记录、搜索框的防抖实例变成两个。
   *
   * 真实运行里 init 由 DOMContentLoaded 触发一次，本来不会重入；但自动化测试
   * 会先手动 await 一次、DOMContentLoaded 再触发一次 —— 于是线上没暴露、
   * 测试里先炸（而且症状是「莫名其妙多了一条」，很难往这上面想）。
   * 重复调用返回同一个 Promise，这样手动那次和 DOMContentLoaded 那次
   * 都会等同一份跑完，谁先谁后都确定。
   */
  init() {
    if (!App._initPromise) App._initPromise = App._init();
    return App._initPromise;
  },

  async _init() {
    document.body.addEventListener('click', (e) => {
      const goto = e.target.closest('[data-goto]');
      if (goto) return App.goto(goto.dataset.goto);
      const act = e.target.closest('[data-act]');
      if (act) {
        const a = act.dataset.act;
        if (a === 'add-item') App.openItemEditor(null, { kind: 'goods' });
        if (a === 'add-doc') App.openItemEditor(null, { kind: 'doc' });
        if (a === 'add-book') App.openItemEditor(null, { kind: 'book' });
        if (a === 'add-loc') App.openLocEditor(null);
      }
    });

    // 兜底：任何没人接的 Promise 异常都要让用户看见。
    // 手机 WebView 没有控制台，静默失败就等于「点了没反应」——手机端 api.sync
    // 曾经没把结果包成 {ok,data}，登录抛的异常一路冒到 onclick 外面，
    // 用户点完「登录并保存」什么反应都没有，也查不出原因。
    // 这类问题不该再无声无息。（根因已修，这层只是保证「再犯也看得见」。）
    window.addEventListener('unhandledrejection', (e) => {
      const msg = String((e && e.reason && e.reason.message) || (e && e.reason) || '未知错误');
      try {
        if (C && typeof C.toast === 'function') C.toast('操作失败：' + msg, 'err', 5000);
        else console.error('未处理的异常：', msg);
      } catch (_) {
        /* 提示通道本身也不能再抛 */
      }
    });

    document.querySelectorAll('.nav-item').forEach((b) => {
      b.onclick = () => App.goto(b.dataset.view);
    });

    document.getElementById('modalMask').onclick = () => C.close();

    /**
     * 扫码枪识别器。懒重建：每次按键时比对一下当前设置里的前缀，
     * 变了就换一个 —— 这样用户在设置页改完前缀立刻生效，
     * 不需要再挂一个「设置变了」的回调（那种回调迟早会有人忘了调）。
     */
    let scanner = null;
    let scannerPrefix = null;
    const getScanner = () => {
      const p = String((App.state.settings && App.state.settings.scannerPrefix) || '');
      if (p !== scannerPrefix) {
        scannerPrefix = p;
        scanner = p ? U.createScannerWatcher({ prefix: p }) : null;
      }
      return scanner;
    };

    document.addEventListener('keydown', (e) => {
      // 扫码枪优先，而且要挂在**捕获**阶段：它得比输入框自己的监听先拿到事件，
      // 否则字符已经进了输入框，再拦就晚了。
      const sw = getScanner();
      if (sw) {
        const r = sw.feed(e.key, Date.now());
        if (r.armed) e.preventDefault();
        if (r.hit) {
          // preventDefault 只挡住「字符进输入框」这个默认动作，事件照样会往下传；
          // 不 stopPropagation 的话，扫码页手动输入框那儿的回车处理还会再跑一遍
          // （拿着已经被清空的输入框去查一次），等于白扫一次。
          e.preventDefault();
          e.stopPropagation();
          App.onScannerCode(r.code);
          return;
        }
      }
      if (e.key === 'Escape' && !document.getElementById('modalRoot').hidden) C.close();
      if (e.ctrlKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        document.getElementById('globalSearch').focus();
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        App.openItemEditor(null, { kind: 'goods' });
      }
    }, true);

    const search = document.getElementById('globalSearch');
    const clearBtn = document.getElementById('clearSearch');
    search.addEventListener(
      'input',
      U.debounce(() => {
        App.state.keyword = search.value.trim();
        clearBtn.hidden = !App.state.keyword;
        if (!App.state.keyword) {
          App.goto(App.state.view === 'docs' || App.state.view === 'books' ? App.state.view : 'items', { keepFilters: true });
          return;
        }
        // 在办公资料/图书页搜索时就地搜，不要把用户弹到别的页面去
        App.goto(App.state.view === 'docs' || App.state.view === 'books' ? App.state.view : 'search');
      }, 220)
    );
    clearBtn.onclick = () => {
      search.value = '';
      App.state.keyword = '';
      clearBtn.hidden = true;
      App.goto('items', { keepFilters: true });
    };

    document.getElementById('btnAddItem').onclick = () => App.openItemEditor(null, { kind: 'goods' });
    document.getElementById('btnQuickScan').onclick = () => App.goto('scan');
    document.getElementById('btnQuickLoc').onclick = () => App.openLocEditor(null);
    document.getElementById('btnSyncNow').onclick = () => App.doSync();

    await App.refreshSide();
    await App.goto('dashboard');

    // 启动时提示临期物品
    const ex = await window.api.call('items.expiringSoon', { days: 7 });
    const list = ex.data || [];
    if (list.length) {
      const expired = list.filter((i) => i.days_left < 0).length;
      const soon = list.length - expired;
      const msg = [expired ? `${expired} 件已过期` : '', soon ? `${soon} 件即将到期` : ''].filter(Boolean).join('，');
      C.toast(msg + '，点击左侧「保质期」查看', expired ? 'err' : 'warn', 5000);
    }
  },

  /**
   * 扫码枪扫到一条码（由 init 里的全局 keydown 调用）。
   *
   * 处理流程跟扫码页**完全一样** —— 二维码定位、内部编码开记录、ISBN 按图书录入、
   * 普通条码查重 —— 所以这里一个判断都不复制，只把 code 递过去。
   * 分开写两套的话，将来改扫码逻辑必然漏掉一边。
   *
   * `el` 传的是扫码页容器（哪怕当前不在扫码页）：它在文档里一直存在、只是 hidden，
   * 所以扫描记录照样累加进去，用户回头打开扫码页能看到这几条「扫码枪」来源的。
   * 从没进过扫码页时 #scanLog 还没渲染出来，_handleCode 那边会跳过日志那一段。
   */
  onScannerCode(code) {
    Views._handleCode(document.getElementById('view-scan'), App.state, code, '', '扫码枪');
  },

  async refreshSide() {
    const [treeRes, setRes] = await Promise.all([
      window.api.call('locations.tree'),
      window.api.call('app.settings.get')
    ]);
    App.state.locTree = treeRes.data || [];
    const st = setRes.data || {};
    // 设置整份存下来：扫码枪前缀、临期天数这些要随时读到，
    // 而且设置页改完前缀要立刻生效（keydown 处理里会比对它决定要不要重建识别器）
    App.state.settings = st;

    const chip = document.getElementById('syncChip');
    const text = document.getElementById('syncText');
    const sub = document.getElementById('brandSub');
    if (st.syncEnabled && st.syncToken) {
      chip.className = 'sync-chip on';
      text.textContent = st.lastSyncAt ? '已同步 ' + U.fmtTime(st.lastSyncAt) : '同步已开启';
      sub.textContent = st.deviceName ? '设备：' + st.deviceName : '已连接 NAS';
    } else {
      chip.className = 'sync-chip';
      text.textContent = '未开启同步';
      sub.textContent = '本地数据';
    }

    App._flatLoc = [];
    const walk = (nodes) => {
      nodes.forEach((n) => {
        App._flatLoc.push(n);
        if (n.children) walk(n.children);
      });
    };
    walk(App.state.locTree);

    const host = document.getElementById('locTree');
    if (!App.state.locTree.length) {
      host.innerHTML = '<div style="padding:10px 8px;font-size:12px;color:var(--text-3)">暂无位置，点击上方 ＋ 添加</div>';
      return;
    }
    const render = (nodes) => nodes
      .map((n) => {
        const hasChild = n.children && n.children.length;
        const open = App.state.locTreeOpen[n.id];
        return `
        <div>
          <div class="loc-node ${App.state.filters.location_id === n.id ? 'active' : ''}" data-loc="${n.id}" style="padding-left:${8 + n.depth * 13}px">
            <span class="caret ${open ? 'open' : ''}" data-toggle="${n.id}">${hasChild ? '▶' : ''}</span>
            <span class="loc-name" title="${U.esc(n.name)}">${U.esc(n.name)}</span>
            <span class="loc-count">${n.total_count || ''}</span>
          </div>
          ${hasChild ? `<div class="loc-children ${open ? 'open' : ''}">${render(n.children)}</div>` : ''}
        </div>`;
      })
      .join('');
    host.innerHTML = render(App.state.locTree);

    host.onclick = (e) => {
      const toggle = e.target.closest('[data-toggle]');
      if (toggle) {
        e.stopPropagation();
        const id = toggle.dataset.toggle;
        App.state.locTreeOpen[id] = !App.state.locTreeOpen[id];
        App.refreshSide();
        return;
      }
      const node = e.target.closest('[data-loc]');
      if (!node) return;
      const id = node.dataset.loc;
      const cur = App.state.filters.location_id;
      App.state.filters = Object.assign({}, App.state.filters, { location_id: cur === id ? null : id });
      App.state.locTreeOpen[id] = true;
      App.refreshSide();
      App.goto('items', { keepFilters: true });
    };
  },

  async refreshAll() {
    await App.refreshSide();
    await App.goto(App.state.view, { keepFilters: true });
  },

  async goto(view, opts) {
    opts = opts || {};
    if (view === 'search') view = 'items';
    const prev = App.state.view;
    App.state.view = view;
    // 列表类页面（物品/办公资料/图书）切进来时清掉上一个页面的筛选，
    // 但保留位置筛选 —— 从位置树点进来的场景要延续。
    if (!opts.keepFilters && (view === 'items' || view === 'docs' || view === 'books') && prev !== view) {
      App.state.filters = { location_id: App.state.filters.location_id || null };
    }

    // 只要「上一个页面是扫码页」就必须把扫码器停掉 —— 包括重新进入扫码页的情况。
    //
    // 为什么不能只在离开扫码页时才停：扫码后保存记录、或同步完成，都会调用
    // App.goto(App.state.view) 把当前页重新渲染一遍。这时旧的 <video> 会被
    // innerHTML 整个换掉，但 getUserMedia 拿到的摄像头流**不会**因为元素被移除
    // 而自动关闭 —— 流一旦泄漏，摄像头（和它的指示灯）就一直开着耗电，再点
    // 「启动摄像头」还会因为摄像头被自己占着而失败。更麻烦的是 _stopScanner
    // 随后会被新实例覆盖，那个旧流就再也停不掉了。
    if (App.state._stopScanner && prev === 'scan') {
      try {
        await App.state._stopScanner();
      } catch (e) {}
      App.state._stopScanner = null;
    }

    // 高亮底栏/侧栏当前页。手机端摘掉的 4 个页面没有自己的标签，
    // 回退到父标签（见文件顶部的 NAV_PARENT），否则底栏一个都不亮。
    // 桌面端 9 个标签都在，hasOwnTab 恒为真，行为与以前完全一致。
    const navTabs = document.querySelectorAll('.nav-item');
    const hasOwnTab = Array.prototype.some.call(navTabs, (b) => b.dataset.view === view);
    const navTarget = hasOwnTab ? view : (NAV_PARENT[view] || view);
    navTabs.forEach((b) => {
      b.classList.toggle('active', b.dataset.view === navTarget);
    });
    document.querySelectorAll('.view').forEach((v) => {
      v.hidden = v.id !== 'view-' + view;
    });

    const el = document.getElementById('view-' + view);
    if (!el) return;
    const fn = Views[view];
    if (!fn) return;
    el.innerHTML = '<div class="empty" style="padding:60px 20px;color:var(--text-3)">加载中…</div>';
    try {
      if (view === 'items' || view === 'docs' || view === 'books') {
        await App.renderItemsFiltered(el, view);
      } else {
        await fn(el, App.state);
      }
    } catch (e) {
      console.error(e);
      el.innerHTML = C.empty('⚠', '页面加载失败', String(e.message || e));
    }
  },

  // 物品清单支持全局搜索词过滤（办公资料页 / 图书页同理）
  async renderItemsFiltered(el, view) {
    view = view || 'items';
    const filters = Object.assign({}, App.state.filters);
    if (App.state.keyword) filters.keyword = App.state.keyword;
    const backup = App.state.filters;
    App.state.filters = filters;
    await Views[view](el, App.state);
    App.state.filters = Object.assign({}, backup);
  },

  pageTitleOf(v) {
    return v;
  },

  // ---------------- 物品行 ----------------
  itemRowHtml(i) {
    const qty = Number(i.quantity) || 0;
    // 注意：data-thumb 里放的是「图片 id」而不是物品 id —— 点缩略图要按图片 id
    // 去取全图（images.data），放物品 id 会取不到，点了没反应。
    // 没有照片时不留空白：给一个内置矢量图标，颜色沿用分类色，
    // 这样列表仍然能一眼看出「这是一盒药 / 这是一份合同」。
    const ico = window.ITEM_ICONS ? ITEM_ICONS.itemSvg(i, 22) : '';
    const lead = i.thumb && i.image_id
      ? `<img class="item-thumb" data-thumb="${i.image_id}" src="${U.esc(i.thumb)}" alt="" title="点击看大图">`
      : ico
        ? `<span class="item-ico" style="color:${U.esc(i.category_color || '#888780')}" title="${U.esc(i.category_name || U.kindLabel(i.kind))}">${ico}</span>`
        : `<span class="item-dot" style="background:${i.category_color || '#888780'}" title="${U.esc(i.category_name || '未分类')}"></span>`;
    return `<div class="item-row" data-item="${i.id}">
      ${lead}
      <div class="item-main">
        <div class="item-name"><span class="item-title">${U.esc(i.name)}</span>
          ${U.expiryTag(i)}
          ${i.tags && i.tags.length ? i.tags.map((t) => `<span class="tag tag-plain">${U.esc(t)}</span>`).join('') : ''}
        </div>
        <div class="item-meta">${App.itemMetaHtml(i)}</div>
      </div>
      <div class="item-right">
        <div class="qty-box" data-qty="${i.id}">
          <button data-minus="${i.id}" title="消耗一件">−</button>
          <span class="qty">${qty}${U.esc(i.unit || '')}</span>
          <button data-plus="${i.id}" title="增加一件">＋</button>
        </div>
        <button class="icon-btn" data-edititem="${i.id}" title="编辑">✎</button>
        <button class="icon-btn danger" data-delitem="${i.id}" title="删除">🗑</button>
      </div>
    </div>`;
  },

  /**
   * 列表第二行的信息。三类物品关心的东西不一样：
   * 办公资料看编号/年度/金额/保管期限，图书看作者/出版社/ISBN，普通物品看条码/到期。
   * 位置放最前面 —— 收纳软件里「放在哪」永远是第一信息。
   */
  itemMetaHtml(i) {
    const ex = i.extra || {};
    const parts = ['◱ ' + (i.location_path || '未指定位置')];
    if (i.kind === 'doc') {
      if (i.code) parts.push('编码 ' + i.code);
      if (ex.doc_no) parts.push('文号 ' + ex.doc_no);
      if (ex.year) parts.push(ex.year + ' 年度');
      if (ex.org) parts.push(ex.org);
      if (ex.amount) parts.push(U.fmtMoney(ex.amount) + ' 元');
      if (ex.keep_until) parts.push('保管至 ' + U.fmtDate(ex.keep_until));
    } else if (i.kind === 'book') {
      if (ex.author) parts.push(ex.author);
      if (ex.publisher) parts.push(ex.publisher);
      if (ex.pub_year) parts.push(ex.pub_year + ' 年');
      // 杂志走的是 977 开头的期刊条码，别一律叫成 ISBN
      if (i.barcode) parts.push((U.isIssnCode(i.barcode) ? 'ISSN ' : 'ISBN ') + i.barcode);
      if (ex.status) parts.push(ex.status);
    } else {
      if (i.code) parts.push('编码 ' + i.code);
      if (i.barcode) parts.push(i.barcode);
      if (i.expiry_date) parts.push('到期 ' + U.fmtDate(i.expiry_date));
    }
    if (i.note) parts.push(String(i.note).slice(0, 24));
    return parts.map((p) => `<span>${U.esc(p)}</span>`).join('');
  },

  handleRowClick(e) {
    const thumb = e.target.closest('[data-thumb]');
    if (thumb) return App.viewImage(thumb.dataset.thumb);
    const minus = e.target.closest('[data-minus]');
    const plus = e.target.closest('[data-plus]');
    const edit = e.target.closest('[data-edititem]');
    const del = e.target.closest('[data-delitem]');
    const row = e.target.closest('[data-item]');

    if (minus || plus) {
      const id = (minus || plus).dataset.minus || (plus || minus).dataset.plus;
      App.consume(id, plus ? 1 : -1);
      return;
    }
    if (edit) return App.openItemEditor(edit.dataset.edititem);
    if (del) return App.deleteItem(del.dataset.delitem);
    if (row) return App.openItemEditor(row.dataset.item);
  },

  async consume(id, delta) {
    const r = await window.api.call('items.consume', { id, delta });
    if (r.ok) {
      const it = r.data;
      C.toast(`${it.name} 数量更新为 ${it.quantity}${it.unit || ''}`, 'ok', 1600);
      if (it.quantity <= 0) {
        const ok = await C.confirm(`「${it.name}」数量已为 0，是否删除？`, { title: '物品用完', okText: '删除' });
        if (ok) {
          await window.api.call('items.delete', { id });
        }
      }
      App.refreshSide();
      App.goto(App.state.view, { keepFilters: true });
    } else C.toast(r.error, 'err');
  },

  async deleteItem(id) {
    const r = await window.api.call('items.get', { id });
    const name = r.ok ? r.data.name : '该物品';
    const ok = await C.confirm(`确定删除「${name}」吗？`, { title: '删除物品', danger: true, okText: '删除' });
    if (!ok) return;
    const d = await window.api.call('items.delete', { id });
    if (d.ok) {
      C.toast('已删除');
      App.refreshAll();
    } else C.toast(d.error, 'err');
  },

  // ---------------- 物品编辑 ----------------
  // 三类（普通物品 / 办公资料 / 图书）共用一个编辑器，只是字段不同。
  // 为什么不拆成三个函数：名称、分类、位置、数量、图片、二维码这些是共用的，
  // 拆开就要维护三份几乎一样的代码，改一处漏两处。
  /**
   * 扫到书背条码之后，联网把书名 / 作者 / 出版社 / 出版年补上。
   *
   * 三条硬规矩：
   *   1. **不阻塞**：表单已经打开了，查询在后台跑，查到了再往里填。
   *   2. **断网安静收场**：这是可选增强。断网、超时、接口挂了都不弹错 ——
   *      顶多在提示行里说一句，让用户知道为什么没自动填。
   *   3. **不覆盖用户已经填的**：用户手快先敲了书名，联网结果不许把它冲掉。
   */
  async _fillBookByIsbn(box, isbn) {
    const hint = box.querySelector('#isbnLookupHint');
    const say = (text, color) => {
      if (!hint) return;
      hint.textContent = text || '';
      hint.style.color = color || '';
    };
    // 别端的 api 可能没有这个方法：没有就当作「不联网」，安静跳过
    if (!window.api || typeof window.api.lookupIsbn !== 'function') return;

    say('正在联网查这本书…', 'var(--text-3)');
    let r = null;
    try {
      r = await window.api.lookupIsbn(isbn);
    } catch (e) {
      r = null;
    }
    // 查询期间用户可能已经把表单关了（甚至又开了另一个）。往一个已经脱离
    // 文档的节点里写东西不会报错，但提示行会「写」到一个不存在的地方去。
    if (!box.isConnected) return;

    if (!r || !r.ok) {
      // 断网 / 超时：什么都不说。用户本来就在手动填，多一句「网络有问题」
      // 只会让人以为软件坏了 —— 而这功能本来就不是必需的。
      // 「连上了但没有这本书」才值得说一句，因为它解释了「为什么没自动填」。
      say(r && r.reason === 'notfound' ? '网上没有这本书的信息，手动填一下吧' : '', 'var(--text-3)');
      return;
    }

    const b = r.book || {};
    const filled = [];
    // 只填**还空着**的字段。用户已经开始填了就以他为准 —— 联网结果只是帮手。
    const put = (key, val, label) => {
      if (!val) return;
      const el = box.querySelector(`[data-k="${key}"]`);
      if (!el || String(el.value || '').trim()) return;
      el.value = val;
      filled.push(label);
    };
    put('name', b.title, '书名');
    put('x_author', (b.authors || []).join('、'), '作者');
    put('x_publisher', b.publisher, '出版社');
    put('x_pub_year', b.publishYear || '', '出版年');

    if (!filled.length) {
      say('网上查到的信息你已经都填好了', 'var(--text-3)');
      return;
    }
    const from = r.source === 'googlebooks' ? 'Google Books' : 'Open Library';
    say(`已从 ${from} 补全：${filled.join('、')}（可自行修改）`, 'var(--green)');
  },

  async openItemEditor(id, preset) {
    preset = preset || {};
    let item = null;
    if (id) {
      const r = await window.api.call('items.get', { id });
      if (!r.ok) return C.toast(r.error, 'err');
      item = r.data;
    }
    const [locRes, catRes] = await Promise.all([
      window.api.call('locations.list'),
      window.api.call('categories.list')
    ]);
    const locs = locRes.data || [];
    const allCats = catRes.data || [];

    const kind = U.KINDS[(item && item.kind) || preset.kind] ? ((item && item.kind) || preset.kind) : 'goods';
    const meta = U.KINDS[kind];
    // 只列出这个栏目该用的分类，避免在「办公资料」里看到「宠物用品」
    const cats = U.catsForKind(allCats, kind);
    const ex = (item && item.extra) || {};

    const v = item || {
      name: '',
      barcode: preset.barcode || '',
      barcodes: preset.barcodes || (preset.barcode ? [preset.barcode] : []),
      code: preset.code || '',
      kind,
      icon: '',
      category_id: null,
      location_id: App.state.filters.location_id || null,
      quantity: 1,
      unit: meta.one,
      production_date: '',
      expiry_date: '',
      shelf_life_days: 0,
      price: '',
      note: '',
      tags: [],
      extra: {}
    };

    // 类型专属字段统一加 x_ 前缀，提交时按前缀摘出来塞进 extra。
    // 这样 C.form 的通用收集逻辑不用改，也不怕和通用字段重名。
    const extraFields = {
      doc: [
        { key: 'x_doc_no', label: '文件编号', value: ex.doc_no || '', placeholder: '单位内部文号，可留空' },
        { key: 'x_year', label: '会计年度', type: 'number', value: ex.year || '', placeholder: '如 2026' },
        { key: 'x_org', label: '来文 / 归档单位', value: ex.org || '' },
        { key: 'x_amount', label: '涉及金额（元）', type: 'number', min: 0, step: '0.01', value: ex.amount === 0 ? '' : ex.amount || '' },
        { key: 'x_keep_until', label: '保管期限至', type: 'dateshort', value: ex.keep_until || '', placeholder: '如 2031-12-31，或 +5y / 5年 / 1231 / x', hint: '这份资料该保存到哪天；办公资料页可以一键筛出已过保管期的。可以直接写「+5y」这种速记' }
      ],
      book: [
        { key: 'x_author', label: '作者', value: ex.author || '' },
        { key: 'x_publisher', label: '出版社', value: ex.publisher || '' },
        { key: 'x_pub_year', label: '出版年', type: 'number', value: ex.pub_year || '', placeholder: '如 2016' },
        {
          key: 'x_status',
          label: '阅读状态',
          type: 'select',
          value: ex.status || '未读',
          options: ['未读', '在读', '已读', '借出']
        }
      ],
      goods: []
    }[kind];

    // 条码字段随类型换名字：图书的条码就是 ISBN，没必要再给一个重复的输入框
    const codeField = kind === 'book'
      ? {
          key: 'barcodes',
          label: 'ISBN / ISSN',
          value: (v.barcodes || []).join(' , '),
          full: true,
          placeholder: '书背面 978 / 979 开头，或杂志封面 977 开头的 13 位数字',
          hint: '扫书背或杂志封面条码会自动填到这里；填了它就能在扫码页直接识别成图书'
        }
      : {
          key: 'barcodes',
          label: kind === 'doc' ? '条码 / 档案号' : '条码',
          value: (v.barcodes || []).join(' , '),
          full: true,
          placeholder: '多个条码用逗号分隔；可用扫码枪对着这里扫',
          hint: kind === 'doc'
            ? '没有条码也没关系，留空会自动生成一个内部编码'
            : '支持一个物品绑定多个条码（不同包装或不同渠道）'
        };

    const fields = [
      { key: 'name', label: meta.nameLabel, value: v.name, required: true, placeholder: meta.namePh, full: true },
      {
        key: 'icon',
        label: '图标',
        type: 'static',
        full: true,
        html: '<div class="icon-field" id="iconField"></div>'
      },
      codeField,
      {
        key: 'code',
        label: '内部编码',
        value: v.code || '',
        hint: '没有条码的东西靠它当身份标识（可打印成二维码贴上去）；留空会在保存时自动生成'
      },
      {
        key: 'category_id',
        label: kind === 'doc' ? '资料类别' : kind === 'book' ? '图书类别' : '分类',
        type: 'select',
        value: v.category_id || '',
        options: [{ value: '', label: '未分类' }].concat(cats.map((c) => ({ value: c.id, label: c.name })))
      },
      {
        key: 'location_id',
        label: '收纳位置',
        type: 'select',
        value: v.location_id || '',
        options: [{ value: '', label: '未指定' }].concat(locs.map((l) => ({ value: l.id, label: l.path })))
      },
      { key: 'quantity', label: kind === 'book' ? '册数' : kind === 'doc' ? '份数' : '数量', type: 'number', min: 0, value: v.quantity, step: '1' },
      { key: 'unit', label: '单位', value: v.unit || meta.one, placeholder: '件 / 瓶 / 盒 / 包' }
    ];

    // 保质期只对普通物品有意义；资料和图书换成各自的专属字段
    if (kind === 'goods') {
      fields.push(
        { key: 'production_date', label: '生产日期', type: 'dateshort', value: v.production_date || '', placeholder: '如 2026-05-17，或 -30天 / 0517', hint: '包装上印的日期。可以直接写「-30天」「0517」这类速记' },
        { key: 'shelf_life_days', label: '保质期（天）', type: 'number', min: 0, value: v.shelf_life_days || 0, hint: '填了生产日期+天数会自动算到期日' },
        { key: 'expiry_date', label: '到期日期', type: 'dateshort', value: v.expiry_date || '', placeholder: '如 2027-05-17，或 +1y / 3个月 / 0517', hint: '想写「一年后」就直接填 +1y；填 x 表示不设期限' }
      );
    } else {
      extraFields.forEach((f) => fields.push(f));
    }

    fields.push(
      { key: 'price', label: kind === 'book' ? '定价（元）' : '单价（元）', type: 'number', min: 0, step: '0.01', value: v.price === 0 ? '' : v.price || '' },
      { key: 'tags', label: '标签', value: (v.tags || []).join(' , '), placeholder: '多个标签用逗号分隔', full: true },
      { key: 'note', label: '备注', type: 'textarea', value: v.note || '', rows: 3, full: true, placeholder: '存放注意事项、用途等' }
    );

    await C.form({
      title: id ? '编辑' + meta.label : '新增' + meta.label,
      fields,
      wide: true,
      okText: id ? '保存修改' : '添加',
      extraHtml:
        `<div class="form-hint" id="expiryPreview" style="margin-top:10px"></div>` +
        // 联网查图书信息的提示行。只在「扫书背条码进来的」情况下才有意义，
        // 手填 ISBN 时不出现，免得每次开表单都多一行字。
        (preset.lookupIsbn ? `<div class="form-hint" id="isbnLookupHint"></div>` : ''),
      onMount: (box) => {
        const get = (k) => box.querySelector(`[data-k="${k}"]`);

        // 扫书背条码进来的：后台联网把书名/作者/出版社补上。
        // 不 await —— 表单已经开了，查询结果回来再往里填（见 _fillBookByIsbn）。
        if (preset.lookupIsbn) App._fillBookByIsbn(box, preset.lookupIsbn);

        // ---- 图标选择：静态占位行 → 点按钮弹图标库 ----
        let chosenIcon = (item && item.icon) || '';
        const iconField = box.querySelector('#iconField');
        const renderIconField = () => {
          if (!iconField) return;
          const shown = chosenIcon || (window.ITEM_ICONS ? ITEM_ICONS.forItem({
            icon: '',
            cat_key: '',
            kind
          }) : '');
          const auto = !chosenIcon;
          iconField.innerHTML =
            '<div class="icon-field-inner">' +
              '<span class="icon-chip">' + (window.ITEM_ICONS ? ITEM_ICONS.svg(shown, 26) : '') + '</span>' +
              '<div class="icon-field-text">' +
                '<div class="icon-field-name">' +
                  (auto ? '按分类自动：' + (window.ITEM_ICONS ? ITEM_ICONS.name(shown) : '') : '已选择：' + (window.ITEM_ICONS ? ITEM_ICONS.name(shown) : '')) +
                '</div>' +
                '<div class="form-hint" style="margin:0">列表里没有照片时显示这个图标</div>' +
              '</div>' +
              '<button class="btn btn-sm" id="btnPickIcon" type="button">选择图标</button>' +
              (chosenIcon ? '<button class="btn btn-sm" id="btnAutoIcon" type="button">用分类默认</button>' : '') +
            '</div>';
          const b = iconField.querySelector('#btnPickIcon');
          if (b) {
            b.onclick = async () => {
              const picked = await App.pickIcon(chosenIcon);
              if (picked === null) return; // 取消
              chosenIcon = picked;
              renderIconField();
            };
          }
          const a = iconField.querySelector('#btnAutoIcon');
          if (a) a.onclick = () => { chosenIcon = ''; renderIconField(); };
        };
        renderIconField();

        // ---- 内部编码：输入框和「生成编码」并排放，别把按钮挤到提示文字下面 ----
        const codeEl = get('code');
        if (codeEl) {
          const wrap = document.createElement('div');
          wrap.className = 'inline-field';
          codeEl.parentNode.insertBefore(wrap, codeEl);
          wrap.appendChild(codeEl);
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn btn-sm';
          btn.textContent = '生成编码';
          btn.onclick = async () => {
            const r = await window.api.call('items.nextCode');
            if (r.ok) {
              codeEl.value = r.data.code;
              C.toast('已生成 ' + r.data.code, 'ok', 1600);
            } else C.toast(r.error, 'err');
          };
          wrap.appendChild(btn);
        }

        // ---- 物品图片：拍照/选图 → 压缩出缩略图 ----
        let pending = null;      // 新选/新拍的图 {full, thumb, w, h}
        let removed = false;     // 是否点了「移除」
        const existingImageId = item ? item.image_id || '' : '';

        const imgRow = document.createElement('div');
        imgRow.className = 'form-row full';
        imgRow.innerHTML =
          '<label class="form-label">' + (kind === 'book' ? '封面照片' : kind === 'doc' ? '文件照片' : '物品图片') + '</label>' +
          '<div class="img-edit">' +
            '<div class="img-preview" id="imgPreview"></div>' +
            '<div class="img-actions">' +
              '<button class="btn btn-sm" id="btnPickImg" type="button">拍照 / 选图</button>' +
              '<button class="btn btn-sm" id="btnViewImg" type="button" hidden>看大图</button>' +
              '<button class="btn btn-sm btn-danger" id="btnRemoveImg" type="button" hidden>移除</button>' +
              '<input type="file" id="imgFile" accept="image/*" capture="environment" hidden>' +
            '</div>' +
            '<div class="form-hint" id="imgHint">拍张照，列表里会显示缩略图，点缩略图可看大图</div>' +
          '</div>';
        // 放在「图标」行后面：先决定用图标还是用照片，再决定照片
        const iconRow = iconField ? iconField.closest('.form-row') : null;
        const nameRow = get('name') && get('name').closest('.form-row');
        const anchor = iconRow || nameRow;
        if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(imgRow, anchor.nextSibling);

        const preview = box.querySelector('#imgPreview');
        const btnView = box.querySelector('#btnViewImg');
        const btnRemove = box.querySelector('#btnRemoveImg');
        const hint = box.querySelector('#imgHint');
        const renderImg = () => {
          const src = pending ? pending.thumb : (removed ? '' : (item && item.thumb) || '');
          preview.innerHTML = src ? '<img src="' + U.esc(src) + '" alt="">' : '<span class="img-ph">暂无图片</span>';
          btnView.hidden = !src;
          btnRemove.hidden = !src;
        };
        renderImg();

        box.querySelector('#btnPickImg').onclick = () => box.querySelector('#imgFile').click();
        box.querySelector('#imgFile').onchange = async (e) => {
          const file = e.target.files && e.target.files[0];
          e.target.value = '';
          if (!file) return;
          hint.textContent = '正在处理图片…';
          try {
            pending = await App._compressImage(file);
            removed = false;
            renderImg();
            hint.textContent = '已生成缩略图，保存后生效';
          } catch (err) {
            hint.textContent = '图片处理失败：' + ((err && err.message) || err);
          }
        };
        btnRemove.onclick = () => {
          pending = null;
          removed = true;
          renderImg();
          hint.textContent = '已标记移除，保存后生效';
        };
        btnView.onclick = () => {
          if (pending) App._showImageModal(pending.full, '物品图片');
          else if (existingImageId && !removed) App.viewImage(existingImageId);
        };
        preview.onclick = () => {
          if (!btnView.hidden) btnView.click();
        };

        // 编辑已有物品时，提供「生成二维码」——打印贴上去，扫码可直接打开这件物品
        if (id) {
          const foot = box.querySelector('.modal-foot');
          if (foot && window.QR) {
            const qb = document.createElement('button');
            qb.className = 'btn btn-sm';
            qb.type = 'button';
            qb.textContent = '生成二维码';
            qb.style.marginRight = 'auto';
            qb.onclick = () =>
              App.showQr({
                type: 'item',
                id,
                name: item ? item.name : '',
                code: item ? item.code : '',
                title: '物品二维码',
                subtitle: item ? item.name : ''
              });
            foot.insertBefore(qb, foot.firstChild);
          }
        }

        // 保质期联动只对普通物品存在；资料/图书没有这两个输入框，
        // 不加这层判断会直接 get(...).addEventListener of null 报错，弹窗点不开。
        const pdEl = get('production_date');
        const daysEl = get('shelf_life_days');
        if (pdEl && daysEl) {
          const sync = () => {
            // 生产日期是速记输入框：用户可能刚敲完「-30天」还没离开输入框，
            // 直接读 .value 会拿到那串字，算出来的到期日就是空的（静默不生效）。
            const pd = U.dateValue(pdEl.value);
            const days = Number(daysEl.value) || 0;
            const ed = get('expiry_date');
            if (pd && days && ed) {
              const calc = U.calcExpiry(pd, days);
              if (calc && ed.value !== calc) {
                ed.value = calc;
                box.querySelector('#expiryPreview').textContent = `已根据生产日期与保质期自动计算到期日：${calc}`;
              }
            }
          };
          pdEl.addEventListener('change', sync);
          daysEl.addEventListener('input', sync);
        }

        const nameEl = get('name');
        const bcEl = get('barcodes');
        const updateInfo = () => {
          const c = (bcEl.value || '').split(',')[0].trim();
          if (!c) return;
          // ISBN / 期刊条码别报成「EAN-13 校验位正确」——对用户来说它就是 ISBN / ISSN
          if (kind === 'book' && U.isBookCode(c)) {
            box.querySelector('#expiryPreview').textContent = U.isIssnCode(c)
              ? '期刊条码（ISSN）格式正确，扫杂志封面上的条码可直接识别成图书'
              : 'ISBN 格式正确，扫书背条码可直接识别成图书';
            return;
          }
          const t = U.barcodeType(c);
          const chk = U.validateEan(c);
          box.querySelector('#expiryPreview').textContent =
            `条码类型：${t}${chk.valid === true ? '（校验位正确）' : chk.valid === false ? `（${chk.reason}）` : ''}`;
        };
        if (!id) bcEl.addEventListener('input', U.debounce(updateInfo, 300));
        if (id && box.querySelector('#expiryPreview')) {
          box.querySelector('#expiryPreview').textContent = `创建于 ${U.fmtTime(item.created_at)} · 最近修改 ${U.fmtTime(item.updated_at)}`;
        }

        setTimeout(() => nameEl.focus(), 60);
      },
      onSubmit: async (vals) => {
        const codes = String(vals.barcodes || '')
          .split(/[,，\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);

        // 类型专属字段：x_ 前缀的摘出来进 extra
        const extra = {};
        Object.keys(vals).forEach((k) => {
          if (k.indexOf('x_') === 0) extra[k.slice(2)] = String(vals[k] == null ? '' : vals[k]).trim();
        });

        // 没有条码的东西自动给个内部编码 —— 需求里的「自动生成条码」。
        // 有条码的就不生成了，免得同一个东西两个身份标识。
        let code = String(vals.code || '').trim();
        if (!code && !codes.length) {
          const cr = await window.api.call('items.nextCode');
          if (cr.ok) code = cr.data.code;
        }

        const payload = {
          id: id || undefined,
          name: vals.name,
          kind,
          icon: chosenIcon,
          code,
          barcodes: codes,
          barcode: codes[0] || '',
          category_id: vals.category_id || null,
          location_id: vals.location_id || null,
          quantity: vals.quantity === '' ? 1 : Number(vals.quantity),
          unit: vals.unit || meta.one,
          production_date: vals.production_date || '',
          expiry_date: vals.expiry_date || '',
          shelf_life_days: Number(vals.shelf_life_days) || 0,
          price: vals.price === '' ? 0 : Number(vals.price),
          tags: String(vals.tags || '')
            .split(/[,，\s]+/)
            .map((s) => s.trim())
            .filter(Boolean),
          note: vals.note || '',
          extra
        };
        const r = await window.api.call('items.save', payload);
        if (!r.ok) throw new Error(r.error);

        // 图片处理放在物品保存之后：新物品要先有 id 才能挂图片
        const savedId = r.data && r.data.id;
        if (savedId && pending) {
          const ir = await window.api.call('images.save', {
            item_id: savedId,
            full: pending.full,
            thumb: pending.thumb,
            w: pending.w,
            h: pending.h
          });
          if (!ir.ok) C.toast('图片保存失败：' + ir.error, 'err', 4000);
        } else if (savedId && removed && existingImageId) {
          await window.api.call('images.remove', { item_id: savedId });
        }

        C.toast(id ? '已保存修改' : '已添加' + meta.label, 'ok');
        App.refreshSide();
        App.goto(App.state.view, { keepFilters: true });
      }
    });
  },

  /**
   * 图标选择弹窗。
   * 返回值：图标 key / '' 表示「用分类默认」/ null 表示取消。
   * 三个返回值必须区分开 —— 不然用户点「用分类默认」会被当成取消，
   * 原来选的图标清不掉。
   */
  pickIcon(current) {
    if (!window.ITEM_ICONS) return Promise.resolve(current || '');
    let chosen = String(current || '');
    let keyword = '';
    return C.modal({
      title: '选择图标',
      wide: true,
      bodyHtml:
        '<div class="icon-picker">' +
          '<div class="icon-picker-bar">' +
            '<input class="input" id="iconSearch" placeholder="搜索图标名，例如：书 / 药 / 发票 / 相机">' +
            '<button class="btn btn-sm" id="btnIconAuto" type="button">用分类默认</button>' +
          '</div>' +
          '<div class="icon-picker-grid" id="iconGrid"></div>' +
        '</div>',
      onMount: (box, close) => {
        const grid = box.querySelector('#iconGrid');
        const render = () => {
          const k = keyword.trim().toLowerCase();
          let html = '';
          ITEM_ICONS.groups.forEach((g) => {
            const icons = g.icons.filter(
              (ic) => !k || ic.name.toLowerCase().indexOf(k) >= 0 || ic.key.indexOf(k) >= 0
            );
            if (!icons.length) return;
            html += '<div class="icon-group-title">' + U.esc(g.name) + '</div><div class="icon-grid">';
            icons.forEach((ic) => {
              html +=
                '<button type="button" class="icon-cell' + (ic.key === chosen ? ' active' : '') +
                '" data-ic="' + ic.key + '" title="' + U.esc(ic.name) + '">' +
                ITEM_ICONS.svg(ic.key, 26) +
                '<span>' + U.esc(ic.name) + '</span></button>';
            });
            html += '</div>';
          });
          grid.innerHTML = html || '<div class="form-hint" style="padding:16px">没有匹配的图标，换个词试试</div>';
        };
        render();
        const s = box.querySelector('#iconSearch');
        s.oninput = () => { keyword = s.value; render(); };
        grid.onclick = (e) => {
          const b = e.target.closest('[data-ic]');
          if (!b) return;
          chosen = b.dataset.ic;
          close(chosen);
        };
        box.querySelector('#btnIconAuto').onclick = () => close('');
      }
    });
  },

  // ---------------- 位置编辑 ----------------
  async openLocEditor(id, presetParent) {
    let loc = null;
    if (id) {
      const list = App._flatLoc || [];
      loc = list.find((l) => l.id === id);
    }
    const flat = (App._flatLoc || []).filter((l) => l.id !== id);
    const descendants = new Set();
    if (id) {
      const collect = (n) => {
        (n.children || []).forEach((c) => {
          descendants.add(c.id);
          collect(c);
        });
      };
      const find = (nodes) => nodes.forEach((n) => (n.id === id ? collect(n) : find(n.children || [])));
      find(App.state.locTree);
    }

    await C.form({
      title: id ? '编辑位置' : presetParent ? '新增子位置' : '新增位置',
      fields: [
        { key: 'name', label: '位置名称', value: loc ? loc.name : '', required: true, full: true, placeholder: '例如：阳台柜 / 第三层 / 鞋盒A' },
        {
          key: 'parent_id',
          label: '上级位置',
          type: 'select',
          value: loc ? loc.parent_id || '' : presetParent || '',
          full: true,
          options: [{ value: '', label: '（作为顶层位置）' }].concat(
            flat.filter((l) => !descendants.has(l.id)).map((l) => ({ value: l.id, label: `${'　'.repeat(l.depth)}${l.path}` }))
          )
        },
        { key: 'note', label: '备注', type: 'textarea', value: loc ? loc.note || '' : '', rows: 2, full: true, placeholder: '例如：放换季衣物' }
      ],
      extraHtml: '<div class="form-divider"></div><div class="form-hint" style="margin-bottom:6px">NFC 标签（碰一碰定位）</div><div id="nfcBlock"></div>',
      onMount: (box, close) => {
        const block = box.querySelector('#nfcBlock');
        const supported = window.api.nfc && window.api.nfc.supported && window.api.nfc.supported();
        if (!supported) {
          block.innerHTML = '<div class="form-hint">当前设备不支持 NFC，无法使用「碰一碰」定位</div>';
          return;
        }
        if (!id) {
          block.innerHTML = '<div class="form-hint">保存位置后，可在此绑定一个 NFC 标签（贴在箱子/抽屉上，碰一下就能看到里面有什么）</div>';
          return;
        }
        const render = () => {
          const bound = loc && loc.nfc_tag;
          if (bound) {
            block.innerHTML =
              '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
              '<span class="tag tag-ok">已绑定 ' + U.esc(bound) + '</span>' +
              '<button class="btn btn-sm" id="btnUnbindNfc">解绑</button></div>';
            box.querySelector('#btnUnbindNfc').onclick = async () => {
              const r = await window.api.call('locations.unbindNfc', { id });
              if (r.ok) {
                C.toast('已解绑');
                await App.refreshSide();
                close();
              } else C.toast(r.error, 'err');
            };
          } else {
            block.innerHTML =
              '<button class="btn btn-sm" id="btnBindNfc">绑定 NFC 标签</button>' +
              '<span class="form-hint" id="nfcHint" style="margin-left:8px">点此后把手机靠近标签即可</span>';
            box.querySelector('#btnBindNfc').onclick = () => {
              const hint = box.querySelector('#nfcHint');
              if (hint) hint.textContent = '请把手机靠近 NFC 标签…';
              window.api.nfc.waitForTag(async (tag) => {
                const r = await window.api.call('locations.bindNfc', { id, nfc_tag: tag.uid });
                if (r.ok) {
                  C.toast('已绑定标签 ' + tag.uid, 'ok');
                  await App.refreshSide();
                  close();
                } else C.toast(r.error, 'err');
              });
            };
          }
        };
        render();
      },
      onSubmit: async (vals) => {
        const r = await window.api.call('locations.save', {
          id: id || undefined,
          name: vals.name,
          parent_id: vals.parent_id || null,
          note: vals.note || ''
        });
        if (!r.ok) throw new Error(r.error);
        C.toast(id ? '已保存' : '已添加位置', 'ok');
        const savedId = r.data && r.data.id;
        if (savedId && r.data.parent_id) App.state.locTreeOpen[r.data.parent_id] = true;
        App.refreshSide();
        App.goto(App.state.view, { keepFilters: true });
      }
    });
  },

  // ---------------- 导入导出 ----------------
  async exportData(kind) {
    kind = kind || 'json';
    const r = await window.api.call('app.export');
    if (!r.ok) return C.toast(r.error, 'err');
    const data = r.data;
    const stamp = U.today();

    if (kind === 'csv') {
      const items = await window.api.call('items.list', {});
      // CSV 只能有一行表头，但三类记录的专属字段完全不同。
      // 做法：表头取三类的**并集**，不适用的格子留空。
      // 这样导出后 Excel 里一列「类型」就能筛，比拆成三个文件或直接丢掉字段都实用
      // —— 用户要的是「导出用 Excel 看」，那就不能让他看不到作者和保管期限。
      const HEAD = [
        '类型', '名称', '内部编码', '条码', '分类', '位置', '数量', '单位',
        '生产日期', '到期日期', '保质期天数', '剩余天数', '保质期状态',
        '文件编号', '会计年度', '来文归档单位', '涉及金额', '保管期限至',
        '作者', '出版社', '出版年', '阅读状态',
        '单价', '标签', '备注'
      ];
      const stateText = (i) =>
        i.expiry_state === 'expired' ? '已过期'
          : i.expiry_state === 'soon' ? '即将到期'
            : i.expiry_state === 'ok' ? '正常' : '';
      const rows = [HEAD].concat(
        (items.data || []).map((i) => {
          const ex = i.extra || {};
          const isGoods = (i.kind || 'goods') === 'goods';
          const isDoc = i.kind === 'doc';
          const isBook = i.kind === 'book';
          return [
            U.kindLabel(i.kind),
            i.name,
            i.code || '',
            i.barcode || '',
            i.category_name || '',
            i.location_path || '',
            i.quantity,
            i.unit || '',
            // 保质期三件套只对普通物品有意义，资料和图书留空
            isGoods ? i.production_date || '' : '',
            isGoods ? i.expiry_date || '' : '',
            isGoods ? i.shelf_life_days || '' : '',
            isGoods && i.days_left !== null && i.days_left !== undefined ? i.days_left : '',
            isGoods ? stateText(i) : '',
            isDoc ? ex.doc_no || '' : '',
            isDoc ? ex.year || '' : '',
            isDoc ? ex.org || '' : '',
            isDoc ? ex.amount || '' : '',
            isDoc ? ex.keep_until || '' : '',
            isBook ? ex.author || '' : '',
            isBook ? ex.publisher || '' : '',
            isBook ? ex.pub_year || '' : '',
            isBook ? ex.status || '' : '',
            i.price || '',
            (i.tags || []).join('|'),
            i.note || ''
          ];
        })
      );
      const csv = '\ufeff' + rows.map((r2) => r2.map((c) => `"${String(c == null ? '' : c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const res = await window.api.exportFile({ defaultName: `家庭收纳_全部记录_${stamp}.csv`, content: csv });
      if (res.ok) C.toast('已导出到 ' + res.filePath, 'ok', 4000);
      return;
    }

    const res = await window.api.exportFile({
      defaultName: `家庭收纳_备份_${stamp}.json`,
      content: JSON.stringify(data, null, 2)
    });
    if (res.ok) C.toast('备份已导出到 ' + res.filePath, 'ok', 4000);
  },

  async importData() {
    const f = await window.api.importFile();
    if (!f.ok) return;
    let parsed;
    try {
      parsed = JSON.parse(f.content);
    } catch (e) {
      return C.toast('文件不是有效的 JSON 备份', 'err');
    }
    const counts = { locations: (parsed.locations || []).length, items: (parsed.items || []).length };
    const ok = await C.confirm(
      `即将导入备份文件：\n位置 ${counts.locations} 个，物品 ${counts.items} 条。\n\n点击「合并导入」会保留现有数据并追加新记录；若要完全替换请先自行备份。`,
      { title: '导入备份', okText: '合并导入' }
    );
    if (!ok) return;
    const r = await window.api.call('app.import', { data: parsed, mode: 'merge' });
    if (r.ok) {
      // 图片没存上必须单独说：否则用户看到「导入完成」，点开图却是空白，
      // 只会以为备份文件坏了，查不出真正的原因是本地空间不够。
      const imgWarn = r.data && r.data.imagesFailed
        ? `，${r.data.imagesFailed} 张图片没能保存（本地空间不足）`
        : '';
      C.toast('导入完成' + imgWarn, imgWarn ? 'warn' : 'ok', imgWarn ? 6000 : 3500);
      App.refreshAll();
    } else C.toast(r.error, 'err');
  },

  // ---------------- 图片 ----------------
  /**
   * 把用户选的照片压成「全图 + 缩略图」两张 JPEG data URL。
   * 手机上原图动辄几 MB，不压缩既存不下（localStorage 上限）也传不动（同步）。
   */
  _compressImage(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const img = new Image();
        img.onload = () => {
          const draw = (max, quality) => {
            const scale = Math.min(1, max / Math.max(img.width, img.height));
            const w = Math.max(1, Math.round(img.width * scale));
            const h = Math.max(1, Math.round(img.height * scale));
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            // 先铺白底：JPEG 不支持透明，PNG 的透明区会变成黑块
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            return { url: canvas.toDataURL('image/jpeg', quality), w, h };
          };
          try {
            const full = draw(1024, 0.68);
            const thumb = draw(160, 0.6);
            resolve({ full: full.url, thumb: thumb.url, w: full.w, h: full.h });
          } catch (e) {
            reject(e);
          }
        };
        img.onerror = () => reject(new Error('图片解码失败'));
        img.src = String(fr.result);
      };
      fr.onerror = () => reject(new Error('图片读取失败'));
      fr.readAsDataURL(file);
    });
  },

  _showImageModal(src, title) {
    return C.modal({
      title: title || '查看图片',
      bodyHtml: '<div class="img-view"><img src="' + U.esc(src) + '" alt=""></div>',
      footHtml: '<button class="btn btn-primary" data-act="close">关闭</button>'
    });
  },

  async viewImage(imageId) {
    const r = await window.api.call('images.data', { id: imageId });
    if (!r.ok || !r.data || !r.data.full) return C.toast('图片读取失败', 'err');
    return App._showImageModal(r.data.full, '查看图片');
  },

  // ---------------- 二维码 ----------------
  /**
   * 生成并展示一个二维码。
   * 位置码贴在箱子/抽屉上，物品码贴在物品上；扫码即可直接打开对应内容。
   */
  async showQr(opts) {
    opts = opts || {};
    if (!window.QR || !window.QR.supported()) return C.toast('二维码组件未加载', 'err');
    const payload = opts.type === 'item' ? QR.itemPayload(opts.id) : QR.locPayload(opts.id);
    let svg;
    try {
      svg = QR.svg(payload, 240);
    } catch (e) {
      return C.toast('生成二维码失败：' + ((e && e.message) || e), 'err');
    }
    const what = opts.type === 'item' ? '物品' : '位置';
    // 有内部编码的东西（没有条码的物品）把编码一起印在标签上：
    // 万一二维码磨损扫不出来，还能照着编码在扫码页手动输进去。
    const codeLine = opts.code
      ? '<div class="qr-code">编码 ' + U.esc(opts.code) + '</div>'
      : '';
    const body =
      '<div class="qr-wrap">' +
      '<div class="qr-box">' + svg + '</div>' +
      (opts.subtitle ? '<div class="qr-caption">' + U.esc(opts.subtitle) + '</div>' : '') +
      codeLine +
      '<div class="form-hint" style="text-align:center">打印或贴到' + what + '上，用「扫码」扫一下就能直接打开</div>' +
      '<div class="qr-payload">' + U.esc(payload) + '</div>' +
      '</div>';
    await C.modal({
      title: opts.title || what + '二维码',
      bodyHtml: body,
      footHtml:
        '<button class="btn" data-act="saveQr">保存为图片</button>' +
        '<button class="btn btn-primary" data-act="close">关闭</button>',
      onMount: (box) => {
        const b = box.querySelector('[data-act="saveQr"]');
        if (b) {
          b.onclick = async () => {
            const safe = String((opts.title || what) + (opts.name ? '-' + opts.name : '')).replace(/[\\/:*?"<>|]/g, '_');
            const r = await window.api.exportFile({ defaultName: safe + '.svg', content: svg });
            if (r && r.ok) C.toast('已保存到 ' + r.filePath, 'ok', 4000);
            else C.toast((r && r.error) || '保存失败', 'err');
          };
        }
      }
    });
  },

  // ---------------- 同步 ----------------
  async doSync() {
    const st = (await window.api.call('app.settings.get')).data || {};
    if (!st.syncEnabled || !st.syncToken) {
      C.toast('尚未开启同步，正在跳转到设置页', 'warn');
      App.goto('settings');
      return;
    }
    const chip = document.getElementById('syncChip');
    chip.className = 'sync-chip';
    document.getElementById('syncText').textContent = '同步中…';
    const r = await window.api.sync.run();
    if (r.ok) {
      const d = r.data;
      // 数据多到一次拉不完时要说清楚，否则用户看到「同步完成」会以为已经全了
      const more = d.hasMore ? '。还有数据没拉完，请再点一次「立即同步」' : '';
      // 图片没能落到本地也要说：不然用户会看到一堆点开是空白的图，
      // 而提示却说「同步完成」，对不上。
      const imgWarn = d.imagesFailed ? `，${d.imagesFailed} 张图片没能保存（本地空间不足）` : '';
      const warn = d.hasMore || d.imagesFailed;
      C.toast(
        `同步完成：上传 ${d.pushed} 条，下载 ${d.pulled} 条${d.conflicts.length ? `，冲突 ${d.conflicts.length} 条待处理` : ''}${imgWarn}${more}`,
        warn ? 'warn' : 'ok',
        warn ? 6000 : 3500
      );
      await App.refreshSide();
      App.goto(App.state.view, { keepFilters: true });
      // 有冲突就把清单摊开给用户看。光报一句「冲突 N 条」等于没说：
      // 用户不知道是哪几条、也不知道自己刚改的东西去哪了。
      if (d.conflicts && d.conflicts.length) await App.showConflictDialog(d.conflicts);
    } else {
      chip.className = 'sync-chip err';
      document.getElementById('syncText').textContent = '同步失败';
      C.toast(r.error, 'err', 4500);
    }
  },

  // ---------------- 同步冲突处理 ----------------
  /**
   * 同一条记录在两台设备上都被改过时，服务端按 updated_at 取新的那条，
   * 本机改的那份另存成一份「（冲突副本）」。
   *
   * 不告诉用户的话：他会发现自己的修改「不见了」，或者库里悄悄多出一堆带
   * 「冲突副本」后缀的东西，却不知道从哪来的。这里把清单摊开，让他逐条决定。
   *
   * 为什么不自动处理：自动删 = 替用户丢掉他的改动；自动留 = 副本越积越多没人清。
   *
   * 为什么是 while 循环而不是一次渲染到底：整个界面只有一个 #modalBox，
   * 「打开编辑器」和「删除确认」都会把它顶掉。所以每处理一条就先把弹窗收掉，
   * 等子操作结束，再带着「还没处理的那些」重新打开。
   */
  async showConflictDialog(conflicts) {
    const pending = (conflicts || []).filter((c) => c && c.conflictId);
    if (!pending.length) return;

    const SCOPE_LABEL = { items: '物品', locations: '位置', categories: '分类' };
    const KIND_LABEL = { goods: '普通物品', doc: '办公资料', book: '图书' };
    const labelOf = (c) =>
      c.scope === 'items' ? KIND_LABEL[c.kind] || '物品' : SCOPE_LABEL[c.scope] || '记录';
    // 只有物品和位置有编辑界面；分类是预置表，没有单独的编辑器
    const canOpen = (c) => c.scope === 'items' || c.scope === 'locations';
    const when = (t) => U.fmtTime(t) || '时间未知';

    let handled = 0;
    while (pending.length) {
      const rows = pending
        .map(
          (c, i) =>
            `<div class="conflict-row">` +
            `<div class="conflict-main">` +
            `<div class="conflict-name">${U.esc(c.name || '（未命名）')}` +
            `<span class="tag tag-plain">${U.esc(labelOf(c))}</span></div>` +
            `<div class="conflict-sub">NAS 上的版本更新（${U.esc(when(c.remoteAt))}），已采用</div>` +
            `<div class="conflict-sub">你本机改的那份（${U.esc(when(c.localAt))}）另存成了副本</div>` +
            // 两份改了不同的名字时要点出来，否则用户会以为「本机那份」叫这个名字
            (c.localName && c.localName !== c.name
              ? `<div class="conflict-sub">本机那份的名字是「${U.esc(c.localName)}」</div>`
              : '') +
            `</div>` +
            `<div class="conflict-acts">` +
            (canOpen(c)
              ? `<button class="btn btn-sm" data-cf-open="${i}">打开</button>`
              : `<span class="form-hint">分类没有单独的编辑界面</span>`) +
            `<button class="btn btn-sm" data-cf-restore="${i}">用副本覆盖</button>` +
            `<button class="btn btn-sm" data-cf-keep="${i}">保留</button>` +
            `<button class="btn btn-sm btn-danger" data-cf-del="${i}">删掉副本</button>` +
            `</div></div>`
        )
        .join('');

      const act = await C.modal({
        title: `同步冲突（${pending.length} 条）`,
        wide: true,
        bodyHtml:
          `<div class="form-hint" style="margin-bottom:10px;line-height:1.7">` +
          `下面这些记录在两台设备上都被改过。为了不覆盖任何一边，NAS 上较新的那份已经采用，` +
          `你本机改的那份存成了「（冲突副本）」。留下还是删掉由你决定：` +
          `保留的副本会在下次同步时上传到 NAS。<br>` +
          `如果你觉得本机这份才对，点「用副本覆盖」把它换回来。` +
          `</div>` +
          `<div id="cfList">${rows}</div>`,
        footHtml:
          `<span class="form-hint" style="flex:1">还剩 ${pending.length} 条没处理，` +
          `关掉窗口下次同步还会再问</span>` +
          `<button class="btn" data-act="close">稍后再说</button>`,
        onMount: (box, close) => {
          const bind = (sel, actName, key) => {
            box.querySelectorAll(sel).forEach((b) => {
              b.onclick = () => close({ act: actName, i: Number(b.dataset[key]) });
            });
          };
          bind('[data-cf-open]', 'open', 'cfOpen');
          bind('[data-cf-restore]', 'restore', 'cfRestore');
          bind('[data-cf-keep]', 'keep', 'cfKeep');
          bind('[data-cf-del]', 'del', 'cfDel');
        }
      });

      if (!act) break; // 用户关掉了弹窗，剩下的先留着，下次同步还会再问

      const c = pending[act.i];
      if (!c) {
        pending.splice(act.i, 1);
        continue;
      }

      if (act.act === 'open') {
        // 打开只是看一眼，副本还在，这一条继续留在待处理列表里
        if (c.scope === 'locations') await App.openLocEditor(c.conflictId);
        else await App.openItemEditor(c.conflictId);
        continue;
      }

      if (act.act === 'restore') {
        // 这一步会盖掉 NAS 上那份较新的改动，而且要同步到所有设备，必须二次确认
        const sure = await C.confirm(
          `确定用本机这份覆盖「${c.name}」吗？\n\n` +
          `覆盖后：\n` +
          `· 这条记录变回你本机改的那份（${when(c.localAt)}）\n` +
          `· NAS 上那份较新的改动（${when(c.remoteAt)}）会被替换掉\n` +
          `· 冲突副本随后清掉，下次同步时其他设备也会跟着变\n\n` +
          `NAS 上那份改动的原文找不回来了，确定要换吗？`,
          { title: '用本机这份覆盖', okText: '确定覆盖', danger: true }
        );
        if (!sure) continue;
        const r = await window.api.call('conflict.restore', {
          scope: c.scope, id: c.id, conflictId: c.conflictId
        });
        if (!r.ok) {
          C.toast(r.error, 'err', 4000);
          continue;
        }
      }

      if (act.act === 'del') {
        const sure = await C.confirm(
          `确定删掉「${c.name}」的冲突副本吗？\n\nNAS 上较新的那份会保留，本机这份改动将无法找回。`,
          { title: '删除冲突副本', okText: '删掉副本', danger: true }
        );
        if (!sure) continue;
        const r = await window.api.call(c.scope + '.delete', { id: c.conflictId });
        if (!r.ok) {
          C.toast(r.error, 'err', 4000);
          continue;
        }
      }

      pending.splice(act.i, 1);
      handled++;
    }

    if (handled) {
      await App.refreshAll();
      C.toast(handled === 1 ? '冲突已处理' : `${handled} 条冲突已处理`, 'ok');
    }
  }
};

window.App = App;
document.addEventListener('DOMContentLoaded', () => App.init());
