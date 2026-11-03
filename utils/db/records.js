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

  // 权限：编辑看「只能改自己录的」，新建看「班级在范围内」
  // 两条都必须过 ctx.deny 这道闸门（不要直接 perms.can：演示模式只读、降级只读
  // 这些"全局规则"都挂在闸门上，绕过它就等于给自己开了后门）
  if (rid) {
    const r0 = oc('records').find(y => y.id === rid);
    if (!r0) return { ok: false, msg: '记录不存在' };
    const err = deny('record.update', { record: r0 });
    if (err) return { ok: false, msg: err };
  } else {
    const err = deny('record.create', { clsId: cid });
    if (err) return { ok: false, msg: err };
    const a = actor();
    if (!perms.canSeeStudent(a, stu)) return { ok: false, msg: '该学生不在你的管理范围内' };
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
    Object.assign(r, next);
    core.persist('records');
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
  core.coll('records').push(e);
  core.persist('records');
  // 结转制班级：每录一节 = 消 1 课时（编辑不重复消课）
  enrollments.consumeHours(e);
  return { ok: true, rid: e.id, record: e };
}
// 批量标记已发送（单条发送 / 整班统一发送都走这里），返回实际变更条数
function recordMarkSent(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number);
  let n = 0; const t = now();
  let denied = 0;
  oc('records').forEach(r => {
    if (r.sent || list.indexOf(r.id) < 0) return;
    if (deny('record.send', { record: r })) { denied++; return; }
    r.sent = true; r.updatedAt = t; n++;
  });
  if (n) core.persist('records');
  return { count: n, denied };
}
function recordRemove(id) {
  const r = oc('records').find(y => y.id === Number(id));
  if (!r) return { ok: false, msg: '记录不存在' };
  const err = deny('record.delete', { record: r });
  if (err) return { ok: false, msg: err };
  r.removed = true; r.updatedAt = now();
  core.persist('records');
  return { ok: true };
}

module.exports = {
  recordList, recordOfStudent, recordOfClass, recordGet, recordLatest,
  canSend, recordSave, recordMarkSent, recordRemove
};
