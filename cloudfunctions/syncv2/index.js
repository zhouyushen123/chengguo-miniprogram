// syncv2 —— 记录/学生/班级上云（替换旧的 openid 单模型 sync，CR-005）
//
// 【模型】每份数据都挂 orgId，服务器按 users 集合里的 openid→orgId 绑定做隔离：
// 一个微信账号只能读写自己绑定机构的数据，别的机构一律拒绝（越权即 fail-closed）。
//
// 【协议】全部 LWW（last-write-wins，按文档 updatedAt 比较）：
//   hello  → 首次登录建绑定；返回该账号的 orgId
//   push   → [{c:集合名, d:文档}] 逐条 upsert，服务器更新的跳过，写入时盖 srvAt
//   pull   → 拉 srvAt > since 的增量（每集合 100 条上限），返回新游标与 more 标记
// 删除是软删（removed:true 作为普通字段同步），所以两端都能看到"这条被删了"。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// 允许同步的集合（users 是本机身份，不同步；演示数据在独立命名空间，天然不进这里）
const COLLS = ['orgs', 'members', 'terms', 'classes', 'courses', 'students', 'enrollments', 'records', 'templates'];
const PAGE = 100;
// 邀请码（机构码）：不参与内容同步，只做"这个人可以加入哪个机构、以什么身份"的凭据
const INVITES = 'invites';
const INVITE_DAYS = 30;
const ROLES = ['parent', 'teacher', 'admin'];
// 去掉容易看错的 0/O/1/I/2/Z，家长照着屏幕或纸质卡片输入不该猜字母
const ALPHABET = 'ACDEFGHJKLMNPQRSTUVWXY3456789';

// 首次调用时集合还不存在（云数据库不会自动建表）→ 一个一个建，已存在就忽略。
// 这样用户不用在控制台手工点十次，部署完直接用。
async function ensureCollections() {
  for (const c of COLLS.concat(['users', INVITES])) {
    try { await db.createCollection(c); } catch (e) { /* 已存在即可 */ }
  }
}

async function userOf(openid) {
  try {
    const r = await db.collection('users').where({ _openid: openid }).limit(1).get();
    return r.data[0] || null;
  } catch (e) {
    await ensureCollections();
    const r = await db.collection('users').where({ _openid: openid }).limit(1).get().catch(() => ({ data: [] }));
    return r.data[0] || null;
  }
}

// 我在这个机构里的成员身份（服务端判权限，不信客户端自报的角色）
async function memberOf(openid, orgId) {
  try {
    const r = await db.collection('members').where({ orgId, openid }).limit(1).get();
    return r.data[0] || null;
  } catch (e) { return null; }
}

function newCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}
// 机构号：首次绑定由服务端发。客户端带上来的是出厂号（org1）时一律重新发一个——
// 出厂号是所有新装设备共用的，直接拿它当机构号，两个客户的数据就会在云端混成一团。
// 只有邀请码加入（带着明确的机构号）才沿用客户端给的号。
const FACTORY_ORG = 'org1';
const ORG_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function newOrgId() {
  let s = '';
  for (let i = 0; i < 10; i++) s += ORG_CHARS[Math.floor(Math.random() * ORG_CHARS.length)];
  return 'org_' + s;
}
// 成员 id：客户端 id 是小整数（nextId），云端发号用「毫秒 ×1000 + 随机」，
// 量级完全错开，永远不会撞到客户端已经发出的号，也不用为两张表维护同一套序列。
function newMemberId() { return Date.now() * 1000 + Math.floor(Math.random() * 1000); }
const CODE_RE = /^[A-Z0-9]{4,10}$/;

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, msg: '未登录，拒绝调用' };
  const action = event && event.action;

  if (action === 'hello') {
    const want = String(event.orgId || '').slice(0, 64);
    const u = await userOf(OPENID);
    if (u) return { ok: true, orgId: u.orgId, firstTime: false, openid: OPENID };
    if (!want) return { ok: false, msg: '缺少机构标识' };
    // 出厂号不是真实机构号：发一个新的，客户端会把本机数据整体改挂过来（minted=true）。
    // 这条分支只会在"这台设备第一次上云"时走到，云端这个号下一条数据都没有，改挂是安全的。
    const minted = want === FACTORY_ORG;
    const orgId = minted ? newOrgId() : want;
    await db.collection('users').add({ data: { _openid: OPENID, orgId, createdAt: db.serverDate() } });
    return { ok: true, orgId, firstTime: true, minted, openid: OPENID };
  }

  // 只读探测：这个微信绑过机构吗？换手机/重装时客户端用它判断"该恢复还是该从零开始"，
  // 不能在探测阶段就建立绑定——那会让新装家长的微信号被绑到出厂机构上，再也加入不了真正的机构。
  if (action === 'whoami') {
    const u = await userOf(OPENID);
    // openid 一起带回去：恢复数据后要靠它认出"我是成员表里的谁"，
    // 否则数据拉下来了却因为查不到身份而一条都看不见（actor 为空 → 权限过滤全挡）。
    return { ok: true, bound: !!u, orgId: u ? String(u.orgId) : '', openid: OPENID };
  }

  // ---- 邀请码：这两个动作必须在"已绑定机构"之前，因为用它们的人本来就还没绑定 ----
  if (action === 'inviteInfo') {
    const code = String(event.code || '').trim().toUpperCase();
    if (!CODE_RE.test(code)) return { ok: false, code: 'BAD_CODE', msg: '邀请码格式不对' };
    const inv = await db.collection(INVITES).doc(code).get().catch(() => null);
    const d = inv && inv.data;
    if (!d) return { ok: false, code: 'NO_CODE', msg: '邀请码不存在' };
    if (d.closed) return { ok: false, code: 'CLOSED', msg: '该邀请码已停用' };
    if ((Number(d.expiresAt) || 0) < Date.now()) return { ok: false, code: 'EXPIRED', msg: '该邀请码已过期' };
    // 只回机构名和身份，不回任何业务数据
    let orgName = '';
    try {
      const o = await db.collection('orgs').where({ id: d.orgId }).limit(1).get();
      orgName = (o.data[0] && o.data[0].name) || '';
    } catch (e) { /* 机构还没同步上去时留空，不影响加入 */ }
    return { ok: true, orgId: d.orgId, role: d.role, orgName };
  }

  if (action === 'inviteJoin') {
    const code = String(event.code || '').trim().toUpperCase();
    const name = String(event.name || '').trim().slice(0, 20);
    if (!CODE_RE.test(code)) return { ok: false, code: 'BAD_CODE', msg: '邀请码格式不对' };
    if (!name) return { ok: false, code: 'NO_NAME', msg: '请填写你的姓名' };
    const inv = await db.collection(INVITES).doc(code).get().catch(() => null);
    const d = inv && inv.data;
    if (!d) return { ok: false, code: 'NO_CODE', msg: '邀请码不存在' };
    if (d.closed) return { ok: false, code: 'CLOSED', msg: '该邀请码已停用' };
    if ((Number(d.expiresAt) || 0) < Date.now()) return { ok: false, code: 'EXPIRED', msg: '该邀请码已过期' };

    // 已经有绑定：只能是同一个机构，否则拒绝（绝不把人从一个机构挪到另一个）
    const had = await userOf(OPENID);
    if (had && String(had.orgId) !== String(d.orgId)) {
      return { ok: false, code: 'ORG_BOUND', msg: '该微信已加入其他机构' };
    }

    // 家长必须提供学号：孩子是谁，由机构自己发的号来定，不让家长自由勾选别人的孩子
    let kids = [];
    if (d.role === 'parent') {
      const no = String(event.stuNo || '').trim();
      if (!no) return { ok: false, code: 'NO_STU', msg: '请填写孩子的学号' };
      const sr = await db.collection('students').where({ orgId: d.orgId, no }).limit(5).get().catch(() => ({ data: [] }));
      const kid = sr.data.filter(s => !s.removed)[0];
      if (!kid) return { ok: false, code: 'NO_STUDENT', msg: '没有找到这个学号，请跟老师核对' };
      kids = [kid.id];
      // 同一家长号码的兄弟姐妹一起带上，家长不必为孩子逐个加入
      if (kid.wechat) {
        const sib = await db.collection('students').where({ orgId: d.orgId, wechat: kid.wechat }).limit(20).get().catch(() => ({ data: [] }));
        sib.data.forEach(s => { if (!s.removed && kids.indexOf(s.id) < 0) kids.push(s.id); });
      }
    }

    const now = Date.now();
    if (!had) {
      await db.collection('users').add({ data: { _openid: OPENID, orgId: d.orgId, createdAt: db.serverDate() } });
    }
    // 同一个人在同一个机构只留一条成员关系：重复加入（换手机、换微信重进）就地更新
    const exist = await memberOf(OPENID, d.orgId);
    let doc;
    if (exist) {
      doc = Object.assign({}, exist, {
        name, role: exist.role === 'owner' ? 'owner' : d.role,
        studentIds: kids.length ? kids : (exist.studentIds || []),
        status: 'active', updatedAt: now, srvAt: now
      });
      delete doc._id;
      await db.collection('members').doc(exist._id).update({ data: doc });
    } else {
      const id = newMemberId();
      doc = {
        id, orgId: d.orgId, userId: 'x' + id, openid: OPENID,
        role: d.role, name,
        clsIds: [], courseIds: [], studentIds: kids,
        status: 'active', phone: '', wechat: '', photo: '',
        createdAt: now, updatedAt: now, srvAt: now
      };
      await db.collection('members').add({ data: doc });
    }
    // 用量只做记录，不限制次数（一个机构码本来就该给全班家长用）
    await db.collection(INVITES).doc(code).update({
      data: { uses: (Number(d.uses) || 0) + 1, lastAt: now }
    }).catch(() => {});
    return { ok: true, orgId: d.orgId, member: doc };
  }

  const u = await userOf(OPENID);
  if (!u) return { ok: false, code: 'NO_BIND', msg: '账号未绑定机构，请先 hello' };
  const orgId = String(event.orgId || '');
  if (orgId !== u.orgId) return { ok: false, code: 'FORBIDDEN', msg: '无权访问该机构数据' };

  // 取（或新建）某个身份的机构邀请码：负责人/管理员才能拿，服务端按成员表判角色
  if (action === 'inviteGet') {
    const role = ROLES.indexOf(event.role) > -1 ? event.role : 'parent';
    const me = await memberOf(OPENID, orgId);
    if (!me) return { ok: false, code: 'NO_MEMBER', msg: '本账号不在该机构成员表里' };
    const isManager = me.role === 'owner' || me.role === 'admin';
    // 老师也能拉家长进自己的班，但不能拉老师/管理员进来
    if (!isManager && !(me.role === 'teacher' && role === 'parent')) {
      return { ok: false, code: 'FORBIDDEN', msg: '没有邀请权限' };
    }
    await ensureCollections();
    const found = await db.collection(INVITES).where({ orgId, role, closed: false }).limit(1).get().catch(() => ({ data: [] }));
    const live = found.data.filter(x => (Number(x.expiresAt) || 0) > Date.now())[0];
    if (live) return { ok: true, code: live._id, role, expiresAt: live.expiresAt, reused: true };
    // 生成到不冲突为止（code 就是文档 _id，天然去重）
    for (let i = 0; i < 5; i++) {
      const code = newCode();
      const expiresAt = Date.now() + INVITE_DAYS * 86400000;
      const dup = await db.collection(INVITES).doc(code).get().catch(() => null);
      if (dup && dup.data) continue;
      await db.collection(INVITES).doc(code).set({
        data: { orgId, role, closed: false, uses: 0, by: OPENID, createdAt: Date.now(), expiresAt }
      });
      return { ok: true, code, role, expiresAt, reused: false };
    }
    return { ok: false, msg: '邀请码生成失败，请重试' };
  }

  if (action === 'push') {
    const docs = Array.isArray(event.docs) ? event.docs.slice(0, 100) : [];
    const now = Date.now();
    let accepted = 0, newer = 0, denied = 0;
    const mine = await memberOf(OPENID, orgId);
    const isMgr = !!mine && (mine.role === 'owner' || mine.role === 'admin');
    for (const it of docs) {
      const c = String((it && it.c) || '');
      let d = it && it.d;
      if (COLLS.indexOf(c) < 0 || !d || d.id === undefined || d.id === null) continue;
      // 成员表是权限的源头，必须服务端把关：客户端推送来的角色/范围一律不可信。
      // 非管理者只能改自己的姓名头像；连"认领自己"都不行的话，第一台设备永远建不出成员，
      // 所以机构还没有任何成员时放行第一条（谁先建机构，谁就是负责人）。
      if (c === 'members' && !isMgr) {
        if (String(d.openid || '') !== OPENID) { denied++; continue; }
        if (mine) {
          d = Object.assign({}, d, {
            role: mine.role, status: mine.status,
            clsIds: mine.clsIds || [], courseIds: mine.courseIds || [], studentIds: mine.studentIds || []
          });
        } else {
          const any = await db.collection('members').where({ orgId }).limit(1).get().catch(() => ({ data: [null] }));
          if (any.data.length) { denied++; continue; }
        }
      }
      const col = db.collection(c);
      const found = await col.where({ orgId, id: d.id }).limit(1).get();
      // 服务器上的版本更新（别的设备刚改过）→ 跳过，让客户端下一步 pull 拿到新值
      if (found.data.length) {
        if ((Number(found.data[0].updatedAt) || 0) > (Number(d.updatedAt) || 0)) { newer++; continue; }
        await col.doc(found.data[0]._id).update({
          data: Object.assign({}, d, { orgId, srvAt: now })
        });
      } else {
        await col.add({ data: Object.assign({}, d, { orgId, srvAt: now }) });
      }
      accepted++;
    }
    return { ok: true, accepted, newer, denied };
  }

  if (action === 'pull') {
    const since = Number(event.since) || 0;
    const docs = [];
    let cursor = since;
    let more = false;
    for (const c of COLLS) {
      let r = { data: [] };
      // 首次部署集合可能不存在：跳过一次并在下一轮补建（pull 不能因为一个集合报错全挂）
      try {
        r = await db.collection(c).where({ orgId, srvAt: _.gt(since) }).limit(PAGE).get();
      } catch (e) {
        await ensureCollections();
        continue;
      }
      if (r.data.length >= PAGE) more = true;
      r.data.forEach(d => {
        const { _id, srvAt, ...rest } = d;
        // srvAt 单独带在条目上（不进文档本体，免得回推时污染数据）
        docs.push({ c, d: rest, srvAt: srvAt || 0 });
        if ((srvAt || 0) > cursor) cursor = srvAt;
      });
    }
    return { ok: true, docs, cursor, more };
  }

  return { ok: false, msg: '未知 action' };
};
