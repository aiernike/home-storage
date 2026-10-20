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

/**
 * 各类型允许出现在 `extra` 里的字段。
 *
 * 为什么要有白名单：`extra` 是个自由对象，字段名拼错（`author` 写成 `auther`）
 * 以前不报错 —— 存进库、界面永远不显示、导出 CSV 也是空的，还跟着同步传到所有
 * 设备。用户只会觉得「我明明填了作者，怎么没有」，而系统一句提示都没有。
 *
 * ⚠️ 这里的键必须和渲染层表单字段（app.js 里 `x_` 开头的那些）一一对应。
 * 渲染层加了字段却忘了往这里加，那个字段会**永远存不进去**且不报错 ——
 * `test-store` 有一条断言盯着两边一致，别只改一处。
 */
const KIND_EXTRA_KEYS = {
  goods: [],
  doc: ['doc_no', 'year', 'org', 'amount', 'keep_until'],
  book: ['author', 'publisher', 'pub_year', 'status']
};

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

    /**
     * 数据来自更新的版本（用户先用新版打开过，又用旧版打开）。
     *
     * 不能按老结构去迁移它 —— 新版本加的字段会被当成「不认识的字段」丢掉。
     * 也**不能在这里抛异常**：load() 会把异常当成「文件损坏」，进而拿备份来覆盖，
     * 甚至把主文件和备份都留档之后开一个空库 —— 那是把用户数据推下悬崖。
     * 所以只做上面那几项「保证结构不崩」的兜底，然后原样返回，
     * **连 schema 都不改**，这样下次用新版本打开时它还是原来那个版本。
     */
    if (from > SCHEMA_VERSION) {
      console.error(`数据文件来自更新的版本（v${from}），本次不做迁移、按原样加载`);
      return raw;
    }

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
  // 本次会话是否已经备过份（说明见 flush）
  let backupDone = false;

  function save() {
    // 合并短时间内的多次写入，避免频繁 IO
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 120);
  }

  function flush() {
    saveTimer = null;
    try {
      const tmp = dbFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
      /**
       * 备份只在本次会话第一次「有东西可备」的时候做一次。
       *
       * 原来是每次落盘都 copyFileSync 整个数据文件 —— 数据文件 5 MB 时，
       * 连续编辑（120ms 防抖）就等于每秒重复复制几十 MB；而 .bak 的语义本来就是
       * 「回到这次会话开始前的样子」，每次刷新它反而把这个语义冲淡了。
       *
       * 第一次落盘时主文件往往还不存在（新库），那次跳过、**标志不置位**，
       * 等主文件建起来再备 —— 否则新库会一次备份都留不下。
       * 坏的主文件在 load() 里已经被挪走了，所以这里备份的一定是可信的主文件。
       */
      if (!backupDone && fs.existsSync(dbFile)) {
        fs.copyFileSync(dbFile, dbFile + '.bak');
        backupDone = true;
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

  /**
   * 建一份「按 id 查」的临时索引，供批量路径使用（列表 / 统计 / 临期）。
   *
   * 为什么是「临时」而不是常驻全局索引：db 的四个数组会被多处**整体替换**
   * （load / app.wipe / app.import 的 replace / 同步合并直接改 store.raw），
   * 常驻索引就得在每个替换点手动失效 —— 漏一处不会报错，只会查到已经不存在的
   * 旧记录，界面上冒出幽灵数据，极难排查。批量路径里建一次、用完即弃，
   * 代价是 O(位置数 + 分类数 + 图片数)，换来的是「每条物品不再线性扫描这三个数组」。
   *
   * 之前是每条物品各查一遍：2000 件物品 + 5000 张图时，一次列表要跑
   * 约 2000 × 5000 = 一千万次比较，而每敲一个字搜索都要重来一遍。
   */
  function buildLookup() {
    return {
      locations: new Map(db.locations.map((l) => [l.id, l])),
      categories: new Map(db.categories.map((c) => [c.id, c])),
      images: new Map(db.images.map((x) => [x.id, x]))
    };
  }

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const target = new Date(dateStr + 'T00:00:00');
    if (isNaN(target.getTime())) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((target - today) / 86400000);
  }

  /**
   * 给物品补上界面要用的关联信息（位置路径、分类名与颜色、图片、保质期状态）。
   *
   * @param {object} it 物品记录
   * @param {object} [lk] 可选的临时索引（buildLookup 的产物）。
   *   批量路径（列表 / 统计 / 临期）**必须传** —— 不传的话每条物品都要把位置、
   *   分类、图片三个数组线性扫一遍，物品一多就是平方级的开销。
   *   单条查询（items.get 之类）不传也没关系，反正只查一次。
   */
  function decorateItem(it, lk) {
    // ⚠️ 只认「确实带着三个 Map」的索引对象。
    // 必须挡一下：`arr.map(decorateItem)` 这种写法会把**数组下标**当第二个参数传进来
    // （map 回调的第二参是 index），不挡就会读到 `undefined.get` 直接崩，
    // 而且崩的地方离写错的地方很远。挡一下最多退化成线性查找，不会炸。
    const idx = lk && lk.locations && lk.categories && lk.images ? lk : null;
    const loc = it.location_id
      ? (idx ? idx.locations.get(it.location_id) : db.locations.find((l) => l.id === it.location_id))
      : null;
    const cat = it.category_id
      ? (idx ? idx.categories.get(it.category_id) : db.categories.find((c) => c.id === it.category_id))
      : null;
    const imgRec = it.image_id
      ? (idx ? idx.images.get(it.image_id) : db.images.find((x) => x.id === it.image_id))
      : null;
    const img = imgRec && !imgRec.deleted ? imgRec : null;
    const dl = daysUntil(it.expiry_date);
    return Object.assign({}, it, {
      location_name: loc && !loc.deleted ? loc.name : '',
      location_path: loc && !loc.deleted ? locationPath(loc.id, undefined, idx) : '',
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

  /**
   * 位置 id → 「厨房 / 冰箱 / 冷藏室」这样的完整路径。
   *
   * @param {object} [lk] 临时索引（见 buildLookup）。批量路径要传 ——
   *   不传的话每往上一层都要把整个位置数组扫一遍，层级一深就是平方级。
   */
  function locationPath(id, sep, lk) {
    sep = sep || ' / ';
    const get = lk ? (i) => lk.locations.get(i) : (i) => db.locations.find((l) => l.id === i);
    const names = [];
    let cur = get(id);
    let guard = 0;
    while (cur && guard++ < 20) {
      names.unshift(cur.name);
      cur = cur.parent_id ? get(cur.parent_id) : null;
    }
    return names.join(sep);
  }

  function barcodeList(item) {
    if (!item) return [];
    if (Array.isArray(item.barcodes) && item.barcodes.length) return item.barcodes;
    return item.barcode ? [item.barcode] : [];
  }

  /**
   * 导出用的设置副本：**剔除同步令牌**。
   *
   * 令牌是服务端签发的 JWT（90 天有效），拿着它就能读写这个账号在 NAS 上的
   * 全部数据。而「导出备份」恰恰是被界面鼓励的操作 —— 图片存不下时的提示就写着
   * 「请先导出备份」。备份又常被发到家庭群、传网盘、发给技术支持，令牌跟着走，
   * 等于把 NAS 的钥匙一起送出去。
   *
   * 这里删掉这个键（而不是置空）：置空的话，把备份导回本机反而会把自己的登录
   * 状态清掉；删掉键则不会覆盖本机已有的令牌。
   */
  function exportSettings() {
    const s = Object.assign({}, db.settings);
    delete s.syncToken;
    return s;
  }

  /**
   * 导入时永远不采纳备份里的同步令牌 —— 以本机为准。
   *
   * 光靠「导出时剔除」不够：备份文件是普通 JSON，谁都能手工编辑。塞一个别人的
   * 令牌进来，本机下次同步就会把自己的数据推到别人账号里，而界面上只显示
   * 「同步完成」。
   */
  function withoutSyncToken(s) {
    const o = Object.assign({}, s || {});
    delete o.syncToken;
    return o;
  }

  /**
   * 按类型过滤 extra 的字段名（白名单见模块顶部的 KIND_EXTRA_KEYS）。
   * 拼错的字段名在这里被丢掉，而不是静默存进库、界面永远显示不出来。
   */
  function sanitizeExtra(kind, raw) {
    if (!raw || typeof raw !== 'object') return {};
    const allow = KIND_EXTRA_KEYS[normalizeKind(kind)] || [];
    const out = {};
    Object.keys(raw).forEach((k) => {
      if (allow.indexOf(k) >= 0) out[k] = raw[k];
    });
    return out;
  }

  // ---------------- 动作路由 ----------------

  const actions = {
    // ---- 总体 ----
    'app.summary': () => {
      // 一趟遍历算完所有计数。原来是 live(db.items) 出现 6 次，
      // 同一条记录的 daysUntil 还要算两遍（expired 一次、soon 一次）。
      const warn = db.settings.expiryWarnDays || 7;
      const items = live(db.items);
      let expired = 0;
      let soon = 0;
      let noLocation = 0;
      let docs = 0;
      let books = 0;
      items.forEach((i) => {
        const d = daysUntil(i.expiry_date);
        if (d !== null) {
          if (d < 0) expired++;
          else if (d <= warn) soon++;
        }
        if (!i.location_id) noLocation++;
        const k = normalizeKind(i.kind);
        if (k === 'doc') docs++;
        else if (k === 'book') books++;
      });
      return {
        items: items.length,
        locations: live(db.locations).length,
        expired,
        soon,
        noLocation,
        docs,
        books,
        settings: db.settings
      };
    },

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
      settings: exportSettings()
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
        // 备份里的设置照单全收，但令牌除外 —— 令牌永远以本机为准
        if (raw.settings) Object.assign(db.settings, withoutSyncToken(raw.settings));
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
      // 先把物品按位置分一次桶，再逐个位置取数。
      // 原来是每个位置都 live(db.items).filter(...) 扫一遍全表 —— 位置数 × 物品数。
      const lk = buildLookup();
      const countByLoc = new Map();
      live(db.items).forEach((i) => {
        if (!i.location_id) return;
        countByLoc.set(i.location_id, (countByLoc.get(i.location_id) || 0) + 1);
      });
      const list = live(db.locations).map((l) => {
        const path = locationPath(l.id, undefined, lk);
        const direct = countByLoc.get(l.id) || 0;
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
      const lk = buildLookup();
      const all = live(db.locations).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name, 'zh-CN'));
      const byParent = new Map();
      all.forEach((l) => {
        const key = l.parent_id || '__root__';
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(l);
      });
      // 物品数先分一次桶：原来是每个位置（递归里每个节点）都扫一遍物品表
      const countByLoc = new Map();
      live(db.items).forEach((i) => {
        if (!i.location_id) return;
        countByLoc.set(i.location_id, (countByLoc.get(i.location_id) || 0) + 1);
      });
      const build = (parentId, depth) => {
        const list = byParent.get(parentId || '__root__') || [];
        const out = [];
        list.forEach((l) => {
          const children = build(l.id, depth + 1);
          const direct = countByLoc.get(l.id) || 0;
          const total = direct + children.reduce((s, c) => s + c.total_count, 0);
          out.push(
            Object.assign({}, l, {
              depth,
              // path 供「上级位置」下拉等场景显示完整层级路径。
              // 不能省：渲染层从树上构建扁平列表，缺了它标签会变成 undefined。
              path: locationPath(l.id, undefined, lk),
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

    // 改层级没有单独的 action：`locations.save` 传 parent_id 就是这件事，
    // 而且它同样带环检测。曾经有个 locations.move 做一模一样的事，已经删掉 ——
    // 两套写法做同一件事，将来改一处漏一处。
    // 界面上的入口在「位置管理 → 编辑」，那个「上级位置」下拉提交的就是 locations.save。

    // ---- 分类 ----
    'categories.list': () => live(db.categories).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0)),

    'categories.save': (p) => {
      const t = now();
      if (p.id) {
        const c = db.categories.find((x) => x.id === p.id);
        if (!c) throw new Error('分类不存在');
        if (p.name != null) {
          // 名称是分类唯一的可见标识。改成空的会在筛选条上留下一个空白 chip，
          // 点进去还筛不出任何东西 —— 与其静默存下，不如直接拦住。
          const name = String(p.name).trim();
          if (!name) throw new Error('分类名称不能为空');
          c.name = name;
        }
        if (p.color != null) c.color = p.color;
        touch(c);
        save();
        return c;
      }
      const name = String(p.name || '').trim();
      if (!name) throw new Error('请填写分类名称');
      // 新建分类的 key 用「栏目:随机串」。
      //
      // 分类属于哪个栏目（物品 / 办公资料 / 图书）是从 key 推出来的（渲染层 U.catKindOf）：
      // 预置分类的 key 是「食品」「合同」「图书」这类短名，对不上的一律算物品。
      // 不把栏目写进 key 的话，用户新建的「会计凭证」永远只会出现在物品页的分类下拉里，
      // 在办公资料页怎么找都找不到 —— 而这类自定义分类恰恰是资料页最需要的。
      const kind = ['goods', 'doc', 'book'].indexOf(p.kind) >= 0 ? p.kind : 'goods';
      const c = {
        id: uid(),
        key: p.key || kind + ':' + uid(),
        name,
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
      const lk = buildLookup();
      const f = p || {};
      const warn = db.settings.expiryWarnDays || 7;
      // 下面三个小函数让「筛选」能在**原始记录**上做，不必先把记录装饰一遍。
      // 装饰要算位置路径、分类名色、图片、保质期状态，是这条路径里最贵的一步。
      const expiryStateOf = (it) => {
        const d = daysUntil(it.expiry_date);
        return d === null ? 'none' : d < 0 ? 'expired' : d <= warn ? 'soon' : 'ok';
      };
      const catNameOf = (it) => {
        const c = it.category_id ? lk.categories.get(it.category_id) : null;
        return c && !c.deleted ? c.name || '' : '';
      };
      const locPathOf = (it) => {
        const l = it.location_id ? lk.locations.get(it.location_id) : null;
        return l && !l.deleted ? locationPath(l.id, undefined, lk) : '';
      };

      /**
       * ⚠️ 顺序很重要：**先筛，后装饰**。
       *
       * 原来是先把全库每条都 decorateItem 一遍，再拿装饰结果去筛。于是搜索框每敲
       * 一个字，都要给全库每一条算一遍位置路径、分类、图片和保质期状态 ——
       * 命中往往只有一两条，其余全是白干的。先筛后装饰，装饰量 = 命中量。
       *
       * 排序键（updated_at / created_at / name / expiry_date / quantity）全是原始字段，
       * 所以排序也可以放在装饰之前。
       */
      let list = live(db.items);
      if (f.keyword) {
        const k = String(f.keyword).toLowerCase();
        list = list.filter(
          (i) =>
            (i.name || '').toLowerCase().includes(k) ||
            (i.barcode || '').toLowerCase().includes(k) ||
            (i.barcodes || []).some((b) => String(b).toLowerCase().includes(k)) ||
            (i.code || '').toLowerCase().includes(k) ||
            (i.note || '').toLowerCase().includes(k) ||
            // 类型专属字段也要能搜到：搜「张老师」「人民邮电」「2026」都要有结果
            Object.keys(i.extra || {}).some((key) => String(i.extra[key] || '').toLowerCase().includes(k)) ||
            // 分类名和位置路径要查关联表 —— 走索引直接查，不用先装饰
            catNameOf(i).toLowerCase().includes(k) ||
            locPathOf(i).toLowerCase().includes(k)
        );
      }
      if (f.kind) {
        const kinds = Array.isArray(f.kind) ? f.kind : [f.kind];
        list = list.filter((i) => kinds.indexOf(normalizeKind(i.kind)) >= 0);
      }
      if (f.location_id) {
        const ids = subtreeIds(f.location_id);
        list = list.filter((i) => i.location_id && ids.has(i.location_id));
      }
      if (f.category_id) list = list.filter((i) => i.category_id === f.category_id);
      if (f.expiry) {
        const want = f.expiry;
        list = list.filter((i) => {
          const st = expiryStateOf(i);
          if (want === 'expired') return st === 'expired';
          if (want === 'soon') return st === 'soon';
          if (want === 'has') return !!i.expiry_date;
          if (want === 'none') return !i.expiry_date;
          return true;
        });
      }

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

      // 到这一步才装饰，而且只装饰筛出来的这些
      return list.map((it) => decorateItem(it, lk));
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
      // 「压根没提条码」和「明确把条码清空」是两回事：
      // 前者不该动原值，后者要真的清掉。靠 codes 分不出来（两种都是空数组），
      // 所以看入参里到底有没有这两个键。
      const hasBarcodeInput = p.barcodes !== undefined || p.barcode !== undefined;
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

      /**
       * ⚠️ 这里的每个字段都必须是「传了才改，没传保持原样」。
       *
       * 以前不是这样：name/code/kind/icon 是「没传就不动」，而 category_id、
       * location_id 会变成 null，quantity 会变成 1，unit 会变成「件」，tags 会清空，
       * 日期和备注会清空，price 会变成 0 —— 两套语义混在同一个对象里。
       *
       * 界面提交表单时总是把每个字段都算好传过来，所以一直没出事。但只要有人写一个
       * 「只改名字」的入口（批量改分类、扫到条码先建一条再回填名称），物品的位置和
       * 分类就会被**静默清空**，而界面照样提示「已保存」。默认值统一挪到新建分支去补。
       */
      const base = {
        name: p.name != null ? String(p.name).trim() : undefined,
        barcode: hasBarcodeInput ? codes[0] || '' : undefined,
        barcodes: hasBarcodeInput ? codes : undefined,
        code: code,
        kind: p.kind != null ? normalizeKind(p.kind) : undefined,
        icon: p.icon != null ? String(p.icon) : undefined,
        category_id: p.category_id !== undefined ? p.category_id || null : undefined,
        location_id: p.location_id !== undefined ? p.location_id || null : undefined,
        quantity: p.quantity != null && p.quantity !== '' ? Number(p.quantity) || 0 : undefined,
        unit: p.unit != null && p.unit !== '' ? String(p.unit) : undefined,
        production_date: p.production_date != null ? p.production_date : undefined,
        expiry_date: p.expiry_date != null ? p.expiry_date : undefined,
        shelf_life_days:
          p.shelf_life_days != null && p.shelf_life_days !== '' ? Number(p.shelf_life_days) || 0 : undefined,
        price: p.price != null && p.price !== '' ? Number(p.price) || 0 : undefined,
        note: p.note != null ? p.note : undefined,
        tags: Array.isArray(p.tags) ? p.tags : undefined
      };

      if (p.id) {
        const it = db.items.find((x) => x.id === p.id);
        if (!it) throw new Error('物品不存在');
        Object.keys(base).forEach((k) => {
          if (base[k] !== undefined) it[k] = base[k];
        });
        // extra 是增量合并：界面只改了「作者」，不能把「出版社」一起冲掉。
        // 合并前先按类型过一遍白名单，拼错的字段名不该进来。
        if (p.extra && typeof p.extra === 'object') {
          it.extra = Object.assign({}, it.extra || {}, sanitizeExtra(it.kind, p.extra));
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
      // base 里那些「没传就不改」留下的 undefined，在新建时要补成合理的初始值 ——
      // 更新分支要的是「保持原样」，新建分支要的是「有个默认值」，两件事不能共用一套写法。
      const NEW_DEFAULTS = {
        barcode: '',
        barcodes: [],
        category_id: null,
        location_id: null,
        quantity: 1,
        unit: '件',
        production_date: '',
        expiry_date: '',
        shelf_life_days: 0,
        price: 0,
        note: '',
        tags: []
      };
      Object.keys(NEW_DEFAULTS).forEach((k) => {
        if (it[k] === undefined) it[k] = NEW_DEFAULTS[k];
      });
      it.name = base.name || '未命名物品';
      it.kind = normalizeKind(base.kind);
      it.icon = base.icon || '';
      it.code = base.code || '';
      it.extra = sanitizeExtra(it.kind, p.extra);
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
      // 只留最近 50 条。常用的东西（比如每天消耗的食品）一年能攒 365 条，
      // 而 logs 会跟着物品一起同步到所有设备、也不会被墓碑瘦身 —— 白白占带宽和体积。
      // 用户真正关心的是「最近几次是什么时候消耗的」。
      const LOG_LIMIT = 50;
      if (it.logs.length > LOG_LIMIT) it.logs = it.logs.slice(-LOG_LIMIT);
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
      const lk = buildLookup();
      return live(db.items)
        .map((it) => decorateItem(it, lk))
        .filter((i) => i.days_left !== null && i.days_left <= days)
        .sort((a, b) => a.days_left - b.days_left);
    },

    'items.stats': () => {
      const lk = buildLookup();
      const items = live(db.items).map((it) => decorateItem(it, lk));
      const byCat = {};
      const byLoc = {};
      // 按类型拆分：办公资料 / 书籍 是独立页面，统计里也要能单独看到体量
      const kinds = { goods: 0, doc: 0, book: 0 };

      // 近 6 个月的入库趋势。先把这 6 个月算出来建个索引，再一趟遍历分桶 ——
      // 原来是每个月都 live(db.items).filter(...) 扫一遍全表，6 个月就是 6 次全表扫描。
      const trend = [];
      const base = new Date();
      const monthIndex = new Map();
      for (let m = 5; m >= 0; m--) {
        const d = new Date(base.getFullYear(), base.getMonth() - m, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        monthIndex.set(key, trend.length);
        trend.push({ name: key.slice(5) + '月', value: 0 });
      }

      let totalValue = 0;
      let totalQty = 0;
      items.forEach((i) => {
        const cat = i.category_name || '未分类';
        byCat[cat] = (byCat[cat] || 0) + 1;
        const loc = i.location_path || '未指定位置';
        byLoc[loc] = (byLoc[loc] || 0) + 1;
        const kd = i.kind || 'goods';
        kinds[kd] = (kinds[kd] || 0) + 1;
        totalValue += (Number(i.price) || 0) * (Number(i.quantity) || 1);
        totalQty += Number(i.quantity) || 0;
        const mi = monthIndex.get(String(i.created_at || '').slice(0, 7));
        if (mi !== undefined) trend[mi].value++;
      });

      const top = (obj, n) =>
        Object.entries(obj)
          .map(([name, value]) => ({ name, value }))
          .sort((a, b) => b.value - a.value)
          .slice(0, n);

      return {
        total: items.length,
        totalQty,
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
          // 反向索引（这张图属于哪个物品）。业务逻辑一律用 items.image_id 正查，
          // 这一份只用于排查数据问题（比如物品没了、图还挂在目录里）。
          // 它随同步来回走，test-server 有一条断言盯着「拉回来时没丢」。
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

  /**
   * 某个位置以及它所有下级位置的 id 集合（筛「厨房下的所有东西」时用）。
   *
   * 先建一次「父 → 子」映射再逐层展开。原来是 while(changed) 每轮都扫一遍全部位置，
   * 最坏是平方级 —— 位置树又深又宽时会明显变慢。
   */
  function subtreeIds(rootId) {
    const childrenOf = new Map();
    live(db.locations).forEach((l) => {
      if (!l.parent_id) return;
      if (!childrenOf.has(l.parent_id)) childrenOf.set(l.parent_id, []);
      childrenOf.get(l.parent_id).push(l.id);
    });
    const set = new Set([rootId]);
    const queue = [rootId];
    while (queue.length) {
      const cur = queue.pop();
      (childrenOf.get(cur) || []).forEach((id) => {
        if (set.has(id)) return;
        set.add(id);
        queue.push(id);
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

    /**
     * 瘦一遍库里还留着的「完整版」老墓碑。
     *
     * 删除时已经瘦过了，这里只针对**外来**的墓碑 —— 从服务端拉回来的可能是
     * 老版本客户端推的完整记录。所以调用点是「同步合并之后」，而不是每次落盘：
     * 每次落盘都全表遍历一遍，数据一大就是白花的开销。
     */
    compactTombstones: () => compactTombstones(db),
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
      if (changed) {
        // 从服务端拉回来的墓碑可能是完整版（老版本客户端推的），顺手瘦一遍。
        // 放在这里而不是每次落盘 —— 只有外来数据会带进完整版墓碑，
        // 每次落盘都全表遍历一遍是白花的开销（见 compactTombstones 的说明）。
        compactTombstones(db);
        saveNow();
      }
      // failed 交回同步层：从 NAS 拉下来的图片存不上，用户也必须知道，
      // 不能只报「同步完成」然后留下一堆点开是空白的图。
      return { changed, failed };
    }
  };
}

// KIND_EXTRA_KEYS 一起导出，只为了让测试能断言「数据层白名单」与
// 「渲染层表单字段」没有漂移 —— 渲染层加了字段却忘了同步白名单，
// 那个字段会永远存不进去，而且不报错。
module.exports = { createStore, KIND_EXTRA_KEYS };
