// utils/sync.js —— 同步引擎（网络编排层；数据层半边在 utils/db/sync.js）
//
// 目标：把老师手机上的记录搬到云端，让「换手机不丢、家长端可见、电脑后台可查」有地基。
// 协议：hello 绑定机构 → pull 拉增量（LWW 合并）→ push 推脏集合（分批，成功后清脏）。
//
// 【为什么先拉后推】两台设备同时改时，先拿到云端较新的版本，再推本地；服务器对更旧的写入
// 会直接跳过（syncv2 的 newer 计数），本地在下一轮 pull 就对齐了。反过来先推会把云端较新的
// 数据用旧值覆盖掉——那是真的丢数据。
//
// 【失败即放弃，绝不阻塞】没网、云函数没部署、额度用尽：全部静默降级为纯本地，下次再试。
// 脏标记持久化在 meta 里，杀进程后下次启动接着推。
const db = require('./db');
const api = require('./api');
const syncmerge = require('./syncmerge');

let ready = false;        // hello 已通过（机构已绑定）
let busy = false;         // 防并发：同一时间只跑一轮
let conflict = false;     // 本机有数据但云端绑定另一个机构 → 停手，别把两边搅在一起
let pendingOrg = '';      // 待采纳的云端机构 id（本机空库=换手机/重装）；拉回数据后才真正切过去
let minted = false;       // 本机数据刚被改挂到服务端新发的机构号上（首次上云）
let timer = null;
let lastRun = 0;
const MIN_GAP = 20000;    // 前台联动的最小间隔（onShow 频繁触发，别每次都全量拉）

const orgId = () => {
  const m = (db.real() && db.real().meta) || {};
  return String(m.orgId || '');
};
const isEmptyLocal = () => {
  const s = db.real() || {};
  return !(s.students || []).length && !(s.records || []).length;
};
// 同步目标的机构 id：恢复过程中先用云端 id 拉，拉成功才切本地 meta
const targetOrg = () => pendingOrg || orgId();

// 绑定机构。云端已有绑定时：
//   本机空库（换手机/重装）→ 采纳云端 orgId，随后全量拉回
//   本机有数据     → 判定为"两个机构撞在一起"，停手并留标记（人工处理，绝不合并）
function init() {
  if (!api.syncOn() || !orgId()) return Promise.resolve({ ok: false, skipped: true });
  if (ready) return Promise.resolve({ ok: true, orgId: orgId(), cached: true });
  // 【空库不上云】hello 会「首次调用即绑定」：新装家长刚一进小程序就把这个微信号
  // 绑到了本机那个空的出厂机构上，等他拿到邀请码想加入真正的机构时，服务端会说
  // 「该微信已加入其他机构」——从此再也进不来。所以空库先不绑，等真有数据
  // （老师走完开通向导、家长用邀请码加入）再绑。
  if (!db.sync.cursor() && isEmptyLocal()) {
    // 空库有两种人：还没开始用的新用户，和换了手机/重装的老用户。
    // 以前一律不绑（怕家长被绑到出厂机构上），代价是换手机永远恢复不回来。
    // 现在先只读地问一句云端：这个微信绑过机构吗？
    //   绑过 → 当作恢复：记下云端机构号，等 pull 真拉回数据再切过去（拉失败本机还是空的，不伤人）
    //   没绑 → 照旧什么都不做，等真有数据再 hello 发号
    return api.syncCall('whoami')
      .then(w => {
        if (!w || !w.ok || !w.orgId) return { ok: false, skipped: true, code: 'EMPTY' };
        pendingOrg = String(w.orgId);
        // 先把 openid 记下来：数据拉回来之后要靠它认出"我是成员表里的谁"，
        // 否则成员表查不到身份 → actor 为空 → 权限过滤把刚拉回来的数据全挡掉（看着像没恢复）。
        if (w.openid) db.patchMeta({ openid: String(w.openid) });
        ready = true;
        return { ok: true, orgId: pendingOrg, adopted: true, restore: true };
      })
      .catch(() => ({ ok: false, skipped: true, code: 'EMPTY' }));
  }
  return api.syncCall('hello', { orgId: orgId() })
    .then(r => {
      if (!r || !r.ok) return { ok: false, code: (r && r.code) || 'HELLO_FAIL', msg: r && r.msg };
      const cloudOrg = String(r.orgId);
      const adopted = cloudOrg !== orgId();
      // 服务端刚发号（minted）：云端还没有这个机构，本机数据全都还挂在出厂号上，
      // 整体改挂过去即可——这是"新机构第一次上云"的正常路径，不是冲突。
      if (r.minted && adopted) {
        const mv = db.sync.reorg ? db.sync.reorg(cloudOrg) : { ok: false, msg: '当前版本不支持机构号迁移' };
        if (!mv.ok) return { ok: false, code: 'REORG_FAIL', msg: mv.msg };
        minted = true;
      } else if (adopted) {
        if (!isEmptyLocal()) {
          // 本机有数据、云端绑的却是另一个机构：可能是换手机前后各建了一份。
          // 绝不自动合并（会把两家的学生揉在一起），停手并让用户看见（首页会提示）。
          conflict = true;
          return { ok: false, code: 'ORG_CONFLICT', msg: '这台手机的数据和云端绑定的是两个机构' };
        }
        // 换手机/重装：先记下云端 orgId，等 pull 真的拉回数据再切换（拉失败时本机仍可用）
        pendingOrg = cloudOrg;
      }
      ready = true;
      // 记住自己的云端账号标识，并把本机成员"认领"到这个账号上：
      // 认领之后，换手机/重装靠 openid 就能找回"我是谁"，不用信本机随机生成的 userId。
      // 改挂（minted）场景下成员表就是我们自己的，照常认领；只有"拉别人数据"的恢复场景才跳过。
      if (r.openid) claim(String(r.openid), adopted && !minted);
      // 从未同步过（游标 0）→ 现有本机数据全部标脏，首次把所有内容推上去
      if (!db.sync.cursor() && !adopted) db.sync.markAllDirty();
      return { ok: true, orgId: cloudOrg, adopted, minted, firstTime: !!r.firstTime };
    })
    .catch(() => ({ ok: false, code: 'CLOUD_OFF' }));
}

// 认领：把 openid 记在 meta（设备本地）并写到本机成员上（会随同步上云）。
// 恢复场景（adopted=true）先不认领——那时的成员表还是别人的，等 pull 回来再说。
function claim(openid, adopted) {
  const meta = db.real().meta || {};
  if (meta.openid !== openid) db.patchMeta({ openid });
  if (adopted) return;
  const res = db.members.claimOpenid ? db.members.claimOpenid(openid) : null;
  if (res && res.ok && !res.already) db.sync.markDirty('members');
}

// 拉增量：每轮每集合 100 条。轮次给足（20 轮 = 单集合 2000 条），
// 因为换手机 / 从备份恢复后的首次全量很容易超过原来的 5 轮上限，
// 拉不完就停会让"看起来同步了、其实少了几百条"这种最难查的问题出现。
const PULL_ROUNDS = 20;
function pullNow() {
  let round = 0, added = 0, updated = 0;
  const step = () => {
    if (round++ >= PULL_ROUNDS) return Promise.resolve({ added, updated, more: true });
    return api.syncCall('pull', { orgId: targetOrg(), since: db.sync.cursor() }).then(r => {
      if (!r || !r.ok) throw new Error((r && r.msg) || 'pull 失败');
      const st = db.sync.applyRemote(r.docs);
      added += st.added; updated += st.updated;
      const next = Math.max(syncmerge.cursorOf(r.docs, db.sync.cursor()), Number(r.cursor) || 0);
      if (next) db.sync.setCursor(next);
      return r.more ? step() : { added, updated, more: false };
    });
  };
  return step();
}

// 推脏集合：分批 50 条/包；全部成功才清脏（中途失败下次重来，不会漏推）
function pushNow() {
  const names = db.sync.dirtyCols();
  if (!names.length) return Promise.resolve({ pushed: 0, cols: 0 });
  const docs = db.sync.snapshot(names);
  if (!docs.length) { db.sync.clearDirty(names); return Promise.resolve({ pushed: 0, cols: 0 }); }
  let pushed = 0;
  return syncmerge.chunk(docs, 50)
    .reduce((acc, batch) => acc.then(() => api.syncCall('push', { orgId: orgId(), docs: batch }).then(r => {
      if (!r || !r.ok) throw new Error((r && r.msg) || 'push 失败');
      pushed += Number(r.accepted) || 0;
      // 云端拒了哪几条要原样记下来（服务端的硬约束在这里回传）
      if (r.rejected && r.rejected.length) db.sync.addRejects(r.rejected);
    })), Promise.resolve())
    .then(() => { db.sync.clearDirty(names); return { pushed, cols: names.length, rejected: db.sync.rejects().length }; });
}

// 一轮完整同步：先拉后推。失败静默（返回 ok:false 仅供日志）
function syncNow(opts) {
  const force = opts && opts.force;
  if (!api.syncOn() || conflict) return Promise.resolve({ ok: false, skipped: true });
  if (busy) return Promise.resolve({ ok: false, busy: true });
  if (!force && Date.now() - lastRun < MIN_GAP) return Promise.resolve({ ok: false, throttled: true });
  busy = true;
  lastRun = Date.now();
  return init()
    .then(r => {
      if (!r.ok) { busy = false; return { ok: false, code: r.code }; }
      return pullNow()
        .then(p => {
          // 恢复完成：pull 成功即切换（本机原本是空库，切换不会丢东西）
          if (pendingOrg) {
            db.patchMeta({ orgId: pendingOrg });
            pendingOrg = '';
          }
          // 恢复完成后补一次认领：成员表已经是自己的了，此时把 openid 固化到成员上才安全
          const oid = (db.real().meta || {}).openid;
          if (oid) claim(oid, false);
          return pushNow().then(u => ({ ok: true, pulled: p.added + p.updated, pushed: u.pushed }));
        })
        .catch(e => ({ ok: false, code: 'SYNC_FAIL', msg: (e && e.message) || '' }))
        .then(out => { busy = false; return out; });
    })
    .catch(e => { busy = false; return { ok: false, code: 'SYNC_FAIL', msg: (e && e.message) || '' }; });
}

/* ---------------- 邀请码加入机构 ----------------
 * 家长/老师拿到机构码后走这里：云端建绑定 + 建成员关系 → 本机改挂到该机构 → 全量拉回。
 * 【前置条件】本机必须是空的。有数据还强行加入，等于把一个机构的记录塞进另一个机构的 id 空间，
 * 冲突起来没法收场。所以宁可拒绝并提示先清空，也不做「合并」这种看起来聪明的事。
 */
function join(code, name, stuNo) {
  if (!api.syncOn()) return Promise.resolve({ ok: false, code: 'CLOUD_OFF', msg: '网络未就绪，请稍后重试' });
  if (!isEmptyLocal()) {
    return Promise.resolve({ ok: false, code: 'LOCAL_DATA', msg: '本机已有数据，请先在「存储空间」里清空后再加入' });
  }
  return api.inviteJoin({ code, name, stuNo })
    .then(r => {
      if (!r || !r.ok) return r || { ok: false, msg: '加入失败' };
      const m = r.member || {};
      db.patchMeta({ orgId: String(r.orgId), me: String(m.userId || ''), openid: String(m.openid || '') });
      // 换机构：游标归零，从头拉一遍；本地那份空库不需要推
      db.sync.setCursor(0);
      db.sync.clearDirty(db.sync.COLLS);
      ready = true;
      return pullNow().then(p => ({ ok: true, orgId: String(r.orgId), member: m, pulled: p.added + p.updated }));
    })
    .catch(e => ({ ok: false, msg: (e && e.message) || '加入失败' }));
}

// 写后自动上推：本地一次保存常常连续写几个集合，防抖合并成一轮
function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    syncNow({ force: true });
  }, 1500);
}

// 前台唤醒入口：节流 + 失败静默（页面不需要知道同步细节）
function kick() {
  if (!api.syncOn()) return;
  syncNow().catch(() => {});
}

db.sync.onDirty(schedule);

// 版本历史：看一条核心资产改过什么（只读）
function history(c, id) {
  if (!api.syncOn()) return Promise.resolve({ ok: false, code: 'OFFLINE', msg: '没联网' });
  return api.syncCall('history', { orgId: orgId(), c, id })
    .catch(() => ({ ok: false, code: 'NET', msg: '网络不通，请重试' }));
}
// 退回某一版（回滚本身也是一次改动，会同步到所有设备）
function revert(c, id, at) {
  if (!api.syncOn()) return Promise.resolve({ ok: false, code: 'OFFLINE', msg: '没联网' });
  return api.syncCall('revert', { orgId: orgId(), c, id, at })
    .catch(() => ({ ok: false, code: 'NET', msg: '网络不通，请重试' }));
}

module.exports = {
  init, pullNow, pushNow, syncNow, kick, schedule, join, claim, history, revert,
  isReady: () => ready, isConflict: () => conflict
};
