// utils/db/sync.js —— 同步的数据层半边（不碰网络，只负责"哪些要推、推完怎么并"）
//
// 【脏集合】任何落盘都经过 core.persist，这里挂一个写钩子把集合名记进 meta.sync.dirty。
// 持久化的原因：用户录完就杀进程，内存里的脏标记会丢，下次启动就不会推了 —— 数据只在
// 这一台手机上，等于"看起来存了，云端没有"。
//
// 【应用远端】applyRemote 用 LWW 合并（见 utils/syncmerge）。合并期间屏蔽写钩子：
// 否则"拉下来写本地"会被当成"本地改动"再推回去，形成来回打转的回声。
const core = require('./core');
const syncmerge = require('../syncmerge');
const entities = require('./entities');

// 参与同步的集合：来自注册表（users 与演示数据不在其中）
const COLLS = entities.SYNC_COLLS.slice();
let applying = false;

const syncMeta = () => (core.realMeta().sync || {});
const dirtyCols = () => (syncMeta().dirty || []).filter(c => COLLS.indexOf(c) > -1);

/* ---------------- 游标：一家一个 ----------------
 * pull 是「srvAt > since」的增量拉取，since 的含义是"我在**这一家**拉到哪儿了"。
 * 多家机构共用一个游标时，切到 B 家会拿着 A 家的进度去拉：比它早的 B 家数据
 * 永远不会被拉下来 —— 表现是"老师切过来只看到最近几条，之前录的全不见了"，
 * 而且两端都不报错，只有靠人回想才发现。所以必须按 orgId 分开记。
 */
const cursors = () => (syncMeta().cursors || {});
const curOrg = () => String(core.realMeta().orgId || '');
const cursor = forOrg => {
  const o = String(forOrg || curOrg());
  const map = cursors();
  if (o && map[o] !== undefined) return Number(map[o]) || 0;
  // 还没写过 cursors 的老数据：那个全局 cursor 属于"当时那家"，认它
  if (!Object.keys(map).length && o === curOrg()) return Number(syncMeta().cursor) || 0;
  // 其余一律从头拉：宁可多拉一遍（合并是幂等的），也不能拿别家的进度跳过自己的历史
  return 0;
};

// 脏标记订阅：同步引擎用它做"写后自动上推"的防抖调度
const dirtyListeners = [];
function onDirty(fn) { if (typeof fn === 'function') dirtyListeners.push(fn); }

function patchSync(patch) {
  const cur = syncMeta();
  core.updateRealMeta({ sync: Object.assign({}, cur, patch) });
}
function markDirty(name) {
  if (COLLS.indexOf(name) < 0) return;
  const d = dirtyCols();
  if (d.indexOf(name) > -1) return;
  d.push(name);
  patchSync({ dirty: d });
  dirtyListeners.forEach(fn => { try { fn(name); } catch (e) { /* 订阅方异常不拖垮写路径 */ } });
}
function clearDirty(names) {
  const left = dirtyCols().filter(c => (names || []).indexOf(c) < 0);
  patchSync({ dirty: left });
}
function setCursor(v, forOrg) {
  const o = String(forOrg || curOrg());
  const n = Number(v) || 0;
  if (!o) { patchSync({ cursor: n }); return; }
  // cursor 仍同步写一份：老版本读它、人工排查也看它，且 orgId 为空时是唯一来源
  const patch = { cursors: Object.assign({}, cursors(), { [o]: n }) };
  if (o === curOrg()) patch.cursor = n;
  patchSync(patch);
}

// 被云端拒绝的改动（学号重号、微信已绑给别人、机构不可删…）。
// 必须留在本机并且给人看见：拒绝意味着"服务端不同意"，本地看起来改成功了、
// 云端永远是旧值，而且下一次拉取不会替它纠正 —— 不告诉用户就是静默不一致。
const rejects = () => (syncMeta().rejects || []);
function addRejects(list) {
  if (!list || !list.length) return;
  const at = Date.now();
  const next = list.map(x => ({ at, c: String(x.c || ''), id: x.id, code: String(x.code || ''), msg: String(x.msg || '') }));
  patchSync({ rejects: next.concat(rejects()).slice(0, 20) });
}
function clearRejects() { patchSync({ rejects: [] }); }

/* ---------------- 冲突败者副本：LWW 的「不静默丢失」底线 ----------------
 * 两台设备同时改同一条记录，后推的赢 —— 这是选定的策略（见 syncmerge），
 * 但「输的那一版直接消失、没有任何痕迹」不行：老师 B 写了半小时的评语被
 * 老师 A 的版本盖掉时，得有一份能找回来的副本，而不是让他以为自己没保存。
 * 败者整份存进 meta.sync.conflicts（本地、不回推云端），上限 20 条、先进先出。
 */
const conflicts = () => (syncMeta().conflicts || []);
function addConflicts(list) {
  if (!list || !list.length) return;
  const at = Date.now();
  const next = list.map(x => ({ at, c: String(x.c || ''), id: x.id, loser: x.loser || null }));
  patchSync({ conflicts: next.concat(conflicts()).slice(0, 20) });
}
function clearConflicts() { patchSync({ conflicts: [] }); }
// 找回败者：以「现在」的时间戳写回，它会在下一轮推送里重新参战并胜出
function restoreConflict(i) {
  const all = conflicts();
  const one = all[Number(i)];
  if (!one || !one.loser) return { ok: false, msg: '副本不存在' };
  const d = JSON.parse(JSON.stringify(one.loser));
  d.updatedAt = Date.now();
  d.removed = false;
  const coll = core.coll(one.c) || [];
  const at = coll.findIndex(x => x && String(x.orgId) === String(d.orgId) && String(x.id) === String(d.id));
  if (at > -1) coll[at] = d; else coll.push(d);
  if (!core.setColl(one.c, coll)) return { ok: false, msg: '写入失败' };
  markDirty(one.c);
  return { ok: true };
}

/* ---------------- 我的可见范围变了：游标必须归零 ----------------
 * pull 的过滤条件现在按「我的角色与班级/孩子」计算（服务端收窄）。负责人给老师
 * 新分了班（成员表 clsIds 变化）、家长被绑了新孩子（studentIds 变化）时，
 * 新范围的历史数据 srvAt 早就过去、游标已越过 —— 不重置就永远拉不下来。
 * 这里在合并远端成员时检测「我的工牌范围变化」，记进 meta（杀进程也不丢），
 * 同步引擎（utils/sync.js）消费它：游标归零 + 再拉一轮。
 */
const scopeOf = m => (!m ? '' : [m.role, (m.clsIds || []).join(','), (m.studentIds || [])].join('|'));
const myOpenid = () => String(core.realMeta().openid || '');
const rescoped = () => (syncMeta().rescoped || []);
function addRescoped(org) {
  const o = String(org || '');
  if (!o) return;
  if (rescoped().indexOf(o) > -1) return;
  patchSync({ rescoped: rescoped().concat([o]) });
}
function clearRescoped(org) {
  const left = rescoped().filter(o => o !== String(org || ''));
  patchSync({ rescoped: left });
}
/* ---------------- 重置纪元（epoch）：这家机构的数据在云端被整体重置了 ----------------
 * resetOrg 之后云端的旧数据全部软删，但其他设备的本地副本还活着，而且
 * 会往下推（flush 只 push 不 pull）—— 没有统一作废信号的话，旧手机上的
 * 试用数据会无限期冒充真实数据。orgs 文档的 epoch 就是这个信号：
 *   · 第一次见到某家的 epoch → 只登记，不动数据（不能把新装设备误判成重置）
 *   · 之后发现 epoch 变了 → 本机这一家的数据全部清掉 + 游标归零重拉
 */
const epochs = () => (syncMeta().epochs || {});
function setEpoch(org, v) {
  patchSync({ epochs: Object.assign({}, epochs(), { [String(org)]: Number(v) || 0 }) });
}
// 清掉本机这一家机构的全部数据（orgs 是主键即机构号，按 id 匹配；其余按 orgId）。
// 这家的冲突败者副本与云端拒收记录一并过期：它们指向的数据已经不存在了。
function wipeOrg(org) {
  const o = String(org || '');
  if (!o) return;
  COLLS.forEach(name => {
    const all = core.coll(name) || [];
    const left = all.filter(d => !d
      || (name === 'orgs' ? String(d.id) !== o : String(d.orgId || '') !== o));
    if (left.length !== all.length) core.setColl(name, left);
  });
  patchSync({
    conflicts: conflicts().filter(x => !x.loser || String(x.loser.orgId || '') !== o),
    rejects: rejects().filter(x => !x || String(x.orgId || '') !== o)
  });
  setCursor(0, o);
}

// 首次上云：把当前机构的全部数据标脏，一次推完（幂等，重复标脏没有副作用）
function markAllDirty() { patchSync({ dirty: COLLS.slice() }); }

// core 的写钩子：任何一次成功落盘都会进来（事务提交、setColl、persist 都走 core.persist）
function onWrite(name) {
  if (applying) return;          // 拉取合并写入不算本地改动
  if (core.isSandbox()) return;  // 演示数据的写不参与同步
  markDirty(name);
}
core.setWriteHook(onWrite);

// 打包待推文档：[{c, d}]。只推当前机构的（core.orgColl 已按 orgId 过滤 + 去掉软删的），
// 软删的文档要单独补进来 —— 否则别处永远不知道"这条被删了"。
function snapshot(names) {
  const o = core.realMeta().orgId;
  const out = [];
  (names || dirtyCols()).forEach(name => {
    if (COLLS.indexOf(name) < 0) return;
    const all = core.coll(name) || [];
    all.forEach(d => {
      if (!d) return;
      if (name === 'orgs') {
        if (String(d.id) !== String(o)) return;         // 只推本机构那条
      } else if (String(d.orgId || o) !== String(o)) return; // 别的机构不推
      out.push({ c: name, d });
    });
  });
  return out;
}

// 应用远端增量：按集合分组 → LWW 合并 → 一次 setColl 落盘。
// 返回 { added, updated }，调用方只用于日志/提示，不影响主流程。
function applyRemote(items) {
  const byColl = {};
  (items || []).forEach(it => {
    const c = it && it.c;
    if (COLLS.indexOf(c) < 0 || !it.d) return;
    (byColl[c] || (byColl[c] = [])).push(it.d);
  });
  let added = 0, updated = 0;
  const names = Object.keys(byColl);
  if (!names.length) return { ok: true, added: 0, updated: 0, failed: [] };
  const failed = [];
  // 【合并前】留一份「我的工牌」快照：mergeList 是整条替换，合并后就找不到旧值了。
  // 元素本身不被就地修改，拿引用比较是安全的。
  const oid = myOpenid();
  const mineBefore = oid
    ? (core.coll('members') || []).filter(m => m && String(m.openid || '') === oid) : [];
  applying = true;
  try {
    names.forEach(c => {
      const res = syncmerge.mergeList(core.coll(c) || [], byColl[c]);
      added += res.added; updated += res.updated;
      // LWW 判负但内容真不同的：留一份败者副本（不静默丢失，见 addConflicts 注释）
      if (res.conflicts && res.conflicts.length) {
        addConflicts(res.conflicts.map(d => ({ c, id: d.id, loser: d })));
      }
      // 【落盘失败必须报出去】以前这里不看返回值：内存改了、磁盘没写进去，
      // 而调用方照样推进同步游标 —— 这批文档以后永远不会再被拉一次，
      // 表现就是"云端有、手机上没有"，重启后彻底消失。宁可这次同步报错重来。
      if ((res.added || res.updated) && !core.setColl(c, res.list)) failed.push(c);
    });
  } finally { applying = false; }
  // 我的工牌范围被远端改了（新分班 / 新绑孩子 / 换角色）：把这家机构记进 rescoped，
  // 同步引擎会把游标归零重拉 —— 不然新范围的历史数据永远拉不下来（游标已越过）。
  // 多机构：逐张工牌比对（每家一条），不止当前这家。
  if (oid) {
    (byColl.members || []).forEach(rd => {
      if (!rd || String(rd.openid || '') !== oid) return;
      const before = mineBefore.find(m => String(m.orgId || '') === String(rd.orgId || ''));
      if (before && scopeOf(before) !== scopeOf(rd)) addRescoped(rd.orgId);
    });
  }
  // 纪元检测：合并进来的 orgs 文档带着 epoch，与登记值不同 = 这家在云端被重置过
  // → 本机这一家全部作废（含刚合并的这批，重拉会重新拿到），rescoped 触发整轮重拉。
  (byColl.orgs || []).forEach(od => {
    if (!od || od.id === undefined) return;
    const key = String(od.id);
    const seen = epochs()[key];
    const cur = Number(od.epoch) || 0;
    if (seen === undefined) { setEpoch(key, cur); return; }
    if (Number(seen) !== cur) {
      wipeOrg(key);
      setEpoch(key, cur);
      addRescoped(key);
    }
  });
  return { ok: failed.length === 0, added, updated, failed };
}

// 机构号换代：把本机全部数据从出厂号挪到服务端刚发的机构号上。
//
// 【只在什么情况下用】服务端 hello 返回 minted=true —— 意味着"这台设备第一次上云，
// 云端还没有这个机构，刚给你发了一个新号"。这时云端那个号下一条数据都没有，
// 整体改挂不会跟任何人撞车，也不需要合并，所以可以放心一把全改。
// 其它情况（云端已经是别人的号）绝不能调它：那是把两个机构的数据揉在一起。
//
// 【为什么必须连本地一起改】读取走 core.orgColl，按 meta.orgId 过滤。
// 只改 meta 不改文档，等于本地数据瞬间"看不见"；只改文档不改 meta，push 又会全被跳过。
function reorg(to) {
  const id = String(to || '');
  if (!id) return { ok: false, msg: '缺少新机构号' };
  if (core.isSandbox()) return { ok: false, msg: '演示模式下不能改机构' };
  const d = core.data();
  let moved = 0;
  COLLS.forEach(name => {
    (d[name] || []).forEach(x => {
      if (!x) return;
      if (name === 'orgs') {
        // 机构表的主键就是机构号，id 和 orgId 必须一起改
        if (String(x.id) === id && String(x.orgId || '') === id) return;
        x.id = id; x.orgId = id; moved++;
      } else if (String(x.orgId || '') !== id) {
        x.orgId = id; moved++;
      }
    });
  });
  core.updateRealMeta({ orgId: id });
  // 每个集合都落一次盘：少写一个，下次启动那一类数据就回到出厂号、彻底看不见了
  COLLS.forEach(name => core.persist(name));
  markAllDirty();
  return { ok: true, orgId: id, moved };
}

module.exports = {
  COLLS, dirtyCols, markDirty, clearDirty, markAllDirty, snapshot, applyRemote,
  cursor, setCursor, onWrite, onDirty, reorg, rejects, addRejects, clearRejects,
  conflicts, addConflicts, clearConflicts, restoreConflict,
  rescoped, clearRescoped, epochs, setEpoch, wipeOrg
};
