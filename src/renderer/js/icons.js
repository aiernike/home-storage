'use strict';
/**
 * 内置物品图标库
 *
 * 为什么要有它：不是每件东西都值得拍张照。药盒、钥匙、文件、书这些，
 * 拍照麻烦、存下来还占空间，但有一个能认出来的图标就足够了。
 * 所以内置一套线性 SVG 图标，新建物品时点一下就能选，不联网、不占地方。
 *
 * 设计约定：
 *   - 全部 24×24 视框，线性风格，描边用 currentColor（跟随主题色自动变色）
 *   - 只画几何图形，不写死颜色，深浅色主题都不用改
 *   - 图标只是「一眼认出类别」，不追求画得像照片
 *
 * 用法：
 *   ITEM_ICONS.svg('book')            → 完整 <svg> 字符串
 *   ITEM_ICONS.svg('book', 20)        → 指定尺寸
 *   ITEM_ICONS.get('book')            → { key, name, group }
 *   ITEM_ICONS.all                    → 扁平列表
 *   ITEM_ICONS.groups                 → 按分组
 *   ITEM_ICONS.forItem(item)          → 这件物品该用哪个图标 key（手选 > 分类默认 > 类型兜底）
 *   ITEM_ICONS.itemSvg(item, 22)      → 直接可用的 <svg>
 */
(function () {
  // 每条：key、显示名、图标内容（<svg> 里除了外层标签的部分）
  var GROUPS = [
    {
      key: 'food',
      name: '食品饮料',
      icons: [
        ['rice', '米面粮油', '<path d="M4 11.5h16a8 8 0 0 1-16 0Z"/><circle cx="9.5" cy="7.6" r=".9"/><circle cx="13" cy="6.6" r=".9"/><circle cx="11.4" cy="9.1" r=".9"/>'],
        ['noodle', '面食', '<path d="M4 12h16a8 8 0 0 1-16 0Z"/><path d="M8 8.5c1-1.2 2-1.2 3 0s2 1.2 3 0 2-1.2 3 0"/><path d="M12 4v3"/>'],
        ['milk', '牛奶乳品', '<path d="M8 3h8v3l2 3v12H6V9l2-3Z"/><path d="M8 6h8M6 12h12"/>'],
        ['bottle', '瓶装', '<path d="M10 2h4v3l1.6 2.6V21a1 1 0 0 1-1 1h-5.2a1 1 0 0 1-1-1V7.6L10 5Z"/><path d="M9 11h6M9 15h6"/>'],
        ['can', '罐头', '<rect x="6" y="6.5" width="12" height="14.5" rx="2"/><path d="M6 10.5h12M9.5 3.5h5"/>'],
        ['snack', '零食', '<path d="M7 3h10l1.5 4v13a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V7Z"/><path d="M7 3v3.5h10V3"/><path d="M9 12h6M9 16h4"/>'],
        ['bread', '面包糕点', '<path d="M4 11.5c0-3.2 3.6-5.2 8-5.2s8 2 8 5.2V18a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z"/><path d="M8.2 7.6 6.6 12M12 6.6 10.4 12M15.8 7.6 14.2 12"/>'],
        ['fruit', '水果', '<path d="M12 7.5c-3.2 0-5.2 2.3-5.2 5.6S9.4 21 12 21s5.2-4.6 5.2-7.9S15.2 7.5 12 7.5Z"/><path d="M12 7.5V4.6M12 4.6c1.4 0 2.4-1 2.4-2.1"/>'],
        ['veg', '蔬菜', '<path d="M12 21V9.5"/><path d="M12 10c0-3.8 2.8-5.8 7.5-5.8C19.5 9 16.7 11 12 10Z"/><path d="M12 14c-3.8-.9-5.7-2.9-5.7-6.8 3.8 0 5.7 2 5.7 6.8Z"/>'],
        ['egg', '蛋类', '<ellipse cx="12" cy="13.6" rx="6" ry="7.4"/>'],
        ['meat', '肉类', '<rect x="4" y="9" width="16" height="6.4" rx="3.2" transform="rotate(-10 12 12)"/><path d="M7.4 9v6.4M16.6 9v6.4" transform="rotate(-10 12 12)"/>'],
        ['oil', '食用油', '<path d="M10 2h4v3l1.6 2.6V21a1 1 0 0 1-1 1h-5.2a1 1 0 0 1-1-1V7.6L10 5Z"/><path d="M12 12.5c1.3 1.5 1.9 2.6 1.9 3.5a1.9 1.9 0 1 1-3.8 0c0-.9.6-2 1.9-3.5Z"/>'],
        ['drink', '饮料', '<path d="M7 3h10l-1.2 18H8.2Z"/><path d="M7.5 9.5h9"/>'],
        ['tea', '茶咖啡', '<path d="M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5Z"/><path d="M17 9.5h1.4a2.5 2.5 0 0 1 0 5H17"/><path d="M7.5 3v2M11 3v2M14.5 3v2"/>'],
        ['frozen', '冷冻', '<path d="M12 3v18M4.6 7.6l14.8 8.8M19.4 7.6L4.6 16.4"/>']
      ]
    },
    {
      key: 'daily',
      name: '日用洗护',
      icons: [
        ['paper', '纸品', '<rect x="4" y="7" width="16" height="13" rx="1.5"/><path d="M4 11h16"/><circle cx="12" cy="15" r="1.9"/>'],
        ['soap', '洗护', '<path d="M12 6V3.6h3.4"/><rect x="9.6" y="6" width="4.8" height="2.6" rx="0.9"/><rect x="6" y="8.6" width="12" height="12.4" rx="2.3"/><path d="M9.4 13.6h5.2"/>'],
        ['cleaner', '清洁剂', '<path d="M8 9.5h8V21H8Z"/><path d="M9.6 9.5V5.6A1.6 1.6 0 0 1 11.2 4h1.6a1.6 1.6 0 0 1 1.6 1.6v3.9"/><path d="M16 6.5h3M19 3.6v5.6"/>'],
        ['laundry', '洗衣', '<rect x="5" y="3" width="14" height="18" rx="2"/><circle cx="12" cy="14" r="3.6"/><circle cx="9" cy="6.6" r=".9"/><circle cx="12" cy="6.6" r=".9"/>'],
        ['towel', '毛巾', '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 12h16M9 5v7"/>'],
        ['cosmetic', '化妆护肤', '<rect x="8" y="9.5" width="8" height="11.5" rx="1.2"/><path d="M10 9.5V6h4v3.5"/><path d="M12 3v3"/>'],
        ['trash', '垃圾袋', '<path d="M6 8h12l-1 13H7Z"/><path d="M9 8V5h6v3"/><path d="M9.5 12v6M14.5 12v6"/>']
      ]
    },
    {
      key: 'med',
      name: '药品健康',
      icons: [
        ['pill', '药片', '<circle cx="12" cy="12" r="8"/><path d="M12 4v16"/>'],
        ['capsule', '胶囊', '<rect x="9" y="3" width="6" height="18" rx="3"/><path d="M9 12h6"/>'],
        ['syrup', '药水', '<path d="M9 3h6v3l2 3v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9Z"/><path d="M7 14h10"/>'],
        ['bandage', '创可贴', '<rect x="3" y="9" width="18" height="7" rx="3.5"/><path d="M8 9v7M16 9v7"/><circle cx="12" cy="12.5" r=".9"/>'],
        ['thermometer', '体温计', '<path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0Z"/><path d="M12 17.6v-3.2"/>'],
        ['firstaid', '急救', '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M12 11v5M9.5 13.5h5"/>'],
        ['mask', '口罩', '<path d="M4 8c2.5-1.5 5-2 8-2s5.5.5 8 2v5c0 3.5-3.5 6-8 6s-8-2.5-8-6Z"/><path d="M4 9.6 2 8.4M20 9.6l2-1.2"/>']
      ]
    },
    {
      key: 'doc',
      name: '办公资料',
      icons: [
        ['file', '文件', '<path d="M13 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8Z"/><path d="M13 3v5h5"/><path d="M9 13h6M9 17h4"/>'],
        ['folder', '文件夹', '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>'],
        ['contract', '合同协议', '<path d="M6 3h9l4 4v14H6Z"/><path d="M15 3v4h4"/><path d="M9 15.5c1-2 2-2 3 0s2 1 3-1"/>'],
        ['invoice', '发票', '<path d="M6 3h12v18l-2-1.5-2 1.5-2-1.5L10 21l-2-1.5L6 21Z"/><path d="M9 8.5h6M9 12.5h6"/>'],
        ['receipt', '票据', '<rect x="6" y="4" width="12" height="16" rx="1"/><path d="M9 9h6M9 13h6M9 17h3"/>'],
        ['certificate', '证照', '<rect x="4" y="3" width="16" height="14" rx="2"/><path d="M8 7.5h8M8 11.5h5"/><path d="M9 17v4l3-1.6 3 1.6v-4"/>'],
        ['ledger', '账簿', '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M8.5 3v18"/><path d="M11.5 8h6M11.5 12h6M11.5 16h4"/>'],
        ['stamp', '印章', '<path d="M8 8a4 4 0 1 1 8 0v3H8Z"/><path d="M5 11h14v3H5Z"/><rect x="4" y="17" width="16" height="3" rx="1"/>'],
        ['calculator', '计算器', '<rect x="5" y="3" width="14" height="18" rx="2"/><rect x="8" y="6" width="8" height="3.2"/><path d="M9 13h.01M12 13h.01M15 13h.01M9 17h.01M12 17h.01M15 17h.01"/>'],
        ['archive', '档案盒', '<rect x="3" y="6" width="18" height="14" rx="1.5"/><path d="M3 10.5h18"/><path d="M9 14h6"/>'],
        ['bank', '银行单据', '<path d="M3 9.5 12 4l9 5.5Z"/><path d="M5.5 9.5V18M18.5 9.5V18M9.5 9.5V18M14.5 9.5V18"/><path d="M3 20.5h18"/>'],
        ['tax', '报税资料', '<path d="M6 3h9l4 4v14H6Z"/><path d="M15 3v4h4"/><path d="M9.5 12.5h5M9.5 16.5h5M10 10.5l4 7"/>'],
        ['chart', '报表', '<path d="M4 4v16h16"/><rect x="7" y="12" width="3" height="5"/><rect x="12" y="8" width="3" height="9"/><rect x="17" y="14" width="3" height="3"/>']
      ]
    },
    {
      key: 'book',
      name: '书籍阅读',
      icons: [
        ['book', '图书', '<path d="M4 4.6A1.6 1.6 0 0 1 5.6 3H11v18H5.6A1.6 1.6 0 0 1 4 19.4Z"/><path d="M11 3h7.4A1.6 1.6 0 0 1 20 4.6v14.8a1.6 1.6 0 0 1-1.6 1.6H11Z"/><path d="M11 3v18"/>'],
        ['bookopen', '阅读中', '<path d="M12 7C10 5.5 7 5 3.5 5.5v13C7 18 10 18.5 12 20Z"/><path d="M12 7c2-1.5 5-2 8.5-1.5v13C17 18 14 18.5 12 20Z"/>'],
        ['textbook', '教材', '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8.5 3v18"/><path d="M11.5 8h6M11.5 12h4"/>'],
        ['magazine', '杂志期刊', '<rect x="4" y="3" width="16" height="18" rx="2"/><rect x="7" y="6" width="10" height="6"/><path d="M7 15h10M7 18h6"/>'],
        ['notebook', '笔记本', '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 3v18"/><path d="M12 8h4M12 12h4"/>'],
        ['library', '书架', '<path d="M4 4h3v16H4Z"/><path d="M9 4h3v16H9Z"/><path d="M14.2 4.6 17.2 4l2.4 15.4-3 .6Z"/><path d="M3 21h18"/>']
      ]
    },
    {
      key: 'digital',
      name: '数码电子',
      icons: [
        ['phone', '手机', '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18.5h2"/>'],
        ['cable', '线材', '<path d="M6 3v6a3 3 0 0 0 3 3h6a3 3 0 0 1 3 3v6"/><rect x="3.5" y="2" width="5" height="3" rx="1"/><rect x="15.5" y="19" width="5" height="3" rx="1"/>'],
        ['battery', '电池', '<rect x="3" y="8" width="16" height="8" rx="2"/><path d="M21.5 11v2"/><rect x="6" y="11" width="4" height="2"/>'],
        ['charger', '充电器', '<rect x="6" y="3" width="12" height="10" rx="2"/><path d="M9 6.5h6"/><path d="M12 13v8"/>'],
        ['headphone', '耳机', '<path d="M5 14v-2a7 7 0 0 1 14 0v2"/><rect x="3" y="13" width="4" height="7" rx="2"/><rect x="17" y="13" width="4" height="7" rx="2"/>'],
        ['camera', '相机', '<rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="12" cy="13.5" r="3.5"/><path d="M9 7l1.5-2h3L15 7"/>'],
        ['usb', '存储卡', '<path d="M7 3h7l4 4v14H7Z"/><path d="M11 3v4M14 3v4"/><rect x="10" y="13" width="5" height="5" rx="1"/>'],
        ['laptop', '电脑', '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>'],
        ['plug', '插头插座', '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0Z"/><path d="M12 17v4"/>']
      ]
    },
    {
      key: 'tool',
      name: '五金工具',
      icons: [
        ['tool', '工具', '<path d="M15 3a5 5 0 0 0-4.6 7L4 16.4 7.6 20l6.4-6.4A5 5 0 0 0 20 9l-3-3-2 2-2-2 2-2Z"/>'],
        ['hammer', '锤子', '<path d="M13 4l7 7-3 3-7-7Z"/><path d="M10 7 3 14l3 3 7-7"/>'],
        ['tape', '胶带', '<ellipse cx="12" cy="12" rx="7.9" ry="6.7"/><ellipse cx="12" cy="12" rx="3.1" ry="2.4"/>'],
        ['scissors', '剪刀', '<circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="18" r="2.5"/><path d="M8.5 16 18 4M15.5 16 6 4"/>'],
        ['key', '钥匙', '<circle cx="8" cy="8" r="4"/><path d="M11 11l9 9"/><path d="M17 17l2-2 2 2-2 2"/>'],
        ['light', '灯泡', '<path d="M9.5 17h5"/><path d="M10.5 20h3"/><path d="M12 3a6 6 0 0 0-3.5 10.9V17h7v-3.1A6 6 0 0 0 12 3Z"/>'],
        ['ruler', '尺子', '<rect x="2" y="8" width="20" height="8" rx="1.5"/><path d="M6 8v3M10 8v4M14 8v3M18 8v4"/>'],
        ['paint', '油漆', '<rect x="4" y="9" width="16" height="12" rx="1.5"/><path d="M4 13h16"/><path d="M12 9V6a3 3 0 0 0-3-3H8"/>']
      ]
    },
    {
      key: 'cloth',
      name: '衣物服饰',
      icons: [
        ['shirt', '上衣', '<path d="M9 3l3 2 3-2 5 3-2 4-2-1v11H8V9L6 10 4 6Z"/>'],
        ['shoe', '鞋', '<path d="M4 17.5h16v1a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5Z"/><path d="M4 17.5v-5h5l3 3h4l3 2"/>'],
        ['bag', '包', '<path d="M5 8h14l1 13H4Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>'],
        ['hat', '帽子', '<path d="M12 5c4 0 6 2 6 4v5H6V9c0-2 2-4 6-4Z"/><path d="M3 14h18v3H3Z"/>'],
        ['glasses', '眼镜', '<circle cx="6.5" cy="13.5" r="3.5"/><circle cx="17.5" cy="13.5" r="3.5"/><path d="M10 13.5h4"/><path d="M3 12.5 4 8h3M21 12.5 20 8h-3"/>'],
        ['watch', '手表饰品', '<circle cx="12" cy="12" r="5.5"/><path d="M12 9.5V12l1.9 1.2"/><path d="M9.6 7 9 3h6l-.6 4M9.6 17 9 21h6l-.6-4"/>']
      ]
    },
    {
      key: 'misc',
      name: '居家其他',
      icons: [
        ['box', '收纳盒', '<rect x="3" y="7" width="18" height="13" rx="1.5"/><path d="M3 11.5h18"/><path d="M9 7V4h6v3"/>'],
        ['basket', '篮子', '<path d="M4 9h16l-1.6 11h-12.8Z"/><path d="M4 9 6 4M20 9l-2-5M9.5 13v4M14.5 13v4"/>'],
        ['gift', '礼品', '<rect x="3" y="9" width="18" height="11" rx="1.5"/><path d="M3 13h18M12 9v11"/><path d="M12 9c0-3-2-5-4-5a2 2 0 0 0 0 5M12 9c0-3 2-5 4-5a2 2 0 0 1 0 5"/>'],
        ['toy', '玩具', '<rect x="3" y="12" width="8" height="8" rx="1"/><rect x="13" y="12" width="8" height="8" rx="1"/><rect x="8" y="4" width="8" height="8" rx="1"/>'],
        ['sport', '运动户外', '<path d="M3 9.5v5M6 7v10M18 7v10M21 9.5v5M6 12h12"/>'],
        ['pet', '宠物', '<circle cx="7" cy="9.5" r="1.9"/><circle cx="11.5" cy="6.8" r="1.9"/><circle cx="16.5" cy="8" r="1.9"/><path d="M9 15.5c0-2 1.8-3.5 4-3.5s4 1.5 4 3.5c0 2.4-2 4.2-4 4.2s-4-1.8-4-4.2Z"/>'],
        ['baby', '母婴', '<path d="M10 7.5h4v12a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1Z"/><path d="M10 7.5V5.6A2.6 2.6 0 0 1 12.6 3h-.2A2.6 2.6 0 0 1 15 5.6v1.9"/><path d="M10 12.5h4"/>'],
        ['plant', '绿植', '<path d="M12 21v-8"/><path d="M12 13.5c0-3.8-2.8-5.8-7.5-5.8C4.5 11.5 7.3 13.5 12 13.5Z"/><path d="M12 11.5c0-3.2 2.8-5 7.5-5C19.5 9.7 16.7 11.5 12 11.5Z"/><path d="M8 21h8"/>'],
        ['umbrella', '雨具', '<path d="M12 3a9 9 0 0 1 9 9H3a9 9 0 0 1 9-9Z"/><path d="M12 12v6.5a2.5 2.5 0 0 0 5 0"/>'],
        ['clock', '钟表', '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'],
        ['craft', '手工艺', '<path d="M12 3a9 9 0 0 0 0 18c1.6 0 2.2-1.1 2.2-2.1 0-1.1-.6-2.1.5-2.1H17a4 4 0 0 0 4-4c0-5.4-4-9.8-9-9.8Z"/><circle cx="8" cy="11.5" r="1.2"/><circle cx="12" cy="8.5" r="1.2"/><circle cx="16" cy="11.5" r="1.2"/>']
      ]
    }
  ];

  // 拍平成 { key: {key,name,group} }，方便按 key 查名字
  var byKey = {};
  var all = [];
  GROUPS.forEach(function (g) {
    g.icons = g.icons.map(function (row) {
      var icon = { key: row[0], name: row[1], body: row[2], group: g.key, groupName: g.name };
      byKey[icon.key] = icon;
      all.push(icon);
      return icon;
    });
  });

  /**
   * 分类 key → 默认图标。
   * 用户不会给每件东西都挑图标（也不该逼他挑），所以按分类给个合理默认：
   * 「药品」底下的东西自动是药片图标，「图书」底下的自动是书本图标。
   * key 取自数据层的预置分类表（store.js 的 PRESET_CATEGORIES），两边必须对得上。
   */
  var CAT_ICON = {
    食品: 'rice', 药品: 'pill', 日化: 'soap', 清洁: 'cleaner', 五金: 'tool',
    文具: 'paper', 衣物: 'shirt', 其他: 'box',
    合同: 'contract', 公文: 'file', 人事: 'folder', 证照: 'certificate', 培训: 'textbook',
    记账: 'ledger', 账簿: 'chart', 发票: 'invoice', 报税: 'tax', 银行: 'bank', 报销: 'receipt',
    图书: 'book', 教材: 'textbook', 期刊: 'magazine',
    母婴: 'baby', 宠物: 'pet', 运动: 'sport', 数码: 'cable', 手工: 'craft'
  };

  // 物品类型兜底：连分类都没选的时候按 kind 给一个
  var KIND_ICON = { goods: 'box', doc: 'file', book: 'book' };

  /** 解析一件物品该用哪个图标：手选的 > 分类默认 > 类型兜底 */
  function iconKeyFor(item) {
    if (!item) return '';
    if (item.icon && byKey[item.icon]) return item.icon;
    if (item.cat_key && CAT_ICON[item.cat_key]) return CAT_ICON[item.cat_key];
    return KIND_ICON[item.kind] || 'box';
  }

  var ITEM_ICONS = {
    groups: GROUPS,
    all: all,
    get: function (key) {
      return byKey[String(key || '')] || null;
    },
    name: function (key) {
      var ic = byKey[String(key || '')];
      return ic ? ic.name : '';
    },
    /** 生成完整 <svg>；key 不存在返回空串（调用方据此回退到色点） */
    svg: function (key, size) {
      var ic = byKey[String(key || '')];
      if (!ic) return '';
      size = size || 24;
      return (
        '<svg class="item-icon" viewBox="0 0 24 24" width="' + size + '" height="' + size + '" ' +
        'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ' +
        'stroke-linejoin="round" aria-hidden="true">' + ic.body + '</svg>'
      );
    },
    catIcon: function (catKey) {
      return CAT_ICON[String(catKey || '')] || '';
    },
    /** 物品该用哪个图标（key） */
    forItem: iconKeyFor,
    /** 物品图标的 <svg>，解析不出时返回空串 */
    itemSvg: function (item, size) {
      return ITEM_ICONS.svg(iconKeyFor(item), size);
    }
  };

  window.ITEM_ICONS = ITEM_ICONS;
})();
