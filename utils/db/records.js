// utils/db/records.js —— 课堂记录
// 依赖：ctx（底座）、students（学生引用与范围校验）、enrollments（结转班消课）。
// 依赖方向：students/enrollments → records（单向），本模块位于领域依赖链顶端。
const { now, org, oc, actor, deny, pushSaved, applyEdit } = require('./ctx');
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

  // 班级字段在这套代码里有三个名字：页面用 cls，数据模型用 cid，历史调用有 clsId。
  // 只认其中两个的话，传 cid 会被静默忽略并回落到「学生的第一个班」——
  // 不报错、不提示，记录直接挂到另一个班上去（和 P1-2 是同一类事故的另一个入口）。
  // 三个都认，代价为零；都没传才回落到第一个班（快速录入的老路径要保留）。
  const rawCid = (p.cls !== undefined && p.cls !== null && p.cls !== '') ? p.cls
    : (p.clsId !== undefined && p.clsId !== null && p.clsId !== '') ? p.clsId
      : p.cid;
  const cid = Number(rawCid) || stu.clsIds[0] || 0;
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

  // 课次：新建时默认归入班级当前课次；补录（隔天补上一课）可显式传更早的课次。
  // 只允许 1 ~ 当前课次：传未来课次/0/负数都拒绝，不静默回落——
  // 静默归错课次会让「本次录入」的统计悄悄失真，比直接报错难发现得多。
  let sess = cls.session;
  if (!rid && p.session !== undefined && p.session !== null && p.session !== '') {
    const s = Number(p.session);
    if (!(s >= 1 && s <= cls.session)) return { ok: false, msg: '归入课次不合法' };
    sess = s;
  }

  const base = {
    // type 不传则沿用原有类型（编辑时不要把它冲掉），新建时默认 achievement
    type: p.type,
    sid: stu.id, cid, courseId, course,
    score: schema.num(p.score, 85),
    tag: schema.str(p.tag).trim(),
    note: schema.str(p.note),
    photos: p.photos, videos: p.videos, audio: p.audio,
    sent: !!send,
    // 新建盖课次；编辑不带 session（base 多余字段会被 Object.assign 里的 r 覆盖回原值）
    session: sess
  };

  if (rid) {
    const r = oc('records').find(y => y.id === rid);
    // 没显式传日期时保留原日期：编辑一条上周的记录不能把它改到今天
    const date = schema.normDate(p.date) || r.date;
    // 编辑不改课次：base.session 是"新建默认值"，编辑时必须显式压回原记录的课次，
    // 否则老师改一条历史记录的分数，它就从第 1 课跳到当前课次去了
    const next = schema.normalizeRecord(Object.assign({}, r, base, { date, session: r.session }), org(), now());
    const ev = schema.validate('record', next);
    if (ev) return { ok: false, msg: ev };
    next.id = r.id; next.tid = r.tid || core.meta().me || ''; next.updatedAt = now();
    // 落盘失败 → 把内存改回去，不能让界面显示"已保存"而磁盘上没有
    if (!applyEdit('records', r, next)) return { ok: false, msg: core.SAVE_FAIL };
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
  if (!pushSaved('records', e)) return { ok: false, msg: core.SAVE_FAIL };
  // 结转制班级：每录一节 = 消 1 课时（编辑不重复消课）
  const hr = enrollments.consumeHours(e);
  if (hr && hr.ok === false) return { ok: true, rid: e.id, record: e, warn: hr.msg };
  return { ok: true, rid: e.id, record: e };
}
// 结清本次课：把该班当前课次所有「已录入未发布」的记录发布给家长，然后课次 +1。
// 这是「本次录入」的唯一收口动作——不要求全员录完（请假/缺席的学生直接略过，本次没有记录）。
// 权限用 record.create：能往这个班录课的人才能结清它；发布部分仍逐条过 record.send，
// 没有发布权的人结清时只推进课次，不发布（denied 数原样返回给页面提示）。
function sessionSettle(clsId) {
  const cid = Number(clsId);
  const cls = oc('classes').find(c => c.id === cid && !c.removed);
  if (!cls) return { ok: false, msg: '班级不存在' };
  const err = deny('record.create', { clsId: cid });
  if (err) return { ok: false, msg: err };
  const cur = Math.max(1, Number(cls.session) || 1);
  const ids = oc('records')
    .filter(r => r.cid === cid && !r.removed && r.session === cur && !r.sent)
    .map(r => r.id);
  return core.tx(() => {
    const out = recordMarkSent(ids);
    if (out.ok === false) return out;          // 落盘失败，事务里 records 已回滚
    const prev = cls.session;
    cls.session = cur + 1; cls.updatedAt = now();
    if (!core.persist('classes')) {
      cls.session = prev;
      return { ok: false, msg: core.SAVE_FAIL };
    }
    return { ok: true, session: cls.session, sent: out.count, denied: out.denied };
  });
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
  if (!applyEdit('records', r, { removed: true, updatedAt: now() })) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true };
}

module.exports = {
  recordList, recordOfStudent, recordOfClass, recordGet, recordLatest,
  canSend, recordSave, recordMarkSent, recordRemove, sessionSettle
};
