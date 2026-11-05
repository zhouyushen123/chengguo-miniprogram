// utils/db/enrollments.js —— 报名（课时账本：孩子 × 班级 × 学期）
// 依赖：ctx（底座）、classes（班级形态决定是否消课）、students（报名对象校验）。
// 依赖方向：classes/students → enrollments（单向），班级删除只直接读集合，不会回头 require 本模块。
//
// 【读也过滤】课时数字直接推给家长端（"还剩 N 节课"），所以列表与单条查询都要按身份过滤：
// 家长只见自己孩子、老师只见自己带的班。内部校验（重复报名、消课找账）走不过滤的 raw 版本，
// 否则"看不到 → 以为不存在 → 又建一条"会造出重复账。
const { now, org, oc, actor, deny, pushSaved, applyEdit, markRemoved, markAlive } = require('./ctx');
const core = require('./core');
const schema = require('./schema');
const perms = require('./permissions');
const classes = require('./classes');
const students = require('./students');

function enrollmentList() {
  const a = actor();
  return oc('enrollments').filter(e => perms.canSeeEnrollment(a, e));
}
function enrollmentGet(id) {
  const x = Number(id);
  const e = oc('enrollments').find(y => y.id === x);
  return (e && perms.canSeeEnrollment(actor(), e)) ? e : null;
}
// 内部用：不过滤身份（写路径的重复校验、消课找账），仍需自行保证调用方已过权限闸门
function enrollmentRaw(id) {
  const x = Number(id);
  return oc('enrollments').find(y => y.id === x) || null;
}
function enrollmentRawOf(clsId, sid) {
  const c = Number(clsId), s = Number(sid);
  return oc('enrollments').find(e => e.clsId === c && e.studentId === s && e.status === 'active') || null;
}
function enrollmentsOfStudent(sid) {
  const x = Number(sid);
  const a = actor();
  return oc('enrollments').filter(e => e.studentId === x && perms.canSeeEnrollment(a, e));
}
function enrollmentsOfClass(clsId) {
  const x = Number(clsId);
  const a = actor();
  if (!perms.canSeeClass(a, x)) return [];
  return oc('enrollments').filter(e => e.clsId === x && perms.canSeeEnrollment(a, e));
}
// 孩子在某个班的在读报名（唯一）；家长端「剩余 N 课时」的取数点
function enrollmentOf(clsId, sid) {
  const a = actor();
  if (!perms.canSeeClass(a, Number(clsId))) return null;
  const e = enrollmentRawOf(clsId, sid);
  return (e && perms.canSeeEnrollment(a, e)) ? e : null;
}
function enrollmentCreate(data) {
  const err = deny('term.manage');
  if (err) return { ok: false, msg: err };
  const d = data || {};
  const cls = classes.classRaw(d.clsId);
  if (!cls) return { ok: false, msg: '班级不存在' };
  if (!students.studentRaw(d.studentId)) return { ok: false, msg: '学生不存在' };
  if (enrollmentRawOf(cls.id, d.studentId)) return { ok: false, msg: '该学生已在本班在读，请直接调整课时' };
  const e = schema.normalizeEnrollment({
    studentId: d.studentId, clsId: cls.id,
    termId: d.termId || cls.termId,
    totalHours: d.totalHours, usedHours: d.usedHours,
    status: d.status, carriedFrom: d.carriedFrom
  }, org(), now());
  const ev = schema.validate('enrollment', e);
  if (ev) return { ok: false, msg: ev };
  e.id = core.nextId();
  if (!pushSaved('enrollments', e)) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true, item: e };
}
function enrollmentUpdate(id, patch) {
  const err = deny('term.manage');
  if (err) return { ok: false, msg: err };
  const e = enrollmentRaw(id);
  if (!e) return { ok: false, msg: '报名不存在' };
  const next = schema.normalizeEnrollment(Object.assign({}, e, patch), org(), now());
  const ev = schema.validate('enrollment', next);
  if (ev) return { ok: false, msg: ev };
  next.id = e.id; next.updatedAt = now();
  if (!applyEdit('enrollments', e, next)) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true, item: e };
}
function enrollmentRemove(id) {
  const err = deny('term.manage');
  if (err) return { ok: false, msg: err };
  const e = enrollmentRaw(id);
  if (!e) return { ok: false, msg: '报名不存在' };
  if (!applyEdit('enrollments', e, markRemoved({}, now()))) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true };
}
// 消课：结转制班级每录一条成果记录 = 消 1 课时。
// 没有报名关系时自动补一条（未购课 total=0，管理员随后补录购买课时），保证课时账不失忆。
// 返回 { ok }，落盘失败时把刚加的课时撤回去——账上多扣一节课比少扣更难查。
function consumeHours(rec) {
  const cls = classes.classRaw(rec.cid);
  if (!cls || cls.mode !== 'carry') return { ok: true, skipped: true };
  let en = enrollmentRawOf(cls.id, rec.sid);
  let created = null;
  if (!en) {
    en = schema.normalizeEnrollment({
      studentId: rec.sid, clsId: cls.id, termId: cls.termId,
      totalHours: 0, usedHours: 0, status: 'active'
    }, org(), now());
    en.id = core.nextId();
    core.coll('enrollments').push(en);
    created = en;
  }
  const prev = en.usedHours;
  en.usedHours = (en.usedHours || 0) + 1;
  en.updatedAt = now();
  if (!core.persist('enrollments')) {
    en.usedHours = prev;
    if (created) {
      const arr = core.coll('enrollments');
      const i = arr.indexOf(created);
      if (i > -1) arr.splice(i, 1);
    }
    return { ok: false, msg: core.SAVE_FAIL };
  }
  return { ok: true };
}

module.exports = {
  enrollmentList, enrollmentGet, enrollmentRaw, enrollmentsOfStudent, enrollmentsOfClass, enrollmentOf,
  enrollmentCreate, enrollmentUpdate, enrollmentRemove, consumeHours
};
