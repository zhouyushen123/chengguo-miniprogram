// utils/db/ctx.js —— 数据访问层的公共底座
//
// 只放「所有领域都要用、且不依赖任何领域」的东西：时间、机构、集合视图、身份判定、写闸门。
// 【依赖方向】ctx ← 各领域模块 ← index.js（门面）。ctx 绝不 require 任何领域模块，
// 这是整个 db 目录不出现 require 循环的根本保证。新增领域模块时请遵守这条单向下行规则。
const schema = require('./schema');
const core = require('./core');
const perms = require('./permissions');

const now = () => Date.now();
const org = () => (core.meta().orgId || schema.DEFAULT_ORG);

// 读路径统一入口：当前机构视图。所有列表/查找都必须走这里，绝不能直接读全量集合，
// 否则其他机构的数据会混进来（曾经的真实 bug：org2 的班级出现在 org1 的列表里）。
const oc = name => core.orgColl(name);

/* =====================================================================
 * 身份与权限
 * ===================================================================*/
// 当前机构下、当前登录人的成员关系（权限的唯一来源）
function memberCurrent() {
  const m = core.meta().me;
  const list = oc('members').filter(x => x.status !== 'disabled');
  return list.find(x => x.userId === m) || list[0] || null;
}

// 把成员关系 + 学生表算成可判定的身份对象（每次实时计算，避免写操作后失效）
function actor() {
  const m = memberCurrent();
  if (!m) return null;
  const u = oc('users').find(x => x.id === m.userId);
  return perms.actorOf({
    id: m.id, orgId: m.orgId, userId: m.userId,
    role: m.role,
    name: (u && u.name) || m.name,
    clsIds: m.clsIds, courseIds: m.courseIds, studentIds: m.studentIds
  }, oc('students'));
}

// 写操作统一闸门：返回 null 表示放行，否则返回可直接 toast 的文案
// 【演示模式】全部写操作在这里一次性拦掉。演示数据是"样板间"：能点能看能翻，
// 但不能改——否则老师会以为自己录的东西存下来了，而它在退出演示时就没了。
function deny(action, target) {
  if (core.isSandbox()) return '演示数据只读，点「开始使用」后再录入';
  const a = actor();
  if (perms.can(a, action, target)) return null;
  return perms.denyReason(a, action);
}

// 按角色找本机构成员（演示数据播种用；无成员时返回 null）
function memberCurrentOfRole(role) {
  return oc('members').find(m => m.role === role) || null;
}

/* =====================================================================
 * 写后落盘的两个小工具
 * ---------------------------------------------------------------------
 * 【为什么必须检查 persist 的返回值】本地存储会失败（单 key 超 1MB、总量超 10MB）。
 * 失败时内存里已经改好了，如果不撤回，界面会显示这条数据、用户以为存好了，
 * 重启后它凭空消失——比当场报错难查得多。所以：写内存 → 立刻落盘 → 失败就还原。
 * ===================================================================*/

// 新增一条：push + 落盘，失败自动撤回。返回 false 时调用方返回 core.SAVE_FAIL
function pushSaved(name, item) {
  const arr = core.coll(name);
  arr.push(item);
  if (core.persist(name)) return true;
  const i = arr.indexOf(item);
  if (i > -1) arr.splice(i, 1);
  return false;
}

// 更新一条：把 next 合并进 obj + 落盘，失败用改动前的浅拷贝还原。
// 注意 next 里的数组/对象必须是新构造的（normalize* 已经保证），否则还原不回来。
function applyEdit(name, obj, next) {
  const backup = Object.assign({}, obj);
  Object.assign(obj, next);
  if (core.persist(name)) return true;
  Object.assign(obj, backup);
  return false;
}

module.exports = {
  now, org, oc, memberCurrent, actor, deny, memberCurrentOfRole, pushSaved, applyEdit
};
