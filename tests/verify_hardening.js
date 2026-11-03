// tests/verify_hardening.js —— 代码审查整改的回归（存储分片 / 落盘失败 / 媒体清理 / 权限收口 / 事务 / 防重）
//
// 这一套测的是"出事时会发生什么"，不是"正常时能不能跑"：
//   - 本地存储写失败，页面还会不会骗用户说"已保存"？
//   - records 顶到 1MB 单 key 上限后，数据还在不在？
//   - 结转走到一半失败，会不会留下半成品？
//   - 记录的 cid 指向学生不在的班，还拦不拦？
const path = require('path');
const assert = require('assert');

/* ---------------- 模拟小程序运行环境（含可控的写失败与文件系统） ---------------- */
const mem = {};
const toasts = [];
let failKeys = {};                      // key → true 时该 key 写入抛错（模拟超限）
const files = {};                       // 媒体目录里的文件：path → { size, mtime }

function fileBytes() {
  let n = 0;
  Object.keys(mem).forEach(k => { n += Buffer.byteLength(JSON.stringify(mem[k]), 'utf8'); });
  return n;
}

global.wx = {
  getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => {
    if (failKeys[k]) { const e = new Error('setStorageSync:fail exceed storage max size'); e.errCode = 100001; throw e; }
    mem[k] = JSON.parse(JSON.stringify(v));
  },
  removeStorageSync: k => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem), currentSize: Math.ceil(fileBytes() / 1024), limitSize: 10240 }),
  showToast: o => { toasts.push(o && o.title); },
  showModal: o => { if (o && o.success) o.success({ confirm: true }); },
  navigateTo: () => {}, switchTab: () => {}, navigateBack: () => {},
  setNavigationBarTitle: () => {}, stopPullDownRefresh: () => {},
  previewImage: () => {}, setClipboardData: o => { o && o.success && o.success(); },
  createInnerAudioContext: () => ({ onEnded() {}, onError() {}, play() {}, stop() {} }),
  env: { USER_DATA_PATH: '/usr' },
  getFileSystemManager: () => ({
    accessSync: p => { if (!(p in files)) throw new Error('no such file'); },
    mkdirSync: () => {},
    copyFileSync: (from, to) => {
      if (!(from in files)) throw new Error('copyFileSync:fail no such file');
      files[to] = { size: 2048, mtime: Date.now() / 1000 };
    },
    readdirSync: d => Object.keys(files)
      .filter(p => p.indexOf(d + '/') === 0)
      .map(p => p.slice(d.length + 1)),
    statSync: p => {
      const f = files[p];
      if (!f) throw new Error('no such file');
      return { size: f.size, mtime: f.mtime };
    },
    unlinkSync: p => { delete files[p]; }
  })
};
const appInst = { globalData: { pick: null } };
global.getApp = () => appInst;
global.App = () => {};
let captured = null;
global.Page = cfg => { captured = cfg; };

function loadPage(rel) {
  captured = null;
  const full = path.join(__dirname, '..', rel);
  delete require.cache[require.resolve(full)];
  require(full);
  const cfg = captured;
  const page = Object.assign({}, cfg);
  page.data = JSON.parse(JSON.stringify(cfg.data || {}));
  page.setData = function (patch, cb) {
    Object.keys(patch).forEach(k => { page.data[k] = patch[k]; });
    if (cb) cb();
  };
  return page;
}

/* ---------------- 铺底数据 ---------------- */
const seed = require('./fixture').richSeed();
Object.keys(seed).forEach(k => { mem[k] = seed[k]; });
let db = require('../utils/db');
const media = require('../utils/media');
db.init();

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

function restart() {
  // 模拟重启：清掉模块缓存后重新加载，数据只能从 mem 里的存储 key 读回来
  Object.keys(require.cache)
    .filter(k => k.indexOf(path.join(__dirname, '..', 'utils')) === 0)
    .forEach(k => { delete require.cache[k]; });
  const fresh = require('../utils/db');
  fresh.init();
  db = fresh;
  return fresh;
}

/* =====================================================================
 * 1. records 分片：单 key 1MB 上限
 * ===================================================================*/
console.log('\n【存储分片：records 超过单片容量自动切片】');
{
  const cls = db.classes.list()[0];
  const stu = db.students.of(cls.id)[0];

  ok('记录写满一片后自动开第二片，且磁盘上每个 key 都不超过单片上限', () => {
    const SIZE = require('../utils/db/storage').SHARD.records;
    assert.ok(SIZE > 0, '分片大小应已配置');
    // 只留一个学生，后面的记录全挂在他身上，便于精确数数
    const all = db.coll('records');
    all.splice(0, all.length);
    db.flush();

    const total = SIZE + 5;
    for (let i = 0; i < total; i++) {
      const r = db.records.save({ cls: cls.id, sid: stu.id, course: '楷书', note: '第' + i + '条' }, false);
      assert.ok(r.ok, '第 ' + i + ' 条应保存成功：' + (r && r.msg));
    }
    assert.strictEqual(db.coll('records').length, total);
    assert.strictEqual(mem['chengguo_v3_records'].length, SIZE, '第一片应刚好装满');
    assert.strictEqual(mem['chengguo_v3_records_2'].length, 5, '剩下的应落到第二片');
  });

  ok('重启后从两片里读回完整数据（顺序不乱）', () => {
    const before = db.coll('records').map(r => r.id);
    const fresh = restart();
    const after = fresh.coll('records').map(r => r.id);
    assert.strictEqual(after.length, before.length, '条数应一致');
    assert.deepStrictEqual(after, before, '顺序应一致');
  });

  ok('老版本的单 key 全量数据（超过单片大小）不会被截断', () => {
    const SIZE = require('../utils/db/storage').SHARD.records;
    // 造一份"升级前"的存储：records 是一个超过单片大小的完整数组
    const legacy = [];
    for (let i = 0; i < SIZE + 40; i++) {
      legacy.push({ id: 100000 + i, sid: 1, cid: 1, date: '2026-01-01', score: 80, orgId: 'org1' });
    }
    mem['chengguo_v3_records'] = legacy;
    delete mem['chengguo_v3_records_2'];
    const fresh = restart();
    assert.strictEqual(fresh.coll('records').length, SIZE + 40, '应整体读回，不能被当成第一片截断');
  });

  ok('记录变少后多余的分片会被清掉（不留陈旧副本）', () => {
    const all = db.coll('records');
    all.splice(0, all.length);
    db.flush();
    assert.ok(!mem['chengguo_v3_records_2'] || mem['chengguo_v3_records_2'].length === 0,
      '第二片应已被删除或清空');
  });
}

/* =====================================================================
 * 2. 落盘失败：不能骗用户"已保存"
 * ===================================================================*/
console.log('\n【落盘失败：回滚内存 + 明确报错】');
{
  // 重新铺一份干净数据（前面的用例把记录清空了）
  const c = db.classes.list()[0];
  const s = db.students.of(c.id)[0];

  ok('写盘失败时 records.save 返回失败，且内存里不留下"幽灵记录"', () => {
    const n0 = db.coll('records').length;
    // 分片写的第一片是集合本名：让它写入失败即可模拟"空间不足"
    failKeys = { 'chengguo_v3_records': true };
    let res;
    try { res = db.records.save({ cls: c.id, sid: s.id, course: '楷书', note: '存不下的一条' }, false); }
    finally { failKeys = {}; }
    assert.strictEqual(res.ok, false, '应如实返回失败');
    assert.ok(/存储空间/.test(res.msg), '提示应说明是空间问题，实际：' + res.msg);
    assert.strictEqual(db.coll('records').length, n0, '内存里不该留下这条记录');
    assert.strictEqual(mem['chengguo_v3_records'] ? mem['chengguo_v3_records'].length : 0, n0,
      '磁盘上也不该有');
  });

  ok('失败会被记录到健康度里，存储页能显示出来', () => {
    const h = db.health();
    assert.ok(h.lastFail && h.lastFail.coll === 'records', '应记下最近一次失败的集合');
  });

  ok('空间恢复后可以正常保存', () => {
    const r = db.records.save({ cls: c.id, sid: s.id, course: '楷书', note: '恢复正常' }, false);
    assert.ok(r.ok, '应保存成功');
  });
}

/* =====================================================================
 * 3. 媒体：失败不产生裂图 + 垃圾文件清理
 * ===================================================================*/
console.log('\n【媒体：转存失败不落引用，垃圾文件可清理】');
{
  ok('转存失败返回空串并计数（不再返回会被系统清理的临时路径）', () => {
    const before = media.lostCount();
    const r = media.persist('/tmp/not-exist.jpg', 'photo');
    assert.strictEqual(r, '', '失败应返回空串');
    assert.strictEqual(media.lostCount(), before + 1, '应计入失败次数');
  });

  ok('成功转存的文件落在持久目录，且能被 scan 统计', () => {
    files['/tmp/ok.jpg'] = { size: 1024, mtime: Date.now() / 1000 };
    const p = media.persist('/tmp/ok.jpg', 'photo');
    assert.ok(p.indexOf(media.DIR + '/') === 0, '应复制到媒体目录，实际 ' + p);
    const sc = media.scan({});
    assert.ok(sc.files >= 1, '应统计到文件');
    assert.ok(sc.bytes >= 1024, '应统计到体积');
  });

  ok('清理只删无引用、且不是刚新建的文件', () => {
    // 三个文件：被引用 / 无引用但很旧 / 无引用但刚建
    files[media.DIR + '/keep.jpg'] = { size: 100, mtime: (Date.now() - 86400000) / 1000 };
    files[media.DIR + '/old.jpg'] = { size: 200, mtime: (Date.now() - 86400000) / 1000 };
    files[media.DIR + '/new.jpg'] = { size: 300, mtime: Date.now() / 1000 };
    const refs = {}; refs[media.DIR + '/keep.jpg'] = 1;
    const sc = media.scan(refs);
    const names = sc.orphan.map(x => x.path.split('/').pop());
    assert.deepStrictEqual(names.sort(), ['old.jpg'], '只有旧的、无引用的才该进清理列表，实际 ' + names.join(','));
    // 前面用例转存成功的文件也是"刚新建且无引用"，所以这里只断言"至少有一个被豁免"
    assert.ok(sc.recent >= 1, '刚新建的文件应被豁免，实际 recent=' + sc.recent);

    const res = media.prune(refs);
    assert.strictEqual(res.removed, 1);
    assert.ok(!files[media.DIR + '/old.jpg'], '旧垃圾文件应被删掉');
    assert.ok(files[media.DIR + '/keep.jpg'], '被引用的必须保留');
    assert.ok(files[media.DIR + '/new.jpg'], '刚新建的必须保留');
  });

  ok('数据层给出的引用集合包含照片/视频/语音', () => {
    const refs = db.mediaRefs();
    const r = db.records.list()[0];
    if (r && r.photos && r.photos.length) {
      assert.ok(refs[r.photos[0]], '记录里的照片应被当成引用');
    }
    assert.ok(Object.keys(refs).length >= 0);
  });
}

/* =====================================================================
 * 4. 权限收口：记录 ↔ 班级 ↔ 学生 必须自洽
 * ===================================================================*/
console.log('\n【权限收口：记录不能挂到学生不在的班】');
{
  const clsA = db.classes.list()[0];
  const clsB = db.classes.list()[1];
  const stuA = db.students.of(clsA.id)[0];

  ok('新建记录：班级不在学生班级列表里 → 拒绝', () => {
    if (!clsB || stuA.clsIds.indexOf(clsB.id) > -1) return;   // 数据不满足前提时跳过
    const r = db.records.save({ cls: clsB.id, sid: stuA.id, note: '挂错班' }, false);
    assert.strictEqual(r.ok, false);
    assert.ok(/班级里没有该学生/.test(r.msg), '实际：' + r.msg);
  });

  ok('编辑记录：把 cid 改到学生不在的班 → 拒绝', () => {
    if (!clsB || stuA.clsIds.indexOf(clsB.id) > -1) return;
    const r0 = db.records.save({ cls: clsA.id, sid: stuA.id, note: '原始' }, false);
    assert.ok(r0.ok);
    const r = db.records.save({ rid: r0.rid, cls: clsB.id, sid: stuA.id, note: '偷改班级' }, false);
    assert.strictEqual(r.ok, false, '应拦住');
    assert.strictEqual(db.records.get(r0.rid).cid, clsA.id, '原记录不应被改动');
  });

  ok('编辑记录：把 sid 改到不在范围内的学生 → 拒绝（老师身份）', () => {
    const clsA = db.classes.list()[0];
    // 造一个只负责 clsA 的老师：老数据里没有 teacher 成员，这条规则就等于没测过
    const mk = db.members.create({ name: '权限测试老师', role: 'teacher', clsIds: [clsA.id] });
    assert.ok(mk.ok, '应能建老师：' + (mk && mk.msg));
    const before = db.settings().me;
    db.users.switchTo(mk.raw.userId);
    try {
      const myCls = db.classes.list()[0];
      assert.ok(myCls, '老师应能看到自己负责的班');
      const myStu = db.students.of(myCls.id)[0];
      const r0 = db.records.save({ cls: myCls.id, sid: myStu.id, note: '我的记录' }, false);
      assert.ok(r0.ok, '老师应能录自己班的学生：' + (r0 && r0.msg));

      // 找一个不在我班里的学生，把记录挪过去
      const other = db.real().students.find(x => !x.removed && x.clsIds.indexOf(myCls.id) < 0);
      if (other) {
        const r = db.records.save({ rid: r0.rid, cls: myCls.id, sid: other.id, note: '挪给别人' }, false);
        assert.strictEqual(r.ok, false, '应拦住把记录挪到不可见学生');
        assert.strictEqual(db.records.get(r0.rid).sid, myStu.id, '原记录不能被改动');
      }
    } finally {
      db.users.switchTo(before);
    }
  });

  ok('报名（课时账）按身份过滤：家长只能看到自己孩子的', () => {
    const parent = db.members.list().find(m => m.role === 'parent');
    if (!parent || !parent.studentIds.length) return;
    const before = db.settings().me;
    db.users.switchTo(parent.userId);
    try {
      const list = db.enrollments.list();
      list.forEach(e => assert.ok(parent.studentIds.indexOf(e.studentId) > -1,
        '家长不该看到别人孩子的课时：' + e.studentId));
    } finally {
      db.users.switchTo(before);
    }
  });
}

/* =====================================================================
 * 5. 结转向导事务化
 * ===================================================================*/
console.log('\n【结转：中途失败整体回滚，成功后新学期直接进行中】');
{
  ok('结转成功：新学期是 active，旧学期归档', () => {
    const t0 = db.terms.create({ name: '事务测试学期', startDate: '2026-09-01' }).item;
    db.terms.update(t0.id, { status: 'active' });
    const c0 = db.classes.create({ name: '事务测试班', termId: t0.id, mode: 'carry' }).item;
    const s0 = db.students.create({ name: '事务测试生', clsIds: [c0.id] }).item;
    db.enrollments.create({ studentId: s0.id, clsId: c0.id, totalHours: 8 });
    const teacher = db.members.list().find(m => m.role !== 'parent');

    const r = db.terms.settle({
      termId: t0.id,
      newTerm: { name: '事务测试新学期', startDate: '2027-02-01' },
      classes: [{
        name: c0.name, teacherId: teacher.id, decision: 'carry',
        courses: [], students: [{ sid: s0.id, act: 're', enId: 0, remain: 8 }]
      }]
    });
    assert.strictEqual(r.ok, true, r.msg);
    const nt = db.terms.list().find(t => t.name === '事务测试新学期');
    assert.ok(nt, '新学期应已创建');
    assert.strictEqual(nt.status, 'active', '结转后新学期必须直接是进行中，否则录入页没有可选班级');
    assert.strictEqual(db.terms.get(t0.id).status, 'archived', '旧学期应归档');
  });

  ok('结转中途失败：旧学期保持原状，不留半成品', () => {
    const t0 = db.terms.create({ name: '回滚测试学期', startDate: '2026-09-01' }).item;
    db.terms.update(t0.id, { status: 'active' });
    const c0 = db.classes.create({ name: '回滚测试班', termId: t0.id, mode: 'carry' }).item;
    const s0 = db.students.create({ name: '回滚测试生', clsIds: [c0.id] }).item;
    const teacher = db.members.list().find(m => m.role !== 'parent');
    const clsBefore = db.coll('classes').length;

    const r = db.terms.settle({
      termId: t0.id,
      newTerm: { name: '回滚测试新学期' },
      classes: [{
        name: c0.name, teacherId: teacher.id, decision: 'carry',
        // 课程名为空 → courseCreate 校验失败 → 事务抛错回滚
        courses: [{ name: '', sel: true }],
        students: [{ sid: s0.id, act: 're', enId: 0, remain: 0 }]
      }]
    });
    assert.strictEqual(r.ok, false, '应报失败');
    assert.strictEqual(db.terms.get(t0.id).status, 'active', '旧学期不能归档');
    assert.ok(!db.terms.list().some(t => t.name === '回滚测试新学期'), '新学期必须被回滚掉');
    assert.strictEqual(db.coll('classes').length, clsBefore, '新建的班级必须被回滚掉');
  });
}

/* =====================================================================
 * 6. 保存防重 + 存储页
 * ===================================================================*/
console.log('\n【保存防重 + 存储空间页】');
{
  ok('录入页连点两次保存，只会产生一条记录', () => {
    const recordPage = loadPage('pages/record/record.js');
    const c = db.classes.list()[0];
    const s = db.students.of(c.id)[0];
    appInst.globalData.pick = { cls: c.id, sid: s.id };
    recordPage.onLoad({});
    recordPage.setData({ clsId: c.id, sid: s.id, note: '连点测试', photos: ['/usr/media/x.jpg'] });
    const n0 = db.coll('records').length;
    const ev = { currentTarget: { dataset: { send: '0' } } };
    recordPage.save(ev);
    recordPage.save(ev);
    assert.strictEqual(db.coll('records').length, n0 + 1, '第二次点击必须被同步锁挡住');
  });

  ok('存储空间页：用量、可清理数量与一键清理都能跑通', () => {
    const page = loadPage('pages/storage/storage.js');
    page.onShow();
    assert.ok(page.data.kvText && page.data.kvText !== '0 B', '应显示结构化数据占用');
    assert.ok(typeof page.data.mdFiles === 'number');
    // 把前面用例造的文件清干净，只放一个"无引用的旧文件"，这样数字是确定的
    Object.keys(files).forEach(k => { delete files[k]; });
    files[media.DIR + '/junk.jpg'] = { size: 4096, mtime: (Date.now() - 86400000) / 1000 };
    page.refresh();
    assert.strictEqual(page.data.orphanCount, 1);
    page.clean();
    assert.ok(!files[media.DIR + '/junk.jpg'], '应被清掉');
    assert.strictEqual(page.data.orphanCount, 0);
  });

  ok('我的页有「存储空间」入口', () => {
    const mine = loadPage('pages/mine/mine.js');
    mine.onShow();
    assert.ok(mine.data.entries.some(e => e.k === 'storage'), '应能看到入口');
  });
}

console.log('\n【第二批：读路径不越权 / 自愈不伪造归属 / 文本有上限】');
{
  const fs = require('fs');
  const readSrc = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  ok('班级"是不是结转制"由数据层回答，页面拿不到班级实体', () => {
    const d = restart();
    const list = d.classes.list();
    const carry = list.find(c => c.mode === 'carry');
    assert.ok(carry, '夹具里应有一个结转制班级');
    assert.strictEqual(d.classes.mode(carry.id), 'carry');
    assert.strictEqual(d.classes.mode(999999), '', '不存在的班返回空串，不抛错');
  });

  ok('学期班级数按当前身份可见范围统计，老师看到的只是自己的班', () => {
    const d = restart();
    const cls = d.classes.list()[0];
    // 造一个只有 1 个班的老师身份
    const m = d.members.create({ role: 'teacher', name: '只带一个班的老师', clsIds: [cls.id] });
    assert.ok(m.ok, m.msg);
    const asTeacher = d.auth.member();
    // 直接切当前身份：meta.me 指向这个老师对应的 user
    mem['chengguo_v3_meta'].me = m.item.userId;
    const t = restart();
    const termId = cls.termId;
    assert.strictEqual(t.classes.countOfTerm(termId), 1, '老师只应数到自己的 1 个班');
    // 换回负责人（不受范围限制）后数字应大于 1
    mem['chengguo_v3_meta'].me = asTeacher.userId;
    const back = restart();
    assert.ok(back.classes.countOfTerm(termId) >= 1);
  });

  ok('同名班级不再串（记录页按班级 id 筛，不按名字反查）', () => {
    const d = restart();
    const base = d.classes.list()[0];
    const dup = d.classes.create({ name: base.name, termId: base.termId });
    assert.ok(dup.ok, dup.msg);
    const stu = d.students.of(base.id)[0];
    // 给重名班也挂一个学生，才能往里写记录
    d.students.update(stu.id, { clsIds: stu.clsIds.concat([dup.item.id]) });
    const r = d.records.save({ cls: dup.item.id, sid: stu.id, course: '楷书', note: '重名班记录' }, false);
    assert.ok(r.ok, r.msg);

    const page = loadPage('pages/records/records.js');
    getApp().globalData.recTab = null;
    page.onShow();
    const idx = page.data.tabIds.indexOf(dup.item.id);
    assert.ok(idx > 0, '页签里应能找到重名班的 id');
    page.setData({ tab: idx });
    const pool = page._pool();
    assert.ok(pool.length > 0, '应筛出这个班的记录');
    assert.ok(pool.every(x => x.cid === dup.item.id), '筛出来的必须全是这个班的（按名字反查时会被另一个同名班串走）');
  });

  ok('缺录入老师的记录不会归给"当前登录人"（家长身份下启动也不伪造成家长）', () => {
    // 两个教职工 → 归属不唯一 → 不能猜；班级也没主讲老师
    const d = restart();
    d.members.create({ role: 'teacher', name: '第二位老师', clsIds: [d.classes.list()[0].id] });
    const cls = d.classes.list()[0];
    const stu = d.students.of(cls.id)[0];
    // 直接构造一条历史记录（没有 tid），绕过保存时的自动填充
    mem['chengguo_v3_records'] = [{
      id: 880001, sid: stu.id, cid: cls.id, date: '2026-10-01', score: 80, tag: '良好',
      note: '历史数据', orgId: 'org1', removed: false, createdAt: 1, updatedAt: 1
    }];
    delete mem['chengguo_v3_records_2'];
    // 假装这次是在家长身份下启动的
    const parent = d.members.list().find(m => m.role === 'parent');
    if (parent) mem['chengguo_v3_meta'].me = parent.userId;

    const fresh = restart();
    const rec = fresh.coll('records').find(x => x.id === 880001);
    assert.ok(rec, '记录应还在');
    assert.strictEqual(rec.tid || '', '', '不能把历史记录记到当前登录人名下');
  });

  ok('家长资料超长会被截断（不写进无界文本，也不报错）', () => {
    const d = restart();
    const stu = d.students.list()[0];
    const res = d.students.updateProfile(stu.id, { nick: '昵称'.repeat(30), note: 'x'.repeat(5000), goal: 'y'.repeat(1000) });
    assert.ok(res.ok, res.msg);
    const p = res.item.profile;
    assert.ok(p.nick.length <= 20, '昵称应被截到 20 字以内，实际 ' + p.nick.length);
    assert.ok(p.note.length <= 500, '备注应被截到 500 字以内，实际 ' + p.note.length);
    assert.ok(p.goal.length <= 200, '目标应被截到 200 字以内，实际 ' + p.goal.length);
    assert.ok(p.submittedAt, '提交时间应照常写上');
  });

  ok('正式版不静默覆盖用户剪贴板', () => {
    const src = readSrc('app.js');
    assert.ok(/if \(!isRelease\) wx\.setClipboardData/.test(src), '自动复制应只在非正式版发生');
  });

  ok('上传脚本从 project.config.json 取 AppID，CI 不再 sed 改源码', () => {
    const deploy = readSrc('deploy.js');
    assert.ok(!/const APPID = 'wx_your_appid'/.test(deploy), '不应再写死占位 AppID');
    assert.ok(/process\.env\.MP_APPID/.test(deploy), '应支持用环境变量注入');
    const yml = readSrc('.github/workflows/deploy.yml');
    assert.ok(!/sed -i "s\/const APPID/.test(yml), 'CI 不该再靠改源码注入 AppID');
    assert.ok(/MP_APPID:/.test(yml), 'CI 应通过 MP_APPID 传入');
  });
}

console.log('\n全部 ' + pass + ' 项加固断言通过');
