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
  return api.syncCall('hello', { orgId: orgId() })
    .then(r => {
      if (!r || !r.ok) return { ok: false, code: (r && r.code) || 'HELLO_FAIL', msg: r && r.msg };
      const adopted = String(r.orgId) !== orgId();
      if (adopted) {
        if (!isEmptyLocal()) { conflict = true; return { ok: false, code: 'ORG_CONFLICT' }; }
        // 换手机/重装：先记下云端 orgId，等 pull 真的拉回数据再切换（拉失败时本机仍可用）
        pendingOrg = String(r.orgId);
      }
      ready = true;
      // 从未同步过（游标 0）→ 现有本机数据全部标脏，首次把所有内容推上去
      if (!db.sync.cursor() && !adopted) db.sync.markAllDirty();
      return { ok: true, orgId: String(r.orgId), adopted, firstTime: !!r.firstTime };
    })
    .catch(() => ({ ok: false, code: 'CLOUD_OFF' }));
}

// 拉增量：最多 5 轮（每轮每集合 100 条），游标只增不减
function pullNow() {
  let round = 0, added = 0, updated = 0;
  const step = () => {
    if (round++ >= 5) return Promise.resolve({ added, updated, more: true });
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
    })), Promise.resolve())
    .then(() => { db.sync.clearDirty(names); return { pushed, cols: names.length }; });
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
          return pushNow().then(u => ({ ok: true, pulled: p.added + p.updated, pushed: u.pushed }));
        })
        .catch(e => ({ ok: false, code: 'SYNC_FAIL', msg: (e && e.message) || '' }))
        .then(out => { busy = false; return out; });
    })
    .catch(e => { busy = false; return { ok: false, code: 'SYNC_FAIL', msg: (e && e.message) || '' }; });
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

module.exports = { init, pullNow, pushNow, syncNow, kick, schedule, isReady: () => ready, isConflict: () => conflict };
