// utils/db/students.js —— 学生
// 依赖：ctx（底座）、pinyin（列表排序）。学生位于实体依赖链的中层，
// 不 require 任何其他领域模块；删除学生时连带处理记录/成员/报名，一律直接读集合。
const { now, org, oc, ocAll, actor, deny, pushSaved, applyEdit, markRemoved, markAlive } = require('./ctx');
const core = require('./core');
const schema = require('./schema');
const perms = require('./permissions');
const pinyin = require('../pinyin');

function studentList() {
  const a = actor();
  return pinyin.sortStudents(oc('students').filter(s => perms.canSeeStudent(a, s)));
}
function studentOf(clsId) {
  const x = Number(clsId);
  const a = actor();
  if (!perms.canSeeClass(a, x)) return [];
  return pinyin.sortStudents(oc('students')
    .filter(s => s.clsIds.indexOf(x) > -1 && perms.canSeeStudent(a, s)));
}
// 内部用：不过滤权限（名称解析、引用校验），但仍限当前机构
function studentRaw(id) {
  const x = Number(id);
  return oc('students').find(s => s.id === x) || null;
}
function studentGet(id) {
  const s = studentRaw(id);
  if (!s) return null;
  return perms.canSeeStudent(actor(), s) ? s : null;
}
function studentName(id) { const s = studentRaw(id); return s ? s.name : ''; }
function studentSearch(q) {
  const k = String(q || '').trim();
  if (!k) return [];
  return studentList().filter(s => s.name.indexOf(k) > -1);
}
function studentCreate(data) {
  const err = deny('student.write');
  if (err) return { ok: false, msg: err };
  const d = data || {};
  // 老师只能在自班下建学生：传进来的班级必须都在自己范围内
  const a = actor();
  const clsIds = schema.numList(d.clsIds);
  if (a && !a.all && clsIds.some(c => !perms.canSeeClass(a, c))) {
    return { ok: false, msg: '只能在自己负责的班级下新增学生' };
  }
  // F-04/F-05/F-06：表单传进来的字段一个都不能漏——以前漏了 gender / enrollYear，
  // 新建时选的性别和入学年份会被静默丢掉，只有 update 才保得住。
  const e = schema.normalizeStudent({
    name: d.name, no: d.no, clsIds,
    gender: d.gender, enrollYear: d.enrollYear,
    parent: d.parent, parentPhone: d.parentPhone, wechat: d.wechat,
    photo: d.photo, profile: d.profile
  }, org(), now());
  const ev = schema.validate('student', e);
  if (ev) return { ok: false, msg: ev };
  // 学号自动分配：调用方不用传，也不会重复（现有最大值 +1）
  if (!e.no) e.no = studentNextNo();
  e.id = core.nextId();
  if (!pushSaved('students', e)) return { ok: false, msg: core.SAVE_FAIL };
  // 同家长号码的孩子自动归入已有家长账号（linked = 被自动补绑的家长姓名）
  return { ok: true, item: e, linked: studentLinkParents(e) };
}
function studentUpdate(id, patch) {
  const s = studentRaw(id);
  if (!s) return { ok: false, msg: '学生不存在' };
  const err = deny('student.write', { student: s });
  if (err) return { ok: false, msg: err };
  const p = patch || {};
  // 越权改班级 = 把学生挪进自己班或挪出去，必须拦
  const a = actor();
  if (p.clsIds && a && !a.all) {
    const cur = s.clsIds;
    const next = schema.numList(p.clsIds);
    const touched = cur.filter(c => next.indexOf(c) < 0).concat(next.filter(c => cur.indexOf(c) < 0));
    if (touched.some(c => !perms.canSeeClass(a, c))) return { ok: false, msg: '无权调整该学生的班级归属' };
  }
  const next = schema.normalizeStudent(Object.assign({}, s, p), org(), now());
  const ev = schema.validate('student', next);
  if (ev) return { ok: false, msg: ev };
  next.id = s.id; next.updatedAt = now();
  if (!applyEdit('students', s, next)) return { ok: false, msg: core.SAVE_FAIL };
  // 改了家长号码可能让两个孩子变成"同一位家长"，这里补一次归并
  return { ok: true, item: s, linked: studentLinkParents(s) };
}
// 家长资料各字段的长度上限。profile 是家长唯一能自由写的文本，
// 不设上限等于把"单条记录体积可控"这条护栏从侧面拆掉（它和记录存在同一份存储里）。
const PROFILE_MAX = { nick: 20, birth: 12, school: 30, phone: 20, wechat: 30, level: 20, goal: 200, note: 500 };
const PROFILE_OTHER_MAX = 100;      // 未登记的字段也别放过
const PROFILE_TOTAL_MAX = 2048;     // 整包上限：8 个字段都写满也不该到 2KB

// 超长就截断，不报错：家长写不出"保存失败但不知道哪里错"的体验。
// 截断顺序稳定（按字段名），结果可复现，不会因为对象键顺序不同而随机丢字。
function sanitizeProfile(raw) {
  const out = {};
  let budget = PROFILE_TOTAL_MAX;
  Object.keys(raw || {}).sort().forEach(k => {
    const max = PROFILE_MAX[k] || PROFILE_OTHER_MAX;
    let v = schema.str(raw[k]).trim();
    if (!v) return;
    v = v.slice(0, Math.min(max, Math.max(0, budget)));
    if (!v) return;
    budget -= v.length;
    out[k] = v;
  });
  return out;
}

function studentUpdateProfile(id, profile) {
  const s = studentRaw(id);
  if (!s) return { ok: false, msg: '学生不存在' };
  // 家长可填自己孩子的资料；老师需在范围内
  const err = deny('profile.write', { student: s });
  if (err) return { ok: false, msg: err };
  const prof = Object.assign(sanitizeProfile(profile), { submittedAt: schema.ymd() });
  if (!applyEdit('students', s, { profile: prof, updatedAt: now() })) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true, item: s };
}
// 删除学生：学生软删，其课堂记录一并软删（避免记录列表出现"无主记录"）
function studentRemove(id) {
  const s = studentRaw(id);
  if (!s) return { ok: false, msg: '学生不存在' };
  const err = deny('student.write', { student: s });
  if (err) return { ok: false, msg: err };
  // 删学生要同时改动 4 个集合，用事务：中途失败不会留下"学生删了、记录还在"的残局
  return core.tx(() => {
    const t = now();
    // 一次删除牵连的每一行都盖同一个 removedAt（markRemoved 负责），
    // 回收站才能把「学生 + 他的记录 + 他的报名」当成一批一起还原。
    markRemoved(s, t);
    let n = 0;
    oc('records').forEach(r => {
      if (r.sid === s.id && !r.removed) { markRemoved(r, t); n++; }
    });
    // 家长绑定关系同步摘掉，避免指向已删学生
    oc('members').forEach(m => {
      const i = m.studentIds.indexOf(s.id);
      if (i > -1) { m.studentIds.splice(i, 1); m.updatedAt = t; }
    });
    // 报名（课时账）一并软删
    oc('enrollments').forEach(en => {
      if (en.studentId === s.id && !en.removed) markRemoved(en, t);
    });
    core.persist('students'); core.persist('records');
    core.persist('members'); core.persist('enrollments');
    return { ok: true, records: n };
  });
}

// 从回收站还原一个学生：把他连同「同一次删除带走的东西」一起放回来。
// 只还原这个学生自己的那一批（removedAt 相同 + 外键指向他），不碰别人后来删的数据。
function studentRestore(id) {
  const s = ocAll('students').find(x => x.id === Number(id) && x.removed);
  if (!s) return { ok: false, msg: '回收站里没有这个学生' };
  // 还原等于一次写操作，权限照旧按 student.write 判（演示模式也照样被拦）
  const err = deny('student.write', { student: s });
  if (err) return { ok: false, msg: err };
  return core.tx(() => {
    const t = now();
    const at = s.removedAt;
    markAlive(s, t);
    let rec = 0, enr = 0;
    // 只认「这一批」：删之前就不在的记录（removedAt 更早）不该被顺手复活。
    // 必须用 ocAll：oc 会把 removed 的行藏起来，删掉的东西根本遍历不到。
    ocAll('records').forEach(r => {
      if (r.sid === s.id && r.removed && r.removedAt === at) { markAlive(r, t); rec++; }
    });
    ocAll('enrollments').forEach(en => {
      if (en.studentId === s.id && en.removed && en.removedAt === at) { markAlive(en, t); enr++; }
    });
    core.persist('students'); core.persist('records'); core.persist('enrollments');
    // 家长绑定在删除时被摘掉了，按「同一家长号码自动归并」的既有规则补回来，
    // 不还原的话家长会看不到这个孩子，而界面上没有任何提示。
    const back = studentLinkParents(s);
    return { ok: true, records: rec, enrollments: enr, parents: back };
  });
}

/* ---------------- 学号与家长归并 ---------------- */
// 学号：机构内唯一、纯数字、从 1001 起。取「现有最大值 +1」而不是「数量 +1」——
// 删掉学生后号码不复用，家长手里记的旧学号不会指向另一个孩子。
const NO_START = 1001;
function studentNextNo() {
  let max = NO_START - 1;
  oc('students').forEach(s => {
    const n = Number(s.no);
    if (isFinite(n) && n > max) max = n;
  });
  return String(max + 1);
}
function studentByNo(no) {
  const k = String(no || '').trim();
  if (!k) return null;
  return oc('students').find(s => !s.removed && String(s.no) === k) || null;
}
// 家长标识：家长微信号/手机号，比较前统一去空格、短横、大小写。
// 空值不参与比较——两个都没填家长号码的学生不能被当成一家人。
function parentKey(v) {
  return String(v || '').trim().toLowerCase().replace(/[\s-]/g, '');
}
// F-04：手机号和微信号都是家长标识。历史数据只填过微信号，新表单可能只填手机号，
// 所以两个键都取、任一个相等就算同一位家长，老孩子和新孩子仍能自动归并（G-07）。
function parentKeys(s) {
  if (!s) return [];
  return [parentKey(s.parentPhone), parentKey(s.wechat)].filter(Boolean);
}
// 同家长的其他孩子（手机号或微信号任一相同）
function studentSiblings(s) {
  const ks = parentKeys(s);
  if (!ks.length) return [];
  return oc('students').filter(x => x.id !== s.id && !x.removed &&
    parentKeys(x).some(k => ks.indexOf(k) > -1));
}
// 自动归并：学生建档/改档后，凡与某位家长已绑定的孩子同属一个家长号码，
// 就把这个学生补进那位家长的绑定列表。场景：家里两个孩子先后报名，
// 第二个建档时自动出现在家长账号下，不需要再手动绑一次。
function studentLinkParents(s) {
  if (!s) return [];
  const sibs = studentSiblings(s);
  if (!sibs.length) return [];
  const sibIds = sibs.map(x => x.id);
  const hit = [];
  oc('members').forEach(m => {
    if (m.role !== 'parent' || m.removed) return;
    if (m.studentIds.indexOf(s.id) > -1) return;                      // 已经绑了，不重复
    if (!m.studentIds.some(id => sibIds.indexOf(id) > -1)) return;    // 不是这位家长的孩子
    m.studentIds.push(s.id);
    m.updatedAt = now();
    hit.push(m.name);
  });
  if (hit.length) core.persist('members');
  return hit;
}

module.exports = {
  studentList, studentOf, studentRaw, studentGet, studentName, studentSearch,
  studentCreate, studentUpdate, studentUpdateProfile, studentRemove, studentRestore,
  studentNextNo, studentByNo, studentSiblings, studentLinkParents, parentKey, parentKeys
};
