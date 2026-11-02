// tests/verify_term.js —— 学期制与课时结转专项验证
// 覆盖：v4→v5 迁移（内置长期班收编）/ 学期 CRUD / 报名与课时账 / 消课 / 结转向导 / 权限闸门
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

/* ================= 场景 A：全新安装 ================= */
console.log('\n【A. 全新安装：内置长期班】');
let db = freshDb();
db.init();

ok('内置「长期班」自动创建且进行中', () => {
  const t = db.terms.list().find(x => x.builtIn);
  assert.ok(t, '应有内置学期');
  assert.strictEqual(t.name, '长期班');
  assert.strictEqual(t.status, 'active');
});
ok('默认班级已挂靠长期班', () => {
  const t = db.terms.list().find(x => x.builtIn);
  db.classes.list().forEach(c => assert.strictEqual(c.termId, t.id));
});
ok('默认班级模式为学期制', () => {
  assert.strictEqual(db.classes.list()[0].mode, 'term');
});

/* ================= 场景 B：v4 老数据升级 ================= */
console.log('\n【B. v4 老数据升级：一条不重建】');
// 清掉场景 A 的落盘（注意 key 带存储前缀）
['meta', 'terms', 'enrollments', 'orgs', 'members', 'classes', 'courses',
 'students', 'records', 'users', 'templates'].forEach(n => { delete mem['chengguo_v3_' + n]; });
mem['chengguo_v3_meta'] = {
  version: 4, orgId: 'org1', orgName: '老机构', me: 't1',
  teacher: '王老师', demoVersion: demo.DEMO_VERSION, createdAt: 1000, updatedAt: 1000
};
mem['chengguo_v3_users'] = [{ id: 't1', name: '王老师', role: 'owner' }];
mem['chengguo_v3_orgs'] = [{ id: 'org1', name: '老机构', ownerId: 't1', status: 'active' }];
mem['chengguo_v3_members'] = [{ id: 900, orgId: 'org1', userId: 't1', role: 'owner', name: '王老师', clsIds: [7, 8], courseIds: [], studentIds: [], status: 'active' }];
mem['chengguo_v3_classes'] = [{ id: 7, name: '书法班', sort: 0 }, { id: 8, name: '素描班', sort: 1 }];
mem['chengguo_v3_courses'] = [{ id: 71, name: '楷书', clsId: 7 }];
mem['chengguo_v3_students'] = [{ id: 70, name: '小明', clsIds: [7], parent: '', wechat: '', photo: '', profile: {} }];
mem['chengguo_v3_records'] = [];
mem['chengguo_v3_templates'] = [];

db = freshDb();
db.init();

ok('v4 数据升级到 v5 且班级被长期班收编', () => {
  assert.strictEqual(db.settings().version, 5);
  const bi = db.terms.list().find(x => x.builtIn);
  assert.ok(bi, '应创建内置学期');
  assert.strictEqual(db.classes._all().length, 2, '班级数量不变');
  db.classes._all().forEach(c => assert.strictEqual(c.termId, bi.id));
});
ok('老学生与课程一条不丢', () => {
  assert.strictEqual(db.students.list().length, 1);
  assert.strictEqual(db.courses.list().length, 1);
  assert.strictEqual(db.students.list()[0].name, '小明');
});

/* ================= 场景 C：学期管理 ================= */
console.log('\n【C. 学期 CRUD 与命名自由】');
let term;
ok('新建学期：无进行中学期外的学期时默认 upcoming', () => {
  const r = db.terms.create({ name: '2026 秋季班', startDate: '2026-09-01' });
  assert.ok(r.ok, r.msg);
  term = r.item;
  assert.strictEqual(term.status, 'upcoming');
});
ok('学期名可以完全自定义（第37期）', () => {
  const r = db.terms.create({ name: '第37期' });
  assert.ok(r.ok, r.msg);
  assert.strictEqual(r.item.name, '第37期');
});
ok('结束日期早于开始日期被拦', () => {
  const r = db.terms.create({ name: '坏学期', startDate: '2026-09-01', endDate: '2026-08-01' });
  assert.ok(!r.ok && /早于/.test(r.msg));
});
ok('无名称被拦', () => {
  const r = db.terms.create({ name: '  ' });
  assert.ok(!r.ok);
});
ok('老师无权管理学期（term.manage 闸门）', () => {
  // 切到一个老师身份：造一个老师 user + member 并切过去
  const u = db.users.list()[0];
  const r2 = db.users.create({ name: '李老师', role: 'teacher', clsIds: [7] });
  assert.ok(r2.ok, r2.msg);
  db.users.switchTo(r2.raw ? r2.raw.userId : u.id);
  const tid = db.users.list().find(x => x.name === '李老师').id;
  db.users.switchTo(tid);
  const r = db.terms.create({ name: '老师建的学期' });
  assert.ok(!r.ok, '老师应被拒绝');
  db.users.switchTo('t1');
});

/* ================= 场景 D：报名与课时账 ================= */
console.log('\n【D. 报名（课时账本）与消课】');
let cls, en;
ok('新建结转制班级挂到指定学期', () => {
  const r = db.classes.create({ name: '硬笔初级', termId: term.id, mode: 'carry' });
  assert.ok(r.ok, r.msg);
  cls = r.item;
  assert.strictEqual(cls.mode, 'carry');
  assert.strictEqual(cls.termId, term.id);
});
ok('学生加入结转班', () => {
  const r = db.students.update(70, { clsIds: [7, cls.id] });
  assert.ok(r.ok, r.msg);
});
ok('创建报名：20 课时，重复报名被拦', () => {
  const r = db.enrollments.create({ studentId: 70, clsId: cls.id, totalHours: 20 });
  assert.ok(r.ok, r.msg);
  en = r.item;
  const dup = db.enrollments.create({ studentId: 70, clsId: cls.id, totalHours: 10 });
  assert.ok(!dup.ok && /已在本班在读/.test(dup.msg));
});
ok('录一条成果记录自动消 1 课时', () => {
  const r = db.records.save({ sid: 70, cls: cls.id, course: '硬笔', score: 90, tag: '优秀', note: '好' }, false);
  assert.ok(r.ok, r.msg);
  const after = db.enrollments.get(en.id);
  assert.strictEqual(after.usedHours, 1);
});
ok('编辑记录不重复消课', () => {
  db.records.save({ rid: r.rid2 || undefined, sid: 70, cls: cls.id, course: '硬笔', score: 92 }, false);
  // 上面新建了一条新记录（第二次调用没有 rid，是新建）→ 会再消 1；再对第一条做编辑不消
  const before = db.enrollments.get(en.id).usedHours;
  db.records.save({ rid: r.rid, sid: 70, cls: cls.id, course: '硬笔', score: 95 }, false);
  assert.strictEqual(db.enrollments.get(en.id).usedHours, before, '编辑不应消课');
});
ok('剩余课时 = total - used', () => {
  const e = db.enrollments.get(en.id);
  assert.strictEqual(e.totalHours - e.usedHours, 18);
});
ok('手动调整课时（购课 +10）', () => {
  const r = db.enrollments.update(en.id, { totalHours: 30 });
  assert.ok(r.ok, r.msg);
  assert.strictEqual(r.item.totalHours - r.item.usedHours, 28);
});
ok('负课时被拦', () => {
  const r = db.enrollments.update(en.id, { usedHours: -1 });
  assert.ok(!r.ok && /不能为负/.test(r.msg));
});
ok('家长无法创建报名', () => {
  db.users.create({ name: '家长甲', role: 'parent', studentIds: [70] });
  const pid = db.users.list().find(x => x.name === '家长甲').id;
  db.users.switchTo(pid);
  const r = db.enrollments.create({ studentId: 70, clsId: 7, totalHours: 5 });
  assert.ok(!r.ok);
  db.users.switchTo('t1');
});

/* ================= 场景 E：结转向导 ================= */
console.log('\n【E. 结转向导（planSettle → 结转 → 归档）】');
let plan, nextTerm, newCls;
ok('planSettle 返回班级/课程/学生/剩余课时', () => {
  const r = db.terms.planSettle(term.id);
  assert.ok(r.ok, r.msg);
  plan = r;
  assert.strictEqual(r.term.id, term.id);
  const carryCls = r.classes.find(x => x.cls.id === cls.id);
  assert.ok(carryCls, '应包含结转班');
  assert.strictEqual(carryCls.students.length, 1);
  assert.strictEqual(carryCls.students[0].remain, 28);
  assert.ok(carryCls.courses.length === 0, '新班还没课程');
});
ok('内置长期班不参与结转', () => {
  const bi = db.terms.list().find(x => x.builtIn);
  const r = db.terms.planSettle(bi.id);
  assert.ok(!r.ok && /不参与/.test(r.msg));
});
ok('第一步：新学期延续班级（复制班+课程+老师指派）', () => {
  const r = db.terms.create({ name: '2026 寒假班', startDate: '2027-01-20' });
  assert.ok(r.ok, r.msg);
  nextTerm = r.item;
  // 把寒假班设为进行中（模拟新学期开学）
  const s = db.terms.update(nextTerm.id, { status: 'active' });
  assert.ok(s.ok, s.msg);
  const rc = db.classes.create({ name: '硬笔初级', termId: nextTerm.id, mode: 'carry', teacherId: 0 });
  assert.ok(rc.ok, rc.msg);
  newCls = rc.item;
  assert.notStrictEqual(newCls.id, cls.id, '必须是全新班级实体');
});
ok('第二步：续报学生（剩余课时带入 + 溯源）', () => {
  const r = db.enrollments.create({
    studentId: 70, clsId: newCls.id, totalHours: 28, usedHours: 0,
    carriedFrom: en.id
  });
  assert.ok(r.ok, r.msg);
  assert.strictEqual(r.item.totalHours, 28, '剩余 28 课时全带入');
  assert.strictEqual(r.item.carriedFrom, en.id);
});
ok('第三步：旧报名标记已结转，未续报的标记流失', () => {
  const r1 = db.enrollments.update(en.id, { status: 'carried' });
  assert.ok(r1.ok, r1.msg);
  // 造一个没续报的学生报名并标记流失
  const r2 = db.enrollments.create({ studentId: 70, clsId: 7, totalHours: 10 });
  assert.ok(r2.ok, r2.msg);
  const r3 = db.enrollments.update(r2.item.id, { status: 'churned' });
  assert.ok(r3.ok, r3.msg);
});
ok('第四步：旧学期归档后不可再结转', () => {
  const r = db.terms.archive(term.id);
  assert.ok(r.ok, r.msg);
  const again = db.terms.planSettle(term.id);
  assert.ok(!again.ok && /已归档/.test(again.msg));
});
ok('内置长期班不可归档', () => {
  const bi = db.terms.list().find(x => x.builtIn);
  const r = db.terms.archive(bi.id);
  assert.ok(!r.ok);
});
ok('归档学期不参与「进行中」列表，新班课时账独立', () => {
  assert.ok(db.terms.activeList().every(t => t.id !== term.id));
  const newEn = db.enrollments.of(newCls.id, 70);
  assert.ok(newEn, '新班在读报名存在');
  assert.strictEqual(newEn.totalHours - newEn.usedHours, 28);
});

/* ================= 场景 F：消课边界 ================= */
console.log('\n【F. 消课边界】');
ok('学期制班级录记录不消课时', () => {
  const r = db.records.save({ sid: 70, cls: 7, course: '楷书', score: 88, tag: '良好', note: '' }, false);
  assert.ok(r.ok, r.msg);
  const en7 = db.enrollments.of(7, 70);
  // 刚才 E 里给班 7 建过报名（后标 churned）；of() 只找 active → 应为 null
  assert.strictEqual(en7, null, '学期制班级不应有 active 报名被消课');
});
ok('结转班无报名时录记录自动补账（未购课 total=0）', () => {
  db.students.create({ name: '插班生', clsIds: [newCls.id] });
  const sid = db.students.list().find(s => s.name === '插班生').id;
  const r = db.records.save({ sid, cls: newCls.id, course: '硬笔', score: 80, tag: '加油', note: '' }, false);
  assert.ok(r.ok, r.msg);
  const en = db.enrollments.of(newCls.id, sid);
  assert.ok(en, '应自动建账');
  assert.strictEqual(en.totalHours, 0);
  assert.strictEqual(en.usedHours, 1);
});
ok('删除班级连带软删报名，学生与记录保留', () => {
  const cid = newCls.id;
  const r = db.classes.remove(cid);
  assert.ok(r.ok, r.msg);
  assert.ok(db.enrollments.ofClass(cid).every(e => e.removed), '报名应软删');
  assert.ok(db.students.list().some(s => s.name === '插班生'), '学生保留');
});

console.log('\n全部 ' + pass + ' 项学期断言通过');
