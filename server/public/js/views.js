'use strict';

const Views = {};

/* ==================== 总览 ==================== */
Views.dashboard = async function (el, state) {
  const [sum, expiring] = await Promise.all([
    window.api.call('app.summary'),
    window.api.call('items.expiringSoon', { days: 30 })
  ]);
  const s = sum.data || {};
  const list = (expiring.data || []).slice(0, 6);

  el.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">总览</div>
        <div class="page-sub">家里收了什么、放在哪、什么时候要用完</div>
      </div>
      <div class="toolbar">
        <!-- 手机端底栏没有「统计」标签（它被收进总览这一级），
             这个入口保证手机上照样点得到统计页；桌面端是多一条捷径。 -->
        <button class="btn btn-sm" data-goto="stats">统计</button>
        <button class="btn btn-sm" id="dashExport">导出备份</button>
      </div>
    </div>

    <div class="cards">
      <div class="card"><div class="card-label">物品总数</div>
        <div class="card-value">${s.items || 0}</div>
        <div class="card-foot">共 ${s.locations || 0} 个收纳位置 · 资料 ${s.docs || 0} 份 / 图书 ${s.books || 0} 本</div></div>
      <div class="card"><div class="card-label">已过期</div>
        <div class="card-value ${s.expired ? 'bad' : ''}">${s.expired || 0}</div>
        <div class="card-foot">建议尽快处理</div></div>
      <div class="card"><div class="card-label">临期提醒</div>
        <div class="card-value ${s.soon ? 'warn' : ''}">${s.soon || 0}</div>
        <div class="card-foot">${s.settings ? s.settings.expiryWarnDays : 7} 天内到期</div></div>
      <div class="card"><div class="card-label">未指定位置</div>
        <div class="card-value ${s.noLocation ? 'warn' : ''}">${s.noLocation || 0}</div>
        <div class="card-foot">建议归位后更好找</div></div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">临期与过期物品</div>
        <button class="btn btn-sm" data-goto="expiry">查看全部</button>
      </div>
      <div class="panel-body flush" id="dashExpiry">
        ${list.length
          ? `<div class="item-list">${list.map((i) => App.itemRowHtml(i)).join('')}</div>`
          : C.empty('✓', '没有临期物品', '所有带保质期的物品都还新鲜')}
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><div class="panel-title">快捷操作</div></div>
      <div class="panel-body">
        <div class="toolbar">
          <button class="btn" data-act="add-item">＋ 新增物品</button>
          <button class="btn" data-act="add-doc">＋ 新增资料</button>
          <button class="btn" data-act="add-book">＋ 新增图书</button>
          <button class="btn" data-goto="scan">扫码录入</button>
          <button class="btn" data-act="add-loc">＋ 新增位置</button>
          <button class="btn" data-goto="items">浏览全部物品</button>
        </div>
      </div>
    </div>`;

  el.querySelector('#dashExport').onclick = () => App.exportData();
  el.querySelector('#dashExpiry').onclick = (e) => App.handleRowClick(e);
};

/* ==================== 公共小件 ==================== */

/**
 * 筛选面板：窄屏默认收起。
 * 手机上一个「类型 + 分类 + 条件」的筛选区能占掉半屏，列表要滚动才看得见；
 * 但筛选又不是每次都改，收起来、标题上提示「已选 N 项」更合适。
 * 桌面宽度够，保持展开。
 */
Views._filterPanel = function (state, activeCount, bodyHtml) {
  const narrow = typeof window !== 'undefined' && window.innerWidth > 0 && window.innerWidth < 640;
  const open = state.filtersOpen == null ? !narrow : !!state.filtersOpen;
  return `<div class="panel">
      <div class="panel-head filter-head" id="filterHead">
        <div class="panel-title">筛选${
          activeCount ? ` <span class="filter-badge">已选 ${activeCount} 项</span>` : ''
        }</div>
        <span class="page-sub" id="filterToggle">${open ? '收起 ▲' : '展开 ▼'}</span>
      </div>
      <div class="panel-body" id="filterBody"${open ? '' : ' hidden'}>${bodyHtml}</div>
    </div>`;
};

/** 绑定筛选面板的展开/收起。就地切换，不重渲染整个页面。 */
Views._bindFilterPanel = function (el, state) {
  const head = el.querySelector('#filterHead');
  const body = el.querySelector('#filterBody');
  const toggle = el.querySelector('#filterToggle');
  if (!head || !body) return;
  head.onclick = () => {
    body.hidden = !body.hidden;
    state.filtersOpen = !body.hidden;
    if (toggle) toggle.textContent = body.hidden ? '展开 ▼' : '收起 ▲';
  };
};

/** 当前生效的筛选项个数（用来在收起的标题上提示） */
Views._activeFilterCount = function (f) {
  return ['kind', 'category_id', 'expiry', 'facet', 'location_id'].filter((k) => f && f[k]).length;
};

/**
 * 分类筛选条。
 * 分类现在有二十多个，全铺出来在手机上会把列表整个顶出屏幕
 * （实测：390px 宽下 chips 占满一屏，一件物品都看不见）。
 * 所以默认只显示前 N 个，其余收进「更多分类」；当前选中的那个必须始终可见，
 * 否则用户选完分类就找不到自己选的是哪个了。
 */
Views._catChips = function (cats, activeId, expanded, limit) {
  const CAP = limit || 9;
  const activeIdx = cats.findIndex((c) => c.id === activeId);
  const showAll = expanded || activeIdx >= CAP;
  const shown = showAll ? cats : cats.slice(0, CAP);
  const out = [
    `<button class="chip ${!activeId ? 'active' : ''}" data-cat="">全部分类</button>`,
    ...shown.map((c) => `<button class="chip ${activeId === c.id ? 'active' : ''}" data-cat="${c.id}">${U.esc(c.name)}</button>`)
  ];
  if (cats.length > CAP) {
    out.push(
      `<button class="chip chip-more" data-catmore="1">${showAll ? '收起分类' : `更多分类 +${cats.length - CAP}`}</button>`
    );
  }
  return out.join('');
};

/* ==================== 物品清单 ==================== */
Views.items = async function (el, state) {
  const [itemsRes, locsRes, catsRes] = await Promise.all([
    window.api.call('items.list', state.filters || {}),
    window.api.call('locations.list'),
    window.api.call('categories.list')
  ]);
  const items = itemsRes.data || [];
  const locs = locsRes.data || [];
  const cats = catsRes.data || [];
  const f = state.filters || {};
  const activeLoc = (f.location_id && locs.find((l) => l.id === f.location_id)) || null;
  const locBanner = activeLoc
    ? `<div class="filter-banner">📍 正在查看位置：<b>${U.esc(activeLoc.path)}</b> · 共 ${items.length} 件</div>`
    : '';

  // 分类筛选跟着类型走：选了「图书」就不该再看到「清洁用品」那 20 多个无关分类。
  const chipCats = f.kind ? U.catsForKind(cats, f.kind) : cats;
  const catChips = Views._catChips(chipCats, f.category_id, state.catChipsExpanded);

  // 类型筛选：三类共处一张表，这里给一个「看全部 / 只看某一类」的开关
  const kindChips = [
    ['', '全部'],
    ['goods', '普通物品'],
    ['doc', '办公资料'],
    ['book', '图书']
  ]
    .map(([v, l]) => `<button class="chip ${(f.kind || '') === v ? 'active' : ''}" data-kind="${v}">${l}</button>`)
    .join('');

  const expChips = [
    ['', '全部'],
    ['soon', '即将到期'],
    ['expired', '已过期'],
    ['has', '有保质期'],
    ['none', '无保质期']
  ]
    .map(([v, l]) => `<button class="chip ${(f.expiry || '') === v ? 'active' : ''}" data-exp="${v}">${l}</button>`)
    .join('');

  el.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">物品清单</div>
        <div class="page-sub" id="itemCount">共 ${items.length} 件</div>
      </div>
      <div class="toolbar">
        <select class="select" id="fltLoc">
          <option value="">全部位置</option>
          ${locs.map((l) => `<option value="${l.id}" ${f.location_id === l.id ? 'selected' : ''}>${U.esc(l.path)}</option>`).join('')}
        </select>
        <select class="select" id="fltSort">
          ${[
            ['updated_desc', '最近修改'],
            ['created_desc', '最近添加'],
            ['name_asc', '名称排序'],
            ['expiry_asc', '保质期临近']
          ]
            .map(([v, l]) => `<option value="${v}" ${(f.sort || 'updated_desc') === v ? 'selected' : ''}>${l}</option>`)
            .join('')}
        </select>
        <button class="btn btn-sm" id="btnPickMode"${state.pickMode ? ' disabled' : ''}>${
          state.pickMode ? '整理中…' : '批量整理'
        }</button>
        <button class="btn btn-primary btn-sm" data-act="add-item">＋ 新增</button>
      </div>
    </div>

    ${locBanner}

    ${Views._filterPanel(
      state,
      Views._activeFilterCount(f),
      // 每行前面钉一个维度小标题（方案 D）。标签是 chip 容器的**兄弟节点**，
      // 不能塞进 #kindChips 里面 —— 测试靠容器里的 .chip 数量判断筛选条渲染全没全。
      `<div class="chip-row"><span class="chip-dim">类型</span>
         <div class="chip-group" id="kindChips">${kindChips}</div></div>
       <div class="chip-row"><span class="chip-dim">分类</span>
         <div class="chip-group" id="catChips">${catChips}</div></div>
       <div class="chip-row"><span class="chip-dim">保质期</span>
         <div class="chip-group" id="expChips">${expChips}</div></div>`
    )}

    <div class="panel">
      <div class="panel-body flush" id="itemList">
        ${items.length
          ? `<div class="item-list">${items.map((i) => App.itemRowHtml(i)).join('')}</div>`
          : C.empty('▤', '还没有物品', '点击「新增」或到扫码页录入第一件物品')}
      </div>
    </div>

    ${
      state.pickMode
        ? `<div class="pick-bar" id="pickBar">
      <span id="pickCount">已选 ${(state.picked || []).length} 件</span>
      <div class="toolbar" style="margin:0">
        <button class="btn btn-sm" id="pickCancel">取消</button>
        <button class="btn btn-primary btn-sm" id="pickMove"${
          (state.picked || []).length ? '' : ' disabled'
        }>移动到…</button>
      </div>
    </div>`
        : ''
    }`;

  const refresh = () => App.goto('items', { keepFilters: true });
  el.querySelector('#btnPickMode').onclick = () => App.startPick();
  const pickMoveBtn = el.querySelector('#pickMove');
  if (pickMoveBtn) pickMoveBtn.onclick = () => App.batchMove();
  const pickCancelBtn = el.querySelector('#pickCancel');
  if (pickCancelBtn) pickCancelBtn.onclick = () => App.cancelPick();
  el.querySelector('#fltLoc').onchange = (e) => {
    state.filters = Object.assign({}, state.filters, { location_id: e.target.value || null });
    refresh();
  };
  el.querySelector('#fltSort').onchange = (e) => {
    state.filters = Object.assign({}, state.filters, { sort: e.target.value });
    refresh();
  };
  el.querySelector('#kindChips').onclick = (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    // 换类型要一并清掉分类筛选：留着「图书」分类再切到「普通物品」会一条都搜不到
    state.filters = Object.assign({}, state.filters, { kind: b.dataset.kind || null, category_id: null });
    refresh();
  };
  el.querySelector('#catChips').onclick = (e) => {
    const more = e.target.closest('[data-catmore]');
    if (more) {
      state.catChipsExpanded = !state.catChipsExpanded;
      refresh();
      return;
    }
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    state.filters = Object.assign({}, state.filters, { category_id: b.dataset.cat || null });
    refresh();
  };
  el.querySelector('#expChips').onclick = (e) => {
    const b = e.target.closest('[data-exp]');
    if (!b) return;
    state.filters = Object.assign({}, state.filters, { expiry: b.dataset.exp || null });
    refresh();
  };
  el.querySelector('#itemList').onclick = (e) => App.handleRowClick(e);
  Views._bindFilterPanel(el, state);
};

/* ==================== 办公资料 / 图书 ==================== */
/**
 * 这两个页面结构完全一样：概览卡片 + 筛选条 + 列表。
 * 差别只在「叫什么」「卡片统计什么」「筛选条件是什么」，
 * 所以共用一个实现 —— 写两份的话改一处漏一处是迟早的事。
 */
Views._kindPage = async function (el, state, kind) {
  const meta = U.KINDS[kind];
  // kind 由本页固定，先摘掉 state 里可能残留的值，避免两处打架
  const f = Object.assign({}, state.filters || {});
  delete f.kind;
  const query = Object.assign({}, f, { kind });

  const [itemsRes, locsRes, catsRes] = await Promise.all([
    window.api.call('items.list', query),
    window.api.call('locations.list'),
    window.api.call('categories.list')
  ]);
  const all = itemsRes.data || [];
  const locs = locsRes.data || [];
  const cats = U.catsForKind(catsRes.data || [], kind);
  const activeLoc = (f.location_id && locs.find((l) => l.id === f.location_id)) || null;

  // ---- 本页专属的次级筛选（年度 / 阅读状态 / 保管期）----
  const today = U.today();
  const facetOf = (i) => {
    const ex = i.extra || {};
    if (kind === 'doc') {
      if (f.facet === 'keep:over') return !!(ex.keep_until && ex.keep_until < today);
      if (f.facet && f.facet.indexOf('y:') === 0) return String(ex.year || '') === f.facet.slice(2);
      if (f.facet === 'y:none') return !ex.year;
      return true;
    }
    if (kind === 'book') {
      if (f.facet) return String(ex.status || '未读') === f.facet;
      return true;
    }
    return true;
  };
  const items = all.filter(facetOf);

  // ---- 概览卡片 ----
  let cards;
  if (kind === 'doc') {
    const year = String(new Date().getFullYear());
    const thisYear = all.filter((i) => String((i.extra || {}).year || '') === year).length;
    const amount = all.reduce((s, i) => s + (Number((i.extra || {}).amount) || 0), 0);
    const noLoc = all.filter((i) => !i.location_id).length;
    cards = [
      ['资料总数', all.length, '份', '含合同、凭证、档案、会计资料'],
      ['本年归档', thisYear, '份', year + ' 年度的资料'],
      ['涉及金额', U.fmtMoney(amount), '元', '已填金额的资料合计'],
      ['未指定位置', noLoc, '份', noLoc ? '建议归位后更好找' : '都已归位']
    ];
  } else {
    const st = (s) => all.filter((i) => String((i.extra || {}).status || '未读') === s).length;
    cards = [
      ['图书总数', all.length, '本', '纸质书、教材、期刊'],
      ['在读', st('在读'), '本', '正在看的'],
      ['未读', st('未读'), '本', '还没开始看的'],
      ['已读 / 借出', st('已读') + st('借出'), '本', '已读完或借出去的']
    ];
  }
  const cardsHtml = cards
    .map(
      ([label, value, unit, foot]) =>
        `<div class="card"><div class="card-label">${U.esc(label)}</div>
          <div class="card-value">${U.esc(String(value))}<span class="card-unit">${U.esc(unit)}</span></div>
          <div class="card-foot">${U.esc(foot)}</div></div>`
    )
    .join('');

  // ---- 筛选条 ----
  const catChips = Views._catChips(cats, f.category_id, state.catChipsExpanded);

  let facets;
  if (kind === 'doc') {
    const years = Array.from(new Set(all.map((i) => String((i.extra || {}).year || '')).filter(Boolean))).sort().reverse();
    facets = [['', '全部年度']]
      .concat(years.map((y) => ['y:' + y, y + ' 年']))
      .concat([['y:none', '未填年度'], ['keep:over', '已过保管期']]);
  } else {
    facets = [['', '全部'], ['未读', '未读'], ['在读', '在读'], ['已读', '已读'], ['借出', '借出']];
  }
  const facetChips = facets
    .map(([v, l]) => `<button class="chip ${(f.facet || '') === v ? 'active' : ''}" data-facet="${v}">${l}</button>`)
    .join('');

  const locBanner = activeLoc
    ? `<div class="filter-banner">📍 正在查看位置：<b>${U.esc(activeLoc.path)}</b> · 共 ${items.length} ${meta.one}</div>`
    : '';

  el.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">${kind === 'doc' ? '办公资料' : '图书'}</div>
        <div class="page-sub">${kind === 'doc'
          ? '合同、凭证、档案、会计资料 —— 按类别和年度归档'
          : '书、教材、期刊 —— 记下放在哪、看没看过'}</div>
      </div>
      <div class="toolbar">
        <select class="select" id="fltLoc">
          <option value="">全部位置</option>
          ${locs.map((l) => `<option value="${l.id}" ${f.location_id === l.id ? 'selected' : ''}>${U.esc(l.path)}</option>`).join('')}
        </select>
        <select class="select" id="fltSort">
          ${[
            ['updated_desc', '最近修改'],
            ['created_desc', '最近添加'],
            ['name_asc', '名称排序']
          ]
            .map(([v, l]) => `<option value="${v}" ${(f.sort || 'updated_desc') === v ? 'selected' : ''}>${l}</option>`)
            .join('')}
        </select>
        <button class="btn btn-primary btn-sm" data-act="${kind === 'doc' ? 'add-doc' : 'add-book'}">＋ 新增${meta.label}</button>
      </div>
    </div>

    ${locBanner}

    <div class="cards">${cardsHtml}</div>

    ${Views._filterPanel(
      state,
      Views._activeFilterCount(f),
      `<div class="chip-row"><span class="chip-dim">分类</span>
         <div class="chip-group" id="catChips">${catChips}</div></div>
       <div class="chip-row"><span class="chip-dim">${kind === 'doc' ? '年度' : '状态'}</span>
         <div class="chip-group" id="facetChips">${facetChips}</div></div>`
    )}

    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">${f.facet || f.category_id || activeLoc ? '筛选结果' : '全部' + meta.label}</div>
        <span class="page-sub">${items.length} ${meta.one}</span>
      </div>
      <div class="panel-body flush" id="kindList">
        ${items.length
          ? `<div class="item-list">${items.map((i) => App.itemRowHtml(i)).join('')}</div>`
          : C.empty('▤',
              '还没有' + meta.label,
              kind === 'doc'
                ? '点「新增资料」把合同、凭证、档案记进来，没条码也能自动编号'
                : '点「新增图书」把书登记进来，扫书背面的 ISBN 就能自动填')}
      </div>
    </div>`;

  const refresh = () => App.goto(kind === 'doc' ? 'docs' : 'books', { keepFilters: true });
  el.querySelector('#fltLoc').onchange = (e) => {
    state.filters = Object.assign({}, state.filters, { location_id: e.target.value || null });
    refresh();
  };
  el.querySelector('#fltSort').onchange = (e) => {
    state.filters = Object.assign({}, state.filters, { sort: e.target.value });
    refresh();
  };
  el.querySelector('#catChips').onclick = (e) => {
    const more = e.target.closest('[data-catmore]');
    if (more) {
      state.catChipsExpanded = !state.catChipsExpanded;
      refresh();
      return;
    }
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    state.filters = Object.assign({}, state.filters, { category_id: b.dataset.cat || null });
    refresh();
  };
  el.querySelector('#facetChips').onclick = (e) => {
    const b = e.target.closest('[data-facet]');
    if (!b) return;
    state.filters = Object.assign({}, state.filters, { facet: b.dataset.facet || null });
    refresh();
  };
  el.querySelector('#kindList').onclick = (e) => App.handleRowClick(e);
  Views._bindFilterPanel(el, state);
};

Views.docs = function (el, state) {
  return Views._kindPage(el, state, 'doc');
};

Views.books = function (el, state) {
  return Views._kindPage(el, state, 'book');
};

/* ==================== 扫码录入 ==================== */
Views.scan = async function (el, state) {
  el.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">扫码录入</div>
        <div class="page-sub">扫条码录物品，扫二维码直接打开位置/物品</div>
      </div>
    </div>

    <div class="scan-layout">
      <div class="panel">
        <div class="panel-head"><div class="panel-title">摄像头扫码</div>
          <span class="page-sub" id="scanState">未启动</span></div>
        <div class="panel-body">
          <div class="scan-stage" id="scanStage">
            <video id="scanVideo" muted playsinline></video>
            <div class="scan-frame scan-laser" id="scanFrame" hidden></div>
          </div>
          <div class="scan-actions">
            <button class="btn btn-primary btn-sm" id="btnStartScan">启动摄像头</button>
            <button class="btn btn-sm" id="btnStopScan" disabled>停止</button>
            <button class="btn btn-sm" id="btnTorch" hidden>开灯</button>
            <button class="btn btn-sm" id="btnPickImage">从图片识别</button>
            <input type="file" id="scanFile" accept="image/*" hidden>
          </div>
          <div class="form-hint" id="scanHint" style="margin-top:9px"></div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><div class="panel-title">手动录入条码</div></div>
        <div class="panel-body">
          <div class="form-row">
            <label class="form-label">条码内容</label>
            <input class="input input-full" id="manualCode" placeholder="扫码枪对准这里直接扫，或手动输入后回车">
            <div class="form-hint" id="codeInfo">支持 EAN-13 / EAN-8 / UPC / Code128 / ISBN / 二维码 / 内部编码</div>
          </div>
          <div class="toolbar" style="margin-top:12px">
            <button class="btn btn-primary btn-sm" id="btnManualGo">查询 / 录入</button>
            <button class="btn btn-sm" id="btnClearManual">清空</button>
          </div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">本次扫描记录</div>
        <button class="btn btn-sm" id="btnClearLog">清空记录</button>
      </div>
      <div class="panel-body flush">
        <div class="scan-log" id="scanLog">
          ${state.scanLog && state.scanLog.length
            ? state.scanLog.map(Views._logHtml).join('')
            : C.empty('▥', '还没有扫描记录', '启动摄像头或手动输入条码后会显示在这里')}
        </div>
      </div>
    </div>`;

  const video = el.querySelector('#scanVideo');
  const frame = el.querySelector('#scanFrame');
  const stateEl = el.querySelector('#scanState');
  const hint = el.querySelector('#scanHint');

  if (!state.scanLog) state.scanLog = [];
  if (!BarcodeScanner.supported) {
    hint.textContent = BarcodeScanner.decoderReady
      ? '这个环境没有可用的摄像头，建议用手动输入或扫码枪（两者体验相同）'
      : '识别组件未加载，请用手动输入或扫码枪';
    el.querySelector('#btnStartScan').disabled = true;
  } else {
    hint.textContent = '提示：条码对准框内，识别后会自动带到录入表单';
  }

  const scanner = new BarcodeScanner(
    video,
    (code, format) => {
      // 已经有弹窗开着时，不要再处理新的识别结果。
      //
      // 摄像头是一直在跑的，而用户扫到条码后通常不会立刻把手机移开 ——
      // 同一个条码 1.5 秒后就会被再次识别（见 util.js 里的去重窗口）。
      // 不管的话后果是一串：提示反复弹、扫描记录里同一条码刷出一堆重复行、
      // 正在等用户点按钮的对话框被整个重建（用户恰好点下去的那一下会落空）。
      // 最糟的是录入表单：扫 A 打开表单、正在填，扫到 B 会把表单整个换成 B，
      // 已经输入的内容无声消失。
      // 所以有弹窗在就把它当背景噪音忽略掉，关掉弹窗即可继续扫。
      const mr = document.getElementById('modalRoot');
      if (mr && !mr.hidden) return;
      App.toast(`识别到条码：${code}`, 'ok', 1500);
      Views._handleCode(el, state, code, format, '摄像头');
    },
    (msg) => {
      // 识别环节真的出错时说出来，不要再让用户对着「识别中」干等
      stateEl.textContent = '识别异常';
      hint.textContent = msg + '。可改用「从图片识别」或手动输入';
      App.toast(msg, 'err', 5000);
    }
  );

  const torchBtn = el.querySelector('#btnTorch');
  torchBtn.onclick = async () => {
    const on = torchBtn.dataset.on !== '1';
    const ok = await scanner.setTorch(on);
    if (ok) {
      torchBtn.dataset.on = on ? '1' : '0';
      torchBtn.textContent = on ? '关灯' : '开灯';
    } else {
      App.toast('这台设备不支持手电筒', 'warn');
      torchBtn.hidden = true;
    }
  };

  el.querySelector('#btnStartScan').onclick = async (e) => {
    e.target.disabled = true;
    stateEl.textContent = '正在启动…';
    const r = await scanner.start();
    if (r.ok) {
      stateEl.textContent = '识别中…';
      frame.hidden = false;
      frame.classList.add('scan-laser');
      el.querySelector('#btnStopScan').disabled = false;
      // 摄像头支持手电筒时才显示按钮（暗光下扫条码很依赖它）
      torchBtn.hidden = !scanner.torchSupported;
      hint.textContent = '把条码或二维码放进取景框，识别成功后自动处理';
    } else {
      e.target.disabled = false;
      stateEl.textContent = '启动失败';
      App.toast(r.reason, 'err', 4000);
      hint.textContent = r.reason;
    }
  };

  el.querySelector('#btnStopScan').onclick = async () => {
    await scanner.stop();
    stateEl.textContent = '已停止';
    frame.hidden = true;
    torchBtn.hidden = true;
    torchBtn.dataset.on = '0';
    torchBtn.textContent = '开灯';
    el.querySelector('#btnStartScan').disabled = !BarcodeScanner.supported;
    el.querySelector('#btnStopScan').disabled = true;
  };

  el.querySelector('#btnPickImage').onclick = () => el.querySelector('#scanFile').click();
  el.querySelector('#scanFile').onchange = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    App.toast('正在识别图片…', 'ok', 1500);
    try {
      const r = await BarcodeScanner.fromImage(file);
      if (r.ok) {
        Views._handleCode(el, state, r.code, r.format, '图片');
      } else {
        App.toast(r.reason, 'err', 3500);
      }
    } catch (err) {
      App.toast('图片识别失败：' + (err.message || err), 'err');
    }
    e.target.value = '';
  };

  const manual = el.querySelector('#manualCode');
  const go = () => {
    const code = manual.value.trim();
    if (!code) return;
    Views._handleCode(el, state, code, '', '手动');
  };
  el.querySelector('#btnManualGo').onclick = go;
  el.querySelector('#btnClearManual').onclick = () => {
    manual.value = '';
    manual.focus();
  };
  manual.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      go();
    }
  });
  manual.addEventListener('input', () => {
    const code = manual.value.trim();
    const info = el.querySelector('#codeInfo');
    if (!code) {
      info.textContent = '支持 EAN-13 / EAN-8 / UPC / Code128 / ISBN / 二维码 / 内部编码';
      info.style.color = '';
      return;
    }
    const type = U.barcodeType(code);
    const v = U.validateEan(code);
    if (v.valid === false) {
      info.textContent = `${type} · ${v.reason}`;
      info.style.color = 'var(--amber)';
    } else if (U.isInternalCode(code)) {
      info.textContent = '内部编码 · 回车可直接打开对应记录，查不到会问你要不要新建';
      info.style.color = 'var(--text-3)';
    } else if (U.isBookCode(code)) {
      const what = U.isIssnCode(code) ? 'ISSN' : 'ISBN';
      info.textContent = `${what}${v.valid === true ? ' · 校验位正确' : ''} · 回车会按图书录入`;
      info.style.color = v.valid === true ? 'var(--text-3)' : 'var(--amber)';
    } else {
      info.textContent = `${type}${v.valid === true ? ' · 校验位正确' : ''}`;
      info.style.color = 'var(--text-3)';
    }
  });

  el.querySelector('#btnClearLog').onclick = () => {
    state.scanLog = [];
    el.querySelector('#scanLog').innerHTML = C.empty('▥', '还没有扫描记录', '启动摄像头或手动输入条码后会显示在这里');
  };

  el.querySelector('#scanLog').onclick = (e) => {
    const b = e.target.closest('[data-log-id]');
    if (b) App.openItemEditor(b.dataset.logId);
  };

  setTimeout(() => manual.focus(), 100);
  state._stopScanner = () => scanner.stop();
};

Views._logHtml = function (r) {
  return `<div class="scan-log-item">
    <span class="tag ${r.matched ? 'tag-ok' : 'tag-plain'}">${r.matched ? '已存在' : '新条码'}</span>
    <span class="code">${U.esc(r.code)}</span>
    <span style="color:var(--text-3)">${U.esc(r.name || '')}</span>
    <span class="time">${U.esc(r.from)} · ${U.esc(r.time)}</span>
    ${r.itemId ? `<button class="btn btn-sm" data-log-id="${r.itemId}">打开</button>` : ''}
  </div>`;
};

Views._handleCode = async function (el, state, code, format, from) {
  // 先判断是不是本应用生成的二维码（位置码 / 物品码）。
  // 是的话直接定位到位置或打开物品详情，不走条码录入流程。
  const qr = window.QR && window.QR.parse ? window.QR.parse(code) : null;
  if (qr) return Views._handleQrCode(el, state, qr, code, from);

  const pushLog = (rec) => {
    state.scanLog = [rec].concat(state.scanLog || []).slice(0, 60);
    // el 可能为 null：扫码枪在别的页面扫的时候没有扫码页容器可用。
    // 记录照样存进 state.scanLog，用户回头打开扫码页就能看到这几条。
    const logEl = el && el.querySelector('#scanLog');
    if (logEl) logEl.innerHTML = state.scanLog.map(Views._logHtml).join('');
  };

  // 内部编码（HS-2026-0001）：这是给「没有条码的东西」自动生成的号，
  // 扫到它就该直接打开对应的那条记录，而不是当成新条码去建一条新的。
  if (U.isInternalCode(code)) {
    const r = await window.api.call('items.byCode', { code });
    const hit = r.data;
    pushLog({
      code,
      format: format || '内部编码',
      from,
      time: U.fmtTime(new Date().toISOString()),
      matched: !!hit,
      itemId: hit ? hit.id : null,
      name: hit ? hit.name : ''
    });
    if (hit) {
      App.toast(`已识别内部编码：${code}`, 'ok', 2000);
      App.openItemEditor(hit.id);
    } else {
      const go = await C.confirm(`内部编码 ${code} 还没有对应的记录。\n要新建一条并把它填进去吗？`, {
        title: '没有找到这条编码',
        okText: '新建记录'
      });
      // 只把编码填进「内部编码」字段，**不要**同时塞进「条码」字段：
      // 内部编码不是商品条码，塞进去编辑器的实时校验会立刻报「非数字条码」，
      // 而且同一条记录会同时挂着两个身份标识，搜索和去重都会变乱。
      if (go) App.openItemEditor(null, { code });
    }
    return;
  }

  // ISBN（978 / 979）和期刊条码（977）：扫的是书背/杂志封面上的条码，
  // 直接按图书录入，省得用户自己再想「这算不算物品」。
  // 但先查一下有没有录入过 —— 不然同一本书扫两次就变成两条重复记录。
  if (U.isBookCode(code)) {
    const what = U.isIssnCode(code) ? '期刊条码（ISSN）' : 'ISBN';
    const found = (await window.api.call('items.byBarcode', { barcode: code })).data;
    pushLog({
      code,
      format: format || what,
      from,
      time: U.fmtTime(new Date().toISOString()),
      matched: !!found,
      itemId: found ? found.id : null,
      name: found ? found.name : ''
    });
    if (found) {
      C.confirm(`${what} ${code} 已属于「${found.name}」。\n是否打开这本书？`, {
        title: '这本书已经录过了',
        okText: '打开'
      }).then((ok) => {
        if (ok) App.openItemEditor(found.id);
      });
      return;
    }
    const add = await C.confirm(`识别到 ${what} ${code}。\n按图书录入吗？`, {
      title: U.isIssnCode(code) ? '这是一本期刊' : '这是一本书',
      okText: '按图书录入'
    });
    if (add) {
      App.openItemEditor(null, {
        kind: 'book',
        barcode: code,
        barcodes: [code],
        // 只有 ISBN（978/979 开头）才联网查。977 开头的期刊条码在图书库里
        // 根本没有，拿去查是白等一次超时，还会让用户以为「网上没这本书」。
        lookupIsbn: U.isIsbn(code) ? code : ''
      });
    }
    return;
  }

  const res = await window.api.call('items.byBarcode', { barcode: code });
  const exist = res.data;
  pushLog({
    code,
    format: format || U.barcodeType(code),
    from,
    time: U.fmtTime(new Date().toISOString()),
    matched: !!exist,
    itemId: exist ? exist.id : null,
    name: exist ? exist.name : ''
  });

  if (exist) {
    C.confirm(`条码 ${code} 已属于「${exist.name}」。\n是否查看该物品？`, {
      title: '条码已存在',
      okText: '查看物品'
    }).then((ok) => {
      if (ok) App.openItemEditor(exist.id);
    });
  } else {
    App.openItemEditor(null, { barcode: code, barcodes: [code] });
  }
};

/* ---- 扫到本应用二维码：位置码看里面有什么，物品码看详情 ---- */
Views._handleQrCode = async function (el, state, qr, code, from) {
  const isItem = qr.type === 'item';
  const rec = {
    code,
    format: '二维码 · ' + (isItem ? '物品' : '位置'),
    from,
    time: U.fmtTime(new Date().toISOString()),
    matched: true,
    itemId: null,
    name: ''
  };
  state.scanLog = [rec].concat(state.scanLog || []).slice(0, 60);
  const logEl = el && el.querySelector('#scanLog');
  if (logEl) logEl.innerHTML = state.scanLog.map(Views._logHtml).join('');

  if (isItem) {
    const r = await window.api.call('items.get', { id: qr.id });
    if (!r.ok || !r.data) {
      App.toast('这个物品二维码对应的物品不存在（可能已删除）', 'err', 3500);
      return;
    }
    App.toast('已识别物品：' + r.data.name, 'ok', 2000);
    App.openItemEditor(qr.id);
    return;
  }

  const r = await window.api.call('locations.list');
  const loc = (r.data || []).find((l) => l.id === qr.id);
  if (!loc) {
    App.toast('这个位置二维码对应的位置不存在（可能已删除）', 'err', 3500);
    return;
  }
  App.toast('已识别位置：' + loc.path, 'ok', 2200);
  App.state.filters = Object.assign({}, App.state.filters, { location_id: loc.id });
  App.goto('items', { keepFilters: true });
};

/* ==================== 保质期 ==================== */
Views.expiry = async function (el, state) {
  const [sum, all] = await Promise.all([
    window.api.call('app.summary'),
    window.api.call('items.expiringSoon', { days: 3650 })
  ]);
  const s = sum.data || {};
  const warnDays = (s.settings && s.settings.expiryWarnDays) || 7;
  const list = all.data || [];
  const expired = list.filter((i) => i.days_left < 0);
  const soon = list.filter((i) => i.days_left >= 0 && i.days_left <= warnDays);
  const later = list.filter((i) => i.days_left > warnDays);

  const section = (title, arr, cls, emptyText) => `
    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">${title} <span style="color:var(--text-3);font-weight:400">(${arr.length})</span></div>
      </div>
      <div class="panel-body flush">
        ${arr.length
          ? `<div class="item-list">${arr.map((i) => App.itemRowHtml(i)).join('')}</div>`
          : C.empty('✓', emptyText, '')}
      </div>
    </div>`;

  el.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">保质期管理</div>
        <div class="page-sub">当前临期阈值：${warnDays} 天（可在设置中调整）</div>
      </div>
      <div class="toolbar">
        <button class="btn btn-sm" id="btnWarnDays">调整阈值</button>
      </div>
    </div>

    <div class="cards">
      <div class="card"><div class="card-label">已过期</div><div class="card-value ${expired.length ? 'bad' : ''}">${expired.length}</div></div>
      <div class="card"><div class="card-label">${warnDays} 天内到期</div><div class="card-value ${soon.length ? 'warn' : ''}">${soon.length}</div></div>
      <div class="card"><div class="card-label">有保质期物品</div><div class="card-value">${list.length}</div></div>
    </div>

    ${section('已过期', expired, 'bad', '没有过期物品')}
    ${section('即将到期', soon, 'warn', '近期没有到期物品')}
    ${section('其他有保质期物品', later, '', '暂无')}
  `;

  el.querySelector('#btnWarnDays').onclick = () => {
    C.form({
      title: '临期提醒天数',
      fields: [
        {
          key: 'days',
          label: '提前多少天提醒',
          type: 'number',
          min: 1,
          max: 365,
          value: warnDays,
          required: true,
          hint: '例如填 7，则到期前 7 天开始显示为「即将到期」'
        }
      ],
      onSubmit: async (v) => {
        await window.api.call('app.settings.set', { expiryWarnDays: Number(v.days) });
        App.toast('已更新提醒阈值');
        App.goto('expiry');
      }
    });
  };

  el.onclick = (e) => App.handleRowClick(e);
};

/* ==================== 位置管理 ==================== */
Views.locations = async function (el, state) {
  const [treeRes, listRes] = await Promise.all([
    window.api.call('locations.tree'),
    window.api.call('locations.list')
  ]);
  const tree = treeRes.data || [];
  const flat = listRes.data || [];

  const nfcSupported = !!(window.api.nfc && window.api.nfc.supported && window.api.nfc.supported());
  const nfcHint = nfcSupported
    ? '<div class="form-hint" style="margin:0 0 6px">已支持 NFC：在「编辑位置」里绑定标签，之后在任意界面碰一下手机，就能直接看到该位置里有什么。</div>'
    : '';
  const qrHint =
    '<div class="form-hint" style="margin:0 0 14px">点每行右侧的 ▦ 可生成该位置的二维码：打印后贴在箱子/抽屉上，之后用「扫码」扫一下就能直接看到里面有什么。</div>';

  const rows = [];
  const walk = (nodes) => {
    nodes.forEach((n) => {
      rows.push(n);
      if (n.children && n.children.length) walk(n.children);
    });
  };
  walk(tree);

  el.innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">位置管理</div>
        <div class="page-sub">按「房间 → 柜子 → 层/格子」组织，支持任意层级</div>
      </div>
      <div class="toolbar">
        <button class="btn btn-primary btn-sm" data-act="add-loc">＋ 新增位置</button>
      </div>
    </div>

    ${nfcHint}
    ${qrHint}

    <div class="panel">
      <div class="panel-head"><div class="panel-title">位置结构（共 ${flat.length} 个）</div></div>
      <div class="panel-body flush">
        <div class="tree-editor" id="treeEditor">
          ${rows.length
            ? rows
                .map(
                  (n) => `
            <div class="tree-row" data-id="${n.id}">
              <div class="tree-indent" style="padding-left:${n.depth * 18}px">
                <span style="color:var(--text-3);font-size:11px">${n.children && n.children.length ? '▾' : '·'}</span>
              </div>
              <div style="flex:1;min-width:0">
                <div class="tree-name">${U.esc(n.name)}</div>
                <div class="tree-path">${U.esc(n.children && n.children.length ? '' : '')}${n.total_count} 件物品</div>
              </div>
              <div class="tree-actions">
                <button class="icon-btn" data-qr="${n.id}" title="生成二维码">▦</button>
                <button class="icon-btn" data-edit="${n.id}" title="编辑">✎</button>
                <button class="icon-btn" data-addsub="${n.id}" title="添加子位置">＋</button>
                <button class="icon-btn danger" data-del="${n.id}" title="删除">🗑</button>
              </div>
            </div>`
                )
                .join('')
            : C.empty('◱', '还没有位置', '点击右上角新增第一个收纳位置')}
        </div>
      </div>
    </div>`;

  el.querySelector('[data-act="add-loc"]').onclick = () => App.openLocEditor(null);
  el.querySelector('#treeEditor').onclick = async (e) => {
    const edit = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-del]');
    const addsub = e.target.closest('[data-addsub]');
    const qr = e.target.closest('[data-qr]');
    if (qr) {
      const node = flat.find((l) => l.id === qr.dataset.qr);
      return App.showQr({
        type: 'loc',
        id: qr.dataset.qr,
        name: node ? node.name : '',
        title: '位置二维码',
        subtitle: node ? node.path : ''
      });
    }
    if (edit) return App.openLocEditor(edit.dataset.edit);
    if (addsub) return App.openLocEditor(null, addsub.dataset.addsub);
    if (del) {
      const id = del.dataset.del;
      const node = flat.find((l) => l.id === id);
      const ok = await C.confirm(
        `确定删除位置「${node ? node.path : ''}」吗？\n该位置下的物品会被移到「未指定位置」。`,
        { title: '删除位置', danger: true, okText: '删除' }
      );
      if (!ok) return;
      const r = await window.api.call('locations.delete', { id, force: true });
      if (r.ok) {
        App.toast('已删除');
        App.refreshAll();
      } else App.toast(r.error, 'err');
    }
  };
};

/* ==================== 统计 ==================== */
Views.stats = async function (el) {
  const r = await window.api.call('items.stats');
  const s = r.data || {};
  const maxCat = Math.max(1, ...(s.categories || []).map((c) => c.value));
  const maxLoc = Math.max(1, ...(s.locations || []).map((c) => c.value));
  const maxTrend = Math.max(1, ...(s.trend || []).map((c) => c.value));
  // 统计的是三类记录的合集，卡片上必须写清楚拆成多少 ——
  // 把书和合同一并算成「物品种类」会让人以为家里有 300 件东西。
  const k = s.kinds || {};
  const kindFoot = `物品 ${k.goods || 0} · 资料 ${k.doc || 0} · 图书 ${k.book || 0}`;

  const bars = (arr, max, color) =>
    arr && arr.length
      ? `<div class="bar-chart">${arr
          .map(
            (c) => `<div class="bar-row">
        <div class="bar-label" title="${U.esc(c.name)}">${U.esc(c.name)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(c.value / max) * 100}%;${color ? `background:${color}` : ''}"></div></div>
        <div class="bar-value">${c.value}</div>
      </div>`
          )
          .join('')}</div>`
      : C.empty('◔', '暂无数据', '添加物品后这里会显示统计');

  el.innerHTML = `
    <div class="page-head">
      <div><div class="page-title">统计</div>
      <div class="page-sub">看看家里东西都堆在哪、值多少钱</div></div>
    </div>

    <div class="cards">
      <div class="card"><div class="card-label">记录总数</div><div class="card-value">${s.total || 0}</div>
        <div class="card-foot">${kindFoot}</div></div>
      <div class="card"><div class="card-label">总数量</div><div class="card-value">${s.totalQty || 0}</div>
        <div class="card-foot">三类记录按各自单位累加</div></div>
      <div class="card"><div class="card-label">估算总价值</div><div class="card-value good">¥${U.fmtMoney(s.totalValue || 0)}</div>
        <div class="card-foot">按录入单价 × 数量估算</div></div>
      <div class="card"><div class="card-label">待处理</div><div class="card-value ${s.expired ? 'bad' : ''}">${(s.expired || 0) + (s.soon || 0)}</div>
        <div class="card-foot">过期 ${s.expired || 0} · 临期 ${s.soon || 0}（只统计物品）</div></div>
    </div>

    <div class="panel"><div class="panel-head"><div class="panel-title">按分类分布</div></div>
      <div class="panel-body">${bars(s.categories, maxCat)}</div></div>

    <div class="panel"><div class="panel-head"><div class="panel-title">按位置分布</div></div>
      <div class="panel-body">${bars(s.locations, maxLoc, '#1d9e75')}</div></div>

    <div class="panel"><div class="panel-head"><div class="panel-title">近 6 个月入库趋势</div></div>
      <div class="panel-body">
        ${
          s.trend && s.trend.some((t) => t.value)
            ? `<div class="trend">${s.trend
                .map(
                  (t) => `<div class="trend-col">
            <div style="font-size:11px;color:var(--text-3)">${t.value}</div>
            <div class="trend-bar" style="height:${Math.max(3, (t.value / maxTrend) * 100)}%"><span></span></div>
            <div class="trend-label">${U.esc(t.name)}</div>
          </div>`
                )
                .join('')}</div>`
            : C.empty('◔', '暂无入库记录', '')
        }
      </div></div>`;
};

/* ==================== 设置 ==================== */
Views.settings = async function (el) {
  const [infoRes, setRes, sumRes] = await Promise.all([
    window.api.appInfo(),
    window.api.call('app.settings.get'),
    window.api.call('app.summary')
  ]);
  const info = infoRes || {};
  const st = setRes.data || {};

  el.innerHTML = `
    <div class="page-head">
      <div><div class="page-title">设置</div>
      <div class="page-sub">数据、同步与备份</div></div>
    </div>

    <div class="panel">
      <div class="panel-head"><div class="panel-title">分类管理</div></div>
      <div class="panel-body">
        <div class="toolbar">
          <button class="btn btn-sm" id="btnManageCats">管理分类</button>
        </div>
        <div class="form-hint" style="margin-top:10px">
          新增、改名、换颜色或删除分类。删除分类后，原本归在它下面的记录会变成「未分类」，
          记录本身不会被删掉。
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><div class="panel-title">提醒设置</div></div>
      <div class="panel-body">
        <div class="form-row" style="max-width:320px">
          <label class="form-label">临期提醒天数</label>
          <div class="form-inline">
            <input class="input" type="number" id="setWarnDays" min="1" max="365" value="${st.expiryWarnDays || 7}">
            <button class="btn btn-sm" id="btnSaveWarn">保存</button>
          </div>
          <div class="form-hint">到期前多少天开始标记为「即将到期」</div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><div class="panel-title">扫码枪</div></div>
      <div class="panel-body">
        <div class="form-row" style="max-width:320px">
          <label class="form-label">扫码枪前缀</label>
          <div class="form-inline">
            <input class="input" id="setScanPrefix" maxlength="1" value="${U.esc(st.scannerPrefix || '')}" placeholder="留空表示不用">
            <button class="btn btn-sm" id="btnSaveScanPrefix">保存</button>
          </div>
          <div class="form-hint">
            有扫码枪才需要填。填一个字符（例如 <b>$</b>），再到扫码枪的说明里把它的
            <b>前缀</b>设成同一个字符。之后在任何页面扫一下都能直接打开或新建记录，
            条码也不会被打进你正在填的输入框里。
          </div>
          <div class="form-hint">
            注意：开启后输入框里就<b>打不出</b>这个字符了（会被当成扫码枪的前缀）。
            平时不用扫码枪的话留空即可。
          </div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <div class="panel-title">数据同步（NAS 私有云）</div>
        <span class="page-sub" id="syncStatusText">${st.syncEnabled ? '已开启' : '未开启'}</span>
      </div>
      <div class="panel-body">
        <div class="form-grid">
          <div class="form-row full">
            <label class="form-label">服务器地址</label>
            <input class="input input-full" id="setSyncUrl" value="${U.esc(st.syncUrl || '')}" placeholder="http://192.168.1.100:8787">
            <div class="form-hint">填 NAS 上 Docker 后端服务的地址与端口</div>
          </div>
          <div class="form-row">
            <label class="form-label">账号</label>
            <input class="input input-full" id="setSyncUser" value="${U.esc(st.syncUser || '')}" placeholder="用户名">
          </div>
          <div class="form-row">
            <label class="form-label">密码</label>
            <input class="input input-full" id="setSyncPass" type="password" placeholder="${st.syncToken ? '已登录，留空则不修改' : '密码'}">
          </div>
          <div class="form-row full">
            <label class="form-label">设备名称</label>
            <input class="input input-full" id="setDeviceName" value="${U.esc(st.deviceName || '')}" placeholder="例如：客厅电脑 / 笔记本">
            <div class="form-hint">用于区分不同设备，同步记录里会标注来源</div>
          </div>
        </div>

        <div class="form-hint" style="margin-top:4px; line-height:1.9">
          <b>首次使用顺序</b>：填写上面三项 → 点「测试连接」确认能连上 → 点「注册新账号」→ 再点「登录并保存」。<br>
          账号密码是你在 NAS 上自建的，不需要联网、不需要手机号。换设备时<b>不要重复注册</b>，
          直接用同一账号密码点「登录并保存」即可共用数据。
        </div>

        <div class="toolbar" style="margin-top:14px">
          <button class="btn btn-sm" id="btnTestSync">测试连接</button>
          <button class="btn btn-sm" id="btnRegister">注册新账号</button>
          <button class="btn btn-primary btn-sm" id="btnLoginSync">登录并保存</button>
          <button class="btn btn-sm" id="btnSyncNow2">立即同步</button>
        </div>
        <div class="form-hint" id="syncMsg" style="margin-top:10px">
          上次同步：${st.lastSyncAt ? U.esc(U.fmtTime(st.lastSyncAt)) : '从未同步'}
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><div class="panel-title">备份与恢复</div></div>
      <div class="panel-body">
        <div class="toolbar">
          <button class="btn btn-sm" id="btnExportJson">导出 JSON 备份</button>
          <button class="btn btn-sm" id="btnExportCsv">导出 CSV 表格</button>
          <button class="btn btn-sm" id="btnImport">导入备份</button>
          <button class="btn btn-sm" id="btnOpenData">打开数据目录</button>
        </div>
        <div class="form-hint" style="margin-top:8px">CSV 含全部三类记录（物品 / 资料 / 图书），用「类型」列就能筛；资料的文件编号、图书的作者出版社都在里面</div>
        <div class="form-hint" style="margin-top:10px">
          JSON 备份包含全部数据，可完整恢复；CSV 便于用 Excel 查看。
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><div class="panel-title">危险操作</div></div>
      <div class="panel-body">
        <div class="toolbar">
          <button class="btn btn-danger btn-sm" id="btnWipe">清空所有数据</button>
        </div>
        <div class="form-hint" style="margin-top:10px">清空后不可恢复，请先导出备份。</div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><div class="panel-title">关于</div></div>
      <div class="panel-body">
        <div class="form-hint" style="line-height:1.9">
          家庭收纳 v${U.esc(info.version || '1.0.0')}<br>
          数据文件：${U.esc(info.userData || '')}<br>
          数据完全存放在本机，开启同步后才会上传到你的 NAS。
        </div>
      </div>
    </div>`;

  el.querySelector('#btnManageCats').onclick = async () => {
    // 改过分类才刷新：弹窗里的改动会影响筛选条的分类 chip 和列表里的分类名
    const changed = await App.manageCategories();
    if (changed) App.refreshAll();
  };

  el.querySelector('#btnSaveWarn').onclick = async () => {
    const v = Number(el.querySelector('#setWarnDays').value) || 7;
    await window.api.call('app.settings.set', { expiryWarnDays: v });
    App.toast('已保存');
    App.refreshSide();
  };

  el.querySelector('#btnSaveScanPrefix').onclick = async () => {
    const v = el.querySelector('#setScanPrefix').value.trim();
    // 只收「一个可见的 ASCII 字符」。扫码枪能配的前缀基本就是这个范围，
    // 而汉字、空格、控制符既配不出来、也没法从键盘上稳定地打出来 ——
    // 收下了只会在 keydown 里变成一个永远匹配不上的死前缀。
    if (v && !/^[\x21-\x7e]$/.test(v)) {
      App.toast('前缀请填一个英文符号或字母（例如 $ 或 ~）', 'err', 3500);
      return;
    }
    await window.api.call('app.settings.set', { scannerPrefix: v });
    // 立刻写回本地状态：keydown 那边是拿 App.state.settings.scannerPrefix 跟前一个
    // 前缀比对、变了才重建识别器的。不写回的话，这次改动要等下一次 refreshSide 才生效。
    App.state.settings = Object.assign({}, App.state.settings, { scannerPrefix: v });
    App.toast(v ? `已开启：扫码枪前缀「${v}」` : '已关闭扫码枪前缀');
  };

  el.querySelector('#btnExportJson').onclick = () => App.exportData('json');
  el.querySelector('#btnExportCsv').onclick = () => App.exportData('csv');
  el.querySelector('#btnImport').onclick = () => App.importData();
  el.querySelector('#btnOpenData').onclick = () => window.api.openPath(info.userData || '');

  el.querySelector('#btnWipe').onclick = async () => {
    const ok = await C.confirm('确定清空所有物品与位置数据吗？\n此操作不可恢复，建议先导出备份。', {
      title: '清空数据',
      danger: true,
      okText: '确认清空'
    });
    if (!ok) return;
    const r = await window.api.call('app.wipe');
    if (r.ok) {
      App.toast('已清空');
      App.refreshAll();
    } else App.toast(r.error, 'err');
  };

  const readSyncForm = () => ({
    syncUrl: el.querySelector('#setSyncUrl').value.trim(),
    syncUser: el.querySelector('#setSyncUser').value.trim(),
    deviceName: el.querySelector('#setDeviceName').value.trim()
  });

  // 设置里存的字段叫 syncUrl / syncUser，而同步接口的参数叫 url / username。
  // 两者名字不同，必须在这里显式转换，否则注册和登录都会拿到 undefined。
  const toSyncPayload = (f, pass) => ({
    url: f.syncUrl,
    username: f.syncUser,
    password: pass,
    deviceName: f.deviceName
  });

  el.querySelector('#btnTestSync').onclick = async () => {
    const url = el.querySelector('#setSyncUrl').value.trim();
    if (!url) return App.toast('请先填写服务器地址', 'warn');
    const msg = el.querySelector('#syncMsg');
    msg.textContent = '正在连接…';
    const r = await window.api.sync.test(url);
    if (r.ok) {
      msg.textContent = `连接成功：${(r.data && r.data.name) || '家庭收纳同步服务'}（${(r.data && r.data.version) || '1.0'}）`;
      App.toast('连接成功', 'ok');
    } else {
      msg.textContent = '连接失败：' + r.error;
      App.toast(r.error, 'err', 4000);
    }
  };

  el.querySelector('#btnRegister').onclick = async () => {
    const f = readSyncForm();
    const pass = el.querySelector('#setSyncPass').value;
    if (!f.syncUrl || !f.syncUser || !pass) return App.toast('请填写地址、账号和密码', 'warn');
    const r = await window.api.sync.register(toSyncPayload(f, pass));
    if (r.ok) {
      App.toast('注册成功，请点击「登录并保存」', 'ok', 3500);
      el.querySelector('#syncMsg').textContent = '注册成功，现在可以登录了';
    } else App.toast(r.error, 'err', 4000);
  };

  el.querySelector('#btnLoginSync').onclick = async () => {
    const f = readSyncForm();
    const pass = el.querySelector('#setSyncPass').value;
    if (!f.syncUrl || !f.syncUser || !pass) return App.toast('请填写地址、账号和密码', 'warn');
    await window.api.call('app.settings.set', Object.assign({ syncEnabled: true }, f));
    const r = await window.api.sync.login(toSyncPayload(f, pass));
    if (r.ok) {
      await window.api.call('app.settings.set', {
        syncToken: r.data.token,
        syncEnabled: true
      });
      App.toast('登录成功，已开启同步', 'ok');
      el.querySelector('#setSyncPass').value = '';
      App.refreshSide();
      App.goto('settings');
    } else {
      App.toast(r.error, 'err', 4000);
      el.querySelector('#syncMsg').textContent = '登录失败：' + r.error;
    }
  };

  el.querySelector('#btnSyncNow2').onclick = () => App.doSync();
};

window.Views = Views;
