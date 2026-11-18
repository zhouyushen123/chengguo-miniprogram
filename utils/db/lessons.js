// utils/db/lessons.js —— 课次：一门课程在一个教学周期（学期）里的每一次课
//
// 课次是内容大纲的载体（课题/日期/知识点/作业），不是"某班的课"——
// 同一门课开到几个班共用同一份课次（纯课程维度，方案见 docs/lesson-plan.md）。
// 依赖：ctx（底座）+ core + schema。不依赖任何其他领域模块（守单向规则）；
// 学期信息直接读 terms 集合原始数据，与 terms.js planSettle 的写法同款。
//
// 【序号机制】seq 是存储序号：成绩单/家长沟通里的"第 N 次课"必须长期稳定，
// 不能按日期实时算（补录一堂旧课，别人档案里的"第 5 次"会突然变"第 6 次"）。
// 补录/改日期导致序号与日期错乱时，lessonDisorder 返回 true，页面提示"按日期重排"，
// 老师确认后 lessonReorder 归位。records 只存 lessonId 不存序号，重排不会错位任何关联。
const { now, org, oc, deny, pushSaved, applyEdit, markRemoved, memberCurrent } = require('./ctx');
const core = require('./core');
const schema = require('./schema');

// 内容类字段：只有这些变化才更新 contentEditedAt（"已确认·内容有更新"的判定依据）
const CONTENT_KEYS = ['date', 'startTime', 'endTime', 'title', 'content'];

/* ---------------- 读 ---------------- */

function lessonRaw(id) {
  const x = Number(id);
  return oc('lessons').find(l => l.id === x) || null;
}
function lessonGet(id) { return lessonRaw(id); }

// 某门课的全部课次，按"学期分组"输出：[ { term, lessons } ]
// 学期排序：进行中在前、未开始次之、已归档最后；同组内新的在前（同 termList 口径）。
// 每组内 lessons 按 seq 升序。term 为 null 的（理论上是异常数据）排最后。
function lessonGroupsOfCourse(courseId) {
  const lessons = oc('lessons').filter(l => l.courseId === Number(courseId));
  const rank = { active: 0, upcoming: 1, archived: 2 };
  const terms = oc('terms')
    .filter(t => lessons.some(l => l.termId === t.id))
    .sort((a, b) =>
      (rank[a.status] - rank[b.status]) ||
      String(b.startDate || '').localeCompare(String(a.startDate || '')) ||
      (b.id - a.id));
  const groups = terms.map(t => ({
    term: t,
    lessons: lessons.filter(l => l.termId === t.id).sort((a, b) => (a.seq - b.seq) || (a.id - b.id))
  }));
  const orphans = lessons.filter(l => !terms.some(t => t.id === l.termId));
  if (orphans.length) {
    groups.push({ term: null, lessons: orphans.sort((a, b) => (a.seq - b.seq) || (a.id - b.id)) });
  }
  return groups;
}

// 有多少条记录关联到这个课次（删除/作废前的提示用）
function linkedCount(id) {
  return oc('records').filter(r => r.lessonId === Number(id) && !r.removed).length;
}

/* ---------------- 学期辅助（直读 terms 原始数据，不 require terms.js） ---------------- */

function termRawOf(id) {
  const x = Number(id);
  return oc('terms').find(t => t.id === x) || null;
}
function termArchived(termId) {
  const t = termRawOf(termId);
  return !!(t && t.status === 'archived');
}

// 新建课次默认挂哪个学期：唯一进行中 → 它；多个进行中 → 开始日期最新的
//（页面在有多个时可以显式弹选，传了 termId 就不走到这里）；一个都没有 → 0（数据兜底层再补）
function defaultTermId() {
  const list = oc('terms').filter(t => t.status === 'active');
  if (!list.length) return 0;
  const real = list.filter(t => !t.builtIn);
  if (real.length === 1) return real[0].id;
  if (list.length === 1) return list[0].id;
  const pick = (real.length ? real : list).slice()
    .sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || '')) || (b.id - a.id));
  return pick[0].id;
}

// 同一课程同学期内的下一个序号：取未删除课次最大值 +1（删除留空洞不重排，介意就点一键重排）
function nextSeq(courseId, termId) {
  let max = 0;
  oc('lessons').forEach(l => {
    if (l.removed || l.courseId !== Number(courseId) || l.termId !== Number(termId)) return;
    if (l.seq > max) max = l.seq;
  });
  return max + 1;
}

/* ---------------- 写 ---------------- */

// 单次添加。seq 默认接在末尾；补录旧日期的课后返回 disorder=true，页面据此提示重排
function lessonCreate(courseId, data) {
  const d = data || {};
  const err = deny('lesson.write', { courseId });
  if (err) return { ok: false, msg: err };
  const course = oc('courses').find(c => c.id === Number(courseId) && !c.removed);
  if (!course) return { ok: false, msg: '课程不存在' };
  const termId = Number(d.termId) || defaultTermId();
  if (!termId) return { ok: false, msg: '没有进行中的学期，请先建学期' };
  if (termArchived(termId)) return { ok: false, msg: '该学期已归档，课次只读' };
  const e = schema.normalizeLesson({
    courseId: course.id, termId,
    seq: (d.seq !== undefined && d.seq !== null && d.seq !== '') ? Number(d.seq) : nextSeq(course.id, termId),
    date: d.date, startTime: d.startTime, endTime: d.endTime,
    title: d.title, content: d.content
  }, org(), now());
  const ev = schema.validate('lesson', e);
  if (ev) return { ok: false, msg: ev };
  e.id = core.nextId();
  e.createdAt = now(); e.updatedAt = now();
  if (!pushSaved('lessons', e)) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true, item: e, disorder: lessonDisorder(course.id, termId) };
}

// 批量生成：起始日期 + 每周上课日 + 次数（+ 可选时间段），一次生成一串课次。
// 一个事务里全部落库：生成到一半空间不足时整体回滚，不留"生成了 3 条、要 5 条"的半成品。
function lessonBatch(courseId, opt) {
  const o = opt || {};
  const err = deny('lesson.write', { courseId });
  if (err) return { ok: false, msg: err };
  const course = oc('courses').find(c => c.id === Number(courseId) && !c.removed);
  if (!course) return { ok: false, msg: '课程不存在' };
  const termId = Number(o.termId) || defaultTermId();
  if (!termId) return { ok: false, msg: '没有进行中的学期，请先建学期' };
  if (termArchived(termId)) return { ok: false, msg: '该学期已归档，课次只读' };
  const count = Math.min(60, Math.max(1, Number(o.count) || 0));
  if (!(Number(o.count) > 0)) return { ok: false, msg: '请输入要生成的课次数（1-60）' };
  const days = (Array.isArray(o.weekdays) ? o.weekdays : []).map(Number).filter(d => d >= 1 && d <= 7);
  if (!days.length) return { ok: false, msg: '请选择每周上课日' };
  const dates = expandDates(o.startDate, days, count);
  if (!dates) return { ok: false, msg: '起始日期格式应为 YYYY-MM-DD' };
  return core.tx(() => {
    let seq = nextSeq(course.id, termId);
    const made = [];
    for (let i = 0; i < dates.length; i++) {
      const e = schema.normalizeLesson({
        courseId: course.id, termId, seq: seq++,
        date: dates[i], startTime: o.startTime, endTime: o.endTime
      }, org(), now());
      const ev = schema.validate('lesson', e);
      if (ev) return { ok: false, msg: ev };
      e.id = core.nextId();
      e.createdAt = now(); e.updatedAt = now();
      if (!pushSaved('lessons', e)) return { ok: false, msg: core.SAVE_FAIL };
      made.push(e);
    }
    return { ok: true, items: made };
  });
}

// 从起始日期当天起，按"每周这些天"往后展开 count 个日期（升序）。起始日当天命中也算。
function expandDates(startDate, weekdays, count) {
  const start = schema.normDate(startDate);
  if (!start) return null;
  const set = {};
  weekdays.forEach(d => { set[d] = 1; });
  const p = start.split('-').map(Number);
  const dt = new Date(p[0], p[1] - 1, p[2]);
  const out = [];
  // 一年足够铺满 60 次课（52 周）；铺不满说明入参有矛盾（如只选周一却 52 周内凑不出）——直接判失败
  for (let i = 0; i < 370 && out.length < count; i++) {
    const w = dt.getDay() === 0 ? 7 : dt.getDay();
    if (set[w]) out.push(schema.ymd(dt));
    dt.setDate(dt.getDate() + 1);
  }
  return out.length === count ? out : null;
}

// 编辑（含事后补录）。方式 C：确认状态不动，仅内容类字段变化时打"有更新"标记。
function lessonUpdate(id, patch) {
  const l = lessonRaw(id);
  if (!l || l.removed) return { ok: false, msg: '课次不存在' };
  const err = deny('lesson.write', { courseId: l.courseId });
  if (err) return { ok: false, msg: err };
  if (termArchived(l.termId)) return { ok: false, msg: '该学期已归档，课次只读' };
  const p = patch || {};
  const next = schema.normalizeLesson(Object.assign({}, l, p), org(), now());
  const ev = schema.validate('lesson', next);
  if (ev) return { ok: false, msg: ev };
  next.id = l.id; next.createdAt = l.createdAt;
  next.confirmedBy = l.confirmedBy; next.confirmedAt = l.confirmedAt;
  if (CONTENT_KEYS.some(k => String(next[k] || '') !== String(l[k] || ''))) next.contentEditedAt = now();
  next.updatedAt = now();
  if (!applyEdit('lessons', l, next)) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true, item: l, disorder: lessonDisorder(l.courseId, l.termId) };
}

// 删除（软删）。有关联记录时调用方先以 linkedCount 提示"作废"，这里行为相同，只是话术不同：
// 记录保留，展示时查不到课次就回退显示"未关联"。
function lessonRemove(id) {
  const l = lessonRaw(id);
  if (!l || l.removed) return { ok: false, msg: '课次不存在' };
  const err = deny('lesson.write', { courseId: l.courseId });
  if (err) return { ok: false, msg: err };
  if (termArchived(l.termId)) return { ok: false, msg: '该学期已归档，课次只读' };
  const linked = linkedCount(l.id);
  markRemoved(l, now());
  if (!core.persist('lessons')) {
    l.removed = false; l.removedAt = 0; l.removedBy = 0;
    return { ok: false, msg: core.SAVE_FAIL };
  }
  return { ok: true, linked };
}

// 老师确认（软标记，非强制）。contentEditedAt 不清零：确认只是刷新"我看过"的时间，
// "内容有更新"的判定 = contentEditedAt > confirmedAt，再点一次确认自然消失。
function lessonConfirm(id) {
  const l = lessonRaw(id);
  if (!l || l.removed) return { ok: false, msg: '课次不存在' };
  const err = deny('lesson.confirm', { courseId: l.courseId });
  if (err) return { ok: false, msg: err };
  if (termArchived(l.termId)) return { ok: false, msg: '该学期已归档，课次只读' };
  const m = memberCurrent();
  if (!applyEdit('lessons', l, {
    status: 'confirmed', confirmedBy: (m && m.id) || 0, confirmedAt: now(), updatedAt: now()
  })) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true, item: l };
}

/* ---------------- 序号机制 C'：错乱检测 + 一键重排 ---------------- */

// 错乱检测：该课程该学期内"有日期"的课次，按（日期, 开始时间）排出来后 seq 必须严格递增。
// 无日期的大纲课次不参与（它们的次序就是创建顺序）。
function lessonDisorder(courseId, termId) {
  const dated = oc('lessons')
    .filter(l => !l.removed && l.courseId === Number(courseId) && l.termId === Number(termId) && l.date)
    .sort((a, b) =>
      a.date.localeCompare(b.date) ||
      String(a.startTime || '99:99').localeCompare(String(b.startTime || '99:99')));
  for (let i = 1; i < dated.length; i++) {
    if (dated[i].seq <= dated[i - 1].seq) return true;
  }
  return false;
}

// 一键重排："有日期"的按（日期, 开始时间）重编 1..K；"无日期"的随后按创建时间续编。
// 删除/作废的不参与（seq 空洞由此补齐）。事务保证要么全排好、要么一个都没动。
function lessonReorder(courseId, termId) {
  const err = deny('lesson.write', { courseId });
  if (err) return { ok: false, msg: err };
  if (termArchived(termId)) return { ok: false, msg: '该学期已归档，课次只读' };
  const list = oc('lessons')
    .filter(l => !l.removed && l.courseId === Number(courseId) && l.termId === Number(termId));
  const dated = list.filter(l => l.date)
    .sort((a, b) =>
      a.date.localeCompare(b.date) ||
      String(a.startTime || '99:99').localeCompare(String(b.startTime || '99:99')));
  const undated = list.filter(l => !l.date)
    .sort((a, b) => (a.createdAt - b.createdAt) || (a.id - b.id));
  const order = dated.concat(undated);
  return core.tx(() => {
    const t = now();
    for (let i = 0; i < order.length; i++) {
      const l = order[i];
      if (l.seq === i + 1) continue;
      l.seq = i + 1; l.updatedAt = t;
      if (!core.persist('lessons')) return { ok: false, msg: core.SAVE_FAIL };
    }
    return { ok: true, count: order.length };
  });
}

// 门面用这份现成的 API 映射（db.lessons = lessons.api）：
// 门面 index.js 有 260 行硬上限，领域自己管自己的出口面，别把映射堆回门面。
const api = {
  get: lessonGet, groups: lessonGroupsOfCourse, linked: linkedCount,
  create: lessonCreate, batch: lessonBatch, update: lessonUpdate,
  remove: lessonRemove, confirm: lessonConfirm,
  disorder: lessonDisorder, reorder: lessonReorder
};

module.exports = Object.assign({
  lessonGet, lessonGroupsOfCourse, linkedCount,
  lessonCreate, lessonBatch, lessonUpdate, lessonRemove, lessonConfirm,
  lessonDisorder, lessonReorder
}, { api });
