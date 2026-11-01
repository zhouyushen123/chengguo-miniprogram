// utils/db/permissions.js —— 机构权限模型（纯函数，无副作用）
//
// 【为什么单独一个文件】权限规则必须只有一处定义。页面里写 if (role === 'parent') 的写法，
// 一旦漏写就是"该拦的没拦"，而且改规则要全项目搜。这里集中定义：谁能做什么、能看到什么。
//
// 【两层模型】
//   1. 角色（role）决定"能不能做这类事"：owner / admin / teacher / parent
//   2. 数据范围（scope）决定"能对哪些数据做"：班级 / 学生
//   两个都通过才算有权限。角色对了但数据不在范围内，一样拒绝。
//
// 【fail-closed 原则】没被显式授权的一律拒绝。老师没分配班级 = 看不到任何班级，
// 而不是"没限制所以全放行"——后者是权限系统里最危险的反模式（配漏一个参数就等于全开）。
//
// 【换云端怎么用】这里全是纯函数，不依赖存储。服务端拿到 token 里的 member 记录后，
// 用同样的文件做判定，前后端一套规则，不会出现"客户端拦了服务端没拦"。

const ROLES = ['owner', 'admin', 'teacher', 'parent'];

const ROLE_LABEL = {
  owner: '机构负责人',
  admin: '管理员',
  teacher: '老师',
  parent: '家长'
};

// 管理级角色：不受数据范围约束，机构内全可见
const FULL = ['owner', 'admin'];

// 动作 → 允许的角色 / 是否受数据范围限制 / 是否限本人数据
//   scoped: true  目标对象必须落在自己的可见范围内
//   own: true     只能操作自己录入的数据（负责人与管理员不受限）
const ACTIONS = {
  'org.manage':     { roles: ['owner', 'admin'] },
  'member.manage':  { roles: ['owner', 'admin'] },
  'class.write':    { roles: ['owner', 'admin'] },
  'course.write':   { roles: ['owner', 'admin'] },
  'student.write':  { roles: ['owner', 'admin', 'teacher'], scoped: true },
  'record.create':  { roles: ['owner', 'admin', 'teacher'], scoped: true },
  'record.update':  { roles: ['owner', 'admin', 'teacher'], scoped: true, own: true },
  'record.delete':  { roles: ['owner', 'admin', 'teacher'], scoped: true, own: true },
  'record.send':    { roles: ['owner', 'admin', 'teacher'], scoped: true },
  'template.write': { roles: ['owner', 'admin'] },
  'profile.write':  { roles: ['owner', 'admin', 'teacher', 'parent'], scoped: true }
};

const numList = v => (Array.isArray(v) ? v.map(Number).filter(n => isFinite(n)) : []);
const has = (list, x) => list.indexOf(Number(x)) > -1;

/* ---------------- 构造身份：把 member 记录 + 学生表算成可判定的 actor ----------------
 * all          管理级，机构内全可见
 * visClsIds    可见班级 id（老师=负责班级；家长=孩子所在班级）
 * visStuIds    可见学生 id（家长=绑定的孩子）
 * 家长额外带 readOnly，且其记录可见性还要叠加"已发送"这一条
 */
function actorOf(member, students) {
  const m = member || {};
  const role = ROLES.indexOf(m.role) > -1 ? m.role : 'parent';
  const base = {
    userId: m.userId || '',
    name: m.name || '',
    role,
    roleLabel: ROLE_LABEL[role] || '未知',
    memberId: m.id || 0,
    orgId: m.orgId || '',
    all: FULL.indexOf(role) > -1,
    readOnly: role === 'parent',
    clsIds: numList(m.clsIds),        // 直接负责的班级（老师）
    courseIds: numList(m.courseIds),
    studentIds: numList(m.studentIds),// 绑定的孩子（家长）
    visClsIds: [],
    visStuIds: []
  };

  if (base.all) return base;

  if (role === 'teacher') {
    base.visClsIds = base.clsIds.slice();
    return base;
  }

  // 家长：可见范围 = 绑定的孩子，以及孩子所在的班级（只用于显示班级名，不用于看别人）
  base.visStuIds = base.studentIds.slice();
  const pool = Array.isArray(students) ? students : [];
  const set = {};
  pool.forEach(s => {
    if (base.visStuIds.indexOf(s.id) > -1 && !s.removed) {
      numList(s.clsIds).forEach(c => { set[c] = 1; });
    }
  });
  base.visClsIds = Object.keys(set).map(Number);
  return base;
}

/* ---------------- 可见性判定 ---------------- */
function canSeeClass(actor, cid) {
  if (!actor || !cid) return false;
  if (actor.all) return true;
  return has(actor.visClsIds, cid);
}

function canSeeStudent(actor, student) {
  if (!actor || !student) return false;
  if (actor.all) return true;
  if (actor.role === 'parent') return has(actor.visStuIds, student.id);
  // 老师：学生只要在自己的某个班里就可见（学生可跨班）
  return numList(student.clsIds).some(c => has(actor.visClsIds, c));
}

// 记录可见性按「记录所属班级」判定，而不是按学生：
// 学生可能同时在两个班，老师只该看到自己带的那个班上的记录
function canSeeRecord(actor, record) {
  if (!actor || !record) return false;
  if (actor.all) return true;
  if (actor.role === 'parent') {
    // 家长只能看已发布的，未发送的草稿永远不可见
    return record.sent === true && has(actor.visStuIds, record.sid);
  }
  return has(actor.visClsIds, record.cid);
}

/* ---------------- 动作判定 ---------------- */
// target 视动作而定：{ clsId } / { student } / { record } / undefined
function can(actor, action, target) {
  if (!actor) return false;
  const rule = ACTIONS[action];
  if (!rule) return false;                                  // 未登记的动作一律拒绝
  if (rule.roles.indexOf(actor.role) < 0) return false;

  const t = target || {};

  // 限本人：老师只能改/删自己录的；负责人与管理员不受限
  // 【fail-closed】只有真正拿到目标对象时才检查归属：abilities() 用空 target 预判时不该被拦。
  // 一旦有目标，tid 为空就拒绝——旧写法 `if (tid && ...)` 会让无主记录对所有人放行，
  // 这正是"历史脏数据导致任何人都能改别人记录"的入口。
  if (rule.own && !actor.all) {
    const hasTarget = !!t.record || Object.prototype.hasOwnProperty.call(t, 'tid');
    if (hasTarget) {
      const tid = t.record ? t.record.tid : t.tid;
      if (!tid) return false;
      if (String(tid) !== String(actor.userId)) return false;
    }
  }

  // 限范围：目标必须在自己可见范围内
  if (rule.scoped) {
    if (t.record) return canSeeRecord(actor, t.record);
    if (t.student) return canSeeStudent(actor, t.student);
    if (t.clsId !== undefined && t.clsId !== null) return canSeeClass(actor, t.clsId);
    if (action === 'record.create' || action === 'student.write' || action === 'profile.write') {
      // 新建时还没目标，允许进入（具体落库时再按学生/班级校验）
      return actor.role !== 'parent' || action === 'profile.write';
    }
  }
  return true;
}

// 拒绝原因文案：直接给页面 toast 用，避免各处自己编
function denyReason(actor, action) {
  if (!actor) return '请先登录';
  const rule = ACTIONS[action];
  if (!rule) return '无权操作';
  if (rule.roles.indexOf(actor.role) < 0) {
    if (actor.role === 'parent') return '家长为只读身份';
    if (actor.role === 'teacher') return '该操作需要管理员权限';
    return '无权操作';
  }
  if (rule.own && !actor.all) return '只能修改自己录入的记录';
  return '该数据不在你的管理范围内';
}

/* ---------------- 对外：可操作清单（页面据此渲染按钮，前后端不会不一致） ---------------- */
function abilities(actor) {
  const out = {};
  Object.keys(ACTIONS).forEach(k => { out[k] = can(actor, k, {}); });
  if (actor && !actor.all) {
    // 受范围限制的动作在"无目标"时先视为可进入，真正拦截在具体目标上
    ['record.create', 'student.write'].forEach(k => {
      out[k] = ACTIONS[k].roles.indexOf(actor.role) > -1;
    });
    if (actor.readOnly) {
      Object.keys(out).forEach(k => { if (k !== 'profile.write') out[k] = false; });
    }
  }
  return out;
}

module.exports = {
  ROLES, ROLE_LABEL, FULL, ACTIONS,
  actorOf, can, canSeeClass, canSeeStudent, canSeeRecord, denyReason, abilities
};
