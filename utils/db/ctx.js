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
// 含"已删除"行的机构视图：oc() 会把 removed 的行藏起来（界面上就该藏），
// 但回收站、还原、体检都必须看得见它们，否则"能删能还原"只是句空话。
function ocAll(name) {
  const list = core.coll(name) || [];
  const o = org();
  if (name === 'orgs') return list.filter(x => String(x.id) === String(o));
  return list.filter(x => (x.orgId || o) === o);
}

/* =====================================================================
 * 身份与权限
 * ===================================================================*/
// 当前机构下、当前登录人的成员关系（权限的唯一来源）
//
// 【为什么不能只按 userId 找】userId 是本机生成的（新装一律叫 t1），换手机/重装后
// 它跟云端成员表里的 userId 毫无关系。曾经的真实风险：家长重装后本机 me='t1'，
// 恰好撞上负责人那条成员的 userId，于是家长拿到了负责人的权限。
// 所以只要知道自己的 openid，就以 openid 为准；只有"预览切换身份"时才临时听 me 的。
function memberCurrent() {
  const meta = core.meta();
  const list = oc('members').filter(x => x.status !== 'disabled');
  if (!list.length) return null;
  const me = meta.me;
  const byOid = meta.openid ? list.find(x => x.openid && x.openid === meta.openid) : null;
  if (byOid) {
    // 预览切换：从本人（byOid 这一条）切走去看别人——homeMe 记着"我本来是谁"
    if (me && me !== byOid.userId && meta.homeMe && meta.homeMe === byOid.userId) {
      const pv = list.find(x => x.userId === me);
      if (pv) return pv;
    }
    return byOid;
  }
  // 尚未上云（没有 openid）或成员还没认领：本机单成员场景照旧
  return list.find(x => x.userId === me) || (list.length === 1 ? list[0] : null);
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

// 打软删标记（所有删除都必须走这里，别自己写 removed = true）
// t 由调用方给：一次删除牵连多个集合时共用一个时间戳，回收站靠它认批。
function markRemoved(doc, t) {
  // 用成员关系取 id，不用 actor()：后者是给权限判定用的视图，不带成员 id
  const a = memberCurrent();
  doc.removed = true;
  doc.updatedAt = t;
  if (!doc.removedAt) doc.removedAt = t;      // 早就删过的保留原批次，不并进这一次
  if (!doc.removedBy) doc.removedBy = (a && a.id) || 0;
  return doc;
}

// 取消软删（回收站还原用）。removedAt 必须清 0，
// 否则下次被删时 carry 着旧值，又和别的批次串在一起。
function markAlive(doc, t) {
  doc.removed = false;
  doc.removedAt = 0;
  doc.removedBy = 0;
  doc.updatedAt = t;
  return doc;
}

module.exports = {
  now, org, oc, ocAll, memberCurrent, actor, deny, memberCurrentOfRole, pushSaved, applyEdit,
  markRemoved, markAlive
};
