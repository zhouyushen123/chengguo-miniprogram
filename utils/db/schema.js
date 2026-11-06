// utils/db/schema.js —— 主数据模型：实体定义、字段约束、校验规则
//
// 十类实体，各自有唯一 id 与归属机构：
//   org      机构    { id, name, ownerId, status }          一个机构 = 一家校区/一个独立经营单元
//   member   成员    { id, orgId, userId, role, clsIds[], courseIds[], studentIds[], status }
//                                                          「某人在这家机构里是谁、能管哪些数据」
//   term     学期    { id, name, startDate, endDate, status, builtIn }   开班的时间段（2026春季班/第N期…）
//   class    班级    { id, name, sort, termId, mode, teacherId }
//                                                          mode: term=随学期结束归档 / carry=课时包可结转
//   course   课程    { id, name, subjectId }                内容单元，不绑定班级（v10）
//   classCourse 班级课程 { id, clsId, courseId, teacherId, sort }  多对多：哪门课在哪个班开
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
// v9：为阶段二题库留位——加 subjects / knowledge_points 两张表、课程挂学科、记录记满分口径。
//     全部是"加空字段/空表"，老数据升级后行为完全不变；现在不做，将来要重挂全部历史数据。
// v10：课程与班级彻底解耦。course 去掉 clsId，新增 class_courses 绑定表——
//     一门课（楷书）只存一条，可以在任意多个班里开；删班只解绑，不删课。
//     这是做题库的前提：题目挂在课程上，课程必须能跨班复用，否则每班一份题库。
const VERSION = 10;
// 机构号、类型工具、审计字段在 schema-base.js（与 schema 同层，方向 base ← schema）
const base = require('./schema-base');
const { DEFAULT_ORG, FACTORY_ORG, ORG_CHARS, newOrgId, isFactoryOrg,
  str, num, list, numList, txtList, ymd, normDate, audit } = base;

// 评分五档（与录入页每档代表分对应，用于筛选与统计口径统一）
const TAGS = ['待提高', '加油', '良好', '优秀', '最佳'];

// 单条记录的媒体数量上限。以前页面里写死一份、这里写死一份，改一处必忘另一处，
// 于是出现"界面上限 9 张、校验上限 9 张"看着一致但实际已经不同步的情况。只留一份。
const LIMITS = { photos: 9, videos: 3 };
// 学科种子、类别与课程名猜测放在 subject-seeds.js（纯常量/纯函数，单独成文件避免 schema 超行数上限）
const seeds = require('./subject-seeds');
const SUBJECT_KINDS = seeds.SUBJECT_KINDS;
const SUBJECT_SEEDS = seeds.SUBJECT_SEEDS;
const SUBJECT_KEYWORDS = seeds.SUBJECT_KEYWORDS;
const KP_SOURCES = seeds.KP_SOURCES;
const guessSubjectId = seeds.guessSubjectId;

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

/* ---------------- 各实体的规范化（白名单字段，多余字段一律丢弃） ---------------- */

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

// 课程：内容单元，不是"某班的课"。一门课可以被任意多个班开设（见 classCourses）。
// v10 之前 clsId 是必填的，等于内容被组织绑死——同一门课 5 个班就有 5 条课程记录、
// 5 份题库、改一次改 5 处。解耦后题库、教案、作业都能挂一次到处用。
function normalizeCourse(raw, orgId, stamp) {
  const r = raw || {};
  return Object.assign({
    id: num(r.id, 0),
    // 学科：阶段二题库按学科筛题/组卷。0 = 未指定（猜不出来就留空，不影响任何现有功能）
    subjectId: num(r.subjectId, 0),
    name: str(r.name).trim()
  }, audit(r, orgId, stamp));
}

// 班级课程绑定（多对多）。它是"关系"而不是"内容"：
// 不独立进回收站（跟着班级走），没有名字，解绑就是软删一行。
function normalizeClassCourse(raw, orgId, stamp) {
  const r = raw || {};
  return Object.assign({
    id: num(r.id, 0),
    clsId: num(r.clsId, 0),
    courseId: num(r.courseId, 0),
    teacherId: num(r.teacherId, 0),
    sort: num(r.sort, 0)
  }, audit(r, orgId, stamp));
}

// 学科：机构内学科清单。gid 是全局稳定 ID，内置 7 条用固定值，跨机构一致。
function normalizeSubject(raw, orgId, stamp) {
  const r = raw || {};
  return Object.assign({
    id: num(r.id, 0),
    gid: str(r.gid).trim(),
    name: str(r.name).trim(),
    kind: SUBJECT_KINDS.indexOf(r.kind) > -1 ? r.kind : 'academic',
    sort: num(r.sort, 0)
  }, audit(r, orgId, stamp));
}

// 学科种子：id 固定按 1..7 分配（幂等——重复调用不会产生第二套）
function buildSubjectSeeds(orgId, stamp) {
  return SUBJECT_SEEDS.map((s, i) => normalizeSubject({
    id: i + 1, gid: s.gid, name: s.name, kind: s.kind, sort: s.sort
  }, orgId, stamp));
}

// 知识点树：阶段一只建表与结构，数据到阶段二再录。
// path 是物化路径（云开发没有递归查询，查子树只能靠前缀匹配），这里只做格式规整。
function normalizeKnowledgePoint(raw, orgId, stamp) {
  const r = raw || {};
  const path = str(r.path).split('/').map(x => x.trim()).filter(Boolean).join('/');
  return Object.assign({
    id: num(r.id, 0),
    gid: str(r.gid).trim(),
    subjectId: num(r.subjectId, 0),
    parentId: num(r.parentId, 0),
    path,
    depth: Math.max(0, num(r.depth, path ? path.split('/').length - 1 : 0)),
    name: str(r.name).trim(),
    grade: str(r.grade).trim(),
    code: str(r.code).trim(),
    sort: num(r.sort, 0),
    source: KP_SOURCES.indexOf(r.source) > -1 ? r.source : 'org'
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
    // 满分口径：默认 100（老记录升级后自动补），只接受 1..1000 的整数，非法值回落 100。
    // 没有它，"85/100" 与 "8.5/10" 在平均分里无法区分。
    scoreScale: (function () {
      const s = Math.round(num(r.scoreScale, 100));
      return (s >= 1 && s <= 1000) ? s : 100;
    })(),
    tag: str(r.tag).trim(),
    note: str(r.note),
    photos: txtList(r.photos),
    videos: txtList(r.videos),
    audio: str(r.audio) || null,
    sent: r.sent === true,
    // 课次号：录入时盖上班级当前课次（补录可显式指定更早的课次）。
    // 0 表示未标注（只会出现在迁移前的老数据上，assignRecordSessions 会补算）。
    session: num(r.session, 0),
    // 关联知识点：阶段二由"作答/评语打标"填入，阶段一恒为空数组。
    // 单独留字段而不是将来加关联表，是因为一条记录挂 1~3 个知识点，键值对足够且省一次联表。
    // 只留正整数：null/''/脏值经 Number() 会变 0，留着就是一个指向不存在知识点的引用
    kpIds: numList(r.kpIds).filter(x => x > 0),
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
    case 'classCourse': return normalizeClassCourse(raw, orgId, stamp);
    case 'subject': return normalizeSubject(raw, orgId, stamp);
    case 'knowledgePoint': return normalizeKnowledgePoint(raw, orgId, stamp);
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
      if (e.name.length > 20) return '课程名称过长';
      return null;
    case 'classCourse':
      if (!e.clsId) return '绑定必须关联班级';
      if (!e.courseId) return '绑定必须关联课程';
      return null;
    case 'subject':
      if (!e.gid) return '学科缺少全局标识（gid）';
      if (!e.name) return '学科名称不能为空';
      if (e.name.length > 12) return '学科名称过长';
      return null;
    case 'knowledgePoint':
      if (!e.gid) return '知识点缺少全局标识（gid）';
      if (!e.name) return '知识点名称不能为空';
      if (!e.subjectId) return '知识点必须归属一个学科';
      if (!e.path) return '知识点缺少路径（path），子树查询依赖它';
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
      // 分数按满分口径校验：满分 10 分的随堂小测可以写 8.5，但不能写 85 却不改口径
      // （直接调 validate 的调用方可能没走 normalize，所以这里也兜底一次）
      const scale = (e.scoreScale >= 1 && e.scoreScale <= 1000) ? e.scoreScale : 100;
      if (!(e.score >= 0 && e.score <= scale)) return '分数应在 0-' + scale + ' 之间';
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
  SUBJECT_KINDS, SUBJECT_SEEDS, SUBJECT_KEYWORDS, KP_SOURCES,
  str, num, list, numList, txtList, ymd, normDate,
  normalize, validate,
  normalizeOrg, normalizeMember,
  normalizeTerm, normalizeClass, normalizeCourse, normalizeClassCourse, normalizeStudent, normalizeEnrollment,
  normalizeSubject, normalizeKnowledgePoint, buildSubjectSeeds, guessSubjectId,
  assignStudentNos, NO_START,
  assignRecordSessions,
  normalizeRecord, normalizeUser, normalizeTemplate
};
