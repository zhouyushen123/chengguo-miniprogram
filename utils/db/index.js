// utils/db/index.js —— 主数据访问层（唯一出口）
//
// 用法：const db = require('../../utils/db');
//   db.classes.list()            db.students.of(clsId)        db.records.save(pick, true)
//   db.auth.actor()              db.auth.can('record.send',{record})
//
// 【约定】
// 1. 页面只通过本文件读写数据：不碰 wx.setStorageSync，也不直接改返回对象里的字段
//    （改字段请调用 update / markSent 等方法，否则不会落盘、也不会更新 updatedAt）
// 2. 所有写操作都过 schema 规范化 + 校验 + 权限判定，非法或越权的写不进去
// 3. 所有实体都带 orgId / createdAt / updatedAt / removed，软删除保留痕迹便于多端同步
// 4. 换云端只替换 utils/db/storage.js 的实现，这里和页面都不用改
//
// 【权限策略：读也过滤，不只拦写】
// 列表查询默认已按当前身份过滤（老师只见自己班、家长只见自己孩子且仅已发布）。
// 页面不要再自己写 role === 'parent' 之类的判断——规则只在 permissions.js 定义一次。
// 需要绕过身份过滤做统计时，用 oc(name)（仍限当前机构）；确实需要跨机构全量才用 core.coll。
// 注意：写操作与启动维护（normalizeAll / repairRefs / 演示数据包 / merge）必须用 core.coll，
// 否则 setColl 这类覆盖写会把他机构的数据一起抹掉。
//
// 【目录结构】本文件只是门面（对外 API 的组装与文档），实现按领域拆在同目录下：
//   ctx.js          底座：now / org / oc / actor / deny（不依赖任何领域，杜绝 require 循环）
//   org.js          机构
//   identity.js     成员 + 账号（user 与 member 是一体两面，合在一起才不会有环）
//   terms.js        学期与结转（数据准备）
//   settle.js       结转向导的落地动作（跨领域事务）
//   classes.js      班级            courses.js    课程
//   students.js     学生            enrollments.js 报名（课时账本）
//   records.js      课堂记录        templates.js  评价模板
//   maintenance.js  启动迁移 / 数据自愈 / 演示数据 / 云端合并
// 依赖方向严格单向：ctx ← L2 领域 ← enrollments/records ← maintenance ← 本文件。
// 新增领域时请沿用这个方向，若发现需要反向调用，说明边界划错了，先调整边界而不是写 require 环。
const schema = require('./schema');
const core = require('./core');
const perms = require('./permissions');

const ctx = require('./ctx');
const orgs = require('./org');
const identity = require('./identity');
const terms = require('./terms');
const classes = require('./classes');
const courses = require('./courses');
const students = require('./students');
const enrollments = require('./enrollments');
const records = require('./records');
const settle = require('./settle');
const templates = require('./templates');
const maintenance = require('./maintenance');

const { org, actor, memberCurrent } = ctx;
const today = () => schema.ymd();

/* =====================================================================
 * 对外
 * ===================================================================*/
const db = {
  init: maintenance.init,
  status: maintenance.status,
  raw: core.data,
  real: core.realData,          // 真实库（与演示模式无关，设备级维护用）
  coll: core.coll,
  flush: core.flushAll,
  health: core.health,          // 存储健康度：用量、上次落盘失败
  mediaRefs: maintenance.mediaRefs,   // 库里引用着的媒体路径（清理垃圾文件用）
  settings: identity.settings, setTeacher: identity.setTeacher,
  today, canSend: records.canSend, merge: maintenance.merge,
  me: identity.me, isParent: identity.isParent,
  // 演示数据：独立的第二套数据（磁盘上另一组 key），只能看不能改。
  // active() 决定页面要不要显示「演示数据」横幅，enter/exit 只切指针、不搬数据。
  demo: maintenance.demo,
  org, nextId: core.nextId,
  TAGS: schema.TAGS,
  TYPES: schema.RECORD_TYPES,
  // 单条记录的媒体数量上限（页面计数与写入校验共用这一份，别再各写一套）
  LIMITS: schema.LIMITS,

  auth: {
    actor,
    member: memberCurrent,
    can: (action, target) => perms.can(actor(), action, target),
    abilities: () => perms.abilities(actor()),
    canSeeClass: cid => perms.canSeeClass(actor(), cid),
    canSeeStudent: s => perms.canSeeStudent(actor(), s),
    canSeeRecord: r => perms.canSeeRecord(actor(), r),
    denyReason: action => perms.denyReason(actor(), action),
    role: () => { const a = actor(); return a ? a.role : ''; },
    roleLabel: () => { const a = actor(); return a ? a.roleLabel : ''; },
    isOwner: () => { const a = actor(); return !!a && a.role === 'owner'; },
    isAdmin: () => { const a = actor(); return !!a && perms.FULL.indexOf(a.role) > -1; },
    isTeacher: () => { const a = actor(); return !!a && a.role === 'teacher'; },
    isParent: () => { const a = actor(); return !!a && a.role === 'parent'; },
    ROLES: perms.ROLES,
    ROLE_LABEL: perms.ROLE_LABEL,
    ACTIONS: perms.ACTIONS
  },

  orgs: {
    current: orgs.orgCurrent, update: orgs.orgUpdate, checkName: orgs.orgCheckName,
    get: id => ctx.oc('orgs').find(o => o.id === String(id)) || null,
    list: () => ctx.oc('orgs')
  },

  members: {
    list: identity.memberList,
    view: identity.memberView,
    get: identity.memberGet,
    ofUser: identity.memberOfUser,
    current: memberCurrent,
    create: identity.memberCreate, update: identity.memberUpdate, remove: identity.memberRemove
  },

  terms: {
    list: terms.termList, get: terms.termGet, activeList: terms.termActiveList,
    create: terms.termCreate, update: terms.termUpdate, archive: terms.termArchive,
    // 结转向导：planSettle 取数据、settle 落地（后者是一个事务，失败整体回滚）
    planSettle: terms.planSettle, settle: settle.settle
  },
  enrollments: {
    list: enrollments.enrollmentList, get: enrollments.enrollmentGet,
    ofStudent: enrollments.enrollmentsOfStudent,
    ofClass: enrollments.enrollmentsOfClass, of: enrollments.enrollmentOf,
    create: enrollments.enrollmentCreate, update: enrollments.enrollmentUpdate,
    remove: enrollments.enrollmentRemove
  },

  classes: {
    list: classes.classList, get: classes.classGet, name: classes.className,
    // 页面要的"只读判定/计数"走这两个：不返回实体，不会顺带把看不见的班名带出去
    mode: classes.classMode, countOfTerm: classes.classCountOfTerm,
    create: classes.classCreate, update: classes.classUpdate, remove: classes.classRemove,
    // 不过滤权限，但仍限当前机构。只允许 tests/ 与数据层内部用：
    // 页面用它会绕过可见性（get 返回 null 时又从这里捞出来），lint 已禁 pages/ 出现 ._all(
    _all: () => ctx.oc('classes')
  },
  courses: {
    list: courses.courseList, of: courses.courseOf, get: courses.courseGet,
    create: courses.courseCreate, update: courses.courseUpdate, remove: courses.courseRemove
  },
  students: {
    list: students.studentList, of: students.studentOf, get: students.studentGet,
    search: students.studentSearch, name: students.studentName,
    create: students.studentCreate, update: students.studentUpdate,
    updateProfile: students.studentUpdateProfile, remove: students.studentRemove
  },
  records: {
    list: records.recordList, ofStudent: records.recordOfStudent, ofClass: records.recordOfClass,
    get: records.recordGet, latest: records.recordLatest, save: records.recordSave,
    markSent: records.recordMarkSent, remove: records.recordRemove
  },
  users: {
    list: identity.userList, get: identity.userGet, name: identity.userName,
    current: identity.userCurrent,
    switchTo: identity.userSwitch, switchHome: identity.userSwitchHome,
    create: identity.userCreate, update: identity.userUpdate, remove: identity.userRemove
  },
  templates: {
    list: templates.tplList, get: templates.tplGet,
    create: templates.tplCreate, update: templates.tplUpdate, remove: templates.tplRemove,
    addOption: templates.tplAddOption, updateOption: templates.tplUpdateOption,
    removeOption: templates.tplRemoveOption,
    replaceAll: templates.tplReplaceAll
  }
};

module.exports = db;
