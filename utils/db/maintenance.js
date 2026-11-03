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
const { now, org, oc, deny, memberCurrentOfRole } = require('./ctx');

/* =====================================================================
 * 启动：加载 → 迁移 → 规范化 → 演示数据 → 引用修复 → 媒体自愈
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
    const seeded = seedDemo();
    const repaired = repairRefs();
    const mediaFixed = repairMedia();
    if (changed || seeded || repaired || mediaFixed || !loaded.meta || loaded.meta.version !== schema.VERSION) {
      core.flushAll();
    }
  } catch (e) {
    // 启动失败不能让整页白屏，也不能把坏状态写回磁盘：
    // 降级成"内存空库 + 只读"，磁盘数据原样保留，页面照常渲染空态。
    bootError = (e && e.message) || '数据加载失败';
    core.setReadOnly(true);
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

// 演示数据：版本变了才整批替换（演示学生与演示记录一起换，真实数据不动）
function seedDemo() {
  if (core.meta().demoVersion === demo.DEMO_VERSION) return false;
  const demoIds = {};
  demo.DEMO_STUDENTS.forEach(s => { demoIds[s.id] = 1; });
  const OLD_DEMO_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]; // 早期种子与第一版演示学生

  core.setColl('records', core.coll('records').filter(r => !r.demo));
  const kept = core.coll('students').filter(s =>
    !(s.demo || OLD_DEMO_IDS.indexOf(s.id) > -1 || demoIds[s.id]));
  const addedStudents = demo.DEMO_STUDENTS.map(s =>
    schema.normalizeStudent(Object.assign({}, s, {
      clsIds: s.clsIds.slice(),
      // 入学年份按 id 确定性铺开（2022–2025），让「按年份筛选」在演示数据上立即可见
      enrollYear: 2022 + (s.id % 4)
    }), org(), now()));
  core.setColl('students', kept.concat(addedStudents));

  const addedRecords = demo.DEMO_RECORDS.map(r =>
    schema.normalizeRecord(Object.assign({ tid: core.meta().me }, r), org(), now()));
  core.setColl('records', core.coll('records').concat(addedRecords));

  // 家长演示账号绑第一个孩子：权限在 member 上，不在 user 上
  const p = memberCurrentOfRole('parent');
  if (p) {
    p.studentIds = [demo.DEMO_STUDENTS[0].id];
    if (p.status === 'invited') p.status = 'active';
    p.updatedAt = now();
    core.persist('members');
  }

  // 演示老师若没有任何班级分工，给他全部班级（否则 fail-closed 下看不到东西）
  const t = memberCurrentOfRole('teacher');
  if (t && !t.clsIds.length) {
    t.clsIds = oc('classes').map(c => c.id);
    t.updatedAt = now();
    core.persist('members');
  }

  core.updateMeta({ demoVersion: demo.DEMO_VERSION });
  return true;
}

// 清空演示数据：只删带 demo 标记的记录与学生，真实数据不动。
// 只清数据、不重置 demoVersion——否则下次启动演示数据又会长回来。
function demoClear() {
  const err = deny('member.manage');
  if (err) return { ok: false, msg: err };
  const rec = core.coll('records');
  const stu = core.coll('students');
  const nr = rec.filter(r => !r.demo);
  const ns = stu.filter(s => !s.demo);
  const rm = { records: rec.length - nr.length, students: stu.length - ns.length };
  if (!rm.records && !rm.students) return { ok: true, item: rm };
  core.setColl('records', nr);
  core.setColl('students', ns);
  return { ok: true, item: rm };
}

// 云端拉取结果合并（按 updatedAt 取新，只处理记录与学生资料）
// 【机构归属】外部数据一律强制打上当前机构：normalize 时 audit 优先用 raw.orgId，
// 若云端带回来的是别的 orgId，记录会入库却永远读不出来（幽灵数据）。
function merge(remote) {
  if (!remote) return false;
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
  init, status, normalizeAll, repairRefs, repairMedia,
  seedDemo, demoClear, merge
};
