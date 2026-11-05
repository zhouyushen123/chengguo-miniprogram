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

const COLLS = ['orgs', 'members', 'terms', 'classes', 'courses', 'students', 'enrollments', 'records', 'templates'];
let applying = false;

const syncMeta = () => (core.realMeta().sync || {});
const dirtyCols = () => (syncMeta().dirty || []).filter(c => COLLS.indexOf(c) > -1);
const cursor = () => Number(syncMeta().cursor) || 0;

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
function setCursor(v) { patchSync({ cursor: Number(v) || 0 }); }

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
  if (!names.length) return { added: 0, updated: 0 };
  applying = true;
  try {
    names.forEach(c => {
      const res = syncmerge.mergeList(core.coll(c) || [], byColl[c]);
      added += res.added; updated += res.updated;
      if (res.added || res.updated) core.setColl(c, res.list);
    });
  } finally { applying = false; }
  return { added, updated };
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
  cursor, setCursor, onWrite, onDirty, reorg, rejects, addRejects, clearRejects
};
