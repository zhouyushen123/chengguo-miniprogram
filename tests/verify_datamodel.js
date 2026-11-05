// tests/verify_datamodel.js —— 数据模型（阶段一：为题库留位）
//
// 这组断言守的是"以后加表不会静默漏东西"：
//   A. 注册表 == 代码：normalize 输出的字段与 entities.js 登记的一字不差
//   B. 集合清单一致：本地存储、同步、三个云函数的清单都包含注册表里的每张同步表
//      （漏一处不会报错，只会表现为"本地有、云端没有"，是灾难恢复那天才发现的那种漏）
//   C. 种子与猜测：7 条学科、课程按名归类、猜不中留 0
//   D. V8 → V9 升级：老库自动补学科/scoreScale/kpIds，且连跑两次结果一致
//   E. 满分口径：scoreScale=10 时 85 分必须被拒绝（否则平均分口径悄悄错掉）
//   F. 数据字典与代码同步（docs/data-dictionary.md 由 schema-doc 生成）
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const schema = require('../utils/db/schema');
const entities = require('../utils/db/entities');
const migrate = require('../utils/db/migrate');
const storage = require('../utils/db/storage');
const sync = require('../utils/db/sync');

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓ ' + name); };
const keysOf = o => Object.keys(o).sort();

/* ---------- A. 注册表 == 代码 ---------- */
console.log('\n【A. 注册表与代码一致】');

ok('每张表都在注册表登记了实体名，且实体名可被 normalize 识别', () => {
  entities.ENTITIES.forEach(e => {
    assert.ok(e.entity, e.coll + ' 缺少 entity 字段');
    assert.notStrictEqual(schema.normalize(e.entity, {}, 'org1', 1000), null, e.coll + ' 的 normalize 返回 null');
  });
});

ok('normalize() 输出的字段与注册表登记完全一致（改字段忘登记 → 这里红）', () => {
  entities.ENTITIES.forEach(e => {
    const out = schema.normalize(e.entity, {}, 'org1', 1000);
    assert.deepStrictEqual(keysOf(out), e.fields.map(f => f.k).sort(),
      '字段不一致：' + e.coll + '\n  代码：' + keysOf(out).join(',') + '\n  登记：' + e.fields.map(f => f.k).sort().join(','));
  });
});

ok('集合名不重复，且 id 类型只有 num / str 两种', () => {
  const seen = {};
  entities.ENTITIES.forEach(e => {
    assert.ok(!seen[e.coll], '集合名重复：' + e.coll);
    seen[e.coll] = 1;
    assert.ok(e.idType === 'num' || e.idType === 'str', e.coll + ' 的 idType 不合法：' + e.idType);
  });
});

/* ---------- B. 集合清单一致 ---------- */
console.log('\n【B. 集合清单一致（本地 / 同步 / 云函数）】');

ok('本地存储的集合清单来自注册表', () => {
  assert.deepStrictEqual(storage.COLLECTIONS.slice(), entities.ALL_COLLS.slice());
});

ok('同步清单 = 注册表里 sync:true 的表（users 不上云）', () => {
  assert.deepStrictEqual(sync.COLLS.slice(), entities.SYNC_COLLS.slice());
  assert.ok(entities.SYNC_COLLS.indexOf('users') < 0, 'users 是设备级账号，不该参与同步');
});

// 云函数不能跨目录 require，只能各自维护清单；这里断言"一个都不能漏"
const CF_FILES = [
  ['cloudfunctions/syncv2/index.js', ['COLLS']],
  ['cloudfunctions/backup/lib.js', ['COLLS']],
  ['cloudfunctions/admin/index.js', ['BACKUP_COLLS', 'CB_COLLS']]
];
ok('三个云函数的集合清单都包含注册表里的每一张同步表', () => {
  CF_FILES.forEach(([file, names]) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    names.forEach(name => {
      const m = src.match(new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\]'));
      assert.ok(m, file + ' 里找不到 ' + name);
      const list = (m[1].match(/'[^']+'/g) || []).map(x => x.replace(/'/g, ''));
      const missing = entities.SYNC_COLLS.filter(c => list.indexOf(c) < 0);
      assert.deepStrictEqual(missing, [], file + ' 的 ' + name + ' 缺少：' + missing.join(', ') +
        '（漏了它，这些数据永远不会同步/备份）');
    });
  });
});

/* ---------- C. 种子与猜测 ---------- */
console.log('\n【C. 学科种子与课程归类】');

const fresh = migrate.buildFresh(1000, { sample: true });

ok('新装即带 7 条内置学科，gid 唯一且固定', () => {
  assert.strictEqual(fresh.subjects.length, 7);
  assert.deepStrictEqual(fresh.subjects.map(s => s.gid), schema.SUBJECT_SEEDS.map(s => s.gid));
  assert.strictEqual(new Set(fresh.subjects.map(s => s.gid)).size, 7);
  assert.ok(fresh.subjects.every(s => s.id > 0 && s.orgId === schema.DEFAULT_ORG));
});

ok('知识点表先建好但是空的（阶段二才录数据）', () => {
  assert.ok(Array.isArray(fresh.knowledge_points));
  assert.strictEqual(fresh.knowledge_points.length, 0);
});

ok('示例课程按名称归到学科：楷书→书法、素描→美术', () => {
  const byName = {};
  fresh.courses.forEach(c => { byName[c.name] = c; });
  const gidOf = id => (fresh.subjects.find(s => s.id === id) || {}).gid;
  assert.strictEqual(gidOf(byName['楷书'].subjectId), 'sub_calligraphy');
  assert.strictEqual(gidOf(byName['素描'].subjectId), 'sub_art');
});

ok('机构自建课程名也能猜中，猜不中留 0 不阻塞', () => {
  const subs = fresh.subjects;
  assert.strictEqual((subs.find(s => s.id === schema.guessSubjectId('数学思维提高班', subs)) || {}).gid, 'sub_math');
  assert.strictEqual((subs.find(s => s.id === schema.guessSubjectId('英语口语', subs)) || {}).gid, 'sub_english');
  assert.strictEqual((subs.find(s => s.id === schema.guessSubjectId('钢琴一对一', subs)) || {}).gid, undefined);
  assert.strictEqual(schema.guessSubjectId('钢琴一对一', subs), 0);
  assert.strictEqual(schema.guessSubjectId('', subs), 0);
});

/* ---------- D. V8 → V9 升级 ---------- */
console.log('\n【D. 老库升级（v8 → v9）】');

function legacyV8() {
  const old = JSON.parse(JSON.stringify(fresh));
  old.meta.version = 8;
  delete old.subjects;
  delete old.knowledge_points;
  old.courses.forEach(c => { delete c.subjectId; });
  // 手写一条 v8 记录（不经 normalize，所以没有 scoreScale / kpIds）
  old.records = [{
    id: 1, sid: 1, cid: 1, courseId: 1, course: '楷书', date: '2026-11-01',
    score: 92, tag: '优秀', note: '写得很稳', photos: [], videos: [], audio: null,
    sent: true, session: 1, tid: 't1',
    orgId: schema.DEFAULT_ORG, createdAt: 900, updatedAt: 900, removed: false, removedAt: 0, removedBy: 0
  }];
  return old;
}

const up = migrate.upgrade(legacyV8(), 2000);

ok('升级后自动补出 7 条学科，且 id 不与已有数据冲突', () => {
  assert.strictEqual(up.subjects.length, 7);
  assert.strictEqual(new Set(up.subjects.map(s => s.id)).size, 7);
});

ok('升级后老课程补上学科（只填空的，不覆盖已有值）', () => {
  const c = up.courses.find(x => x.name === '楷书');
  assert.ok(c.subjectId > 0, '楷书没被归类');
  assert.strictEqual((up.subjects.find(s => s.id === c.subjectId) || {}).gid, 'sub_calligraphy');
});

ok('升级后老记录 scoreScale=100、kpIds=[]，分数与内容不变', () => {
  const r = up.records[0];
  assert.strictEqual(r.scoreScale, 100);
  assert.deepStrictEqual(r.kpIds, []);
  assert.strictEqual(r.score, 92);
  assert.strictEqual(r.note, '写得很稳');
});

ok('升级幂等：再跑一次不产生第二套学科，归类不变', () => {
  const twice = migrate.upgrade(JSON.parse(JSON.stringify(up)), 3000);
  assert.strictEqual(twice.subjects.length, 7);
  assert.deepStrictEqual(twice.subjects.map(s => s.gid).sort(), up.subjects.map(s => s.gid).sort());
  assert.strictEqual(twice.courses.find(x => x.name === '楷书').subjectId, up.courses.find(x => x.name === '楷书').subjectId);
});

ok('机构改过学科名时，升级不会把名字冲回内置名', () => {
  const renamed = JSON.parse(JSON.stringify(up));
  const m = renamed.subjects.find(s => s.gid === 'sub_math');
  m.name = '思维数学';
  const again = migrate.upgrade(renamed, 4000);
  assert.strictEqual(again.subjects.find(s => s.gid === 'sub_math').name, '思维数学');
});

/* ---------- E. 满分口径与知识点引用 ---------- */
console.log('\n【E. 满分口径 / 知识点引用】');

const rec = (patch) => schema.normalizeRecord(Object.assign({
  sid: 1, cid: 1, date: '2026-11-05', score: 85, note: ''
}, patch), schema.DEFAULT_ORG, 1000);

ok('满分 10 分的记录可以写 8.5 分，写 85 分被拒绝', () => {
  assert.strictEqual(schema.validate('record', rec({ score: 8.5, scoreScale: 10 })), null);
  const bad = schema.validate('record', rec({ score: 85, scoreScale: 10 }));
  assert.ok(bad && bad.indexOf('0-10') > -1, '应提示 0-10，实际：' + bad);
});

ok('scoreScale 非法值（0 / 5000 / 非数字）一律回落 100', () => {
  assert.strictEqual(rec({ scoreScale: 0 }).scoreScale, 100);
  assert.strictEqual(rec({ scoreScale: 5000 }).scoreScale, 100);
  assert.strictEqual(rec({ scoreScale: 'abc' }).scoreScale, 100);
  assert.strictEqual(rec({ scoreScale: 150 }).scoreScale, 150);
});

ok('kpIds 只保留数字（脏数据不污染统计）', () => {
  assert.deepStrictEqual(rec({ kpIds: [3, 'x', '5', null] }).kpIds, [3, 5]);
  assert.deepStrictEqual(rec({}).kpIds, []);
});

ok('学科/知识点的必填校验拦得住半成品数据', () => {
  const s = schema.normalizeSubject({ name: '数学' }, schema.DEFAULT_ORG, 1000);
  assert.ok(schema.validate('subject', s), '缺 gid 应被拒绝');
  const k = schema.normalizeKnowledgePoint({ name: '分数', subjectId: 2 }, schema.DEFAULT_ORG, 1000);
  assert.ok(schema.validate('knowledgePoint', k), '缺 path 应被拒绝');
  const okK = schema.normalizeKnowledgePoint({ gid: 'kp_1', name: '分数', subjectId: 2, path: '数学/分数' }, schema.DEFAULT_ORG, 1000);
  assert.strictEqual(schema.validate('knowledgePoint', okK), null);
  assert.strictEqual(okK.depth, 1, '深度应由 path 推导');
});

/* ---------- F. 数据字典门禁 ---------- */
console.log('\n【F. 数据字典与代码一致】');

ok('tools/schema-doc.js --check 通过（文档没过期）', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'schema-doc.js'), '--check'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, (r.stdout || '') + (r.stderr || '') + '\n  运行 npm run docs:schema 重新生成');
});

/* ---------- G. 启动期补出来的行必须让同步层看见 ----------
 * 事故原型：学科种子由启动维护写入，走的是 core.flushAll（落盘但"不算改动"的快路径），
 * 不过写钩子 → 不标脏 → 永远不推云端。现场表现为"本机 7 条、云端 0 条"，重启也不会好。
 * 这三条断言守的就是这条缝：维护期新增/修改过的集合，必须出现在 sync.dirty 里。 */
console.log('\n【G. 启动期补的行要能被同步层看见】');

// 先给一个最小 wx 桩：media.js 在加载时就会读 wx.env，没有它整个数据层起不来
global.wx = global.wx || { env: { USER_DATA_PATH: '' } };

function bootDb(seed) {
  const mem = {};
  Object.keys(seed).forEach(k => { mem[k] = JSON.parse(JSON.stringify(seed[k])); });
  global.wx = {
    getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
    setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
    removeStorageSync: k => { delete mem[k]; },
    getStorageInfoSync: () => ({ keys: Object.keys(mem), currentSize: 1, limitSize: 10240 })
  };
  Object.keys(require.cache).forEach(k => { if (k.indexOf('utils') > -1) delete require.cache[k]; });
  const db = require('../utils/db');
  db.init();
  return { db, mem };
}

const fixture = require('./fixture');

ok('v9 设备丢了学科种子：启动补齐后必须标脏（否则只在本机）', () => {
  const seed = fixture.richSeed();
  seed['chengguo_v3_subjects'] = [];
  delete seed.chengguo_v3_meta.subjStamp;
  const { db } = bootDb(seed);
  assert.strictEqual(db.subjects.list().length, 7, '种子应被补齐');
  assert.ok(db.sync.dirtyCols().indexOf('subjects') > -1, 'subjects 必须进 dirty，否则推不上云端');
});

ok('v8 老库升级到 v9：新表也要进 dirty（不是只写本地）', () => {
  const seed = fixture.richSeed();
  seed['chengguo_v3_meta'].version = 8;
  delete seed['chengguo_v3_meta'].subjStamp;
  delete seed['chengguo_v3_subjects'];
  delete seed['chengguo_v3_knowledge_points'];
  seed['chengguo_v3_courses'].forEach(c => { delete c.subjectId; });
  const { db } = bootDb(seed);
  assert.strictEqual(db.subjects.list().length, 7);
  const dirty = db.sync.dirtyCols();
  assert.ok(dirty.indexOf('subjects') > -1, 'subjects 必须进 dirty');
  assert.ok(dirty.indexOf('courses') > -1, '补了 subjectId 的课程也要进 dirty');
});

ok('启动维护后不重复标脏：推完清脏，第二次启动不再标', () => {
  const seed = fixture.richSeed();
  seed['chengguo_v3_subjects'] = [];
  delete seed.chengguo_v3_meta.subjStamp;
  const first = bootDb(seed);
  const names = first.db.sync.dirtyCols();
  assert.ok(names.indexOf('subjects') > -1);
  first.db.sync.clearDirty(names);          // 等价于"这一轮推成功了"
  const second = bootDb(first.mem);
  assert.deepStrictEqual(second.db.sync.dirtyCols(), [], '种子已齐全且已打戳，第二次启动不该再标脏');
});

console.log('\n【H. 坏档自救：成员丢了以后还能不能救回来】');

ok('成员表空了就是坏档：actor 为空、所有写操作都提示「请先登录」', () => {
  const seed = fixture.richSeed();
  seed['chengguo_v3_members'] = [];
  const { db } = bootDb(seed);
  assert.strictEqual(db.auth.actor(), null, '没有成员记录就没有身份');
  assert.strictEqual(db.auth.denyReason('class.write'), '请先登录');
  const r = db.classes.create({ name: '新班', termId: 1 });
  assert.strictEqual(r.ok, false, '坏档状态下建班级必须被拦（这就是真机上看到的那一幕）');
  assert.strictEqual(r.msg, '请先登录');
});

ok('resetReal 能把坏档救回出厂：重建负责人 + 清空业务数据 + 身份恢复', () => {
  const seed = fixture.richSeed();
  seed['chengguo_v3_members'] = [];
  const { db, mem } = bootDb(seed);
  assert.strictEqual(db.auth.actor(), null);
  const r = db.resetReal();
  assert.strictEqual(r.ok, true, '重置应成功');
  const a = db.auth.actor();
  assert.ok(a, '重置后必须有身份，否则还是死结');
  assert.strictEqual(a.role, 'owner');
  assert.strictEqual(db.students.list().length, 0, '出厂态没有学生');
  assert.strictEqual(db.records.list().length, 0, '出厂态没有记录');
  // 落盘：重新用同一份存储启动，身份仍在（否则"重置完一重启又坏"）
  const again = bootDb(mem);
  assert.ok(again.db.auth.actor(), '重启后身份仍要在');
});

ok('rawCounts 能区分「数据丢了」和「数据挂在别的机构号下」', () => {
  const seed = fixture.richSeed();
  seed['chengguo_v3_students'].push({
    id: 9001, orgId: 'org-orphan', name: '别人的学生', no: 9001,
    clsIds: [], createdAt: 1, updatedAt: 1, removed: false
  });
  const { db } = bootDb(seed);
  const row = db.rawCounts().find(x => x.k === 'students');
  assert.ok(row, '要有 students 这一行');
  assert.ok(row.all > row.mine, '总条数应大于本机构条数：数据还在，只是挂在别的机构号下');
  assert.strictEqual(row.all - row.mine, 1);
  assert.ok(row.label, '要有中文名，界面上直接显示');
});

ok('存储页必须有重置入口与诊断区块（没有出口，坏档就只能卸载重装）', () => {
  const fs = require('fs');
  const path = require('path');
  const wxml = fs.readFileSync(path.join(__dirname, '../pages/storage/storage.wxml'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../pages/storage/storage.js'), 'utf8');
  assert.ok(wxml.indexOf('重置本机数据') > -1, '页面上要有重置按钮');
  assert.ok(wxml.indexOf('rawRows') > -1, '页面上要显示原始条数');
  assert.ok(js.indexOf('db.resetReal') > -1, '按钮要接重置实现');
  assert.strictEqual(js.indexOf("const COLLS = ['orgs'"), -1, '云端备份的集合清单不许再手抄');
});

console.log('\n全部 ' + pass + ' 项数据模型断言通过');
