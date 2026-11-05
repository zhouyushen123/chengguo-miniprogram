// utils/db/schema.js —— 主数据模型：实体定义、字段约束、校验规则
//
// 十类实体，各自有唯一 id 与归属机构：
//   org      机构    { id, name, ownerId, status }          一个机构 = 一家校区/一个独立经营单元
//   member   成员    { id, orgId, userId, role, clsIds[], courseIds[], studentIds[], status }
//                                                          「某人在这家机构里是谁、能管哪些数据」
//   term     学期    { id, name, startDate, endDate, status, builtIn }   开班的时间段（2026春季班/第N期…）
//   class    班级    { id, name, sort, termId, mode, teacherId }
//                                                          mode: term=随学期结束归档 / carry=课时包可结转
//   course   课程    { id, clsId, name }                    clsId → class.id
//   student  学生    { id, name, clsIds[], parent, wechat, photo, profile{} }
//   enrollment 报名  { id, studentId, clsId, termId, totalHours, usedHours, status, carriedFrom }
//                                                          课时账本：孩子在这个班买了多少课时、上了多少、剩多少
//   record   课堂记录 { id, sid, cid, courseId, course, date, score, tag, note, photos[], videos[], audio, sent, tid }
//   user     人员    { id, name }                           人的身份本身，不含权限
//   template 评价模板 { id, name, options[] }
//
// 【为什么把权限从 user 拆到 member】
// 原来 user 上直接挂 role + clsIds，等于"一个人一辈子只有一个身份"。但现实是：
//   - 同一位老师可以在两家机构兼职，两边的班级和角色都不同
//   - 一位家长有两个孩子，在不同机构上课
// 权限属于「人 × 机构」这个组合，不属于人本身。拆开后换机构不影响历史数据，
// 上云时 member 就是服务端的一张授权表，user 只是账号。
//
// 公共审计字段（所有实体强制携带）：orgId 归属机构 / createdAt 创建时间 / updatedAt 更新时间 / removed 软删除
// 软删除的意义：多端同步时"删掉"必须能被同步，硬删会被其它端的历史数据覆盖复活。
// v7：班级增加 session（课次号）——「本次录入」的节点由老师手动结清，不再由自然日自动切换；
// 记录落库时盖上当前课次号，跨天/多人接力录同一节课也能算成同一次。
const VERSION = 8;
// 出厂机构号：每台新装设备的本地库都挂它，**它不是一个真实机构**。
// 首次上云时由服务端发一个随机机构号（见 syncv2 的 hello），本地整体改挂过去。
// 以前它被当成真实机构号用，结果所有客户的数据都落在 org1 里混成一团——
// 那在单客户测试期看不出来，第二个客户进来就是灾难。
const DEFAULT_ORG = 'org1';
const FACTORY_ORG = DEFAULT_ORG;
// 机构号字符集：去掉容易看错的 0/o/1/l/i，它是会被人从日志里念出来的
const ORG_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function newOrgId(rand) {
  const r = rand || Math.random;
  let s = '';
  for (let i = 0; i < 10; i++) {
    const x = Math.min(0.999999, Math.max(0, Number(r()) || 0));
    s += ORG_CHARS[Math.floor(x * ORG_CHARS.length)];
  }
  return 'org_' + s;
}
// 还挂在出厂号上 = 这台设备的机构号还没被服务端换成真实值
const isFactoryOrg = id => String(id || '') === FACTORY_ORG;

// 评分五档（与录入页每档代表分对应，用于筛选与统计口径统一）
const TAGS = ['待提高', '加油', '良好', '优秀', '最佳'];

// 单条记录的媒体数量上限。以前页面里写死一份、这里写死一份，改一处必忘另一处，
// 于是出现"界面上限 9 张、校验上限 9 张"看着一致但实际已经不同步的情况。只留一份。
const LIMITS = { photos: 9, videos: 3 };
// 记录类型（ADR-009：留字段不留逻辑）
// 现在只有一种「成果」，但字段先落下去。将来加考勤/作业/缴费时，只是往这个数组里加值
// 并写对应的 domain 逻辑，不需要再改表结构、不需要迁移历史数据。
// 这是用接近零的成本，换掉未来一次全量数据迁移。
const RECORD_TYPES = ['achievement'];
// 角色顺序即权限由大到小；具体能做什么见 utils/db/permissions.js
const ROLES = ['owner', 'admin', 'teacher', 'parent'];
const MEMBER_STATUS = ['active', 'invited', 'disabled'];
const ORG_STATUS = ['active', 'suspended'];
// 学期状态：upcoming 未开始 / active 进行中（录入入口只看它）/ archived 已归档（只读）
const TERM_STATUS = ['upcoming', 'active', 'archived'];
// 班级模式：term 随学期结束归档；carry 课时包，没上完结转下期
const CLASS_MODES = ['term', 'carry'];
// 报名状态：active 在读 / carried 已结转到新班 / churned 未续报（流失，档案保留）/ refunded 退费
const ENROLL_STATUS = ['active', 'carried', 'churned', 'refunded'];

// 默认评价模板：维度名 + 该维度下的常用评语选项
const DEFAULT_TEMPLATES = [
  { name: '上课态度', options: ['认真专注，积极举手发言', '听讲认真，偶有走神，提醒后能改正', '状态放松，与同学互动积极'] },
  { name: '反馈交流', options: ['能主动和老师交流，回答问题思路清晰', '愿意表达自己的想法，敢于提问', '与老师配合默契，反馈及时'] },
  { name: '课堂记录', options: ['本节课完成新内容练习，整体完成度较高', '本节课以复习巩固为主，练习认真', '课堂纪律良好，练习节奏跟得上'] },
  { name: '知识掌握', options: ['已基本掌握本节内容，细节还需多加练习', '重点内容掌握扎实，可进入下一阶段', '部分知识点还需课后加强，建议多练'] },
  { name: '课程注意', options: ['请课后复习本节内容，下节课将巩固练习', '请提前完成课后作业，下节课检查讲评', '下节课将学习新内容，请保持状态'] }
];

/* ---------------- 基础类型工具（容错优先，脏数据不抛错） ---------------- */
const str = (v, d) => (typeof v === 'string' ? v : (v === null || v === undefined ? (d || '') : String(v)));
const num = (v, d) => { const x = Number(v); return isFinite(x) ? x : d; };
const list = v => (Array.isArray(v) ? v : []);
const numList = v => list(v).map(Number).filter(x => isFinite(x));
const txtList = v => list(v).map(x => str(x).trim()).filter(Boolean);
const pad2 = n => (n < 10 ? '0' : '') + n;

// 统一日期格式 YYYY-MM-DD（历史数据里有 2026-11-1 这种没补零的写法，字符串排序会错位）
function ymd(d) {
  const x = d || new Date();
  return x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate());
}
function normDate(v) {
  const m = str(v).trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  return m ? m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]) : '';
}

/* ---------------- 各实体的规范化（白名单字段，多余字段一律丢弃） ---------------- */
function audit(raw, orgId, stamp) {
  const r = raw || {};
  const created = num(r.createdAt, 0) || stamp;
  const removed = r.removed === true;
  return {
    orgId: str(r.orgId, DEFAULT_ORG) || DEFAULT_ORG,
    createdAt: created,
    updatedAt: num(r.updatedAt, 0) || stamp,
    removed,
    // 删除痕迹：removedAt 是「哪一次删除」的标记。删学生/删班级会连带软删记录、报名、课程，
    // 它们共用同一个 removedAt —— 回收站靠这个值把一整批认出来，一起还原。
    // 已经删过的行不改写原值，否则后来的一次删除会把两次删的东西混成一批，还原时"复活"错的条目。
    removedAt: removed ? (num(r.removedAt, 0) || num(r.updatedAt, 0) || stamp) : 0,
    removedBy: removed ? num(r.removedBy, 0) : 0
  };
}

function normalizeClass(raw, orgId, stamp) {
  const r = raw || {};
  return Object.assign({
    id: num(r.id, 0),
    name: str(r.name).trim(),
    sort: num(r.sort, 0),
    termId: num(r.termId, 0),                                  // 归属学期（0 = 未挂靠，normalizeAll 会兜底挂到内置学期）
    mode: CLASS_MODES.indexOf(r.mode) > -1 ? r.mode : 'term',  // 学期制为默认，老数据无感
    teacherId: num(r.teacherId, 0),                            // 主讲老师（member id），0 = 未指派
    // 课次号：当前正录的是第几次课，从 1 起。结清（sessionSettle）时 +1。
    // 老数据升级时由 assignRecordSessions 按历史日期分组补算，不小于 1。
    session: Math.max(1, num(r.session, 1)),
    // 删除班级时被一起摘掉的关联（学生 / 负责该班的成员）。
    // 不记下来的话，从回收站恢复的班级会是个"空班"——学生还在，但不在班里了，
    // 而且没有任何界面提示这件事，等于一次静默的半个还原。
    detached: {
      students: numList(r.detached && r.detached.students),
      members: numList(r.detached && r.detached.members)
    }
  }, audit(r, orgId, stamp));
}

// 学期：开班的时间段。名称完全自由（2026春季班 / 暑假班 / 第N期），排序与计算一律按日期。
// builtIn: 内置「长期班」——老数据升级时自动创建并收编全部历史班级，不参与结转向导。
function normalizeTerm(raw, orgId, stamp) {
  const r = raw || {};
  return Object.assign({
    id: num(r.id, 0),
    name: str(r.name).trim(),
    startDate: normDate(r.startDate),
    endDate: normDate(r.endDate),
    status: TERM_STATUS.indexOf(r.status) > -1 ? r.status : 'upcoming',
    builtIn: r.builtIn === true
  }, audit(r, orgId, stamp));
}

// 报名（课时账本）：孩子 × 班级 × 学期。结转制班级的消费与结转都落在这张表上。
// carriedFrom 指向上一期的报名 id，续报溯源用。
function normalizeEnrollment(raw, orgId, stamp) {
  const r = raw || {};
  return Object.assign({
    id: num(r.id, 0),
    studentId: num(r.studentId, 0),
    clsId: num(r.clsId, 0),
    termId: num(r.termId, 0),
    totalHours: num(r.totalHours, 0),
    usedHours: num(r.usedHours, 0),
    status: ENROLL_STATUS.indexOf(r.status) > -1 ? r.status : 'active',
    carriedFrom: num(r.carriedFrom, 0)
  }, audit(r, orgId, stamp));
}

function normalizeCourse(raw, orgId, stamp) {
  const r = raw || {};
  return Object.assign({
    id: num(r.id, 0),
    clsId: num(r.clsId, 0),
    name: str(r.name).trim()
  }, audit(r, orgId, stamp));
}

function normalizeStudent(raw, orgId, stamp) {
  const r = raw || {};
  return Object.assign({
    id: num(r.id, 0),
    name: str(r.name).trim(),
    // 学号：系统自动生成的机构内唯一编号（纯数字，从 1001 起）。
    // 用途有两个——家长凭学号绑定孩子；同一个家长号码下的多个孩子自动归并到同一位家长。
    // 由 students.js 在建档时分配，迁移老数据时按建档顺序补发，一经生成不再改动。
    no: str(r.no).trim(),
    // 性别：仅 男/女 两种取值，空串表示未知（历史数据与未填写的都归入未知，便于筛选补录）
    gender: ['男', '女'].indexOf(r.gender) > -1 ? r.gender : '',
    // 入学年份：机构视角的入学时间（区别于建档时间），0 表示未填；筛选「按年份看学员」用
    enrollYear: num(r.enrollYear, 0),
    clsIds: numList(r.clsIds),
    parent: str(r.parent).trim(),
    wechat: str(r.wechat).trim(),
    photo: str(r.photo),
    profile: (r.profile && typeof r.profile === 'object') ? Object.assign({}, r.profile) : {},
    demo: r.demo === true
  }, audit(r, orgId, stamp));
}

// 学号补发：老数据、演示数据里没有学号，按建档顺序（id 升序）从 1001 起补。
// 已有学号原样保留；同一批数据每次算出的号相同（幂等），不会因为归并/迁移反复变动。
const NO_START = 1001;
function assignStudentNos(list) {
  const arr = Array.isArray(list) ? list : [];
  const used = {};
  arr.forEach(s => { if (s.no) used[s.no] = 1; });
  let seq = NO_START - 1;
  arr.slice().sort((a, b) => a.id - b.id).forEach(s => {
    if (s.no) return;
    do { seq++; } while (used[String(seq)]);
    s.no = String(seq);
    used[s.no] = 1;
  });
  return arr;
}

// 课次补算：给没有 session 标的老记录（v6 及以前）按「同班同一天 = 同一次课」归组编号。
// 同一班内日期升序编号：最早的一天 = 第 1 次课，依次递增；已有 session 的记录不动（幂等，重跑结果不变）。
// 班级的当前课次 = max(自身 session, 该班记录的最大 session, 1) —— 老数据里"最近一天"往往就是
// 正在录的这课，升级后班级页看到的还是同一批未录学生，行为无感。
function assignRecordSessions(classes, records) {
  const clsArr = Array.isArray(classes) ? classes : [];
  const recArr = Array.isArray(records) ? records : [];
  // 每个班出现过的日期集合（含有 session 的记录，保证混合数据也能对上号）
  const datesOf = {};
  recArr.forEach(r => {
    if (!r || r.removed || !r.cid || !r.date) return;
    const arr = datesOf[r.cid] || (datesOf[r.cid] = []);
    if (arr.indexOf(r.date) < 0) arr.push(r.date);
  });
  Object.keys(datesOf).forEach(cid => {
    const seq = {};
    datesOf[cid].sort().forEach((d, i) => { seq[d] = i + 1; });
    recArr.forEach(r => {
      if (r && !r.removed && r.cid === Number(cid) && !r.session) r.session = seq[r.date] || 1;
    });
    const c = clsArr.find(x => x && x.id === Number(cid));
    if (c) {
      let maxS = 1;
      recArr.forEach(r => { if (r && !r.removed && r.cid === Number(cid) && r.session > maxS) maxS = r.session; });
      c.session = Math.max(num(c.session, 1), maxS, 1);
    }
  });
  return records;
}

function normalizeRecord(raw, orgId, stamp) {
  const r = raw || {};
  const date = normDate(r.date) || ymd(new Date(num(r.createdAt, stamp)));
  return Object.assign({
    id: num(r.id, 0),
    type: RECORD_TYPES.indexOf(r.type) > -1 ? r.type : 'achievement',   // 业务活动类型，见 ADR-009
    sid: num(r.sid, 0),
    cid: num(r.cid, 0),
    courseId: num(r.courseId, 0),
    course: str(r.course).trim(),
    date,
    score: num(r.score, 0),
    tag: str(r.tag).trim(),
    note: str(r.note),
    photos: txtList(r.photos),
    videos: txtList(r.videos),
    audio: str(r.audio) || null,
    sent: r.sent === true,
    // 课次号：录入时盖上班级当前课次（补录可显式指定更早的课次）。
    // 0 表示未标注（只会出现在迁移前的老数据上，assignRecordSessions 会补算）。
    session: num(r.session, 0),
    tid: str(r.tid),        // 录入老师，用于"XX老师的课堂语音"
    demo: r.demo === true
  }, audit(r, orgId, stamp));
}

function normalizeOrg(raw, stamp) {
  const r = raw || {};
  return Object.assign({
    id: str(r.id, DEFAULT_ORG) || DEFAULT_ORG,
    name: str(r.name).trim(),
    ownerId: str(r.ownerId).trim(),
    status: ORG_STATUS.indexOf(r.status) > -1 ? r.status : 'active'
  }, audit(r, str(r.orgId, r.id || DEFAULT_ORG), stamp));
}

// 成员关系：权限的唯一来源。role 决定能做什么，三个 id 列表决定能对谁做。
function normalizeMember(raw, orgId, stamp) {
  const r = raw || {};
  const role = ROLES.indexOf(r.role) > -1 ? r.role : 'parent';
  return Object.assign({
    id: num(r.id, 0),
    orgId: str(r.orgId, orgId || DEFAULT_ORG) || DEFAULT_ORG,
    userId: str(r.userId).trim(),
    role,
    name: str(r.name).trim(),          // 冗余一份姓名，成员列表不必再查 users
    clsIds: numList(r.clsIds),
    courseIds: numList(r.courseIds),
    studentIds: numList(r.studentIds),
    status: MEMBER_STATUS.indexOf(r.status) > -1 ? r.status : 'active',
    phone: str(r.phone).trim(),        // 档案：手机号（选填，老师/家长通用）
    wechat: str(r.wechat).trim(),      // 档案：微信号（选填）
    photo: str(r.photo).trim(),        // 档案：头像照片（选填；头像统一口径见 components/ava）
    // 云端账号标识（v8）：邀请码加入的成员由云函数写入，本机自建的成员在首次上云时
    // 由「认领」动作补上。它比 userId 可靠——userId 是本机生成的，跨设备毫无意义。
    openid: str(r.openid).trim()
  }, audit(r, orgId, stamp));
}

// 人员实体只保留"这个人是谁"，权限全部移到 member。
// role 仅作默认值参考（新建成员关系时沿用），不参与任何判定。
function normalizeUser(raw, orgId, stamp) {
  const r = raw || {};
  const role = ROLES.indexOf(r.role) > -1 ? r.role : 'teacher';
  return Object.assign({
    id: str(r.id),
    name: str(r.name).trim(),
    photo: str(r.photo).trim(),        // 头像：与成员表冗余同步（memberUpdate 负责），展示统一走 components/ava
    role
  }, audit(r, orgId, stamp));
}

function normalizeTemplate(raw, orgId, stamp) {
  const r = raw || {};
  return Object.assign({
    id: num(r.id, 0),
    name: str(r.name).trim(),
    options: txtList(r.options),
    sort: num(r.sort, 0)
  }, audit(r, orgId, stamp));
}

// 不同实体 id 类型不同：班级/课程/学生/记录/模板/成员用自增数字，人员与机构用字符串
function normalize(entity, raw, orgId, stamp) {
  switch (entity) {
    case 'org': return normalizeOrg(raw, stamp);
    case 'member': return normalizeMember(raw, orgId, stamp);
    case 'term': return normalizeTerm(raw, orgId, stamp);
    case 'class': return normalizeClass(raw, orgId, stamp);
    case 'course': return normalizeCourse(raw, orgId, stamp);
    case 'student': return normalizeStudent(raw, orgId, stamp);
    case 'enrollment': return normalizeEnrollment(raw, orgId, stamp);
    case 'record': return normalizeRecord(raw, orgId, stamp);
    case 'user': return normalizeUser(raw, orgId, stamp);
    case 'template': return normalizeTemplate(raw, orgId, stamp);
    default: return null;
  }
}

/* ---------------- 校验规则：写入前拦，返回错误文案（null = 通过） ---------------- */
function validate(entity, e) {
  if (!e) return '数据为空';
  switch (entity) {
    case 'org':
      if (!e.name) return '机构名称不能为空';
      if (e.name.length > 30) return '机构名称过长';
      return null;
    case 'member':
      if (!e.userId) return '成员必须关联人员';
      if (ROLES.indexOf(e.role) < 0) return '角色不合法';
      // 老师必须有分工范围：空范围会让"按班过滤"退化成全可见（fail-open）
      if (e.role === 'teacher' && !e.clsIds.length && e.status === 'active') return '老师需要至少分配一个班级';
      if (e.role === 'parent' && !e.studentIds.length && e.status === 'active') return '家长需要至少绑定一个孩子';
      return null;
    case 'class':
      if (!e.name) return '班级名称不能为空';
      if (e.name.length > 20) return '班级名称过长';
      return null;
    case 'term':
      if (!e.name) return '学期名称不能为空';
      if (e.name.length > 20) return '学期名称过长';
      if (e.startDate && !e.startDate) return '开始日期格式应为 YYYY-MM-DD';
      if (e.endDate && e.startDate && e.endDate < e.startDate) return '结束日期不能早于开始日期';
      return null;
    case 'enrollment':
      if (!e.studentId) return '报名必须关联学生';
      if (!e.clsId) return '报名必须关联班级';
      if (e.totalHours < 0 || e.usedHours < 0) return '课时数不能为负';
      return null;
    case 'course':
      if (!e.name) return '课程名称不能为空';
      if (!e.clsId) return '课程必须归属一个班级';
      return null;
    case 'student':
      if (!e.name) return '学生姓名不能为空';
      if (e.name.length > 20) return '学生姓名过长';
      if (e.parent && e.parent.length > 20) return '家长姓名过长';
      return null;
    case 'record':
      if (!e.sid) return '记录必须关联学生';
      if (!e.cid) return '记录必须关联班级';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) return '记录日期格式应为 YYYY-MM-DD';
      if (!(e.score >= 0 && e.score <= 100)) return '分数应在 0-100 之间';
      if (e.photos.length > LIMITS.photos) return '照片最多 ' + LIMITS.photos + ' 张';
      if (e.videos.length > LIMITS.videos) return '视频最多 ' + LIMITS.videos + ' 个';
      return null;
    case 'user':
      if (!e.name) return '人员姓名不能为空';
      if (ROLES.indexOf(e.role) < 0) return '角色不合法';
      return null;
    case 'template':
      if (!e.name) return '模板维度名不能为空';
      if (e.name.length > 12) return '维度名过长';
      return null;
    default: return '未知实体';
  }
}

module.exports = {
  VERSION, DEFAULT_ORG, FACTORY_ORG, newOrgId, isFactoryOrg, ORG_CHARS,
  TAGS, LIMITS, RECORD_TYPES, ROLES, MEMBER_STATUS, ORG_STATUS,
  TERM_STATUS, CLASS_MODES, ENROLL_STATUS, DEFAULT_TEMPLATES,
  str, num, list, numList, txtList, ymd, normDate,
  normalize, validate,
  normalizeOrg, normalizeMember,
  normalizeTerm, normalizeClass, normalizeCourse, normalizeStudent, normalizeEnrollment,
  assignStudentNos, NO_START,
  assignRecordSessions,
  normalizeRecord, normalizeUser, normalizeTemplate
};
