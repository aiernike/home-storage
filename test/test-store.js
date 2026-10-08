'use strict';
// 数据层功能验证脚本
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-test-'));
const { createStore } = require(path.join(__dirname, '..', 'src', 'main', 'store.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  → ' + extra : '')); }
}

(async () => {
  const store = createStore(tmp);
  const call = (a, p) => store.handle(a, p);

  console.log('\n[1] 初始化与预置数据');
  const tree0 = await call('locations.tree');
  ok('预置位置树有顶层节点', tree0.length >= 4, 'got ' + tree0.length);
  const cats = await call('categories.list');
  ok('预置分类已扩充（>= 24 个）', cats.length >= 24, 'got ' + cats.length);
  // 需求要求新增「办公资料 / 会计专用 / 书籍阅读」三类分类，逐类点名校验
  const catNames = cats.map((c) => c.name);
  const needCats = [
    '合同协议', '人事档案', '资质证照',           // 办公资料类
    '记账凭证', '账簿报表', '报税资料', '银行单据', // 会计专用类
    '图书', '教材教辅', '杂志期刊',               // 书籍阅读类
    '母婴用品', '宠物用品', '运动户外'             // 生活扩展类
  ];
  const missCats = needCats.filter((n) => catNames.indexOf(n) < 0);
  ok('新增分类齐备（办公/会计/书籍/生活）', missCats.length === 0, '缺：' + missCats.join(','));
  // 原有 8 个分类的 key 必须保留，否则老数据的 category_id 会失联
  const catKeys = cats.map((c) => c.key);
  const oldKeys = ['食品', '药品', '日化', '清洁', '五金', '文具', '衣物', '其他'];
  ok('原有 8 个分类 key 未丢失', oldKeys.every((k) => catKeys.indexOf(k) >= 0));
  ok('分类 key 无重复', new Set(catKeys).size === catKeys.length);
  ok('每个分类都有颜色', cats.every((c) => /^#[0-9A-Fa-f]{6}$/.test(c.color || '')));

  const kitchen = tree0.find((n) => n.name === '厨房');
  ok('厨房有子位置', kitchen.children.length >= 2);
  const fridge = kitchen.children.find((n) => n.name === '冰箱');
  ok('冰箱下有冷藏室', fridge.children.some((n) => n.name === '冷藏室'));

  // 树节点必须带 path：渲染层的「上级位置」下拉从树构建扁平列表，
  // 缺 path 时标签会显示成 undefined。
  const flatTree = [];
  const flatWalk = (ns) => ns.forEach((n) => { flatTree.push(n); if (n.children) flatWalk(n.children); });
  flatWalk(tree0);
  ok('树节点均含 path 字段', flatTree.every((n) => typeof n.path === 'string' && n.path),
    '缺少 path 的节点数：' + flatTree.filter((n) => !n.path).length);
  const deepNode = flatTree.find((n) => n.name === '冷藏室');
  ok('深层节点的 path 是完整层级', deepNode && deepNode.path === '厨房 / 冰箱 / 冷藏室',
    'got ' + (deepNode && deepNode.path));
  ok('树节点 depth 与 path 层级一致',
    deepNode && deepNode.depth === deepNode.path.split(' / ').length - 1,
    'depth=' + (deepNode && deepNode.depth) + ' path=' + (deepNode && deepNode.path));

  console.log('\n[2] 新增位置与层级');
  const newLoc = await call('locations.save', { name: '阳台柜', parent_id: null });
  ok('新增顶层位置', !!newLoc.id);
  const sub = await call('locations.save', { name: '第三层', parent_id: newLoc.id });
  ok('新增子位置', sub.parent_id === newLoc.id);
  const list = await call('locations.list');
  const subRow = list.find((l) => l.id === sub.id);
  ok('位置路径正确', subRow.path === '阳台柜 / 第三层', 'got ' + subRow.path);

  console.log('\n[3] 循环引用防护');
  let blocked = false;
  try { await call('locations.move', { id: newLoc.id, parent_id: sub.id }); }
  catch (e) { blocked = true; }
  ok('阻止移动到自己的下级', blocked);

  console.log('\n[4] 物品增删改查');
  const milk = await call('items.save', {
    name: '全脂牛奶', barcodes: ['6901234567892'], category_id: cats[0].id,
    location_id: fridge.children[0].id, quantity: 2, unit: '盒',
    production_date: '2026-09-01', shelf_life_days: 30, price: 12.5, tags: ['早餐']
  });
  ok('新增物品成功', !!milk.id);
  ok('排序码第一位正确', milk.barcode === '6901234567892');

  console.log('\n[5] 条码唯一性');
  let dupBlocked = false;
  try { await call('items.save', { name: '另一个牛奶', barcodes: ['6901234567892'] }); }
  catch (e) { dupBlocked = true; }
  ok('重复条码被拒绝', dupBlocked);

  console.log('\n[6] 条码反查');
  const found = await call('items.byBarcode', { barcode: '6901234567892' });
  ok('按条码查到物品', found && found.name === '全脂牛奶');
  const notFound = await call('items.byBarcode', { barcode: '0000000000000' });
  ok('未知条码返回 null', notFound === null);

  console.log('\n[7] 保质期计算与状态');
  const expectedExpiry = new Date('2026-09-01T00:00:00');
  expectedExpiry.setDate(expectedExpiry.getDate() + 30);
  const fmtD = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const exp = fmtD(expectedExpiry);
  ok('30天保质期推算到期日 = 10-01', exp === '2026-10-01', 'got ' + exp);

  // 造一个过期物品和一个临期物品
  const today = new Date();
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dPast = new Date(today); dPast.setDate(dPast.getDate() - 5);
  const dSoon = new Date(today); dSoon.setDate(dSoon.getDate() + 3);

  await call('items.save', { name: '过期酸奶', expiry_date: fmt(dPast), location_id: fridge.children[0].id });
  await call('items.save', { name: '快过期面包', expiry_date: fmt(dSoon), location_id: fridge.children[0].id });

  const all = await call('items.list', {});
  const yogurt = all.find((i) => i.name === '过期酸奶');
  const bread = all.find((i) => i.name === '快过期面包');
  ok('过期物品状态 = expired', yogurt.expiry_state === 'expired', 'got ' + yogurt.expiry_state);
  ok('临期物品状态 = soon', bread.expiry_state === 'soon', 'got ' + bread.expiry_state);
  ok('过期天数计算正确 (-5)', yogurt.days_left === -5, 'got ' + yogurt.days_left);

  const soon = await call('items.expiringSoon', { days: 7 });
  ok('临期查询返回 2 条', soon.length === 2, 'got ' + soon.length);
  ok('临期查询按紧急度排序', soon[0].days_left < soon[1].days_left);

  console.log('\n[8] 位置筛选（含子位置递归）');
  const inFridge = await call('items.list', { location_id: fridge.id });
  ok('按冰箱筛选含冷藏室物品', inFridge.length >= 3, 'got ' + inFridge.length);
  const inKitchen = await call('items.list', { location_id: kitchen.id });
  ok('按厨房筛选含全部下级', inKitchen.length >= 3, 'got ' + inKitchen.length);
  const inBalcony = await call('items.list', { location_id: newLoc.id });
  ok('空位置返回 0 条', inBalcony.length === 0);

  console.log('\n[9] 搜索');
  const s1 = await call('items.list', { keyword: '牛奶' });
  ok('按名称搜索', s1.length === 1 && s1[0].name === '全脂牛奶', 'got ' + s1.length);
  const s2 = await call('items.list', { keyword: '6901234567892' });
  ok('按条码搜索', s2.length === 1);
  const s3 = await call('items.list', { keyword: '冷藏室' });
  ok('按位置路径搜索', s3.length >= 3, 'got ' + s3.length);

  console.log('\n[10] 数量增减与消耗');
  const c1 = await call('items.consume', { id: milk.id, delta: -1 });
  ok('消耗减一 → 1', c1.quantity === 1, 'got ' + c1.quantity);
  const c2 = await call('items.consume', { id: milk.id, delta: -5 });
  ok('不会减到负数', c2.quantity === 0, 'got ' + c2.quantity);
  ok('消耗记录已写入', Array.isArray(c2.logs) && c2.logs.length === 2);

  console.log('\n[11] 删除保护');
  let delBlocked = false;
  try { await call('locations.delete', { id: kitchen.id }); }
  catch (e) { delBlocked = true; }
  ok('有子位置时拒绝删除', delBlocked);

  let usedBlocked = false;
  try { await call('locations.delete', { id: fridge.id }); }
  catch (e) { usedBlocked = true; }
  ok('子位置存在时拒绝删除冰箱', usedBlocked);

  let parentBlocked = false;
  try { await call('locations.delete', { id: newLoc.id }); }
  catch (e) { parentBlocked = true; }
  ok('有子位置时拒绝删除（保护正确）', parentBlocked);
  // 先删子位置，再删父位置
  await call('locations.delete', { id: sub.id });
  const delParent = await call('locations.delete', { id: newLoc.id });
  ok('清空子位置后可删除父位置', delParent.ok === true);

  console.log('\n[12] 统计');
  const stats = await call('items.stats');
  ok('统计物品总数', stats.total >= 3, 'got ' + stats.total);
  ok('统计总价值 > 0', stats.totalValue > 0, 'got ' + stats.totalValue);
  ok('统计分类分布非空', stats.categories.length > 0);
  ok('统计位置分布非空', stats.locations.length > 0);
  ok('趋势有 6 个月', stats.trend.length === 6);

  console.log('\n[13] 数据持久化（重开进程后仍在）');
  store.saveNow();
  const store2 = createStore(tmp);
  const all2 = await store2.handle('items.list', {});
  ok('重新加载后物品还在', all2.length === all.length, `${all2.length} vs ${all.length}`);
  const found2 = await store2.handle('items.byBarcode', { barcode: '6901234567892' });
  ok('重新加载后条码仍可查', found2 && found2.name === '全脂牛奶');

  console.log('\n[14] 导出 / 导入');
  const dump = await call('app.export');
  ok('导出包含物品', dump.items.length === all.length);
  ok('导出包含位置', dump.locations.length > 0);

  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-test2-'));
  const store3 = createStore(tmp2);
  await store3.handle('app.import', { data: dump, mode: 'replace' });
  const imported = await store3.handle('items.list', {});
  ok('导入后物品数一致', imported.length === all.length, `${imported.length} vs ${all.length}`);
  const importedFound = await store3.handle('items.byBarcode', { barcode: '6901234567892' });
  ok('导入后位置关联完好', importedFound && importedFound.location_path.includes('冷藏室'), 'got ' + (importedFound && importedFound.location_path));

  console.log('\n[15] 汇总接口');
  const sum = await call('app.summary');
  ok('汇总含物品数', sum.items === all.length);
  ok('汇总含过期数', sum.expired === 1, 'got ' + sum.expired);
  ok('汇总含临期数', sum.soon === 1, 'got ' + sum.soon);

  console.log('\n[16] NFC 标签绑定位置');
  // 设计：标签只当「位置的手柄」，用 UID 当标识，不往标签里写数据，
  // 所以最便宜的空白卡也能用；一个标签只能绑一个位置；UID 大小写不敏感。
  const uidA = '04A2B3C4D51122';
  const uidB = '04E5F6A7B83344';
  const shoe = await call('locations.save', { name: '鞋柜', parent_id: null });
  ok('新增位置用于绑标签', !!shoe.id);
  const drawer = await call('locations.save', { name: '抽屉盒', parent_id: null });
  ok('新增第二个位置用于冲突测试', !!drawer.id);

  const bound = await call('locations.bindNfc', { id: shoe.id, nfc_tag: uidA.toLowerCase() });
  ok('绑定时 UID 自动转大写', bound.nfc_tag === uidA, 'got ' + bound.nfc_tag);

  const listRow = (await call('locations.list')).find((l) => l.id === shoe.id);
  ok('位置列表含 nfc_tag 字段', !!listRow && listRow.nfc_tag === uidA, listRow && listRow.nfc_tag);
  const treeRow = (await call('locations.tree')).find((n) => n.id === shoe.id);
  ok('位置树含 nfc_tag 字段', !!treeRow && treeRow.nfc_tag === uidA, treeRow && treeRow.nfc_tag);

  const byA = await call('locations.byNfc', { nfc_tag: uidA });
  ok('byNfc 用大写 UID 命中', !!byA && byA.id === shoe.id && byA.path === '鞋柜',
    JSON.stringify(byA).slice(0, 120));
  const byLower = await call('locations.byNfc', { nfc_tag: uidA.toLowerCase() });
  ok('byNfc 大小写不敏感（小写也能命中）', !!byLower && byLower.id === shoe.id);
  const none = await call('locations.byNfc', { nfc_tag: uidB });
  ok('未绑定标签 byNfc 返回 null', none === null);
  const empty = await call('locations.byNfc', { nfc_tag: '   ' });
  ok('空 UID 的 byNfc 返回 null', empty === null);

  // 一个标签只能绑一个位置：把 A 绑到第二个位置必须被拒绝
  let clash = false;
  let clashMsg = '';
  try { await call('locations.bindNfc', { id: drawer.id, nfc_tag: uidA }); }
  catch (e) { clash = true; clashMsg = e.message; }
  ok('同一标签绑第二个位置被拒绝', clash);
  ok('冲突提示说清了被绑到哪个位置', /已绑定到/.test(clashMsg), clashMsg);

  let emptyRej = false;
  try { await call('locations.bindNfc', { id: drawer.id, nfc_tag: '   ' }); }
  catch (e) { emptyRej = true; }
  ok('空 UID 绑定被拒绝', emptyRej);

  // 不存在的位置报错
  let noLoc = false;
  try { await call('locations.bindNfc', { id: 'no-such-loc', nfc_tag: uidB }); }
  catch (e) { noLoc = true; }
  ok('绑定到不存在的位置报错', noLoc);

  // 解绑后该标签不再命中
  const unbound = await call('locations.unbindNfc', { id: shoe.id });
  ok('解绑返回成功', unbound.ok === true);
  const afterUnbind = await call('locations.byNfc', { nfc_tag: uidA });
  ok('解绑后 byNfc 返回 null', afterUnbind === null);
  const listAfterUnbind = (await call('locations.list')).find((l) => l.id === shoe.id);
  ok('解绑后位置列表 nfc_tag 为空串', !!listAfterUnbind && listAfterUnbind.nfc_tag === '');

  // 重新绑定后，重开进程（同一存储目录）数据仍在 —— 证明 nfc_tag 真实落盘
  await call('locations.bindNfc', { id: shoe.id, nfc_tag: uidA });
  store.saveNow();
  const storeN = createStore(tmp);
  const byAfter = await storeN.handle('locations.byNfc', { nfc_tag: uidA });
  ok('重开存储后 nfc_tag 仍可用', !!byAfter && byAfter.id === shoe.id, JSON.stringify(byAfter).slice(0, 120));
  const pathAfter = await storeN.handle('locations.byNfc', { nfc_tag: uidA });
  ok('重开后 byNfc 仍返回完整 path', !!pathAfter && pathAfter.path === '鞋柜');

  // ============================================================
  // [17] 物品图片（拍照 → 缩略图 → 查看 → 同步）
  // 设计要点：全图 base64 写独立文件，storage.json 里只留缩略图，
  // 否则手机端 localStorage 约 5MB 会被一张照片撑爆。
  // ============================================================
  console.log('\n[17] 物品图片');
  const FULL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD' + 'A'.repeat(400);
  const THUMB = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ' + 'B'.repeat(80);
  const photo = await call('items.save', { name: '带照片的物品', location_id: fridge.children[0].id });

  const beforeImg = (await call('items.list')).find((i) => i.id === photo.id);
  ok('新物品默认没有图片', beforeImg && beforeImg.has_image === false, JSON.stringify(beforeImg && beforeImg.has_image));
  ok('没有图片时 thumb 为空串', beforeImg && beforeImg.thumb === '', JSON.stringify(beforeImg && beforeImg.thumb));

  const saved = await call('images.save', { item_id: photo.id, full: FULL, thumb: THUMB, w: 1024, h: 768 });
  ok('保存图片后返回的 item 标记 has_image', saved.has_image === true);
  ok('保存图片后 item 带上 image_id', typeof saved.image_id === 'string' && saved.image_id.length > 0, saved.image_id);
  ok('保存图片后 item 带上缩略图', saved.thumb === THUMB);

  const listWithImg = (await call('items.list')).find((i) => i.id === photo.id);
  ok('物品列表里带缩略图（列表不用再取全图）', listWithImg.thumb === THUMB);
  ok('物品列表里 image_id 与保存结果一致', listWithImg.image_id === saved.image_id);

  const got = await call('images.data', { id: saved.image_id });
  ok('images.data 能取回全图', got.full === FULL);
  ok('images.data 也带缩略图', got.thumb === THUMB);

  // storage.json 里绝不能出现全图（手机端容量红线）
  store.saveNow(); // save() 是防抖的，先强制落盘再读文件
  const rawJson = fs.readFileSync(store.dataFile, 'utf8');
  ok('storage.json 不含全图 base64', rawJson.indexOf(FULL) === -1);
  ok('storage.json 含缩略图（列表离线也能显示）', rawJson.indexOf(THUMB) !== -1);
  ok('全图落在独立文件里', fs.existsSync(path.join(path.dirname(store.dataFile), 'images', saved.image_id + '.txt')));

  // 重开存储：图片元数据与全图都要还在
  store.saveNow();
  const storeI = createStore(tmp);
  const afterReopen = (await storeI.handle('items.list')).find((i) => i.id === photo.id);
  ok('重开存储后物品仍有图', afterReopen && afterReopen.has_image === true);
  ok('重开存储后缩略图还在', afterReopen && afterReopen.thumb === THUMB);
  const gotAfter = await storeI.handle('images.data', { id: saved.image_id });
  ok('重开存储后仍能取回全图', gotAfter.full === FULL);

  // 覆盖保存：同一个物品再拍一张，不应产生第二张图
  const saved2 = await call('images.save', { item_id: photo.id, full: FULL, thumb: THUMB + 'X', w: 800, h: 600 });
  ok('重复拍照不新建图片记录（复用同一 id）', saved2.image_id === saved.image_id, saved2.image_id + ' vs ' + saved.image_id);
  const imgCount = (await call('app.export')).images.filter((x) => !x.deleted).length;
  ok('活跃图片记录只有一条', imgCount === 1, 'got ' + imgCount);

  // 导出必须带全图，否则备份恢复后图片就丢了
  const expData = await call('app.export');
  const expImg = expData.images.find((x) => x.id === saved.image_id);
  ok('导出数据含图片记录', !!expImg);
  ok('导出数据含图片全图（备份可完整恢复）', expImg && expImg.full === FULL);

  // 导入（replace）能把图片和全图一起还原
  const tmpImp = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-imp-'));
  const storeImp = createStore(tmpImp);
  await storeImp.handle('app.import', { data: expData, mode: 'replace' });
  const impItem = (await storeImp.handle('items.list')).find((i) => i.id === photo.id);
  ok('导入后物品带图', impItem && impItem.has_image === true);
  const impImg = await storeImp.handle('images.data', { id: saved.image_id });
  ok('导入后全图也能取回', impImg.full === FULL);
  try { fs.rmSync(tmpImp, { recursive: true, force: true }); } catch (e) {}

  // 增量同步：since 之后的变更才带出去
  const incAll = store.imagesSince('');
  ok('imagesSince("") 返回全部图片', incAll.length >= 1 && incAll[0].full === FULL);
  const incNone = store.imagesSince('2999-01-01T00:00:00.000Z');
  ok('imagesSince(未来时间) 返回空', incNone.length === 0);

  // 应用远端图片（另一台设备新增的图）
  const storeR = createStore(fs.mkdtempSync(path.join(os.tmpdir(), 'hs-rem-')));
  const remoteFull = 'data:image/jpeg;base64,/9j/4REMOTE' + 'C'.repeat(200);
  const applied = storeR.applyImages([
    { id: 'img-remote-1', item_id: 'it-x', thumb: THUMB, w: 640, h: 480, full: remoteFull,
      created_at: '2026-09-13T00:00:00.000Z', updated_at: '2026-09-13T00:00:00.000Z', deleted: false }
  ]);
  ok('applyImages 报告有变更', applied.changed === true && applied.failed === 0,
    JSON.stringify(applied));
  const remoteGot = await storeR.handle('images.data', { id: 'img-remote-1' });
  ok('应用远端图片后能取回全图', remoteGot.full === remoteFull);
  const appliedAgain = storeR.applyImages([
    { id: 'img-remote-1', item_id: 'it-x', thumb: THUMB, full: remoteFull,
      updated_at: '2026-09-13T00:00:00.000Z', deleted: false }
  ]);
  ok('applyImages 对同版本数据不重复应用', appliedAgain.changed === false);

  // 删物品要连带软删图片，并删掉全图文件
  await call('items.delete', { id: photo.id });
  const afterDel = await call('app.export');
  const delImg = afterDel.images.find((x) => x.id === saved.image_id);
  ok('删物品后图片记录被软删', delImg && delImg.deleted === true);
  ok('删物品后全图文件已清理', !fs.existsSync(path.join(path.dirname(store.dataFile), 'images', saved.image_id + '.txt')));

  // 手动移除图片
  const photo2 = await call('items.save', { name: '再拍一张', location_id: fridge.children[0].id });
  await call('images.save', { item_id: photo2.id, full: FULL, thumb: THUMB, w: 100, h: 100 });
  const removed = await call('images.remove', { item_id: photo2.id });
  ok('移除图片后 has_image 变回 false', removed.has_image === false);
  ok('移除图片后 thumb 清空', removed.thumb === '');
  const removedList = (await call('items.list')).find((i) => i.id === photo2.id);
  ok('列表里该物品已无图', removedList.has_image === false);
  let noImg = false;
  try { await call('images.data', { id: removed.image_id }); } catch (e) { noImg = true; }
  ok('已删图片再取全图会报错', noImg);

  // 清库要把图片文件一并清掉
  await call('images.save', { item_id: photo2.id, full: FULL, thumb: THUMB, w: 100, h: 100 });
  const tmpWipe = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-wipe-'));
  const storeW = createStore(tmpWipe);
  const wItem = await storeW.handle('items.save', { name: '待清库' });
  await storeW.handle('images.save', { item_id: wItem.id, full: FULL, thumb: THUMB });
  const wImgDir = path.join(path.dirname(storeW.dataFile), 'images');
  ok('清库前图片文件存在', fs.existsSync(wImgDir) && fs.readdirSync(wImgDir).length > 0);
  await storeW.handle('app.wipe');
  const leftover = fs.existsSync(wImgDir) ? fs.readdirSync(wImgDir).length : 0;
  ok('清库后图片文件被清空', leftover === 0, 'got ' + leftover);
  try { fs.rmSync(tmpWipe, { recursive: true, force: true }); } catch (e) {}

  // ------------------------------------------------------------------
  // [v2] 物品类型 / 图标 / 内部编码 / 类型专属字段
  // 需求：办公资料与书籍单独成栏目、没条码的物品自动生成编码、给物品配图。
  // 这些都落在同一张 items 表上，靠 kind 区分，所以数据层必须先把字段撑住。
  // ------------------------------------------------------------------
  console.log('\n[v2] 物品类型 / 图标 / 内部编码 / 专属字段');

  // 1) 默认类型是普通物品，老数据和新数据行为一致
  const v2Plain = await call('items.save', { name: 'v2 普通物品' });
  ok('默认 kind 是 goods', v2Plain.kind === 'goods', 'got ' + v2Plain.kind);
  ok('默认 icon 为空串（由界面按分类兜底）', v2Plain.icon === '');
  ok('默认 code 为空串', v2Plain.code === '');
  ok('默认 extra 是空对象', v2Plain.extra && typeof v2Plain.extra === 'object' && !Array.isArray(v2Plain.extra));

  // 2) 非法 kind 要兜底成 goods，不能让脏数据把界面渲染搞崩
  const v2BadKind = await call('items.save', { name: 'v2 脏类型', kind: 'hacker' });
  ok('非法 kind 兜底为 goods', v2BadKind.kind === 'goods', 'got ' + v2BadKind.kind);

  // 3) 办公资料：文件名称 / 类别 / 年度 / 金额 / 保管期限
  const v2Doc = await call('items.save', {
    name: '房屋租赁合同',
    kind: 'doc',
    icon: 'contract',
    extra: { doc_no: 'HT-2026-018', year: '2026', org: '某某物业', amount: '48000', keep_until: '2031-12-31' }
  });
  ok('办公资料 kind=doc', v2Doc.kind === 'doc');
  ok('办公资料 icon 已保存', v2Doc.icon === 'contract');
  ok('办公资料专属字段可读', v2Doc.extra.doc_no === 'HT-2026-018' && v2Doc.extra.amount === '48000');
  ok('办公资料带分类 key 供界面兜底图标', typeof v2Doc.cat_key === 'string');

  // 4) 书籍：书名 / 作者 / 出版社 / ISBN / 阅读状态
  const v2Book = await call('items.save', {
    name: '深入理解计算机系统',
    kind: 'book',
    icon: 'book',
    barcode: '9787111544937',
    extra: { author: 'Randal E. Bryant', publisher: '机械工业出版社', pub_year: '2016', status: '在读' }
  });
  ok('书籍 kind=book', v2Book.kind === 'book');
  ok('书籍专属字段可读', v2Book.extra.author === 'Randal E. Bryant' && v2Book.extra.publisher === '机械工业出版社');

  // 5) extra 是增量合并：只改一个字段不能把其它字段冲掉
  const v2Book2 = await call('items.save', { id: v2Book.id, extra: { status: '已读' } });
  ok('extra 增量合并保留旧字段', v2Book2.extra.author === 'Randal E. Bryant' && v2Book2.extra.status === '已读',
    JSON.stringify(v2Book2.extra));
  ok('extra 合并后 name 未被清空', v2Book2.name === '深入理解计算机系统');

  // 6) 按 kind 过滤
  const v2Docs = await call('items.list', { kind: 'doc' });
  ok('按 kind=doc 过滤只返回办公资料', v2Docs.length > 0 && v2Docs.every((i) => i.kind === 'doc'), 'got ' + v2Docs.length);
  const v2Books = await call('items.list', { kind: 'book' });
  ok('按 kind=book 过滤只返回书籍', v2Books.length > 0 && v2Books.every((i) => i.kind === 'book'), 'got ' + v2Books.length);
  const v2Both = await call('items.list', { kind: ['doc', 'book'] });
  ok('kind 支持数组（多类型）', v2Both.length === v2Docs.length + v2Books.length, 'got ' + v2Both.length);
  const v2Goods = await call('items.list', { kind: 'goods' });
  ok('kind=goods 过滤不包含资料/书籍', v2Goods.every((i) => i.kind === 'goods'));

  // 7) 搜索要覆盖内部编码与专属字段，否则「搜作者名搜不到书」很反直觉
  ok('搜索命中内部编码', (await call('items.list', { keyword: 'HT-2026-018' })).some((i) => i.id === v2Doc.id));
  ok('搜索命中专属字段（作者）', (await call('items.list', { keyword: 'Bryant' })).some((i) => i.id === v2Book.id));
  ok('搜索命中专属字段（出版社）', (await call('items.list', { keyword: '机械工业' })).some((i) => i.id === v2Book.id));
  ok('搜索命中分类名', (await call('items.list', { keyword: '图书' })).length >= 0);

  // 8) 内部编码：自动生成 HS-<年>-<4位流水>
  const v2Year = new Date().getFullYear();
  const v2Code1 = await call('items.nextCode');
  ok('自动编码格式为 HS-年-4位', v2Code1.code === `HS-${v2Year}-0001`, 'got ' + v2Code1.code);
  const v2WithCode = await call('items.save', { name: 'v2 无条码物品', code: v2Code1.code, kind: 'goods' });
  ok('编码可写入物品', v2WithCode.code === v2Code1.code);
  const v2Code2 = await call('items.nextCode');
  ok('下一个编码流水号 +1', v2Code2.code === `HS-${v2Year}-0002`, 'got ' + v2Code2.code);
  ok('编码序号可从返回值读到', v2Code2.seq === 2, 'got ' + v2Code2.seq);

  // 流水号不能重复：手工塞一个 0009 之后，下一个必须是 0010
  await call('items.save', { name: 'v2 跳号物品', code: `HS-${v2Year}-0009` });
  const v2Code3 = await call('items.nextCode');
  ok('流水号按已有最大值推进', v2Code3.code === `HS-${v2Year}-0010`, 'got ' + v2Code3.code);

  // 编码唯一性：重复编码必须报错，否则扫码会扫出两个结果
  let v2DupErr = '';
  try { await call('items.save', { name: 'v2 重复编码', code: v2Code1.code }); } catch (e) { v2DupErr = e.message; }
  ok('重复内部编码被拒绝', /占用/.test(v2DupErr), v2DupErr);

  // 自定义前缀
  const v2Custom = await call('items.nextCode', { prefix: 'bg' });
  ok('支持自定义前缀并转大写', v2Custom.code === `BG-${v2Year}-0001`, 'got ' + v2Custom.code);

  // 9) 按内部编码查（扫自生成条码时用）
  const v2ByCode = await call('items.byCode', { code: v2Code1.code });
  ok('按内部编码能查到物品', v2ByCode && v2ByCode.id === v2WithCode.id);
  ok('按内部编码查大小写不敏感', !!(await call('items.byCode', { code: v2Code1.code.toLowerCase() })));
  ok('查不到的编码返回 null', (await call('items.byCode', { code: 'HS-1999-9999' })) === null);
  ok('空编码返回 null', (await call('items.byCode', { code: '' })) === null);

  // 10) 统计要能按类型拆开
  const v2Stats = await call('items.stats');
  ok('统计返回按类型计数', v2Stats.kinds && typeof v2Stats.kinds.doc === 'number');
  ok('统计里 doc 数量与过滤一致', v2Stats.kinds.doc === v2Docs.length, `${v2Stats.kinds.doc} vs ${v2Docs.length}`);
  ok('统计里 book 数量与过滤一致', v2Stats.kinds.book === v2Books.length, `${v2Stats.kinds.book} vs ${v2Books.length}`);

  // 11) 概览接口也要带资料/书籍数量（导航徽标用）
  const v2Sum = await call('app.summary');
  ok('概览含 docs 计数', v2Sum.docs === v2Docs.length, `${v2Sum.docs} vs ${v2Docs.length}`);
  ok('概览含 books 计数', v2Sum.books === v2Books.length, `${v2Sum.books} vs ${v2Books.length}`);

  // 12) 导出/导入必须带上新字段，否则备份恢复后资料就退化成普通物品了
  const v2Exp = await call('app.export');
  const v2ExpDoc = v2Exp.items.find((i) => i.id === v2Doc.id);
  ok('导出含 kind/icon/code/extra', v2ExpDoc && v2ExpDoc.kind === 'doc' && v2ExpDoc.icon === 'contract' &&
    v2ExpDoc.extra && v2ExpDoc.extra.doc_no === 'HT-2026-018');

  // 光「导出带字段」还不够 —— 用户恢复备份走的是 app.import，导入那一侧也要原样落地，
  // 否则「备份文件里有、恢复完就没了」这种问题要等用户真出事才会发现。
  const tmpImp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-imp2-'));
  const storeImp2 = createStore(tmpImp2);
  await storeImp2.handle('app.import', { data: v2Exp, mode: 'replace' });
  const impDoc = (await storeImp2.handle('items.list', { kind: 'doc' })).find((i) => i.id === v2Doc.id);
  const impBook = (await storeImp2.handle('items.list', { kind: 'book' })).find((i) => i.id === v2Book.id);
  const impCoded = (await storeImp2.handle('items.list', {})).find((i) => i.id === v2WithCode.id);
  ok('导入后资料没有退化成普通物品', impDoc && impDoc.kind === 'doc', JSON.stringify(impDoc && impDoc.kind));
  ok('导入后资料的图标还在', impDoc && impDoc.icon === 'contract', impDoc && impDoc.icon);
  ok('导入后资料的专属字段还在',
    impDoc && impDoc.extra && impDoc.extra.doc_no === 'HT-2026-018', JSON.stringify(impDoc && impDoc.extra));
  ok('导入后图书的作者出版社还在',
    impBook && impBook.extra && impBook.extra.author === 'Randal E. Bryant' &&
      impBook.extra.publisher === '机械工业出版社',
    JSON.stringify(impBook && impBook.extra));
  ok('导入后内部编码还在', impCoded && impCoded.code === v2WithCode.code, impCoded && impCoded.code);
  ok('导入后按内部编码仍能查到', !!(await storeImp2.handle('items.byCode', { code: v2WithCode.code })));
  ok('导入后统计仍按类型拆开',
    (await storeImp2.handle('items.stats')).kinds.doc === (await call('items.stats')).kinds.doc);
  // 落盘是 120ms 防抖的：删临时目录前必须等它写完，否则防抖定时器醒来会打印 ENOENT 噪音
  await new Promise((r) => setTimeout(r, 200));
  try { fs.rmSync(tmpImp2, { recursive: true, force: true }); } catch (e) {}

  // merge 模式（不覆盖已有记录）：新记录要整条进来，同 id 的老记录保持不动。
  // 这是「拿一份旧备份补数据」时最常用的模式，语义反了会把现有数据冲掉。
  const tmpMerge = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-merge-'));
  const storeMerge = createStore(tmpMerge);
  const mergeOld = await storeMerge.handle('items.save', { name: '合并前就有的物品' });
  await storeMerge.handle('app.import', {
    mode: 'merge',
    data: {
      locations: [], categories: [],
      items: [
        {
          id: 'merge-new-doc', name: '合并进来的合同', kind: 'doc', code: 'HS-2026-0500',
          extra: { doc_no: 'HT-MERGE-1' }, updated_at: new Date().toISOString(), deleted: false
        },
        {
          id: mergeOld.id, name: '不该覆盖的名字', kind: 'book',
          updated_at: new Date().toISOString(), deleted: false
        }
      ]
    }
  });
  const mergeList = await storeMerge.handle('items.list', {});
  const mergeNew = mergeList.find((i) => i.id === 'merge-new-doc');
  const mergeKept = mergeList.find((i) => i.id === mergeOld.id);
  ok('merge 导入的新记录带上了 kind', mergeNew && mergeNew.kind === 'doc', JSON.stringify(mergeNew && mergeNew.kind));
  ok('merge 导入的新记录带上了 extra',
    mergeNew && mergeNew.extra && mergeNew.extra.doc_no === 'HT-MERGE-1', JSON.stringify(mergeNew && mergeNew.extra));
  ok('merge 导入的新记录内部编码可用',
    !!(await storeMerge.handle('items.byCode', { code: 'HS-2026-0500' })));
  ok('merge 导入不覆盖已存在的同 id 记录',
    mergeKept && mergeKept.name === '合并前就有的物品' && mergeKept.kind === 'goods',
    JSON.stringify(mergeKept && { n: mergeKept.name, k: mergeKept.kind }));
  await new Promise((r) => setTimeout(r, 200));
  try { fs.rmSync(tmpMerge, { recursive: true, force: true }); } catch (e) {}

  // 老备份文件（schema v1，记录里根本没有 kind/icon/code/extra）导进来不能崩，
  // 导入后还要照常能读能改 —— 用户拿几年前导出的备份恢复是很常见的事。
  // 注意 migrate() 只在新库首次启动时跑，导入老数据不会触发它，
  // 所以这里靠的是 decorateItem / items.save 里的运行时兜底。
  const tmpV1Imp = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-v1imp-'));
  const storeV1Imp = createStore(tmpV1Imp);
  await storeV1Imp.handle('app.import', {
    mode: 'replace',
    data: {
      version: 1, locations: [], categories: [],
      items: [{
        id: 'old-1', name: '老备份里的酱油', barcode: '6901234567892', quantity: 1,
        updated_at: '2024-01-01T00:00:00.000Z', deleted: false
      }]
    }
  });
  const oldImp = (await storeV1Imp.handle('items.list', {})).find((i) => i.id === 'old-1');
  ok('导入 v1 老备份不崩且能列出', !!oldImp, JSON.stringify(oldImp && oldImp.name));
  ok('导入的 v1 老记录按普通物品兜底',
    oldImp && oldImp.kind === 'goods' && typeof oldImp.extra === 'object',
    JSON.stringify(oldImp && { k: oldImp.kind, e: oldImp.extra }));
  const oldSaved = await storeV1Imp.handle('items.save', {
    id: 'old-1', kind: 'doc', extra: { doc_no: 'HT-OLD-1' }
  });
  ok('导入的老记录能正常改成办公资料',
    oldSaved.kind === 'doc' && oldSaved.extra.doc_no === 'HT-OLD-1',
    JSON.stringify({ k: oldSaved.kind, e: oldSaved.extra }));
  await new Promise((r) => setTimeout(r, 200));
  try { fs.rmSync(tmpV1Imp, { recursive: true, force: true }); } catch (e) {}

  // 13) v1 老库升级：没有 kind/icon/code/extra 的记录要被补上默认值
  const tmpV1 = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-v1-'));
  const v1Data = {
    schema: 1,
    locations: [{ id: 'L1', name: '老柜子', parent_id: null, created_at: '2020-01-01T00:00:00.000Z', updated_at: '2020-01-01T00:00:00.000Z', deleted: false }],
    items: [{ id: 'I1', name: '老物品', quantity: 1, created_at: '2020-01-01T00:00:00.000Z', updated_at: '2020-01-01T00:00:00.000Z', deleted: false }],
    categories: [{ id: 'C1', key: '食品', name: '我家改过的食品', color: '#123456', sort: 0, created_at: '2020-01-01T00:00:00.000Z', updated_at: '2020-01-01T00:00:00.000Z', deleted: false }],
    images: [],
    settings: {}
  };
  fs.mkdirSync(path.join(tmpV1, 'data'), { recursive: true });
  fs.writeFileSync(path.join(tmpV1, 'data', 'storage.json'), JSON.stringify(v1Data), 'utf8');
  const storeV1 = createStore(tmpV1);
  const v1Item = await storeV1.handle('items.get', { id: 'I1' });
  ok('v1 老物品升级后有 kind', v1Item.kind === 'goods', 'got ' + v1Item.kind);
  ok('v1 老物品升级后有 icon/code/extra',
    v1Item.icon === '' && v1Item.code === '' && !!v1Item.extra);
  const v1Cats = await storeV1.handle('categories.list');
  ok('升级后补齐了新增分类', v1Cats.length >= 24, 'got ' + v1Cats.length);
  const v1Mine = v1Cats.find((c) => c.key === '食品');
  ok('用户改过的分类名和颜色未被覆盖', v1Mine && v1Mine.name === '我家改过的食品' && v1Mine.color === '#123456',
    v1Mine ? v1Mine.name + '/' + v1Mine.color : 'null');
  ok('升级后 schema 提升到 2', (await storeV1.handle('app.export')).version === 2);

  // 14) 删掉的预置分类不能在下次启动时又冒出来（尊重用户的删除）
  const v1Del = v1Cats.find((c) => c.key === '宠物');
  await storeV1.handle('categories.delete', { id: v1Del.id });
  // 落盘是防抖的（120ms），必须等它写完再重开，否则读到的是删除前的旧文件
  await new Promise((r) => setTimeout(r, 300));
  const storeV1b = createStore(tmpV1);
  const v1Cats2 = await storeV1b.handle('categories.list');
  ok('用户删掉的预置分类不会被重新加回', !v1Cats2.some((c) => c.key === '宠物'));
  try { fs.rmSync(tmpV1, { recursive: true, force: true }); } catch (e) {}

  // 15) 同步合并不能丢新字段（kind / code / extra）
  // 背景：三类记录共用一张 items 表，靠 kind 区分；内部编码存在 code；
  // 办公资料和图书的专属字段存在 extra。服务端把整条记录当 JSONB 存，
  // 客户端 mergeByUpdatedAt 也是整条替换——但这两处都必须有断言锁住，
  // 否则哪天有人加了「只保留已知字段」的裁剪，这些字段会「同步之后静默变空」。
  console.log('\n[15] 同步合并保留新字段');
  const { mergeByUpdatedAt } = require(path.join(__dirname, '..', 'src', 'main', 'sync.js'));
  const remoteDoc = {
    id: 'doc-1', name: '房屋租赁合同', kind: 'doc', code: 'HS-2026-0001',
    category_key: '合同协议', quantity: 1,
    extra: { doc_no: 'HT-2026-018', fiscal_year: '2026' },
    updated_at: '2026-09-13T10:00:00.000Z', deleted: false
  };
  const remoteBook = {
    id: 'book-1', name: '深入理解计算机系统', kind: 'book', barcode: '9787111544937',
    extra: { author: 'Bryant', publisher: '机械工业出版社' },
    updated_at: '2026-09-13T10:00:00.000Z', deleted: false
  };
  const m1 = mergeByUpdatedAt([], [remoteDoc, remoteBook]);
  const docBack = m1.merged.find((x) => x.id === 'doc-1');
  const bookBack = m1.merged.find((x) => x.id === 'book-1');
  ok('合并后资料的 kind 未丢', docBack && docBack.kind === 'doc', JSON.stringify(docBack && docBack.kind));
  ok('合并后资料的内部编码未丢', docBack && docBack.code === 'HS-2026-0001', docBack && docBack.code);
  ok('合并后资料的 extra 整块未丢',
    docBack && docBack.extra && docBack.extra.doc_no === 'HT-2026-018' && docBack.extra.fiscal_year === '2026',
    JSON.stringify(docBack && docBack.extra));
  ok('合并后图书的 kind 与 ISBN 未丢',
    bookBack && bookBack.kind === 'book' && bookBack.barcode === '9787111544937',
    JSON.stringify(bookBack && { k: bookBack.kind, b: bookBack.barcode }));
  ok('合并后图书的作者出版社未丢',
    bookBack && bookBack.extra && bookBack.extra.author === 'Bryant' &&
      bookBack.extra.publisher === '机械工业出版社',
    JSON.stringify(bookBack && bookBack.extra));
  ok('extra 是对象而不是被序列化成字符串',
    docBack && typeof docBack.extra === 'object' && typeof docBack.extra !== 'string',
    typeof (docBack && docBack.extra));

  // 本地是旧版本、远端是新版本 → 远端整条覆盖，本地留一份冲突副本。
  // 冲突副本也要带着 kind/extra，否则用户从副本里再也找不回资料信息。
  const localOld = Object.assign({}, remoteDoc, {
    name: '房屋租赁合同（本地改过）', updated_at: '2026-09-13T09:00:00.000Z'
  });
  const m2 = mergeByUpdatedAt([localOld], [remoteDoc]);
  const winner = m2.merged.find((x) => x.id === 'doc-1');
  const copy = m2.merged.find((x) => /-conflict-/.test(x.id));
  ok('新版本胜出', winner && winner.updated_at === remoteDoc.updated_at, winner && winner.updated_at);
  ok('冲突副本带上了 kind', copy && copy.kind === 'doc', JSON.stringify(copy && copy.kind));
  ok('冲突副本带上了 extra',
    copy && copy.extra && copy.extra.doc_no === 'HT-2026-018', JSON.stringify(copy && copy.extra));
  ok('冲突被报告给上层', m2.conflicts.length === 1 && m2.conflicts[0].id === 'doc-1',
    JSON.stringify(m2.conflicts));

  // 冲突信息要给够界面用的东西。
  // 界面上每条冲突有「打开 / 保留 / 删掉副本」三个动作：不知道这条属于哪张表就
  // 不知道该开哪个编辑器、该调哪个删除接口；不知道副本自己的 id 就删不掉副本。
  // 少任何一项，界面要么静默少一个按钮，要么点了报「不存在」。
  const m3 = mergeByUpdatedAt([localOld], [remoteDoc], 'items');
  const c3 = m3.conflicts[0] || {};
  ok('冲突里带上了 scope（决定开哪个编辑器、调哪个删除接口）',
    c3.scope === 'items', JSON.stringify(c3.scope));
  ok('冲突里带上了 kind（三类共表，界面要显示「图书 / 办公资料」）',
    c3.kind === 'doc', JSON.stringify(c3.kind));
  ok('冲突里带上了副本自己的 id（不是正本的 id）',
    !!c3.conflictId && c3.conflictId !== c3.id && /-conflict-/.test(c3.conflictId),
    JSON.stringify(c3.conflictId));
  ok('冲突里给的副本 id 在合并结果里真的存在（否则「删掉副本」会报不存在）',
    !!m3.merged.find((x) => x.id === c3.conflictId), JSON.stringify(c3.conflictId));
  ok('冲突里带上了两边的修改时间（界面要告诉用户哪份更新）',
    c3.localAt === '2026-09-13T09:00:00.000Z' && c3.remoteAt === remoteDoc.updated_at,
    JSON.stringify({ l: c3.localAt, r: c3.remoteAt }));

  // 本地更新时本机版本直接胜出，不留副本 —— 这时候不该报冲突。
  // 报错了界面就会弹出一份根本不存在的副本，用户点「删掉副本」必然报错。
  const localNew = Object.assign({}, remoteDoc, {
    name: '房屋租赁合同（本机改过）', updated_at: '2026-09-13T11:00:00.000Z'
  });
  const m4 = mergeByUpdatedAt([localNew], [remoteDoc], 'items');
  ok('本机版本更新时不产生副本', !m4.merged.some((x) => /-conflict-/.test(x.id)),
    JSON.stringify(m4.merged.map((x) => x.id)));
  ok('本机版本更新时也不报冲突', m4.conflicts.length === 0, JSON.stringify(m4.conflicts));
  ok('本机版本更新时本机版本胜出',
    m4.merged.find((x) => x.id === 'doc-1').updated_at === localNew.updated_at,
    m4.merged.find((x) => x.id === 'doc-1').updated_at);

  // [15b] sync() 有没有把三张表的 scope 接对
  // mergeByUpdatedAt 本身在 [15] 里测过了，但「哪张表传哪个 scope」是另一回事：
  // 把 items 传成 locations 不会有任何报错，界面会拿物品的冲突去开位置编辑器，
  // 用户点「打开」看到的是一个空表单 —— 只有真的走一遍 sync() 才测得到。
  console.log('\n[15b] sync() 的冲突来源标记');
  const nodeHttp = require('http');
  const { createSync } = require(path.join(__dirname, '..', 'src', 'main', 'sync.js'));

  // 远端固定用「一分钟以后」，保证它一定比刚建好的本地记录新
  const remoteAt = new Date(Date.now() + 60000).toISOString();

  // 先建本地记录拿到真实 id（id 是数据层生成的，不能自己编）
  const tmpSync = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-sync-'));
  const storeSync = createStore(tmpSync);
  const locLocal = await storeSync.handle('locations.save', { name: '厨房' });
  const itmLocal = await storeSync.handle('items.save', { name: '酱油', kind: 'goods' });

  const fakeServer = nodeHttp.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          serverTime: remoteAt,
          pull: {
            locations: [
              { id: locLocal.id, name: '厨房（远端改过）', updated_at: remoteAt, deleted: false }
            ],
            items: [
              {
                id: itmLocal.id, name: '酱油（远端改过）', kind: 'goods',
                updated_at: remoteAt, deleted: false
              }
            ],
            categories: [],
            images: []
          }
        })
      );
    });
  });
  await new Promise((r) => fakeServer.listen(0, '127.0.0.1', r));
  const fakePort = fakeServer.address().port;

  storeSync.raw.settings.syncEnabled = true;
  storeSync.raw.settings.syncToken = 'tok';
  storeSync.raw.settings.syncUrl = 'http://127.0.0.1:' + fakePort;
  storeSync.raw.settings.deviceName = 'test';

  const syncOut = await createSync(storeSync).sync();
  const scopeOf = (s) => syncOut.conflicts.find((c) => c.scope === s);
  const itemCf = scopeOf('items');
  const locCf = scopeOf('locations');
  ok('sync() 报出了两条冲突', syncOut.conflicts.length === 2, JSON.stringify(syncOut.conflicts));
  ok('物品冲突被标成 items（不是 locations）', !!itemCf, JSON.stringify(syncOut.conflicts.map((c) => c.scope)));
  ok('位置冲突被标成 locations（不是 items）', !!locCf, JSON.stringify(syncOut.conflicts.map((c) => c.scope)));
  ok('物品冲突带着 kind，界面才显示得出「普通物品」', itemCf && itemCf.kind === 'goods',
    JSON.stringify(itemCf && itemCf.kind));
  ok('每条冲突的副本都真的落在库里（否则界面点「删掉副本」必报不存在）',
    !!itemCf && storeSync.raw.items.some((x) => x.id === itemCf.conflictId) &&
      !!locCf && storeSync.raw.locations.some((x) => x.id === locCf.conflictId),
    JSON.stringify(syncOut.conflicts.map((c) => c.conflictId)));
  ok('冲突里给的是副本 id，不是正本 id',
    !!itemCf && itemCf.conflictId !== itemCf.id && !!locCf && locCf.conflictId !== locCf.id,
    JSON.stringify(syncOut.conflicts.map((c) => [c.id, c.conflictId])));

  await new Promise((r) => fakeServer.close(r));
  try { fs.rmSync(tmpSync, { recursive: true, force: true }); } catch (e) {}

  // [15c] 冲突的「用副本覆盖正本」
  // 这一步会把 NAS 上那份较新的改动整个盖掉，而且盖完找不回来 —— 用户点的是一次
  // 不可逆的操作。所以内容有没有真换成本机那份、副本有没有收干净、有没有落盘，
  // 都必须自己验，不能靠「界面上看着变了」。
  console.log('\n[15c] 冲突：用副本覆盖正本');
  const mergeForRestore = require(path.join(__dirname, '..', 'src', 'main', 'sync.js')).mergeByUpdatedAt;

  const tmpRes = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-restore-'));
  const storeRes = createStore(tmpRes);
  // 本机那份：名称、备注、extra 全带上，才能证明是「整份覆盖」而不是只改了名字
  const itmRes = await storeRes.handle('items.save', {
    name: '酱油（本机改的）', kind: 'goods', note: '本机加的备注',
    extra: { brand: '本机品牌' }, quantity: 3
  });
  // 远端那份更新（时间戳往后挪一分钟，模拟 NAS 上的版本胜出）
  // extra 里塞一个「只有 NAS 有」的字段：整份覆盖之后它必须消失，
  // 不然「覆盖」就退化成增量合并了（用户的旧字段会赖着不走）
  const remoteWin = {
    id: itmRes.id, name: '酱油（NAS 改的）', kind: 'goods', note: 'NAS 加的备注',
    extra: { brand: 'NAS 品牌', nasOnly: '只存在于 NAS' }, quantity: 9, barcodes: [],
    updated_at: new Date(Date.now() + 60000).toISOString(), deleted: false
  };
  // 快照一份：merge 之后这个对象会变成库里的正本，覆盖动作是就地改写它的，
  // 拿它本身当基准比就变成「自己跟自己比」，永远相等（踩过一次）。
  const remoteAtSnap = remoteWin.updated_at;
  const mRes = mergeForRestore([storeRes.raw.items.find((x) => x.id === itmRes.id)], [remoteWin], 'items');
  const cfRes = mRes.conflicts[0] || {};
  ok('[15c] 冲突里带上了本机那份的原名',
    cfRes.localName === '酱油（本机改的）', JSON.stringify(cfRes.localName));
  const copyRec = mRes.merged.find((x) => x.id === cfRes.conflictId) || {};
  ok('[15c] 副本记录里存着原名（覆盖时靠它还原，不能带「（冲突副本）」后缀）',
    copyRec.conflict_name === '酱油（本机改的）', JSON.stringify(copyRec.conflict_name));

  // 同步结束后库里的样子
  storeRes.raw.items = mRes.merged;
  storeRes.saveNow();

  const restored = await storeRes.handle('conflict.restore', {
    scope: 'items', id: cfRes.id, conflictId: cfRes.conflictId
  });
  ok('[15c] 覆盖动作返回成功', restored && restored.ok === true, JSON.stringify(restored));

  const afterRes = storeRes.raw.items.find((x) => x.id === cfRes.id);
  ok('[15c] 正本换成了本机那份的内容',
    afterRes.name === '酱油（本机改的）' && afterRes.note === '本机加的备注' &&
      afterRes.quantity === 3, JSON.stringify({ n: afterRes.name, note: afterRes.note, q: afterRes.quantity }));
  ok('[15c] 覆盖是整份替换，extra 不会两边混着（NAS 独有的字段必须消失）',
    afterRes.extra && afterRes.extra.brand === '本机品牌' && !('nasOnly' in afterRes.extra),
    JSON.stringify(afterRes.extra));
  ok('[15c] 名字不带「（冲突副本）」后缀（否则下次同步会把这个后缀发给所有设备）',
    afterRes.name.indexOf('冲突副本') < 0, afterRes.name);
  ok('[15c] 覆盖后正本的时间戳严格新于被覆盖的那份（否则下次同步又判一次冲突）',
    afterRes.updated_at > remoteAtSnap, afterRes.updated_at + ' vs ' + remoteAtSnap);
  const copyAfter = storeRes.raw.items.find((x) => x.id === cfRes.conflictId);
  ok('[15c] 副本被软删（不能硬删，删除动作要能同步出去）',
    !!copyAfter && copyAfter.deleted === true, JSON.stringify(copyAfter));
  ok('[15c] 副本被瘦身成墓碑（备注/条码/extra 这些体积大头都没了）',
    !!copyAfter &&
      Object.keys(copyAfter).every((k) => ['id', 'name', 'key', 'updated_at', 'deleted'].indexOf(k) >= 0),
    JSON.stringify(Object.keys(copyAfter || {})));
  ok('[15c] 正本自己没被删', !!afterRes && afterRes.deleted === false);
  ok('[15c] 覆盖没有顺手把别的记录删掉',
    storeRes.raw.items.filter((x) => !x.deleted).length === 1,
    JSON.stringify(storeRes.raw.items.map((x) => [x.id, x.deleted])));

  // 落盘：真关掉重开一次，确认不是只改了内存
  await new Promise((r) => setTimeout(r, 300));
  const storeRes2 = createStore(tmpRes);
  const reopened = storeRes2.raw.items.find((x) => x.id === cfRes.id);
  ok('[15c] 覆盖的结果真的落盘了（重开还是本机那份）',
    !!reopened && reopened.name === '酱油（本机改的）', JSON.stringify(reopened && reopened.name));
  ok('[15c] 副本的删除也落盘了',
    !!storeRes2.raw.items.find((x) => x.id === cfRes.conflictId && x.deleted),
    JSON.stringify(storeRes2.raw.items.map((x) => [x.id, x.deleted])));

  // 覆盖完再同步一次，不该又冒出新的冲突副本（这是用户最直接的「有没有生效」判据）
  // 远端仍用服务器上那个原始时间戳（不能用被就地改写过的 remoteWin）
  const mAgain = mergeForRestore(
    storeRes2.raw.items.filter((x) => !x.deleted),
    [{
      id: itmRes.id, name: '酱油（NAS 改的）', kind: 'goods',
      updated_at: remoteAtSnap, deleted: false
    }],
    'items'
  );
  ok('[15c] 覆盖后紧接着再同步，不会再判出冲突',
    mAgain.conflicts.length === 0, JSON.stringify(mAgain.conflicts));
  ok('[15c] 再同步时胜出的是本机那份（覆盖真的生效了）',
    mAgain.merged.find((x) => x.id === itmRes.id).name === '酱油（本机改的）',
    JSON.stringify(mAgain.merged.find((x) => x.id === itmRes.id).name));

  // 只能拿「副本」来覆盖，不能把这个动作当通用的整条覆盖接口用
  const refuseSelf = await storeRes.handle('conflict.restore', {
    scope: 'items', id: cfRes.id, conflictId: cfRes.id
  }).then(() => '').catch((e) => e.message);
  ok('[15c] 拿正本 id 当副本会被拒（防止误用成通用覆盖接口）',
    /不是冲突副本/.test(refuseSelf), refuseSelf);

  // 副本标记本身就是「这是副本」的凭据：id 命名哪天换了，覆盖不该整体失灵
  // （界面上按钮还在，点下去只得到一句莫名其妙的报错，用户没法自救）
  const alienCopy = {
    id: 'alien-copy-1', name: '酱油（冲突副本）', conflict_name: '酱油（本机改的）',
    kind: 'goods', note: '本机加的备注', extra: {}, barcodes: [],
    updated_at: new Date().toISOString(), deleted: false
  };
  storeRes.raw.items.push(alienCopy);
  const alienOk = await storeRes.handle('conflict.restore', {
    scope: 'items', id: cfRes.id, conflictId: alienCopy.id
  }).then((r) => r.ok === true).catch(() => false);
  ok('[15c] id 命名变了也认得出副本（靠副本标记兜底，不让覆盖整体失灵）',
    alienOk === true, String(alienOk));

  const refuseGone = await storeRes.handle('conflict.restore', {
    scope: 'items', id: cfRes.id, conflictId: cfRes.conflictId
  }).then(() => '').catch((e) => e.message);
  ok('[15c] 副本已经收掉了，再点一次会明确报错（而不是静默成功）',
    /找不到冲突副本/.test(refuseGone), refuseGone);
  const refuseScope = await storeRes.handle('conflict.restore', {
    scope: 'images', id: cfRes.id, conflictId: cfRes.conflictId
  }).then(() => '').catch((e) => e.message);
  ok('[15c] 未知的数据类型会被拒（三张表之外没有可覆盖的东西）',
    /未知的数据类型/.test(refuseScope), refuseScope);

  // 位置与分类也要能用：分类没有编辑器，覆盖是它唯一的「要本机这份」手段
  const locRes = await storeRes.handle('locations.save', { name: '厨房（本机改的）' });
  const locRemote = {
    id: locRes.id, name: '厨房（NAS 改的）', updated_at: new Date(Date.now() + 60000).toISOString(), deleted: false
  };
  const mLoc = mergeForRestore([storeRes.raw.locations.find((x) => x.id === locRes.id)], [locRemote], 'locations');
  storeRes.raw.locations = storeRes.raw.locations
    .filter((x) => x.id !== locRes.id)
    .concat(mLoc.merged);
  const rLoc = await storeRes.handle('conflict.restore', {
    scope: 'locations', id: mLoc.conflicts[0].id, conflictId: mLoc.conflicts[0].conflictId
  });
  ok('[15c] 位置也能用副本覆盖',
    rLoc.ok && storeRes.raw.locations.find((x) => x.id === locRes.id).name === '厨房（本机改的）',
    JSON.stringify(storeRes.raw.locations.find((x) => x.id === locRes.id)));

  const catRes = storeRes.raw.categories.find((c) => !c.deleted);
  const catRemote = {
    id: catRes.id, key: catRes.key, name: 'NAS 改的分类名', color: '#000000',
    updated_at: new Date(Date.now() + 60000).toISOString(), deleted: false
  };
  const mCat = mergeForRestore([Object.assign({}, catRes)], [catRemote], 'categories');
  storeRes.raw.categories = storeRes.raw.categories
    .filter((x) => x.id !== catRes.id)
    .concat(mCat.merged);
  const rCat = await storeRes.handle('conflict.restore', {
    scope: 'categories', id: mCat.conflicts[0].id, conflictId: mCat.conflicts[0].conflictId
  });
  const catNow = storeRes.raw.categories.find((x) => x.id === catRes.id);
  ok('[15c] 分类也能用副本覆盖（分类没有编辑器，这是它唯一的挽回手段）',
    rCat.ok && catNow.name === catRes.name && catNow.color === catRes.color,
    JSON.stringify({ want: catRes.name, got: catNow.name }));

  // 图片：正本原来那张图被换掉后，要是没人再引用，文件必须跟着删
  // 场景：本机那份把照片删了（image_id 置空）却改了名字，NAS 那份还带着照片。
  // 用本机这份覆盖之后，NAS 那张图就没人引用了 —— 全图一张好几 MB，
  // 留着就是纯占地方，而用户永远看不到它。
  const itmImg = await storeRes.handle('items.save', { name: '带图的物品' });
  await storeRes.handle('images.save', {
    item_id: itmImg.id, full: 'data:image/png;base64,AAA', thumb: 'data:image/png;base64,TTT'
  });
  const imgOldId = storeRes.raw.items.find((x) => x.id === itmImg.id).image_id;
  const imgDirRes = path.join(path.dirname(storeRes.dataFile), 'images');
  const imgFile = path.join(imgDirRes, imgOldId + '.txt');
  ok('[15c] 全图落成了独立文件（下面要验它会被清掉）', fs.existsSync(imgFile), imgFile);

  const localNoImg = Object.assign({}, storeRes.raw.items.find((x) => x.id === itmImg.id), {
    name: '带图的物品（本机改的）', image_id: null
  });
  const remoteWithImg = Object.assign({}, storeRes.raw.items.find((x) => x.id === itmImg.id), {
    name: '带图的物品（NAS 改的）',
    updated_at: new Date(Date.now() + 60000).toISOString()
  });
  const mImg = mergeForRestore([localNoImg], [remoteWithImg], 'items');
  storeRes.raw.items = storeRes.raw.items
    .filter((x) => x.id !== itmImg.id)
    .concat(mImg.merged);
  ok('[15c] 覆盖前：正本挂的是 NAS 那张图（否则下面那条断言测不到东西）',
    storeRes.raw.items.find((x) => x.id === itmImg.id).image_id === imgOldId,
    JSON.stringify(storeRes.raw.items.find((x) => x.id === itmImg.id).image_id));

  const rImg = await storeRes.handle('conflict.restore', {
    scope: 'items', id: mImg.conflicts[0].id, conflictId: mImg.conflicts[0].conflictId
  });
  ok('[15c] 用副本覆盖时，正本被换掉的那张图不再被引用',
    rImg.ok && !storeRes.raw.items.find((x) => x.id === itmImg.id).image_id,
    JSON.stringify(storeRes.raw.items.find((x) => x.id === itmImg.id).image_id));
  ok('[15c] 没人引用的那张全图文件被清掉了（不留孤儿占地方）',
    !fs.existsSync(imgFile), imgFile);
  const imgRec = storeRes.raw.images.find((x) => x.id === imgOldId);
  ok('[15c] 图片记录也软删了，删除动作能同步出去',
    !imgRec || imgRec.deleted === true, JSON.stringify(imgRec));

  // 反向：正本换上的图还有别的记录在用，就绝不能删文件
  const itmImg2 = await storeRes.handle('items.save', { name: '共用图的物品' });
  await storeRes.handle('images.save', {
    item_id: itmImg2.id, full: 'data:image/png;base64,BBB', thumb: 'data:image/png;base64,UUU'
  });
  const imgShared = storeRes.raw.items.find((x) => x.id === itmImg2.id).image_id;
  const sharedFile = path.join(imgDirRes, imgShared + '.txt');
  // 造一条「别人也在用这张图」的记录（数据层没有唯一性约束，理论上可能）
  const itmOther = await storeRes.handle('items.save', { name: '另一个也挂着这张图' });
  storeRes.raw.items.find((x) => x.id === itmOther.id).image_id = imgShared;

  const localDrop = Object.assign({}, storeRes.raw.items.find((x) => x.id === itmImg2.id), {
    name: '共用图的物品（本机改的）', image_id: null
  });
  const remoteKeep = Object.assign({}, storeRes.raw.items.find((x) => x.id === itmImg2.id), {
    name: '共用图的物品（NAS 改的）',
    updated_at: new Date(Date.now() + 60000).toISOString()
  });
  const mImg2 = mergeForRestore([localDrop], [remoteKeep], 'items');
  storeRes.raw.items = storeRes.raw.items
    .filter((x) => x.id !== itmImg2.id)
    .concat(mImg2.merged);
  await storeRes.handle('conflict.restore', {
    scope: 'items', id: mImg2.conflicts[0].id, conflictId: mImg2.conflicts[0].conflictId
  });
  ok('[15c] 图还有别人在用时不删文件（宁可留着，也不能删掉别人正在用的图）',
    fs.existsSync(sharedFile), sharedFile);

  try { fs.rmSync(tmpRes, { recursive: true, force: true }); } catch (e) {}

  // 18) 数据文件损坏时的自愈
  // 这是用户丢数据时的最后一道防线，而且整个恢复过程用户看不见（只写进 console），
  // 所以错了也没人会知道 —— 必须有测试。
  console.log('\n[18] 数据文件损坏与恢复');

  // 恢复过程会往 console.error 写日志（用户看不到控制台，但技术支持看得到）。
  // 这里是预期输出，先接管下来免得污染测试日志，顺便断言它确实说清了发生了什么。
  const realConsoleError = console.error;
  const recoverLog = [];
  console.error = (...args) => {
    recoverLog.push(args.map((a) => String(a && a.message ? a.message : a)).join(' '));
  };

  // 场景 A：主文件损坏、备份完好
  const tmpDmg = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-dmg-'));
  const dmgDir = path.join(tmpDmg, 'data');
  const dmgMain = path.join(dmgDir, 'storage.json');
  const dmgBak = dmgMain + '.bak';
  const storeDmg = createStore(tmpDmg);
  await storeDmg.handle('items.save', { name: '第一件重要物品' });
  await new Promise((r) => setTimeout(r, 300));
  await storeDmg.handle('items.save', { name: '第二件重要物品' });
  await new Promise((r) => setTimeout(r, 300));
  ok('每次落盘都会留一份 .bak', fs.existsSync(dmgBak));

  fs.writeFileSync(dmgMain, '{"items":[{"id":"x"', 'utf8');
  const storeDmg2 = createStore(tmpDmg);
  const dmgList = await storeDmg2.handle('items.list');
  ok('主文件损坏时能从备份恢复',
    dmgList.some((i) => i.name === '第一件重要物品'), dmgList.map((i) => i.name).join(','));
  ok('损坏的主文件已被挪走，不再占用原文件名', !fs.existsSync(dmgMain));
  const keptA = fs.readdirSync(dmgDir).filter((f) => /\.corrupt-/.test(f));
  ok('留档文件带 .corrupt- 时间戳，便于人工挽救', keptA.length === 1, keptA.join(','));

  // 恢复之后继续用：好不容易救回来的好备份不能被破坏
  await storeDmg2.handle('items.save', { name: '恢复后新增的物品' });
  await new Promise((r) => setTimeout(r, 300));
  let bakAfter = null;
  try { bakAfter = JSON.parse(fs.readFileSync(dmgBak, 'utf8')); } catch (e) { bakAfter = null; }
  ok('恢复后第一次落盘不会把好备份覆盖成坏文件',
    !!(bakAfter && Array.isArray(bakAfter.items) && bakAfter.items.length >= 1),
    bakAfter ? bakAfter.items.map((i) => i.name).join(',') : '备份已损坏');
  const dmgNow = await storeDmg2.handle('items.list');
  ok('恢复后的改动正常写入主文件',
    dmgNow.some((i) => i.name === '恢复后新增的物品'), dmgNow.map((i) => i.name).join(','));
  // 之后恢复正常：再存一次应当重新生成备份
  await storeDmg2.handle('items.save', { name: '第三件' });
  await new Promise((r) => setTimeout(r, 300));
  ok('恢复正常后备份机制继续工作', fs.existsSync(dmgBak));
  try { fs.rmSync(tmpDmg, { recursive: true, force: true }); } catch (e) {}

  // 场景 B：主文件与备份都损坏 → 两份都要留档，绝不能静默丢弃
  const tmpDmg2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-dmg2-'));
  const dmg2Dir = path.join(tmpDmg2, 'data');
  const dmg2Main = path.join(dmg2Dir, 'storage.json');
  const storeDmgB = createStore(tmpDmg2);
  await storeDmgB.handle('items.save', { name: '孤本数据' });
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(dmg2Main, '坏掉了', 'utf8');
  fs.writeFileSync(dmg2Main + '.bak', '也坏掉了', 'utf8');

  const storeDmgB2 = createStore(tmpDmg2);
  const listB = await storeDmgB2.handle('items.list');
  ok('两份都读不动时不崩，以空库启动',
    Array.isArray(listB) && !listB.some((i) => i.name === '孤本数据'), listB.map((i) => i.name).join(','));
  const keptB = fs.readdirSync(dmg2Dir).filter((f) => /\.corrupt-/.test(f));
  ok('损坏的主文件与备份都被留档（两份都在）', keptB.length === 2, fs.readdirSync(dmg2Dir).join(','));
  // 关键：原始内容必须还在，用户/技术支持还能人工捞数据
  const keptText = keptB.map((f) => fs.readFileSync(path.join(dmg2Dir, f), 'utf8')).join('|');
  ok('留档文件保留了原始内容（没被清空）',
    keptText.includes('坏掉了') && keptText.includes('也坏掉了'), keptText.slice(0, 40));

  // 继续使用不能把留档文件覆盖掉
  await storeDmgB2.handle('items.save', { name: '新库里的东西' });
  await new Promise((r) => setTimeout(r, 300));
  const keptB2 = fs.readdirSync(dmg2Dir).filter((f) => /\.corrupt-/.test(f));
  ok('继续使用不会覆盖留档文件', keptB2.length === 2, fs.readdirSync(dmg2Dir).join(','));
  const keptText2 = keptB2.map((f) => fs.readFileSync(path.join(dmg2Dir, f), 'utf8')).join('|');
  ok('留档文件内容在后续使用中保持不变',
    keptText2.includes('坏掉了') && keptText2.includes('也坏掉了'), keptText2.slice(0, 40));
  try { fs.rmSync(tmpDmg2, { recursive: true, force: true }); } catch (e) {}

  // 场景 C：主文件被误删（同步软件搬走 / 杀软隔离），备份还在。
  // 以前这种情况会直接开空库，备份就晾在那儿没人用 —— 用户以为数据全没了。
  const tmpDmg3 = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-dmg3-'));
  const dmg3Dir = path.join(tmpDmg3, 'data');
  const dmg3Main = path.join(dmg3Dir, 'storage.json');
  const storeDmgC = createStore(tmpDmg3);
  await storeDmgC.handle('items.save', { name: '被误删前的重要数据' });
  await new Promise((r) => setTimeout(r, 300));
  await storeDmgC.handle('items.save', { name: '第二条' });
  await new Promise((r) => setTimeout(r, 300));
  fs.unlinkSync(dmg3Main);
  const storeDmgC2 = createStore(tmpDmg3);
  const listC = await storeDmgC2.handle('items.list');
  ok('主文件被误删时从备份恢复，而不是默默开空库',
    listC.some((i) => i.name === '被误删前的重要数据'), listC.map((i) => i.name).join(','));
  await storeDmgC2.handle('items.save', { name: '恢复后新增' });
  await new Promise((r) => setTimeout(r, 300));
  ok('从备份恢复后主文件被重新建立', fs.existsSync(dmg3Main));
  const listC2 = await storeDmgC2.handle('items.list');
  ok('恢复后的改动正常写回主文件',
    listC2.some((i) => i.name === '恢复后新增'), listC2.map((i) => i.name).join(','));
  try { fs.rmSync(tmpDmg3, { recursive: true, force: true }); } catch (e) {}

  console.error = realConsoleError;
  ok('恢复过程写下了可排查的日志（用户看不到控制台，但技术支持看得到）',
    recoverLog.some((s) => /从备份恢复/.test(s)) && recoverLog.some((s) => /留档/.test(s)),
    recoverLog.join(' ｜ ').slice(0, 160));

  // 19) 图片文件的磁盘生命周期
  // 全图是单独存文件的（一张可能几 MB，手机端还有存储配额），
  // 所以「什么时候删文件」必须有测试 —— 漏删是慢性磁盘泄漏，用户不会立刻发现，
  // 等到手机写不进去的时候已经攒了几百张。
  console.log('\n[19] 图片文件的磁盘生命周期');

  const tmpImg = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-img-'));
  const imgDir = path.join(tmpImg, 'data', 'images');
  const storeImg = createStore(tmpImg);
  const imgItem = await storeImg.handle('items.save', { name: '带照片的物品' });
  await storeImg.handle('images.save', {
    item_id: imgItem.id,
    full: 'data:image/jpeg;base64,AAAA',
    thumb: 'data:image/jpeg;base64,QQ==', w: 100, h: 100
  });
  await new Promise((r) => setTimeout(r, 300));
  ok('保存图片后生成了全图文件', fs.readdirSync(imgDir).length === 1, fs.readdirSync(imgDir).join(','));

  // 删物品 → 它的图片文件要跟着删，否则删得越多、磁盘越满
  await storeImg.handle('items.delete', { id: imgItem.id });
  await new Promise((r) => setTimeout(r, 300));
  ok('删除物品时连带清理图片文件', fs.readdirSync(imgDir).length === 0, fs.readdirSync(imgDir).join(','));

  // 再造一件带图的物品，然后用「另一个库」的备份 replace 导入
  const imgItem2 = await storeImg.handle('items.save', { name: '被替换掉的物品' });
  await storeImg.handle('images.save', {
    item_id: imgItem2.id, full: 'data:image/jpeg;base64,AAAA',
    thumb: 'data:image/jpeg;base64,QQ==', w: 100, h: 100
  });
  await new Promise((r) => setTimeout(r, 300));

  const tmpImg2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-img2-'));
  const storeImg2 = createStore(tmpImg2);
  const imgItem3 = await storeImg2.handle('items.save', { name: '导入进来的物品' });
  await storeImg2.handle('images.save', {
    item_id: imgItem3.id, full: 'data:image/jpeg;base64,BBBB',
    thumb: 'data:image/jpeg;base64,gg==', w: 50, h: 50
  });
  await new Promise((r) => setTimeout(r, 300));
  const imgBackup = await storeImg2.handle('app.export');

  await storeImg.handle('app.import', { data: imgBackup, mode: 'replace' });
  await new Promise((r) => setTimeout(r, 300));
  const filesAfter = fs.readdirSync(imgDir);
  const dbImages = (await storeImg.handle('app.export')).images;
  ok('replace 导入后不留旧图片孤儿文件', filesAfter.length === dbImages.length,
    `文件 [${filesAfter.join(',')}] ｜ 记录 [${dbImages.map((x) => x.id).join(',')}]`);
  ok('导入进来的图片文件没被误删',
    dbImages.every((x) => filesAfter.indexOf(x.id + '.txt') >= 0), filesAfter.join(','));
  ok('导入进来的图片能读回全图',
    (await storeImg.handle('images.data', { id: dbImages[0].id })).full === 'data:image/jpeg;base64,BBBB');
  try { fs.rmSync(tmpImg, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(tmpImg2, { recursive: true, force: true }); } catch (e) {}

  /* ---------------------------------------------------------------------
   * 图片写盘失败必须让上层知道
   *
   * 为什么单列一段：全图在独立文件里、缩略图在 db 里，两者是分开写的。
   * 如果文件没写进去、db 里却记了一条，界面会显示缩略图、点开大图却是空白，
   * 而保存动作照样提示「已添加」—— 用户以为照片存上了，其实没有。
   * 手机的 localStorage 只有 5MB，一张照片就可能写满，这不是理论问题。
   * ------------------------------------------------------------------- */
  console.log('\n[20] 图片写盘失败必须让上层知道');

  // 写失败会往 console.error 写日志，是预期输出，先接管下来免得污染测试日志，
  // 顺便断言它确实留下了可排查的线索。
  const realConsoleError2 = console.error;
  const imgFailLog = [];
  console.error = (...args) => {
    imgFailLog.push(args.map((a) => String(a && a.message ? a.message : a)).join(' '));
  };

  // 让所有写到 images 目录的操作失败，模拟磁盘满 / 手机存储写满
  const breakImageWrites = () => {
    const real = fs.writeFileSync;
    fs.writeFileSync = function (p, ...rest) {
      if (String(p).indexOf('images') >= 0) {
        const e = new Error('ENOSPC: no space left on device');
        e.code = 'ENOSPC';
        throw e;
      }
      return real.call(fs, p, ...rest);
    };
    return () => {
      fs.writeFileSync = real;
    };
  };

  const tmpImg3 = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-imgfail-'));
  const storeImg3 = createStore(tmpImg3);
  const failItem = await storeImg3.handle('items.save', { name: '照片存不下的物品' });

  const restore3 = breakImageWrites();
  let saveErr = null;
  try {
    await storeImg3.handle('images.save', {
      item_id: failItem.id,
      full: 'data:image/jpeg;base64,AAAA',
      thumb: 'data:image/jpeg;base64,QQ==', w: 100, h: 100
    });
  } catch (e) {
    saveErr = e;
  }
  restore3();

  ok('图片写盘失败时抛错，而不是假装成功', !!saveErr, saveErr ? '' : 'images.save 正常返回了');
  ok('错误信息告诉用户怎么办', !!saveErr && /导出备份|清理/.test(saveErr.message),
    saveErr ? saveErr.message : '');
  const failAfter = await storeImg3.handle('app.export');
  ok('失败后不留残缺图片记录（否则列表有缩略图、点开空白）',
    failAfter.images.length === 0, '记录数 ' + failAfter.images.length);
  const failItemAfter = (await storeImg3.handle('items.list', {})).find((x) => x.id === failItem.id);
  ok('失败后物品上没有挂 image_id', !failItemAfter.image_id, String(failItemAfter.image_id));
  ok('失败后 has_image 为 false，界面不会显示「有图」', failItemAfter.has_image === false);

  // 已经有图的情况下换图失败，旧图不能跟着丢
  const tmpImg4 = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-imgkeep-'));
  const storeImg4 = createStore(tmpImg4);
  const keepItem = await storeImg4.handle('items.save', { name: '先有图再换图' });
  await storeImg4.handle('images.save', {
    item_id: keepItem.id,
    full: 'data:image/jpeg;base64,OLD',
    thumb: 'data:image/jpeg;base64,T0xE', w: 10, h: 10
  });
  const beforeSwap = (await storeImg4.handle('app.export')).images[0];

  const restore4 = breakImageWrites();
  let swapErr = null;
  try {
    await storeImg4.handle('images.save', {
      item_id: keepItem.id,
      full: 'data:image/jpeg;base64,NEW',
      thumb: 'data:image/jpeg;base64,TkVX', w: 20, h: 20
    });
  } catch (e) {
    swapErr = e;
  }
  restore4();

  ok('换图失败时也抛错', !!swapErr);
  ok('换图失败后旧图仍能读回', (await storeImg4.handle('images.data', { id: beforeSwap.id })).full === 'data:image/jpeg;base64,OLD');
  const afterSwap = (await storeImg4.handle('app.export')).images;
  ok('换图失败后没有多出一条图片记录', afterSwap.length === 1, '记录数 ' + afterSwap.length);
  ok('换图失败后缩略图没被新图覆盖', afterSwap[0].thumb === 'data:image/jpeg;base64,T0xE');

  // 导入备份时图片写不进去：导入结果要报出来，不能只说「导入完成」
  const tmpImg5 = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-imgimp-'));
  const storeImg5 = createStore(tmpImg5);
  const imgImpItem = await storeImg5.handle('items.save', { name: '备份里的物品' });
  await storeImg5.handle('images.save', {
    item_id: imgImpItem.id,
    full: 'data:image/jpeg;base64,BACK',
    thumb: 'data:image/jpeg;base64,QkFD', w: 20, h: 20
  });
  const imgImpBackup = await storeImg5.handle('app.export');

  const tmpImg6 = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-imgimp2-'));
  const storeImg6 = createStore(tmpImg6);
  const restore6 = breakImageWrites();
  const impRes = await storeImg6.handle('app.import', { data: imgImpBackup, mode: 'replace' });
  restore6();
  ok('导入时图片写失败会计数并返回', impRes.imagesFailed === 1, 'imagesFailed=' + impRes.imagesFailed);
  ok('导入结果仍带物品统计（没被新字段挤掉）', impRes.items >= 1, JSON.stringify(impRes).slice(0, 120));

  // 同步拉取图片写不进去：也要报出来，否则「同步完成」和空白图对不上
  const tmpImg7 = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-imgsync-'));
  const storeImg7 = createStore(tmpImg7);
  const restore7 = breakImageWrites();
  const apRes = storeImg7.applyImages([
    {
      id: 'img-sync-fail', item_id: null, thumb: 'data:image/jpeg;base64,QQ==',
      full: 'data:image/jpeg;base64,QUJD', created_at: '2026-09-13T00:00:00.000Z',
      updated_at: '2026-09-13T00:00:00.000Z', deleted: false
    }
  ]);
  restore7();
  ok('applyImages 报告写盘失败张数', apRes.failed === 1 && apRes.changed === true, JSON.stringify(apRes));

  // 等防抖落盘跑完再删目录：saveNow() 是 120ms 防抖，删太早定时器醒来会打印
  // ENOENT 噪音（不影响断言，但污染输出，容易让人以为测试坏了）
  await new Promise((r) => setTimeout(r, 300));
  [tmpImg3, tmpImg4, tmpImg5, tmpImg6, tmpImg7].forEach((d) => {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
  });

  console.error = realConsoleError2;
  ok('图片写失败时留下了可排查的日志', imgFailLog.some((s) => /图片写入失败/.test(s)),
    imgFailLog.length + ' 条日志');

  /* ---------------------------------------------------------------------
   * 删除要真的能腾出空间（墓碑瘦身）
   *
   * 为什么单列一段：删除是软删除 —— 同步要靠「deleted:true 的记录」
   * 把删除动作带给其他设备，硬删的话对方永远不知道要删。
   * 但整条留着的话数据文件永远缩不回去：用户按「存储空间不足」的提示
   * 去删记录，会发现空间几乎没释放（实测删 200 条只少了 0.2%，
   * 本质上只是把 "deleted":false 改成了 "deleted":true）。
   * ------------------------------------------------------------------- */
  console.log('\n[21] 删除要真的腾出空间（墓碑瘦身）');

  const tmpTomb = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-tomb-'));
  const storeTomb = createStore(tmpTomb);
  const tombFile = path.join(tmpTomb, 'data', 'storage.json');

  // 造一批带大字段的记录（备注 / 条码 / 标签都是体积大头）
  const tombIds = [];
  for (let i = 0; i < 60; i++) {
    const it = await storeTomb.handle('items.save', {
      name: '待删物品' + i,
      note: '用来撑体积的备注内容'.repeat(6),
      barcode: '6900000' + String(200000 + i),
      tags: ['甲', '乙', '丙']
    });
    tombIds.push(it.id);
  }
  await new Promise((r) => setTimeout(r, 300));
  const tombSizeBefore = fs.statSync(tombFile).size;

  await storeTomb.handle('items.delete', { ids: tombIds });
  await new Promise((r) => setTimeout(r, 300));
  const tombSizeAfter = fs.statSync(tombFile).size;

  ok('删除后数据文件明显变小（不是只改了个 deleted 标志）',
    tombSizeAfter < tombSizeBefore * 0.5,
    `${tombSizeBefore} → ${tombSizeAfter} 字节（释放 ${(((tombSizeBefore - tombSizeAfter) / tombSizeBefore) * 100).toFixed(0)}%）`);

  const tombExport = await storeTomb.handle('app.export');
  const tombRec = tombExport.items.find((x) => x.id === tombIds[0]);
  ok('墓碑仍然在（同步要靠它把删除动作带给其他设备）', !!tombRec && tombRec.deleted === true);
  ok('墓碑只留 id/name/key/updated_at/deleted',
    !!tombRec &&
      Object.keys(tombRec).every((k) => ['id', 'name', 'key', 'updated_at', 'deleted'].indexOf(k) >= 0),
    tombRec ? Object.keys(tombRec).join(',') : '');
  ok('墓碑留住了名字（导出备份时能看出删了什么）',
    !!tombRec && tombRec.name === '待删物品0', tombRec && tombRec.name);
  ok('墓碑不再带备注/条码/标签（这些是体积大头）',
    !!tombRec && !tombRec.note && !tombRec.barcode && !tombRec.tags);

  // 分类墓碑必须留着 key：升级时靠它判断「这个预置分类用户已经删过了」，
  // key 一丢，用户删掉的预置分类就会在下次升级时自己长回来。
  const tombCats = await storeTomb.handle('categories.list');
  const victimCat = tombCats.find((c) => c.key === '食品');
  await storeTomb.handle('categories.delete', { id: victimCat.id });
  const catTomb = (await storeTomb.handle('app.export')).categories.find((x) => x.id === victimCat.id);
  ok('分类墓碑保留了 key', !!catTomb && catTomb.key === '食品', catTomb ? JSON.stringify(catTomb) : '');
  ok('分类墓碑被瘦身（颜色/排序等已清掉）', !!catTomb && catTomb.color === undefined);

  // 墓碑在同步里的语义不能变
  const mergeTomb = require(path.join(__dirname, '..', 'src', 'main', 'sync.js')).mergeByUpdatedAt;
  const tombMerge = mergeTomb([], [
    { id: 'x1', name: '远端删的', updated_at: '2026-09-15T00:00:00.000Z', deleted: true }
  ]);
  ok('墓碑能被合并进来，仍是已删除状态',
    tombMerge.merged.length === 1 && tombMerge.merged[0].deleted === true,
    JSON.stringify(tombMerge.merged));

  // 落盘时的兜底：从服务端拉回来的「完整版」墓碑也要被清掉
  const tmpFlush = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-flushtomb-'));
  const storeFlush = createStore(tmpFlush);
  await storeFlush.handle('items.save', { name: '活着的物品' });
  storeFlush.applyImages([
    {
      id: 'img-old-tomb', item_id: null, thumb: '', w: 0, h: 0,
      created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', deleted: true
    }
  ]);
  await new Promise((r) => setTimeout(r, 300));
  const imgTomb = (await storeFlush.handle('app.export')).images.find((x) => x.id === 'img-old-tomb');
  ok('同步拉来的完整版墓碑，落盘时也被瘦身',
    !!imgTomb && Object.keys(imgTomb).length <= 5,
    imgTomb ? Object.keys(imgTomb).join(',') : '');

  // 老库（升级上来的）里的完整版墓碑，启动时清一次
  const tmpOldTomb = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-oldtomb-'));
  const oldTombFile = path.join(tmpOldTomb, 'data', 'storage.json');
  fs.mkdirSync(path.dirname(oldTombFile), { recursive: true });
  fs.writeFileSync(
    oldTombFile,
    JSON.stringify({
      schema: 2,
      locations: [],
      categories: [],
      images: [],
      settings: {},
      items: [
        {
          id: 'old-tomb-1', name: '老的墓碑', note: '一大段没用的备注'.repeat(10),
          barcodes: ['6900000000001'], kind: 'goods', extra: {},
          created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
          deleted: true
        },
        {
          id: 'live-1', name: '还活着的', note: '这段不能被清', kind: 'goods', extra: {},
          created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
          deleted: false
        }
      ]
    }),
    'utf8'
  );
  const storeOldTomb = createStore(tmpOldTomb);
  await new Promise((r) => setTimeout(r, 300));
  const oldExp = await storeOldTomb.handle('app.export');
  const oldTomb = oldExp.items.find((x) => x.id === 'old-tomb-1');
  const liveRec = oldExp.items.find((x) => x.id === 'live-1');
  ok('启动时清掉了老墓碑的冗余字段', !!oldTomb && oldTomb.note === undefined && oldTomb.barcodes === undefined);
  ok('老墓碑的名字保留着', !!oldTomb && oldTomb.name === '老的墓碑', oldTomb && oldTomb.name);
  ok('活着的记录一点没动',
    !!liveRec && liveRec.note === '这段不能被清' && liveRec.deleted === false,
    liveRec ? JSON.stringify(liveRec).slice(0, 80) : '');
  ok('清理只针对墓碑（活记录字段完整）', !!liveRec && liveRec.kind === 'goods' && !!liveRec.extra);

  [tmpTomb, tmpFlush, tmpOldTomb].forEach((d) => {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {}
  });

  console.log('\n[22] 设置项：新增字段要能读能写，老库升级要自动补上');
  const setRes = await store.handle('app.settings.get');
  ok('新库带扫码枪前缀字段（默认关闭）', setRes.scannerPrefix === '',
    JSON.stringify(setRes.scannerPrefix));
  ok('临期天数默认 7 天', setRes.expiryWarnDays === 7, String(setRes.expiryWarnDays));

  await store.handle('app.settings.set', { scannerPrefix: '$' });
  const setAfter = await store.handle('app.settings.get');
  ok('能存进扫码枪前缀', setAfter.scannerPrefix === '$', JSON.stringify(setAfter.scannerPrefix));
  ok('改一个设置不会把别的冲掉（整份覆盖是陷阱）',
    setAfter.expiryWarnDays === 7 && setAfter.syncEnabled === false,
    JSON.stringify(setAfter));

  await new Promise((r) => setTimeout(r, 300));
  const storeReopen = createStore(tmp);
  const setReopen = await storeReopen.handle('app.settings.get');
  ok('重开之后前缀还在（真的落了盘）', setReopen.scannerPrefix === '$',
    JSON.stringify(setReopen.scannerPrefix));

  await store.handle('app.settings.set', { scannerPrefix: '' });
  ok('清空前缀能关掉（那个字符要还回给用户）',
    (await store.handle('app.settings.get')).scannerPrefix === '', '');

  // 老版本的库文件里根本没有 scannerPrefix 这个键。升级后必须自动补上默认值，
  // 否则渲染层读到 undefined，扫码枪识别器会拿它当「没配」——
  // 看起来像「设置页里填了却不生效」。
  const tmpOldSet = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-oldset-'));
  const oldSetDir = path.join(tmpOldSet, 'data');
  fs.mkdirSync(oldSetDir, { recursive: true });
  const oldSetMain = path.join(oldSetDir, 'storage.json');
  // 照着一个老版本（schema 2、没有 scannerPrefix）的库文件写
  fs.writeFileSync(oldSetMain, JSON.stringify({
    schema: 2,
    locations: [{ id: 'l1', name: '客厅', parent_id: '', updated_at: '2026-01-01T00:00:00.000Z' }],
    items: [{ id: 'i1', name: '老物品', updated_at: '2026-01-01T00:00:00.000Z' }],
    categories: [],
    images: [],
    settings: { expiryWarnDays: 15, syncEnabled: false, syncUrl: '', syncToken: '', syncUser: '', deviceName: '', lastSyncAt: '' },
    meta: { createdAt: '2026-01-01T00:00:00.000Z' }
  }), 'utf8');
  const storeOldSet = createStore(tmpOldSet);
  const oldSetNow = await storeOldSet.handle('app.settings.get');
  ok('老库升级后自动补上扫码枪前缀字段', oldSetNow.scannerPrefix === '',
    JSON.stringify(oldSetNow.scannerPrefix));
  ok('补默认值不会冲掉用户原来的设置', oldSetNow.expiryWarnDays === 15,
    String(oldSetNow.expiryWarnDays));
  ok('老库的数据也还在', (await storeOldSet.handle('items.list')).some((i) => i.name === '老物品'), '');
  try { fs.rmSync(tmpOldSet, { recursive: true, force: true }); } catch (e) {}

  /* ---- [23] 分类的增改、物品的批量归位 ----
   *
   * 这两个 action 目前在界面里没有入口（分类只用来筛选，改物品位置走的是 items.save），
   * 但它们是 store 的公开接口：渲染层能 window.api.call 直接调，桌面端还要过 IPC。
   * 一条测试都不盯的话，以后真接上界面时踩了坑都不知道 —— 而且 store 是唯一数据入口，
   * 「没人调」不等于「可以坏」。
   */
  console.log('\n[23] 分类增改与物品批量归位');

  // 新建分类：名字要 trim、颜色要存住、list 里查得到
  const newCat = await call('categories.save', { name: '  露营装备  ', color: '#3b7dbf' });
  ok('categories.save 能新建分类', !!newCat && !!newCat.id, JSON.stringify(newCat));
  ok('新建的分类名会去掉首尾空格', newCat.name === '露营装备', JSON.stringify(newCat.name));
  ok('新建的分类颜色存住了', newCat.color === '#3b7dbf', JSON.stringify(newCat.color));
  ok('新建的分类能在 categories.list 里查到',
    (await call('categories.list')).some((c) => c.id === newCat.id), '');

  // 改名：只传 name，不能把 color 冲掉
  const renamed = await call('categories.save', { id: newCat.id, name: '露营与户外' });
  ok('categories.save 能改分类名', renamed.name === '露营与户外', JSON.stringify(renamed.name));
  ok('只改名不会冲掉原来的颜色', renamed.color === '#3b7dbf', JSON.stringify(renamed.color));
  ok('改名后 list 里读到的是新名字',
    (await call('categories.list')).some((c) => c.id === newCat.id && c.name === '露营与户外'), '');
  // 新建分支和改名分支各有一处 trim，两处都得盯 —— 变异验证时发现
  // 只测新建分支的话，改名的 trim 被删掉是测不出来的。
  const renamedTrim = await call('categories.save', { id: newCat.id, name: '  露营与户外  ' });
  ok('改分类名也会去掉首尾空格', renamedTrim.name === '露营与户外', JSON.stringify(renamedTrim.name));

  // 改不存在的分类必须报错，不能悄悄新建一条
  let catErr = '';
  try { await call('categories.save', { id: 'no-such-cat', name: '幽灵分类' }); } catch (e) { catErr = e.message; }
  ok('categories.save 改不存在的分类会报错', /不存在/.test(catErr), catErr || '(居然没报错)');
  ok('报错时没有偷偷多出一条',
    (await call('categories.list')).filter((c) => c.name === '幽灵分类').length === 0, '');

  // 批量归位
  const boxA = await call('locations.save', { name: '露营箱A', parent_id: null });
  const boxB = await call('locations.save', { name: '露营箱B', parent_id: null });
  const tent = await call('items.save', { name: '帐篷', location_id: boxA.id });
  const chair = await call('items.save', { name: '折叠椅', location_id: boxA.id });
  const bag = await call('items.save', { name: '睡袋', location_id: boxA.id });

  const moved = await call('items.move', { ids: [tent.id, chair.id, bag.id], location_id: boxB.id });
  ok('items.move 批量归位返回成功', !!moved && moved.ok === true, JSON.stringify(moved));
  ok('items.move 返回真实移动条数', moved.count === 3, String(moved && moved.count));
  ok('三件都真的挪到了新位置',
    (await call('items.list', { location_id: boxB.id })).length === 3,
    String((await call('items.list', { location_id: boxB.id })).length));
  ok('旧位置已经空了',
    (await call('items.list', { location_id: boxA.id })).length === 0, '');

  // 单条移动（不传数组）+ 移到 null 等于取消位置
  const single = await call('items.move', { id: bag.id, location_id: null });
  ok('items.move 支持单条（不传数组）', single.count === 1, String(single.count));
  ok('移到 null 等于取消位置', !(await call('items.get', { id: bag.id })).location_id,
    JSON.stringify((await call('items.get', { id: bag.id })).location_id));

  // 不存在的 id 要跳过，不能算进 count 里充数
  const ghostMove = await call('items.move', { ids: ['no-such-item', tent.id], location_id: boxA.id });
  ok('items.move 跳过不存在的 id（count 只算真挪动的）', ghostMove.count === 1, String(ghostMove.count));
  ok('真挪动的那件确实回去了',
    (await call('items.get', { id: tent.id })).location_id === boxA.id, '');

  console.log('\n========================================');
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log('========================================\n');

  try { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(tmp2, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
