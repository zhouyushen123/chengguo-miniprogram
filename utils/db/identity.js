// utils/db/identity.js —— 成员与账号（「人」在本机构的角色与范围）
//
// user 是跨机构的账号本身，member 是这个账号在本机构的角色/数据范围，两者本质是一体两面，
// 且互相引用（建成员要查账号、改账号要落到成员），所以放在同一个模块里，避免 require 互相循环。
// 依赖：ctx（底座）、org（机构名）、classes（成员视图里的班级名）、students（成员视图里的孩子名）。
const { now, org, oc, actor, deny, memberCurrent, pushSaved, applyEdit } = require('./ctx');
const core = require('./core');
const schema = require('./schema');
const perms = require('./permissions');
const orgs = require('./org');
const classes = require('./classes');
const students = require('./students');

/* =====================================================================
 * 成员（机构 × 人 × 角色 × 数据范围）
 * ===================================================================*/
function memberList() {
  return oc('members').slice();
}
// 成员的可读视图：补上人员姓名与范围文字（页面直接用，不必再各处拼）
function memberView(m) {
  const cls = m.clsIds.map(id => classes.className(id)).filter(Boolean);
  const kids = m.studentIds.map(id => (students.studentRaw(id) || {}).name).filter(Boolean);
  return {
    id: m.id, userId: m.userId, name: m.name,
    role: m.role, roleLabel: perms.ROLE_LABEL[m.role] || m.role,
    status: m.status,
    clsIds: m.clsIds.slice(), courseIds: m.courseIds.slice(), studentIds: m.studentIds.slice(),
    clsText: cls.join('、'),
    kidText: kids.join('、'),
    full: perms.FULL.indexOf(m.role) > -1
  };
}
function memberGet(id) {
  return oc('members').find(m => m.id === Number(id)) || null;
}
function memberOfUser(userId) {
  return oc('members').find(m => m.userId === String(userId)) || null;
}

function memberCreate(data) {
  const err = deny('member.manage');
  if (err) return { ok: false, msg: err };
  const d = data || {};
  // 一个机构只能有一个负责人：多个人都拿 owner 会让"谁最大"失去意义
  if (d.role === 'owner' && oc('members').some(m => m.role === 'owner')) {
    return { ok: false, msg: '该机构已有负责人，请用「移交负责人」转移' };
  }
  // 建人 + 建成员关系是同一件事：用事务包起来，避免"人建好了、成员关系没建成"的孤儿账号
  return core.tx(() => {
    // 有 id 视为给已存在的人员补一条成员关系，没有则先建人
    let userId = schema.str(d.userId).trim();
    if (!userId) {
      const u = schema.normalizeUser({ id: 'u' + now(), name: d.name, role: d.role }, org(), now());
      const eu = schema.validate('user', u);
      if (eu) return { ok: false, msg: eu };
      if (!pushSaved('users', u)) return { ok: false, msg: core.SAVE_FAIL };
      userId = u.id;
    } else {
      const exist = userGet(userId);
      if (!exist) return { ok: false, msg: '人员不存在' };
      if (exist.name !== schema.str(d.name).trim() && d.name) {
        if (!applyEdit('users', exist, { name: schema.str(d.name).trim(), updatedAt: now() })) {
          return { ok: false, msg: core.SAVE_FAIL };
        }
      }
      if (memberOfUser(userId)) return { ok: false, msg: '该人员已在本机构中' };
    }

    const e = schema.normalizeMember({
      id: core.nextId(), orgId: org(), userId,
      role: d.role, name: d.name,
      clsIds: d.clsIds, courseIds: d.courseIds, studentIds: d.studentIds,
      status: d.status
    }, org(), now());
    const ev = schema.validate('member', e);
    if (ev) return { ok: false, msg: ev };
    if (!pushSaved('members', e)) return { ok: false, msg: core.SAVE_FAIL };
    return { ok: true, item: memberView(e), raw: e };
  });
}

function memberUpdate(id, patch) {
  const err = deny('member.manage');
  if (err) return { ok: false, msg: err };
  const m = memberGet(id);
  if (!m) return { ok: false, msg: '成员不存在' };
  const p = patch || {};
  // 机构负责人只能有一个：转移负责人要显式走 ownerTransfer，避免把自己锁在外面
  if (p.role === 'owner' && m.role !== 'owner') return { ok: false, msg: '请用「移交负责人」操作' };
  const next = schema.normalizeMember(Object.assign({}, m, p), org(), now());
  const ev = schema.validate('member', next);
  if (ev) return { ok: false, msg: ev };
  next.id = m.id; next.updatedAt = now();
  // 改成员往往连带改账号姓名，两张表要么一起成、要么一起回滚
  return core.tx(() => {
    if (!applyEdit('members', m, next)) return { ok: false, msg: core.SAVE_FAIL };
    if (p.name) {
      const u = userGet(m.userId);
      if (u && !applyEdit('users', u, { name: p.name, updatedAt: now() })) {
        return { ok: false, msg: core.SAVE_FAIL };
      }
    }
    return { ok: true, item: memberView(m) };
  });
}

function memberRemove(id) {
  const err = deny('member.manage');
  if (err) return { ok: false, msg: err };
  const m = memberGet(id);
  if (!m) return { ok: false, msg: '成员不存在' };
  if (m.role === 'owner') return { ok: false, msg: '不能移除机构负责人' };
  if (!applyEdit('members', m, { removed: true, updatedAt: now() })) return { ok: false, msg: core.SAVE_FAIL };
  return { ok: true };
}

/* =====================================================================
 * 人员（跨机构的账号本身；权限看 member）
 * ===================================================================*/
function userList() { return oc('users').slice(); }
function userGet(id) { return oc('users').find(u => u.id === String(id)) || null; }
function userName(id) { const u = userGet(id); return u ? u.name : ''; }

// 当前登录人的"合成身份"：user 的姓名 + member 的角色与范围
// 页面沿用 u.role / u.clsIds / u.studentIds，不必知道底层已拆成两张表
function userCurrent() {
  const m = memberCurrent();
  const u = m ? userGet(m.userId) : null;
  const base = u || userList()[0] || null;
  if (!base) return null;
  return {
    id: base.id, name: base.name,
    role: (m && m.role) || base.role || 'parent',
    clsIds: m ? m.clsIds.slice() : [],
    courseIds: m ? m.courseIds.slice() : [],
    studentIds: m ? m.studentIds.slice() : [],
    memberId: m ? m.id : 0,
    orgId: org(),
    status: m ? m.status : 'invited'
  };
}

// 切换身份：只切"人"，角色与范围由该人在本机构的成员关系决定
function userSwitch(id) {
  const u = userGet(id);
  if (!u) return { ok: false, msg: '人员不存在' };
  const m = memberOfUser(u.id);
  const meta = core.meta();
  const patch = { me: String(id), role: (m && m.role) || u.role };
  // 记住"我本来是谁"。没有这条，预览家长端后会因为看不到成员列表而切不回来
  if (!meta.homeMe) patch.homeMe = meta.me || String(id);
  core.updateMeta(patch);
  return { ok: true, item: userCurrent() };
}
// 回到本人的真实身份
function userSwitchHome() {
  const h = core.meta().homeMe;
  if (!h) return { ok: false, msg: '没有可返回的身份' };
  return userSwitch(h);
}

// 兼容旧调用：等价于"建人 + 建成员关系"
function userCreate(data) {
  return memberCreate(data);
}
function userUpdate(id, patch) {
  const m = memberOfUser(id);
  if (!m) {
    const u = userGet(id);
    if (!u) return { ok: false, msg: '人员不存在' };
    return { ok: false, msg: '该人员不属于当前机构' };
  }
  return memberUpdate(m.id, patch);
}
function userRemove(id) {
  const m = memberOfUser(id);
  if (!m) return { ok: false, msg: '该人员不属于当前机构' };
  return memberRemove(m.id);
}

/* =====================================================================
 * 设置（页面读的汇总视角）
 * ===================================================================*/
function settings() {
  const m = core.meta();
  const o = orgs.orgCurrent();
  const a = actor();
  return {
    orgId: m.orgId,
    orgName: (o && o.name) || m.orgName || '我的机构',
    teacher: m.teacher || '',
    me: m.me || '',
    homeMe: m.homeMe || m.me || '',
    canSwitchHome: !!(m.homeMe && m.homeMe !== m.me),
    role: (a && a.role) || '',
    roleLabel: (a && a.roleLabel) || '',
    memberId: (a && a.memberId) || 0,
    // 当前是不是在看演示数据（演示包是独立的一套数据，只能看不能改）
    sandbox: core.isSandbox(),
    version: m.version
  };
}
// 机构名与"我的名字"都落在机构/成员上，不再塞进 meta.teacher 这一个裸字段
function setTeacher(name) {
  const v = schema.str(name).trim();
  const a = actor();
  if (a && a.memberId) {
    const m = memberGet(a.memberId);
    if (m) {
      core.tx(() => {
        if (!applyEdit('members', m, { name: v, updatedAt: now() })) return { ok: false, msg: core.SAVE_FAIL };
        const u = userGet(m.userId);
        if (u && !applyEdit('users', u, { name: v, updatedAt: now() })) return { ok: false, msg: core.SAVE_FAIL };
        return { ok: true };
      });
    }
  }
  core.updateMeta({ teacher: v });
  return settings();
}
function me() { return core.meta().me; }
function isParent() { const a = actor(); return !!a && a.role === 'parent'; }

module.exports = {
  memberList, memberView, memberGet, memberOfUser,
  memberCreate, memberUpdate, memberRemove,
  userList, userGet, userName, userCurrent, userSwitch, userSwitchHome,
  userCreate, userUpdate, userRemove,
  settings, setTeacher, me, isParent
};
