// utils/db/students.js —— 学生
// 依赖：ctx（底座）、pinyin（列表排序）。学生位于实体依赖链的中层，
// 不 require 任何其他领域模块；删除学生时连带处理记录/成员/报名，一律直接读集合。
const { now, org, oc, actor, deny, pushSaved, applyEdit } = require('./ctx');
const core = require('./core');
const schema = require('./schema');
const perms = require('./permissions');
const pinyin = require('../pinyin');

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
  if (!pushSaved('students', e)) return { ok: false, msg: core.SAVE_FAIL };
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
  if (!applyEdit('students', s, next)) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true, item: s };
}
function studentUpdateProfile(id, profile) {
  const s = studentRaw(id);
  if (!s) return { ok: false, msg: '学生不存在' };
  // 家长可填自己孩子的资料；老师需在范围内
  const err = deny('profile.write', { student: s });
  if (err) return { ok: false, msg: err };
  const prof = Object.assign({}, profile, { submittedAt: schema.ymd() });
  if (!applyEdit('students', s, { profile: prof, updatedAt: now() })) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true, item: s };
}
// 删除学生：学生软删，其课堂记录一并软删（避免记录列表出现"无主记录"）
function studentRemove(id) {
  const s = studentRaw(id);
  if (!s) return { ok: false, msg: '学生不存在' };
  const err = deny('student.write', { student: s });
  if (err) return { ok: false, msg: err };
  // 删学生要同时改动 4 个集合，用事务：中途失败不会留下"学生删了、记录还在"的残局
  return core.tx(() => {
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
    // 报名（课时账）一并软删
    oc('enrollments').forEach(en => {
      if (en.studentId === s.id) { en.removed = true; en.updatedAt = t; }
    });
    core.persist('students'); core.persist('records');
    core.persist('members'); core.persist('enrollments');
    return { ok: true, records: n };
  });
}

module.exports = {
  studentList, studentOf, studentRaw, studentGet, studentName, studentSearch,
  studentCreate, studentUpdate, studentUpdateProfile, studentRemove
};
