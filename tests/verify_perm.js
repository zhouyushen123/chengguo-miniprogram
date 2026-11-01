// tests/verify_perm.js —— 机构权限模型验证
// 用真实模块跑，不 mock 业务逻辑：wx 只提供存储与提示接口。
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;

function ok(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// 每个用例用独立存储与独立模块实例，避免互相污染
function boot(seed) {
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k];
  });
  const mem = seed || {};
  global.wx = {
    getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
    setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
    removeStorageSync: k => { delete mem[k]; },
    showToast: () => {}, showModal: () => {}, setNavigationBarTitle: () => {}, navigateBack: () => {}
  };
  const db = require(path.join(ROOT, 'utils/db'));
  db.init();
  return { db, mem };
}

/* ---------------- 造一份 v3 老数据（升级前的真实结构） ---------------- */
function v3Seed() {
  const t = Date.now();
  return {
    'chengguo_v3_meta': { version: 3, orgId: 'org1', teacher: '周老师', me: 't1', demoVersion: 5, createdAt: t, updatedAt: t },
    'chengguo_v3_classes': [
      { id: 1, name: '书法班', sort: 0, orgId: 'org1', createdAt: t, updatedAt: t, removed: false },
      { id: 2, name: '素描班', sort: 1, orgId: 'org1', createdAt: t, updatedAt: t, removed: false }
    ],
    'chengguo_v3_courses': [
      { id: 1, name: '楷书', clsId: 1, orgId: 'org1', createdAt: t, updatedAt: t, removed: false },
      { id: 2, name: '素描', clsId: 2, orgId: 'org1', createdAt: t, updatedAt: t, removed: false }
    ],
    'chengguo_v3_students': [
      { id: 101, name: '周小明', clsIds: [1], parent: '周妈妈', wechat: 'zxm', profile: {}, orgId: 'org1', createdAt: t, updatedAt: t, removed: false },
      { id: 102, name: '李小红', clsIds: [1, 2], parent: '', wechat: '', profile: {}, orgId: 'org1', createdAt: t, updatedAt: t, removed: false },
      { id: 103, name: '王大力', clsIds: [2], parent: '', wechat: '', profile: {}, orgId: 'org1', createdAt: t, updatedAt: t, removed: false }
    ],
    'chengguo_v3_records': [
      { id: 201, sid: 101, cid: 1, course: '楷书', date: '2026-10-01', score: 92, tag: '优秀', note: 'a', photos: ['p1.jpg'], videos: [], audio: null, sent: true, tid: 't1', orgId: 'org1', createdAt: t, updatedAt: t, removed: false },
      { id: 202, sid: 101, cid: 1, course: '楷书', date: '2026-10-08', score: 85, tag: '良好', note: 'b', photos: [], videos: [], audio: null, sent: false, tid: 't1', orgId: 'org1', createdAt: t, updatedAt: t, removed: false },
      { id: 203, sid: 102, cid: 2, course: '素描', date: '2026-10-09', score: 78, tag: '加油', note: 'c', photos: [], videos: [], audio: null, sent: true, tid: 't1', orgId: 'org1', createdAt: t, updatedAt: t, removed: false },
      { id: 204, sid: 103, cid: 2, course: '素描', date: '2026-10-10', score: 95, tag: '最佳', note: 'd', photos: [], videos: [], audio: null, sent: true, tid: 't1', orgId: 'org1', createdAt: t, updatedAt: t, removed: false },
      { id: 205, sid: 102, cid: 1, course: '楷书', date: '2026-10-11', score: 88, tag: '良好', note: 'e', photos: [], videos: [], audio: null, sent: false, tid: 't2', orgId: 'org1', createdAt: t, updatedAt: t, removed: false }
    ],
    'chengguo_v3_users': [
      // 旧版老师没有 clsIds —— 靠"空 = 全放行"，升级时必须显式补全
      { id: 't1', name: '周老师', role: 'teacher', clsIds: [], courseIds: [], studentIds: [], orgId: 'org1', createdAt: t, updatedAt: t, removed: false },
      { id: 't2', name: '陈老师', role: 'teacher', clsIds: [2], courseIds: [], studentIds: [], orgId: 'org1', createdAt: t, updatedAt: t, removed: false },
      { id: 'p1', name: '周妈妈', role: 'parent', clsIds: [], courseIds: [], studentIds: [101], orgId: 'org1', createdAt: t, updatedAt: t, removed: false }
    ],
    'chengguo_v3_templates': [
      { id: 1, name: '上课态度', options: ['认真'], sort: 0, orgId: 'org1', createdAt: t, updatedAt: t, removed: false }
    ]
  };
}

console.log('\n【1】v3 → v4 升级：数据一条都不能丢');
{
  const { db } = boot(v3Seed());
  ok('版本升到 4', () => assert.strictEqual(db.settings().version, 4));
  ok('45 类学生记录数完整保留', () => {
    assert.strictEqual(db.raw().students.length, 3);
    assert.strictEqual(db.raw().records.length, 5);
    assert.strictEqual(db.raw().classes.length, 2);
    assert.strictEqual(db.raw().courses.length, 2);
    assert.strictEqual(db.raw().templates.length, 1);
  });
  ok('学生 id 原样不动（家长绑定不失效）', () =>
    assert.deepStrictEqual(db.raw().students.map(s => s.id).sort(), [101, 102, 103]));
  ok('记录 id 与归属原样不动', () =>
    assert.deepStrictEqual(db.raw().records.map(r => r.id).sort(), [201, 202, 203, 204, 205]));
  ok('机构表已生成，负责人是第一个老师', () => {
    const o = db.orgs.current();
    assert.ok(o, '机构不存在');
    assert.strictEqual(o.ownerId, 't1');
  });
  ok('权限从 user 搬到 member', () => {
    assert.strictEqual(db.members.list().length, 3);
    const u = db.raw().users[0];
    assert.strictEqual(u.clsIds, undefined, 'user 上不该再留 clsIds');
  });
  ok('首个老师升为负责人，其余保持老师', () => {
    const m1 = db.members.ofUser('t1'), m2 = db.members.ofUser('t2');
    assert.strictEqual(m1.role, 'owner');
    assert.strictEqual(m2.role, 'teacher');
  });
  ok('旧版"空班级=全放行"被显式展开，老师升级后不会突然瞎', () => {
    const m1 = db.members.ofUser('t1');
    assert.deepStrictEqual(m1.clsIds.sort(), [1, 2]);
  });
}

console.log('\n【2】身份与可见范围');
{
  const { db } = boot(v3Seed());
  ok('负责人全可见', () => {
    assert.strictEqual(db.auth.actor().all, true);
    assert.strictEqual(db.classes.list().length, 2);
    assert.strictEqual(db.records.list().length, 5);
  });

  db.users.switchTo('t2');
  ok('陈老师只带素描班 → 只看到 1 个班', () =>
    assert.deepStrictEqual(db.classes.list().map(c => c.name), ['素描班']));
  ok('按记录所属班级过滤，不是按学生', () => {
    const ids = db.records.list().map(r => r.id).sort();
    // 203(素描) 204(素描) 可见；205 是李小红在书法班的记录 → 不可见
    assert.deepStrictEqual(ids, [203, 204]);
  });
  ok('跨班学生仍可见（李小红在素描班）', () =>
    assert.deepStrictEqual(db.students.list().map(s => s.name).sort(), ['李小红', '王大力']));
  ok('不能改别的班的学生', () => {
    const r = db.students.update(101, { name: '改名字' });
    assert.strictEqual(r.ok, false);
  });
  ok('不能加课程到别的班', () => {
    const r = db.courses.create({ name: '越权课', clsId: 1 });
    assert.strictEqual(r.ok, false);
  });

  db.users.switchTo('p1');
  ok('家长只看到自己孩子', () =>
    assert.deepStrictEqual(db.students.list().map(s => s.name), ['周小明']));
  ok('家长看不到未发送的草稿（隐私核心）', () => {
    const ids = db.records.list().map(r => r.id);
    assert.deepStrictEqual(ids, [201], '只应看到已发送的 201，实际 ' + JSON.stringify(ids));
  });
  ok('家长不能录入', () => {
    const r = db.records.save({ sid: 101, cls: 1, course: '楷书', note: 'x' }, false);
    assert.strictEqual(r.ok, false);
  });
  ok('家长可以填自己孩子的资料', () => {
    const r = db.students.updateProfile(101, { nick: '小明' });
    assert.strictEqual(r.ok, true);
  });
  ok('家长不能填别人孩子的资料', () => {
    const r = db.students.updateProfile(103, { nick: 'x' });
    assert.strictEqual(r.ok, false);
  });
  ok('家长不能管理班级', () => {
    assert.strictEqual(db.classes.create({ name: '新班' }).ok, false);
  });
}

console.log('\n【3】老师只能改自己录的（记录归属）');
{
  const { db } = boot(v3Seed());
  db.users.switchTo('t2');
  // t2 带素描班：203 是 t1 录的，205 是 t2 录的但属书法班
  ok('不能改别人录的记录', () => {
    const r = db.records.save({ rid: 203, sid: 102, cls: 2, note: '偷偷改' }, false);
    assert.strictEqual(r.ok, false);
    assert.ok(/自己录入/.test(r.msg), '提示语应说明原因，实际：' + r.msg);
  });
  ok('负责人可以改任何人录的记录', () => {
    db.users.switchTo('t1');
    const r = db.records.save({ rid: 203, sid: 102, cls: 2, course: '素描', note: '负责人修正' }, false);
    assert.strictEqual(r.ok, true);
  });
}

console.log('\n【4】fail-closed：没有授权就看不到，而不是全放行');
{
  const { db } = boot(v3Seed());
  // 模拟脏数据 / 云端异常：某个老师的分工被清空
  const m = db.members.ofUser('t2');
  m.clsIds = [];
  db.users.switchTo('t2');
  ok('老师分工为空 → 看不到任何班级', () =>
    assert.strictEqual(db.classes.list().length, 0));
  ok('老师分工为空 → 看不到任何学生与记录', () => {
    assert.strictEqual(db.students.list().length, 0);
    assert.strictEqual(db.records.list().length, 0);
  });
  ok('老师分工为空 → 不能凭空录入', () => {
    const r = db.records.save({ sid: 101, cls: 1, note: 'x' }, false);
    assert.strictEqual(r.ok, false);
  });
}

console.log('\n【5】引用完整性：删班级 / 删学生不留悬空授权');
{
  const { db } = boot(v3Seed());
  db.classes.remove(2);
  ok('删班级后成员授权同步摘除', () => {
    const m2 = db.members.ofUser('t2');
    assert.deepStrictEqual(m2.clsIds, [], '陈老师应已失去素描班');
  });
  ok('删班级后该班课程一并软删', () =>
    assert.strictEqual(db.courses.of(2).length, 0));

  db.students.remove(101);
  ok('删学生后家长绑定同步摘除', () => {
    const p = db.members.ofUser('p1');
    assert.deepStrictEqual(p.studentIds, []);
  });
  ok('删学生后家长看不到任何孩子', () => {
    db.users.switchTo('p1');
    assert.strictEqual(db.students.list().length, 0);
    assert.strictEqual(db.records.list().length, 0);
  });
}

console.log('\n【6】成员管理权限与约束');
{
  const { db } = boot(v3Seed());
  ok('老师不能管理成员', () => {
    db.users.switchTo('t2');
    assert.strictEqual(db.members.create({ name: '新人', role: 'teacher', clsIds: [2] }).ok, false);
  });
  ok('负责人可以加成员', () => {
    db.users.switchTo('t1');
    const r = db.members.create({ name: '新老师', role: 'teacher', clsIds: [1] });
    assert.strictEqual(r.ok, true);
  });
  ok('不能再加一个负责人（会造成权限真空）', () => {
    const r = db.members.create({ name: '第二负责人', role: 'owner', clsIds: [1] });
    assert.strictEqual(r.ok, false);
  });
  ok('老师不给班级会被拒（避免建出空权限账号）', () => {
    const r = db.members.create({ name: '无班老师', role: 'teacher', clsIds: [] });
    assert.strictEqual(r.ok, false);
  });
  ok('负责人不能被移除', () => {
    const m1 = db.members.ofUser('t1');
    assert.strictEqual(db.members.remove(m1.id).ok, false);
  });
  ok('同一人不能重复加入同一机构', () => {
    const r = db.members.create({ name: '周老师', role: 'teacher', clsIds: [1], userId: 't1' });
    assert.strictEqual(r.ok, false);
  });
}

console.log('\n【7】机构信息');
{
  const { db } = boot(v3Seed());
  ok('改名成功并落到 meta', () => {
    const r = db.orgs.update({ name: '橙果美术' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(db.settings().orgName, '橙果美术');
  });
  ok('老师不能改机构信息', () => {
    db.users.switchTo('t2');
    assert.strictEqual(db.orgs.update({ name: '乱改' }).ok, false);
  });
}

console.log('\n【8】全新安装（无任何历史数据）');
{
  const { db } = boot({});
  ok('默认班级与成员就绪', () => {
    assert.strictEqual(db.classes.list().length, 2);
    assert.strictEqual(db.settings().role, 'owner');
  });
  ok('演示数据入库 45 学生', () => assert.strictEqual(db.students.list().length, 45));
  ok('负责人能看到全部记录', () => assert.ok(db.records.list().length > 0));
  ok('家长演示账号已绑定孩子', () => {
    const p = db.members.list().find(m => m.role === 'parent');
    assert.ok(p.studentIds.length > 0, '应绑定至少一个孩子');
    assert.strictEqual(p.status, 'active');
  });
}

console.log('\n【9】二次启动：不重复迁移、不重复播种');
{
  const seed = v3Seed();
  const { mem } = boot(seed);
  const { db } = boot(Object.assign({}, mem, { 'chengguo_v3_meta': JSON.parse(JSON.stringify(mem['chengguo_v3_meta'])) }));
  // 第二次启动时 storage 里的数据和第一次落盘一致
  const { db: db2 } = boot(JSON.parse(JSON.stringify(mem)));
  ok('重启后学生数不变（没有翻倍）', () => assert.strictEqual(db2.students.list().length, 3));
  ok('重启后记录数不变', () => assert.strictEqual(db2.records.list().length, 5));
  ok('重启后成员数不变', () => assert.strictEqual(db2.members.list().length, 3));
  ok('重启后版本仍是 4', () => assert.strictEqual(db2.settings().version, 4));
}

console.log('\n' + (fail ? ('✗ ' + fail + ' 项失败，' + pass + ' 项通过') : ('全部 ' + pass + ' 项权限断言通过')));
process.exit(fail ? 1 : 0);
