// utils/db/classes.js —— 班级
// 依赖：ctx（底座）、terms（新建班级默认挂当前进行中的学期）。不反向依赖 enrollments/records。
const { now, org, oc, actor, deny } = require('./ctx');
const core = require('./core');
const schema = require('./schema');
const perms = require('./permissions');
const terms = require('./terms');

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
  const d = data || {};
  const e = schema.normalizeClass({
    name: d.name, sort: d.sort,
    // 不传学期 → 挂到当前进行中的学期（没有则 0，normalizeAll 兜底挂内置长期班）
    termId: d.termId || ((terms.termActiveList()[0] || {}).id || 0),
    mode: d.mode,
    teacherId: d.teacherId
  }, org(), now());
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
  // 该班的报名（课时账）一并软删：班没了账跟着走，学生与记录保留
  oc('enrollments').forEach(en => {
    if (en.clsId === c.id) { en.removed = true; en.updatedAt = t; }
  });
  core.persist('classes'); core.persist('courses'); core.persist('students'); core.persist('members'); core.persist('enrollments');
  return { ok: true };
}

module.exports = { classList, classRaw, classGet, className, classCreate, classUpdate, classRemove };
