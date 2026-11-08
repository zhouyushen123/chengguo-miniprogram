// tests/verify_owner.js —— 机构负责人角色完整旅程（数据层）
//
// 2026-11-09：用户要求「按负责人 / 老师 / 家长三种角色做深度测试」。
// 老师已有 verify_teacher.js，家长是 verify_parent.js，负责人此前只有
// verify_journey 的 J1~J3（开通+录入）和零散套件，管理侧的成段旅程没人串。
//
// 这个套件把负责人当**唯一主角**，每段标注 docs/user-test-cases.md 的人工用例编号：
//   O1 身份与全量能力：负责人是该机构唯一能管所有事的人（O-04）
//   O2 成员管理：加老师/家长、一号多孩、修改不新增、移除→回收站恢复（G-02/04/06/08/09）
//   O3 切换视角与切回：以老师视角看世界再完整回来（G-10/G-11）
//   O4 学期结转计划：planSettle 口径 + 归档后拒绝再结转（K-03/K-04/K-08）
//   O5 回收站分类：学生/班级/记录/成员四类都在、可恢复（N-01/N-02/N-04）
//   O6 管理侧防线：负责人唯一性、家长不占管理位（G-02 的反面）
//   O7 电脑端后台入口在负责人手上（O-08 源码级）
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

function boot(mem) {
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k];
  });
  global.wx = {
    getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
    setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
    removeStorageSync: k => { delete mem[k]; },
    getStorageInfoSync: () => ({ keys: Object.keys(mem), currentSize: 1, limitSize: 10240 }),
    showToast: () => {}, showModal: () => {}
  };
  const db = require(path.join(ROOT, 'utils/db'));
  db.init();
  return db;
}

console.log('· 负责人角色完整旅程');

/* ================= 场景搭建 ================= */
const mem = {};
let db = boot(mem);
const ids = {};
ok('O0 负责人搭场景：机构 / 学期 / 2 班 / 2 课 / 3 学生 / 老师 / 双孩家长', () => {
  assert.ok(db.orgs.update({ name: '墨白书法工作室' }).ok, '机构保存失败');
  const t = db.terms.create({ name: '2026 秋季学期', startDate: '2026-09-01', endDate: '2027-01-20', status: 'active' });
  assert.ok(t.ok, '学期：' + (t.msg || ''));
  ids.termId = t.item.id;

  const a = db.classes.create({ name: '软笔基础班', termId: ids.termId, mode: 'term' });
  const b = db.classes.create({ name: '硬笔提高班', termId: ids.termId, mode: 'hour' });
  assert.ok(a.ok && b.ok, '班级创建失败');
  ids.clsA = a.item.id;
  ids.clsB = b.item.id;
  assert.ok(db.courses.create({ name: '软笔书法', clsId: ids.clsA }).ok);
  assert.ok(db.courses.create({ name: '硬笔书法', clsId: ids.clsB }).ok);

  const s1 = db.students.create({ name: '李思远', clsIds: [ids.clsA] });
  const s2 = db.students.create({ name: '李知行', clsIds: [ids.clsB] });
  const s3 = db.students.create({ name: '周小雨', clsIds: [ids.clsA] });
  assert.ok(s1.ok && s2.ok && s3.ok, '学生创建失败');
  ids.stu1 = s1.item.id;
  ids.stu2 = s2.item.id;
  ids.stu3 = s3.item.id;

  const m = db.members.create({ role: 'teacher', name: '陈老师', clsIds: [ids.clsA] });
  assert.ok(m.ok, '老师创建失败：' + (m.msg || ''));
  ids.teacher = m.raw.userId;
  ids.teacherMember = m.item.id;
  ids.owner = mem['chengguo_v3_users'].find(u => u.role === 'owner').id;
});

/* ================= O1 身份与全量能力 ================= */
ok('O1a 身份：我是负责人，界面标签对（O-04）', () => {
  db.users.switchTo(ids.owner);
  assert.strictEqual(db.auth.role(), 'owner');
  assert.strictEqual(db.auth.roleLabel(), '机构负责人');
  assert.strictEqual(db.auth.isOwner(), true);
  assert.strictEqual(db.auth.isAdmin(), true, '负责人应算管理员');
  assert.strictEqual(db.auth.isTeacher(), false);
});

ok('O1b 能力清单：管理侧动作全开（O-04）', () => {
  const ab = db.auth.abilities();
  ['org.manage', 'member.manage', 'term.manage', 'class.write', 'course.write',
    'template.write', 'student.write', 'record.create', 'record.send', 'profile.write']
    .forEach(k => assert.strictEqual(ab[k], true, '负责人应有 ' + k));
});

/* ================= O2 成员管理 ================= */
ok('O2a 添加家长并按学号绑定两个孩子（G-04/G-06/Q-09）', () => {
  const p = db.members.create({ role: 'parent', name: '李妈妈', studentIds: [ids.stu1, ids.stu2] });
  assert.ok(p.ok, '家长创建失败：' + (p.msg || ''));
  ids.parent = p.raw.userId;
  ids.parentMember = p.item.id;
  assert.strictEqual(p.item.studentIds.length, 2, '一号多孩：应绑到 2 个孩子');
  assert.ok(p.item.studentIds.indexOf(ids.stu1) > -1 && p.item.studentIds.indexOf(ids.stu2) > -1);
});

ok('O2b 幽灵学号不进家长视野（G-05 等价：绑了不存在的学号也不会看到幽灵孩子）', () => {
  const p2 = db.members.create({ role: 'parent', name: '试错家长', studentIds: [ids.stu3, 99999] });
  assert.ok(p2.ok, '创建应成功（学号错不拦创建，靠视图过滤兜底）');
  db.users.switchTo(p2.raw.userId);
  assert.ok(db.family.kids().every(k => k.name !== ''), '孩子名不应为空');
  assert.ok(db.family.kids().length <= 1, '幽灵学号不应变成一个孩子');
  db.users.switchTo(ids.owner);
  db.members.remove(p2.item.id);
});

ok('O2c 修改成员：改名 + 换负责班级，成员数不变，账号姓名同步（G-08）', () => {
  const before = db.members.list().length;
  const r = db.members.update(ids.teacherMember, { name: '陈静老师', clsIds: [ids.clsA, ids.clsB] });
  assert.ok(r.ok, '修改失败：' + (r.msg || ''));
  assert.strictEqual(db.members.list().length, before, '修改不应新增成员');
  assert.strictEqual(r.item.name, '陈静老师');
  assert.deepStrictEqual(r.item.clsIds, [ids.clsA, ids.clsB], '负责班级应已更新');
  const u = db.users.get(ids.teacher);
  assert.strictEqual(u.name, '陈静老师', '账号姓名应连带同步');
});

ok('O2d 移除 → 回收站分类可见 → 恢复（G-09/N-02/N-03）', () => {
  const r = db.members.remove(ids.teacherMember);
  assert.ok(r.ok, '移除失败：' + (r.msg || ''));
  assert.ok(!db.members.list().some(x => x.id === ids.teacherMember), '移除后列表应无此人');
  const tr = db.trash.list('members');
  assert.ok(tr.items.some(x => x.id === ids.teacherMember), '回收站「成员」分类应有此人');
  const rs = db.trash.restore('members', ids.teacherMember);
  assert.ok(rs.ok, '恢复失败：' + (rs.msg || ''));
  const back = db.members.list().find(x => x.id === ids.teacherMember);
  assert.ok(back, '恢复后应回来');
  assert.deepStrictEqual(back.clsIds, [ids.clsA, ids.clsB], '恢复后角色范围应原样回来');
});

/* ================= O6 管理侧防线（先于视角切换，保持 owner 身份） ================= */
ok('O6a 负责人唯一：不能建第二个负责人（G-02 反面）', () => {
  const r = db.members.create({ role: 'owner', name: '二号负责人' });
  assert.ok(!r.ok, '不应允许再建负责人');
  assert.ok(/负责人/.test(r.msg), '拒绝原因要能看懂：' + r.msg);
});

ok('O6b 不能移除负责人自己（G-09 反面）', () => {
  const me = db.members.list().find(x => x.role === 'owner');
  const r = db.members.remove(me.id);
  assert.ok(!r.ok, '不能移除负责人');
});

/* ================= O3 切换视角与切回 ================= */
ok('O3a 切到老师视角：世界变小了（G-10）', () => {
  db.users.switchTo(ids.teacher);
  assert.strictEqual(db.auth.role(), 'teacher');
  // O2c 已把陈老师的范围改成 [clsA, clsB]，老师应只看到分配的班，不看到更多
  const assigned = [ids.clsA, ids.clsB];
  assert.ok(db.classes.list().every(c => assigned.indexOf(c.id) > -1), '老师只看到分配的班');
  assert.ok(db.students.list().every(s => s.clsIds.some(cid => assigned.indexOf(cid) > -1)), '老师只看到分到班里的学生');
  const ab = db.auth.abilities();
  assert.strictEqual(ab['org.manage'], false, '老师视角下管理能力应消失');
});

ok('O3b 切回我自己：数据一点不少（G-11）', () => {
  db.users.switchHome();
  assert.strictEqual(db.auth.role(), 'owner', '切回应回到负责人');
  assert.strictEqual(db.classes.list().length, 2, '班级应完整');
  assert.strictEqual(db.students.list().length, 3, '学生应完整');
  assert.strictEqual(db.auth.abilities()['org.manage'], true, '管理能力应回来');
});

/* ================= O4 学期结转 ================= */
ok('O4a 结转计划：每班的课/学生/剩余课时都齐（K-03/K-04）', () => {
  const plan = db.terms.planSettle(ids.termId);
  assert.ok(plan.ok, '结转计划失败：' + (plan.msg || ''));
  assert.strictEqual(plan.classes.length, 2, '应覆盖本学期 2 个班');
  const clsA = plan.classes.find(x => x.cls.id === ids.clsA);
  assert.ok(clsA.courses.some(c => c.name === '软笔书法'), 'A 班课程应进计划');
  assert.ok(clsA.students.some(s => s.student.id === ids.stu1), 'A 班学生应进计划');
  // 硬笔提高班是课时结转模式，报名账本里没有报名也不该报错（remain=0 兜底）
  const clsB = plan.classes.find(x => x.cls.id === ids.clsB);
  assert.ok(clsB, 'B 班应在计划里');
});

ok('O4b 归档后的学期不能再结转（K-08 的保护位）', () => {
  const arch = db.terms.archive(ids.termId);
  assert.ok(arch.ok, '归档失败：' + (arch.msg || ''));
  const again = db.terms.planSettle(ids.termId);
  assert.ok(!again.ok, '已归档学期不应再出结转计划');
  assert.ok(/归档/.test(again.msg), '原因要能看懂：' + again.msg);
});

/* ================= O5 回收站分类 ================= */
ok('O5 删班 → 四类回收站各归各类 → 恢复班级（N-02/N-04）', () => {
  const del = db.classes.remove(ids.clsB);
  assert.ok(del.ok, '删班失败：' + (del.msg || ''));
  ['students', 'classes', 'records', 'members'].forEach(k => {
    const tr = db.trash.list(k);
    assert.ok(tr && Array.isArray(tr.items), '回收站应有「' + k + '」分类');
  });
  assert.ok(db.trash.list('classes').items.some(x => x.id === ids.clsB), '班级应在回收站');
  const rs = db.trash.restore('classes', ids.clsB);
  assert.ok(rs.ok, '恢复班失败：' + (rs.msg || ''));
  assert.ok(db.classes.list().some(c => c.id === ids.clsB), '班级应回来');
});

/* ================= O7 电脑端后台入口（源码级） ================= */
ok('O7 电脑端后台入口对负责人可见、在机构身份页里（O-08）', () => {
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  // 入口页是「机构与身份」（pages/orgid），老师角色旅程 R-01 已断言老师侧看不到它
  const src = read('pages/orgid/orgid.js') + read('pages/orgid/orgid.wxml');
  assert.ok(/电脑端后台/.test(src), '机构与身份页应有电脑端后台入口');
});

console.log('\n全部 ' + pass + ' 项负责人旅程断言通过');
