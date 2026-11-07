// family —— 家长侧云能力（订阅消息 + 已读回执 + 家长留言）
//
// 1) 订阅消息：模板 ID 走环境变量 NOTIFY_TEMPLATE_ID（备案通过后在 mp 后台申请教育类目模板，
//    把 ID 配到这里，代码零改动）。链路：家长点「开启成绩通知」→ requestSubscribeMessage 授权 →
//    bind 登记 openid + 授权次数；老师结清发布 → send 按学生找到家长 openid → subscribeMessage.send。
//    openid_map：{ _openid, sids:[学生id], name, grants:剩余可发条数, updatedAt }
//
// 2) 已读回执 / 家长留言：两张**不进同步集合**的云端专属表。为什么不能塞进 records：
//    syncv2 的 records 是按 orgId 全量 pull 的，塞进去等于把别家孩子的留言同步到所有设备，
//    家长还能伪造写入。所以这里按「这个微信到底是谁、绑的是哪个孩子」做服务端鉴权（fail-closed），
//    查不到成员 / 不是自家孩子 / 记录未发布，一律拒绝，绝不信前端传来的 sid。
//    record_views { id: orgId:rid:openid, orgId, rid, sid, openid, viewedAt }  ← doc(id).set 幂等
//    parent_notes { id(auto), orgId, rid, sid, openid, text, createdAt, handled, handledBy, handledAt }
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const COL = 'openid_map';
const VIEWS = 'record_views';
const NOTES = 'parent_notes';
const FULL = ['owner', 'admin'];      // 管理级：机构内学生全可见
const NOTE_MAX = 200;                 // 单条留言字数
const NOTE_PER_REC = 3;               // 一张成果一个家长最多留 3 条
const NOTE_FLOOD = 2;                 // 60 秒内最多 2 条（防刷屏）

const tplId = () => (process.env.NOTIFY_TEMPLATE_ID || '').trim();

// 两张新表第一次写入前建一次（云数据库不会自动建表）。云函数实例内只跑一次：
// 每次调用都 createCollection 会白白多三次 API 往返。
let ensured = false;
async function ensureNew() {
  if (ensured) return;
  for (const c of [VIEWS, NOTES]) {
    try { await db.createCollection(c); } catch (e) { /* 已存在即可 */ }
  }
  ensured = true;
}

// 调我的这个微信在机构里的成员身份。一个微信只能绑一个机构（syncv2 保证），
// 所以按 openid 取第一条即可；没有成员记录 = 还没加入，一切写操作拒绝。
async function memberOf(openid) {
  const r = await db.collection('members').where({ openid }).limit(1).get().catch(() => ({ data: [] }));
  const m = (r.data || [])[0];
  if (!m || m.removed) return null;
  if (m.status === 'disabled') return null;
  return m;
}

const sidList = m => (Array.isArray(m && m.studentIds) ? m.studentIds : []).map(Number).filter(n => n > 0);

// 这名学生是否在这位老师的可见范围里（家长走另一条：只看 studentIds）
async function teacherSeesStudent(m, sid) {
  const r = await db.collection('students').where({ orgId: m.orgId, id: Number(sid) }).limit(1)
    .get().catch(() => ({ data: [] }));
  const s = (r.data || []).filter(x => !x.removed)[0];
  if (!s) return false;
  if (FULL.indexOf(m.role) > -1) return true;
  const cls = (Array.isArray(m.clsIds) ? m.clsIds : []).map(Number);
  return (Array.isArray(s.clsIds) ? s.clsIds : []).map(Number).some(c => cls.indexOf(c) > -1);
}

// 老师端列表用：一次算出可见学生集合，避免逐条查学生（N 次往返）
async function scopeSids(m) {
  const r = await db.collection('students').where({ orgId: m.orgId }).limit(1000)
    .get().catch(() => ({ data: [] }));
  const live = (r.data || []).filter(s => !s.removed);
  if (FULL.indexOf(m.role) > -1) return live.map(s => Number(s.id));
  const cls = (Array.isArray(m.clsIds) ? m.clsIds : []).map(Number);
  return live.filter(s => (Array.isArray(s.clsIds) ? s.clsIds : []).map(Number).some(c => cls.indexOf(c) > -1))
    .map(s => Number(s.id));
}

async function recordOf(orgId, rid) {
  const r = await db.collection('records').where({ orgId, id: Number(rid) }).limit(1)
    .get().catch(() => ({ data: [] }));
  return (r.data || []).filter(x => !x.removed)[0] || null;
}

// 批量取记录（家长留言列表要显示是哪节课的）
async function recordsByIds(orgId, rids) {
  const map = {};
  if (!rids.length) return map;
  const r = await db.collection('records').where({ orgId, id: _.in(rids) }).limit(100)
    .get().catch(() => ({ data: [] }));
  (r.data || []).forEach(x => { map[Number(x.id)] = x; });
  return map;
}
async function studentsByIds(orgId, sids) {
  const map = {};
  if (!sids.length) return map;
  const r = await db.collection('students').where({ orgId, id: _.in(sids) }).limit(100)
    .get().catch(() => ({ data: [] }));
  (r.data || []).forEach(x => { map[Number(x.id)] = x; });
  return map;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, msg: '未登录，拒绝调用' };
  const action = event && event.action;

  // 前端取模板 ID（requestSubscribeMessage 需要它；未配置时前端隐藏入口）
  if (action === 'tpl') {
    const tpl = tplId();
    return { ok: true, tpl, ready: !!tpl };
  }

  // 家长绑定：授权成功后登记 openid → 孩子列表，grants = 本次授权可收到的推送条数（一次性订阅按条计）
  if (action === 'bind') {
    const sids = (Array.isArray(event.sids) ? event.sids : []).map(Number).filter(n => n > 0).slice(0, 20);
    const grants = Math.max(0, Number(event.grants) || 0);
    if (!sids.length) return { ok: false, msg: '缺少孩子信息' };
    const col = db.collection(COL);
    const prev = await col.where({ _openid: OPENID }).limit(1).get().catch(() => ({ data: [] }));
    if (prev.data.length) {
      const doc = prev.data[0];
      await col.doc(doc._id).update({
        data: {
          sids: Array.from(new Set((doc.sids || []).concat(sids))),
          grants: (Number(doc.grants) || 0) + grants,
          updatedAt: db.serverDate()
        }
      });
    } else {
      await col.add({ data: { _openid: OPENID, sids, name: String(event.name || '').slice(0, 20), grants, updatedAt: db.serverDate() } });
    }
    return { ok: true };
  }

  // 老师结清发布后触达：items = [{sid, name, score, tag, note, clsName, date}]
  if (action === 'send') {
    const tpl = tplId();
    if (!tpl) return { ok: false, code: 'NO_TPL', msg: '未配置 NOTIFY_TEMPLATE_ID，家长通知跳过（不影响发布）' };
    const items = Array.isArray(event.items) ? event.items.slice(0, 100) : [];
    if (!items.length) return { ok: true, sent: 0 };
    const sids = Array.from(new Set(items.map(x => Number(x.sid)).filter(n => n > 0)));
    if (!sids.length) return { ok: true, sent: 0 };
    // 找到所有绑定了这些孩子的家长 openid
    const docs = await db.collection(COL).where({ sids: db.command.elemMatch(db.command.in(sids)) })
      .limit(100).get().catch(() => ({ data: [] }));
    if (!docs.data.length) return { ok: true, sent: 0, nobind: true };
    let sent = 0, refused = 0;
    for (const doc of docs.data) {
      const my = items.filter(x => (doc.sids || []).indexOf(Number(x.sid)) > -1);
      for (const it of my) {
        if ((Number(doc.grants) || 0) <= 0) { refused++; continue; } // 授权额度用完，不发（发也必失败）
        // 模板字段按申请到的模板定死结构；这里给的是教育成绩通知常用三段式，
        // 模板字段名不同时只需改 data 里的 key（value 结构 thing/character_string 不变）
        try {
          await cloud.openapi.subscribeMessage.send({
            touser: doc._openid,
            templateId: tpl,
            page: 'pages/index/index',
            data: {
              thing1: { value: String(it.clsName || '课后成果').slice(0, 20) },
              character_string1: { value: String(it.date || '').slice(0, 32) },
              thing2: { value: ('等第' + (it.tag || '—') + ' ' + String(it.note || '')).slice(0, 20) }
            }
          });
          sent++;
          await db.collection(COL).doc(doc._id).update({ data: { grants: db.command.inc(-1) } });
        } catch (e) {
          // 43101 = 用户未订阅/已拒收：额度清零，别再浪费下一次尝试
          if (e && (e.errCode === 43101 || String(e.errMsg || '').indexOf('43101') > -1)) {
            refused++;
            await db.collection(COL).doc(doc._id).update({ data: { grants: 0 } }).catch(() => {});
          }
        }
      }
    }
    return { ok: true, sent, refused, parents: docs.data.length };
  }

  /* ================= 已读回执（家长打开成果详情时静默上报） ================= */
  if (action === 'fbView') {
    const rid = Number(event.rid) || 0, sid = Number(event.sid) || 0;
    if (!rid || !sid) return { ok: false, code: 'BAD', msg: '参数不完整' };
    const m = await memberOf(OPENID);
    if (!m) return { ok: false, code: 'NO_MEMBER', msg: '还没有加入机构' };
    // 只有家长需要回执；老师/负责人看记录不算「家长已读」，别把口径搅乱
    if (m.role !== 'parent') return { ok: false, code: 'NOT_PARENT', msg: '只有家长端需要回执' };
    if (sidList(m).indexOf(sid) < 0) return { ok: false, code: 'FORBIDDEN', msg: '不是你的孩子' };
    const rec = await recordOf(m.orgId, rid);
    // 未发布的记录家长本来就不该看到，也不该产生回执（否则老师会以为家长看过了）
    if (!rec || Number(rec.sid) !== sid || !rec.sent) {
      return { ok: false, code: 'NO_RECORD', msg: '记录不存在或尚未发布' };
    }
    await ensureNew();
    const id = String(m.orgId) + ':' + rid + ':' + OPENID;
    // 幂等：同一条记录同一个家长反复打开只留一条。data 里绝不出现 _id（admin 踩过 -501007）
    await db.collection(VIEWS).doc(id).set({
      data: { orgId: String(m.orgId), rid, sid, openid: OPENID, viewedAt: Date.now() }
    });
    return { ok: true };
  }

  /* ================= 家长留言（对某条成果给老师留话） ================= */
  if (action === 'fbNote') {
    const rid = Number(event.rid) || 0, sid = Number(event.sid) || 0;
    const raw = String(event.text || '').trim();
    if (!rid || !sid) return { ok: false, code: 'BAD', msg: '参数不完整' };
    if (!raw) return { ok: false, code: 'EMPTY', msg: '先写一句再发吧' };
    if (raw.length > NOTE_MAX) return { ok: false, code: 'TOO_LONG', msg: '最多 ' + NOTE_MAX + ' 字，请精简一下' };
    const m = await memberOf(OPENID);
    if (!m) return { ok: false, code: 'NO_MEMBER', msg: '还没有加入机构' };
    if (m.role !== 'parent') return { ok: false, code: 'NOT_PARENT', msg: '只有家长可以留言' };
    if (sidList(m).indexOf(sid) < 0) return { ok: false, code: 'FORBIDDEN', msg: '不是你的孩子' };
    const rec = await recordOf(m.orgId, rid);
    if (!rec || Number(rec.sid) !== sid || !rec.sent) {
      return { ok: false, code: 'NO_RECORD', msg: '记录不存在或尚未发布' };
    }
    await ensureNew();
    const now = Date.now();
    const col = db.collection(NOTES);
    // 限流：一张成果 3 条上限 + 60 秒内 2 条。取最近 10 条足够判两件事，不必 count 全表。
    const mine = await col.where({ orgId: String(m.orgId), rid, sid, openid: OPENID })
      .limit(10).get().catch(() => ({ data: [] }));
    const list = mine.data || [];
    if (list.length >= NOTE_PER_REC) {
      return { ok: false, code: 'LIMIT', msg: '这条成果已经留过 ' + NOTE_PER_REC + ' 条啦' };
    }
    const recent = list.filter(n => now - (Number(n.createdAt) || 0) < 60000).length;
    if (recent >= NOTE_FLOOD) return { ok: false, code: 'FLOOD', msg: '刚发过，过一分钟再说' };
    // 内容安全：只有明确命中违规（87014）才拦，接口抖动时放行——
    // 把家长全堵在门外，比偶尔漏检一条伤害大（与 secCheck 的既有口径一致）。
    const chk = await cloud.callFunction({ name: 'secCheck', data: { action: 'msg', content: raw } })
      .then(r => (r && r.result) || {})
      .catch(() => ({ ok: true, warn: true }));
    if (chk.ok === false && chk.hit) {
      return { ok: false, code: 'UNSAFE', msg: '这段话发不出去，请改一下再发' };
    }
    const doc = {
      orgId: String(m.orgId), rid, sid, openid: OPENID, text: raw,
      createdAt: now, handled: 0, handledBy: '', handledAt: 0
    };
    const add = await col.add({ data: doc });
    return { ok: true, id: (add && add._id) || '', createdAt: now, handled: 0 };
  }

  /* ================= 列表：家长看自己写的，老师看可见范围内的 ================= */
  if (action === 'fbList') {
    const m = await memberOf(OPENID);
    if (!m) return { ok: false, code: 'NO_MEMBER', msg: '还没有加入机构' };
    await ensureNew();
    const col = db.collection(NOTES);
    // 不用 orderBy：小机构数据量小，内存排序可以省掉控制台建索引这一步（少一个部署坑）
    if (m.role === 'parent') {
      const q = await col.where({ orgId: String(m.orgId), openid: OPENID }).limit(100)
        .get().catch(() => ({ data: [] }));
      const list = (q.data || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 30);
      const recs = await recordsByIds(m.orgId, Array.from(new Set(list.map(n => Number(n.rid)))));
      return {
        ok: true, scope: 'parent',
        notes: list.map(n => ({
          id: n._id, rid: Number(n.rid), sid: Number(n.sid),
          text: String(n.text || ''), createdAt: Number(n.createdAt) || 0, handled: !!n.handled,
          course: (recs[Number(n.rid)] || {}).course || '', date: (recs[Number(n.rid)] || {}).date || ''
        })),
        unhandled: list.filter(n => !n.handled).length
      };
    }
    if (FULL.indexOf(m.role) < 0 && m.role !== 'teacher') {
      return { ok: false, code: 'FORBIDDEN', msg: '无权查看家长反馈' };
    }
    const sids = await scopeSids(m);
    const q = await col.where({ orgId: String(m.orgId) }).limit(100).get().catch(() => ({ data: [] }));
    const all = (q.data || []).filter(n => sids.indexOf(Number(n.sid)) > -1)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    // 老师端要显示「谁家的孩子、哪节课、什么时候说的」，姓名/班级由服务端补，
    // 留言表本身只存 sid/rid（不存姓名、学号、手机号）
    const recs = await recordsByIds(m.orgId, Array.from(new Set(all.map(n => Number(n.rid)))));
    const stus = await studentsByIds(m.orgId, Array.from(new Set(all.map(n => Number(n.sid)))));
    const rows = all.slice(0, 30).map(n => {
      const s = stus[Number(n.sid)] || {};
      const r = recs[Number(n.rid)] || {};
      return {
        id: n._id, rid: Number(n.rid), sid: Number(n.sid), text: String(n.text || ''),
        createdAt: Number(n.createdAt) || 0, handled: !!n.handled,
        stuName: s.name || '学生', course: r.course || '', date: r.date || '',
        score: r.score, tag: r.tag || '', session: r.session || 0
      };
    });
    return { ok: true, scope: 'teacher', notes: rows, unhandled: all.filter(n => !n.handled).length, total: all.length };
  }

  /* ================= 批量回执统计（记录列表 / 班级页的小标） ================= */
  if (action === 'fbStats') {
    const m = await memberOf(OPENID);
    if (!m) return { ok: false, code: 'NO_MEMBER', msg: '还没有加入机构' };
    if (m.role === 'parent') return { ok: false, code: 'NOT_TEACHER', msg: '家长端不需要回执统计' };
    const rids = (Array.isArray(event.rids) ? event.rids : []).map(Number).filter(n => n > 0).slice(0, 50);
    if (!rids.length) return { ok: true, stats: {} };
    await ensureNew();
    const sids = await scopeSids(m);
    const v = await db.collection(VIEWS).where({ orgId: String(m.orgId), rid: _.in(rids) }).limit(1000)
      .get().catch(() => ({ data: [] }));
    const n = await db.collection(NOTES).where({ orgId: String(m.orgId), rid: _.in(rids) }).limit(1000)
      .get().catch(() => ({ data: [] }));
    const stats = {};
    rids.forEach(id => { stats[id] = { viewed: 0, notes: 0, unhandled: 0 }; });
    (v.data || []).forEach(x => {
      if (sids.indexOf(Number(x.sid)) < 0) return;  // 不在可见范围的学生不计数
      const k = Number(x.rid);
      if (stats[k]) stats[k].viewed++;
    });
    (n.data || []).forEach(x => {
      if (sids.indexOf(Number(x.sid)) < 0) return;
      const k = Number(x.rid);
      if (!stats[k]) return;
      stats[k].notes++;
      if (!x.handled) stats[k].unhandled++;
    });
    return { ok: true, stats };
  }

  /* ================= 标记已处理（只能标记自己看得到的） ================= */
  if (action === 'fbHandle') {
    const id = String(event.id || '');
    if (!id) return { ok: false, code: 'BAD', msg: '缺少留言 id' };
    const m = await memberOf(OPENID);
    if (!m) return { ok: false, code: 'NO_MEMBER', msg: '还没有加入机构' };
    if (m.role === 'parent') return { ok: false, code: 'NOT_TEACHER', msg: '没有处理留言的权限' };
    await ensureNew();
    const col = db.collection(NOTES);
    const got = await col.doc(id).get().catch(() => null);
    const n = got && got.data;
    if (!n || String(n.orgId) !== String(m.orgId)) return { ok: false, code: 'NOT_FOUND', msg: '留言不存在' };
    if (!(await teacherSeesStudent(m, n.sid))) return { ok: false, code: 'FORBIDDEN', msg: '这条不在你的管理范围' };
    await col.doc(id).update({ data: { handled: 1, handledBy: String(m.userId || ''), handledAt: Date.now() } });
    return { ok: true };
  }

  return { ok: false, msg: '未知 action' };
};
