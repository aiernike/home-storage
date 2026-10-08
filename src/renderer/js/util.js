'use strict';

const U = {
  esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  addDays(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return '';
    d.setDate(d.getDate() + Number(days || 0));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  /**
   * 加/减若干个月。
   *
   * 为什么不能直接用 `setMonth(getMonth() + n)`：1 月 31 日加一个月，
   * 目标月没有 31 号，JS 会自己滚到 3 月 3 日 —— 那是「加 31 天」，不是「加一个月」。
   * 正确做法是先落到月初、再挪月份、最后把日号夹回该月最后一天。
   */
  addMonths(dateStr, months) {
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return '';
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + (Number(months) || 0));
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  /**
   * 日期速记：把「+1m / 30天 / 0517 / 20260517 / x」这类输入解析成 `YYYY-MM-DD`。
   *
   * 为什么要有这个：保质期、保管期限这些字段，用户脑子里想的是「一年后」「明年 5 月」，
   * 不是「2027-05-17」。原生日期选择器只认完整日期，逼着人先去翻日历 ——
   * 填保质期本来就烦，再翻一遍日历就更不想填了。
   *
   * 返回值的两种「没有日期」必须分开：
   *   `{ok:false, reason}` = 看不懂（要拦住用户，不能当空值静默吞掉）
   *   `{ok:true, date:''}` = 用户明确说了「没有期限」（x / 空）
   *
   * @param {string} input 用户输入
   * @param {string} [todayStr] 今天（YYYY-MM-DD）；不传取系统日期。测试靠它注入。
   * @returns {{ok:true, date:string} | {ok:false, reason:string}}
   */
  parseDateShorthand(input, todayStr) {
    const raw = String(input == null ? '' : input).trim();
    if (!raw) return { ok: true, date: '' };

    const today = U.fmtDate(todayStr || U.today());
    const p = (n) => String(n).padStart(2, '0');
    const base = new Date(today + 'T00:00:00');
    if (isNaN(base.getTime())) return { ok: false, reason: '读不出今天是哪天' };

    // 「没有期限」：x 是 Grocy 的约定（永不过期），这里映射成空日期 ——
    // 本软件的「到期日期」空着就是「不提醒过期」，不需要 2999-12-31 那种哨兵值
    // （哨兵值会让保质期页显示「还有 355000 天」）。
    if (/^[xX×]$/.test(raw) || ['无', '没有', '清空', '-', '--'].indexOf(raw) >= 0) {
      return { ok: true, date: '' };
    }

    // 相对今天：+1m / -3d / 30天 / 3个月 / 2周 / 1年（不带符号默认往后）
    const rel = raw.match(/^([+-]?)\s*(\d+)\s*(d|天|w|周|m|月|个月|y|年)$/i);
    if (rel) {
      const n = (rel[1] === '-' ? -1 : 1) * (Number(rel[2]) || 0);
      const unit = rel[3].toLowerCase();
      if (unit === 'd' || unit === '天') return { ok: true, date: U.addDays(today, n) };
      if (unit === 'w' || unit === '周') return { ok: true, date: U.addDays(today, n * 7) };
      if (unit === 'y' || unit === '年') return { ok: true, date: U.addMonths(today, n * 12) };
      return { ok: true, date: U.addMonths(today, n) };
    }

    const WORDS = { 今天: 0, 明天: 1, 后天: 2, 大后天: 3, 昨天: -1, 前天: -2 };
    if (WORDS[raw] !== undefined) return { ok: true, date: U.addDays(today, WORDS[raw]) };

    // 完整日期：2026-05-17 / 2026/5/17 / 2026.5.17 / 2026年5月17日 / 20260517
    let m = raw.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
    if (!m) m = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) {
      const y = +m[1], mo = +m[2], da = +m[3];
      // 用 Date 回读一遍校验：能挡住 2026-02-30、2026-13-01 这种「格式对、日子不存在」
      const built = new Date(y, mo - 1, da);
      if (built.getFullYear() !== y || built.getMonth() !== mo - 1 || built.getDate() !== da) {
        return { ok: false, reason: `没有 ${y} 年 ${mo} 月 ${da} 日这一天` };
      }
      return { ok: true, date: `${y}-${p(mo)}-${p(da)}` };
    }

    // 只有月日：0517 / 5-17 / 5/17 / 5月17日
    m = raw.match(/^(\d{1,2})[-/.月](\d{1,2})日?$/) || raw.match(/^(\d{2})(\d{2})$/);
    if (m) {
      const mo = +m[1], da = +m[2];
      const inYear = (yy) => {
        const built = new Date(yy, mo - 1, da);
        if (built.getFullYear() !== yy || built.getMonth() !== mo - 1 || built.getDate() !== da) return '';
        return `${yy}-${p(mo)}-${p(da)}`;
      };
      const thisYear = base.getFullYear();
      const first = inYear(thisYear);
      if (!first) return { ok: false, reason: `没有 ${mo} 月 ${da} 日这一天` };
      // 已经过去的月日当成明年 —— 写「0517」的人想的是「下次 5 月 17」，
      // 而不是「今年 5 月 17（早就过期了）」。（2 月 29 日在平年没有，那年就报错）
      if (first < today) {
        const next = inYear(thisYear + 1);
        return next ? { ok: true, date: next } : { ok: false, reason: `没有 ${mo} 月 ${da} 日这一天` };
      }
      return { ok: true, date: first };
    }

    return { ok: false, reason: '看不懂这个日期' };
  },

  /**
   * 读一个可能还是速记状态的日期输入框。
   * 只用在「反正后面还要整体校验」的地方（比如保质期自动算到期日的联动预览）：
   * 看不懂就当作空，不要在这里弹错 —— 报错交给表单提交那一步统一做。
   */
  dateValue(input, todayStr) {
    const r = U.parseDateShorthand(input, todayStr);
    return r.ok ? r.date : '';
  },

  /**
   * 一串字符像不像条码/二维码内容。
   *
   * 用途是「扫码枪前缀」的收尾校验：前缀 + 回车中间那一段，只有长得像条码才认。
   * 不校验的话，用户打了「$」又打了个回车（其实是想提交表单），
   * 也会被当成扫了一条空码；「$你`好」这种中文更不该当条码。
   */
  isScannerCode(code) {
    const s = String(code == null ? '' : code).trim();
    // 最短的常见条码是 UPC-E（6 位），但留点余量给短的自定义码；
    // 上限 128 是二维码的字符容量量级，再长必然是误触
    if (s.length < 4 || s.length > 128) return false;
    // 只认条码/二维码里可能出现的字符。空格、中文、控制符一律不算 ——
    // 人手误触几乎一定会带上它们，而真条码不会。
    return /^[0-9A-Za-z\-_.:\/+=%#@]+$/.test(s);
  },

  /**
   * 扫码枪识别器。
   *
   * 扫码枪在系统眼里就是一个 USB 键盘：它「打字」的速度极快（每个字符间隔通常
   * 不到 10 毫秒），打完还会补一个回车。如果不管它，焦点在哪它就把条码灌进哪个
   * 输入框 —— 正在填「物品名称」，扫一下名字就变成一串数字。
   *
   * 办法是让扫码枪在设置里配一个**前缀字符**（Grocy 用 `$`），本识别器只认
   * 「前缀开头 → 极快连续输入 → 回车/Tab 结尾」这一整串，别的键一概不碰。
   *
   * 为什么不用定时器判断「这一串是不是结束了」：
   *   - 定时器会让这个逻辑没法测（得等真实时间流逝，或者去打桩 setTimeout）；
   *   - 而且「超时就结束」本身是错的 —— 真正要判的是「这些字符是不是**一次连续**
   *     输入的」。所以这里改成看**相邻两次按键的时间差**：扫码枪几乎无间隔，
   *     人手打字至少一百多毫秒。时间由调用方传进来（`feed(key, now)`），
   *     测试里想传多少传多少。
   *
   * @param {{prefix: string, gapMs?: number}} opts
   *   prefix 前缀（空字符串 = 关闭，feed 永远不命中）
   *   gapMs  相邻按键超过这个毫秒数就认为「不是同一次连续输入」，默认 80
   * @returns {{feed: (key: string, now: number) => {hit: boolean, armed: boolean, code: string}, reset: () => void}}
   *   hit    —— 认出了一整条扫码，`code` 是去掉前缀后的内容
   *   armed  —— 当前这次按键属于「正在收集的扫码序列」，调用方应当 preventDefault，
   *             别让字符漏进输入框
   */
  createScannerWatcher(opts) {
    const prefix = String((opts && opts.prefix) || '');
    const gapMs = (opts && opts.gapMs) || 80;
    // 前缀之后还能收多长。超过这个长度必然是误触（真条码不会这么长），
    // 与其一直攒着占内存、还不如直接放弃这次收集。
    const MAX_BODY = 128;

    let buf = '';
    let lastAt = 0;
    // 「buf 已经完整等于 prefix」。单字符前缀时第一次按键就为真。
    let gotPrefix = false;

    const reset = () => {
      buf = '';
      lastAt = 0;
      gotPrefix = false;
    };

    const miss = () => ({ hit: false, armed: false, code: '' });

    const feed = (key, now) => {
      if (typeof key !== 'string' || !key) return miss();
      const t = Number(now) || 0;

      // 距离上一次按键隔了太久 → 上一次那串不是扫码枪，清掉残留。
      // 这一步必须放在处理回车之前：用户按了「$」又过了半秒才按回车，
      // 那是两个独立动作，不能拼成一次扫码。
      if (buf && lastAt && t - lastAt > gapMs) reset();

      // 回车 / Tab 都是常见的扫码枪后缀
      if (key === 'Enter' || key === 'Tab') {
        const body = gotPrefix ? buf.slice(prefix.length) : '';
        const ok = gotPrefix && U.isScannerCode(body);
        reset();
        // 没命中时 armed 为 false：用户可能只是想提交表单，别把他的回车吞了
        return ok ? { hit: true, armed: true, code: body } : miss();
      }

      // Shift / F1 / 方向键这类没有单个字符的键：既不参与收集，也不打断收集
      // （扫码枪打大写字母时会带上 Shift，打断就永远收不全了）
      if (key.length !== 1) return { hit: false, armed: buf !== '', code: '' };

      if (!buf) {
        // 只有跟前缀的第一个字符一样，才有可能开始一次扫码
        if (key !== prefix[0]) return miss();
        buf = key;
        lastAt = t;
        gotPrefix = prefix.length === 1;
        return { hit: false, armed: true, code: '' };
      }

      buf += key;
      lastAt = t;
      if (!gotPrefix) {
        if (buf.length > prefix.length || prefix.indexOf(buf) !== 0) {
          // 前缀对不上了（比如配的是 `$$`，用户打了 `$a`），这次收集作废
          reset();
          return miss();
        }
        gotPrefix = buf === prefix;
      }
      if (buf.length > prefix.length + MAX_BODY) {
        reset();
        return miss();
      }
      return { hit: false, armed: true, code: '' };
    };

    return { feed, reset };
  },

  fmtDate(s) {
    if (!s) return '';
    return String(s).slice(0, 10);
  },

  fmtTime(s) {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },

  daysLeftText(days) {
    if (days === null || days === undefined) return '';
    if (days < 0) return `已过期 ${Math.abs(days)} 天`;
    if (days === 0) return '今天到期';
    if (days === 1) return '明天到期';
    return `还有 ${days} 天`;
  },

  expiryTag(item) {
    if (!item.expiry_date) return '';
    const map = {
      expired: 'tag-expired',
      soon: 'tag-soon',
      ok: 'tag-ok'
    };
    const cls = map[item.expiry_state] || 'tag-plain';
    const icon = item.expiry_state === 'expired' ? '⚠' : item.expiry_state === 'soon' ? '◷' : '✓';
    return `<span class="tag ${cls}">${icon} ${U.esc(U.daysLeftText(item.days_left))}</span>`;
  },

  // 保质期推导：已知生产日期 + 保质期天数 → 到期日
  calcExpiry(productionDate, shelfLifeDays) {
    if (!productionDate || !shelfLifeDays) return '';
    return U.addDays(productionDate, shelfLifeDays);
  },

  /**
   * 物品类型。三类共用一张表，界面上靠 kind 决定「叫什么、显示哪些字段」。
   * label 用「物品 / 资料 / 图书」这种用户看得懂的说法，不出现 goods/doc 这种内部词。
   */
  KINDS: {
    goods: { label: '物品', one: '件', page: 'items', nameLabel: '物品名称', namePh: '例如：酱油 / 布洛芬 / 5 号电池' },
    doc: { label: '资料', one: '份', page: 'docs', nameLabel: '文件名称', namePh: '例如：房屋租赁合同 / 2026年3月记账凭证' },
    book: { label: '图书', one: '本', page: 'books', nameLabel: '书名', namePh: '例如：深入理解计算机系统' }
  },

  kindLabel(kind) {
    const k = U.KINDS[kind];
    return k ? k.label : '物品';
  },

  /**
   * 分类 key → 归属栏目。
   * 办公资料页只列办公/会计类分类，书籍页只列书籍类分类，
   * 这样新建资料时不会在下拉里看到「宠物用品」。
   * 不在表里的（用户自建分类）一律归到普通物品。
   */
  CAT_KIND: {
    合同: 'doc', 公文: 'doc', 人事: 'doc', 证照: 'doc', 培训: 'doc',
    记账: 'doc', 账簿: 'doc', 发票: 'doc', 报税: 'doc', 银行: 'doc', 报销: 'doc',
    图书: 'book', 教材: 'book', 期刊: 'book'
  },

  catKindOf(catKey) {
    return U.CAT_KIND[String(catKey || '')] || 'goods';
  },

  /** 该栏目该显示哪些分类 */
  catsForKind(cats, kind) {
    const list = cats || [];
    if (kind === 'goods') return list.filter((c) => U.catKindOf(c.key) === 'goods');
    return list.filter((c) => U.catKindOf(c.key) === kind);
  },

  fmtMoney(n) {
    const v = Number(n) || 0;
    return v % 1 === 0 ? String(v) : v.toFixed(2);
  },

  debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  },

  /**
   * 内部编码：HS-2026-0001 这种「没有条码的东西」自动生成的编号。
   * 它承载的是我们自己发的号，所以绝不能当成普通条码去校验（会报「长度不符合」），
   * 扫码时也要优先按内部编码去库里找对应的东西。
   */
  isInternalCode(code) {
    return /^[A-Z]{2,6}-\d{4}-\d{3,6}$/i.test(String(code || '').trim());
  },

  /** ISBN：978 / 979 开头的 13 位，扫书背条码时按图书录入 */
  isIsbn(code) {
    return /^97[89]\d{10}$/.test(String(code || '').trim());
  },

  /**
   * 期刊条码：977 开头（ISSN 的 EAN-13 形式），扫杂志封面上的条码走这条。
   * 杂志没有 ISBN，只有 ISSN，但同样是「一本一册」的东西，归到图书栏目最顺手。
   */
  isIssnCode(code) {
    return /^977\d{10}$/.test(String(code || '').trim());
  },

  /** 扫到 ISBN 或期刊条码，都按图书/期刊录入 */
  isBookCode(code) {
    return U.isIsbn(code) || U.isIssnCode(code);
  },

  // 常见条码规则校验与提示
  barcodeType(code) {
    const c = String(code || '').trim();
    if (U.isInternalCode(c)) return '内部编码';
    if (!/^\d+$/.test(c)) return '非数字条码';
    const len = c.length;
    if (len === 13) return U.isIsbn(c) ? 'ISBN' : U.isIssnCode(c) ? 'ISSN' : 'EAN-13';
    if (len === 12) return 'UPC-A';
    if (len === 8) return 'EAN-8';
    if (len === 14) return 'ITF-14 / GTIN';
    if (len === 20) return 'GS1-128';
    return `${len} 位数字`;
  },

  validateEan(code) {
    const c = String(code || '').trim();
    // 内部编码是我们自己发的号，没有校验位这回事，别拿条码规则去挑刺
    if (U.isInternalCode(c)) return { valid: null, reason: '内部编码，无需校验位' };
    // ISBN / ISSN 的校验位算法和 EAN-13 完全一样，只是提示词要说对名字
    const isbn = U.isIsbn(c);
    const issn = U.isIssnCode(c);
    const who = isbn ? 'ISBN' : issn ? 'ISSN' : '';
    if (!who && !/^\d{8}$|^\d{12,14}$/.test(c)) return { valid: null, reason: '长度不符合标准条码规则' };
    const digits = c.split('').map(Number);
    const check = digits.pop();
    let sum = 0;
    digits.reverse().forEach((d, i) => {
      sum += d * (i % 2 === 0 ? 3 : 1);
    });
    const expect = (10 - (sum % 10)) % 10;
    return expect === check
      ? { valid: true, reason: who ? `${who} 校验位正确` : '校验位正确' }
      : { valid: false, reason: who ? `${who} 校验位应为 ${expect}，当前为 ${check}` : `校验位应为 ${expect}，当前为 ${check}` };
  }
};

/**
 * 条码扫描器 —— 用纯 JS 的 ZXing 做识别，不再依赖浏览器的 BarcodeDetector。
 *
 * 为什么换掉 BarcodeDetector：它是实验性接口，很多环境里要么根本没有
 * （Windows 版 Chromium、安卓 WebView），要么有但识别不出来（没有谷歌服务的手机）。
 * 表现就是「摄像头能打开，但对着条码半天没反应」——因为失败被静默吞掉了。
 *
 * 这里同时做两件事：
 *  1. 识别不依赖任何系统组件，纯 JS 解码，各平台行为一致
 *  2. 任何环节的失败都要报出来，绝不再出现「一直转圈但什么都不说」
 */
class BarcodeScanner {
  constructor(videoEl, onDetect, onError) {
    this.video = videoEl;
    this.onDetect = onDetect;
    this.onError = onError || null;
    this.stream = null;
    this.running = false;
    this.reader = null;
    this.lastCode = '';
    this.lastAt = 0;
    this.failures = 0;
    this.reported = false;
  }

  /** 识别组件是否可用（ZXing 已加载） */
  static get decoderReady() {
    return typeof window !== 'undefined' && !!window.ZXing && !!window.ZXing.BrowserMultiFormatReader;
  }

  /** 是否有可用的摄像头接口 */
  static get hasCamera() {
    return typeof navigator !== 'undefined'
      && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  static get supported() {
    return BarcodeScanner.decoderReady && BarcodeScanner.hasCamera;
  }

  /** ZXing 判定「这一帧里没有条码」时抛的就是这个，属于正常情况，不算错误 */
  static _isNotFound(e) {
    const ZXing = window.ZXing || {};
    if (ZXing.NotFoundException && e instanceof ZXing.NotFoundException) return true;
    return /NotFound/i.test(String((e && e.name) || (e && e.message) || e));
  }

  /**
   * 构造一个带格式提示的解码器。
   *
   * tryHarder 会多试几种二值化和角度，认得更全但慢好几倍。
   * 实时扫码要的是流畅（几百毫秒内出结果），开它反而卡顿；
   * 识别静态图片不在乎那几百毫秒，开它能提高成功率。
   */
  static _reader(tryHarder) {
    const ZXing = window.ZXing;
    const hints = new Map();
    const F = ZXing.BarcodeFormat || {};
    const want = [
      F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E,
      F.CODE_128, F.CODE_39, F.CODE_93,
      F.ITF, F.CODABAR, F.QR_CODE
    ].filter(Boolean);
    if (want.length) hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, want);
    if (tryHarder) hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    return new ZXing.BrowserMultiFormatReader(hints, tryHarder ? 0 : 200);
  }

  /** 当前摄像头是否支持手电筒（暗光下扫条码很依赖它） */
  get torchSupported() {
    try {
      if (!this.track || typeof this.track.getCapabilities !== 'function') return false;
      const caps = this.track.getCapabilities();
      return !!caps && caps.torch === true;
    } catch (e) {
      return false;
    }
  }

  /** 开关手电筒。成功返回 true，设备不支持返回 false */
  async setTorch(on) {
    try {
      if (!this.track || !this.torchSupported) return false;
      await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
      return true;
    } catch (e) {
      return false;
    }
  }

  async start() {
    if (this.running) return { ok: true };

    if (!BarcodeScanner.decoderReady) {
      return { ok: false, reason: '识别组件没能加载（js/zxing.min.js 缺失），请手动输入条码' };
    }
    if (!BarcodeScanner.hasCamera) {
      return { ok: false, reason: '这个环境没有可用的摄像头，请用扫码枪或手动输入' };
    }

    try {
      // 分辨率给高一些：条码/二维码在画面里占的像素越多越好认，
      // 尤其小条码在 720p 下经常差一点点认不出来。加上连续对焦，
      // 避免手机把焦点锁在远处、近处的条码一直糊着。
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          advanced: [{ focusMode: 'continuous' }]
        }
      });
    } catch (e) {
      return {
        ok: false,
        reason: '打不开摄像头：' + (e && e.name ? e.name + ' ' : '') +
          (e && e.message ? e.message : e) +
          '。请检查是否已授予相机权限，或改用手动输入'
      };
    }

    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', 'true');
    this.video.muted = true;

    // 以前这里是 .catch(() => {})，播放失败会被吞掉，
    // 结果画面不动、识别永远不触发，界面却一直显示「识别中」。
    try {
      await this.video.play();
    } catch (e) {
      return { ok: false, reason: '摄像头画面无法播放：' + (e && e.message ? e.message : e) };
    }

    // 等到真的有画面再开始识别，否则解码器拿到的是空帧
    try {
      await this._waitForFrame();
    } catch (e) {
      return { ok: false, reason: '摄像头一直没有画面，请重试或改用手动输入' };
    }

    this.running = true;
    this.failures = 0;
    this.reported = false;
    this._frame = 0;
    this.reader = BarcodeScanner._reader(false); // 实时识别：要流畅，不开 tryHarder
    // 另配一个开了 tryHarder 的解码器，每隔几帧用一次：
    // 认得更全（多试几种二值化/角度），又不至于每帧都慢。
    this.readerDeep = BarcodeScanner._reader(true);
    // 摄像头视频轨：手电筒（torch）和后续对焦都靠它
    try {
      this.track = this.stream.getVideoTracks ? this.stream.getVideoTracks()[0] : null;
    } catch (e) {
      this.track = null;
    }

    // 用自己的循环调 decodeFromVideoElement（单次），不再用 ZXing 的
    // decodeFromVideoElementContinuously —— 它是实验接口，在安卓 WebView
    // 里回调可能根本不会触发，界面就一直沉默。
    this._loop();

    return { ok: true };
  }

  /**
   * 实时识别主循环
   *
   * 每一帧：
   *  1. 检查视频是否真的有画面（readyState 和尺寸都正常）
   *  2. 让解码器认一帧
   *  3. 认到 → 触发回调；认不到（NotFoundException）→ 正常，继续
   *  4. 真的报错 → 计数，连续 N 次才报一次，避免刷屏
   *  5. rAF 控制节奏，间隔至少 SCAN_INTERVAL 毫秒，别把 CPU 跑满
   */
  _loop() {
    const SCAN_INTERVAL = 200;
    let lastScanAt = 0;
    const tick = async () => {
      if (!this.running) return;

      const now = Date.now();
      if (now - lastScanAt < SCAN_INTERVAL) {
        this.raf = requestAnimationFrame(tick);
        return;
      }
      lastScanAt = now;

      // 视频没有画面就别解码，否则是空转
      if (this.video.readyState < 2 || !this.video.videoWidth || !this.video.videoHeight) {
        this.raf = requestAnimationFrame(tick);
        return;
      }

      // 每隔 3 帧用一次「认真模式」（tryHarder），其余帧用快速模式：
      // 兼顾流畅与识别率，小条码/脏污条码更容易被认出来。
      const deep = this._frame++ % 3 === 0;
      const reader = deep ? this.readerDeep : this.reader;

      try {
        const result = await reader.decodeFromVideoElement(this.video);
        this.failures = 0;
        const val = result.getText();
        const fmt = result.getBarcodeFormat();
        // 同一条码 1.5 秒内不重复触发
        if (val && (val !== this.lastCode || now - this.lastAt > 1500)) {
          this.lastCode = val;
          this.lastAt = now;
          this.onDetect(val, fmt);
        }
      } catch (e) {
        if (BarcodeScanner._isNotFound(e)) {
          // 正常：这一帧里没有条码
        } else {
          this.failures++;
          if (this.failures >= 3 && !this.reported) {
            this.reported = true;
            const msg = '识别出错：' + ((e && e.message) || e);
            if (this.onError) this.onError(msg);
          }
        }
      }

      if (this.running) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** 等视频真正出画面，最多 8 秒 */
  _waitForFrame() {
    return new Promise((resolve, reject) => {
      if (this.video.readyState >= 2 && this.video.videoWidth > 0) return resolve();
      const t0 = Date.now();
      const check = () => {
        if (this.video.readyState >= 2 && this.video.videoWidth > 0) return resolve();
        if (Date.now() - t0 > 8000) return reject(new Error('等待画面超时'));
        requestAnimationFrame(check);
      };
      check();
    });
  }

  async stop() {
    this.running = false;
    [this.reader, this.readerDeep].forEach((rd) => {
      if (!rd) return;
      try {
        rd.reset();
      } catch (e) {}
    });
    this.reader = null;
    this.readerDeep = null;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.track = null;
    if (this.video) this.video.srcObject = null;
  }

  // 从图片文件识别
  static async fromImage(file) {
    if (!BarcodeScanner.decoderReady) {
      return { ok: false, reason: '识别组件未加载，请手动输入条码' };
    }

    // 先给图片拉个 URL，交给 ZXing 的浏览器端解码器。
    // 走 URL 而不是 createImageBitmap，是为了让 Electron 和安卓 WebView 走同一条路径。
    const url = URL.createObjectURL(file);
    const img = new Image();
    try {
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('图片读取失败'));
        img.src = url;
      });
      const reader = BarcodeScanner._reader(true); // 静态图片：不在乎慢，开 tryHarder 认得更全
      const result = await reader.decodeFromImageElement(img);
      return { ok: true, code: result.getText(), format: result.getBarcodeFormat() };
    } catch (e) {
      if (BarcodeScanner._isNotFound(e)) {
        return { ok: false, reason: '这张图里没找到条码，换张清楚点的试试，或直接手动输入' };
      }
      return { ok: false, reason: '图片识别失败：' + (e && e.message ? e.message : e) };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

window.U = U;
window.BarcodeScanner = BarcodeScanner;
