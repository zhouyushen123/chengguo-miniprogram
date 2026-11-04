// tests/verify_demo.js —— 演示数据与真实数据的隔离
//
// 演示数据不再是"真实库里打了 demo 标记的行"，而是磁盘上另一套 key（chengguo_demo_*）
// 里的完整一套数据，靠 core.setMode 切换视图。这套断言守的就是这条边界：
//   1. 真实库里永远不出现演示行（磁盘级检查，不看内存标记）
//   2. 演示模式只读，写不进去也不会把真实 key 改掉
//   3. 退出/重启/重置/版本升级，真实数据一个字节都不动
//   4. 老版本混进真实库的演示行，升级时被请出去且内容不丢（演示包里还有）
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REAL = 'chengguo_v3_';
const DEMO = 'chengguo_demo_';
const COLLS = ['orgs', 'members', 'terms', 'classes', 'courses', 'students', 'enrollments', 'records', 'users', 'templates'];

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// 每个用例独立存储 + 独立模块实例
function boot(seed) {
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k];
  });
  const mem = seed || {};
  global.wx = {
    getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
    setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
    removeStorageSync: k => { delete mem[k]; },
    showToast: () => {}, showModal: () => {},
    setNavigationBarTitle: () => {}, navigateBack: () => {},
    env: { USER_DATA_PATH: '/tmp' },
    getFileSystemManager: () => ({ copyFileSync() {}, accessSync() { throw new Error('ENOENT'); }, mkdirSync() {}, readdirSync() { return []; }, statSync() { return { size: 0 }; } })
  };
  const db = require(path.join(ROOT, 'utils/db'));
  db.init();
  return { db, mem };
}

const realStudents = mem => (mem[REAL + 'students'] || []);
const demoStudents = mem => (mem[DEMO + 'students'] || []);

/* =============================== 1. 全新安装 =============================== */
console.log('\n【1】全新安装：真实库干净，演示数据另存一套');
{
  const { db, mem } = boot({});

  ok('真实库里零学生零记录', () => {
    assert.strictEqual(db.students.list().length, 0);
    assert.strictEqual(db.records.list().length, 0);
    assert.strictEqual(db.settings().sandbox, false, '默认在真实机构，不是样板间');
  });

  ok('演示数据不随安装生成：新用户手机里不躺测试数据，第一屏就是空的', () => {
    assert.strictEqual(demoStudents(mem).length, 0, '安装时不该写演示包');
    assert.strictEqual(db.demo.available(), false, '还没点过，就不该有现成的包');
    assert.strictEqual(Object.keys(mem).filter(k => k.indexOf(DEMO) === 0).length, 0, '演示 key 一个都不该出现');
  });

  ok('点「看演示数据」才现建，并且落在独立 key 上（磁盘级验证，不看内存标记）', () => {
    assert.deepStrictEqual(db.demo.enter(), { ok: true });
    assert.strictEqual(demoStudents(mem).length, 45, '演示包应含 45 个学生');
    assert.ok((mem[DEMO + 'records'] || []).length > 0, '演示包应含记录');
    assert.ok(mem[DEMO + 'meta'], '演示包应带自己的 meta');
    assert.strictEqual(realStudents(mem).length, 0, '真实 key 里不能有一条演示学生');
    assert.strictEqual((mem[REAL + 'records'] || []).length, 0);
    db.demo.exit();
  });

  ok('演示包带全自己的机构/班级/课程/成员，是个能独立渲染的完整世界', () => {
    const m = mem[DEMO + 'meta'];
    assert.strictEqual(m.orgName, '演示机构');
    assert.strictEqual(demoStudents(mem)[0].orgId, m.orgId);
    assert.strictEqual((mem[DEMO + 'classes'] || []).length, 2);
    assert.strictEqual((mem[DEMO + 'courses'] || []).length, 2);
    assert.ok((mem[DEMO + 'members'] || []).length >= 2, '演示包里要有成员，否则权限层看不到东西');
  });
}

/* =============================== 2. 演示模式 =============================== */
console.log('\n【2】演示模式：能看能翻，不能改');
{
  const { db, mem } = boot({});
  const storage = require(path.join(ROOT, 'utils/db/storage'));

  ok('进入演示：机构名/学生/记录都来自演示包', () => {
    assert.deepStrictEqual(db.demo.enter(), { ok: true });
    assert.strictEqual(db.settings().sandbox, true);
    assert.strictEqual(db.settings().orgName, '演示机构');
    assert.strictEqual(db.students.list().length, 45);
    assert.ok(db.records.list().length > 0);
  });

  ok('写操作在闸门上被拒，内存里也不会多出一条', () => {
    const r = db.students.create({ name: '临时学生', clsIds: [1] });
    assert.strictEqual(r.ok, false);
    assert.ok(r.msg.indexOf('演示') > -1, '提示应说明这是演示数据：' + r.msg);
    assert.strictEqual(db.students.list().length, 45);
    const rec = db.records.save({ sid: 101, cls: 1, course: '楷书', note: 'x' }, true);
    assert.strictEqual(rec.ok, false);
    assert.strictEqual(db.students.update(101, { name: '改名' }).ok, false);
    assert.strictEqual(db.students.remove(101).ok, false);
  });

  ok('演示模式下真实 key 一次都没被写过', () => {
    const before = JSON.stringify(mem[REAL + 'students']);
    let writes = 0;
    const orig = storage.saveCollection;
    storage.saveCollection = (...a) => { writes++; return orig.apply(storage, a); };
    db.students.create({ name: '还是不行', clsIds: [1] });
    db.flush();
    storage.saveCollection = orig;
    assert.strictEqual(writes, 0, '演示态不该有任何落盘');
    assert.strictEqual(JSON.stringify(mem[REAL + 'students']), before);
  });

  ok('退出演示：回到自己的机构，演示数据不残留', () => {
    assert.deepStrictEqual(db.demo.exit(), { ok: true });
    assert.strictEqual(db.settings().sandbox, false);
    assert.strictEqual(db.students.list().length, 0);
    assert.strictEqual(db.records.list().length, 0);
    assert.strictEqual(db.settings().orgName, '我的机构');
  });

  ok('退出后可以正常录入，且写的是真实库', () => {
    const r = db.students.create({ name: '李小果', clsIds: [1] });
    assert.strictEqual(r.ok, true, r.msg);
    assert.strictEqual(db.students.list().length, 1);
    assert.strictEqual(realStudents(mem).length, 1);
    assert.strictEqual(realStudents(mem)[0].name, '李小果');
  });
}

/* =============================== 3. 重启 =============================== */
console.log('\n【3】重启：模式与数据都按用户的显式选择来');
{
  const first = boot({});
  first.db.demo.exit();
  first.db.students.create({ name: '李小果', clsIds: [1] });
  const again = boot(first.mem);
  ok('退出演示后重启，不会被塞回演示模式', () => {
    assert.strictEqual(again.db.settings().sandbox, false);
    assert.strictEqual(again.db.students.list().length, 1, '自己录的学生还在');
  });
  ok('演示包建过一次就留在磁盘上：重启仍在，随时可以再看', () => {
    again.db.demo.enter();              // 这批安装没点过演示 → 现建
    assert.strictEqual(again.db.students.list().length, 45);
    again.db.demo.exit();
    assert.strictEqual(again.db.students.list().length, 1);
    const third = boot(again.mem);       // 再启动一次：包已经在磁盘上了
    assert.strictEqual(third.db.demo.available(), true, '建过的包不用重建');
    third.db.demo.enter();
    assert.strictEqual(third.db.students.list().length, 45);
    third.db.demo.exit();
  });
}

/* =============================== 4. 老数据升级 =============================== */
console.log('\n【4】老版本混进真实库的演示数据：请出去，但不丢内容');
{
  const t = Date.now();
  // 模拟上一版：演示学生和真实学生混在同一个 students 集合里，靠 demo 标记区分
  const seed = {
    [REAL + 'meta']: { version: 5, orgId: 'org1', orgName: '我的机构', teacher: '周老师', me: 't1', demoVersion: 6, createdAt: t, updatedAt: t },
    [REAL + 'orgs']: [{ id: 'org1', name: '我的机构', ownerId: 't1', status: 'active', orgId: 'org1', createdAt: t, updatedAt: t, removed: false }],
    [REAL + 'users']: [{ id: 't1', name: '周老师', role: 'owner', orgId: 'org1', createdAt: t, updatedAt: t, removed: false }],
    [REAL + 'members']: [{ id: 1, orgId: 'org1', userId: 't1', role: 'owner', name: '周老师', clsIds: [1], courseIds: [], studentIds: [], status: 'active', createdAt: t, updatedAt: t, removed: false }],
    [REAL + 'terms']: [{ id: 1, name: '长期班', status: 'active', builtIn: true, orgId: 'org1', createdAt: t, updatedAt: t, removed: false }],
    [REAL + 'classes']: [{ id: 1, name: '书法班', termId: 1, orgId: 'org1', createdAt: t, updatedAt: t, removed: false }],
    [REAL + 'courses']: [],
    [REAL + 'students']: [
      { id: 101, name: '演示学生甲', clsIds: [1], demo: true, orgId: 'org1', createdAt: t, updatedAt: t, removed: false },
      { id: 9001, name: '我自己录的', clsIds: [1], orgId: 'org1', createdAt: t, updatedAt: t, removed: false }
    ],
    [REAL + 'records']: [
      { id: 7001, sid: 101, cid: 1, date: '2026-10-01', score: 90, tag: '优秀', tid: 't1', demo: true, orgId: 'org1', createdAt: t, updatedAt: t, removed: false },
      { id: 7002, sid: 9001, cid: 1, date: '2026-10-02', score: 88, tag: '良好', tid: 't1', orgId: 'org1', createdAt: t, updatedAt: t, removed: false }
    ],
    [REAL + 'templates']: []
  };
  const { db, mem } = boot(seed);

  ok('真实库里的演示学生被清出去，自己录的留着', () => {
    assert.strictEqual(realStudents(mem).length, 1);
    assert.strictEqual(realStudents(mem)[0].name, '我自己录的');
    assert.strictEqual(realStudents(mem).some(s => s.demo), false, '磁盘上不能再有 demo 标记的学生');
  });

  ok('挂在演示学生上的记录一并清掉，自己录的记录不动', () => {
    const ids = (mem[REAL + 'records'] || []).map(r => r.id);
    assert.deepStrictEqual(ids, [7002]);
  });

  ok('升级后自动进演示：用户刚才看的就是演示数据，不该突然变空', () => {
    assert.strictEqual(db.settings().sandbox, true);
    assert.strictEqual(db.students.list().length, 45, '演示内容一条没少');
  });

  ok('退出演示就回到只有自己那条数据的真实库', () => {
    db.demo.exit();
    assert.strictEqual(db.students.list().length, 1);
    assert.strictEqual(db.records.list().length, 1);
  });
}

/* =============================== 5. 重置与升版 =============================== */
console.log('\n【5】重置演示数据 / 演示包升版：真实数据不受影响');
{
  const { db, mem } = boot({});
  db.demo.exit();
  db.students.create({ name: '真实学生', clsIds: [1] });
  const realBefore = JSON.stringify(mem[REAL + 'students']);

  ok('重置演示包：演示内容重建，真实 key 一字未改', () => {
    db.demo.enter();
    const r = db.demo.reset();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(db.students.list().length, 45);
    db.demo.exit();
    assert.strictEqual(JSON.stringify(mem[REAL + 'students']), realBefore);
  });

  ok('演示包版本落后时自动重建，同样不碰真实库', () => {
    const stale = JSON.parse(JSON.stringify(mem));
    stale[DEMO + 'meta'].demoVersion = 1;               // 假装这是上一版演示包
    stale[DEMO + 'students'] = stale[DEMO + 'students'].slice(0, 3);  // 内容也旧了
    const b2 = boot(stale);
    assert.strictEqual(demoStudents(b2.mem).length, 45, '应重建到当前版本');
    assert.strictEqual(JSON.stringify(b2.mem[REAL + 'students']), realBefore, '真实数据必须一字不差');
    assert.strictEqual(b2.db.students.list().length, 1);
  });
}

/* =============================== 6. 隔离的边界 =============================== */
console.log('\n【6】隔离的边界：换云端、导出、统计都不会串');
{
  const { db, mem } = boot({});
  db.demo.enter();

  ok('演示模式下云端合并被跳过（不会把演示数据推到真实库）', () => {
    const before = JSON.stringify(mem[REAL + 'records']);
    const changed = db.merge({ records: [{ id: 1, sid: 101, cid: 1, date: '2026-10-01', score: 90, tid: 't1' }] });
    assert.strictEqual(changed, false);
    assert.strictEqual(JSON.stringify(mem[REAL + 'records']), before);
  });

  ok('演示包只存本地：演示 key 与真实 key 完全不同的前缀', () => {
    const demoKeys = Object.keys(mem).filter(k => k.indexOf(DEMO) === 0);
    assert.ok(demoKeys.length >= COLLS.length + 1, '演示包应有全部集合 + meta');
    demoKeys.forEach(k => assert.ok(k.indexOf(DEMO) === 0 && k.indexOf(REAL) !== 0));
  });
}

console.log('\n' + (fail ? ('✗ ' + fail + ' 项失败，' + pass + ' 项通过') : ('全部 ' + pass + ' 项演示隔离断言通过')));
process.exit(fail ? 1 : 0);
