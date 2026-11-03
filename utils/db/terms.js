// utils/db/terms.js —— 学期（开班时间段）与结转向导
// 依赖：ctx（底座）。不依赖任何其他领域模块。
const { now, org, oc, deny, pushSaved, applyEdit } = require('./ctx');
const core = require('./core');
const schema = require('./schema');

// 排序：进行中 → 未开始 → 已归档；同组内按开始日期倒序（新的在前）
function termList() {
  const rank = { active: 0, upcoming: 1, archived: 2 };
  return oc('terms').slice().sort((a, b) =>
    (rank[a.status] - rank[b.status]) ||
    String(b.startDate || '').localeCompare(String(a.startDate || '')) ||
    (b.id - a.id));
}
function termRaw(id) {
  const x = Number(id);
  return oc('terms').find(t => t.id === x) || null;
}
function termGet(id) { return termRaw(id); }
// 当前进行中的学期（可能多个：培训机构的暑假班和秋季班常常并行）
function termActiveList() { return oc('terms').filter(t => t.status === 'active'); }
function termCreate(data) {
  const err = deny('term.manage');
  if (err) return { ok: false, msg: err };
  const d = data || {};
  const e = schema.normalizeTerm({
    name: d.name, startDate: d.startDate, endDate: d.endDate,
    status: d.status
  }, org(), now());
  const ev = schema.validate('term', e);
  if (ev) return { ok: false, msg: ev };
  // 默认规则：机构还没有进行中的学期 → 新学期直接进行中；否则先建为未开始
  if (!d.status) e.status = termActiveList().length ? 'upcoming' : 'active';
  e.id = core.nextId();
  if (!pushSaved('terms', e)) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true, item: e };
}
function termUpdate(id, patch) {
  const err = deny('term.manage');
  if (err) return { ok: false, msg: err };
  const t = termRaw(id);
  if (!t) return { ok: false, msg: '学期不存在' };
  const p = patch || {};
  if (t.builtIn && (p.status === 'archived' || p.name !== undefined && p.name !== t.name)) {
    return { ok: false, msg: '内置长期班不能归档或改名' };
  }
  const next = schema.normalizeTerm(Object.assign({}, t, p), org(), now());
  const ev = schema.validate('term', next);
  if (ev) return { ok: false, msg: ev };
  next.id = t.id; next.builtIn = t.builtIn; next.updatedAt = now();
  if (!applyEdit('terms', t, next)) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true, item: t };
}
// 归档：只能通过结转向导的完成动作触发（这里提供原子操作）；归档后该学期全部只读
function termArchive(id) {
  const err = deny('term.manage');
  if (err) return { ok: false, msg: err };
  const t = termRaw(id);
  if (!t) return { ok: false, msg: '学期不存在' };
  if (t.builtIn) return { ok: false, msg: '内置长期班不能归档' };
  if (!applyEdit('terms', t, { status: 'archived', updatedAt: now() })) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true, item: t };
}
// 结转向导的数据准备：该学期每个班级的课程、学生、报名与剩余课时
function planSettle(termId) {
  const err = deny('term.manage');
  if (err) return { ok: false, msg: err };
  const t = termRaw(termId);
  if (!t) return { ok: false, msg: '学期不存在' };
  if (t.builtIn) return { ok: false, msg: '内置长期班不参与结转' };
  if (t.status === 'archived') return { ok: false, msg: '该学期已归档' };
  const classes = oc('classes')
    .filter(c => c.termId === t.id && !c.removed)
    .sort((a, b) => (a.sort - b.sort) || (a.id - b.id));
  const out = classes.map(c => ({
    cls: c,
    courses: oc('courses').filter(x => x.clsId === c.id && !x.removed),
    students: oc('students')
      .filter(s => !s.removed && s.clsIds.indexOf(c.id) > -1)
      .map(s => {
        const en = oc('enrollments').find(e =>
          e.clsId === c.id && e.studentId === s.id && e.status === 'active');
        return {
          student: s,
          enrollment: en,
          remain: en ? Math.max(0, (en.totalHours || 0) - (en.usedHours || 0)) : 0
        };
      })
  }));
  return { ok: true, term: t, classes: out };
}

module.exports = {
  termList, termRaw, termGet, termActiveList,
  termCreate, termUpdate, termArchive, planSettle
};
