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
const entities = require('./entities');
const factory = require('./factory');
const storage = require('./storage');
const perms = require('./permissions');

const ctx = require('./ctx');
const orgs = require('./org');
const identity = require('./identity');
const terms = require('./terms');
const classes = require('./classes');
const courses = require('./courses');
const content = require('./content');
const students = require('./students');
const enrollments = require('./enrollments');
const records = require('./records');
const settle = require('./settle');
const templates = require('./templates');
const audit = require('./audit');
const trash = require('./trash');
const maintenance = require('./maintenance');
const syncStore = require('./sync');

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
  // 本地快照：核心资产（学生/老师/机构/班级/记录）的滚动备份，最多 3 份。
  // 页面只做「看有什么、手动备份、恢复」三件事，恢复后由 maintenance 负责落盘与重新同步。
  // 核心资产体检：学生 / 成员 / 机构之间的引用是否对得上。
  // scan 只读；fix 只做"修了绝不会更糟"的两类（悬空引用、学号重复/缺失）。
  audit: { scan: audit.scan, fix: audit.fix },
  // 回收站：删除是可逆的，这里是列出来与还原的唯一入口
  trash: { list: trash.list, restore: trash.restore },
  snapshots: {
    list: storage.snapshotList,
    save: tag => storage.saveSnapshot(tag, core.realData()),
    read: storage.readSnapshot,
    drop: storage.dropSnapshot,
    restore: maintenance.restoreSnapshot
  },
  mediaRefs: maintenance.mediaRefs,   // 库里引用着的媒体路径（清理垃圾文件用）
  // 回到出厂：本机数据坏档（成员表丢失 → 所有写操作都被「请先登录」拦住）时的唯一自救出口。
  // 只清本机，云端不动；重置后重走开通向导，第一次同步会重新绑定机构。
  resetReal: factory.resetReal,
  // 半坏档自救：机构在、成员表空 → 到处「请先登录」。遇到写被拦时可先修身份再重试一次
  repairIdentity: factory.repairIdentity,
  integrity: maintenance.integrity, integrityGroups: maintenance.integrityGroups, repairLinks: maintenance.repairLinks,  // 引用完整性
  adoptFactoryRows: maintenance.adoptFactoryRows,   // 骨架收编：登录前用出厂号建的行跟着换机构号
  // 原始条数：每张表「总条数 / 当前机构条数」。数据"看着少了"时用它分辨是丢了还是身份不对
  rawCounts: () => {
    const raw = core.realData() || {};
    const cur = core.meta().orgId || '';
    // 只数有效行（排除已删除）：2026-11-05 真机踩过——成员表 1/1 看着有人，
    // 其实那一条是 removed 的死行，身份判定（走 oc 视图）看不到它，于是到处「请先登录」。
    // 诊断卡如果连死行一起数，就会把「坏了」显示成「好的」，误导排查方向。
    return entities.ALL_COLLS.map(n => {
      const list = (Array.isArray(raw[n]) ? raw[n] : []).filter(x => x && !x.removed);
      const mine = n === 'orgs'
        ? list.filter(x => String(x && x.id) === String(cur)).length
        : list.filter(x => String((x && x.orgId) || cur) === String(cur)).length;
      const def = entities.byColl(n);
      return { k: n, label: (def && def.label) || n, all: list.length, mine };
    });
  },
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
    ofOpenid: identity.memberOfOpenid,
    claimOpenid: identity.claimOpenid,
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
    restore: classes.classRestore,
    // 不过滤权限，但仍限当前机构。只允许 tests/ 与数据层内部用：
    // 页面用它会绕过可见性（get 返回 null 时又从这里捞出来），lint 已禁 pages/ 出现 ._all(
    _all: () => ctx.oc('classes')
  },
  courses: {
    list: courses.courseList, of: courses.courseOf, get: courses.courseGet,
    create: courses.courseCreate, update: courses.courseUpdate, remove: courses.courseRemove, restore: courses.courseRestore,
    // V10：课程与班级解耦后的绑定能力——课程库一次建好，在任何班"开课"就是绑一条
    bind: courses.courseBind, unbind: courses.courseUnbind,
    setClasses: courses.courseSetClasses,
    classIdsOf: courses.classIdsOf, courseIdsOf: courses.courseIdsOf, bindingsOf: courses.bindingOf,
    orphans: courses.courseOrphans,
    // 同名课程收拢（老数据「一个班一条课」的清理入口）
    duplicates: courses.courseDuplicates, merge: courses.courseMerge, mergeAll: courses.courseMergeAll
  },
  // 内容域：学科与知识点（阶段一只建表，不建界面；阶段二题库的挂载点）
  subjects: {
    list: content.subjectList, get: content.subjectGet, byGid: content.subjectByGid,
    guessFor: content.guessFor,
    create: content.subjectCreate, update: content.subjectUpdate, remove: content.subjectRemove
  },
  kps: {
    list: content.kpList, get: content.kpGet, byGid: content.kpByGid,
    children: content.kpChildren, subtree: content.kpSubtree,
    create: content.kpCreate, update: content.kpUpdate, remove: content.kpRemove
  },
  students: {
    list: students.studentList, of: students.studentOf, get: students.studentGet,
    search: students.studentSearch, name: students.studentName,
    byNo: students.studentByNo, siblings: students.studentSiblings,
    create: students.studentCreate, update: students.studentUpdate,
    updateProfile: students.studentUpdateProfile, remove: students.studentRemove,
    restore: students.studentRestore
  },
  records: {
    list: records.recordList, ofStudent: records.recordOfStudent, ofClass: records.recordOfClass,
    get: records.recordGet, latest: records.recordLatest, save: records.recordSave,
    markSent: records.recordMarkSent, attachCloud: records.recordAttachCloud, remove: records.recordRemove,
    restore: records.recordRestore,
    // 批量保存（成绩单模式）：一个事务逐条过权限/校验/消课，一次落盘
    batch: records.recordBatchSave,
    // 结清本次课：发布当前课次未发布记录 + 课次 +1（一个事务，失败整体回滚）
    settle: records.sessionSettle
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
  },
  // 同步的数据层半边（网络编排在 utils/sync.js）：脏集合、推送快照、远端合并、游标
  sync: {
    COLLS: syncStore.COLLS,
    dirtyCols: syncStore.dirtyCols,
    markDirty: syncStore.markDirty,
    snapshot: syncStore.snapshot,
    applyRemote: syncStore.applyRemote,
    markAllDirty: syncStore.markAllDirty,
    clearDirty: syncStore.clearDirty,
    cursor: syncStore.cursor,
    setCursor: syncStore.setCursor,
    onDirty: syncStore.onDirty,
    // 云端拒绝的改动（学号重号、微信已绑给别人…）：推送成功后要读它才能如实上报，
    // 以前门面漏登记这三个，pushNow 一成功就抛 "db.sync.rejects is not a function"，
    // 脏集合永远清不掉 —— 表现是每次启动都把整个机构重推一遍。
    rejects: syncStore.rejects,
    addRejects: syncStore.addRejects,
    clearRejects: syncStore.clearRejects,
    // 机构号换代：只在服务端刚发号（minted）时用，别的地方调用等于把两个机构的数据搅在一起
    reorg: syncStore.reorg
  },
  // 设备级 meta 读写（仅同步层/身份层使用）
  patchMeta: core.updateRealMeta
};
module.exports = db;
