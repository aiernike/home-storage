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
