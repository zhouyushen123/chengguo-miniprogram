// tests/verify_journey.js —— 用户旅程端到端（数据层）
//
// 2026-11-06 第二轮重测：单点套件（权限/备份/同步…）各自都绿，但没人验证
// 「一条真实使用路径从头走到尾不串味」。这里把 docs/user-test-cases.md 里
// 可自动化的核心旅程按用户操作顺序串起来跑，每段标注对应的人工用例编号，
// 人工测试时失败可先看这里是否已红。
//
// 覆盖旅程（括号内是 user-test-cases.md 的编号）：
//   J1 开通四步 + 重启不丢（A-09~A-12, P0-6）
//   J2 首页统计与标题（B-01, P0-2）
//   J3 录入：发布前置三分支 → 草稿 → 修改 → 发布（H-19/21/22/23, I-10）
//   J4 家长视角：只见已发布、只见自己孩子、不可改（Q-04/05/08, P0-5）
//   J5 老师视角：只见本班、只改自己（R-02/04/03）
//   J6 删除学生 → 回收站恢复（N-03, F-14）
//   J7 本地备份 → 删学生 → 从备份恢复（P-08/P-09）
//   J8 本机数据计数只数有效行（P-11）
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

// 独立存储 + 独立模块实例；同一份 mem 可以"重启"（模拟杀掉小程序再打开）
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

console.log('· 用户旅程端到端');

/* ================= J1 开通四步 + 重启不丢 ================= */
const mem = {};
let db = boot(mem);
ok('J1a 向导第 1 步：机构名校验与保存（A-04/A-05/A-06 等价）', () => {
  // 长度校验在向导页面（name.length < 2），数据层 checkName 走 schema 校验
  const fs2 = require('fs');
  const setupSrc = fs2.readFileSync(path.join(ROOT, 'pages/setup/setup.js'), 'utf8');
  assert.ok(setupSrc.indexOf('name.length < 2') > -1, '向导应有「至少 2 个字」校验（A-05）');
  const phoneErr = fs2.readFileSync(path.join(ROOT, 'pages/setup/setup.js'), 'utf8');
  assert.ok(/11 位/.test(phoneErr), '向导应有手机号 11 位校验提示（A-06）');
  assert.ok(db.orgs.checkName('墨白书法工作室') === '', '正常机构名应通过 checkName');
  const up = db.orgs.update({ name: '墨白书法工作室' });
  assert.ok(up.ok, '机构保存失败：' + (up.msg || ''));
});
let termId, clsId, stuId;
ok('J1b 第 2 步：建学期（A-09）', () => {
  const r = db.terms.create({ name: '2026 秋季学期', startDate: '2026-09-01', endDate: '2027-01-20', status: 'active' });
  assert.ok(r.ok, '学期创建失败：' + (r.msg || ''));
  termId = r.item.id;
});
ok('J1c 第 3 步：建班 + 第一门课程（A-10）', () => {
  const c = db.classes.create({ name: '书法提高班', termId, mode: 'term' });
  assert.ok(c.ok, '班级创建失败：' + (c.msg || ''));
  clsId = c.item.id;
  const cr = db.courses.create({ name: '软笔书法', clsId });
  assert.ok(cr.ok, '课程创建失败：' + (cr.msg || ''));
});
ok('J1d 第 4 步：加学生（A-11/A-12）', () => {
  const s = db.students.create({ name: '李思远', clsIds: [clsId] });
  assert.ok(s.ok, '学生创建失败：' + (s.msg || ''));
  stuId = s.item.id;
  assert.ok(s.item.no, '学号应自动生成');
});
ok('J1e 杀掉重开：四要素全在，不用重新开通（P0-6）', () => {
  db = boot(mem);   // 同一份存储重新 init
  assert.strictEqual(db.classes.list().length, 1, '班级丢了');
  assert.strictEqual(db.students.list().length, 1, '学生丢了');
  assert.ok(db.terms.list().some(t => t.name === '2026 秋季学期'), '学期丢了');
  assert.ok(db.auth.actor(), '重启后身份应自动恢复');
  assert.strictEqual(db.settings().orgName, '墨白书法工作室', '机构名丢了');
});

/* ================= J2 首页统计 ================= */
ok('J2 首页统计口径：1 班级 / 1 学生（B-01/P0-2）', () => {
  assert.strictEqual(db.classes.list().length, 1);
  assert.strictEqual(db.students.list().length, 1);
  assert.strictEqual(db.courses.list().length, 1);
});

/* ================= J3 录入发布与修改 ================= */
let recId;
ok('J3a 发布前置三分支（H-19）', () => {
  assert.strictEqual(db.canSend({ sid: stuId }), false, '只有学生没有内容：不可发');
  assert.strictEqual(db.canSend({ sid: 0, note: 'x' }), false, '只有内容没有学生：不可发');
  assert.strictEqual(db.canSend({ sid: stuId, note: '握笔进步明显' }), true, '学生+文字：可发');
  assert.strictEqual(db.canSend({ sid: stuId, photos: ['p.jpg'] }), true, '学生+照片：可发（不需要文字）');
});
ok('J3b 存草稿：不发布、待发布态可见（H-21）', () => {
  const r = db.records.save({ sid: stuId, clsId, score: 85, tag: '良好', note: '今天横折写得好', course: '软笔书法' }, false);
  assert.ok(r.ok, '草稿保存失败：' + (r.msg || ''));
  recId = r.rid;
  const list = db.records.list();
  const hit = list.find(x => x.id === recId);
  assert.ok(hit, '草稿应出现在记录列表');
  assert.strictEqual(hit.sent, false, '草稿应为未发布');
});
ok('J3c 编辑保存：内容更新且保持草稿态（I-09）', () => {
  const r = db.records.save({ rid: recId, sid: stuId, clsId, score: 92, tag: '优秀', note: '改后的评语', course: '软笔书法' }, false);
  assert.ok(r.ok, '编辑失败：' + (r.msg || ''));
  const hit = db.records.list().find(x => x.id === recId);
  assert.strictEqual(hit.score, 92, '分数应已更新');
  assert.strictEqual(hit.note, '改后的评语', '评语应已更新');
  assert.strictEqual(hit.sent, false, '编辑不应误发布');
});
ok('J3d 发布到家长端（H-22/I-10）', () => {
  const r = db.records.markSent(recId);
  assert.ok(r.ok !== false, '发布失败：' + JSON.stringify(r).slice(0, 120));
  const hit = db.records.list().find(x => x.id === recId);
  assert.strictEqual(hit.sent, true, '发布后应为已发布');
});

/* ================= J4 家长视角 ================= */
let parentUserId;
ok('J4a 负责人建家长并绑定孩子（Q-01/Q-02 等价）', () => {
  const m = db.members.create({ role: 'parent', name: '李妈妈', studentIds: [stuId] });
  assert.ok(m.ok, '家长创建失败：' + (m.msg || ''));
  assert.ok(m.item.studentIds && m.item.studentIds.indexOf(stuId) > -1, '孩子应绑定成功');
  parentUserId = m.raw.userId;
});
ok('J4b 家长只看到已发布，草稿不可见（Q-05）', () => {
  // 先补一条草稿
  const d = db.records.save({ sid: stuId, clsId, score: 60, tag: '待提高', note: '还没发布的一条' }, false);
  assert.ok(d.ok, '草稿创建失败');
  db.users.switchTo(parentUserId);
  const seen = db.records.list();
  assert.ok(seen.every(x => x.sent), '家长不应看到任何未发布记录');
  assert.ok(seen.some(x => x.id === recId), '家长应看到已发布的那条');
});
ok('J4c 家长只看到自己孩子（Q-04）', () => {
  db.users.switchTo(parentUserId);
  // 第二个学生不绑给这位家长
  db.users.switchTo(db.auth.actor() && mem['chengguo_v3_users'].find(u => u.role === 'owner').id);
  const s2 = db.students.create({ name: '王大力', clsIds: [clsId] });
  assert.ok(s2.ok, '第二个学生创建失败');
  db.users.switchTo(parentUserId);
  const seen = db.students.list();
  assert.ok(seen.every(s => s.id === stuId), '家长不应看到未绑定的孩子');
});
ok('J4d 家长不可改记录（Q-08）', () => {
  db.users.switchTo(parentUserId);
  const rec = db.records.list().find(x => x.id === recId);
  assert.ok(!db.auth.can('record.update', { record: rec }), '家长不应有修改权限');
  const r = db.records.save({ rid: recId, sid: stuId, clsId, score: 1, tag: '待提高', note: '越权', course: '软笔书法' }, false);
  assert.ok(!r.ok, '家长越权修改必须被拦');
});

/* ================= J5 老师视角 ================= */
let teacherUserId, tRecId;
ok('J5a 负责人建老师并分配本班（G-02）', () => {
  db.users.switchTo(mem['chengguo_v3_users'].find(u => u.role === 'owner').id);
  const m = db.members.create({ role: 'teacher', name: '陈老师', clsIds: [clsId] });
  assert.ok(m.ok, '老师创建失败：' + (m.msg || ''));
  teacherUserId = m.raw.userId;
});
ok('J5b 老师只见本班学生（R-02/R-05）', () => {
  db.users.switchTo(teacherUserId);
  assert.ok(db.students.list().every(s => s.clsIds.indexOf(clsId) > -1), '老师不应看到班外学生');
});
ok('J5c 老师能录能发（R-03）', () => {
  const r = db.records.save({ sid: stuId, clsId, score: 88, tag: '良好', note: '老师录的', course: '软笔书法' }, true);
  assert.ok(r.ok, '老师录入失败：' + (r.msg || ''));
  tRecId = r.rid;
});
ok('J5d 老师只能改自己录的（R-04）', () => {
  const mine = db.records.list().find(x => x.id === tRecId);
  assert.ok(db.auth.can('record.update', { record: mine }), '自己的记录应可改');
  const others = db.records.list().find(x => x.id === recId);
  assert.ok(!db.auth.can('record.update', { record: others }), '负责人录的不应可改');
  const r = db.records.save({ rid: recId, sid: stuId, clsId, score: 1, tag: '待提高', note: '越权', course: '软笔书法' }, false);
  assert.ok(!r.ok, '老师越权修改必须被拦');
});

/* ================= J6 回收站 ================= */
ok('J6 删除学生 → 回收站恢复，记录跟着回来（N-03/F-14）', () => {
  db.users.switchTo(mem['chengguo_v3_users'].find(u => u.role === 'owner').id);
  const before = db.records.list().length;
  const del = db.students.remove(stuId);
  assert.ok(del.ok, '删除失败：' + (del.msg || ''));
  assert.strictEqual(db.students.list().length, 1, '删除后列表应少一人');
  const tr = db.trash.list('students');
  assert.ok(tr.items.some(x => x.id === stuId), '回收站应有该学生');
  const rs = db.trash.restore('students', stuId);
  assert.ok(rs.ok, '恢复失败：' + (rs.msg || ''));
  assert.strictEqual(db.students.list().length, 2, '恢复后应回来');
  assert.ok(db.records.list().length >= before, '学生的记录应跟着回来');
});

/* ================= J7 本地备份/恢复 ================= */
ok('J7 备份 → 删学生 → 从备份恢复（P-08/P-09）', () => {
  const snap = db.snapshots.save('手动备份');
  assert.ok(snap.ok !== false, '备份失败：' + JSON.stringify(snap).slice(0, 120));
  const del = db.students.remove(stuId);
  assert.ok(del.ok, '删除失败');
  assert.strictEqual(db.students.list().length, 1);
  const snaps = db.snapshots.list();
  assert.ok(snaps.length > 0, '快照列表应有记录');
  const target = snaps[0];
  const rs = db.snapshots.restore(target.id);
  assert.ok(rs.ok !== false, '恢复失败：' + JSON.stringify(rs).slice(0, 120));
  assert.ok(db.students.list().some(s => s.name === '李思远'), '恢复后李思远应回来');
});

/* ================= J8 本机数据计数 ================= */
ok('J8 本机数据计数只数有效行，不含已删除（P-11）', () => {
  // 删一个学生制造死行，再对比计数
  const del = db.students.remove(stuId);
  assert.ok(del.ok, '删除失败');
  const row = db.rawCounts().find(x => x.k === 'students');
  assert.ok(row, '计数应含 students');
  assert.strictEqual(row.mine, 1, '本机构有效学生应只剩 1 个，死行不计');
});

console.log('\n全部 ' + pass + ' 项用户旅程断言通过');
