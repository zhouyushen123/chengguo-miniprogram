// tests/verify_photo_batch.js —— 批量录入「统一上传图片 / 照片分拣」专项守卫
//
// 守四件事：
//   1. 照片池：一次选多张、走 media 持久化、上限、删除时清掉所有学生的引用
//   2. 分拣：点照片勾学生 / 点学生勾照片，两个方向都落到同一份 rows[].photos；每人 ≤ 9 张
//   3. 保存：全班共用 / 各自专属 / 请假跳过 / 未分配提示 / 草稿恢复带图
//   4. 上云：照片池按路径去重只传一次，违规图剔除，fileID 回填到全班记录（不是一人传一份）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ---------------- 模拟小程序运行环境 ---------------- */
const mem = {};
const toasts = [];
const modals = [];
let chooseFiles = [];
let chooseCount = -1;
let fileSeq = 0;
global.wx = {
  getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete mem[k]; },
  showToast: o => { toasts.push((o && o.title) || ''); },
  showModal: o => { modals.push(o || {}); if (o && o.success) o.success({ confirm: true, content: '' }); },
  chooseMedia: o => { chooseCount = o && o.count; if (o && o.success) o.success({ tempFiles: chooseFiles }); },
  previewImage: () => {},
  setNavigationBarColor: () => {}, setTabBarStyle: () => {}, setTabBarItem: () => {},
  setBackgroundColor: () => {}, getSystemInfoSync: () => ({}),
  navigateTo: () => {}, navigateBack: () => {}, switchTab: () => {},
  showLoading: () => {}, hideLoading: () => {},
  env: { USER_DATA_PATH: '/tmp' },
  getFileSystemManager: () => ({
    accessSync: () => {}, mkdirSync: () => {},
    copyFileSync: () => { fileSeq++; }, readdirSync: () => [], statSync: () => ({ size: 1 })
  })
};
global.getApp = () => ({ globalData: { pick: null } });
global.App = () => {};
let captured = null;
global.Page = cfg => { captured = cfg; };
function loadPage(rel) {
  captured = null;
  const full = path.join(ROOT, rel);
  delete require.cache[require.resolve(full)];
  require(full);
  const page = Object.assign({}, captured);
  page.data = JSON.parse(JSON.stringify(captured.data || {}));
  page.setData = function (patch, cb) {
    Object.keys(patch).forEach(k => {
      if (k.indexOf('[') > -1 || k.indexOf('.') > -1) {
        // 支持 rows[0].photos / sheetStus[1].on 这类路径
        const parts = k.replace(/\[(\d+)\]/g, '.$1').split('.');
        let o = page.data;
        for (let i = 0; i < parts.length - 1; i++) { if (!o[parts[i]]) o[parts[i]] = {}; o = o[parts[i]]; }
        o[parts[parts.length - 1]] = patch[k];
      } else page.data[k] = patch[k];
    });
    if (cb) cb();
  };
  return page;
}

function freshDb() {
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf('utils') > -1) delete require.cache[k];
  });
  return require('../utils/db');
}
let db = freshDb();
db.init();
const cls = db.classes.create({ name: '照片分拣班' }).item;
const stus = ['周诺昭', '李明', '王小虎'].map(n => db.students.create({ name: n, clsIds: [cls.id] }).item);
const page = loadPage('pages/batch/batch.js');
page.onLoad({ id: String(cls.id) });

const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const fak = n => '/tmp/local/p' + n + '.jpg';
function setFiles(arr) { chooseFiles = arr.map(p => ({ tempFilePath: p, size: 1024, fileType: 'image' })); }
function fakeIo(opts) {
  const o = opts || {};
  return {
    upload: p => {
      if (o.calls) o.calls.push(p);
      if (o.uploadFail) return Promise.resolve(null);
      return Promise.resolve('cloud://fake/' + String(p).replace(/.*\//, ''));
    },
    check: fid => Promise.resolve((o.hit || []).some(h => String(fid).indexOf(h) > -1)
      ? { ok: false, hit: true } : { ok: true })
  };
}
const photocloud = require('../utils/photocloud');

/* ================= A. 照片上云：去重 / 违规 / 降级 ================= */
t('A01 prepare 同一路径只上传一次，返回 map 与去重后的 list', async () => {
  const calls = [];
  const out = await photocloud.prepare(['/a.jpg', '/b.jpg', '/a.jpg'], fakeIo({ calls }));
  assert.strictEqual(calls.length, 2, '重复路径不该重复上传');
  assert.strictEqual(out.uploaded, 2);
  assert.strictEqual(out.list.length, 3);
  assert.strictEqual(out.list[0], 'cloud://fake/a.jpg');
  assert.strictEqual(out.list[2], 'cloud://fake/a.jpg');
});
t('A02 已是 cloud:// 的原样复用，不再上传', async () => {
  const calls = [];
  const out = await photocloud.prepare(['cloud://old.jpg'], fakeIo({ calls }));
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(out.list[0], 'cloud://old.jpg');
});
t('A03 内容违规的照片从结果里剔除（dropped 计数）', async () => {
  const out = await photocloud.prepare(['/bad.jpg', '/ok.jpg'], fakeIo({ hit: ['bad'] }));
  assert.strictEqual(out.dropped, 1);
  assert.deepStrictEqual(out.list, ['cloud://fake/ok.jpg']);
  assert.strictEqual(out.map['/bad.jpg'], '');
});
t('A04 上传失败保留本地路径（首页 migrateAll 会补传）', async () => {
  const out = await photocloud.prepare(['/x.jpg'], fakeIo({ uploadFail: true }));
  assert.strictEqual(out.kept, 1);
  assert.deepStrictEqual(out.list, ['/x.jpg']);
});
t('A05 云未通时不调上传，全部留本地路径', async () => {
  const out = await photocloud.prepare(['/x.jpg']);
  assert.strictEqual(out.kept, 1);
  assert.deepStrictEqual(out.list, ['/x.jpg']);
});
t('A06 flushBatch：全班共用一张图只传一次，fileID 回填到每条记录', async () => {
  const p = '/shared.jpg';
  const r1 = db.records.save({ cls: cls.id, sid: stus[0].id, score: 90, photos: [p] }, false);
  const r2 = db.records.save({ cls: cls.id, sid: stus[1].id, score: 91, photos: [p] }, false);
  assert.ok(r1.ok && r2.ok, (r1.msg || '') + (r2.msg || ''));
  const calls = [];
  const out = await photocloud.flushBatch([
    { rid: r1.rid, photos: [p] }, { rid: r2.rid, photos: [p] }
  ], fakeIo({ calls }));
  assert.strictEqual(calls.length, 1, '两条记录共用一张照片，只应上传 1 次');
  assert.strictEqual(out.changed, 2);
  assert.deepStrictEqual(db.records.get(r1.rid).photos, ['cloud://fake/shared.jpg']);
  assert.deepStrictEqual(db.records.get(r2.rid).photos, ['cloud://fake/shared.jpg']);
});
t('A07 flushBatch 违规图从已落库记录里移除', async () => {
  const r = db.records.save({ cls: cls.id, sid: stus[2].id, score: 88, photos: ['/bad.jpg', '/good.jpg'] }, false);
  assert.ok(r.ok, r.msg);
  await photocloud.flushBatch([{ rid: r.rid, photos: ['/bad.jpg', '/good.jpg'] }], fakeIo({ hit: ['bad'] }));
  assert.deepStrictEqual(db.records.get(r.rid).photos, ['cloud://fake/good.jpg']);
});

/* ================= B. 页面：照片池 ================= */
t('B01 初始状态：空照片池、每行无照片、未分配为 0', () => {
  assert.deepStrictEqual(page.data.photos, []);
  assert.strictEqual(page.data.shared, false);
  assert.strictEqual(page.data.unassigned, 0);
  assert.ok(page.data.rows.length === 3 && page.data.rows.every(r => Array.isArray(r.photos) && !r.photos.length));
  assert.strictEqual(page.data.maxPhotos, 30);
});
t('B02 一次选 3 张：转存为持久路径，角标全部「待分配」', () => {
  setFiles(['wxfile://a.jpg', 'wxfile://b.jpg', 'wxfile://c.jpg']);
  page.addPhotos({ currentTarget: { dataset: { src: 'album' } } });
  assert.strictEqual(page.data.photos.length, 3);
  assert.ok(page.data.photos.every(p => p.indexOf('/tmp/media/photo_') === 0), '必须转存到用户目录，不能留临时路径');
  assert.strictEqual(page.data.photoCells.length, 3);
  assert.ok(page.data.photoCells.every(c => c.n === 0));
  assert.strictEqual(page.data.unassigned, 3);
  assert.strictEqual(chooseCount, 9, '一次最多向微信要 9 张');
});
t('B03 照片池上限 30 张，满后不再增加', () => {
  const full = [];
  for (let i = 0; i < 30; i++) full.push(fak(i));
  page.setData({ photos: full });
  page._syncPhotos();
  setFiles(['wxfile://overflow.jpg']);
  page.addPhotos({ currentTarget: { dataset: { src: 'album' } } });
  assert.strictEqual(page.data.photos.length, 30);
  assert.ok(toasts.some(x => x.indexOf('最多 30 张') > -1));
  // 复位成 3 张，供后续分拣用例使用
  page.setData({ photos: page.data.photos.slice(0, 0) });
  setFiles(['wxfile://a.jpg', 'wxfile://b.jpg', 'wxfile://c.jpg']);
  page.addPhotos({ currentTarget: { dataset: { src: 'album' } } });
  assert.strictEqual(page.data.photos.length, 3);
});
t('B04 删除池里一张：所有学生行里的引用同步清掉', () => {
  const p0 = page.data.photos[0];
  page.setData({ rows: page.data.rows.map(r => Object.assign({}, r, { photos: [p0] })) });
  page._syncPhotos();
  assert.strictEqual(page.data.photoCells[0].n, 3);
  page.rmPoolPhoto({ currentTarget: { dataset: { i: '0' } } });
  assert.strictEqual(page.data.photos.length, 2);
  assert.ok(page.data.rows.every(r => r.photos.indexOf(p0) < 0));
  assert.ok(page.data.photoCells.every(c => c.p !== p0));
});

/* ================= C. 页面：两个方向的分拣 ================= */
t('C01 点照片勾学生：只给勾中的同学带上这张照片', () => {
  page.setData({ rows: page.data.rows.map(r => Object.assign({}, r, { photos: [] })) });
  page._syncPhotos();
  const p = page.data.photos[0];
  page.openPhoto({ currentTarget: { dataset: { i: '0' } } });
  assert.strictEqual(page.data.sheetMode, 'photo');
  assert.strictEqual(page.data.sheetStus.length, 3);
  page.toggleSheetStu({ currentTarget: { dataset: { i: '0' } } });
  page.confirmSheet();
  assert.strictEqual(page.data.sheet, false);
  assert.deepStrictEqual(page.data.rows[0].photos, [p]);
  assert.deepStrictEqual(page.data.rows[1].photos, []);
  assert.strictEqual(page.data.photoCells[0].n, 1);
  assert.strictEqual(page.data.unassigned, 1);
});
t('C02 点学生勾照片：按人挑选，反向也写到同一份 rows[].photos', () => {
  page.openStuPhotos({ currentTarget: { dataset: { i: '1' } } });
  assert.strictEqual(page.data.sheetMode, 'stu');
  assert.strictEqual(page.data.sheetPhotos.length, 2);
  page.toggleSheetPhoto({ currentTarget: { dataset: { i: '1' } } });
  page.confirmSheet();
  assert.deepStrictEqual(page.data.rows[1].photos, [page.data.photos[1]]);
});
t('C03 每人最多 9 张：超了给提示且不写入', () => {
  // 先清掉 C01 分给第一位同学的那张，才能验证「超限时不写入」
  page.setData({ rows: page.data.rows.map(r => Object.assign({}, r, { photos: [] })) });
  const many = [];
  for (let i = 0; i < 10; i++) many.push(fak(100 + i));
  page.setData({ photos: many });
  page._syncPhotos();
  page.openStuPhotos({ currentTarget: { dataset: { i: '0' } } });
  page.data.sheetPhotos.forEach((x, i) => page.toggleSheetPhoto({ currentTarget: { dataset: { i: String(i) } } }));
  page.confirmSheet();
  assert.ok(toasts.some(x => x.indexOf('每人最多 9 张') > -1));
  assert.strictEqual(page.data.sheet, true, '超限时弹层不关，让老师改');
  assert.deepStrictEqual(page.data.rows[0].photos, []);
  page.closeSheet();
  // 复位 3 张
  page.setData({ photos: [] });
  setFiles(['wxfile://a.jpg', 'wxfile://b.jpg', 'wxfile://c.jpg']);
  page.addPhotos({ currentTarget: { dataset: { src: 'album' } } });
  assert.strictEqual(page.data.photos.length, 3, 'C03 复位后照片池应为 3 张，实际 ' + page.data.photos.length);
});
t('C04 全班共用：未分配归零，保存时全员都带照片', () => {
  page.toggleShared();
  assert.strictEqual(page.data.shared, true);
  assert.strictEqual(page.data.unassigned, 0);
});

/* ================= D. 保存 / 草稿 / 源码守卫 ================= */
t('D01 草稿带照片池、分配关系与共用开关', () => {
  const d = wx.getStorageSync('chengguo_batchdraft_v1_' + cls.id);
  assert.ok(d && d.photos && d.photos.length === 3);
  assert.strictEqual(d.shared, true);
  assert.ok(Array.isArray(d.rows) && d.rows.every(r => Array.isArray(r.photos)));
});
t('D02 重进页面恢复草稿，不用重选图重分', () => {
  const p2 = loadPage('pages/batch/batch.js');
  p2.onLoad({ id: String(cls.id) });
  assert.deepStrictEqual(p2.data.photos, page.data.photos);
  assert.strictEqual(p2.data.shared, true);
  assert.deepStrictEqual(p2.data.rows.map(r => r.photos), page.data.rows.map(r => r.photos));
});
t('D03 真落库：按人专属只给对应同学带照片，请假的不落库', () => {
  const before = db.records.ofClass(cls.id).length;
  page.toggleShared();                 // 关掉共用，改为按人专属
  page.setData({ rows: page.data.rows.map((r, i) => Object.assign({}, r, {
    photos: i === 0 ? [page.data.photos[0]] : [], leave: i === 2
  })) });
  page._syncPhotos();
  const kept = page.data.rows.filter(r => !r.leave);
  page._confirmSave(kept);
  const all = db.records.ofClass(cls.id);
  assert.strictEqual(all.length, before + 2, '请假的学生不该生成记录');
  const mine = all.slice(0, 2).sort((a, b) => a.sid - b.sid);
  // 学生行按姓氏拼音排序，不能假设等于创建顺序
  const fst = mine.find(r => r.sid === kept[0].id);
  const snd = mine.find(r => r.sid === kept[1].id);
  assert.ok(fst && snd, 'mine=' + JSON.stringify(mine.map(r => ({ sid: r.sid, photos: r.photos }))) + ' kept=' + kept.map(r => r.id));
  assert.deepStrictEqual(fst.photos, [page.data.photos[0]]);
  assert.deepStrictEqual(snd.photos, []);
  assert.ok(!mine.some(r => r.sid === page.data.rows[2].id), '请假的人不该出现在新记录里');
});
t('D04 保存确认框提示「未分配照片不会进任何记录」', () => {
  page.setData({ rows: page.data.rows.map(r => Object.assign({}, r, { photos: [], leave: false })) });
  page._syncPhotos();
  assert.strictEqual(page.data.unassigned, 3);
  modals.length = 0;
  page._confirmSave(page.data.rows);
  assert.ok(modals.some(m => String(m.content).indexOf('没分给学生') > -1), '老师必须看见未分配提示');
});
t('D05 共用 + 超过 9 张：落库时每人截断到 9 张', () => {
  const many = [];
  for (let i = 0; i < 12; i++) many.push(fak(200 + i));
  page.setData({ photos: many, shared: true });
  page._syncPhotos();
  const before = db.records.ofClass(cls.id).length;
  page._confirmSave(page.data.rows);
  const all = db.records.ofClass(cls.id);
  const added = all.slice(0, all.length - before);
  assert.strictEqual(added.length, 3);
  assert.ok(added.every(r => r.photos.length === 9), '数据层上限 9 张');
  assert.ok(added.every(r => new Set(r.photos).size === 9), '不能有重复路径');
});
t('D06 源码守卫：持久化、上云去重、删除清引用都在链路上', () => {
  const js = read('pages/batch/batch.js');
  const wxml = read('pages/batch/batch.wxml');
  const cloud = read('utils/photocloud.js');
  assert.ok(/media\.persist\(/.test(js), '选图必须转存，不能留临时路径');
  assert.ok(/photocloud\.flushBatch\(/.test(js), '保存后必须后台统一上云');
  assert.ok(/function prepare\(/.test(cloud) && /function flushBatch\(/.test(cloud));
  assert.ok(/pool\.indexOf\(p\) > -1/.test(js), '落库只认池里还在的照片');
  assert.ok(/catchtap="openStuPhotos"/.test(wxml) && /catchtap="openPhoto"/.test(wxml));
  assert.ok(/catchtap="toggleShared"/.test(wxml));
  assert.ok(/class="hint"[^>]*>还有 \{\{unassigned\}\} 张/.test(wxml) || /\{\{unassigned\}\} 张没分给学生/.test(wxml));
});

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + (e && e.message)); }
  }
  console.log(fail ? ('verify_photo_batch: ' + fail + ' FAILED') : ('verify_photo_batch: all ' + tests.length + ' passed'));
  process.exit(fail ? 1 : 0);
})();
