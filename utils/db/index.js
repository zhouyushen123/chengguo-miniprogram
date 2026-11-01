// utils/db/index.js —— 主数据访问层（唯一出口）
//
// 用法：const db = require('../../utils/db');
//   db.classes.list()            db.students.of(clsId)        db.records.save(pick, true)
//   db.classes.create({name})    db.templates.addOption(id,t) db.users.current()
//
// 【约定】
// 1. 页面只通过本文件读写数据：不碰 wx.setStorageSync，也不直接改返回对象里的字段
//    （改字段请调用 update / markSent 等方法，否则不会落盘、也不会更新 updatedAt）
// 2. 所有写操作都过 schema 规范化 + 校验，非法数据写不进去
// 3. 所有实体都带 orgId / createdAt / updatedAt / removed，软删除保留痕迹便于多端同步
// 4. 换云端只替换 utils/db/storage.js 的实现，这里和页面都不用改
const storage = require('./storage');
const schema = require('./schema');
const core = require('./core');
const migrate = require('./migrate');
const pinyin = require('../pinyin');
const demo = require('../demo-data');

const now = () => Date.now();
const org = () => (core.meta().orgId || schema.DEFAULT_ORG);

/* =====================================================================
 * 启动：加载 → 迁移 → 规范化 → 演示数据 → 引用修复
 * ===================================================================*/
let inited = false;

function init() {
  if (inited) return;
  const loaded = storage.load();
  const data = (loaded.meta && loaded.meta.version === schema.VERSION)
    ? loaded
    : migrate.build(loaded);
  core.hydrate(data);

  const changed = normalizeAll();
  const seeded = seedDemo();
  const repaired = repairRefs();
  if (changed || seeded || repaired || !loaded.meta || loaded.meta.version !== schema.VERSION) {
    core.flushAll();
  }
  inited = true;
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
  each('classes', schema.normalizeClass);
  each('courses', schema.normalizeCourse);
  each('students', schema.normalizeStudent);
  each('records', schema.normalizeRecord);
  each('users', schema.normalizeUser);
  each('templates', schema.normalizeTemplate);
  const m = core.meta();
  if (!m.version) { core.updateMeta({ version: schema.VERSION, orgId: m.orgId || schema.DEFAULT_ORG, createdAt: now(), updatedAt: now() }); changed = true; }
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
    if (!r.tid && me) { r.tid = me; changed++; }
  });
  return changed > 0;
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

  // 家长演示账号绑第一个孩子
  const p = core.coll('users').find(u => u.role === 'parent' && !u.removed);
  if (p) { p.studentIds = [demo.DEMO_STUDENTS[0].id]; core.persist('users'); }

  core.updateMeta({ demoVersion: demo.DEMO_VERSION });
  return true;
}

/* =====================================================================
 * 班级
 * ===================================================================*/
function classList() {
  return core.coll('classes').filter(c => !c.removed)
    .slice().sort((a, b) => (a.sort - b.sort) || (a.id - b.id));
}
function classGet(id) {
  const x = Number(id);
  return core.coll('classes').find(c => c.id === x && !c.removed) || null;
}
function className(id) { const c = classGet(id); return c ? c.name : ''; }
function classCreate(data) {
  const e = schema.normalizeClass({ name: data && data.name, sort: data && data.sort }, org(), now());
  const err = schema.validate('class', e);
  if (err) return { ok: false, msg: err };
  e.id = core.nextId();
  core.coll('classes').push(e);
  core.persist('classes');
  return { ok: true, item: e };
}
function classUpdate(id, patch) {
  const c = classGet(id);
  if (!c) return { ok: false, msg: '班级不存在' };
  const next = schema.normalizeClass(Object.assign({}, c, patch), org(), now());
  const err = schema.validate('class', next);
  if (err) return { ok: false, msg: err };
  next.id = c.id; next.updatedAt = now();
  Object.assign(c, next);
  core.persist('classes');
  return { ok: true, item: c };
}
// 删除班级：班级软删，其课程一并软删，学生从该班移除（学生与历史记录保留）
function classRemove(id) {
  const c = classGet(id);
  if (!c) return { ok: false, msg: '班级不存在' };
  const t = now();
  c.removed = true; c.updatedAt = t;
  core.coll('courses').forEach(x => {
    if (x.clsId === c.id && !x.removed) { x.removed = true; x.updatedAt = t; }
  });
  core.coll('students').forEach(s => {
    const i = s.clsIds.indexOf(c.id);
    if (i > -1) { s.clsIds.splice(i, 1); s.updatedAt = t; }
    if (s.clsIds.length === 0) { /* 允许"未分班"状态存在，不自动删学生 */ }
  });
  core.persist('classes'); core.persist('courses'); core.persist('students');
  return { ok: true };
}

/* =====================================================================
 * 课程
 * ===================================================================*/
function courseList() {
  return core.coll('courses').filter(c => !c.removed).slice()
    .sort((a, b) => (a.clsId - b.clsId) || (a.id - b.id));
}
function courseOf(clsId) {
  const x = Number(clsId);
  return courseList().filter(c => c.clsId === x);
}
function courseGet(id) {
  const x = Number(id);
  return core.coll('courses').find(c => c.id === x && !c.removed) || null;
}
function courseCreate(data) {
  const e = schema.normalizeCourse({ name: data && data.name, clsId: data && data.clsId }, org(), now());
  const err = schema.validate('course', e);
  if (err) return { ok: false, msg: err };
  e.id = core.nextId();
  core.coll('courses').push(e);
  core.persist('courses');
  return { ok: true, item: e };
}
function courseUpdate(id, patch) {
  const c = courseGet(id);
  if (!c) return { ok: false, msg: '课程不存在' };
  const next = schema.normalizeCourse(Object.assign({}, c, patch), org(), now());
  const err = schema.validate('course', next);
  if (err) return { ok: false, msg: err };
  next.id = c.id; next.updatedAt = now();
  Object.assign(c, next);
  core.persist('courses');
  return { ok: true, item: c };
}
function courseRemove(id) {
  const c = courseGet(id);
  if (!c) return { ok: false, msg: '课程不存在' };
  c.removed = true; c.updatedAt = now();
  core.persist('courses');
  return { ok: true };
}

/* =====================================================================
 * 学生
 * ===================================================================*/
function studentList() {
  return pinyin.sortStudents(core.coll('students').filter(s => !s.removed));
}
function studentOf(clsId) {
  const x = Number(clsId);
  return pinyin.sortStudents(core.coll('students').filter(s => !s.removed && s.clsIds.indexOf(x) > -1));
}
function studentGet(id) {
  const x = Number(id);
  return core.coll('students').find(s => s.id === x && !s.removed) || null;
}
function studentSearch(q) {
  const k = String(q || '').trim();
  if (!k) return [];
  return studentList().filter(s => s.name.indexOf(k) > -1);
}
function studentCreate(data) {
  const d = data || {};
  const e = schema.normalizeStudent({
    name: d.name, clsIds: d.clsIds, parent: d.parent, wechat: d.wechat, photo: d.photo, profile: d.profile
  }, org(), now());
  const err = schema.validate('student', e);
  if (err) return { ok: false, msg: err };
  e.id = core.nextId();
  core.coll('students').push(e);
  core.persist('students');
  return { ok: true, item: e };
}
function studentUpdate(id, patch) {
  const s = studentGet(id);
  if (!s) return { ok: false, msg: '学生不存在' };
  const next = schema.normalizeStudent(Object.assign({}, s, patch), org(), now());
  const err = schema.validate('student', next);
  if (err) return { ok: false, msg: err };
  next.id = s.id; next.updatedAt = now();
  Object.assign(s, next);
  core.persist('students');
  return { ok: true, item: s };
}
function studentUpdateProfile(id, profile) {
  const s = studentGet(id);
  if (!s) return { ok: false, msg: '学生不存在' };
  s.profile = Object.assign({}, profile, { submittedAt: schema.ymd() });
  s.updatedAt = now();
  core.persist('students');
  return { ok: true, item: s };
}
// 删除学生：学生软删，其课堂记录一并软删（避免记录列表出现"无主记录"）
function studentRemove(id) {
  const s = studentGet(id);
  if (!s) return { ok: false, msg: '学生不存在' };
  const t = now();
  s.removed = true; s.updatedAt = t;
  let n = 0;
  core.coll('records').forEach(r => {
    if (r.sid === s.id && !r.removed) { r.removed = true; r.updatedAt = t; n++; }
  });
  core.persist('students'); core.persist('records');
  return { ok: true, records: n };
}

/* =====================================================================
 * 课堂记录
 * ===================================================================*/
function recordList() {
  return core.coll('records').filter(r => !r.removed).slice().sort((a, b) => b.id - a.id);
}
function recordOfStudent(sid) {
  const x = Number(sid);
  return recordList().filter(r => r.sid === x);
}
function recordOfClass(cid) {
  const x = Number(cid);
  return recordList().filter(r => r.cid === x);
}
function recordGet(id) {
  const x = Number(id);
  return core.coll('records').find(r => r.id === x && !r.removed) || null;
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
  const stu = studentGet(p.sid);
  if (!stu) return { ok: false, msg: '请先选择学生' };
  if (send && !canSend(p)) return { ok: false, msg: '内容还没补齐' };

  const cid = Number(p.cls || p.clsId) || stu.clsIds[0] || 0;
  const course = schema.str(p.course).trim();
  const courseId = Number(p.courseId) ||
    ((core.coll('courses').find(c => c.clsId === cid && c.name === course && !c.removed) || {}).id || 0);

  const base = {
    sid: stu.id, cid, courseId, course,
    score: schema.num(p.score, 85),
    tag: schema.str(p.tag).trim(),
    note: schema.str(p.note),
    photos: p.photos, videos: p.videos, audio: p.audio,
    sent: !!send
  };

  const rid = Number(p.rid) || 0;
  if (rid) {
    const r = recordGet(rid);
    if (!r) return { ok: false, msg: '记录不存在' };
    // 没显式传日期时保留原日期：编辑一条上周的记录不能把它改到今天
    const date = schema.normDate(p.date) || r.date;
    const next = schema.normalizeRecord(Object.assign({}, r, base, { date }), org(), now());
    const err = schema.validate('record', next);
    if (err) return { ok: false, msg: err };
    next.id = r.id; next.tid = r.tid || core.meta().me || ''; next.updatedAt = now();
    Object.assign(r, next);
    core.persist('records');
    return { ok: true, rid: r.id, record: r };
  }

  const e = schema.normalizeRecord(Object.assign({}, base, {
    tid: core.meta().me || '',
    date: schema.normDate(p.date) || schema.ymd()
  }), org(), now());
  const err = schema.validate('record', e);
  if (err) return { ok: false, msg: err };
  e.id = core.nextId();
  e.createdAt = now(); e.updatedAt = now();
  core.coll('records').push(e);
  core.persist('records');
  return { ok: true, rid: e.id, record: e };
}
// 批量标记已发送（单条发送 / 整班统一发送都走这里），返回实际变更条数
function recordMarkSent(ids) {
  const set = {};
  (Array.isArray(ids) ? ids : [ids]).forEach(id => { set[Number(id)] = 1; });
  let n = 0; const t = now();
  core.coll('records').forEach(r => {
    if (r.removed || r.sent || !set[r.id]) return;
    r.sent = true; r.updatedAt = t; n++;
  });
  if (n) core.persist('records');
  return n;
}
function recordRemove(id) {
  const r = recordGet(id);
  if (!r) return { ok: false, msg: '记录不存在' };
  r.removed = true; r.updatedAt = now();
  core.persist('records');
  return { ok: true };
}

/* =====================================================================
 * 人员（老师 / 家长 / 管理员）
 * ===================================================================*/
function userList() { return core.coll('users').filter(u => !u.removed).slice(); }
function userGet(id) { return core.coll('users').find(u => u.id === String(id) && !u.removed) || null; }
function userName(id) { const u = userGet(id); return u ? u.name : ''; }
function userCurrent() {
  const m = core.meta().me;
  return userGet(m) || userList()[0] || null;
}
function userSwitch(id) {
  if (!userGet(id)) return { ok: false, msg: '人员不存在' };
  core.updateMeta({ me: String(id), role: userGet(id).role });
  return { ok: true, item: userGet(id) };
}
function userCreate(data) {
  const d = data || {};
  const e = schema.normalizeUser({
    id: d.id || ('u' + now()), name: d.name, role: d.role,
    clsIds: d.clsIds, courseIds: d.courseIds, studentIds: d.studentIds
  }, org(), now());
  const err = schema.validate('user', e);
  if (err) return { ok: false, msg: err };
  if (userGet(e.id)) e.id = 'u' + core.nextId();
  core.coll('users').push(e);
  core.persist('users');
  return { ok: true, item: e };
}
function userUpdate(id, patch) {
  const u = userGet(id);
  if (!u) return { ok: false, msg: '人员不存在' };
  const next = schema.normalizeUser(Object.assign({}, u, patch), org(), now());
  const err = schema.validate('user', next);
  if (err) return { ok: false, msg: err };
  next.id = u.id; next.updatedAt = now();
  Object.assign(u, next);
  core.persist('users');
  return { ok: true, item: u };
}
function userRemove(id) {
  const u = userGet(id);
  if (!u) return { ok: false, msg: '人员不存在' };
  u.removed = true; u.updatedAt = now();
  core.persist('users');
  if (core.meta().me === u.id) {
    const rest = userList();
    if (rest.length) core.updateMeta({ me: rest[0].id, role: rest[0].role });
  }
  return { ok: true };
}

/* =====================================================================
 * 评价模板
 * ===================================================================*/
function tplList() {
  return core.coll('templates').filter(t => !t.removed).slice()
    .sort((a, b) => (a.sort - b.sort) || (a.id - b.id));
}
function tplGet(id) {
  const x = Number(id);
  return core.coll('templates').find(t => t.id === x && !t.removed) || null;
}
function tplCreate(data) {
  const list = tplList();
  const e = schema.normalizeTemplate({
    name: data && data.name, options: data && data.options, sort: list.length
  }, org(), now());
  const err = schema.validate('template', e);
  if (err) return { ok: false, msg: err };
  e.id = core.nextId();
  core.coll('templates').push(e);
  core.persist('templates');
  return { ok: true, item: e };
}
function tplUpdate(id, patch) {
  const t = tplGet(id);
  if (!t) return { ok: false, msg: '模板不存在' };
  const next = schema.normalizeTemplate(Object.assign({}, t, patch), org(), now());
  const err = schema.validate('template', next);
  if (err) return { ok: false, msg: err };
  next.id = t.id; next.updatedAt = now();
  Object.assign(t, next);
  core.persist('templates');
  return { ok: true, item: t };
}
function tplRemove(id) {
  const t = tplGet(id);
  if (!t) return { ok: false, msg: '模板不存在' };
  t.removed = true; t.updatedAt = now();
  core.persist('templates');
  return { ok: true };
}
function tplAddOption(id, text) {
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
  const t = tplGet(id);
  if (!t) return { ok: false, msg: '模板不存在' };
  if (index < 0 || index >= t.options.length) return { ok: false, msg: '选项不存在' };
  t.options.splice(index, 1); t.updatedAt = now();
  core.persist('templates');
  return { ok: true, item: t };
}
// 整表覆盖（兼容旧接口 saveTpls 用）
function tplReplaceAll(list) {
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
  return { orgId: m.orgId, teacher: m.teacher || '', me: m.me || '', demoVersion: m.demoVersion || 0, version: m.version };
}
function setTeacher(name) { core.updateMeta({ teacher: schema.str(name).trim() }); return settings(); }
function me() { return core.meta().me; }
function isParent() { const u = userCurrent(); return !!u && u.role === 'parent'; }

// 云端拉取结果合并（按 updatedAt 取新，只处理记录与学生资料）
function merge(remote) {
  if (!remote) return false;
  let changed = false;
  (remote.records || []).forEach(raw => {
    const inc = schema.normalizeRecord(raw, org(), now());
    if (!inc.id) return;
    const cur = core.coll('records').find(r => r.id === inc.id);
    if (!cur) { core.coll('records').push(inc); changed = true; }
    else if ((inc.updatedAt || 0) > (cur.updatedAt || 0)) { Object.assign(cur, inc); changed = true; }
  });
  (remote.profiles || []).forEach(p => {
    const s = core.coll('students').find(x => x.id === Number(p.sid));
    if (s && p.profile) { s.profile = p.profile; s.updatedAt = now(); changed = true; }
  });
  if (changed) { core.persist('records'); core.persist('students'); }
  return changed;
}

const db = {
  init,
  raw: core.data,
  flush: core.flushAll,
  settings, setTeacher, today, canSend, merge, me, isParent,
  org, nextId: core.nextId,
  TAGS: schema.TAGS,
  classes: {
    list: classList, get: classGet, name: className,
    create: classCreate, update: classUpdate, remove: classRemove,
    // 兼容：按数组方式直接读写（仅供迁移/调试，页面不要用）
    _all: () => core.coll('classes')
  },
  courses: {
    list: courseList, of: courseOf, get: courseGet,
    create: courseCreate, update: courseUpdate, remove: courseRemove
  },
  students: {
    list: studentList, of: studentOf, get: studentGet, search: studentSearch,
    create: studentCreate, update: studentUpdate, updateProfile: studentUpdateProfile, remove: studentRemove
  },
  records: {
    list: recordList, ofStudent: recordOfStudent, ofClass: recordOfClass, get: recordGet,
    latest: recordLatest, save: recordSave, markSent: recordMarkSent, remove: recordRemove
  },
  users: {
    list: userList, get: userGet, name: userName, current: userCurrent,
    switchTo: userSwitch, create: userCreate, update: userUpdate, remove: userRemove
  },
  templates: {
    list: tplList, get: tplGet, create: tplCreate, update: tplUpdate, remove: tplRemove,
    addOption: tplAddOption, updateOption: tplUpdateOption, removeOption: tplRemoveOption,
    replaceAll: tplReplaceAll
  }
};

module.exports = db;
