// tests/verify_integrity.js —— 地基体检：引用完整性 + 同步合并 + 分片落盘
//
// 为什么单开一套：其它套件都是"某个功能对不对"，这一套问的是
// 「不管怎么折腾，库里的关系还能不能自圆其说」。数据层是地基，地基坏了
// 表现出来是"记录少了一条""这个班选不到课""老师忽然看不到课"——查起来极贵。
//
// 四组：
//   I  静态：集合清单在本地与三个云函数之间必须逐字一致（加表漏改一处 = 静默分裂）
//   R  运行时：一条真实业务路径走完，integrity() 必须是空的
//   D  脏数据：注入 5 类悬空关系 → 体检报得出来 → 自愈能修干净 → 重启仍干净
//   S  同步合并 + 分片落盘：不丢文档、幂等、同秒墓碑不吞活行；700 条跨片读写一致
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };

// 独立存储 + 独立模块实例（模拟一台干净的手机）
function boot(mem) {
  Object.keys(require.cache).forEach(k => {
    if (k.indexOf(path.join(ROOT, 'utils')) === 0) delete require.cache[k];
  });
  global.wx = {
    getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
    setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
    removeStorageSync: k => { delete mem[k]; },
    getStorageInfoSync: () => ({ keys: Object.keys(mem), currentSize: 200, limitSize: 10240 }),
    showToast: () => {}, showModal: () => {}
  };
  const db = require(path.join(ROOT, 'utils/db'));
  db.init();
  return db;
}

console.log('· 地基体检');

/* =====================================================================
 * I. 静态：集合清单只有一份真相
 * ===================================================================*/
const entities = require(path.join(ROOT, 'utils/db/entities'));
const ALL = entities.ALL_COLLS.slice();

// 云函数只搬同步集合（users 是本机账号表，不上云）；测试夹具要搬全部（含 users）
const CLOUD_LISTS = [
  ['cloudfunctions/syncv2/index.js', /const COLLS = \[([\s\S]*?)\];/],
  ['cloudfunctions/backup/lib.js', /const COLLS = \[([\s\S]*?)\];/],
  ['cloudfunctions/admin/index.js', /const BACKUP_COLLS = \[([\s\S]*?)\];/],
  ['cloudfunctions/admin/index.js', /const CB_COLLS = \[([\s\S]*?)\];/]
];

function listOf(file, re) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const m = src.match(re);
  assert.ok(m, file + ' 里没找到集合清单');
  return m[1].match(/'[^']+'/g).map(s => s.replace(/'/g, '')).sort();
}

ok('I1 三个云函数的集合清单与 SYNC_COLLS 逐字一致', () => {
  const SYNC = entities.SYNC_COLLS.slice().sort();
  CLOUD_LISTS.forEach(([file, re]) => {
    assert.deepStrictEqual(listOf(file, re), SYNC,
      file + ' 的集合清单与 SYNC_COLLS 不一致（漏一张表 = 本地有、云端没有）');
  });
});

ok('I1b 测试夹具搬的是全部集合（含 users），不会漏掉新表', () => {
  assert.deepStrictEqual(listOf('tests/fixture.js', /const COLLS = \[([\s\S]*?)\];/), ALL.slice().sort());
});

ok('I2 同步集合与数字 id 集合都登记在实体表里，且每张表都有规范化函数', () => {
  const schema = require(path.join(ROOT, 'utils/db/schema'));
  entities.SYNC_COLLS.forEach(c => assert.ok(ALL.indexOf(c) > -1, '同步集合未登记：' + c));
  entities.NUM_ID_COLLS.forEach(c => assert.ok(ALL.indexOf(c) > -1, '数字 id 集合未登记：' + c));
  entities.ENTITIES.forEach(e => {
    const fn = schema['normalize' + e.entity.charAt(0).toUpperCase() + e.entity.slice(1)];
    assert.strictEqual(typeof fn, 'function', e.entity + ' 缺少 normalize 函数（脏字段会直接进库）');
  });
});

/* =====================================================================
 * R. 运行时：走一条真实业务路径，关系必须自洽
 * ===================================================================*/
const mem = {};
let db = boot(mem);
let clsA, clsB, crs, stuA, stuB, recA, deadCrs, deadCls;

ok('R1 全新库体检查不出问题', () => {
  assert.deepStrictEqual(db.integrity(), [], '空库就有悬空关系');
});

ok('R2 建班/跨班课程/学生/记录/报名后，关系仍然自洽', () => {
  const t = db.terms.activeList()[0] || db.terms.create({ name: '长期班', status: 'active' }).item;
  clsA = db.classes.create({ name: 'A 班', termId: t.id }).item;
  clsB = db.classes.create({ name: 'B 班', termId: t.id }).item;
  crs = db.courses.create({ name: '楷书', clsIds: [clsA.id, clsB.id] }).item;
  assert.deepStrictEqual(db.courses.classIdsOf(crs.id).sort((x, y) => x - y), [clsA.id, clsB.id].sort((x, y) => x - y));
  stuA = db.students.create({ name: '甲', clsIds: [clsA.id] }).item;
  stuB = db.students.create({ name: '乙', clsIds: [clsB.id] }).item;
  recA = db.records.save({ cls: clsA.id, sid: stuA.id, course: '楷书', note: '第一课' }, true).record;
  assert.ok(recA.courseId, '记录应挂上课程指针');
  assert.deepStrictEqual(db.integrity(), [], '正常业务路径不该产生悬空关系');
});

ok('R3 删班（进回收站）后绑定一起软删，不算悬空', () => {
  assert.strictEqual(db.classes.remove(clsB.id).ok, true);
  assert.deepStrictEqual(db.integrity(), [], '班级在回收站里是正常状态，不能被当成悬空');
  assert.strictEqual(db.courses.classIdsOf(crs.id).indexOf(clsB.id), -1, '课程暂时不在这个班');
});

ok('R4 还原班级后绑定回来，仍然自洽', () => {
  assert.strictEqual(db.classes.restore(clsB.id).ok, true);
  assert.ok(db.courses.classIdsOf(crs.id).indexOf(clsB.id) > -1, '开设关系要跟班级一起回来');
  assert.deepStrictEqual(db.integrity(), []);
});

ok('R5 合并同名课程后没有指针指向墓碑', () => {
  const core = require(path.join(ROOT, 'utils/db/core'));
  const schema = require(path.join(ROOT, 'utils/db/schema'));
  const dupId = 880001;
  core.coll('courses').push(schema.normalizeCourse({ id: dupId, name: '楷书', subjectId: crs.subjectId }, 'org1', Date.now()));
  core.persist('courses');
  db.courses.bind(clsA.id, dupId);
  db.records.save({ cls: clsA.id, sid: stuA.id, course: '楷书', courseId: dupId, note: '并课前' }, true);
  const r = db.courses.merge(crs.id, [dupId]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(db.integrity().length, 0, '合并后仍有悬空指针：' + JSON.stringify(db.integrity()));
});

/* =====================================================================
 * D. 脏数据：体检报得出、自愈修得掉、重启后仍干净
 * ===================================================================*/
ok('D1 注入 5 类悬空关系，integrity() 全部报出来', () => {
  const core = require(path.join(ROOT, 'utils/db/core'));
  const schema = require(path.join(ROOT, 'utils/db/schema'));
  // 造两具"墓碑"：本地确实有这一行，但已经删了 —— 这种引用一定是死的
  deadCrs = db.courses.create({ name: '废弃课', subjectId: crs.subjectId }).item;
  db.courses.remove(deadCrs.id);
  deadCls = db.classes.create({ name: '废弃班' }).item;
  db.classes.remove(deadCls.id);

  // ① 活绑定指向已删课程 ② 同班同课重复绑定 ③ 绑定指向"整行不存在"的课（只报不修）
  core.coll('class_courses').push(schema.normalizeClassCourse({ id: 880002, clsId: clsA.id, courseId: deadCrs.id }, 'org1', Date.now()));
  core.coll('class_courses').push(schema.normalizeClassCourse({ id: 880003, clsId: clsA.id, courseId: crs.id }, 'org1', Date.now()));
  core.coll('class_courses').push(schema.normalizeClassCourse({ id: 880005, clsId: clsA.id, courseId: 999999 }, 'org1', Date.now()));
  // ④ 记录的课程指针指向已删课程
  core.coll('records').push(schema.normalizeRecord({
    id: 880004, sid: stuA.id, cid: clsA.id, courseId: deadCrs.id, course: '楷书', date: '2026-11-06', note: '悬空指针'
  }, 'org1', Date.now()));
  // ⑤ 成员课程授权 / 学生班级范围里留着已删的行
  const m = core.coll('members')[0];
  m.courseIds = (m.courseIds || []).concat([deadCrs.id]);
  stuB.clsIds = stuB.clsIds.concat([deadCls.id]);
  core.persist('class_courses'); core.persist('records'); core.persist('members'); core.persist('students');

  const kinds = db.integrity().map(x => x.kind);
  ['binding.courseDead', 'binding.dup', 'binding.course', 'record.courseId', 'member.courseIds', 'student.clsIds']
    .forEach(k => assert.ok(kinds.indexOf(k) > -1, '体检没报出 ' + k + '，实际：' + kinds.join(',')));
});

ok('D2 自愈：修掉可证明已死的引用，保留"可能还没同步到"的（只报不修）', () => {
  const r = db.repairLinks();
  assert.ok(r.bindings >= 1, '应摘掉指向已删课程的绑定');
  assert.ok(r.dupBind >= 1, '应清掉重复绑定');
  assert.ok(r.records >= 1, '应修掉记录的悬空课程指针');
  assert.ok(r.members >= 1 && r.students >= 1, '应清掉成员/学生范围里已删的 id');
  // 记录的文字内容不能被自愈吃掉（修的是指针，不是内容）
  const rec = db.records.list().find(x => x.id === 880004);
  assert.ok(rec && rec.note === '悬空指针', '自愈不能改动记录内容');
  assert.strictEqual(rec.courseId, crs.id, '能按课程名认回来的要认回来，不要清零');
  // 整个库里唯一剩下的问题，就是那条指向"整行不存在"的绑定：
  // 它可能是别的设备上刚建、还没同步下来的课，启动时就删掉等于拿本地视图去拆远端数据
  const left = db.integrity();
  assert.deepStrictEqual(left.map(x => x.kind), ['binding.course'],
    '除了"缺行待同步"以外不该再有别的问题：' + JSON.stringify(left));
});

ok('D3 自愈结果已落盘；重启后仍只保留"待同步"那一类，且不去动它', () => {
  db = boot(mem);
  const left = db.integrity();
  assert.deepStrictEqual(left.map(x => x.kind), ['binding.course'], '重启后脏数据又回来了（说明没落盘）');
  const core = require(path.join(ROOT, 'utils/db/core'));
  const b = core.coll('class_courses').find(x => x.id === 880005);
  assert.strictEqual(b.removed, false, '缺行的绑定不能在启动时被删（那可能是还没同步到的课）');
});

/* =====================================================================
 * S. 同步合并 + 分片落盘
 * ===================================================================*/
const syncmerge = require(path.join(ROOT, 'utils/syncmerge'));

ok('S1 合并是并集：任何一边有的文档都不会消失', () => {
  const local = [{ id: 1, updatedAt: 10 }, { id: 2, updatedAt: 20 }];
  const remote = [{ id: 2, updatedAt: 30 }, { id: 3, updatedAt: 5 }];
  const r = syncmerge.mergeList(local, remote);
  assert.deepStrictEqual(r.list.map(x => x.id).sort(), [1, 2, 3], '合并丢了文档');
  assert.strictEqual(r.list.find(x => x.id === 2).updatedAt, 30, '同 id 取更新的那条');
});

ok('S2 合并幂等：同一批远端再合一次不再变', () => {
  const local = [{ id: 1, updatedAt: 10, note: 'a' }];
  const remote = [{ id: 1, updatedAt: 10, note: 'b' }];
  const once = syncmerge.mergeList(local, remote).list;
  const twice = syncmerge.mergeList(once, remote);
  assert.deepStrictEqual(twice.list, once, '第二次合并改动了结果');
  assert.strictEqual(twice.updated, 0);
});

ok('S3 时间戳相同：活着的赢，墓碑不能吞掉本机活行（P0 同类口子）', () => {
  const live = { id: 7, updatedAt: 100, removed: false, note: '本机的记录' };
  const tomb = { id: 7, updatedAt: 100, removed: true };
  assert.deepStrictEqual(syncmerge.pickWinner(live, tomb), live, '同秒墓碑不该覆盖活行');
  assert.deepStrictEqual(syncmerge.pickWinner(tomb, live), live, '反方向同理');
});

ok('S4 更晚的删除仍然生效（不能因为 S3 就删不掉）', () => {
  const live = { id: 7, updatedAt: 100 };
  const tomb = { id: 7, updatedAt: 101, removed: true };
  assert.strictEqual(syncmerge.pickWinner(live, tomb).removed, true, '晚一步的删除必须能传播');
});

ok('S5 700 条记录跨分片写入后能原样读回', () => {
  const core = require(path.join(ROOT, 'utils/db/core'));
  const schema = require(path.join(ROOT, 'utils/db/schema'));
  const base = 900000;
  for (let i = 0; i < 700; i++) {
    core.coll('records').push(schema.normalizeRecord({
      id: base + i, sid: stuA.id, cid: clsA.id, courseId: crs.id, course: '楷书',
      date: '2026-11-06', note: '第 ' + i + ' 条'
    }, 'org1', Date.now()));
  }
  assert.strictEqual(db.flush(), true, '落盘失败');
  const n = Object.keys(mem).filter(k => k.indexOf('chengguo_v3_records') === 0).length;
  assert.ok(n >= 3, '700 条应分成至少 3 片，实际 ' + n + ' 个 key');
  db = boot(mem);
  const back = db.records.list().filter(x => x.id >= base && x.id < base + 700);
  assert.strictEqual(back.length, 700, '读回的条数不对：' + back.length);
  assert.strictEqual(back.find(x => x.id === base + 699).note, '第 699 条', '最后一条内容不对');
});

ok('S6 记录变少后多余分片被清掉，不会读到"幽灵数据"', () => {
  const core = require(path.join(ROOT, 'utils/db/core'));
  const list = core.coll('records');
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].id >= 900000 && list[i].id < 900500) list.splice(i, 1);
  }
  assert.strictEqual(db.flush(), true);
  const shards = Object.keys(mem).filter(k => k.indexOf('chengguo_v3_records') === 0).length;
  assert.ok(shards <= 2, '记录少了，分片数应跟着降，实际 ' + shards);
  db = boot(mem);
  assert.strictEqual(db.records.list().filter(x => x.id >= 900000 && x.id < 901000).length, 200, '读回条数不对');
});

ok('S6b 待同步的绑定补上来之后，体检彻底归零', () => {
  const core = require(path.join(ROOT, 'utils/db/core'));
  const list = core.coll('class_courses').filter(x => x.id !== 880005);
  assert.strictEqual(core.setColl('class_courses', list), true, '落盘失败');
  assert.deepStrictEqual(db.integrity(), []);
});

ok('S7 id 分配器跨集合不撞号（同一毫秒连续创建）', () => {
  const core = require(path.join(ROOT, 'utils/db/core'));
  const seen = {};
  for (let i = 0; i < 200; i++) {
    const id = core.nextId();
    assert.ok(!seen[id], 'id 撞号：' + id);
    seen[id] = 1;
  }
});


/* =====================================================================
 * W. 写路径守卫：每个会落盘的领域函数都必须先过权限闸门
 * ---------------------------------------------------------------------
 * 权限测试验的是"规则对不对"，这里验的是"有没有人忘了调规则"。
 * 新增一个写入函数却忘了 deny()，功能测试照样全绿——只有真机上一个老师能改别人班时才暴露。
 * 内部工具函数（鉴权由调用方做完的那种）必须登记在 ALLOW 里并写明理由。
 * ===================================================================*/
ok('W1 所有落盘的领域写函数都调用了 deny()', () => {
  const DIR = path.join(ROOT, 'utils/db');
  const FILES = ['classes', 'courses', 'students', 'records', 'enrollments', 'identity', 'terms', 'templates', 'content', 'org'];
  // 已鉴权过的内部工具：调用它的地方都先 deny 过，且自己不做用户级判断
  const ALLOW = {
    'courses.bindQuiet': '建课顺手绑定/迁移用，鉴权在 courseCreate / courseBind 里',
    'classes.classRaw': '只读',
    'students.studentLinkParents': '兄弟共用家长账号的内部联动，调用方 studentCreate 已鉴权',
    'enrollments.consumeHours': '录课消课的内部步骤，调用方 recordSave 已鉴权',
    'records.recordAttachCloud': '后台补传照片只改照片字段，落库前用 canSeeRecord 兜范围',
    'identity.claimOpenid': '认领本人账号（只改自己这条成员），不需要角色权限',
    'identity.setTeacher': '只改自己的名字，作用对象固定为当前成员'
  };
  const offenders = [];
  FILES.forEach(name => {
    const src = fs.readFileSync(path.join(DIR, name + '.js'), 'utf8');
    const re = /^function (\w+)\(([\s\S]*?)^\}/gm;
    let m;
    while ((m = re.exec(src))) {
      const fn = m[1], body = m[0];
      const writes = /applyEdit\(|pushSaved\(|core\.persist\(|markRemoved\(/.test(body);
      if (!writes) continue;
      if (/deny\(/.test(body)) continue;
      if (ALLOW[name + '.' + fn]) continue;
      offenders.push(name + '.' + fn);
    }
  });
  assert.deepStrictEqual(offenders, [], '这些写函数没调 deny()，等于绕过了权限：' + offenders.join(', '));
});

ok('W2 软删除一定带 removedAt（回收站靠它认批）', () => {
  const core = require(path.join(ROOT, 'utils/db/core'));
  const s = db.students.create({ name: '待删', clsIds: [clsA.id] }).item;
  db.students.remove(s.id);
  const raw = core.coll('students').find(x => x.id === s.id);
  assert.strictEqual(raw.removed, true);
  assert.ok(Number(raw.removedAt) > 0, '软删行必须记下"哪一批删的"');
  assert.deepStrictEqual(db.integrity(), [], '删完之后体检要干净：' + JSON.stringify(db.integrity()));
  assert.strictEqual(db.students.restore(s.id).ok, true, '还原应成功');
});

ok('G1 体检分组：缺行归「待同步」、墓碑归「故障」，两组不能混', () => {
  const core = require(path.join(ROOT, 'utils/db/core'));
  const schema = require(path.join(ROOT, 'utils/db/schema'));
  const t = Date.now();
  // 一条指向"本地有、但已删除"的课程（可证明是死的）
  core.coll('class_courses').push(schema.normalizeClassCourse({ id: 881001, clsId: clsA.id, courseId: deadCrs.id }, 'org1', t));
  // 一条指向"整行都不存在"的课程（可能只是还没同步下来）
  core.coll('class_courses').push(schema.normalizeClassCourse({ id: 881002, clsId: clsB.id, courseId: 987654 }, 'org1', t));
  core.persist('class_courses');

  const by = {};
  db.integrityGroups().forEach(x => { by[x.kind] = x; });
  assert.ok(by['binding.courseDead'], '应报出指向已删课程的绑定');
  assert.strictEqual(by['binding.courseDead'].wait, false, '墓碑是可证明的故障，不能算待同步');
  assert.ok(by['binding.course'], '应报出指向不存在课程的绑定');
  assert.strictEqual(by['binding.course'].wait, true, '整行不存在要算待同步：新设备分批拉取时这段关系是正常的');
  // 分组名必须是给人看的中文，不能把 kind 直接甩到界面上
  db.integrityGroups().forEach(x => assert.ok(/[\u4e00-\u9fa5]/.test(x.label), '分组说明要用中文：' + x.kind));

  // 收尾：自愈能摘掉「死引用」，但「待同步」那条必须留着（这是这套口径的核心）
  db.repairLinks();
  const left = db.integrity();
  assert.deepStrictEqual(left.map(x => x.kind), ['binding.course'],
    '自愈后只该剩"缺行待同步"：' + JSON.stringify(left));
  const list = core.coll('class_courses').filter(x => x.id !== 881002);
  core.setColl('class_courses', list);
  assert.deepStrictEqual(db.integrity(), [], '清掉待同步项后体检应归零');
});

ok('G2 存储页的体检入口在页面上真的接上了（模板绑的事件都有对应方法）', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'pages/storage/storage.wxml'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'pages/storage/storage.js'), 'utf8');
  ['fixLinks', 'fixData'].forEach(fn => {
    assert.ok(wxml.indexOf('bindtap="' + fn + '"') > -1, '模板里没有 ' + fn + ' 的入口');
    assert.ok(new RegExp('\\b' + fn + '\\(\\)').test(js), 'js 里没有 ' + fn + ' 方法');
  });
  // 头部状态必须是综合结果：只写死"一切正常"会出现"下面列着断线、上面说正常"
  assert.ok(js.indexOf('syncHead') > -1, '头部文案要综合两层检查');
  assert.ok(wxml.indexOf('headHint') > -1 && wxml.indexOf('auditOk ?') === -1, '头部不能只按 audit 判断');
});

ok('G3 骨架收编：切换机构号后，出厂号建的学期/模板/学科跟着换，orgs 例外', () => {
  // 独立起一台"新装手机"：init 走 buildFresh，骨架全部挂出厂号
  const mem2 = {};
  const db2 = boot(mem2);
  const core2 = require(path.join(ROOT, 'utils/db/core'));
  const termBefore = core2.coll('terms').filter(x => !x.removed).length;
  assert.ok(termBefore > 0, '新装库应该有内置学期（骨架）');

  // 模拟 hello：云端发了真实机构号，本机切过去 —— 骨架行不会自己跟着换
  db2.patchMeta({ orgId: 'org_x9' });
  const kinds = db2.integrity().map(x => x.kind);
  assert.ok(kinds.some(k => /^org\./.test(k)), '切完机构体检应该报出骨架残留：' + kinds.join(','));
  // 体检的分组名要能看出是哪张表，不能只说"混入其它机构的数据"
  const g = db2.integrityGroups().find(x => /^org\./.test(x.kind));
  assert.ok(/（.+）/.test(g.label), '分组名要带表名：' + g.label);

  db2.adoptFactoryRows('org_x9');
  core2.coll('terms').concat(core2.coll('templates')).concat(core2.coll('subjects'))
    .forEach(d => { if (d) assert.strictEqual(d.orgId, 'org_x9', '骨架行要收编到新机构号'); });
  // orgs 例外：id 即机构号，云端登录后会拉回本机构的行，出厂那行不动
  core2.coll('orgs').forEach(o => { if (o) assert.strictEqual(o.id, 'org1', 'orgs 不该被收编改动'); });
  assert.deepStrictEqual(db2.integrity().filter(x => /^org/.test(x.kind)), [], '收编后机构残留应清零');

  // 幂等：第二次调用是空操作，不会再动任何行
  const again = db2.adoptFactoryRows('org_x9');
  assert.strictEqual(again.rows, 0, '收编必须幂等（重复调用不改任何行）');
});

ok('G4 机构切换点：首次绑定必收编骨架，切换机构绝收编（否则会把 A 家的模板搬到 B 家）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'utils/sync.js'), 'utf8');
  // 三处改 meta.orgId：hello 采纳云端号、邀请码 join（改挂）、doSwitch（换一家干活）
  const switches = src.split('db.patchMeta({ orgId').length - 1;
  const calls = src.split('db.adoptFactoryRows(').length - 1;
  assert.strictEqual(switches, 3, '机构切换点变了（现在 ' + switches + ' 处），这条断言要同步改');
  // 【为什么切换点少一次收编】adoptFactoryRows 是把"出厂号建的那套骨架"认领到真实机构号上，
  // 只适用于"本机数据整体改挂"（首次上云、邀请码加入）。切到另一家已有机构的账上时收编，
  // 等于把 A 家的学期/模板搬到 B 家，是实打实的数据污染。
  assert.strictEqual(calls, 2, '收编只该出现在两处改挂，现在有 ' + calls + ' 处');
});

ok('G5 重复绑定收口：同一微信两条成员关系只留一条，me 改指保留行', () => {
  const mem2 = {};
  const db2 = boot(mem2);
  const core2 = require(path.join(ROOT, 'utils/db/core'));
  db2.patchMeta({ orgId: 'org_x9' });

  // 造两条同 openid 的成员：A 建得早没名字，B 建得晚有名字且 me 指着它
  const mk = (id, userId, name, createdAt) => ({
    id, orgId: 'org_x9', userId, role: 'owner', name: name || '',
    openid: 'oX', status: 'active', createdAt, updatedAt: createdAt,
    clsIds: [], courseIds: [], studentIds: []
  });
  core2.coll('members').push(mk(9001, 'uA', '', 1000));
  core2.coll('members').push(mk(9002, 'uB', '张老师', 2000));
  core2.persist('members');
  db2.patchMeta({ me: 'uB' });

  const r = db2.dedupeBindings();
  assert.strictEqual(r.rows, 1, '该删掉一条：' + JSON.stringify(r));
  const alive = core2.coll('members').filter(x => !x.removed && x.openid === 'oX');
  assert.strictEqual(alive.length, 1);
  assert.strictEqual(alive[0].id, 9002, 'me 指着、有名字的该留');
  assert.strictEqual(core2.coll('members').find(x => x.id === 9001).removed, true, '另一条进回收站（打墓碑，不是物理删）');
  // me 本来就指着保留行，不该被动过
  assert.strictEqual(db2.real().meta.me, 'uB');
  // 幂等：再跑一遍是空操作
  assert.deepStrictEqual(db2.dedupeBindings(), { rows: 0, renamed: 0 });

  // 反过来：me 指着的是没名字的旧行 → 留旧行（me 优先级最高），并把名字从账号表借来
  const mem3 = {};
  const db3 = boot(mem3);
  const core3 = require(path.join(ROOT, 'utils/db/core'));
  db3.patchMeta({ orgId: 'org_x9' });
  core3.coll('members').push(mk(9101, 'uC', '', 1000));
  core3.coll('members').push(mk(9102, 'uD', '李老师', 2000));
  core3.coll('users').push({ id: 'uC', orgId: 'org_x9', name: '真正的名字', role: 'owner', createdAt: 1000, updatedAt: 1000 });
  core3.persist('members');
  core3.persist('users');
  db3.patchMeta({ me: 'uC' });
  const r3 = db3.dedupeBindings();
  assert.strictEqual(r3.rows, 1);
  const alive3 = core3.coll('members').filter(x => !x.removed && x.openid === 'oX');
  assert.strictEqual(alive3[0].id, 9101, 'me 指着的行优先保留（权限判定按它走）');
  assert.strictEqual(alive3[0].name, '真正的名字', '保留行没名字要从账号表补，记录署名靠它');
  assert.strictEqual(db3.real().meta.me, 'uC');
});

ok('G6 身份自救不重人：机构里还有成员时认旧身份，绝不新建第二条', () => {
  const mem2 = {};
  const db2 = boot(mem2);
  const core2 = require(path.join(ROOT, 'utils/db/core'));
  db2.patchMeta({ orgId: 'org_x9' });
  core2.coll('orgs').push({ id: 'org_x9', name: '测试机构', createdAt: 1000, updatedAt: 1000 });
  // 机构里有业务数据 + 两条成员（都还没认领 openid），me 指向不存在的账号
  // → memberCurrent 解析出人（两条成员时单成员兜底失效），老逻辑会在这里重建负责人
  core2.coll('members').push({
    id: 9201, orgId: 'org_x9', userId: 'uOld', role: 'owner', name: '老王',
    openid: '', status: 'active', createdAt: 1000, updatedAt: 1000,
    clsIds: [], courseIds: [], studentIds: []
  });
  core2.coll('members').push({
    id: 9203, orgId: 'org_x9', userId: 'uT', role: 'teacher', name: '张老师',
    openid: '', status: 'active', createdAt: 1100, updatedAt: 1100,
    clsIds: [], courseIds: [], studentIds: []
  });
  core2.coll('students').push({ id: 9202, orgId: 'org_x9', name: '小明', no: 'S001', removed: false, createdAt: 1000, updatedAt: 1000 });
  core2.persist('members');
  core2.persist('students');
  db2.patchMeta({ me: 'uGhost' });

  const r = db2.repairIdentity();
  assert.ok(r.ok, '自救应该成功：' + JSON.stringify(r));
  assert.strictEqual(r.code, 'ADOPTED', '该认旧身份而不是重建：' + r.code);
  assert.strictEqual(db2.real().meta.me, 'uOld', 'me 要指到已有的成员');
  assert.strictEqual(core2.coll('members').filter(x => !x.removed && x.orgId === 'org_x9').length, 2, '不能多出第三条成员（原有的两条都原样保留）');
});

ok('G7 owner 残骸收口：无名且未认领的多余负责人进回收站，存活行借名', () => {
  const mem2 = {};
  const db2 = boot(mem2);
  const core2 = require(path.join(ROOT, 'utils/db/core'));
  db2.patchMeta({ orgId: 'org_x9' });
  const mk = (id, userId, role, name, openid, createdAt) => ({
    id, orgId: 'org_x9', userId, role, name: name || '', openid: openid || '',
    status: 'active', createdAt, updatedAt: createdAt, clsIds: [], courseIds: [], studentIds: []
  });
  // 真机形状：A = 云端那条（认领过微信但没名字）；C = 自救重出来的残骸（无微信无名字）
  core2.coll('members').push(mk(9301, 'uA', 'owner', '', 'oX', 1000));
  core2.coll('members').push(mk(9302, 'uC', 'owner', '', '', 2000));
  core2.coll('users').push({ id: 'uA', orgId: 'org_x9', name: '王校长', role: 'owner', createdAt: 1000, updatedAt: 1000 });
  core2.persist('members');
  core2.persist('users');
  db2.patchMeta({ me: 'uA' });

  const r = db2.dedupeBindings();
  assert.strictEqual(r.rows, 1, '残骸该被收走：' + JSON.stringify(r));
  const alive = core2.coll('members').filter(x => !x.removed && x.orgId === 'org_x9');
  assert.deepStrictEqual(alive.map(x => x.id), [9301], '只剩云端那条');
  assert.strictEqual(core2.coll('members').find(x => x.id === 9302).removed, true, '残骸是墓碑不是物理删');
  assert.strictEqual(alive[0].name, '王校长', '存活行没名字要从账号表借');
  // 三条保护：有名的不动、me 指着的不动、机构里没有已认领 owner 时不动
  const mem3 = {};
  const db3 = boot(mem3);
  const core3 = require(path.join(ROOT, 'utils/db/core'));
  db3.patchMeta({ orgId: 'org_x9' });
  core3.coll('members').push(mk(9401, 'uP', 'owner', '', '', 1000));
  core3.coll('members').push(mk(9402, 'uQ', 'owner', '', '', 2000));
  core3.persist('members');
  db3.patchMeta({ me: 'uP' });
  const r3 = db3.dedupeBindings();
  assert.strictEqual(r3.rows, 0, '两条 owner 都没绑微信：分不清哪条是残骸，不能自动删');
});

ok('G8 取后台账号失败不能只说「网络不通」（冷启动超时要重试、真实错误要带出来）', () => {
  const api = fs.readFileSync(path.join(ROOT, 'utils/api.js'), 'utf8');
  const page = fs.readFileSync(path.join(ROOT, 'pages/mine/mine.js'), 'utf8');
  const i = api.indexOf('function adminAccount');
  const fn = api.slice(i, i + 900);
  assert.ok(/\.catch\(\(\) => wait/.test(fn), 'admin 首次调用常被 3 秒超时掐断，必须自动重试');
  assert.ok(/err:/.test(fn), '真实 errMsg 必须回传，不能吞成一句「网络不通」');
  assert.ok(/out\.err|错误信息/.test(page), '失败弹窗要显示具体错误，便于定位');
  assert.ok(!/网络不通，请重试/.test(page), '别再出现笼统的「网络不通」提示');
});

console.log('\n全部 ' + pass + ' 项地基断言通过');
