// utils/db/records.js —— 课堂记录
// 依赖：ctx（底座）、students（学生引用与范围校验）、enrollments（结转班消课）。
// 依赖方向：students/enrollments → records（单向），本模块位于领域依赖链顶端。
const { now, org, oc, actor, deny } = require('./ctx');
const core = require('./core');
const schema = require('./schema');
const perms = require('./permissions');
const students = require('./students');
const enrollments = require('./enrollments');

function recordList() {
  const a = actor();
  return oc('records')
    .filter(r => perms.canSeeRecord(a, r))
    .slice().sort((x, y) => y.id - x.id);
}
function recordOfStudent(sid) {
  const x = Number(sid);
  const a = actor();
  return recordList().filter(r => r.sid === x && perms.canSeeRecord(a, r));
}
function recordOfClass(cid) {
  const x = Number(cid);
  const a = actor();
  if (!perms.canSeeClass(a, x)) return [];
  return recordList().filter(r => r.cid === x);
}
function recordGet(id) {
  const x = Number(id);
  const r = oc('records').find(y => y.id === x);
  return (r && perms.canSeeRecord(actor(), r)) ? r : null;
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
  const stu = students.studentRaw(p.sid);
  if (!stu) return { ok: false, msg: '请先选择学生' };
  if (send && !canSend(p)) return { ok: false, msg: '内容还没补齐' };

  const cid = Number(p.cls || p.clsId) || stu.clsIds[0] || 0;
  const rid = Number(p.rid) || 0;
  if (!cid) return { ok: false, msg: '请先选择班级' };

  // 【记录 ↔ 班级 ↔ 学生 三者必须自洽】
  // 不校验 cid 归属会有两个真问题：① 记录的 cid 指向学生并不在的班，班级统计、
  // 家长可见性（按 cid 判定）都会错；② 结转制班级录课时会按 (cid, sid) 找不到报名
  // 而自动补一条 totalHours:0 的账 —— 账上凭空多一个"欠 1 节课"的孩子。
  const cls = oc('classes').find(c => c.id === cid);
  if (!cls) return { ok: false, msg: '班级不存在' };
  const a = actor();

  if (rid) {
    const r0 = oc('records').find(y => y.id === rid);
    if (!r0) return { ok: false, msg: '记录不存在' };
    const err = deny('record.update', { record: r0 });
    if (err) return { ok: false, msg: err };
    // 【只校验老对象是不够的】闸门看的是 r0 的归属，通过之后把 sid/cid 换成别人的，
    // 就能把记录搬到看不见的学生/班级上。新的目标同样要过一遍范围校验。
    if (!perms.canSeeStudent(a, stu)) return { ok: false, msg: '该学生不在你的管理范围内' };
    if (!perms.canSeeClass(a, cid)) return { ok: false, msg: '该班级不在你的管理范围内' };
    // 改了班级才要求"学生在这个班里"；班级没变时放行，否则学生转班后连历史记录都改不了
    if (cid !== r0.cid && stu.clsIds.indexOf(cid) < 0) {
      return { ok: false, msg: '这个班级里没有该学生' };
    }
  } else {
    const err = deny('record.create', { clsId: cid });
    if (err) return { ok: false, msg: err };
    if (!perms.canSeeStudent(a, stu)) return { ok: false, msg: '该学生不在你的管理范围内' };
    if (stu.clsIds.indexOf(cid) < 0) return { ok: false, msg: '这个班级里没有该学生' };
  }

  const course = schema.str(p.course).trim();
  const courseId = Number(p.courseId) ||
    ((oc('courses').find(c => c.clsId === cid && c.name === course) || {}).id || 0);

  const base = {
    // type 不传则沿用原有类型（编辑时不要把它冲掉），新建时默认 achievement
    type: p.type,
    sid: stu.id, cid, courseId, course,
    score: schema.num(p.score, 85),
    tag: schema.str(p.tag).trim(),
    note: schema.str(p.note),
    photos: p.photos, videos: p.videos, audio: p.audio,
    sent: !!send
  };

  if (rid) {
    const r = oc('records').find(y => y.id === rid);
    // 没显式传日期时保留原日期：编辑一条上周的记录不能把它改到今天
    const date = schema.normDate(p.date) || r.date;
    const next = schema.normalizeRecord(Object.assign({}, r, base, { date }), org(), now());
    const ev = schema.validate('record', next);
    if (ev) return { ok: false, msg: ev };
    next.id = r.id; next.tid = r.tid || core.meta().me || ''; next.updatedAt = now();
    const backup = Object.assign({}, r);
    Object.assign(r, next);
    // 落盘失败 → 把内存改回去，不能让界面显示"已保存"而磁盘上没有
    if (!core.persist('records')) { Object.assign(r, backup); return { ok: false, msg: core.SAVE_FAIL }; }
    return { ok: true, rid: r.id, record: r };
  }

  const e = schema.normalizeRecord(Object.assign({}, base, {
    tid: core.meta().me || '',
    date: schema.normDate(p.date) || schema.ymd()
  }), org(), now());
  const ev = schema.validate('record', e);
  if (ev) return { ok: false, msg: ev };
  e.id = core.nextId();
  e.createdAt = now(); e.updatedAt = now();
  const arr = core.coll('records');
  arr.push(e);
  if (!core.persist('records')) {
    const i = arr.indexOf(e);
    if (i > -1) arr.splice(i, 1);
    return { ok: false, msg: core.SAVE_FAIL };
  }
  // 结转制班级：每录一节 = 消 1 课时（编辑不重复消课）
  const hr = enrollments.consumeHours(e);
  if (hr && hr.ok === false) return { ok: true, rid: e.id, record: e, warn: hr.msg };
  return { ok: true, rid: e.id, record: e };
}
// 批量标记已发送（单条发送 / 整班统一发送都走这里），返回实际变更条数
function recordMarkSent(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number);
  const touched = [];
  let denied = 0; const t = now();
  oc('records').forEach(r => {
    if (r.sent || list.indexOf(r.id) < 0) return;
    if (deny('record.send', { record: r })) { denied++; return; }
    touched.push({ r, prev: r.updatedAt });
    r.sent = true; r.updatedAt = t;
  });
  if (!touched.length) return { count: 0, denied };
  if (!core.persist('records')) {
    touched.forEach(x => { x.r.sent = false; x.r.updatedAt = x.prev; });
    return { count: 0, denied, ok: false, msg: core.SAVE_FAIL };
  }
  return { count: touched.length, denied };
}
function recordRemove(id) {
  const r = oc('records').find(y => y.id === Number(id));
  if (!r) return { ok: false, msg: '记录不存在' };
  const err = deny('record.delete', { record: r });
  if (err) return { ok: false, msg: err };
  const prev = { removed: r.removed, updatedAt: r.updatedAt };
  r.removed = true; r.updatedAt = now();
  if (!core.persist('records')) {
    r.removed = prev.removed; r.updatedAt = prev.updatedAt;
    return { ok: false, msg: core.SAVE_FAIL };
  }
  return { ok: true };
}

module.exports = {
  recordList, recordOfStudent, recordOfClass, recordGet, recordLatest,
  canSend, recordSave, recordMarkSent, recordRemove
};
