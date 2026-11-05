// tests/verify_session.js —— 课次（session）专项验证
//
// 守三件事：
//   1. 节点由老师手动「结清」推进，不由自然日自动切换：
//      同一节课两个老师分两天录，三状态/统计口径都按课次算，跨天不串课。
//   2. 结清 = 发布本次未发布记录 + 课次 +1（一个事务）；不要求全员录完（请假/缺席略过）。
//   3. 补录：录入可显式归入更早的课次；未来课次拒绝；编辑不改课次。
// 外加：v6→v7 迁移（老记录按「同班同一天 = 同一课」补算）与家长无权结清。
const assert = require('assert');
const schema = require('../utils/db/schema');

/* ---------- 模拟 wx 存储 ---------- */
const mem = {};
global.wx = {
  getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete mem[k]; }
};

function freshDb() {
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf('utils\\db') > -1 || k.indexOf('utils/db') > -1) delete require.cache[k];
  });
  return require('../utils/db');
}

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

// 建班 + 建学生 + 录一条记录的快捷路径（owner 身份）
function setup() {
  const db = freshDb();
  db.init();
  const cls = db.classes.create({ name: '测试班' }).item;
  const stu = db.students.create({ name: '周诺昭', clsIds: [cls.id] }).item;
  return { db, cls, stu };
}

/* ================= A. 新装与录入盖课次 ================= */
console.log('\n【A. 录入盖课次】');
let t = setup();
ok('新班级 session 从 1 开始', () => {
  assert.strictEqual(t.cls.session, 1);
});
ok('新建记录自动盖上班级当前课次', () => {
  const r = t.db.records.save({ cls: t.cls.id, sid: t.stu.id, score: 90, note: '好' }, false);
  assert.ok(r.ok, r.msg);
  assert.strictEqual(r.record.session, 1);
});
ok('补录显式传更早课次：合法', () => {
  const r = t.db.records.save({ cls: t.cls.id, sid: t.stu.id, score: 80, session: 1 }, false);
  assert.ok(r.ok, r.msg);
  assert.strictEqual(r.record.session, 1);
});

/* ================= B. 结清 ================= */
console.log('\n【B. 结清本次课】');
t = setup();
t.db.records.save({ cls: t.cls.id, sid: t.stu.id, score: 90 }, false);
ok('结清：发布未发布记录 + 课次 +1', () => {
  const out = t.db.records.settle(t.cls.id);
  assert.ok(out.ok, out.msg);
  assert.strictEqual(out.session, 2);
  assert.strictEqual(out.sent, 1);
  const rec = t.db.records.list()[0];
  assert.strictEqual(rec.sent, true, '记录应已发布');
  assert.strictEqual(rec.session, 1, '记录课次不变');
});
ok('结清后新课次是干净的空白批次', () => {
  const cur = t.db.classes.get(t.cls.id).session;
  const recs = t.db.records.ofClass(t.cls.id).filter(r => r.session === cur);
  assert.strictEqual(recs.length, 0);
});
ok('空课次也能结清（这周没上课直接跳过）', () => {
  const out = t.db.records.settle(t.cls.id);
  assert.ok(out.ok, out.msg);
  assert.strictEqual(out.session, 3);
  assert.strictEqual(out.sent, 0);
});
ok('补录上一课：结清到第 3 课后归入第 2 课合法、第 4 课拒绝', () => {
  const r2 = t.db.records.save({ cls: t.cls.id, sid: t.stu.id, score: 88, session: 2 }, false);
  assert.ok(r2.ok, r2.msg);
  assert.strictEqual(r2.record.session, 2);
  const bad = t.db.records.save({ cls: t.cls.id, sid: t.stu.id, score: 88, session: 4 }, false);
  assert.strictEqual(bad.ok, false, '未来课次必须拒绝');
  assert.ok(/课次/.test(bad.msg));
});

/* ================= C. 三状态按课次算（跨天不串课） ================= */
console.log('\n【C. 跨天录同一课不串课】');
t = setup();
const c1 = t.cls;
t.db.records.save({ cls: c1.id, sid: t.stu.id, score: 90, note: '第一天完成练习', date: '2026-11-04' }, true);  // 第一天录+发
t.db.records.save({ cls: c1.id, sid: t.stu.id, score: 95, note: '第二天巩固', date: '2026-11-05' }, false); // 第二天接着录同一课
ok('同课跨天两条记录同属一个课次', () => {
  const recs = t.db.records.ofClass(c1.id);
  assert.strictEqual(recs.length, 2);
  assert.ok(recs.every(r => r.session === 1), '未结清前都是第 1 课');
});
ok('编辑记录不改课次（结清后改老记录的分数）', () => {
  t.db.records.settle(c1.id);                      // 结清 → 课次 2
  const old = t.db.records.ofClass(c1.id).find(r => r.session === 1);
  const out = t.db.records.save({ rid: old.id, cls: c1.id, sid: t.stu.id, score: 99 }, false);
  assert.ok(out.ok, out.msg);
  assert.strictEqual(out.record.session, 1, '编辑后课次必须还是 1');
  assert.strictEqual(out.record.score, 99);
});

/* ================= D. 权限 ================= */
console.log('\n【D. 结清权限】');
t = setup();
t.db.records.save({ cls: t.cls.id, sid: t.stu.id, score: 90 }, false);
// 切到家长身份：建家长（人+成员一体），再切换当前身份
const pMem = t.db.users.create({ name: '家长甲', role: 'parent', studentIds: [t.stu.id] });
assert.ok(pMem.ok, pMem.msg);
t.db.users.switchTo(pMem.item.userId);
ok('家长不能结清', () => {
  const out = t.db.records.settle(t.cls.id);
  assert.strictEqual(out.ok, false);
});
ok('家长结清也不会改掉课次', () => {
  assert.strictEqual(t.db.classes.get(t.cls.id).session, 1);
});
t.db.users.switchHome();

/* ================= E. v6→v7 迁移：老记录按日期归课次 ================= */
console.log('\n【E. 迁移补算课次】');
ok('老数据按「同班同一天 = 同一课」归组，班级对齐最新一课', () => {
  const stamp = Date.now();
  const classes = [
    schema.normalizeClass({ id: 1, name: '老班' }, 'org1', stamp)
  ];
  const records = [
    schema.normalizeRecord({ id: 1, sid: 1, cid: 1, date: '2026-10-10', score: 80 }, 'org1', stamp),
    schema.normalizeRecord({ id: 2, sid: 2, cid: 1, date: '2026-10-10', score: 85 }, 'org1', stamp),
    schema.normalizeRecord({ id: 3, sid: 1, cid: 1, date: '2026-10-12', score: 90 }, 'org1', stamp),
    schema.normalizeRecord({ id: 4, sid: 1, cid: 1, date: '2026-10-15', score: 95 }, 'org1', stamp)
  ];
  schema.assignRecordSessions(classes, records);
  assert.deepStrictEqual(records.map(r => r.session), [1, 1, 2, 3], '同一天的归同一课');
  assert.strictEqual(classes[0].session, 3, '班级对齐到最新一课');
});
ok('迁移幂等：重跑结果不变', () => {
  const stamp = Date.now();
  const classes = [schema.normalizeClass({ id: 1, name: '老班' }, 'org1', stamp)];
  const records = [
    schema.normalizeRecord({ id: 1, sid: 1, cid: 1, date: '2026-10-10', score: 80 }, 'org1', stamp),
    schema.normalizeRecord({ id: 2, sid: 1, cid: 1, date: '2026-10-12', score: 90 }, 'org1', stamp)
  ];
  schema.assignRecordSessions(classes, records);
  const first = records.map(r => r.session);
  schema.assignRecordSessions(classes, records);
  assert.deepStrictEqual(records.map(r => r.session), first);
  assert.strictEqual(classes[0].session, 2);
});
ok('已有 session 的记录不被重算（混合数据安全）', () => {
  const stamp = Date.now();
  const classes = [schema.normalizeClass({ id: 1, name: '班', session: 2 }, 'org1', stamp)];
  const records = [
    schema.normalizeRecord({ id: 1, sid: 1, cid: 1, date: '2026-10-10', score: 80, session: 1 }, 'org1', stamp),
    schema.normalizeRecord({ id: 2, sid: 1, cid: 1, date: '2026-10-11', score: 90 }, 'org1', stamp)
  ];
  schema.assignRecordSessions(classes, records);
  assert.strictEqual(records[0].session, 1, '已标注的保持原样');
  assert.strictEqual(records[1].session, 2, '未标注的按日期序补算');
});

/* ================= F. 版本号 ================= */
console.log('\n【F. schema 版本】');
ok('schema.VERSION 升到 7', () => {
  assert.strictEqual(schema.VERSION, 7);
});
ok('normalizeClass 的 session 兜底不小于 1', () => {
  const c = schema.normalizeClass({ id: 9, name: 'x', session: 0 }, 'org1', Date.now());
  assert.strictEqual(c.session, 1);
});

console.log('\n全部 ' + pass + ' 项课次断言通过');
if (process.env.EXIT_STRICT) process.exit(0);
