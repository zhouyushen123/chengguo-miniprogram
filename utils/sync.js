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
const schema = require('./db/schema');

let ready = false;        // hello 已通过（机构已绑定）
let busy = false;         // 防并发：同一时间只跑一轮
let conflict = false;     // 本机有数据但云端绑定另一个机构 → 停手，别把两边搅在一起
let pendingOrg = '';      // 待采纳的云端机构 id（本机空库=换手机/重装）；拉回数据后才真正切过去
let minted = false;       // 本机数据刚被改挂到服务端新发的机构号上（首次上云）
let switching = false;    // 正在换机构：此时不能把"游标 0"当成"首次上云"去全量重推
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
// 这个微信号是不是"已经在云端有身份"（可以再加一家机构了）。
// 【不能只看 orgId 非空】新装设备的 meta.orgId 常常还是出厂号 org1 —— 那只是本机骨架的归属，
// 云端一条数据都没有。把出厂号当成"已绑定"，会让第一次加入的人走成"追加"，两份数据从此混在一个界面里。
const bound = () => {
  const o = orgId();
  if (o && !schema.isFactoryOrg(o)) return true;
  return !!((db.real() && db.real().meta) || {}).openid;
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
      // 从未同步过（游标 0）→ 现有本机数据全部标脏，首次把所有内容推上去。
      // 【切机构时不做】新换的那家游标天然是 0，但本机在这家的数据可能只是上次拉下来的副本，
      // 全量重推一遍既慢又容易把本机旧值盖到云端（虽然有 updatedAt 兜着，但没必要赌）。
      if (!db.sync.cursor() && !adopted && !switching) db.sync.markAllDirty();
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
// only：指定拉哪一家（新增第二家机构时用）。不传就是"当前机构"。
function pullNow(only) {
  const useOrg = String(only || targetOrg());
  let round = 0, added = 0, updated = 0;
  const step = () => {
    if (round++ >= PULL_ROUNDS) return Promise.resolve({ added, updated, more: true });
    return api.syncCall('pull', { orgId: useOrg, since: db.sync.cursor(useOrg) }).then(r => {
      if (!r || !r.ok) throw new Error((r && r.msg) || 'pull 失败');
      const st = db.sync.applyRemote(r.docs);
      // 有集合没写进磁盘时不能推进游标：推了这批文档就再也不会被拉下来，
      // 变成"云端有、本机没有"。留在这里报错，下次同步从同一游标重拉（合并是幂等的）。
      if (!st.ok) throw new Error('本地存储空间不足，' + st.failed.length + ' 个集合没能写入，稍后自动重试');
      added += st.added; updated += st.updated;
      const next = Math.max(syncmerge.cursorOf(r.docs, db.sync.cursor(useOrg)), Number(r.cursor) || 0);
      if (next) db.sync.setCursor(next, useOrg);
      return r.more ? step() : { added, updated, more: false };
    });
  };
  return step();
}

/* ---------------- 自动上推：四条路，一条都不能少 ----------------
 * 用户的期望只有一句：录完就该在云端，不要我手动点。
 *   ① 落盘成功 → 1.5 秒后自动推          （schedule）
 *   ② 推失败   → 30s / 60s / 120s 退避重试（retryLater；以前这个函数写了却没人调用，
 *                 等于失败后只能等下一次打开小程序 —— 老师录完就锁屏的话，云端能空一整天）
 *   ③ 回前台 / 切后台 → 立刻补推          （app.js 的 onShow / onHide → kick / flush）
 *   ④ 断网恢复 → 立刻补推                 （app.js 的 wx.onNetworkStatusChange → flush）
 * ①② 在这里，③④ 依赖 app.js 的钩子；缺 ② 就是"看起来会同步，其实要人点"。
 */

// 只推不拉：联网恢复 / 切后台这类"顺手补一刀"的场景，拉一轮没意义还可能很慢。
// 不节流、不看 MIN_GAP：脏数据在那儿堆着，越快推上去越好。
function flush() {
  if (!api.syncOn() || conflict) return Promise.resolve({ ok: false, code: 'SYNC_OFF' });
  if (busy) return Promise.resolve({ ok: false, busy: true });
  if (!db.sync.dirtyCols().length) return Promise.resolve({ ok: true, pushed: 0, nothing: true });
  busy = true;
  lastRun = Date.now();
  return init()
    .then(r => {
      if (!r || !r.ok) { busy = false; return { ok: false, code: (r && r.code) || 'INIT_FAIL' }; }
      return pushNow()
        .then(u => { busy = false; retryCount = 0; return { ok: true, pushed: u.pushed, cols: u.cols }; })
        .catch(e => { busy = false; retryLater(); return { ok: false, code: 'PUSH_FAIL', msg: (e && e.message) || '' }; });
    })
    .catch(e => { busy = false; retryLater(); return { ok: false, code: 'SYNC_FAIL', msg: (e && e.message) || '' }; });
}

// 还有多少条没上云。首页用它给一句实话（"还有 3 条没传上去，联网后自动补传"），
// 而不是等用户自己发现"云端怎么是空的"——那种沉默的丢失最难查。
function pending() {
  try {
    const cols = db.sync.dirtyCols();
    if (!cols.length) return 0;
    return db.sync.snapshot(cols).length;
  } catch (e) { return 0; }
}

// 被云端退回、重试也不会自己好（学号重复、成员越权这类）的条数。
// 它和"待上传"不是一回事：待上传会自己传上去，退回得人去改 —— 所以首页分开说，
// 别让用户以为"等一下就好了"，等一年也上不去。
function rejectedCount() {
  try { return (db.sync.rejects() || []).length; } catch (e) { return 0; }
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
      // denied 是服务端直接丢掉的条数（权限不足/成员不是自己）。它连 rejected 都不进，
      // 客户端要是当成功，那几条就永远只活在手机里 —— 记下来，别让沉默替人做决定。
      if (Number(r.denied) > 0) {
        db.sync.addRejects([{ c: '', id: '', code: 'DENIED', msg: '有 ' + r.denied + ' 条被云端丢弃（权限不足）' }]);
      }
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
            // 切机构号后，登录前用出厂号建的骨架（内置学期/模板/学科）要收编过来：
            // 不然它们被机构过滤挡住——学期页空、模板页空、体检报"混入其它机构的数据"
            db.adoptFactoryRows(pendingOrg);
            pendingOrg = '';
          }
          // 恢复完成后补一次认领：成员表已经是自己的了，此时把 openid 固化到成员上才安全
          const oid = (db.real().meta || {}).openid;
          if (oid) claim(oid, false);
          return pushNow().then(u => ({ ok: true, pulled: p.added + p.updated, pushed: u.pushed }));
        })
        .catch(e => ({ ok: false, code: 'SYNC_FAIL', msg: (e && e.message) || '' }))
        .then(out => {
          busy = false;
          // 【失败必须有人接着试】以前这里只是返回失败，重试要等下一次前台。
          // 老师录完就锁屏、一整天不打开小程序时，云端会一直是空的，而且两端都不报错。
          if (out && out.ok) retryCount = 0;
          else if (db.sync.dirtyCols().length) retryLater();
          return out;
        });
    })
    .catch(e => { busy = false; return { ok: false, code: 'SYNC_FAIL', msg: (e && e.message) || '' }; });
}

/* ---------------- 邀请码加入机构 ----------------
 * 家长/老师拿到机构码后走这里：云端建绑定 + 建成员关系 → 本机改挂到该机构 → 全量拉回。
 * 【前置条件】本机必须是空的。有数据还强行加入，等于把一个机构的记录塞进另一个机构的 id 空间，
 * 冲突起来没法收场。所以宁可拒绝并提示先清空，也不做「合并」这种看起来聪明的事。
 */
function adopt(r) {
  const m = r.member || {};
  db.patchMeta({ orgId: String(r.orgId), me: String(m.userId || ''), openid: String(m.openid || '') });
  // 同上：骨架行跟着换机构号，否则内置学期/模板在本机构里永远看不见
  db.adoptFactoryRows(String(r.orgId));
  // 换机构：游标归零，从头拉一遍；本地那份空库不需要推
  db.sync.setCursor(0);
  db.sync.clearDirty(db.sync.COLLS);
  ready = true;
  return pullNow().then(p => ({
    ok: true, orgId: String(r.orgId), member: m, sid: Number(r.sid) || 0,
    pulled: p.added + p.updated
  }));
}

function join(code, name, stuNo) {
  if (!api.syncOn()) return Promise.resolve({ ok: false, code: 'CLOUD_OFF', msg: '网络未就绪，请稍后重试' });
  // 已经有云端身份 → 这次是「再加一家」，不是首次加入。
  // 两条路的差别只在"加完切不切过去"，云端建绑定/建成员完全一样。
  if (bound()) return joinMore(code, name, stuNo);
  if (!isEmptyLocal()) {
    return Promise.resolve({ ok: false, code: 'LOCAL_DATA', msg: '本机已有数据，请先在「存储空间」里清空后再加入' });
  }
  return api.inviteJoin({ code, name, stuNo })
    .then(r => (!r || !r.ok) ? (r || { ok: false, msg: '加入失败' }) : adopt(r))
    .catch(e => ({ ok: false, msg: (e && e.message) || '加入失败' }));
}

/* ---------------- 家长点卡确认 ----------------
 * 与 join 共用 adopt：云端 cardClaim 已经把绑定和成员关系建好了，
 * 这里只负责把本机改挂过去并全量拉回，绝不再打一次 inviteJoin（那会重复建成员）。
 */
function joinByCard(token, name, merge) {
  if (!api.syncOn()) return Promise.resolve({ ok: false, code: 'CLOUD_OFF', msg: '网络未就绪，请稍后重试' });
  // 已经有云端身份 → 认第二张卡是"再加一家"，不是"首次加入"（家长可能两家都报了课）。
  // 【加完不切走】家长的心智里只有"我的孩子"，不该被要求记住自己在哪家机构；
  // 成员关系已经落到云端，家长端的跨机构视图会把这一家的成果一并显示出来。
  if (bound()) {
    return api.cardClaim(token, name, merge)
      .then(r => {
        if (!r || !r.ok) return r || { ok: false, msg: '确认失败' };
        const target = String(r.orgId || '');
        if (!target || target === orgId()) return Object.assign({}, r, { already: true });
        return pullNow(target).then(p => Object.assign({}, r, { orgId: target, pulled: p.added + p.updated, added: true }));
      })
      .catch(e => ({ ok: false, msg: (e && e.message) || '确认失败' }));
  }
  if (!isEmptyLocal()) {
    return Promise.resolve({ ok: false, code: 'LOCAL_DATA', msg: '本机已有数据，请先在「存储空间」里清空后再加入' });
  }
  return api.cardClaim(token, name, merge)
    .then(r => (!r || !r.ok) ? (r || { ok: false, msg: '确认失败' }) : adopt(r))
    .catch(e => ({ ok: false, msg: (e && e.message) || '确认失败' }));
}

/* ---------------- 多机构：清单 / 切换 / 再加一家 ----------------
 * 一个微信可以有多张机构工牌（老师同时在两家上课、负责人在两家管事）。
 *
 * 【切换只换指针，不搬数据】本机是一个全量库：所有机构的数据都在这台手机的存储里，
 * 读的时候按 meta.orgId 过滤（core.orgColl），写的时候也只认当前这家。
 * 所以切换一条都不删，切回来还是原样；云端那边依旧按 orgId 物理隔离，
 * 不存在"平台集中存了一份合并名单"这回事。
 */
function orgList() {
  if (!api.syncOn()) return Promise.resolve({ ok: false, code: 'CLOUD_OFF', orgs: [] });
  return api.myOrgs()
    .then(r => (r && r.ok)
      ? { ok: true, orgs: r.orgs || [], cur: orgId() }
      : { ok: false, code: (r && r.code) || 'FAIL', orgs: [] })
    .catch(() => ({ ok: false, code: 'NET', orgs: [] }));
}

// 切到另一家机构。任何一步失败都退回原来那家 —— 宁可让人留在能用的地方，
// 也别停在一个页面全空、还不知道为什么空的界面上。
function switchOrg(to) {
  const target = String(to || '');
  if (!target) return Promise.resolve({ ok: false, msg: '缺少机构标识' });
  if (target === orgId()) return Promise.resolve({ ok: true, same: true, orgId: target });
  if (!api.syncOn()) return Promise.resolve({ ok: false, code: 'CLOUD_OFF', msg: '网络未就绪，请稍后重试' });
  if (conflict) return Promise.resolve({ ok: false, code: 'ORG_CONFLICT', msg: '这台手机的同步有冲突，先处理完才能切换' });
  if (busy) return Promise.resolve({ ok: false, code: 'BUSY', msg: '正在同步，等两秒再切' });
  busy = true;
  return pushNow().then(
    () => doSwitch(target),
    // 【推不上去就不切】snapshot 只打包"当前机构"的文档，切走之后这些脏数据再也推不上去：
    // 数据还在手机里，但云端永远缺这一段，而且两端都不会报错。
    () => { busy = false; return { ok: false, code: 'PUSH_FAIL', msg: '当前机构还有内容没传上云，等网络好了再切换（数据在本机，不会丢）' }; }
  ).catch(e => { busy = false; return { ok: false, code: 'SWITCH_FAIL', msg: (e && e.message) || '切换失败' }; });
}

function doSwitch(target) {
  const m = db.real().meta || {};
  const back = { orgId: String(m.orgId || ''), me: String(m.me || '') };
  switching = true;
  db.patchMeta({ orgId: target, me: '' });
  ready = false;
  const fail = e => {
    db.patchMeta(back);
    ready = false;
    busy = false; switching = false;
    return { ok: false, code: 'SWITCH_FAIL', msg: (e && e.message) || '切换失败，已退回原来的机构' };
  };
  return init()
    .then(r => {
      if (!r || !r.ok) throw new Error((r && r.msg) || '没拿到这一家的访问权限');
      return pullNow(target);
    })
    .then(p => {
      // 认领：这一家的成员表已经拉到本机，按 openid 找回"我是谁"
      const oid = (db.real().meta || {}).openid;
      if (oid) claim(oid, false);
      // 本地可能还留着这一家上次没推完的东西，补推一次
      return pushNow().then(() => p);
    })
    .then(p => {
      busy = false; switching = false;
      return { ok: true, orgId: target, pulled: p.added + p.updated };
    })
    .catch(fail);
}

// 再加一家机构：本机已经有别家数据时也能加（老师去另一家兼课）。
// 与 join 的区别只有两点：① 不要求本机为空 ② 加完**不切走**，留在手头这家继续用。
function joinMore(code, name, stuNo) {
  if (!api.syncOn()) return Promise.resolve({ ok: false, code: 'CLOUD_OFF', msg: '网络未就绪，请稍后重试' });
  return api.inviteJoin({ code, name, stuNo })
    .then(r => {
      if (!r || !r.ok) return r || { ok: false, msg: '加入失败' };
      const target = String(r.orgId);
      if (!target) return { ok: false, msg: '云端没返回机构' };
      if (target === orgId()) return { ok: true, orgId: target, already: true };
      // 只把这一家的数据拉进来，不切走：他只是多了一张工牌，手头还在另一家上班
      return pullNow(target).then(p => ({ ok: true, orgId: target, pulled: p.added + p.updated, added: true }));
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

// 前台唤醒入口：节流 + 失败静默（页面不需要知道同步细节）。
// 返回 Promise 是给诊断用的：app.js 把结果记进 globalData，出问题不必再靠猜。
function kick() {
  if (!api.syncOn()) return Promise.resolve({ ok: false, code: 'SYNC_OFF' });
  return syncNow().catch(() => ({ ok: false, code: 'SYNC_FAIL' }));
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

/* ---------------- 写后自动上云 ----------------
 * 以前同步只有两个时机：启动/回前台（app.onShow，节流 20s）和存储页的手动按钮。
 * 老师在录入页一路操作、始终不切后台时，数据就一直躺在「待推送」里 ——
 * 真机上的表现就是「手机上明明有学生，云端 0 条」，而且完全没有提示。
 * 这里订阅数据层的脏标记：任何一次落盘成功，1.5 秒后自动推一轮。
 * 失败按 30s → 60s → 120s 退避重试 3 次（之后交给下次前台，不无限重试打网络）。
 */
let retryTimer = null;
let retryCount = 0;
const RETRY_DELAY = [30000, 60000, 120000];
function retryLater() {
  if (retryTimer || retryCount >= RETRY_DELAY.length) return;
  const wait = RETRY_DELAY[retryCount];
  retryCount++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    // 下一次是否还要重试，由 syncNow 自己判断（成功 retryCount 归零、失败继续排），
    // 这里不要重复排，否则退避阶梯一次失败走两级。
    syncNow({ force: true }).catch(() => {});
  }, wait);
}

try {
  db.sync.onDirty(() => {
    // 云还没就绪（未初始化/未部署）：脏标记已经落在 meta 里，下次前台/下次写会再排，
    // 这里不排重试定时器（否则离线时每 30 秒空转一次，白耗电和流量）
    if (!api.syncOn()) return;
    retryCount = 0;
    schedule();
  });
} catch (e) { /* 数据层不可用不影响本地使用 */ }

module.exports = {
  init, pullNow, pushNow, syncNow, kick, schedule, flush, pending, rejectedCount,
  join, joinByCard, claim, history, revert,
  orgList, switchOrg, joinMore,
  // 确认页提前检测本机是否为空库，别让人填完姓名才看到 LOCAL_DATA
  canJoin: () => isEmptyLocal(),
  // 已经有机构的人还能不能再加一家：能（多机构）
  canAddOrg: () => bound(),
  currentOrg: () => orgId(),
  isReady: () => ready, isConflict: () => conflict
};
