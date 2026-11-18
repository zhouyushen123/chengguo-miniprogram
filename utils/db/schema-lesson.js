// utils/db/schema-lesson.js —— 课次（lessons）的规范化与校验
//
// 【为什么单独一个文件】schema.js 有 500 行硬上限（tests/verify_arch.js D 节）。
// 课次是第 24 张集合，字段最多，塞回 schema.js 会让主模型文件再次膨胀——
// 与 subject-seeds.js 同一先例：纯常量/纯函数单独成文件，方向 base ← 本文件 ← schema。
const { str, num, normDate, audit } = require('./schema-base');

// 课次确认状态：draft 待确认 / confirmed 已确认（软标记，非强制，不影响任何读写）
const LESSON_STATUS = ['draft', 'confirmed'];

// 课次：一门课程在一个教学周期（学期）里的每一次课。是内容大纲的载体，不是"某班的课"。
// seq 是存储序号而非按日期实时算的派生值——成绩单/家长沟通里的"第 N 次课"必须长期稳定；
// 补录导致序号与日期错乱时由 lessons.js 的「一键重排」让老师确认后归位。
// weekday 一律由 date 推导（手填会和日期矛盾）；时间段结构化存起止，
// 为"学生计划/排课匹配"预留机器可读的口径。
function normalizeLesson(raw, orgId, stamp) {
  const r = raw || {};
  const date = normDate(r.date);
  return Object.assign({
    id: num(r.id, 0),
    courseId: num(r.courseId, 0),
    termId: num(r.termId, 0),
    seq: Math.max(1, num(r.seq, 1)),
    date,
    weekday: date ? weekdayOf(date) : 0,
    startTime: hhmm(r.startTime),
    endTime: hhmm(r.endTime),
    title: str(r.title).trim(),
    content: str(r.content),
    status: LESSON_STATUS.indexOf(r.status) > -1 ? r.status : 'draft',
    confirmedBy: num(r.confirmedBy, 0),
    confirmedAt: num(r.confirmedAt, 0),
    // 内容编辑时间：与 updatedAt 分开——updatedAt 任何变更甚至同步写回都会动，拿它判
    // "内容有更新"会误报。仅内容类字段（date/时间段/title/content）变化时更新。
    contentEditedAt: num(r.contentEditedAt, 0)
  }, audit(r, orgId, stamp));
}

function validateLesson(e) {
  if (!e.courseId) return '课次必须关联课程';
  if (e.seq < 1) return '课次序号不合法';
  if (e.title && e.title.length > 30) return '课题过长（最多 30 字）';
  if (e.content && e.content.length > 2000) return '课次内容过长（最多 2000 字）';
  if (e.startTime && e.endTime && e.endTime <= e.startTime) return '结束时间必须晚于开始时间';
  return null;
}

// 由日期推星期（1~7，周一=1）。不用 new Date('YYYY-MM-DD')：它按 UTC 解析，
// 东八区 getDay() 会偏一天。手工拆年月日、按本地时区构造才是对的。
function weekdayOf(date) {
  const p = String(date || '').split('-');
  if (p.length !== 3) return 0;
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  const w = d.getDay();
  return w === 0 ? 7 : w;
}

// HH:mm 白名单清洗：时间要参与将来的排课匹配，脏值宁可清空也不留
function hhmm(v) {
  const s = str(v).trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : '';
}

module.exports = { LESSON_STATUS, normalizeLesson, validateLesson, weekdayOf };
