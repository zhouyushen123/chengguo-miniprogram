// utils/db/index.js —— 主数据访问层（唯一出口）
//
// 用法：const db = require('../../utils/db');
//   db.classes.list()            db.students.of(clsId)        db.records.save(pick, true)
//   db.auth.actor()              db.auth.can('record.send',{record})
//
// 【约定】
// 1. 页面只通过本文件读写数据：不碰 wx.setStorageSync，也不直接改返回对象里的字段
//    （改字段请调用 update / markSent 等方法，否则不会落盘、也不会更新 updatedAt）
// 2. 所有写操作都过 schema 规范化 + 校验 + 权限判定，非法或越权的写不进去
// 3. 所有实体都带 orgId / createdAt / updatedAt / removed，软删除保留痕迹便于多端同步
// 4. 换云端只替换 utils/db/storage.js 的实现，这里和页面都不用改
//
// 【权限策略：读也过滤，不只拦写】
// 列表查询默认已按当前身份过滤（老师只见自己班、家长只见自己孩子且仅已发布）。
// 页面不要再自己写 role === 'parent' 之类的判断——规则只在 permissions.js 定义一次。
// 需要绕过身份过滤做统计时，用 oc(name)（仍限当前机构）；确实需要跨机构全量才用 core.coll。
// 注意：写操作与启动维护（normalizeAll / repairRefs / seedDemo / merge）必须用 core.coll，
// 否则 setColl 这类覆盖写会把他机构的数据一起抹掉。
const storage = require('./storage');
const schema = require('./schema');
const core = require('./core');
const migrate = require('./migrate');
const perms = require('./permissions');
const pinyin = require('../pinyin');
const demo = require('../demo-data');
const media = require('../media');

const now = () => Date.now();
const org = () => (core.meta().orgId || schema.DEFAULT_ORG);
// 读路径统一入口：当前机构视图。所有列表/查找都必须走这里，绝不能直接读全量集合，
// 否则其他机构的数据会混进来（曾经的真实 bug：org2 的班级出现在 org1 的列表里）。
const oc = name => core.orgColl(name);

/* =====================================================================
 * 身份与权限
 * ===================================================================*/
// 当前机构下、当前登录人的成员关系（权限的唯一来源）
function memberCurrent() {
  const m = core.meta().me;
  const list = oc('members').filter(x => x.status !== 'disabled');
  return list.find(x => x.userId === m) || list[0] || null;
}

// 把成员关系 + 学生表算成可判定的身份对象（每次实时计算，避免写操作后失效）
function actor() {
  const m = memberCurrent();
  if (!m) return null;
  const u = oc('users').find(x => x.id === m.userId);
  return perms.actorOf({
    id: m.id, orgId: m.orgId, userId: m.userId,
    role: m.role,
    name: (u && u.name) || m.name,
    clsIds: m.clsIds, courseIds: m.courseIds, studentIds: m.studentIds
  }, oc('students'));
}

// 写操作统一闸门：返回 null 表示放行，否则返回可直接 toast 的文案
function deny(action, target) {
  const a = actor();
  if (perms.can(a, action, target)) return null;
  return perms.denyReason(a, action);
}

/* =====================================================================
 * 启动：加载 → 迁移 → 规范化 → 演示数据 → 引用修复 → 媒体自愈
 * ===================================================================*/let inited = false;
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
  each('classes', schema.normalizeClass);
  each('courses', schema.normalizeCourse);
  each('students', schema.normalizeStudent);
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
    schema.normalizeStudent(Object.assign({}, s, { clsIds: s.clsIds.slice() }), org(), now()));
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

function memberCurrentOfRole(role) {
  return oc('members').find(m => m.role === role) || null;
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

/* =====================================================================
 * 机构
 * ===================================================================*/
function orgCurrent() {
  return oc('orgs').find(o => o.id === org()) || null;
}
function orgUpdate(patch) {
  const err = deny('org.manage');
  if (err) return { ok: false, msg: err };
  const o = orgCurrent();
  if (!o) return { ok: false, msg: '机构不存在' };
  const next = schema.normalizeOrg(Object.assign({}, o, patch), now());
  const e = schema.validate('org', next);
  if (e) return { ok: false, msg: e };
  next.id = o.id; next.updatedAt = now();
  Object.assign(o, next);
  core.persist('orgs');
  core.updateMeta({ orgName: o.name });
  return { ok: true, item: o };
}

/* =====================================================================
 * 成员（机构 × 人 × 角色 × 数据范围）
 * ===================================================================*/
function memberList() {
  return oc('members').slice();
}
// 成员的可读视图：补上人员姓名与范围文字（页面直接用，不必再各处拼）
function memberView(m) {
  const cls = m.clsIds.map(id => className(id)).filter(Boolean);
  const kids = m.studentIds.map(id => (studentRaw(id) || {}).name).filter(Boolean);
  return {
    id: m.id, userId: m.userId, name: m.name,
    role: m.role, roleLabel: perms.ROLE_LABEL[m.role] || m.role,
    status: m.status,
    clsIds: m.clsIds.slice(), courseIds: m.courseIds.slice(), studentIds: m.studentIds.slice(),
    clsText: cls.join('、'),
    kidText: kids.join('、'),
    full: perms.FULL.indexOf(m.role) > -1
  };
}
function memberGet(id) {
  return oc('members').find(m => m.id === Number(id)) || null;
}
function memberOfUser(userId) {
  return oc('members').find(m => m.userId === String(userId)) || null;
}

function memberCreate(data) {
  const err = deny('member.manage');
  if (err) return { ok: false, msg: err };
  const d = data || {};
  // 一个机构只能有一个负责人：多个人都拿 owner 会让"谁最大"失去意义
  if (d.role === 'owner' && oc('members').some(m => m.role === 'owner')) {
    return { ok: false, msg: '该机构已有负责人，请用「移交负责人」转移' };
  }
  // 有 id 视为给已存在的人员补一条成员关系，没有则先建人
  let userId = schema.str(d.userId).trim();
  if (!userId) {
    const u = schema.normalizeUser({ id: 'u' + now(), name: d.name, role: d.role }, org(), now());
    const eu = schema.validate('user', u);
    if (eu) return { ok: false, msg: eu };
    core.coll('users').push(u);
    core.persist('users');
    userId = u.id;
  } else {
    const exist = userGet(userId);
    if (!exist) return { ok: false, msg: '人员不存在' };
    if (exist.name !== schema.str(d.name).trim() && d.name) {
      exist.name = schema.str(d.name).trim(); exist.updatedAt = now();
      core.persist('users');
    }
    if (memberOfUser(userId)) return { ok: false, msg: '该人员已在本机构中' };
  }

  const e = schema.normalizeMember({
    id: core.nextId(), orgId: org(), userId,
    role: d.role, name: d.name,
    clsIds: d.clsIds, courseIds: d.courseIds, studentIds: d.studentIds,
    status: d.status
  }, org(), now());
  const ev = schema.validate('member', e);
  if (ev) return { ok: false, msg: ev };
  core.coll('members').push(e);
  core.persist('members');
  return { ok: true, item: memberView(e), raw: e };
}

function memberUpdate(id, patch) {
  const err = deny('member.manage');
  if (err) return { ok: false, msg: err };
  const m = memberGet(id);
  if (!m) return { ok: false, msg: '成员不存在' };
  const p = patch || {};
  // 机构负责人只能有一个：转移负责人要显式走 ownerTransfer，避免把自己锁在外面
  if (p.role === 'owner' && m.role !== 'owner') return { ok: false, msg: '请用「移交负责人」操作' };
  const next = schema.normalizeMember(Object.assign({}, m, p), org(), now());
  const ev = schema.validate('member', next);
  if (ev) return { ok: false, msg: ev };
  next.id = m.id; next.updatedAt = now();
  Object.assign(m, next);
  if (p.name) {
    const u = userGet(m.userId);
    if (u) { u.name = p.name; u.updatedAt = now(); core.persist('users'); }
  }
  core.persist('members');
  return { ok: true, item: memberView(m) };
}

function memberRemove(id) {
  const err = deny('member.manage');
  if (err) return { ok: false, msg: err };
  const m = memberGet(id);
  if (!m) return { ok: false, msg: '成员不存在' };
  if (m.role === 'owner') return { ok: false, msg: '不能移除机构负责人' };
  m.removed = true; m.updatedAt = now();
  core.persist('members');
  return { ok: true };
}

/* =====================================================================
 * 班级
 * ===================================================================*/
function classList() {
  const a = actor();
  return oc('classes').filter(c => perms.canSeeClass(a, c.id))
    .slice().sort((x, y) => (x.sort - y.sort) || (x.id - y.id));
}
// 不过滤的全量（内部统计与名称解析用，不暴露给页面）
function classRaw(id) {
  const x = Number(id);
  return oc('classes').find(c => c.id === x) || null;
}
function classGet(id) {
  const a = actor();
  return perms.canSeeClass(a, id) ? classRaw(id) : null;
}
function className(id) { const c = classRaw(id); return c ? c.name : ''; }

function classCreate(data) {
  const err = deny('class.write');
  if (err) return { ok: false, msg: err };
  const e = schema.normalizeClass({ name: data && data.name, sort: data && data.sort }, org(), now());
  const ev = schema.validate('class', e);
  if (ev) return { ok: false, msg: ev };
  e.id = core.nextId();
  core.coll('classes').push(e);
  core.persist('classes');
  return { ok: true, item: e };
}
function classUpdate(id, patch) {
  const err = deny('class.write', { clsId: id });
  if (err) return { ok: false, msg: err };
  const c = classRaw(id);
  if (!c) return { ok: false, msg: '班级不存在' };
  const next = schema.normalizeClass(Object.assign({}, c, patch), org(), now());
  const ev = schema.validate('class', next);
  if (ev) return { ok: false, msg: ev };
  next.id = c.id; next.updatedAt = now();
  Object.assign(c, next);
  core.persist('classes');
  return { ok: true, item: c };
}
// 删除班级：班级软删，其课程一并软删，学生从该班移除（学生与历史记录保留）
function classRemove(id) {
  const err = deny('class.write', { clsId: id });
  if (err) return { ok: false, msg: err };
  const c = classRaw(id);
  if (!c) return { ok: false, msg: '班级不存在' };
  const t = now();
  c.removed = true; c.updatedAt = t;
  oc('courses').forEach(x => {
    if (x.clsId === c.id) { x.removed = true; x.updatedAt = t; }
  });
  oc('students').forEach(s => {
    const i = s.clsIds.indexOf(c.id);
    if (i > -1) { s.clsIds.splice(i, 1); s.updatedAt = t; }
  });
  // 成员负责范围里也要摘掉这个班，否则会留下指向已删班级的悬空授权
  oc('members').forEach(m => {
    const i = m.clsIds.indexOf(c.id);
    if (i > -1) { m.clsIds.splice(i, 1); m.updatedAt = t; }
  });
  core.persist('classes'); core.persist('courses'); core.persist('students'); core.persist('members');
  return { ok: true };
}

/* =====================================================================
 * 课程
 * ===================================================================*/
function courseList() {
  const a = actor();
  return oc('courses').filter(c => perms.canSeeClass(a, c.clsId))
    .slice().sort((x, y) => (x.clsId - y.clsId) || (x.id - y.id));
}
function courseOf(clsId) {
  const x = Number(clsId);
  const a = actor();
  if (!perms.canSeeClass(a, x)) return [];
  return oc('courses').filter(c => c.clsId === x)
    .sort((p, q) => p.id - q.id);
}
function courseGet(id) {
  const x = Number(id);
  const c = oc('courses').find(y => y.id === x);
  if (!c) return null;
  return perms.canSeeClass(actor(), c.clsId) ? c : null;
}
function courseCreate(data) {
  const err = deny('course.write', { clsId: data && data.clsId });
  if (err) return { ok: false, msg: err };
  const e = schema.normalizeCourse({ name: data && data.name, clsId: data && data.clsId }, org(), now());
  const ev = schema.validate('course', e);
  if (ev) return { ok: false, msg: ev };
  e.id = core.nextId();
  core.coll('courses').push(e);
  core.persist('courses');
  return { ok: true, item: e };
}
function courseUpdate(id, patch) {
  const c = courseGet(id);
  if (!c) return { ok: false, msg: '课程不存在或无权操作' };
  const err = deny('course.write', { clsId: c.clsId });
  if (err) return { ok: false, msg: err };
  const next = schema.normalizeCourse(Object.assign({}, c, patch), org(), now());
  const ev = schema.validate('course', next);
  if (ev) return { ok: false, msg: ev };
  next.id = c.id; next.updatedAt = now();
  Object.assign(c, next);
  core.persist('courses');
  return { ok: true, item: c };
}
function courseRemove(id) {
  const c = courseGet(id);
  if (!c) return { ok: false, msg: '课程不存在或无权操作' };
  const err = deny('course.write', { clsId: c.clsId });
  if (err) return { ok: false, msg: err };
  c.removed = true; c.updatedAt = now();
  core.persist('courses');
  return { ok: true };
}

/* =====================================================================
 * 学生
 * ===================================================================*/
function studentList() {
  const a = actor();
  return pinyin.sortStudents(oc('students').filter(s => perms.canSeeStudent(a, s)));
}
function studentOf(clsId) {
  const x = Number(clsId);
  const a = actor();
  if (!perms.canSeeClass(a, x)) return [];
  return pinyin.sortStudents(oc('students')
    .filter(s => s.clsIds.indexOf(x) > -1 && perms.canSeeStudent(a, s)));
}
// 内部用：不过滤权限（名称解析、引用校验），但仍限当前机构
function studentRaw(id) {
  const x = Number(id);
  return oc('students').find(s => s.id === x) || null;
}
function studentGet(id) {
  const s = studentRaw(id);
  if (!s) return null;
  return perms.canSeeStudent(actor(), s) ? s : null;
}
function studentName(id) { const s = studentRaw(id); return s ? s.name : ''; }
function studentSearch(q) {
  const k = String(q || '').trim();
  if (!k) return [];
  return studentList().filter(s => s.name.indexOf(k) > -1);
}
function studentCreate(data) {
  const err = deny('student.write');
  if (err) return { ok: false, msg: err };
  const d = data || {};
  // 老师只能在自班下建学生：传进来的班级必须都在自己范围内
  const a = actor();
  const clsIds = schema.numList(d.clsIds);
  if (a && !a.all && clsIds.some(c => !perms.canSeeClass(a, c))) {
    return { ok: false, msg: '只能在自己负责的班级下新增学生' };
  }
  const e = schema.normalizeStudent({
    name: d.name, clsIds, parent: d.parent, wechat: d.wechat, photo: d.photo, profile: d.profile
  }, org(), now());
  const ev = schema.validate('student', e);
  if (ev) return { ok: false, msg: ev };
  e.id = core.nextId();
  core.coll('students').push(e);
  core.persist('students');
  return { ok: true, item: e };
}
function studentUpdate(id, patch) {
  const s = studentRaw(id);
  if (!s) return { ok: false, msg: '学生不存在' };
  const err = deny('student.write', { student: s });
  if (err) return { ok: false, msg: err };
  const p = patch || {};
  // 越权改班级 = 把学生挪进自己班或挪出去，必须拦
  const a = actor();
  if (p.clsIds && a && !a.all) {
    const cur = s.clsIds;
    const next = schema.numList(p.clsIds);
    const touched = cur.filter(c => next.indexOf(c) < 0).concat(next.filter(c => cur.indexOf(c) < 0));
    if (touched.some(c => !perms.canSeeClass(a, c))) return { ok: false, msg: '无权调整该学生的班级归属' };
  }
  const next = schema.normalizeStudent(Object.assign({}, s, p), org(), now());
  const ev = schema.validate('student', next);
  if (ev) return { ok: false, msg: ev };
  next.id = s.id; next.updatedAt = now();
  Object.assign(s, next);
  core.persist('students');
  return { ok: true, item: s };
}
function studentUpdateProfile(id, profile) {
  const s = studentRaw(id);
  if (!s) return { ok: false, msg: '学生不存在' };
  // 家长可填自己孩子的资料；老师需在范围内
  const err = deny('profile.write', { student: s });
  if (err) return { ok: false, msg: err };
  s.profile = Object.assign({}, profile, { submittedAt: schema.ymd() });
  s.updatedAt = now();
  core.persist('students');
  return { ok: true, item: s };
}
// 删除学生：学生软删，其课堂记录一并软删（避免记录列表出现"无主记录"）
function studentRemove(id) {
  const s = studentRaw(id);
  if (!s) return { ok: false, msg: '学生不存在' };
  const err = deny('student.write', { student: s });
  if (err) return { ok: false, msg: err };
  const t = now();
  s.removed = true; s.updatedAt = t;
  let n = 0;
  oc('records').forEach(r => {
    if (r.sid === s.id) { r.removed = true; r.updatedAt = t; n++; }
  });
  // 家长绑定关系同步摘掉，避免指向已删学生
  oc('members').forEach(m => {
    const i = m.studentIds.indexOf(s.id);
    if (i > -1) { m.studentIds.splice(i, 1); m.updatedAt = t; }
  });
  core.persist('students'); core.persist('records'); core.persist('members');
  return { ok: true, records: n };
}

/* =====================================================================
 * 课堂记录
 * ===================================================================*/
function recordList() {
  const a = actor();
  return oc('records')
    .filter(r => perms.canSeeRecord(a, r))
    .slice().sort((x, y) => y.id - x.id);
}
function recordOfStudent(sid) {
  const x = Number(sid);
  const a = actor();
  return recordList().filter(r => r.sid === x && perms.canSeeRecord(a, r));
}
function recordOfClass(cid) {
  const x = Number(cid);
  const a = actor();
  if (!perms.canSeeClass(a, x)) return [];
  return recordList().filter(r => r.cid === x);
}
function recordGet(id) {
  const x = Number(id);
  const r = oc('records').find(y => y.id === x);
  return (r && perms.canSeeRecord(actor(), r)) ? r : null;
}
function recordLatest(sid) {
  const list = recordOfStudent(sid);
  return list[0] || null;
}
function canSend(pick) {
  const p = pick || {};
  const hasContent = (p.photos && p.photos.length) || (p.videos && p.videos.length) || p.audio ||
    (p.note && String(p.note).trim());
  return !!(p.sid && hasContent);
}
// 新建或更新一条记录。pick 兼容三处入口的字段名：cls / clsId / course / courseId
function recordSave(pick, send) {
  const p = pick || {};
  const stu = studentRaw(p.sid);
  if (!stu) return { ok: false, msg: '请先选择学生' };
  if (send && !canSend(p)) return { ok: false, msg: '内容还没补齐' };

  const cid = Number(p.cls || p.clsId) || stu.clsIds[0] || 0;
  const rid = Number(p.rid) || 0;

  // 权限：编辑看「只能改自己录的」，新建看「班级在范围内」
  if (rid) {
    const r0 = oc('records').find(y => y.id === rid);
    if (!r0) return { ok: false, msg: '记录不存在' };
    const err = deny('record.update', { record: r0 });
    if (err) return { ok: false, msg: err };
  } else {
    const a = actor();
    if (!perms.can(a, 'record.create', { clsId: cid })) {
      return { ok: false, msg: perms.denyReason(a, 'record.create') };
    }
    if (!perms.canSeeStudent(a, stu)) return { ok: false, msg: '该学生不在你的管理范围内' };
  }

  const course = schema.str(p.course).trim();
  const courseId = Number(p.courseId) ||
    ((oc('courses').find(c => c.clsId === cid && c.name === course) || {}).id || 0);

  const base = {
    // type 不传则沿用原有类型（编辑时不要把它冲掉），新建时默认 achievement
    type: p.type,
    sid: stu.id, cid, courseId, course,
    score: schema.num(p.score, 85),
    tag: schema.str(p.tag).trim(),
    note: schema.str(p.note),
    photos: p.photos, videos: p.videos, audio: p.audio,
    sent: !!send
  };

  if (rid) {
    const r = oc('records').find(y => y.id === rid);
    // 没显式传日期时保留原日期：编辑一条上周的记录不能把它改到今天
    const date = schema.normDate(p.date) || r.date;
    const next = schema.normalizeRecord(Object.assign({}, r, base, { date }), org(), now());
    const ev = schema.validate('record', next);
    if (ev) return { ok: false, msg: ev };
    next.id = r.id; next.tid = r.tid || core.meta().me || ''; next.updatedAt = now();
    Object.assign(r, next);
    core.persist('records');
    return { ok: true, rid: r.id, record: r };
  }

  const e = schema.normalizeRecord(Object.assign({}, base, {
    tid: core.meta().me || '',
    date: schema.normDate(p.date) || schema.ymd()
  }), org(), now());
  const ev = schema.validate('record', e);
  if (ev) return { ok: false, msg: ev };
  e.id = core.nextId();
  e.createdAt = now(); e.updatedAt = now();
  core.coll('records').push(e);
  core.persist('records');
  return { ok: true, rid: e.id, record: e };
}
// 批量标记已发送（单条发送 / 整班统一发送都走这里），返回实际变更条数
function recordMarkSent(ids) {
  const a = actor();
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number);
  let n = 0; const t = now();
  let denied = 0;
  oc('records').forEach(r => {
    if (r.sent || list.indexOf(r.id) < 0) return;
    if (!perms.can(a, 'record.send', { record: r })) { denied++; return; }
    r.sent = true; r.updatedAt = t; n++;
  });
  if (n) core.persist('records');
  return { count: n, denied };
}
function recordRemove(id) {
  const r = oc('records').find(y => y.id === Number(id));
  if (!r) return { ok: false, msg: '记录不存在' };
  const err = deny('record.delete', { record: r });
  if (err) return { ok: false, msg: err };
  r.removed = true; r.updatedAt = now();
  core.persist('records');
  return { ok: true };
}

/* =====================================================================
 * 人员（跨机构的账号本身；权限看 member）
 * ===================================================================*/
function userList() { return oc('users').slice(); }
function userGet(id) { return oc('users').find(u => u.id === String(id)) || null; }
function userName(id) { const u = userGet(id); return u ? u.name : ''; }

// 当前登录人的"合成身份"：user 的姓名 + member 的角色与范围
// 页面沿用 u.role / u.clsIds / u.studentIds，不必知道底层已拆成两张表
function userCurrent() {
  const m = memberCurrent();
  const u = m ? userGet(m.userId) : null;
  const base = u || userList()[0] || null;
  if (!base) return null;
  return {
    id: base.id, name: base.name,
    role: (m && m.role) || base.role || 'parent',
    clsIds: m ? m.clsIds.slice() : [],
    courseIds: m ? m.courseIds.slice() : [],
    studentIds: m ? m.studentIds.slice() : [],
    memberId: m ? m.id : 0,
    orgId: org(),
    status: m ? m.status : 'invited'
  };
}

// 切换身份：只切"人"，角色与范围由该人在本机构的成员关系决定
function userSwitch(id) {
  const u = userGet(id);
  if (!u) return { ok: false, msg: '人员不存在' };
  const m = memberOfUser(u.id);
  const meta = core.meta();
  const patch = { me: String(id), role: (m && m.role) || u.role };
  // 记住"我本来是谁"。没有这条，预览家长端后会因为看不到成员列表而切不回来
  if (!meta.homeMe) patch.homeMe = meta.me || String(id);
  core.updateMeta(patch);
  return { ok: true, item: userCurrent() };
}
// 回到本人的真实身份
function userSwitchHome() {
  const h = core.meta().homeMe;
  if (!h) return { ok: false, msg: '没有可返回的身份' };
  return userSwitch(h);
}

// 兼容旧调用：等价于"建人 + 建成员关系"
function userCreate(data) {
  return memberCreate(data);
}
function userUpdate(id, patch) {
  const m = memberOfUser(id);
  if (!m) {
    const u = userGet(id);
    if (!u) return { ok: false, msg: '人员不存在' };
    return { ok: false, msg: '该人员不属于当前机构' };
  }
  return memberUpdate(m.id, patch);
}
function userRemove(id) {
  const m = memberOfUser(id);
  if (!m) return { ok: false, msg: '该人员不属于当前机构' };
  return memberRemove(m.id);
}

/* =====================================================================
 * 评价模板
 * ===================================================================*/
function tplList() {
  return oc('templates').slice().sort((a, b) => (a.sort - b.sort) || (a.id - b.id));
}
function tplGet(id) {
  const x = Number(id);
  return oc('templates').find(t => t.id === x) || null;
}
function tplCreate(data) {
  const err = deny('template.write');
  if (err) return { ok: false, msg: err };
  const list = tplList();
  const e = schema.normalizeTemplate({
    name: data && data.name, options: data && data.options, sort: list.length
  }, org(), now());
  const ev = schema.validate('template', e);
  if (ev) return { ok: false, msg: ev };
  e.id = core.nextId();
  core.coll('templates').push(e);
  core.persist('templates');
  return { ok: true, item: e };
}
function tplUpdate(id, patch) {
  const err = deny('template.write');
  if (err) return { ok: false, msg: err };
  const t = tplGet(id);
  if (!t) return { ok: false, msg: '模板不存在' };
  const next = schema.normalizeTemplate(Object.assign({}, t, patch), org(), now());
  const ev = schema.validate('template', next);
  if (ev) return { ok: false, msg: ev };
  next.id = t.id; next.updatedAt = now();
  Object.assign(t, next);
  core.persist('templates');
  return { ok: true, item: t };
}
function tplRemove(id) {
  const err = deny('template.write');
  if (err) return { ok: false, msg: err };
  const t = tplGet(id);
  if (!t) return { ok: false, msg: '模板不存在' };
  t.removed = true; t.updatedAt = now();
  core.persist('templates');
  return { ok: true };
}
function tplAddOption(id, text) {
  const err = deny('template.write');
  if (err) return { ok: false, msg: err };
  const t = tplGet(id);
  const v = schema.str(text).trim();
  if (!t) return { ok: false, msg: '模板不存在' };
  if (!v) return { ok: false, msg: '内容不能为空' };
  if (t.options.indexOf(v) > -1) return { ok: false, msg: '已有相同选项' };
  t.options.push(v); t.updatedAt = now();
  core.persist('templates');
  return { ok: true, item: t, index: t.options.length - 1 };
}
function tplUpdateOption(id, index, text) {
  const err = deny('template.write');
  if (err) return { ok: false, msg: err };
  const t = tplGet(id);
  const v = schema.str(text).trim();
  if (!t) return { ok: false, msg: '模板不存在' };
  if (!v) return { ok: false, msg: '内容不能为空' };
  if (index < 0 || index >= t.options.length) return { ok: false, msg: '选项不存在' };
  t.options[index] = v; t.updatedAt = now();
  core.persist('templates');
  return { ok: true, item: t };
}
function tplRemoveOption(id, index) {
  const err = deny('template.write');
  if (err) return { ok: false, msg: err };
  const t = tplGet(id);
  if (!t) return { ok: false, msg: '模板不存在' };
  if (index < 0 || index >= t.options.length) return { ok: false, msg: '选项不存在' };
  t.options.splice(index, 1); t.updatedAt = now();
  core.persist('templates');
  return { ok: true };
}
// 整表覆盖（兼容旧接口 saveTpls 用）
function tplReplaceAll(list) {
  const err = deny('template.write');
  if (err) return { ok: false, msg: err };
  const cur = tplList();
  const next = (Array.isArray(list) ? list : []).map((t, i) => {
    const e = schema.normalizeTemplate({
      id: (cur[i] && cur[i].id) || 0, name: t.n || t.name, options: t.opts || t.options, sort: i
    }, org(), now());
    if (!e.id) e.id = core.nextId();
    return e;
  });
  core.setColl('templates', next);
  return { ok: true };
}

/* =====================================================================
 * 查询辅助 / 云端合并 / 设置
 * ===================================================================*/
const today = () => schema.ymd();

function settings() {
  const m = core.meta();
  const o = orgCurrent();
  const a = actor();
  return {
    orgId: m.orgId,
    orgName: (o && o.name) || m.orgName || '我的机构',
    teacher: m.teacher || '',
    me: m.me || '',
    homeMe: m.homeMe || m.me || '',
    canSwitchHome: !!(m.homeMe && m.homeMe !== m.me),
    role: (a && a.role) || '',
    roleLabel: (a && a.roleLabel) || '',
    memberId: (a && a.memberId) || 0,
    demoVersion: m.demoVersion || 0,
    version: m.version
  };
}
// 机构名与"我的名字"都落在机构/成员上，不再塞进 meta.teacher 这一个裸字段
function setTeacher(name) {
  const v = schema.str(name).trim();
  const a = actor();
  if (a && a.memberId) {
    const m = memberGet(a.memberId);
    if (m) {
      m.name = v; m.updatedAt = now();
      const u = userGet(m.userId);
      if (u) { u.name = v; u.updatedAt = now(); core.persist('users'); }
      core.persist('members');
    }
  }
  core.updateMeta({ teacher: v });
  return settings();
}
function me() { return core.meta().me; }
function isParent() { const a = actor(); return !!a && a.role === 'parent'; }

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

/* =====================================================================
 * 对外
 * ===================================================================*/
const db = {
  init,
  status,
  raw: core.data,
  coll: core.coll,
  flush: core.flushAll,
  settings, setTeacher, today, canSend, merge, me, isParent,
  demoClear,
  org, nextId: core.nextId,
  TAGS: schema.TAGS,
  TYPES: schema.RECORD_TYPES,

  auth: {
    actor,
    member: memberCurrent,
    can: (action, target) => perms.can(actor(), action, target),
    abilities: () => perms.abilities(actor()),
    canSeeClass: cid => perms.canSeeClass(actor(), cid),
    canSeeStudent: s => perms.canSeeStudent(actor(), s),
    canSeeRecord: r => perms.canSeeRecord(actor(), r),
    denyReason: action => perms.denyReason(actor(), action),
    role: () => { const a = actor(); return a ? a.role : ''; },
    roleLabel: () => { const a = actor(); return a ? a.roleLabel : ''; },
    isOwner: () => { const a = actor(); return !!a && a.role === 'owner'; },
    isAdmin: () => { const a = actor(); return !!a && perms.FULL.indexOf(a.role) > -1; },
    isTeacher: () => { const a = actor(); return !!a && a.role === 'teacher'; },
    isParent: () => { const a = actor(); return !!a && a.role === 'parent'; },
    ROLES: perms.ROLES,
    ROLE_LABEL: perms.ROLE_LABEL,
    ACTIONS: perms.ACTIONS
  },

  orgs: {
    current: orgCurrent, update: orgUpdate,
    get: id => oc('orgs').find(o => o.id === String(id)) || null,
    list: () => oc('orgs')
  },

  members: {
    list: memberList,
    view: memberView,
    get: memberGet,
    ofUser: memberOfUser,
    current: memberCurrent,
    create: memberCreate, update: memberUpdate, remove: memberRemove
  },

  classes: {
    list: classList, get: classGet, name: className,
    create: classCreate, update: classUpdate, remove: classRemove,
    // 不过滤权限，但仍限当前机构（内部/调试用，页面不要用）
    _all: () => oc('classes')
  },
  courses: {
    list: courseList, of: courseOf, get: courseGet,
    create: courseCreate, update: courseUpdate, remove: courseRemove
  },
  students: {
    list: studentList, of: studentOf, get: studentGet, search: studentSearch,
    name: studentName,
    create: studentCreate, update: studentUpdate, updateProfile: studentUpdateProfile, remove: studentRemove
  },
  records: {
    list: recordList, ofStudent: recordOfStudent, ofClass: recordOfClass, get: recordGet,
    latest: recordLatest, save: recordSave, markSent: recordMarkSent, remove: recordRemove
  },
  users: {
    list: userList, get: userGet, name: userName, current: userCurrent,
    switchTo: userSwitch, switchHome: userSwitchHome, create: userCreate, update: userUpdate, remove: userRemove
  },
  templates: {
    list: tplList, get: tplGet, create: tplCreate, update: tplUpdate, remove: tplRemove,
    addOption: tplAddOption, updateOption: tplUpdateOption, removeOption: tplRemoveOption,
    replaceAll: tplReplaceAll
  }
};

module.exports = db;
