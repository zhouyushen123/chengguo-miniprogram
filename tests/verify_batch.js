// tests/verify_batch.js —— 成绩单批量录入专项验证
//
// 守四件事：
//   1. db.records.batch：一个事务批量落库，一次写盘；逐条过权限/课次/消课（复用单条口径）
//   2. 请假跳过：部分失败的行只记账不连累整批；全军覆没时返回失败
//   3. 归入当前课次：与「课次结清」闭环——批量保存后三状态按课次立刻可见
//   4. 草稿工具 utils/draft.js：按班级隔离、可存可清
const assert = require('assert');

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

function setup() {
  const db = freshDb();
  db.init();
  const cls = db.classes.create({ name: '素描班' }).item;
  const stus = ['周诺昭', '李明', '王小虎', '赵丫头'].map(n =>
    db.students.create({ name: n, clsIds: [cls.id] }).item);
  return { db, cls, stus };
}

/* ================= A. 批量落库 ================= */
console.log('\n【A. 批量落库】');
let t = setup();
ok('批量保存：4 人一次落库，全归当前课次', () => {
  const items = t.stus.map((s, i) => ({ cls: t.cls.id, sid: s.id, score: 80 + i, tag: '良好', note: '第' + i + '号评语' }));
  const out = t.db.records.batch(items, false);
  assert.ok(out.ok, out.msg);
  assert.strictEqual(out.saved, 4);
  assert.strictEqual(out.failed, 0);
  const recs = t.db.records.ofClass(t.cls.id);
  assert.strictEqual(recs.length, 4);
  assert.ok(recs.every(r => r.session === 1), '全部盖第 1 课次');
});
ok('结转制班级批量录也会逐条消课', () => {
  const en = t.db.enrollments.create({ studentId: t.stus[0].id, clsId: t.cls.id, termId: 0, totalHours: 10, usedHours: 0 });
  assert.ok(en.ok, en.msg);
  const c2 = t.db.classes.create({ name: '课时包班', mode: 'carry' }).item;
  t.db.students.update(t.stus[0].id, { clsIds: [t.cls.id, c2.id] });
  const out = t.db.records.batch([
    { cls: c2.id, sid: t.stus[0].id, score: 90, note: 'x' },
    { cls: c2.id, sid: t.stus[0].id, score: 91, note: 'y' }
  ], false);
  assert.ok(out.ok, out.msg);
  const acc = t.db.enrollments.ofStudent(t.stus[0].id).find(e => e.clsId === c2.id);
  assert.strictEqual(acc.usedHours, 2, '两条记录消 2 课时');
});
ok('空清单拒绝', () => {
  assert.strictEqual(t.db.records.batch([], false).ok, false);
});

/* ================= B. 部分失败与权限 ================= */
console.log('\n【B. 部分失败不连累整批】');
t = setup();
ok('一行学生不在班：只记 1 条失败，其余 3 条正常保存', () => {
  const outsider = t.db.students.create({ name: '隔壁班' }).item;
  const otherCls = t.db.classes.create({ name: '别班' }).item;
  t.db.students.update(outsider.id, { clsIds: [otherCls.id] });
  const items = t.stus.map(s => ({ cls: t.cls.id, sid: s.id, score: 85, note: 'n' }))
    .concat([{ cls: t.cls.id, sid: outsider.id, score: 85, note: 'n' }]);
  const out = t.db.records.batch(items, false);
  assert.ok(out.ok, '部分失败仍算成功');
  assert.strictEqual(out.saved, 4);
  assert.strictEqual(out.failed, 1);
  assert.strictEqual(t.db.records.ofClass(t.cls.id).length, 4, '只有 4 条落库');
});
ok('全军覆没：返回失败并带首条原因', () => {
  const out = t.db.records.batch([{ cls: t.cls.id, sid: 99999, score: 85 }], false);
  assert.strictEqual(out.ok, false);
  assert.ok(out.msg && out.msg.length > 0);
  assert.strictEqual(t.db.records.ofClass(t.cls.id).length, 4, '一条也不该落进去');
});
t = setup();
ok('家长身份批量落库被整体拒绝', () => {
  const pMem = t.db.users.create({ name: '家长乙', role: 'parent', studentIds: [t.stus[0].id] });
  assert.ok(pMem.ok, pMem.msg);
  t.db.users.switchTo(pMem.item.userId);
  const out = t.db.records.batch(t.stus.map(s => ({ cls: t.cls.id, sid: s.id, score: 90 })), false);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(t.db.records.ofClass(t.cls.id).length, 0);
});
t.db.users.switchHome();

/* ================= C. 与课次结清闭环 ================= */
console.log('\n【C. 批量录 → 结清 → 新一课】');
t = setup();
ok('批量录第 1 课 → 结清 → 批量录第 2 课，互不干扰', () => {
  t.db.records.batch(t.stus.map(s => ({ cls: t.cls.id, sid: s.id, score: 85, note: '第一课' })), false);
  const s1 = t.db.records.settle(t.cls.id);
  assert.ok(s1.ok && s1.session === 2, s1.msg || '');
  assert.strictEqual(s1.sent, 4, '结清时 4 条全部发布');
  t.db.records.batch(t.stus.map(s => ({ cls: t.cls.id, sid: s.id, score: 90, note: '第二课' })), false);
  const cur = t.db.classes.get(t.cls.id).session;
  const curRecs = t.db.records.ofClass(t.cls.id).filter(r => r.session === cur);
  assert.strictEqual(curRecs.length, 4);
  assert.ok(curRecs.every(r => !r.sent), '第 2 课未发布');
  assert.strictEqual(t.db.records.ofClass(t.cls.id).length, 8, '两课共 8 条');
});
ok('补录：批量清单可显式归入更早课次', () => {
  const out = t.db.records.batch([{ cls: t.cls.id, sid: t.stus[0].id, score: 70, note: '补第一课', session: 1 }], false);
  assert.ok(out.ok, out.msg);
  assert.strictEqual(out.results[0].record.session, 1);
});

/* ================= D. 草稿工具 ================= */
console.log('\n【D. 草稿 utils/draft.js】');
ok('按班级隔离：两个班的草稿互不覆盖', () => {
  const draft = require('../utils/draft');
  draft.set(1, { rows: ['a'], topic: 't1' });
  draft.set(2, { rows: ['b'], topic: 't2' });
  assert.strictEqual(draft.get(1).topic, 't1');
  assert.strictEqual(draft.get(2).topic, 't2');
  draft.clear(1);
  assert.strictEqual(draft.get(1), null);
  assert.ok(draft.get(2), '另一个班的草稿还在');
});
ok('异常输入不抛错', () => {
  const draft = require('../utils/draft');
  draft.set('abc', { x: 1 });                    // 非法 id：不抛错（落到 0 号槽）
  const d = draft.get(undefined);                // 同槽读取：不抛错即可
  assert.ok(d === null || typeof d === 'object');
  draft.clear('abc');
  assert.strictEqual(draft.get('abc'), null);
});

console.log('\n全部 ' + pass + ' 项批量录入断言通过');
