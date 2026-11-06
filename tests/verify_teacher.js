// tests/verify_teacher.js —— 老师角色完整旅程（数据层）
//
// 2026-11-06：用户要求「用老师的角色再跑一遍」。原来的 verify_journey 里老师只占
// J5 的 4 条（只见本班 / 能录能发 / 只改自己），覆盖面太窄，多数老师会踩的边界
// （跨班加学生、无班老师、管理级入口、回收站、代发别人草稿）都没测。
//
// 这个套件把老师当**唯一主角**，从登录到日常操作按顺序走一遍，每段标注人工用例编号：
//   T1 身份与入口：我是老师，不是管理员（R-01）
//   T2 可见范围：只看见自己的班、学生、课程、记录（R-02/R-05）
//   T3 日常主线：录入 → 草稿 → 发布 → 家长端收到 → 改自己的（R-03）
//   T4 own 边界：别人录的不能改不能删；能不能代发（R-04）
//   T5 学生管理：本班能加能改能删；别班一律拦（R-06）
//   T6 管理级操作：机构名/成员/学期/班级/课程/模板 全拦（R-01）
//   T7 没分班的老师：fail-closed，什么都看不到（R-02 的极端情形）
//   T8 回收站：老师看到的是不是只有自己范围的（越界检查）
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

console.log('· 老师角色完整旅程');

/* ================= 场景搭建（负责人视角） ================= */
// A 班是陈老师负责的班，B 班不是。两个班各两名学生，环境贴近真实。
const mem = {};
let db = boot(mem);
const ids = {};
ok('T0 负责人搭场景：2 班 / 4 学生 / 2 课 / 1 老师 / 1 家长', () => {
  assert.ok(db.orgs.update({ name: '墨白书法工作室' }).ok);
  const t = db.terms.create({ name: '2026 秋季学期', startDate: '2026-09-01', endDate: '2027-01-20', status: 'active' });
  assert.ok(t.ok, '学期：' + (t.msg || ''));
  ids.termId = t.item.id;

  const a = db.classes.create({ name: '软笔基础班', termId: ids.termId, mode: 'term' });
  const b = db.classes.create({ name: '硬笔提高班', termId: ids.termId, mode: 'term' });
  assert.ok(a.ok && b.ok, '班级创建失败');
  ids.clsA = a.item.id;
  ids.clsB = b.item.id;
  assert.ok(db.courses.create({ name: '软笔书法', clsId: ids.clsA }).ok);
  assert.ok(db.courses.create({ name: '硬笔书法', clsId: ids.clsB }).ok);

  const sa1 = db.students.create({ name: '李思远', clsIds: [ids.clsA] });
  const sa2 = db.students.create({ name: '周小雨', clsIds: [ids.clsA] });
  const sb1 = db.students.create({ name: '王大力', clsIds: [ids.clsB] });
  const sb2 = db.students.create({ name: '赵一诺', clsIds: [ids.clsB] });
  assert.ok(sa1.ok && sa2.ok && sb1.ok && sb2.ok, '学生创建失败');
  ids.stuA1 = sa1.item.id; ids.stuA2 = sa2.item.id;
  ids.stuB1 = sb1.item.id; ids.stuB2 = sb2.item.id;

  // 负责人自己在 A 班录一条并发布，用来测「老师能不能改别人录的」
  const r = db.records.save({ sid: ids.stuA1, clsId: ids.clsA, score: 80, tag: '良好', note: '负责人录的', course: '软笔书法' }, true);
  assert.ok(r.ok, '负责人录入失败：' + (r.msg || ''));
  ids.ownerRec = r.rid;
  // B 班也来一条，用来测「老师看不到别班记录」
  const rb = db.records.save({ sid: ids.stuB1, clsId: ids.clsB, score: 70, tag: '良好', note: 'B 班的记录', course: '硬笔书法' }, true);
  assert.ok(rb.ok);
  ids.bRec = rb.rid;

  const m = db.members.create({ role: 'teacher', name: '陈老师', clsIds: [ids.clsA] });
  assert.ok(m.ok, '老师创建失败：' + (m.msg || ''));
  ids.teacher = m.raw.userId;
  ids.teacherMember = m.item.id;
  const p = db.members.create({ role: 'parent', name: '李妈妈', studentIds: [ids.stuA1] });
  assert.ok(p.ok, '家长创建失败：' + (p.msg || ''));
  ids.parent = p.raw.userId;
  ids.owner = mem['chengguo_v3_users'].find(u => u.role === 'owner').id;
});

ok('T0b 连建多个成员：userId 互不相同（同毫秒也不串号）', () => {
  // 2026-11-06 实测踩到：两个成员同一毫秒创建时，userId 都是 'u'+时间戳 → 撞成同一账号，
  // 后建的人直接变成前一个人的身份。批量导入老师/家长时会真的发生。
  const made = [];
  for (let i = 0; i < 3; i++) {
    const m = db.members.create({ role: 'teacher', name: '临时老师' + i, clsIds: [ids.clsA] });
    assert.ok(m.ok, '第 ' + i + ' 个成员创建失败：' + (m.msg || ''));
    made.push(m.raw.userId);
  }
  assert.strictEqual(new Set(made).size, 3, '3 个成员应有 3 个不同 userId，实际：' + made.join(','));
  made.forEach((uid, i) => {
    const m = db.members.ofUser(uid);
    assert.ok(m, 'userId ' + uid + ' 应能查回成员');
    assert.strictEqual(m.name, '临时老师' + i, '查回的成员应是本人，不应串到别人：' + m.name);
    db.members.remove(m.id);
  });
  assert.strictEqual(db.members.list().filter(x => x.role === 'teacher').length, 1, '清场后应只剩陈老师');
});

/* ================= T1 身份与入口 ================= */
ok('T1a 老师登录：身份是老师，不是管理员（R-01）', () => {
  db.users.switchTo(ids.teacher);
  assert.strictEqual(db.auth.role(), 'teacher', '角色应为 teacher');
  assert.strictEqual(db.auth.roleLabel(), '老师', '界面标签应为「老师」');
  assert.strictEqual(db.auth.isTeacher(), true);
  assert.strictEqual(db.auth.isAdmin(), false, '老师不应被当成管理员');
  assert.strictEqual(db.auth.isOwner(), false);
});

ok('T1b 能力清单：该给的给，不该给的一律不给（R-01）', () => {
  const ab = db.auth.abilities();
  ['student.write', 'record.create', 'record.update', 'record.delete', 'record.send', 'profile.write']
    .forEach(k => assert.strictEqual(ab[k], true, '老师应有 ' + k));
  ['org.manage', 'member.manage', 'term.manage', 'class.write', 'course.write', 'template.write']
    .forEach(k => assert.strictEqual(ab[k], false, '老师不应有 ' + k));
  // 拒绝文案要能直接给用户看，不能让老师看到「无权操作」这种不知所云的话
  assert.strictEqual(db.auth.denyReason('class.write'), '该操作需要管理员权限');
});

ok('T1c 管理页只给 3 个页签，没有「机构」「人员」（R-01）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'pages/mgr/mgr.js'), 'utf8');
  assert.ok(src.indexOf("['机构', '班级', '课程', '学生', '人员']") > -1, '管理级 5 页签定义不见了');
  assert.ok(src.indexOf(": ['班级', '课程', '学生']") > -1, '老师 3 页签定义不见了');
  // 页签序号定位（tabK）在老师这里也必须是 3 个，否则首页统计卡会跳到空白页
  assert.ok(src.indexOf("['cls', 'course', 'stu']") > -1, '老师的 tabK 名单应为 3 项');
});

/* ================= T2 可见范围 ================= */
ok('T2a 班级：只看到自己负责的 A 班（R-02）', () => {
  const list = db.classes.list();
  assert.strictEqual(list.length, 1, '应只看到 1 个班，实际 ' + list.length);
  assert.strictEqual(list[0].id, ids.clsA);
  assert.strictEqual(db.auth.canSeeClass(ids.clsB), false, 'B 班不可见');
});

ok('T2b 学生：只有 A 班 2 人，B 班 2 人看不见（R-02/R-05）', () => {
  const list = db.students.list();
  assert.strictEqual(list.length, 2, '应只看到 2 人，实际 ' + list.length);
  assert.ok(list.every(s => s.clsIds.indexOf(ids.clsA) > -1), '不应混进 B 班学生');
  assert.ok(!list.some(s => s.id === ids.stuB1), '王大力不可见');
  assert.strictEqual(db.students.get(ids.stuB1), null, '按 id 直取 B 班学生应为 null');
  assert.strictEqual(db.students.of(ids.clsB).length, 0, 'B 班名单应为空');
});

ok('T2c 课程：只有 A 班的课（R-02）', () => {
  const list = db.courses.list();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].clsId, ids.clsA);
});

ok('T2d 记录：只有 A 班记录，B 班记录看不到（R-02/R-05）', () => {
  const list = db.records.list();
  assert.ok(list.length > 0);
  assert.ok(list.every(x => x.id !== ids.bRec), '不应看到 B 班的记录');
  assert.ok(list.some(x => x.id === ids.ownerRec), 'A 班记录应可见');
  assert.strictEqual(db.records.get(ids.bRec), null, '按 id 直取 B 班记录应为 null');
});

/* ================= T3 日常主线：录入 → 发布 → 家长收到 ================= */
let tRec = 0;
ok('T3a 发布前置：学生 + 任一内容才让发（H-19）', () => {
  assert.strictEqual(db.canSend({ sid: ids.stuA1 }), false, '只有学生：不可发');
  assert.strictEqual(db.canSend({ sid: ids.stuA2, note: '今天进步了' }), true, '学生+文字：可发');
  assert.strictEqual(db.canSend({ sid: ids.stuA2, photos: ['a.jpg'] }), true, '学生+照片：可发');
});

ok('T3b 存草稿：自己能看到「待发布」（H-21）', () => {
  const r = db.records.save({ sid: ids.stuA2, clsId: ids.clsA, score: 88, tag: '良好', note: '横折有进步', course: '软笔书法' }, false);
  assert.ok(r.ok, '草稿失败：' + (r.msg || ''));
  tRec = r.rid;
  const hit = db.records.list().find(x => x.id === tRec);
  assert.ok(hit, '草稿应在列表里');
  assert.strictEqual(hit.sent, false, '草稿应为未发布');
  // tid 是录入老师（记录署名），own 判定就靠它
  assert.strictEqual(hit.tid, ids.teacher, '记录应署老师自己，实际 tid=' + hit.tid);
});

ok('T3c 发布：状态变已发布（H-22）', () => {
  const r = db.records.markSent(tRec);
  assert.ok(r.ok !== false, '发布失败：' + JSON.stringify(r).slice(0, 120));
  assert.strictEqual(db.records.list().find(x => x.id === tRec).sent, true);
});

ok('T3d 家长端：能看到老师发给自己孩子的那条，看不到另一个孩子的（Q-02/Q-04）', () => {
  // 老师给李思远（家长绑定的孩子）录一条并发布
  const r = db.records.save({ sid: ids.stuA1, clsId: ids.clsA, score: 90, tag: '优秀', note: '给思远的评语', course: '软笔书法' }, true);
  assert.ok(r.ok, '老师给李思远录入失败：' + (r.msg || ''));
  ids.recForStuA1 = r.rid;

  db.users.switchTo(ids.parent);
  const seen = db.records.list();
  assert.ok(seen.some(x => x.id === ids.recForStuA1), '家长应看到老师发给自家孩子的记录');
  assert.ok(!seen.some(x => x.id === tRec), '家长不应看到另一个孩子（周小雨）的记录');
  assert.ok(seen.every(x => x.sent), '家长不应看到任何未发布记录');
  assert.ok(seen.every(x => x.sid === ids.stuA1), '家长只应看到自己孩子');
  db.users.switchTo(ids.teacher);
});

ok('T3e 改自己的记录：分数/评语/照片都能改（I-09/R-03）', () => {
  const r = db.records.save({
    rid: tRec, sid: ids.stuA2, clsId: ids.clsA,
    score: 93, tag: '优秀', note: '改后的评语', photos: ['p1.jpg'], course: '软笔书法'
  }, true);
  assert.ok(r.ok, '老师改自己的记录失败：' + (r.msg || ''));
  const hit = db.records.list().find(x => x.id === tRec);
  assert.strictEqual(hit.score, 93);
  assert.strictEqual(hit.note, '改后的评语');
  assert.deepStrictEqual(hit.photos, ['p1.jpg'], '照片应更新');
});

/* ================= T4 own 边界 ================= */
ok('T4a 别人录的不能改：拦并说清原因（R-04）', () => {
  assert.strictEqual(db.auth.can('record.update', { record: db.records.list().find(x => x.id === ids.ownerRec) }), false);
  const r = db.records.save({ rid: ids.ownerRec, sid: ids.stuA1, clsId: ids.clsA, score: 1, tag: '待提高', note: '越权改' }, false);
  assert.ok(!r.ok, '老师改负责人录的记录必须被拦');
  assert.strictEqual(r.msg, '只能修改自己录入的记录', '拒绝文案应指明原因，实际：' + r.msg);
});

ok('T4b 别人录的不能删（R-04）', () => {
  const r = db.records.remove(ids.ownerRec);
  assert.ok(!r.ok, '老师删负责人录的记录必须被拦');
  assert.ok(db.records.list().some(x => x.id === ids.ownerRec), '记录应还在');
});

ok('T4c 别人录的草稿能不能代发：按当前实现记录行为（R-03）', () => {
  // record.send 只受 scoped 约束、不 own：老师在班里就能代发（家访代发是真实需求）
  db.users.switchTo(ids.owner);
  const d = db.records.save({ sid: ids.stuA1, clsId: ids.clsA, score: 85, tag: '良好', note: '负责人留的草稿' }, false);
  assert.ok(d.ok);
  db.users.switchTo(ids.teacher);
  const can = db.auth.can('record.send', { record: db.records.list().find(x => x.id === d.rid) });
  assert.strictEqual(can, true, '当前设计：本班记录老师可代发（record.send 不限 own）');
  const s = db.records.markSent(d.rid);
  assert.ok(s.ok !== false, '代发失败：' + JSON.stringify(s).slice(0, 120));
});

/* ================= T5 学生管理 ================= */
ok('T5a 在本班加学生：成功且自动分学号（R-06）', () => {
  const r = db.students.create({ name: '孙小满', clsIds: [ids.clsA] });
  assert.ok(r.ok, '本班加学生失败：' + (r.msg || ''));
  assert.ok(r.item.no, '学号应自动生成');
  ids.stuA3 = r.item.id;
  assert.strictEqual(db.students.list().length, 3, '本班名单应变成 3 人');
});

ok('T5b 往别班加学生：拦（R-06）', () => {
  const r = db.students.create({ name: '偷渡学生', clsIds: [ids.clsB] });
  assert.ok(!r.ok, '老师不应能往 B 班加学生');
  assert.ok(/只能在自己负责的班级/.test(r.msg), '拒绝文案应说明范围，实际：' + r.msg);
  // 混着传也要拦（A+B）
  const r2 = db.students.create({ name: '混班学生', clsIds: [ids.clsA, ids.clsB] });
  assert.ok(!r2.ok, '混班新建（含别班）必须被拦');
});

ok('T5c 改本班学生资料：成功（R-06）', () => {
  const r = db.students.update(ids.stuA2, { name: '周小雨', parent: '周妈妈', wechat: 'zhou_mm' });
  assert.ok(r.ok, '改本班学生失败：' + (r.msg || ''));
  assert.strictEqual(db.students.get(ids.stuA2).parent, '周妈妈');
});

ok('T5d 改别班学生：拦（R-06）', () => {
  const r = db.students.update(ids.stuB1, { name: '被改的名字' });
  assert.ok(!r.ok, '老师不应能改 B 班学生');
});

ok('T5e 删本班学生：按当前实现允许，且进回收站可恢复（R-06/N-03）', () => {
  const r = db.students.remove(ids.stuA3);
  assert.strictEqual(r.ok, true, '当前设计：老师可删本班学生（删错能在回收站恢复）');
  assert.strictEqual(db.students.list().length, 2);
  const tr = db.trash.list('students');
  assert.ok(tr.items.some(x => x.id === ids.stuA3), '被删学生应进回收站');
  const rs = db.trash.restore('students', ids.stuA3);
  assert.ok(rs.ok, '恢复失败：' + (rs.msg || ''));
  assert.strictEqual(db.students.list().length, 3, '恢复后应回来');
});

ok('T5f 删别班学生：拦（R-06）', () => {
  const r = db.students.remove(ids.stuB1);
  assert.ok(!r.ok, '老师不应能删 B 班学生');
  db.users.switchTo(ids.owner);
  assert.ok(db.students.get(ids.stuB1), 'B 班学生应还在');
  db.users.switchTo(ids.teacher);
});

/* ================= T6 管理级操作全拦 ================= */
ok('T6a 改机构名：拦，文案是「该操作需要管理员权限」（R-01）', () => {
  const r = db.orgs.update({ name: '老师偷偷改的名字' });
  assert.ok(!r.ok, '老师不应能改机构名');
  assert.strictEqual(r.msg, '该操作需要管理员权限');
});

ok('T6b 建成员/学期/班级/课程/模板：逐个拦（R-01）', () => {
  assert.ok(!db.members.create({ role: 'teacher', name: '老师自己拉的人' }).ok, '不应能建成员');
  assert.ok(!db.terms.create({ name: '偷偷加的学期', startDate: '2026-01-01', endDate: '2026-06-30' }).ok, '不应能建学期');
  assert.ok(!db.classes.create({ name: '偷偷加的班', termId: ids.termId }).ok, '不应能建班级');
  assert.ok(!db.courses.create({ name: '偷偷加的课', clsId: ids.clsA }).ok, '不应能建课程');
  assert.ok(!db.templates.create({ title: '偷偷加的模板' }).ok, '不应能建模板');
});

ok('T6c 改本班班级信息：拦（班级管理属管理级）', () => {
  const r = db.classes.update(ids.clsA, { name: '陈老师改的班名' });
  assert.ok(!r.ok, '老师不应能改班级信息');
  assert.strictEqual(db.classes.get(ids.clsA).name, '软笔基础班', '班名应保持原样');
});

/* ================= T7 没有班级的老师：fail-closed ================= */
ok('T7a 建「不带班的老师」：数据层直接拦，不允许产生看不见任何东西的账号（R-02）', () => {
  db.users.switchTo(ids.owner);
  const m = db.members.create({ role: 'teacher', name: '新来的老师' });
  assert.strictEqual(m.ok, false, '不应允许创建不带班的老师');
  assert.ok(/至少分配一个班级/.test(m.msg), '拒绝文案应说明原因，实际：' + m.msg);
  assert.ok(!db.members.list().some(x => x.name === '新来的老师'), '不应留下半成品账号');
});

ok('T7b 老师被调离所有班级：要么拦，要么立刻什么都看不到（不留可见残留）', () => {
  db.users.switchTo(ids.owner);
  const r = db.members.update(ids.teacherMember, { clsIds: [] });
  if (r.ok) {
    // 允许清空：那必须立刻 fail-closed，一条数据都不能再看
    db.users.switchTo(ids.teacher);
    assert.strictEqual(db.classes.list().length, 0, '调离后不应还能看到班级');
    assert.strictEqual(db.students.list().length, 0, '调离后不应还能看到学生');
    assert.strictEqual(db.records.list().length, 0, '调离后不应还能看到记录');
    const w = db.records.save({ sid: ids.stuA1, clsId: ids.clsA, score: 90, note: '被调离后越权' }, false);
    assert.ok(!w.ok, '调离后不应还能录入');
  } else {
    assert.ok(/至少分配一个班级/.test(r.msg), '要么拦住，要么彻底不可见；实际拒绝文案：' + r.msg);
  }
  // 复原，后面的用例继续用陈老师
  db.users.switchTo(ids.owner);
  const back = db.members.update(ids.teacherMember, { clsIds: [ids.clsA] });
  assert.ok(back.ok, '恢复班级失败：' + (back.msg || ''));
  db.users.switchTo(ids.teacher);
  assert.strictEqual(db.students.list().length, 3, '恢复后应重新看到本班 3 人');
});

/* ================= T8 回收站越界检查 ================= */
ok('T8a 回收站：老师看到的删除项不应包含别班学生（越界检查）', () => {
  db.users.switchTo(ids.owner);
  const del = db.students.remove(ids.stuB1);   // 负责人在 B 班删一个
  assert.ok(del.ok, '负责人删 B 班学生失败');
  db.users.switchTo(ids.teacher);
  const tr = db.trash.list('students');
  const leak = tr.items.filter(x => x.id === ids.stuB1);
  assert.strictEqual(leak.length, 0,
    '老师不应在回收站看到别班学生（B 班「王大力」泄露；回收站里是姓名与评语，属敏感数据）');
});

ok('T8b 回收站：老师能恢复本班删掉的学生', () => {
  db.users.switchTo(ids.teacher);
  const mine = db.trash.list('students').items;
  assert.ok(mine.length >= 0);
  // 本班刚恢复过孙小满，这里再造一个：删 → 回收站里能看到 → 恢复
  const c = db.students.create({ name: '临时学生', clsIds: [ids.clsA] });
  assert.ok(c.ok);
  assert.ok(db.students.remove(c.item.id).ok);
  const list = db.trash.list('students').items;
  assert.ok(list.some(x => x.id === c.item.id), '本班删除项应可见');
  const rs = db.trash.restore('students', c.item.id);
  assert.ok(rs.ok, '恢复本班学生失败：' + (rs.msg || ''));
});

ok('T8c 回收站：老师恢复别班学生被拦（写权限同样按范围判）', () => {
  db.users.switchTo(ids.teacher);
  const r = db.trash.restore('students', ids.stuB1);
  assert.strictEqual(r.ok, false, '老师不应能恢复别班学生');
  db.users.switchTo(ids.owner);
  assert.ok(!db.students.list().some(s => s.id === ids.stuB1), 'B 班学生仍应在回收站里');
  db.users.switchTo(ids.teacher);
});

console.log('\n全部 ' + pass + ' 项老师角色断言通过');
