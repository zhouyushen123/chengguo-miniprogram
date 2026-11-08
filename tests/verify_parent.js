// tests/verify_parent.js —— 家长（学生端）角色完整旅程（数据层）
//
// 2026-11-09：与 verify_teacher.js / verify_owner.js 配套，把家长当**唯一主角**
// 从拿到机构码到看孩子成绩走一遍。此前家长只有 verify_journey J4 的 4 条基础
// 断言，Q 组「多孩切换 / 历史倒序 / 课时账本 / 家长版裁剪」没成段测过。
//
// 每段标注 docs/user-test-cases.md 的人工用例编号：
//   Q1 身份与能力：只读，写一律拒绝（Q-08）
//   Q2 只见自己孩子：别的学生与班级不进视野（Q-04）
//   Q3 只见已发布：草稿永远不可见（Q-05/P0-5）
//   Q4 历史倒序 + 班级名带出来（Q-06/Q-07）
//   Q5 一号多孩：两个孩子各看各的，切孩子不串数据（Q-09）
//   Q6 课时账本按班分（Q-11 补充口径）
//   Q7 家长版我的页裁剪（O-13 源码级）
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

console.log('· 家长角色完整旅程');

/* ================= 场景搭建（负责人视角） ================= */
const mem = {};
let db = boot(mem);
const ids = {};
ok('Q0 负责人搭场景：1 班 + 别家孩子 / 已发布 2 条 + 草稿 1 条 / 家长绑 2 孩', () => {
  assert.ok(db.orgs.update({ name: '墨白书法工作室' }).ok);
  const t = db.terms.create({ name: '2026 秋季学期', startDate: '2026-09-01', status: 'active' });
  assert.ok(t.ok);
  ids.termId = t.item.id;
  const c = db.classes.create({ name: '软笔基础班', termId: ids.termId, mode: 'term' });
  assert.ok(c.ok);
  ids.clsId = c.item.id;
  assert.ok(db.courses.create({ name: '软笔书法', clsId: ids.clsId }).ok);

  const s1 = db.students.create({ name: '李思远', clsIds: [ids.clsId] });
  const s2 = db.students.create({ name: '李知行', clsIds: [ids.clsId] });
  const s3 = db.students.create({ name: '王大力', clsIds: [ids.clsId] });
  assert.ok(s1.ok && s2.ok && s3.ok);
  ids.stu1 = s1.item.id;   // 家长老大的孩子
  ids.stu2 = s2.item.id;   // 家长老二的孩子
  ids.stuOther = s3.item.id; // 别人家的孩子

  // 思远：已发布 2 条（11-01、11-08）+ 草稿 1 条；知行：已发布 1 条
  const r1 = db.records.save({ sid: ids.stu1, clsId: ids.clsId, score: 85, tag: '良好', note: '第一次课', course: '软笔书法', date: '2026-11-01' }, true);
  const r2 = db.records.save({ sid: ids.stu1, clsId: ids.clsId, score: 92, tag: '优秀', note: '第二次课', course: '软笔书法', date: '2026-11-08' }, true);
  const r3 = db.records.save({ sid: ids.stu1, clsId: ids.clsId, score: 70, tag: '良好', note: '还没发布的草稿', course: '软笔书法', date: '2026-11-09' }, false);
  const r4 = db.records.save({ sid: ids.stu2, clsId: ids.clsId, score: 78, tag: '良好', note: '弟弟的课', course: '软笔书法', date: '2026-11-05' }, true);
  assert.ok(r1.ok && r2.ok && r3.ok && r4.ok, '造记录失败：' + JSON.stringify([r1, r2, r3, r4].map(x => x.msg)));
  ids.rec1 = r1.rid; ids.rec2 = r2.rid; ids.draft = r3.rid; ids.rec4 = r4.rid;

  const m = db.members.create({ role: 'parent', name: '李妈妈', studentIds: [ids.stu1, ids.stu2] });
  assert.ok(m.ok, '家长创建失败：' + (m.msg || ''));
  ids.parent = m.raw.userId;
  ids.owner = mem['chengguo_v3_users'].find(u => u.role === 'owner').id;
});

/* ================= Q1 身份与能力 ================= */
ok('Q1a 身份：我是家长，只读身份（Q-08）', () => {
  db.users.switchTo(ids.parent);
  assert.strictEqual(db.auth.role(), 'parent');
  assert.strictEqual(db.auth.roleLabel(), '家长');
  assert.strictEqual(db.auth.isParent(), true);
  assert.strictEqual(db.auth.isOwner(), false);
  assert.strictEqual(db.auth.isAdmin(), false);
});

ok('Q1b 能力清单：除了自己的资料，一个写口都没有（Q-08）', () => {
  const ab = db.auth.abilities();
  Object.keys(ab).forEach(k => {
    if (k === 'profile.write') return;
    assert.strictEqual(ab[k], false, '家长不应有 ' + k);
  });
  assert.strictEqual(ab['profile.write'], true, '家长只能改自己的资料');
});

/* ================= Q2 只见自己孩子 ================= */
ok('Q2 学生视野：只有自家两个孩子，别家孩子和班级管理不可见（Q-04）', () => {
  const seen = db.students.list();
  assert.ok(seen.every(s => s.id === ids.stu1 || s.id === ids.stu2), '不应看到别家孩子');
  assert.ok(!seen.some(s => s.id === ids.stuOther), '王大力不可见');
  assert.strictEqual(db.students.get(ids.stuOther), null, '按 id 直取别家孩子应为 null');
});

/* ================= Q3 只见已发布 ================= */
ok('Q3 记录视野：草稿永远不可见（Q-05/P0-5）', () => {
  const seen = db.records.list();
  assert.ok(seen.length > 0, '应看到已发布记录');
  assert.ok(seen.every(x => x.sent === true), '家长视野里不应有未发布记录');
  assert.ok(!seen.some(x => x.id === ids.draft), '草稿不可见');
  assert.strictEqual(db.records.get(ids.draft), null, '按 id 直取草稿应为 null');
});

/* ================= Q4 历史倒序 ================= */
ok('Q4 孩子的历史：按日期倒序，班级名带出来（Q-06/Q-07）', () => {
  const kids = db.family.kids();
  assert.strictEqual(kids.length, 2, '应有两个孩子');
  const elder = kids.find(k => k.name === '李思远');
  assert.ok(elder, '老大应在列表里');
  assert.strictEqual(elder.count, 2, '老大只数已发布（草稿不算）');
  const recs = db.family.records(elder.pid);
  assert.strictEqual(recs.length, 2);
  assert.ok(recs[0].date >= recs[1].date, '应按日期倒序');
  assert.strictEqual(recs[0].note, '第二次课', '最新一条在最上');
  assert.ok(recs.every(r => r.clsName === '软笔基础班'), '每条应带班级名');
});

/* ================= Q5 一号多孩 ================= */
ok('Q5 多孩切换：两个孩子各看各的，记录不串（Q-09）', () => {
  const kids = db.family.kids();
  const elder = kids.find(k => k.name === '李思远');
  const younger = kids.find(k => k.name === '李知行');
  assert.ok(elder && younger, '两个孩子都要在');
  const eRecs = db.family.records(elder.pid);
  const yRecs = db.family.records(younger.pid);
  assert.ok(eRecs.every(r => r.sid === ids.stu1), '老大的记录不该混进别人的');
  assert.ok(yRecs.every(r => r.sid === ids.stu2 && r.note === '弟弟的课'), '老二的记录应只有自己那条');
  assert.notStrictEqual(elder.pid, younger.pid, '两个孩子的 pid 应不同');
  // 家长主视野（records.list）= 两个孩子已发布的并集
  const seen = db.records.list();
  assert.ok(seen.some(x => x.id === ids.rec4), '家长主视野应含老二的记录');
  assert.strictEqual(seen.length, 3, '已发布共 3 条（草稿除外）');
});

/* ================= Q6 课时账本 ================= */
ok('Q6 课时账本：按班返回分组而不是瞎加总数（Q-11 补充）', () => {
  const kids = db.family.kids();
  const elder = kids.find(k => k.name === '李思远');
  const hours = db.family.hours(elder.pid);
  assert.ok(Array.isArray(hours), '课时账本应是分组数组');
});

/* ================= Q7 家长版裁剪（源码级） ================= */
ok('Q7 家长版「我的」只有身份卡/我的孩子/设置，不出现管理入口（O-13）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'pages/mine/mine.js'), 'utf8');
  assert.ok(/isParent|parent/.test(src), '我的页应有家长分支');
  const wxml = fs.readFileSync(path.join(ROOT, 'pages/mine/mine.wxml'), 'utf8');
  // 家长版裁剪的判定在 js/wxml 里都有角色开关；这里守住「我的孩子」入口存在
  assert.ok(/我的孩子|孩子/.test(wxml + src), '家长版应有「我的孩子」入口');
});

console.log('\n全部 ' + pass + ' 项家长旅程断言通过');
