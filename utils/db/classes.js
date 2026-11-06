// utils/db/classes.js —— 班级
// 依赖：ctx（底座）、terms（新建班级默认挂当前进行中的学期）。不反向依赖 enrollments/records。
const { now, org, oc, ocAll, actor, deny, pushSaved, applyEdit, markRemoved, markAlive } = require('./ctx');
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

// 只回答"这个班是不是结转制"，不把班级实体交出去。
// 页面算剩余课时需要这个判定，但不需要班名/老师名——给实体等于顺带泄露了不该看的班。
function classMode(id) { const c = classRaw(id); return c ? c.mode : ''; }

// 某个学期下有几个班（学期页的统计数字）。
// 用的是"当前身份可见"的班级，不是全量：老师看到的应该是自己带的班有几个。
function classCountOfTerm(termId) {
  const a = actor();
  const t = Number(termId);
  return oc('classes').filter(c => !c.removed && c.termId === t && perms.canSeeClass(a, c.id)).length;
}

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
  if (!pushSaved('classes', e)) return { ok: false, msg: core.SAVE_FAIL };
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
  if (!applyEdit('classes', c, next)) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true, item: c };
}
// 删除班级：班级软删，该班的课程绑定跟着软删（课程本身保留），学生从该班移除
// （学生与历史记录保留）。
// 【V10 起不再连课一起删】课程已经是独立的可复用内容（可能还开在别的班），
// 删班只解除"这门课在这个班开过"这个关系。以前连课删掉，别的班就被迫再建一条同名课。
function classRemove(id) {
  const err = deny('class.write', { clsId: id });
  if (err) return { ok: false, msg: err };
  const c = classRaw(id);
  if (!c) return { ok: false, msg: '班级不存在' };
  return core.tx(() => {
    const t = now();
    markRemoved(c, t);
    oc('class_courses').forEach(x => {
      if (x.clsId === c.id && !x.removed) markRemoved(x, t);
    });
    // 名单与授权是被「摘掉」而不是被删除的，还原时得知道当初摘掉的是谁，
    // 所以把班级从哪些人身上摘下来记在这条班级文档上（随它一起同步、一起恢复）。
    const stu = [], mem = [];
    oc('students').forEach(s => {
      const i = s.clsIds.indexOf(c.id);
      if (i > -1) { s.clsIds.splice(i, 1); s.updatedAt = t; stu.push(s.id); }
    });
    // 成员负责范围里也要摘掉这个班，否则会留下指向已删班级的悬空授权
    oc('members').forEach(m => {
      const i = m.clsIds.indexOf(c.id);
      if (i > -1) { m.clsIds.splice(i, 1); m.updatedAt = t; mem.push(m.id); }
    });
    c.detached = { students: stu, members: mem };
    // 该班的报名（课时账）一并软删：班没了账跟着走，学生与记录保留
    oc('enrollments').forEach(en => {
      if (en.clsId === c.id && !en.removed) markRemoved(en, t);
    });
    core.persist('classes'); core.persist('class_courses'); core.persist('students');
    core.persist('members'); core.persist('enrollments');
    return { ok: true };
  });
}

// 从回收站还原班级：班级 + 该班的课程绑定 + 报名一起回来，
// 并把当初从学生/成员身上摘掉的关联按记录补回去（不然是个"空班"）。
function classRestore(id) {
  const c = ocAll('classes').find(x => x.id === Number(id) && x.removed);
  if (!c) return { ok: false, msg: '回收站里没有这个班级' };
  const err = deny('class.write', { clsId: c.id });
  if (err) return { ok: false, msg: err };
  return core.tx(() => {
    const t = now();
    const at = c.removedAt;
    const link = c.detached || { students: [], members: [] };
    markAlive(c, t);
    c.detached = { students: [], members: [] };
    let crs = 0, enr = 0, stu = 0, mem = 0;
    // 绑定按同批次认回来；课程本身如果也被单独删过，则跳过（课程还原时有自己的判断）
    ocAll('class_courses').forEach(x => {
      if (x.clsId !== c.id || !x.removed || x.removedAt !== at) return;
      if (!oc('courses').some(k => k.id === x.courseId)) return;
      markAlive(x, t); crs++;
    });
    ocAll('enrollments').forEach(en => {
      if (en.clsId === c.id && en.removed && en.removedAt === at) { markAlive(en, t); enr++; }
    });
    oc('students').forEach(s => {
      if (link.students.indexOf(s.id) > -1 && s.clsIds.indexOf(c.id) < 0) {
        s.clsIds.push(c.id); s.updatedAt = t; stu++;
      }
    });
    oc('members').forEach(m => {
      if (link.members.indexOf(m.id) > -1 && m.clsIds.indexOf(c.id) < 0) {
        m.clsIds.push(c.id); m.updatedAt = t; mem++;
      }
    });
    core.persist('classes'); core.persist('class_courses'); core.persist('enrollments');
    if (stu) core.persist('students');
    if (mem) core.persist('members');
    return { ok: true, courses: crs, enrollments: enr, students: stu, members: mem };
  });
}

module.exports = {
  classList, classRaw, classGet, className, classMode, classCountOfTerm,
  classCreate, classUpdate, classRemove, classRestore
};
