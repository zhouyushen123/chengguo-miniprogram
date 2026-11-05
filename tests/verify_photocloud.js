// verify_photocloud.js —— 照片云端备份编排层守卫
// 守的是纯编排逻辑（上传/检查依赖注入），云存储本体只能在真机验证：
//   1. 只传本地路径，cloud:// 与空槽原样保留
//   2. 上传失败/链路异常 = 保留本地路径（下次再试），绝不丢照片引用
//   3. 内容违规（87014 hit）= 从记录里剔除；检查接口挂了 = 不误删（fail-open）
//   4. 传成功后记录里换成 fileID（走数据层 attachCloud，页面与家长端可直接显示）
//   5. migrateAll：幂等（传完不再进队列）、云未开时跳过
const assert = require('assert');

/* ---------- 模拟 wx 存储 ---------- */
const mem = {};
global.wx = {
  getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete mem[k]; }
};

function freshDb() {
  // 清掉全部 utils 缓存：photocloud/api 等模块顶部持有 db 引用，
  // 不清的话下一个用例拿到的是上一个 db 实例，会读到旧数据
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf('utils') > -1) delete require.cache[k];
  });
  return require('../utils/db');
}

const tests = [];
const t = (name, fn) => tests.push([name, fn]);

// 伪云：upload 依路径回 fileID；check 按 set 放行/拦截/抛错
function makeIo(opts) {
  const o = opts || {};
  return {
    upload: p => {
      if (o.uploadFail) return Promise.resolve(null);
      if (o.uploadThrow) return Promise.reject(new Error('网络炸了'));
      return Promise.resolve('cloud://fake/' + String(p).replace(/.*\//, ''));
    },
    check: fid => {
      if (o.checkThrow) return Promise.reject(new Error('安全接口挂了'));
      const hit = (o.hit || []).some(h => String(fid).indexOf(h) > -1);
      return Promise.resolve(hit ? { ok: false, hit: true } : { ok: true });
    }
  };
}

function setup() {
  for (const k in mem) delete mem[k];   // 每个用例独立库，避免上个用例的记录混进来
  const db = freshDb();
  db.init();
  const cls = db.classes.create({ name: '照片班' }).item;
  const stu = db.students.create({ name: '周诺昭', clsIds: [cls.id] }).item;
  const r = db.records.save({ cls: cls.id, sid: stu.id, score: 90, note: '带图记录', photos: ['/usr/media/a.jpg', '/usr/media/b.jpg', '/usr/media/c.jpg'] }, false);
  assert.ok(r.ok, r.msg);
  return { db, cls, stu, rid: r.rid };
}

t('flushRecord：本地路径全部换 fileID，记录更新', async () => {
  const { db, rid } = setup();
  const out = await require('../utils/photocloud').flushRecord(rid, makeIo());
  assert.strictEqual(out.uploaded, 3);
  assert.strictEqual(out.dropped, 0);
  const r2 = db.records.get(rid);
  assert.ok(r2.photos.every(p => p.indexOf('cloud://') === 0), '三张都应是 cloud:// fileID');
  assert.strictEqual(r2.photos[0], 'cloud://fake/a.jpg');
  assert.strictEqual(r2.score, 90, '其它字段不能被碰');
});

t('flushRecord：cloud:// 与空槽原样保留，只补传本地', async () => {
  const { db, rid } = setup();
  const pc = require('../utils/photocloud');
  db.records.attachCloud(rid, ['cloud://old/x.jpg', '/usr/media/b.jpg', '']);
  const out = await pc.flushRecord(rid, makeIo());
  assert.strictEqual(out.uploaded, 1);
  const r2 = db.records.get(rid);
  assert.strictEqual(r2.photos[0], 'cloud://old/x.jpg');
  assert.strictEqual(r2.photos[1], 'cloud://fake/b.jpg');
  assert.ok(!r2.photos.includes(''), '空槽应被清掉');
});

t('flushRecord：上传失败 = 留本地路径，引用不丢', async () => {
  const { db, rid } = setup();
  const out = await require('../utils/photocloud').flushRecord(rid, makeIo({ uploadFail: true }));
  assert.strictEqual(out.uploaded, 0);
  assert.strictEqual(out.kept, 3);
  const r2 = db.records.get(rid);
  assert.deepStrictEqual(r2.photos, ['/usr/media/a.jpg', '/usr/media/b.jpg', '/usr/media/c.jpg']);
});

t('flushRecord：链路异常 = 留本地（降级不炸）', async () => {
  const { db, rid } = setup();
  const out = await require('../utils/photocloud').flushRecord(rid, makeIo({ uploadThrow: true }));
  assert.strictEqual(out.kept, 3);
  assert.strictEqual(db.records.get(rid).photos.length, 3);
});

t('flushRecord：内容违规照片被剔除，干净的保留', async () => {
  const { db, rid } = setup();
  // b.jpg 传云后 fileID 含 "b.jpg"，命中黑名单
  const out = await require('../utils/photocloud').flushRecord(rid, makeIo({ hit: ['b.jpg'] }));
  assert.strictEqual(out.uploaded, 2);
  assert.strictEqual(out.dropped, 1);
  const r2 = db.records.get(rid);
  assert.strictEqual(r2.photos.length, 2);
  assert.ok(r2.photos.every(p => p.indexOf('b.jpg') === -1));
});

t('flushRecord：检查接口挂了 = 不误删（fail-open）', async () => {
  const { db, rid } = setup();
  const out = await require('../utils/photocloud').flushRecord(rid, makeIo({ checkThrow: true }));
  assert.strictEqual(out.uploaded, 3);
  assert.strictEqual(out.dropped, 0);
  assert.strictEqual(db.records.get(rid).photos.length, 3);
});

t('migrateAll：幂等——传完的记录不再进队列', async () => {
  const { rid } = setup();
  const pc = require('../utils/photocloud');
  const r1 = await pc.migrateAll(makeIo());
  assert.strictEqual(r1.uploaded, 3);
  const r2 = await pc.migrateAll(makeIo());
  assert.strictEqual(r2.uploaded, 0, '第二次应无事可做');
  assert.ok(r2.records === 0 || r2.records === undefined);
  assert.ok(rid); // 引用避免 lint
});

t('migrateAll：云关闭时跳过（测试环境没有 wx.cloud，必须不碰数据）', async () => {
  setup();
  // 不注入 io = 生产路径：api.enabled() 恒 false，直接 skipped
  const out = await require('../utils/photocloud').migrateAll();
  assert.strictEqual(out.skipped, true);
});

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ✓ ' + name); }
    catch (e) { fail++; console.log('  ✗ ' + name + ' —— ' + (e && e.message)); }
  }
  console.log(fail ? ('verify_photocloud: ' + fail + ' FAILED') : ('verify_photocloud: all ' + tests.length + ' passed'));
  process.exit(fail ? 1 : 0);
})();
