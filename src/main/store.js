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
