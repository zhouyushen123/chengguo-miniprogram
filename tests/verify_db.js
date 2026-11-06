// tests/verify_db.js —— 主数据层回归验证（Node 环境，模拟 wx 存储）
const path = require('path');
const assert = require('assert');
const schema = require('../utils/db/schema');

/* ---------- 1. 造一个"老版本"设备存储：v2 单一大对象 ---------- */
const mem = {};
global.wx = {
  getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete mem[k]; }
};

const demo = require('../utils/demo-data');
// 夹具模拟的是"老师自己录的学生和记录"：演示数据现在住在独立的存储里（storage.demo），
// 真实库不该带 demo 标记 —— 带着会被启动时的 purgeSeed 当成历史演示数据清出去。
const students = demo.DEMO_STUDENTS.map(s => { const x = Object.assign({}, s); delete x.demo; return x; });
const records = demo.DEMO_RECORDS.map(r => { const x = Object.assign({}, r); delete x.demo; return x; });
// 故意制造三处脏数据：缺班级 / 日期没补零 / 缺录入老师
records[0].cid = undefined;
records[1].date = '2026-11-1';
records[2].cid = undefined;

mem['chengguo_v2'] = {
  teacher: '王老师', me: 't1', role: 'teacher',
  users: [
    { id: 't1', name: '王老师', role: 'teacher', clsIds: [], courseIds: [] },
    { id: 'p1', name: '家长演示', role: 'parent', studentIds: [101] }
  ],
  classes: [{ id: 1, name: '书法班' }, { id: 2, name: '素描班' }],
  courses: [{ id: 1, name: '楷书', clsId: 1 }, { id: 2, name: '素描', clsId: 2 }],
  students, records,
  demoVersion: demo.DEMO_VERSION        // 与当前版本一致 → 不重复灌演示数据
};
mem['chengguo_tpls'] = [
  { n: '上课态度', opts: ['认真专注', '偶有走神'] },
  { n: '知识点掌握', opts: ['掌握扎实'] },   // 历史维度名，应迁移为「知识掌握」
  { n: '课程注意', opts: ['课后复习'] }
];

/* ---------- 2. 启动数据层 ---------- */
function freshRequire() {
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf(path.join('utils', 'db')) > -1 || k.endsWith('utils\\store.js') || k.endsWith('utils/store.js')) delete require.cache[k];
  });
  return require('../utils/db');
}

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

let db = freshRequire();
db.init();

console.log('\n【迁移：v2 大对象 → v4 实体集合】');
ok('元信息升到 v4 且带 orgId', () => {
  const s = db.settings();
  assert.strictEqual(s.version, schema.VERSION);
  assert.strictEqual(s.orgId, 'org1');
  assert.strictEqual(s.teacher, '王老师');
});
ok('8 类实体各自独立存储成一个 key', () => {
  ['orgs', 'members', 'classes', 'courses', 'students', 'records', 'users', 'templates'].forEach(n => {
    assert.ok(Array.isArray(mem['chengguo_v3_' + n]), n + ' 未独立存储');
  });
});
ok('班级 / 课程 / 学生数量与 id 保持不变', () => {
  assert.strictEqual(db.classes.list().length, 2);
  assert.strictEqual(db.courses.list().length, 2);
  assert.strictEqual(db.students.list().length, demo.DEMO_STUDENTS.length);
  assert.ok(db.students.get(101), '演示学生 id 应保留');
});
ok('旧 key 保留作兜底（不删数据）', () => {
  assert.ok(mem['chengguo_v2'] && mem['chengguo_v2'].students.length === 45);
});
ok('所有实体都补齐审计字段', () => {
  const all = [].concat(db.classes.list(), db.courses.list(), db.students.list(), db.records.list(), db.users.list(), db.templates.list(), db.members.list());
  all.forEach(e => {
    assert.ok(e.orgId === 'org1', 'orgId 缺失 ' + JSON.stringify(e).slice(0, 80));
    assert.ok(typeof e.createdAt === 'number' && e.createdAt > 0, 'createdAt 缺失');
    assert.ok(typeof e.updatedAt === 'number' && e.updatedAt > 0, 'updatedAt 缺失');
    assert.strictEqual(e.removed, false);
  });
});
ok('模板迁成实体，历史维度名同步改名', () => {
  const t = db.templates.list();
  assert.strictEqual(t.length, 3);
  assert.strictEqual(t[1].name, '知识掌握');
  assert.deepStrictEqual(t[0].options, ['认真专注', '偶有走神']);
  t.forEach(x => assert.ok(x.id > 0));
});
ok('脏数据自愈：缺班级回填 + 日期补零', () => {
  assert.ok(db.records.list().every(r => r.cid > 0), '仍存在无班级记录');
  assert.ok(db.records.list().every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date)), '日期格式不统一');
  assert.ok(db.records.list().every(r => r.tid === 't1'), '录入老师未回填');
});
ok('课程以 id 关联，不靠名字字符串', () => {
  const r = db.records.list().find(x => x.course === '素描');
  assert.ok(r && r.courseId === 2, '课程 id 未回填');
});

console.log('\n【字段约束与校验】');
ok('空名称班级被拒', () => {
  const r = db.classes.create({ name: '   ' });
  assert.strictEqual(r.ok, false);
});
ok('新建班级成功并带审计字段', () => {
  const r = db.classes.create({ name: '国画班' });
  assert.strictEqual(r.ok, true);
  assert.ok(r.item.id > 0 && r.item.orgId === 'org1');
  assert.strictEqual(db.classes.list().length, 3);
});
ok('课程不再必须归属班级（V10 解耦），但名称必填、班级要真实存在', () => {
  const r = db.courses.create({ name: '写意' });
  assert.strictEqual(r.ok, true, '无班级也能进课程库');
  assert.strictEqual(r.item.clsId, undefined, '课程实体上不再带 clsId');
  assert.strictEqual(db.courses.classIdsOf(r.item.id).length, 0, '还没开在任何班');
  const bad = db.courses.create({ name: '油画', clsId: 9999 });
  assert.strictEqual(bad.ok, false, '指向不存在班级的建课要被拒');
  assert.strictEqual(db.courses.create({ name: '' }).ok, false);
});
ok('记录必须关联学生、分数有上下限', () => {
  assert.strictEqual(db.records.save({ sid: 0, note: 'x' }, false).ok, false);
  assert.strictEqual(db.records.save({ sid: 101, score: 120, note: 'x' }, false).ok, false);
});
ok('照片 / 视频数量上限拦截', () => {
  const photos = new Array(10).fill('a.jpg');
  assert.strictEqual(db.records.save({ sid: 101, photos }, false).ok, false);
});

console.log('\n【录入 → 首页/班级页可见】');
let newRid = 0;
ok('新建记录：班级、课程 id、日期、老师全部落到规范字段', () => {
  const r = db.records.save({ cls: 1, sid: 101, course: '楷书', score: 92, tag: '优秀', note: '上课态度：认真' }, true);
  assert.strictEqual(r.ok, true, r.msg);
  const rec = r.record;
  newRid = rec.id;
  assert.strictEqual(rec.cid, 1);
  assert.strictEqual(rec.courseId, 1);
  assert.strictEqual(rec.sid, 101);
  assert.strictEqual(rec.tid, 't1');
  assert.match(rec.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(rec.sent, true);
});
ok('新记录能被班级页 / 学生页按规范字段查到', () => {
  assert.ok(db.records.ofClass(1).some(r => r.id === newRid));
  assert.ok(db.records.ofStudent(101).some(r => r.id === newRid));
  assert.strictEqual(db.records.latest(101).id, newRid, '最近一条应为新记录');
});
ok('编辑同一条记录不会新增', () => {
  const before = db.records.list().length;
  const r = db.records.save({ rid: newRid, cls: 1, sid: 101, course: '楷书', score: 85, note: '改过' }, true);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(db.records.list().length, before);
  assert.strictEqual(db.records.get(newRid).note, '改过');
});
ok('编辑旧记录不会把日期改成今天', () => {
  const old = db.records.save({ sid: 101, cls: 1, course: '楷书', date: '2026-09-15', note: '旧记录', photos: ['a.jpg'] }, true).record;
  const ed = db.records.save({ rid: old.id, sid: 101, cls: 1, course: '楷书', note: '改过', photos: ['a.jpg'] }, true).record;
  assert.strictEqual(ed.date, '2026-09-15');
});
ok('id 单调递增，不撞号', () => {
  const ids = new Set();
  for (let i = 0; i < 5; i++) {
    const r = db.records.save({ sid: 101, note: '批量' + i }, true);
    assert.ok(!ids.has(r.rid) && r.rid > newRid, 'id 重复或未递增');
    ids.add(r.rid);
  }
});

console.log('\n【发送状态与批量发送】');
ok('批量标记已发送只影响未发送的', () => {
  const pool = db.records.ofClass(1).filter(r => !r.sent);
  assert.ok(pool.length > 0, '测试前提：班级 1 存在未发送记录');
  const n = db.records.markSent(pool.map(r => r.id));
  assert.strictEqual(n.count, pool.length);
  assert.strictEqual(db.records.markSent(pool.map(r => r.id)).count, 0, '重复发送应返回 0');
});

console.log('\n【软删除与关联清理】');
ok('删班级：只解绑课程（课程保留）、学生移出该班、记录保留', () => {
  const c = db.classes.create({ name: '临时班' }).item;
  const course = db.courses.create({ name: '临时课', clsId: c.id }).item;
  const stu = db.students.create({ name: '临时学生', clsIds: [c.id] }).item;
  const rec = db.records.save({ cls: c.id, sid: stu.id, note: '临时记录' }, true).record;

  assert.strictEqual(db.classes.remove(c.id).ok, true);
  assert.strictEqual(db.classes.get(c.id), null, '班级应不可见');
  // V10：课程是独立资产，删班只解除"这门课在这个班开过"，不连课一起删
  assert.ok(db.courses.get(course.id), '课程本身应保留（可能还开在别的班）');
  assert.strictEqual(db.courses.classIdsOf(course.id).length, 0, '但已不在任何班开设');
  assert.strictEqual(db.students.get(stu.id).clsIds.length, 0, '学生应移出该班');
  assert.ok(db.records.get(rec.id), '历史记录应保留');
  // 软删标记要落库，多端同步时才能传播删除
  const raw = mem['chengguo_v3_classes'].find(x => x.id === c.id);
  assert.strictEqual(raw.removed, true);
});
ok('删学生：其记录一并软删，不再出现在列表', () => {
  const stu = db.students.create({ name: '待删学生', clsIds: [1] }).item;
  const rec = db.records.save({ cls: 1, sid: stu.id, note: '将被删' }, true).record;
  const r = db.students.remove(stu.id);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(db.records.get(rec.id), null, '记录应一并软删');
});

console.log('\n【学号与家长归并】');
ok('建档自动分配不重复学号，可按学号查回', () => {
  const a = db.students.create({ name: '学号甲', clsIds: [1] }).item;
  const b = db.students.create({ name: '学号乙', clsIds: [1] }).item;
  assert.ok(/^\d+$/.test(a.no), '学号应为纯数字：' + a.no);
  assert.notStrictEqual(a.no, b.no, '两个学生的学号不能重复');
  assert.strictEqual(db.students.byNo(a.no).id, a.id, '按学号应查回本人');
  assert.strictEqual(db.students.byNo('999999'), null, '不存在的学号返回 null');
  db.students.remove(a.id); db.students.remove(b.id);
});
ok('同一家长号码的第二个孩子自动归入已有家长账号', () => {
  const kid1 = db.students.create({ name: '姐姐', clsIds: [1], parent: '张妈妈', wechat: '13800001111' }).item;
  const p = db.members.create({ name: '张妈妈', role: 'parent', studentIds: [kid1.id], clsIds: [], courseIds: [] });
  assert.strictEqual(p.ok, true, p.msg || '');
  // 号码写法不同（带短横）也要认成同一位家长
  const kid2 = db.students.create({ name: '弟弟', clsIds: [1], parent: '张妈妈', wechat: '138-0000-1111' });
  assert.strictEqual(kid2.ok, true, kid2.msg || '');
  assert.deepStrictEqual(kid2.linked, ['张妈妈'], '应提示归入哪位家长');
  const m = db.members.list().find(x => x.name === '张妈妈');
  assert.ok(m.studentIds.indexOf(kid2.item.id) > -1, '弟弟应自动出现在家长名下');
  assert.ok(m.studentIds.indexOf(kid1.id) > -1, '原有的姐姐不能被顶掉');
  // 家长号码不同 → 不能被当成一家人
  const other = db.students.create({ name: '别家孩子', clsIds: [1], parent: '李爸爸', wechat: '13900002222' });
  assert.deepStrictEqual(other.linked, [], '号码不同不应归并');
  // 清理，避免影响后续用例的学生数量断言
  [kid1.id, kid2.item.id, other.item.id].forEach(id => db.students.remove(id));
  db.members.remove(m.id);
});
ok('家长只挑一个孩子，同家长的其他孩子自动带出', () => {
  const a = db.students.create({ name: '大成', clsIds: [1], wechat: '13700003333' }).item;
  const b = db.students.create({ name: '小成', clsIds: [1], wechat: '13700003333' }).item;
  const p = db.members.create({ name: '成爸爸', role: 'parent', studentIds: [a.id], clsIds: [], courseIds: [] });
  assert.strictEqual(p.ok, true, p.msg || '');
  assert.ok(p.item.studentIds.indexOf(b.id) > -1, '同家长的另一个孩子应被自动带上');
  // 改成员时只留一个孩子，也会被补齐（不能出现"漏了老大"）
  const m = db.members.list().find(x => x.name === '成爸爸');
  db.members.update(m.id, { studentIds: [b.id] });
  const after = db.members.list().find(x => x.name === '成爸爸');
  assert.ok(after.studentIds.indexOf(a.id) > -1, '改档后同家长孩子仍应齐全');
  [a.id, b.id].forEach(id => db.students.remove(id));
  db.members.remove(m.id);
});

console.log('\n【评价模板】');
ok('新增 / 修改 / 删除选项，重名被拒', () => {
  const g = db.templates.list()[0];
  const n0 = g.options.length;
  assert.strictEqual(db.templates.addOption(g.id, '新评语').ok, true);
  assert.strictEqual(db.templates.addOption(g.id, '新评语').ok, false, '重名应被拒');
  assert.strictEqual(db.templates.list()[0].options.length, n0 + 1);
  db.templates.updateOption(g.id, n0, '改过的评语');
  assert.strictEqual(db.templates.list()[0].options[n0], '改过的评语');
  db.templates.removeOption(g.id, n0);
  assert.strictEqual(db.templates.list()[0].options.length, n0);
});
ok('空维度名被拒', () => {
  assert.strictEqual(db.templates.create({ name: ' ' }).ok, false);
});

console.log('\n【身份与权限】');
ok('切换身份后 current 跟着变（角色来自成员关系）', () => {
  db.users.switchTo('p1');
  assert.strictEqual(db.users.current().role, 'parent');
  assert.strictEqual(db.isParent(), true);
  db.users.switchTo('t1');
  assert.strictEqual(db.isParent(), false);
});
ok('v2 里的首个老师升级为机构负责人', () => {
  assert.strictEqual(db.settings().role, 'owner');
  assert.strictEqual(db.orgs.current().ownerId, 't1');
});

console.log('\n【课程与班级解耦（V10）】');
ok('迁移：老课程的 clsId 派生成绑定，课程实体上不再有 clsId', () => {
  const ks = db.courses.list().find(c => c.name === '楷书');
  assert.ok(ks, '楷书应随迁移保留');
  assert.strictEqual(ks.clsId, undefined, '课程实体不该再带 clsId');
  assert.deepStrictEqual(db.courses.classIdsOf(ks.id), [1], '楷书开在书法班(1)');
});

ok('同一门课可同时开在多个班，课程只存一条', () => {
  const ks = db.courses.list().find(c => c.name === '楷书');
  const a = db.classes.create({ name: '楷书A班' }).item;
  const b = db.classes.create({ name: '楷书B班' }).item;
  const n0 = db.courses.list().length;
  assert.ok(db.courses.bind(a.id, ks.id).ok);
  assert.ok(db.courses.bind(b.id, ks.id).ok);
  assert.strictEqual(db.courses.list().length, n0, '不该复制出新课程');
  const ids = db.courses.classIdsOf(ks.id);
  assert.ok(ids.indexOf(a.id) > -1 && ids.indexOf(b.id) > -1);
  // 上课选课：两个班都能选到这门课，而且指向同一条课程
  assert.deepStrictEqual(db.courses.of(a.id).map(c => c.id), [ks.id]);
  assert.deepStrictEqual(db.courses.of(b.id).map(c => c.id), [ks.id]);
});

ok('同名建课直接复用课程库里的那门，不制造第二条', () => {
  const ks = db.courses.list().find(c => c.name === '楷书');
  const n0 = db.courses.list().length;
  const c = db.classes.create({ name: '楷书C班' }).item;
  const r = db.courses.create({ name: '楷书', clsId: c.id });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reused, true, '应复用而不是新建');
  assert.strictEqual(r.item.id, ks.id);
  assert.strictEqual(db.courses.list().length, n0);
  assert.ok(db.courses.classIdsOf(ks.id).indexOf(c.id) > -1, '顺带开到新班');
});

ok('解绑只摘掉这个班，课程与其他班不受影响', () => {
  const ks = db.courses.list().find(c => c.name === '楷书');
  const before = db.courses.classIdsOf(ks.id);
  const target = before[0];
  const r = db.courses.unbind(target, ks.id);
  assert.strictEqual(r.ok, true);
  assert.ok(db.courses.get(ks.id), '课程本身还在');
  assert.strictEqual(db.courses.classIdsOf(ks.id).indexOf(target), -1);
  assert.strictEqual(db.courses.classIdsOf(ks.id).length, before.length - 1);
});

ok('删班不删课：绑定一起进回收站，班级还原时认回来', () => {
  const ks = db.courses.list().find(c => c.name === '楷书');
  const cls = db.classes.create({ name: '临时楷书班' }).item;
  db.courses.bind(cls.id, ks.id);
  db.classes.remove(cls.id);
  assert.ok(db.courses.get(ks.id), '课程不能被连带删除');
  assert.strictEqual(db.courses.classIdsOf(ks.id).indexOf(cls.id), -1, '暂时不在这个班');
  assert.strictEqual(db.classes.restore(cls.id).ok, true);
  assert.ok(db.courses.classIdsOf(ks.id).indexOf(cls.id) > -1, '还原班级，开设关系一起回来');
});

ok('删课连带解绑，还原时绑定全回来', () => {
  const ks = db.courses.list().find(c => c.name === '楷书');
  const ids = db.courses.classIdsOf(ks.id);
  assert.strictEqual(db.courses.remove(ks.id).ok, true);
  assert.strictEqual(db.courses.get(ks.id), null, '课程不可见');
  assert.strictEqual(db.courses.classIdsOf(ks.id).length, 0, '绑定也一起失效');
  const r = db.courses.restore(ks.id);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(db.courses.classIdsOf(ks.id), ids, '绑定按批次全认回来');
});

ok('录记录时按课程名反查课程 id（跨班同名也认）', () => {
  const ks = db.courses.list().find(c => c.name === '楷书');
  const cls = db.classes.create({ name: '楷书D班' }).item;
  assert.ok(db.courses.bind(cls.id, ks.id).ok);
  const stu = db.students.create({ name: '反查学生', clsIds: [cls.id] }).item;
  const r = db.records.save({ cls: cls.id, sid: stu.id, course: '楷书', note: '解耦后录一条' }, true);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.record.courseId, ks.id, '课程指针要挂上，题库将来靠它关联');
});

console.log('\n【持久化：模拟重启后数据还在】');
ok('重启后数据一致（说明真的落盘了）', () => {
  const before = {
    cls: db.classes.list().length,
    stu: db.students.list().length,
    rec: db.records.list().length,
    tpl: db.templates.list().length
  };
  db = freshRequire();
  db.init();
  assert.strictEqual(db.classes.list().length, before.cls);
  assert.strictEqual(db.students.list().length, before.stu);
  assert.strictEqual(db.records.list().length, before.rec);
  assert.strictEqual(db.templates.list().length, before.tpl);
  assert.strictEqual(db.settings().version, schema.VERSION);
});
ok('二次 init 不会重复灌演示数据', () => {
  const n1 = db.students.list().length;
  db = freshRequire(); db.init();
  assert.strictEqual(db.students.list().length, n1);
});

console.log('\n全部 ' + pass + ' 项断言通过');
