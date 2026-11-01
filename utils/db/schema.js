// utils/db/schema.js —— 主数据模型：实体定义、字段约束、校验规则
//
// 八类实体，各自有唯一 id 与归属机构：
//   org      机构    { id, name, ownerId, status }          一个机构 = 一家校区/一个独立经营单元
//   member   成员    { id, orgId, userId, role, clsIds[], courseIds[], studentIds[], status }
//                                                          「某人在这家机构里是谁、能管哪些数据」
//   class    班级    { id, name, sort }
//   course   课程    { id, clsId, name }                    clsId → class.id
//   student  学生    { id, name, clsIds[], parent, wechat, photo, profile{} }
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
const VERSION = 4;
const DEFAULT_ORG = 'org1';

// 评分五档（与录入页每档代表分对应，用于筛选与统计口径统一）
const TAGS = ['待提高', '加油', '良好', '优秀', '最佳'];
// 角色顺序即权限由大到小；具体能做什么见 utils/db/permissions.js
const ROLES = ['owner', 'admin', 'teacher', 'parent'];
const MEMBER_STATUS = ['active', 'invited', 'disabled'];
const ORG_STATUS = ['active', 'suspended'];

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
  return {
    orgId: str(r.orgId, DEFAULT_ORG) || DEFAULT_ORG,
    createdAt: created,
    updatedAt: num(r.updatedAt, 0) || stamp,
    removed: r.removed === true
  };
}

function normalizeClass(raw, orgId, stamp) {
  const r = raw || {};
  return Object.assign({
    id: num(r.id, 0),
    name: str(r.name).trim(),
    sort: num(r.sort, 0)
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
    clsIds: numList(r.clsIds),
    parent: str(r.parent).trim(),
    wechat: str(r.wechat).trim(),
    photo: str(r.photo),
    profile: (r.profile && typeof r.profile === 'object') ? Object.assign({}, r.profile) : {},
    demo: r.demo === true
  }, audit(r, orgId, stamp));
}

function normalizeRecord(raw, orgId, stamp) {
  const r = raw || {};
  const date = normDate(r.date) || ymd(new Date(num(r.createdAt, stamp)));
  return Object.assign({
    id: num(r.id, 0),
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
    status: MEMBER_STATUS.indexOf(r.status) > -1 ? r.status : 'active'
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
    case 'class': return normalizeClass(raw, orgId, stamp);
    case 'course': return normalizeCourse(raw, orgId, stamp);
    case 'student': return normalizeStudent(raw, orgId, stamp);
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
      if (e.photos.length > 9) return '照片最多 9 张';
      if (e.videos.length > 3) return '视频最多 3 个';
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
  VERSION, DEFAULT_ORG, TAGS, ROLES, MEMBER_STATUS, ORG_STATUS, DEFAULT_TEMPLATES,
  str, num, list, numList, txtList, ymd, normDate,
  normalize, validate,
  normalizeOrg, normalizeMember,
  normalizeClass, normalizeCourse, normalizeStudent, normalizeRecord, normalizeUser, normalizeTemplate
};
