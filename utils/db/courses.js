// utils/db/courses.js —— 课程（挂在班级下）
// 依赖：ctx（底座）。课程不反向依赖班级模块：可见性判断统一走 perms.canSeeClass。
const { now, org, oc, actor, deny } = require('./ctx');
const core = require('./core');
const schema = require('./schema');
const perms = require('./permissions');

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

module.exports = { courseList, courseOf, courseGet, courseCreate, courseUpdate, courseRemove };
