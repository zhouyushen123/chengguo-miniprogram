// utils/db/maintenance.js —— 启动、自愈与云端合并
//
// 这里放的是「整个库级别」的操作：加载/迁移、规范化、引用修复、媒体自愈、演示数据、云端合并。
// 它们必须直接操作 core.coll（全量集合），不能用 oc()——否则 setColl 这类覆盖写会把
// 其他机构的数据一起抹掉。依赖：ctx（底座），不依赖具体领域的读写函数。
const storage = require('./storage');
const schema = require('./schema');
const core = require('./core');
const migrate = require('./migrate');
const media = require('../media');
const demo = require('../demo-data');
const { now, org, oc } = require('./ctx');

/* =====================================================================
 * 启动：加载 → 迁移 → 规范化 → 演示数据包 → 引用修复 → 媒体自愈 → 决定看哪套数据
 * ===================================================================*/
let inited = false;
let bootError = '';

function init() {
  if (inited) return;
  try {
    const loaded = storage.load();
    const data = (loaded.meta && loaded.meta.version === schema.VERSION)
      ? loaded
      : migrate.build(loaded);
    core.hydrate(data);

    const changed = normalizeAll();
    const purged = purgeSeed();          // 老版本混在真实库里的演示数据 → 请出去（演示包里另有一份）
    ensureDemo();                        // 演示数据包：缺了就按 demo-data 建，版本变了就重建
    const repaired = repairRefs();
    const mediaFixed = repairMedia();
    resolveMode(purged);                 // 该进演示还是回真实机构
    if (changed || purged || repaired || mediaFixed) core.flushAll();
  } catch (e) {
    // 启动失败不能让整页白屏，也不能把坏状态写回磁盘：
    // 降级成"内存空库 + 只读"，磁盘数据原样保留，页面照常渲染空态。
    bootError = (e && e.message) || '数据加载失败';
    core.setReadOnly(true);
    core.setMode('real');
    if (!core.isReady()) {
      try { core.hydrate(migrate.buildFresh(Date.now())); } catch (e2) { /* 连兜底都失败就只能空着 */ }
    }
    console.error('[db] 初始化失败，已降级为只读', e);
  }
  inited = true;
}

// 启动状态：页面可据此提示"数据读取异常，当前为只读"
function status() {
  return { ready: inited, degraded: !!bootError, error: bootError, readOnly: core.isReadOnly() };
}

// 把库里所有实体按当前 schema 过一遍（补默认字段、修正日期格式、丢弃未知字段）
function normalizeAll() {
  let changed = false;
  const each = (name, fn) => {
    const list = core.coll(name);
    for (let i = 0; i < list.length; i++) {
      const next = fn(list[i], org(), now());
      if (JSON.stringify(next) !== JSON.stringify(list[i])) { list[i] = next; changed = true; }
    }
  };
  each('orgs', x => schema.normalizeOrg(x, now()));
  each('members', schema.normalizeMember);
  each('terms', schema.normalizeTerm);
  each('classes', schema.normalizeClass);
  each('courses', schema.normalizeCourse);
  each('students', schema.normalizeStudent);
  each('enrollments', schema.normalizeEnrollment);
  each('records', schema.normalizeRecord);
  each('users', schema.normalizeUser);
  each('templates', schema.normalizeTemplate);
  const m = core.meta();
  if (!m.version) {
    core.updateMeta({
      version: schema.VERSION, orgId: m.orgId || schema.DEFAULT_ORG,
      orgName: m.orgName || '我的机构', createdAt: now(), updatedAt: now()
    });
    changed = true;
  }
  // 兜底：机构表为空时补一个，避免权限判定无处可取
  if (!oc('orgs').length) {
    const first = oc('users').find(u => u.role !== 'parent') || oc('users')[0];
    core.coll('orgs').push(schema.normalizeOrg({
      id: org(), name: m.orgName || '我的机构',
      ownerId: (first && first.id) || '', status: 'active'
    }, now()));
    changed = true;
  }
  // 兜底：内置「长期班」不存在或班级没挂靠学期时补齐（版本刚升级/异常数据）
  const termFix = migrate.ensureBuiltinTerm(core.coll('terms'), core.coll('classes'), org(), now());
  if (termFix.changed) changed = true;
  return changed;
}

// 引用完整性自愈：老记录缺班级/缺课程/缺录入老师时按学生与班级回填
function repairRefs() {
  let changed = 0;
  const me = core.meta().me || '';
  const students = core.coll('students');
  const courses = core.coll('courses');
  core.coll('records').forEach(r => {
    if (r.removed) return;
    if (!r.cid) {
      const s = students.find(x => x.id === r.sid);
      if (s && s.clsIds.length) { r.cid = s.clsIds[0]; changed++; }
    }
    if (!r.courseId && r.course) {
      const c = courses.find(x => x.clsId === r.cid && x.name === r.course && !x.removed);
      if (c) { r.courseId = c.id; changed++; }
    }
    // tid 必须有值：为空会让"只能改自己录的"这条规则失效
    if (!r.tid && me) { r.tid = me; changed++; }
  });
  return changed > 0;
}

// 媒体自愈：历史记录里的 photos / videos / audio 可能还是临时路径（系统随时会清理），
// 启动时尝试把它们转存成持久文件。源文件已经不在了就无法恢复——此时保留原路径不动，
// 而不是清空引用：清空等于主动删掉用户照片，留着至少还有一丝恢复可能。
function repairMedia() {
  let n = 0;
  const fix = (p, kind) => {
    const s = schema.str(p);
    if (!s || media.isPersist(s)) return s;
    if (!media.exists(s)) return s;
    const next = media.persist(s, kind);
    if (next && next !== s) { n++; return next; }
    return s;
  };
  oc('records').forEach(r => {
    const photos = (r.photos || []).map(p => fix(p, 'photo'));
    const videos = (r.videos || []).map(p => fix(p, 'video'));
    const audio = r.audio ? fix(r.audio, 'audio') : r.audio;
    if (photos.join('|') !== (r.photos || []).join('|')) r.photos = photos;
    if (videos.join('|') !== (r.videos || []).join('|')) r.videos = videos;
    if (audio !== r.audio) r.audio = audio;
  });
  oc('students').forEach(s => {
    if (s.photo) {
      const np = fix(s.photo, 'photo');
      if (np !== s.photo) s.photo = np;
    }
  });
  return n > 0;
}

// 真实库引用着的媒体文件集合（跨机构、含已软删的记录）。
// 「存储空间」页拿它和磁盘目录比对，差集就是可以清理的垃圾文件。
// 已删除的记录也算"引用"：宁可留着，也不要因为一条被误删的记录把照片真删了——
// 用户的照片删掉就找不回来了，多占几百 KB 是可以接受的代价。
function mediaRefs() {
  const st = core.realData();
  const out = {};
  const add = v => { const s = schema.str(v); if (s) out[s] = 1; };
  (st.students || []).forEach(s => add(s.photo));
  (st.records || []).forEach(r => {
    (r.photos || []).forEach(add);
    (r.videos || []).forEach(add);
    add(r.audio);
  });
  return out;
}

/* =====================================================================
 * 演示数据
 *
 * 【设计】演示数据不是"真实库里打了标记的行"，而是磁盘上另一套 key（storage.demo）里的
 * 完整一套数据：机构、学期、班级、课程、成员、学生、记录全都有。当前看哪一套由
 * core.setMode('real' | 'demo') 决定，切换只换指针，不搬数据。
 *
 * 好处：
 *   1. 重播/清空/改造演示数据，物理上碰不到真实数据 —— 不再依赖 demoVersion 这个开关
 *   2. 不需要每一处查询都记得过滤 demo 标记，也就不会漏
 *   3. 演示模式下写操作被 ctx.deny 拦下（样板间能看不许改），误操作不会留在真实数据里
 * ===================================================================*/
const DEMO_ORG_NAME = '演示机构';

// 用 buildFresh 的默认骨架 + demo-data 的学生与记录拼出整套演示数据：
// 骨架里已经带了书法班/素描班、楷书/素描、负责人与家长账号、默认评价模板，
// 演示学生正好挂在这两个班上，一份数据就能把 App 每个页面填满。
function buildDemoData() {
  const stamp = now();
  const d = migrate.buildFresh(stamp);
  const o = schema.DEFAULT_ORG;
  d.meta = Object.assign({}, d.meta, {
    orgName: DEMO_ORG_NAME, demoVersion: demo.DEMO_VERSION,
    // 演示包自己的 meta 永远是"真实库"，它不会嵌套切模式
    sandbox: false, createdAt: stamp, updatedAt: stamp
  });
  d.orgs = d.orgs.map(x => Object.assign({}, x, { name: DEMO_ORG_NAME }));

  d.students = demo.DEMO_STUDENTS.map(s => schema.normalizeStudent(Object.assign({}, s, {
    clsIds: s.clsIds.slice(),
    // 入学年份按 id 确定性铺开（2022–2025），让「按年份筛选」在演示数据上立即可见
    enrollYear: 2022 + (s.id % 4)
  }), o, stamp));
  d.records = demo.DEMO_RECORDS.map(r =>
    schema.normalizeRecord(Object.assign({ tid: d.meta.me }, r), o, stamp));

  // 家长演示账号绑第一个孩子：权限在 member 上，不在 user 上
  const p = d.members.find(m => m.role === 'parent');
  if (p) {
    p.studentIds = [demo.DEMO_STUDENTS[0].id];
    if (p.status === 'invited') p.status = 'active';
    p.updatedAt = stamp;
  }
  // 演示老师拿到全部班级：fail-closed 下不分配就什么都看不到
  const t = d.members.find(m => m.role !== 'parent');
  if (t) {
    t.clsIds = d.classes.map(c => c.id);
    t.updatedAt = stamp;
  }
  return d;
}

function writeDemoPackage(d) {
  storage.demo.removeAll();   // 先清干净：删掉已经不存在的实体，避免旧 key 残留
  storage.COLLECTIONS.forEach(n => storage.demo.saveCollection(n, d[n]));
  storage.demo.saveMeta(d.meta);
}

// 演示包就绪：磁盘上有且版本一致就直接用，否则按当前 demo-data 重建
function ensureDemo() {
  const saved = storage.demo.load();
  const usable = saved.meta
    && saved.meta.demoVersion === demo.DEMO_VERSION
    && (saved.students.length || saved.records.length);
  if (usable) { core.hydrateDemo(saved); return false; }
  const built = buildDemoData();
  writeDemoPackage(built);
  core.hydrateDemo(built);
  return true;
}

// 老版本把演示数据直接灌进了真实库（靠 demoVersion 区分）。现在它们已经有独立的家，
// 真实库里那些带 demo 标记的学生与记录要一次性清出去 —— 不清就变成"看起来像真实数据"
// 的幽灵行：统计、导出、家长绑定都会把它算进去。
function purgeSeed() {
  const stu = core.coll('students');
  const rec = core.coll('records');
  const seeded = stu.filter(s => s.demo);
  if (!seeded.length && !rec.some(r => r.demo)) return false;
  const ids = {};
  seeded.forEach(s => { ids[s.id] = 1; });
  // 挂在演示学生上的记录一并清掉：没有学生，留着就是一条无主记录
  const keepRec = rec.filter(r => !r.demo && !ids[r.sid]);
  core.setColl('students', stu.filter(s => !s.demo));
  core.setColl('records', keepRec);
  core.coll('members').forEach(m => {
    const next = (m.studentIds || []).filter(sid => !ids[sid]);
    if (next.length !== (m.studentIds || []).length) { m.studentIds = next; m.updatedAt = now(); }
  });
  core.persist('members');
  return true;
}

// 决定启动后看哪一套。
// 优先级：用户显式选择（meta.sandbox）> 本次启动刚清掉演示数据（那就还给他演示视图）> 真实机构。
// 为什么不在"库是空的"时候自动进演示：空库不等于"想看样板间"——老师刚清空学生准备
// 重新录入时被弹回演示模式，会以为自己的库坏了。模式由用户点，不由猜测。
function resolveMode(justPurged) {
  const m = core.realMeta();
  let sandbox = m.sandbox;
  if (typeof sandbox !== 'boolean') {
    sandbox = !!justPurged;
    core.updateRealMeta({ sandbox });
  }
  core.setMode(sandbox ? 'demo' : 'real');
  return core.isSandbox();
}

/* ---------------- 演示模式的对外开关 ---------------- */
const demoApi = {
  active: () => core.isSandbox(),
  available: () => core.isDemoReady(),
  // 进演示：只切指针 + 记住选择，真实数据一个字节都不动
  enter() {
    if (!core.isDemoReady()) return { ok: false, msg: '演示数据还没准备好，请重启小程序' };
    core.setMode('demo');
    core.updateRealMeta({ sandbox: true });
    return { ok: true };
  },
  // 回真实机构。哪怕真实库是空的也留在真实模式：用户既然点了"开始使用"，
  // 就不该下次打开又被塞回演示样板间。
  exit() {
    core.setMode('real');
    core.updateRealMeta({ sandbox: false });
    return { ok: true };
  },
  // 重置：把演示包按当前 demo-data 重建（演示时乱点的痕迹一并消失），真实数据不受影响
  reset() {
    const built = buildDemoData();
    writeDemoPackage(built);
    core.hydrateDemo(built);
    if (core.isSandbox()) core.setMode('demo');
    return { ok: true, item: { students: built.students.length, records: built.records.length } };
  }
};

// 云端拉取结果合并（按 updatedAt 取新，只处理记录与学生资料）
// 【机构归属】外部数据一律强制打上当前机构：normalize 时 audit 优先用 raw.orgId，
// 若云端带回来的是别的 orgId，记录会入库却永远读不出来（幽灵数据）。
// 【演示模式】合并只写真实库：demo 态的落盘本来就是关掉的，这里显式跳过免得白跑。
function merge(remote) {
  if (!remote || core.isSandbox()) return false;
  const o = org();
  let changed = false;
  const own = raw => !(raw && raw.orgId && raw.orgId !== o);
  (remote.records || []).forEach(raw => {
    if (!own(raw)) return;
    const inc = schema.normalizeRecord(Object.assign({}, raw, { orgId: o }), o, now());
    if (!inc.id) return;
    const cur = core.coll('records').find(r => r.id === inc.id);
    if (!cur) { core.coll('records').push(inc); changed = true; }
    else if ((inc.updatedAt || 0) > (cur.updatedAt || 0)) { Object.assign(cur, inc); changed = true; }
  });
  (remote.profiles || []).forEach(p => {
    if (!own(p)) return;
    const s = core.coll('students').find(x => x.id === Number(p.sid));
    if (s && p.profile) { s.profile = p.profile; s.updatedAt = now(); changed = true; }
  });
  if (changed) { core.persist('records'); core.persist('students'); }
  return changed;
}

module.exports = {
  mediaRefs,
  init, status, normalizeAll, repairRefs, repairMedia,
  buildDemoData, ensureDemo, purgeSeed, resolveMode, demo: demoApi, merge
};
