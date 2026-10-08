'use strict';
/**
 * ISBN 联网查询测试。
 *
 * 分两层：
 *   1. 纯函数 —— 把两个数据源的响应规范化。喂 JSON 看结果，不需要网络。
 *   2. 查询器 —— 用假 http 模块，验「命中 / 降级 / 断网 / 超时 / 404 / 畸形输入」
 *      这几条路径。断网是**必须**测的：这个功能的价值一半在于「没网时安静收场」。
 *
 * ⚠️ 样本 JSON 按两个源的官方响应结构手写（本机无外网，没能对着真实响应核过）。
 *    所以解析函数对字段的读取刻意做得宽容：数组既认 `["名"]` 也认 `[{name:"名"}]`，
 *    缺字段就是空值，绝不会因为接口改版而崩。
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const isbn = require(path.join(ROOT, 'src', 'main', 'isbn.js'));

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (e !== undefined ? '  → ' + e : '')); }
};

/* ---------------- 假 http：按 options.path 决定返回什么 ---------------- */
function fakeHttp(handler) {
  const seen = [];
  const mod = {
    request(options, cb) {
      seen.push(options);
      const listeners = {};
      const req = {
        on(ev, fn) {
          (listeners[ev] = listeners[ev] || []).push(fn);
          return req;
        },
        end() {
          const r = handler(options);
          setTimeout(() => {
            if (r === 'error') {
              (listeners.error || []).forEach((f) => f(new Error('网络请求失败')));
              return;
            }
            if (r === 'timeout') {
              (listeners.timeout || []).forEach((f) => f());
              return;
            }
            const res = {
              statusCode: r.status,
              on(ev, fn) {
                if (ev === 'data') fn(r.body);
                else if (ev === 'end') setTimeout(fn, 0);
                return res;
              }
            };
            cb(res);
          }, 0);
        },
        destroy() {}
      };
      return req;
    }
  };
  return { mod, seen };
}

const OL_HIT = JSON.stringify({
  'ISBN:9787111544937': {
    url: 'https://openlibrary.org/books/OL26849325M/xxx',
    key: '/books/OL26849325M',
    title: '深入理解计算机系统',
    subtitle: '原书第 3 版',
    authors: [{ url: '/authors/OL123A', name: 'Randal E. Bryant' }],
    number_of_pages: 737,
    publishers: [{ name: '机械工业出版社' }],
    publish_date: '2016',
    cover: { small: 'https://covers.openlibrary.org/b/id/1-S.jpg' }
  }
});

/**
 * 同一个响应里含**两条**记录。
 * 为什么要专门造这个样本：正常请求一个 bibkeys 只查一个 ISBN，响应里也就一条 ——
 * 于是「按 ISBN 取键」和「随便取第一个值」这两种实现**结果完全一样**，
 * 测试分不出来（第一版就是这么写的，变异验证时暴露成假绿）。
 * 把两条记录塞进同一个响应，才能逼出「取错了键」这件事。
 */
const OL_TWO = JSON.stringify({
  'ISBN:9787111544937': {
    title: '深入理解计算机系统',
    authors: [{ name: 'Randal E. Bryant' }],
    publishers: [{ name: '机械工业出版社' }],
    publish_date: '2016',
    number_of_pages: 737
  },
  'ISBN:9780132350884': {
    title: 'Clean Code',
    authors: [{ name: 'Robert C. Martin' }],
    publishers: [{ name: 'Prentice Hall' }],
    publish_date: '2008',
    number_of_pages: 464
  }
});

const GB_HIT = JSON.stringify({
  totalItems: 1,
  items: [
    {
      volumeInfo: {
        title: 'Clean Code',
        subtitle: 'A Handbook of Agile Software Craftsmanship',
        authors: ['Robert C. Martin'],
        publisher: 'Prentice Hall',
        publishedDate: '2008-08-01',
        pageCount: 464,
        industryIdentifiers: [{ type: 'ISBN_13', identifier: '9780132350884' }]
      }
    }
  ]
});

const GB_EMPTY = JSON.stringify({ totalItems: 0 });

(async () => {
  console.log('\n[1] 输入整理（normalizeIsbn）');
  ok('标准 13 位照收', isbn.normalizeIsbn('9787111544937') === '9787111544937');
  ok('带连字符的也认', isbn.normalizeIsbn('978-7-111-54493-7') === '9787111544937');
  ok('带空格的也认', isbn.normalizeIsbn(' 978 7111 544937 ') === '9787111544937');
  ok('ISBN-10 照收', isbn.normalizeIsbn('0132350882') === '0132350882');
  ok('ISBN-10 结尾的 x 归一成大写', isbn.normalizeIsbn('043942089x') === '043942089X',
    isbn.normalizeIsbn('043942089x'));
  ok('位数不对的返回空串（省一次白等的超时）',
    isbn.normalizeIsbn('12345') === '' && isbn.normalizeIsbn('') === '' &&
    isbn.normalizeIsbn(null) === '' && isbn.normalizeIsbn(undefined) === '');
  ok('只有数字才留下（字母混进来会被剔掉，位数就变了）',
    isbn.normalizeIsbn('978711154493A') === '', isbn.normalizeIsbn('978711154493A'));

  console.log('\n[2] 出版年提取（publishYear）');
  ok('光年份', isbn.publishYear('2016') === 2016);
  ok('年月', isbn.publishYear('2016-05') === 2016);
  ok('年月日', isbn.publishYear('2008-08-01') === 2008);
  ok('带前缀的 c2016', isbn.publishYear('c2016') === 2016);
  ok('方括号 [2016]', isbn.publishYear('[2016]') === 2016);
  ok('中文年月', isbn.publishYear('2016年5月') === 2016);
  ok('取不到就是 0（调用方不填这个字段）',
    isbn.publishYear('') === 0 && isbn.publishYear(null) === 0 && isbn.publishYear('不详') === 0);
  ok('明显不像年份的数字不要（避免把杂串里的数字当年份）',
    isbn.publishYear('0') === 0 && isbn.publishYear('999') === 0 && isbn.publishYear('12345') === 0);

  console.log('\n[3] 名单读取（names：两种数组形式都要认）');
  ok('对象数组（Open Library 的 jscmd=data 形式）',
    JSON.stringify(isbn.names([{ name: '甲' }, { name: '乙' }])) === '["甲","乙"]',
    JSON.stringify(isbn.names([{ name: '甲' }, { name: '乙' }])));
  ok('字符串数组（Google Books 的形式）',
    JSON.stringify(isbn.names(['甲', '乙'])) === '["甲","乙"]');
  ok('对象数组但没有 name（Open Library 的 isbn/xxx.json 只给 key）→ 空',
    JSON.stringify(isbn.names([{ key: '/authors/OL1A' }])) === '[]');
  ok('空值/非数组不会崩', JSON.stringify(isbn.names(null)) === '[]' &&
    JSON.stringify(isbn.names(undefined)) === '[]' && JSON.stringify(isbn.names('甲')) === '[]');
  ok('空白项会被剔掉', JSON.stringify(isbn.names(['甲', '', '  ', null])) === '["甲"]');

  console.log('\n[4] Open Library 响应解析');
  const ol = isbn.parseOpenLibrary(JSON.parse(OL_HIT), '9787111544937');
  ok('书名', ol && ol.title === '深入理解计算机系统', ol && ol.title);
  ok('副标题', ol && ol.subtitle === '原书第 3 版', ol && ol.subtitle);
  ok('作者', ol && ol.authors.join('、') === 'Randal E. Bryant', ol && ol.authors.join('、'));
  ok('出版社', ol && ol.publisher === '机械工业出版社', ol && ol.publisher);
  ok('出版年从 publish_date 里摘出来', ol && ol.publishYear === 2016, ol && ol.publishYear);
  ok('页数', ol && ol.pages === 737, ol && ol.pages);
  ok('**查不到时是空对象 {}** → 返回 null（这是「这本书网上没有」的正常表达）',
    isbn.parseOpenLibrary({}, '9787111544937') === null);
  // 错键必须配上**真实记录**才测得出来。原来写的是 `{ 'ISBN:123': {} }`，
  // 那个空对象会让「取错值」和「正确不匹配」都因为没书名而返回 null —— 两种实现
  // 分不开，等于白测（变异验证时发现的）。
  ok('键名对不上也是 null（不会拿别的 ISBN 的记录充数）',
    isbn.parseOpenLibrary({ 'ISBN:9780000000000': { title: '别的书' } }, '9787111544937') === null);
  ok('有记录但没有 title → null（没书名的记录填了也没用）',
    isbn.parseOpenLibrary({ 'ISBN:9787111544937': { authors: [{ name: '甲' }] } }, '9787111544937') === null);
  ok('响应是 null / 字符串 / 数组都不会崩',
    isbn.parseOpenLibrary(null, '9787111544937') === null &&
    isbn.parseOpenLibrary('oops', '9787111544937') === null &&
    isbn.parseOpenLibrary([], '9787111544937') === null);
  ok('缺 authors/publishers/pages 时给空值而不是 undefined',
    (() => {
      const r = isbn.parseOpenLibrary({ 'ISBN:9787111544937': { title: '只有书名' } }, '9787111544937');
      return r && r.authors.length === 0 && r.publisher === '' && r.pages === 0 && r.publishYear === 0;
    })(), '');

  console.log('\n[5] Google Books 响应解析');
  const gb = isbn.parseGoogleBooks(JSON.parse(GB_HIT), '9780132350884');
  ok('书名', gb && gb.title === 'Clean Code', gb && gb.title);
  ok('副标题', gb && gb.subtitle === 'A Handbook of Agile Software Craftsmanship', gb && gb.subtitle);
  ok('作者（字符串数组）', gb && gb.authors.join('、') === 'Robert C. Martin', gb && gb.authors.join('、'));
  ok('出版社', gb && gb.publisher === 'Prentice Hall', gb && gb.publisher);
  ok('出版年', gb && gb.publishYear === 2008, gb && gb.publishYear);
  ok('页数', gb && gb.pages === 464, gb && gb.pages);
  ok('**totalItems:0 且没有 items** → null（正常的「查不到」）',
    isbn.parseGoogleBooks(JSON.parse(GB_EMPTY), '9780132350884') === null);
  ok('items 是空数组 → null', isbn.parseGoogleBooks({ items: [] }, '9780132350884') === null);
  ok('items 有元素但没有 volumeInfo → null',
    isbn.parseGoogleBooks({ items: [{}] }, '9780132350884') === null);
  ok('响应畸形不会崩',
    isbn.parseGoogleBooks(null, '9780132350884') === null &&
    isbn.parseGoogleBooks({ items: 'x' }, '9780132350884') === null);

  console.log('\n[6] 请求地址');
  ok('Open Library 地址里带上 ISBN',
    isbn.openLibraryUrl('9787111544937').indexOf('bibkeys=ISBN:9787111544937') > 0,
    isbn.openLibraryUrl('9787111544937'));
  ok('Open Library 要求 json + jscmd=data（少了就返回别的格式）',
    /format=json/.test(isbn.openLibraryUrl('9787111544937')) &&
    /jscmd=data/.test(isbn.openLibraryUrl('9787111544937')));
  ok('Google Books 地址里带上 ISBN',
    isbn.googleBooksUrl('9780132350884').indexOf('q=isbn:9780132350884') > 0,
    isbn.googleBooksUrl('9780132350884'));

  console.log('\n[7] 查询器：命中 / 降级 / 断网 / 超时');

  // 场景 A：首选源就命中
  {
    const { mod, seen } = fakeHttp((o) => ({ status: 200, body: OL_HIT }));
    const l = isbn.createIsbnLookup({ http: mod, https: mod });
    const r = await l.lookup('9787111544937');
    ok('首选源命中时只发一次请求', seen.length === 1, String(seen.length));
    ok('命中返回 ok + source=openlibrary', r.ok === true && r.source === 'openlibrary', JSON.stringify(r.ok && r.source));
    ok('命中带回书名', r.ok && r.book.title === '深入理解计算机系统', r.ok && r.book.title);
    ok('请求发到了 openlibrary.org', seen[0] && seen[0].hostname === 'openlibrary.org', seen[0] && seen[0].hostname);
    ok('用的是 https 且路径完整', seen[0] && seen[0].protocol === 'https:' &&
      seen[0].path.indexOf('/api/books') === 0, seen[0] && seen[0].path);
    ok('带上了 User-Agent（Open Library 会对无 UA 的请求限流）',
      !!(seen[0] && seen[0].headers && seen[0].headers['User-Agent']), '');
    ok('带了超时（不能无限等下去）', seen[0] && seen[0].timeout > 0, seen[0] && seen[0].timeout);
  }

  // 场景 B：首选源没有这本书 → 降级到第二源
  {
    const { mod, seen } = fakeHttp((o) =>
      o.hostname === 'openlibrary.org' ? { status: 200, body: '{}' } : { status: 200, body: GB_HIT });
    const l = isbn.createIsbnLookup({ http: mod, https: mod });
    const r = await l.lookup('9780132350884');
    ok('首选源没有这本书时会去试第二源', seen.length === 2, String(seen.length));
    ok('降级结果标着 source=googlebooks', r.ok === true && r.source === 'googlebooks', JSON.stringify(r));
    ok('降级也把书名带回来了', r.ok && r.book.title === 'Clean Code', r.ok && r.book.title);
  }

  // 场景 C：两个源都没有这本书
  {
    const { mod } = fakeHttp((o) =>
      o.hostname === 'openlibrary.org' ? { status: 200, body: '{}' } : { status: 200, body: GB_EMPTY });
    const l = isbn.createIsbnLookup({ http: mod, https: mod });
    const r = await l.lookup('9780132350884');
    ok('两个源都查不到 → ok:false + reason=notfound',
      r.ok === false && r.reason === 'notfound', JSON.stringify(r));
  }

  // 场景 D：断网（两个源都连不上）
  {
    const { mod, seen } = fakeHttp(() => 'error');
    const l = isbn.createIsbnLookup({ http: mod, https: mod });
    const r = await l.lookup('9787111544937');
    ok('断网时安静返回 ok:false + reason=offline（不抛异常）',
      r.ok === false && r.reason === 'offline', JSON.stringify(r));
    // 这条是「别让用户白等」：连不上就别再去试第二个源了，
    // 否则断网时用户要等 6 秒 + 6 秒，而他本来只想手动填个书名
    ok('断网时不再去试第二个源（不白等第二个超时）', seen.length === 1, String(seen.length));
  }

  // 场景 E：超时
  {
    const { mod, seen } = fakeHttp(() => 'timeout');
    const l = isbn.createIsbnLookup({ http: mod, https: mod });
    const r = await l.lookup('9787111544937');
    ok('超时同样安静收场', r.ok === false && r.reason === 'offline', JSON.stringify(r));
    ok('超时也不再试第二个源', seen.length === 1, String(seen.length));
  }

  // 场景 F：4xx（连上了，只是没这本书）—— 不能报成断网，
  // 否则用户会去查网络，而真正的原因是「这本书网上就没有」。
  // 这种情况**要**继续试第二个源：Open Library 没有的书，Google Books 可能有。
  {
    const { mod, seen } = fakeHttp((o) =>
      o.hostname === 'openlibrary.org' ? { status: 404, body: 'not found' } : { status: 200, body: GB_EMPTY });
    const l = isbn.createIsbnLookup({ http: mod, https: mod });
    const r = await l.lookup('9780132350884');
    ok('4xx 算「没这本书」而不是「断网」', r.ok === false && r.reason === 'notfound', JSON.stringify(r));
    ok('4xx 时会继续试第二个源（换个源可能就有）', seen.length === 2, String(seen.length));
  }

  // 场景 G：5xx 是服务端故障 → 算连不上
  {
    const { mod } = fakeHttp(() => ({ status: 503, body: 'down' }));
    const l = isbn.createIsbnLookup({ http: mod, https: mod });
    const r = await l.lookup('9787111544937');
    ok('5xx 算连不上（服务端故障）', r.ok === false && r.reason === 'offline', JSON.stringify(r));
  }

  // 场景 H：返回的不是 JSON（接口被网关拦了之类）
  {
    const { mod } = fakeHttp(() => ({ status: 200, body: '<html>请先登录</html>' }));
    const l = isbn.createIsbnLookup({ http: mod, https: mod });
    const r = await l.lookup('9787111544937');
    ok('返回非 JSON 时不会崩，走降级后安静收场',
      r.ok === false && r.reason === 'notfound', JSON.stringify(r));
  }

  // 场景 I：根本不是 ISBN
  {
    const { mod, seen } = fakeHttp(() => ({ status: 200, body: OL_HIT }));
    const l = isbn.createIsbnLookup({ http: mod, https: mod });
    const r = await l.lookup('9771009633018');
    ok('期刊条码（977）不是 ISBN，直接返回 badisbn', r.ok === false && r.reason === 'badisbn', JSON.stringify(r));
    ok('不是 ISBN 时一次请求都不发（不白等超时）', seen.length === 0, String(seen.length));
  }

  // 场景 J：超时时间可以配
  {
    const { mod, seen } = fakeHttp(() => ({ status: 200, body: OL_HIT }));
    const l = isbn.createIsbnLookup({ http: mod, https: mod, timeout: 1234 });
    await l.lookup('9787111544937');
    ok('超时时间可以配（默认 6 秒）', seen[0].timeout === 1234, String(seen[0].timeout));
  }

  // 场景 K：并发查两本不同的书，各自必须拿到自己那本。
  // 响应里**故意同时含两条记录**：如果实现是「取响应里的第一个值」，两个请求会拿到
  // 同一本，下面的断言立刻红。这是「按 ISBN 取键」唯一的可观测替代量。
  {
    const { mod } = fakeHttp(() => ({ status: 200, body: OL_TWO }));
    const l = isbn.createIsbnLookup({ http: mod, https: mod });
    const both = await Promise.all([l.lookup('9787111544937'), l.lookup('9780132350884')]);
    ok('并发查询结果不会串',
      both[0].ok && both[0].book.title === '深入理解计算机系统' &&
      both[1].ok && both[1].book.title === 'Clean Code',
      JSON.stringify(both.map((x) => (x.ok ? x.book.title : x.reason))));
    // 注意这里断言的是**作者**而不是 book.isbn：book.isbn 是 parseOpenLibrary 的
    // 入参回填的，取错键它照样是请求的那个 ISBN，测不出东西（这条原来是假绿的）。
    ok('并发时各自拿到自己那本的作者（不是响应里第一条的作者）',
      both[0].ok && both[0].book.authors.join('、') === 'Randal E. Bryant' &&
      both[1].ok && both[1].book.authors.join('、') === 'Robert C. Martin',
      JSON.stringify(both.map((x) => (x.ok ? x.book.authors.join('、') : x.reason))));
  }

  console.log('\n========================================');
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log('========================================\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
