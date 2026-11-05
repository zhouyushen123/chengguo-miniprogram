// tests/verify_backup.js —— 核心资产（学生 / 老师 / 机构）的抗损坏与可恢复
//
// 这一套不测"正常能不能用"，只测"出事时数据还在不在"：
//   1. 某一片读不出来 → 绝不当成"没了"，也绝不把残缺数据写回磁盘
//   2. 有本地快照 → 自动恢复，且立刻落盘、游标归零重新对齐云端
//   3. 没有快照 → 只读降级，磁盘一个字节都不动
//   4. 分片写到一半失败 → 已写的片回滚，不留"前半段新、后半段旧"
//   5. 超过分片上限 → 显式失败，不静默截断
//   6. 快照只裁记录，核心资产一条不裁；最多留 3 份
//   7. 升级前自动留一份
const path = require('path');
const assert = require('assert');

/* ---------------- 模拟运行环境（可控的读失败 / 写失败） ---------------- */
const mem = {};
let failKeys = {};                      // 写这个 key 抛错（模拟配额满）
let failRead = {};                      // 读这个 key 抛错（模拟存储抖动 / 数据损坏）

function bytes() {
  let n = 0;
  Object.keys(mem).forEach(k => { n += Buffer.byteLength(JSON.stringify(mem[k]), 'utf8'); });
  return n;
}

global.wx = {
  getStorageSync: k => {
    if (failRead[k]) throw new Error('getStorageSync:fail');
    return k in mem ? JSON.parse(JSON.stringify(mem[k])) : '';
  },
  setStorageSync: (k, v) => {
    if (failKeys[k]) { const e = new Error('setStorageSync:fail exceed storage max size'); throw e; }
    mem[k] = JSON.parse(JSON.stringify(v));
  },
  removeStorageSync: k => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem), currentSize: Math.ceil(bytes() / 1024), limitSize: 10240 }),
  showToast: () => {}, showModal: () => {}, navigateTo: () => {}, switchTab: () => {},
  navigateBack: () => {}, setNavigationBarTitle: () => {}, stopPullDownRefresh: () => {},
  previewImage: () => {}, setClipboardData: o => { o && o.success && o.success(); },
  createInnerAudioContext: () => ({ onEnded() {}, onError() {}, play() {}, stop() {} }),
  env: { USER_DATA_PATH: '/usr' },
  getFileSystemManager: () => ({
    accessSync: () => { throw new Error('no such file'); },
    mkdirSync: () => {}, copyFileSync: () => {}, readdirSync: () => [],
    statSync: () => { throw new Error('no such file'); }, unlinkSync: () => {}
  })
};
global.getApp = () => ({ globalData: {} });
global.App = () => {};

/* ---------------- 铺底：一份有学生、老师、班级、记录的真实库 ---------------- */
const seed = require('./fixture').richSeed();
Object.keys(seed).forEach(k => { mem[k] = seed[k]; });

let db = require('../utils/db');
db.init();

const BASE_STUDENTS = db.coll('students').length;
const BASE_MEMBERS = db.coll('members').length;
assert.ok(BASE_STUDENTS > 0 && BASE_MEMBERS > 0, '铺底数据要有学生和成员');

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

function reload() {
  Object.keys(require.cache)
    .filter(k => k.indexOf(path.join(__dirname, '..', 'utils')) === 0)
    .forEach(k => { delete require.cache[k]; });
  const fresh = require('../utils/db');
  fresh.init();
  return fresh;
}
function reset() { failKeys = {}; failRead = {}; }
function clearSnaps() {
  Object.keys(mem).filter(k => k.indexOf('chengguo_snap') === 0).forEach(k => { delete mem[k]; });
}

/* =====================================================================
 * 1. 读失败 ≠ 没有数据
 * ===================================================================*/
console.log('\n【读盘校验：残缺数据绝不回写】');
{
  ok('某个集合读异常时，load 会报 damage，而不是返回一个空集合当没事', () => {
    const storage = require('../utils/db/storage');
    failRead['chengguo_v3_students'] = true;
    const got = storage.load();
    reset();
    assert.ok(Array.isArray(got._damage) && got._damage.indexOf('students') > -1,
      '应记录 students 读失败，实际：' + JSON.stringify(got._damage));
    assert.strictEqual(got.students.length, 0, '读不出来时先给空数组占位');
  });

  ok('分片集合缺一片时同样报 damage（不是静默少几百条）', () => {
    const storage = require('../utils/db/storage');
    const SIZE = storage.SHARD.records;
    const list = [];
    for (let i = 0; i < SIZE + 10; i++) {
      list.push({ id: 900000 + i, sid: 1, cid: 1, date: '2026-01-01', score: 80, orgId: 'org1', text: 'r' + i });
    }
    mem['chengguo_v3_records'] = list.slice(0, SIZE);
    mem['chengguo_v3_records_2'] = list.slice(SIZE);
    mem['chengguo_v3_chunks'] = { records: 2 };

    failRead['chengguo_v3_records_2'] = true;
    const got = storage.load();
    reset();
    assert.ok(got._damage.some(d => d.indexOf('records') === 0), '应记录 records 缺片，实际：' + JSON.stringify(got._damage));
    assert.strictEqual(got.records.length, 0, '不确定就别给数，宁可当成未知');

    delete mem['chengguo_v3_records'];
    delete mem['chengguo_v3_records_2'];
    delete mem['chengguo_v3_chunks'];
  });
}

/* =====================================================================
 * 2. 有快照 → 自动恢复
 * ===================================================================*/
console.log('\n【自动恢复：有备份就不是终点】');
{
  ok('快照能存下并读回核心资产（学生 / 成员 / 机构 / 班级都在）', () => {
    clearSnaps();
    const storage = require('../utils/db/storage');
    const r = storage.saveSnapshot('手动备份', db.real());
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.counts.students, BASE_STUDENTS);
    assert.strictEqual(r.counts.members, BASE_MEMBERS);
    const snap = storage.readSnapshot(r.id);
    assert.ok(snap && snap.data, '快照应能读回');
    assert.strictEqual(snap.data.students.length, BASE_STUDENTS);
    assert.ok(snap.meta && snap.meta.orgId, '机构号必须一起存（否则恢复后等于全新安装）');
  });

  ok('启动时发现读异常 → 自动用最近快照恢复，并把恢复结果落盘', () => {
    clearSnaps();
    const storage = require('../utils/db/storage');
    storage.saveSnapshot('每日备份', db.real());

    // 破坏：students 读不出来（模拟分片丢失 / 存储抖动）
    failRead['chengguo_v3_students'] = true;
    const fresh = reload();
    db = fresh;
    reset();

    assert.strictEqual(fresh.coll('students').length, BASE_STUDENTS, '学生应被恢复回来');
    assert.strictEqual(fresh.coll('members').length, BASE_MEMBERS, '老师（成员）也应恢复');
    const st = fresh.status();
    assert.ok(st.restored, '状态里要能看出"这次是从备份恢复的"');
    assert.ok(!st.degraded, '恢复成功就不该降级');

    // 落盘：磁盘上那份残缺数据已经被完整数据覆盖
    const onDisk = mem['chengguo_v3_students'];
    assert.strictEqual(Array.isArray(onDisk) ? onDisk.length : -1, BASE_STUDENTS, '磁盘应已写回完整数据');
  });

  ok('恢复后游标归零 + 全量标脏（更早的记录靠云端补回来）', () => {
    const raw = db.real();
    assert.strictEqual(Number((raw.meta.sync || {}).cursor) || 0, 0, '游标应归零');
    const dirty = (raw.meta.sync || {}).dirty || [];
    assert.ok(dirty.length >= 5, '应把各集合都标脏，实际：' + dirty.join(','));
  });
}

/* =====================================================================
 * 3. 没有快照 → 只读降级，磁盘不动
 * ===================================================================*/
console.log('\n【降级保护：没备份也不能自己抹掉】');
{
  ok('读异常且没有快照 → 进只读，且磁盘上的原有数据一字未改', () => {
    clearSnaps();
    // 确认磁盘上有一份"好数据"
    db.flush();
    const before = JSON.stringify(mem['chengguo_v3_classes']);

    failRead['chengguo_v3_classes'] = true;
    const fresh = reload();
    db = fresh;
    reset();

    const st = fresh.status();
    assert.strictEqual(st.degraded, true, '应当降级');
    assert.strictEqual(st.readOnly, true, '应当只读');
    assert.ok(/读取异常/.test(st.error), '错误信息应说明是读取异常，实际：' + st.error);
    assert.strictEqual(JSON.stringify(mem['chengguo_v3_classes']), before, '磁盘上的班级数据不能被覆盖');
  });

  ok('只读态下写入直接失败并告知调用方（不会假装保存成功）', () => {
    const r = db.students.create({ name: '只读期间不该进来的人' });
    assert.strictEqual(r.ok, false, '只读时必须拒绝写入');
    assert.ok(r.msg, '要给出原因');
  });

  // 恢复正常
  reset();
  mem['chengguo_v3_classes'] = seed['chengguo_v3_classes'];
  db = reload();
  clearSnaps();
}

/* =====================================================================
 * 4. 写入中途失败 → 回滚
 * ===================================================================*/
console.log('\n【写入回滚：不留半新半旧】');
{
  const storage = require('../utils/db/storage');
  const SIZE = storage.SHARD.records;

  ok('第 2 片写失败时，第 1 片回滚到旧值（否则磁盘上前半段新、后半段旧）', () => {
    const list = [];
    for (let i = 0; i < SIZE + 5; i++) {
      list.push({ id: 700000 + i, sid: 1, cid: 1, date: '2026-01-01', score: 80, orgId: 'org1', text: '旧' + i });
    }
    assert.strictEqual(storage.saveCollection('records', list), true);
    const oldFirst = JSON.stringify(mem['chengguo_v3_records']);

    // 第 1、2 片内容都改（模拟删中间记录这类整体位移）
    const next = list.map(x => Object.assign({}, x, { text: x.text.replace('旧', '新') }));
    failKeys['chengguo_v3_records_2'] = true;
    const okWrite = storage.saveCollection('records', next);
    reset();

    assert.strictEqual(okWrite, false, '写失败必须如实返回 false');
    assert.strictEqual(JSON.stringify(mem['chengguo_v3_records']), oldFirst,
      '第 1 片必须回到这次写入之前的内容');
  });

  ok('超过分片上限时显式失败（以前会照写不误，超出部分永远读不回来）', () => {
    const huge = new Array(storage.MAX_SHARDS * SIZE + 1).fill({}).map((_, i) => ({ id: 800000 + i }));
    assert.strictEqual(storage.saveCollection('records', huge), false, '应拒绝并返回 false');
  });

  // 还原
  delete mem['chengguo_v3_records'];
  delete mem['chengguo_v3_records_2'];
  delete mem['chengguo_v3_chunks'];
}

/* =====================================================================
 * 5. 快照策略：只裁记录、最多 3 份
 * ===================================================================*/
console.log('\n【快照策略：核心资产一条不裁】');
{
  const storage = require('../utils/db/storage');

  ok('记录特别多时只裁记录，学生/成员/机构/班级一条不动', () => {
    clearSnaps();
    const data = {
      meta: { orgId: 'org1', orgName: '测试机构' },
      students: db.real().students.slice(),
      members: db.real().members.slice(),
      orgs: db.real().orgs.slice(),
      classes: db.real().classes.slice()
    };
    const big = [];
    for (let i = 0; i < 500; i++) big.push({ id: 1 + i, sid: 1, note: new Array(600).join('长') });
    data.records = big;

    const r = storage.saveSnapshot('压力测试', data);
    assert.ok(r.ok, JSON.stringify(r));
    const snap = storage.readSnapshot(r.id);
    assert.ok(snap.data.records.length <= 300, '记录应被裁剪，实际 ' + snap.data.records.length);
    assert.strictEqual(snap.data.students.length, data.students.length, '学生不能裁');
    assert.strictEqual(snap.data.members.length, data.members.length, '成员不能裁');
    assert.strictEqual(snap.data.classes.length, data.classes.length, '班级不能裁');
  });

  ok('最多留 3 份，最旧的自动清掉（不能把配额吃光）', () => {
    clearSnaps();
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(storage.saveSnapshot('第' + i + '份', db.real()).id);
    const list = storage.snapshotList();
    assert.strictEqual(list.length, 3, '应只留 3 份，实际 ' + list.length);
    assert.ok(!list.some(x => x.id === ids[0]), '最旧的一份应已删除');
    assert.ok(list.some(x => x.id === ids[3]), '最新的必须还在');
  });

  ok('最新一份能按时间取到（恢复流程靠它）', () => {
    const s = storage.latestSnapshot();
    assert.ok(s && s.data, '应能拿到一份可用快照');
  });
}

/* =====================================================================
 * 6. 手动恢复
 * ===================================================================*/
console.log('\n【手动恢复：回到某个时间点】');
{
  clearSnaps();
  const storage = require('../utils/db/storage');
  const snap = storage.saveSnapshot('手动备份', db.real());

  // 删掉一个学生（模拟误删；删除是软删，列表里才看得出来）
  const before = db.students.list().length;
  const victim = db.students.list()[0];
  db.students.remove(victim.id);
  assert.strictEqual(db.students.list().length, before - 1, '先确认真的删掉了');

  ok('恢复快照后，被删的学生回来了', () => {
    const r = db.snapshots.restore(snap.id);
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(db.students.list().length, before, '学生数应回到快照时');
    assert.ok(db.students.list().some(s => s.id === victim.id), '被删的那个应回来');
  });

  ok('恢复前会自动留一份"恢复前"，点错了还能退回去', () => {
    const list = storage.snapshotList();
    assert.ok(list.some(x => x.tag === '恢复前'), '应有一份恢复前的备份，实际：' + list.map(x => x.tag).join(','));
  });

  ok('恢复后游标归零（让云端重新对齐，不产生重复）', () => {
    const raw = db.real();
    assert.strictEqual(Number((raw.meta.sync || {}).cursor) || 0, 0);
    assert.ok(((raw.meta.sync || {}).dirty || []).length > 0, '应标脏准备回推');
  });
}

/* =====================================================================
 * 7. 升级前自动备份
 * ===================================================================*/
console.log('\n【升级前自动备份】');
{
  ok('版本不一致时，先把旧库整份存下来再迁移', () => {
    clearSnaps();
    db.flush();
    // 造一个"旧版本"的库
    mem['chengguo_v3_meta'] = Object.assign({}, mem['chengguo_v3_meta'], { version: 1 });
    failRead = {}; failKeys = {};
    const fresh = reload();
    assert.ok(fresh, '迁移后应能正常启动');
    const list = require('../utils/db/storage').snapshotList();
    assert.ok(list.some(x => String(x.tag).indexOf('升级前') > -1),
      '应留下升级前的备份，实际：' + list.map(x => x.tag).join(','));
    assert.strictEqual(fresh.coll('students').length, BASE_STUDENTS, '迁移不能丢学生');
  });
}

/* =====================================================================
 * 8. 核心资产体检
 * ===================================================================*/
console.log('\n【数据体检：核心资产之间的引用】');
{
  const o = db.real().meta.orgId;

  ok('干净的库体检为"健康"', () => {
    const a = db.audit.scan();
    assert.ok(a.ok);
    assert.ok(a.counts.students > 0 && a.counts.members > 0, '要能数出核心资产');
    assert.ok(a.healthy, '不应有问题：' + JSON.stringify(a.issues.map(x => x.k)));
  });

  ok('学号重复会被报出来（家长凭学号认孩子，重复会认错人）', () => {
    const list = db.coll('students').filter(x => !x.removed);
    list[1].no = list[0].no;
    const a = db.audit.scan();
    const hit = a.issues.find(x => x.k === 'dupNo');
    assert.ok(hit, '应报 dupNo');
    assert.strictEqual(hit.level, 'error');
  });

  ok('学生挂在已删除的班级上会被报出来', () => {
    const list = db.coll('students').filter(x => !x.removed);
    list[2].clsIds = list[2].clsIds.concat([987654]);
    const a = db.audit.scan();
    assert.ok(a.issues.some(x => x.k === 'stuDanglingCls'), '应报 stuDanglingCls');
  });

  ok('记录指向不存在的学生会被报出来（这类不自动修，交给人判断）', () => {
    db.coll('records').push({
      id: 998877, sid: 987654, cid: db.coll('classes')[0].id, date: '2026-01-01',
      note: '孤儿记录', orgId: o, removed: false, createdAt: 1, updatedAt: 1
    });
    const a = db.audit.scan();
    assert.ok(a.issues.some(x => x.k === 'recOrphanStu'), '应报 recOrphanStu');
  });

  ok('修复：学号重新发号且机构内唯一，学生一条不少', () => {
    const before = db.students.list().length;
    const r = db.audit.fix(['dangling', 'noNo']);
    assert.ok(r.ok, JSON.stringify(r));
    const nos = db.coll('students').filter(x => !x.removed).map(x => String(x.no));
    assert.strictEqual(new Set(nos).size, nos.length, '学号必须唯一');
    assert.strictEqual(db.students.list().length, before, '学生数量不能变');
  });

  ok('修复：摘掉悬空班级引用，但不删学生', () => {
    const s = db.coll('students')[2];
    assert.ok(!(s.clsIds || []).some(id => id === 987654), '悬空引用应已摘掉');
    assert.ok(db.coll('students').some(x => x.id === s.id), '学生本身还在');
  });

  ok('修复后仍保留"孤儿记录"的告警（没有替用户做删除决定）', () => {
    const a = db.audit.scan();
    assert.ok(a.issues.some(x => x.k === 'recOrphanStu'), '孤儿记录应仍然可见');
    const rec = db.coll('records').find(x => x.id === 998877);
    assert.ok(rec && !rec.removed, '不能自动删掉用户的记录');
  });

  ok('同一微信绑定多个成员会被报出来（权限会串）', () => {
    const ms = db.coll('members');
    if (ms[0] && ms[1]) {
      ms[1].openid = ms[0].openid || 'openid-dup';
      ms[0].openid = ms[1].openid;
    }
    const a = db.audit.scan();
    assert.ok(a.issues.some(x => x.k === 'memDupOpenid'), '应报 memDupOpenid');
  });
}

console.log('\n全部 ' + pass + ' 项备份与恢复断言通过');
