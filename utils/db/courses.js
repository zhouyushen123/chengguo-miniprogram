// utils/db/courses.js —— 课程（挂在班级下）
// 依赖：ctx（底座）。课程不反向依赖班级模块：可见性判断统一走 perms.canSeeClass。
const { now, org, oc, ocAll, actor, deny, pushSaved, applyEdit, markRemoved, markAlive } = require('./ctx');
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
  const d = data || {};
  const name = schema.str(d.name).trim();
  const e = schema.normalizeCourse({
    name, clsId: d.clsId,
    // 学科：显式传了就用，没传就按课程名猜一次（猜不中留 0，不阻塞建课）
    subjectId: d.subjectId !== undefined && d.subjectId !== ''
      ? d.subjectId
      : schema.guessSubjectId(name, oc('subjects'))
  }, org(), now());
  const ev = schema.validate('course', e);
  if (ev) return { ok: false, msg: ev };
  e.id = core.nextId();
  if (!pushSaved('courses', e)) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true, item: e };
}
function courseUpdate(id, patch) {
  const c = courseGet(id);
  if (!c) return { ok: false, msg: '课程不存在或无权操作' };
  const err = deny('course.write', { clsId: c.clsId });
  if (err) return { ok: false, msg: err };
  const p = Object.assign({}, patch);
  const next = schema.normalizeCourse(Object.assign({}, c, p), org(), now());
  // 改名后没显式指定学科、原来也没归类 → 再猜一次；已有学科不因改名被冲掉
  if ((p.subjectId === undefined || p.subjectId === '') && !c.subjectId) {
    next.subjectId = schema.guessSubjectId(next.name, oc('subjects'));
  }
  const ev = schema.validate('course', next);
  if (ev) return { ok: false, msg: ev };
  next.id = c.id; next.updatedAt = now();
  if (!applyEdit('courses', c, next)) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true, item: c };
}
function courseRemove(id) {
  const c = courseGet(id);
  if (!c) return { ok: false, msg: '课程不存在或无权操作' };
  const err = deny('course.write', { clsId: c.clsId });
  if (err) return { ok: false, msg: err };
  if (!applyEdit('courses', c, markRemoved({}, now()))) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true };
}

// 从回收站还原。课程没有连带（历史记录上的课程名是独立文字，不受影响），markAlive 即可
function courseRestore(id) {
  const c = ocAll('courses').find(x => x.id === Number(id) && x.removed);
  if (!c) return { ok: false, msg: '回收站里没有这门课' };
  const err = deny('course.write', { clsId: c.clsId });
  if (err) return { ok: false, msg: err };
  // 班级也被删了（删班带删课）：先把课挂回一个不存在的班会成孤儿，这种连批还原才合理
  const cls = oc('classes').find(x => x.id === c.clsId);
  if (!cls) return { ok: false, msg: '它所属的班级也在回收站里，先还原班级再还原课程' };
  if (!applyEdit('courses', c, markAlive({}, now()))) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true };
}

module.exports = { courseList, courseOf, courseGet, courseCreate, courseUpdate, courseRemove, courseRestore };
