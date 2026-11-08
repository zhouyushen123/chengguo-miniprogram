// syncv2 —— 记录/学生/班级上云（替换旧的 openid 单模型 sync，CR-005）
//
// 【模型】每份数据都挂 orgId，服务器按 users 集合里的 openid→机构工牌做隔离：
// 一个微信可以有**多张工牌**（users.orgIds），但每一次请求只能读写「点名的这一家」的数据，
// 没有那家工牌就一律拒绝（越权即 fail-closed）。多机构 = 多一个可进入的空间，不是把数据合到一起。
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
const COLLS = ['orgs', 'members', 'terms', 'classes', 'courses', 'class_courses', 'subjects', 'knowledge_points',
  'students', 'enrollments', 'records', 'templates'];
const PAGE = 100;
// 版本历史：核心资产每次被"真的改内容"之前留一份旧值。
// 只做核心四类——记录是海量增长的业务数据，给它留历史等于把库撑爆，而且误改一条记录的代价远小于误改一个学生。
const HISTORY = 'history';
const HIST_COLLS = ['orgs', 'members', 'students', 'classes'];
const HIST_KEEP = 10;
// 邀请码（机构码）：不参与内容同步，只做"这个人可以加入哪个机构、以什么身份"的凭据
const INVITES = 'invites';
const INVITE_DAYS = 30;
const ROLES = ['parent', 'teacher', 'admin'];
// 去掉容易看错的 0/O/1/I/2/Z，家长照着屏幕或纸质卡片输入不该猜字母
const ALPHABET = 'ACDEFGHJKLMNPQRSTUVWXY3456789';
// 家长邀请卡：一人一张，把「机构码 + 孩子」预封成一次性令牌。
// 家长不用记 6 位码、不用记 4 位学号，点开卡片确认即可。
// token 只用无歧义小写字母数字，12 位；分享链接里只有它，不带任何业务数据。
const CARDS = 'invite_cards';
const CARD_DAYS = 7;
const CARD_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const CARD_RE = /^[a-z0-9]{12,20}$/;

// 首次调用时集合还不存在（云数据库不会自动建表）→ 一个一个建，已存在就忽略。
// 这样用户不用在控制台手工点十次，部署完直接用。
async function ensureCollections() {
  for (const c of COLLS.concat(['users', INVITES, HISTORY, CARDS])) {
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

// 这个微信能进入的机构列表。
// 老数据只有单个 orgId（一个微信只能属于一家），新数据多一个 orgIds 数组：
// 同一个人在两家机构上课 = 两张工牌，各自一条 members，谁也不覆盖谁。
// 主机构（orgId）保留不动，客户端第一次进来没有偏好时用它。
function orgsOf(u) {
  const list = Array.isArray(u && u.orgIds) ? u.orgIds.map(String).filter(Boolean) : [];
  const main = String((u && u.orgId) || '');
  if (main && list.indexOf(main) < 0) list.unshift(main);
  return list;
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
// 上一个用过的服务端时间戳（云函数实例内有效）。只为避免"同一毫秒两次 push"撞号，
// 真正的正确性靠 pull 的组完整性保护（见下面 pull 分支）。
let lastSrvAt = 0;
// 下一个同步时间戳：同一实例内严格递增（跨实例靠 pull 端末组保护兜底）
function nextSrvAt() {
  const t = Date.now();
  lastSrvAt = t > lastSrvAt ? t : lastSrvAt + 1;
  return lastSrvAt;
}

// 业务内容是否相同（忽略同步元数据）。只用来决定"值不值得留旧版"：
// 仅 updatedAt 变了的推送不该刷出一堆内容一样的历史。
const META_KEYS = { _id: 1, _openid: 1, srvAt: 1, updatedAt: 1 };
function sameContent(a, b) {
  const keys = {};
  Object.keys(a || {}).forEach(k => { if (!META_KEYS[k]) keys[k] = 1; });
  Object.keys(b || {}).forEach(k => { if (!META_KEYS[k]) keys[k] = 1; });
  for (const k of Object.keys(keys)) {
    const x = a ? a[k] : undefined;
    const y = b ? b[k] : undefined;
    if (x === y) continue;
    // 缺字段与它的默认值算同一个内容：客户端少传一个 removed:false 不该被当成一次修改
    const empty = v => v === undefined || v === null || v === false || v === '' || v === 0;
    if (empty(x) && empty(y)) continue;
    if (x && y && typeof x === 'object' && typeof y === 'object') {
      if (JSON.stringify(x) !== JSON.stringify(y)) return false;
      continue;
    }
    return false;
  }
  return true;
}

// 留一版旧值 + 只保留最近 HIST_KEEP 版。
// 无限归档等于把数据库变成垃圾桶，而且查起来更慢；"最近十次改错了能退回去"才是真实需求。
async function keepHistory(orgId, c, id, doc, openid) {
  const old = Object.assign({}, doc);
  delete old._id; delete old._openid; delete old.srvAt;
  try {
    await db.collection(HISTORY).add({ data: { orgId, c, id, at: Date.now(), by: openid, doc: old } });
    const r = await db.collection(HISTORY).where({ orgId, c, id })
      .orderBy('at', 'desc').skip(HIST_KEEP).limit(20).get();
    for (const x of r.data) await db.collection(HISTORY).doc(x._id).remove();
  } catch (e) {
    // 历史写失败绝不能连带业务写入失败——但一定要留痕，否则"以为有历史"比没有更危险
    console.warn('[syncv2] 写历史失败', c, id, e && e.message);
  }
}

// 核心资产的硬约束：客户端体检是事后的，服务端这一层才拦得住
async function checkCore(c, d, orgId) {
  if (c === 'orgs' && d.removed === true) {
    return { code: 'ORG_ROOT', msg: '机构档案不能删除' };
  }
  if (c === 'students' && d.removed !== true) {
    const no = String(d.no === undefined || d.no === null ? '' : d.no).trim();
    if (no) {
      const r = await db.collection('students').where({ orgId, no }).limit(10).get().catch(() => ({ data: [] }));
      const clash = r.data.filter(x => String(x.id) !== String(d.id) && x.removed !== true && String(x.no).trim() === no);
      // 学号是家长认孩子的唯一凭据，重号会让家长看到别人家的孩子
      if (clash.length) return { code: 'DUP_NO', msg: '学号 ' + no + ' 已被「' + (clash[0].name || '其他学生') + '」使用' };
    }
  }
  if (c === 'members' && d.removed !== true && d.openid) {
    const r = await db.collection('members').where({ orgId, openid: d.openid }).limit(10).get().catch(() => ({ data: [] }));
    const clash = r.data.filter(x => String(x.id) !== String(d.id) && x.removed !== true);
    // 一个微信两条成员关系 = 权限按哪条生效不确定，这类问题排查起来极贵
    if (clash.length) return { code: 'MEM_TAKEN', msg: '这个微信已经绑定了「' + (clash[0].name || '其他成员') + '」' };
  }
  if (c === 'members' && d.removed !== true && d.role === 'owner') {
    const r = await db.collection('members').where({ orgId, role: 'owner' }).limit(10).get().catch(() => ({ data: [] }));
    const clash = r.data.filter(x => String(x.id) !== String(d.id) && x.removed !== true);
    if (clash.length) return { code: 'OWNER_EXISTS', msg: '机构已有负责人「' + (clash[0].name || '') + '」' };
  }
  return null;
}
const CODE_RE = /^[A-Z0-9]{4,10}$/;

/* ---------------- 家长邀请卡 · 服务端工具 ----------------
 * 卡片不是一套新身份体系：服务端把它换回「机构码 + 孩子」，再走和老入口一样的落库。
 * 所以 inviteJoin 的建绑定/建成员/权限口径完全复用，老码不受影响。
 */
function newCardToken() {
  let s = '';
  for (let i = 0; i < 12; i++) s += CARD_CHARS[Math.floor(Math.random() * CARD_CHARS.length)];
  return s;
}

// 取（或新建）本机构的家长邀请码。卡片从不把这个码下发到家长端，
// 只在服务端用它反查机构身份 —— 家长手里只有 token。
async function parentCode(orgId, openid) {
  const found = await db.collection(INVITES).where({ orgId, role: 'parent', closed: false })
    .limit(5).get().catch(() => ({ data: [] }));
  const live = found.data.filter(x => (Number(x.expiresAt) || 0) > Date.now())[0];
  if (live) return live._id;
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    const dup = await db.collection(INVITES).doc(code).get().catch(() => null);
    if (dup && dup.data) continue;
    await db.collection(INVITES).doc(code).set({
      data: { orgId, role: 'parent', closed: false, uses: 0, by: openid,
        createdAt: Date.now(), expiresAt: Date.now() + INVITE_DAYS * 86400000 }
    });
    return code;
  }
  return '';
}

// 卡片状态统一在这里判：不存在 / 作废 / 过期 / 已用过，家长端只会收到一句人话。
async function readCard(token) {
  if (!CARD_RE.test(token)) return { err: { ok: false, code: 'BAD_CARD', msg: '卡片链接不对，请让老师重发' } };
  const r = await db.collection(CARDS).doc(token).get().catch(() => null);
  const d = r && r.data;
  if (!d) return { err: { ok: false, code: 'NO_CARD', msg: '这张卡片不存在，请让老师重发' } };
  if (d.status === 'revoked') return { err: { ok: false, code: 'REVOKED', msg: '这张卡片已被老师作废，请让老师重发' } };
  if ((Number(d.expiresAt) || 0) < Date.now()) return { err: { ok: false, code: 'EXPIRED', msg: '这张卡片已过 7 天有效期，请让老师重发' } };
  return { d };
}

// 认领哪些孩子。老入口按学号；卡片按 sid（服务端自己存的，家长看不到），
// 这样学生没填学号也能发卡 —— 「不让家长记学号」要真的做到。
// 兄弟姐妹按微信号 + 家长手机号双键归并（客户端 F-04 已是双键，云端在此对齐）。
async function kidsFor(orgId, opts) {
  let kid = null;
  if (opts && opts.studentId) {
    const sr = await db.collection('students').where({ orgId, id: Number(opts.studentId) || 0 })
      .limit(5).get().catch(() => ({ data: [] }));
    kid = sr.data.filter(s => !s.removed)[0];
    if (!kid) return { err: { ok: false, code: 'NO_STUDENT', msg: '孩子档案已不在，请让老师重发卡片' } };
  } else {
    const no = String((opts && opts.stuNo) || '').trim();
    if (!no) return { err: { ok: false, code: 'NO_STU', msg: '请填写孩子的学号' } };
    const sr = await db.collection('students').where({ orgId, no }).limit(5).get().catch(() => ({ data: [] }));
    kid = sr.data.filter(s => !s.removed)[0];
    if (!kid) return { err: { ok: false, code: 'NO_STUDENT', msg: '没有找到这个学号，请跟老师核对' } };
  }
  const kids = [kid.id];
  const keys = [];
  if (kid.wechat) keys.push({ k: 'wechat', v: String(kid.wechat) });
  if (kid.parentPhone) keys.push({ k: 'parentPhone', v: String(kid.parentPhone) });
  for (const it of keys) {
    const q = {}; q[it.k] = it.v;
    const sib = await db.collection('students').where(Object.assign({ orgId }, q))
      .limit(20).get().catch(() => ({ data: [] }));
    sib.data.forEach(s => { if (!s.removed && kids.indexOf(s.id) < 0) kids.push(s.id); });
  }
  return { kids, kid };
}

/* ---------------- 平台身份 pid：同一个孩子在多家机构 ----------------
 * 一个孩子可能在 A 家学美术、B 家学钢琴，两家各自给他建了一条档案。
 * pid 是这两条档案之间的桥：家长端把 pid 相同的档案认成一个孩子，按机构分组展示。
 * 【为什么建档时不发号】机构自己建档时并不知道这孩子别家也在教；
 * 只有家长认领的那一刻，才有"这两个张小明是同一个人"这句判断。
 */
function newPid() {
  let s = '';
  for (let i = 0; i < 10; i++) s += CARD_CHARS[Math.floor(Math.random() * CARD_CHARS.length)];
  return 'p_' + s;
}

// 这个微信已经认下来的孩子（跨所有有工牌的机构）。
// 只回识别要用的字段，不回成绩、不回照片：这是"认人"，不是"看数据"。
async function findMyKids(openid, orgIds) {
  const out = [];
  for (const oid of orgIds) {
    const m = await memberOf(openid, oid);
    if (!m) continue;
    const ids = (m.studentIds || []).map(Number).filter(Boolean);
    // 逐个按 id 取（一个家长名下通常 1~3 个孩子）：不用 _.in，也不受单页上限影响
    for (const sid of ids) {
      const r = await db.collection('students').where({ orgId: oid, id: sid })
        .limit(5).get().catch(() => ({ data: [] }));
      const s = r.data.filter(x => !x.removed)[0];
      if (!s) continue;
      out.push({
        orgId: oid, sid: s.id, name: String(s.name || ''), pid: String(s.pid || ''),
        phone: String(s.parentPhone || '').replace(/\D/g, ''), wechat: String(s.wechat || '')
      });
    }
  }
  return out;
}

// 两条档案是同一个孩子吗：同名 / 同家长手机 / 同微信号，任一命中就"提出来问一句"。
// 只提示、不自动合并 —— 误合并会把两个孩子的成长记录混在一起，还牵涉两家机构，
// 让家长多点一次「不是同一个」远比事后拆分便宜。
function sameKid(a, b) {
  if (!a || !b) return false;
  if (a.pid && b.pid && String(a.pid) === String(b.pid)) return true;
  if (a.name && b.name && String(a.name).trim() === String(b.name).trim()) return true;
  if (a.phone && b.phone && String(a.phone) === String(b.phone)) return true;
  if (a.wechat && b.wechat && String(a.wechat) === String(b.wechat)) return true;
  return false;
}

// 把 pid 写到学生档案上。srvAt / updatedAt 必须一起推进：
// pull 是按 srvAt > since 拉增量的，不推进的话手机永远拉不到这条改动，
// 孩子在没有 pid 的状态下一直用下去，家长端也就永远合不起来。
async function setStudentsPid(orgId, ids, pid) {
  const list = (ids || []).map(Number).filter(Boolean);
  if (!orgId || !list.length || !pid) return false;
  const at = nextSrvAt();
  try {
    // 逐条更新而不是 _.in：这条链路一行只有一两个学生（卡片锁定的那个孩子），
    // 少依赖一个查询操作符，换环境/换测试假库都少一处坑。
    for (const sid of list) {
      await db.collection('students').where({ orgId, id: sid })
        .update({ data: { pid: String(pid), updatedAt: at, srvAt: at } });
    }
    return true;
  } catch (e) {
    console.warn('[syncv2] 写 pid 失败', orgId, pid, e && e.message);
    return false;
  }
}

// 建立/更新绑定与成员关系：inviteJoin 与 cardClaim 共用，避免两份实现漂移。
// status 是给「老师审核」留的口子：阶段 1 一律 active，老入口也永远是 active。
async function finishJoin(orgId, role, openid, name, kids, status) {
  const had = await userOf(openid);
  const now = Date.now();
  if (!had) {
    await db.collection('users').add({ data: { _openid: openid, orgId, orgIds: [orgId], createdAt: db.serverDate() } });
  } else if (orgsOf(had).indexOf(String(orgId)) < 0) {
    // 第二家机构：追加一张工牌，不动主机构。
    // 【为什么不再拒绝】以前这里直接回 ORG_BOUND，等于"一个老师只能在第一家机构任教"。
    // 现在改成追加：数据仍然按 orgId 物理隔离，多出来的只是"这个人还能进另一家"。
    const mine = orgsOf(had).concat([String(orgId)]);
    await db.collection('users').doc(had._id).update({ data: { orgIds: mine } });
  }
  // 同一个人在同一个机构只留一条成员关系：重复加入（换手机、换微信重进）就地更新
  const exist = await memberOf(openid, orgId);
  let doc;
  if (exist) {
    doc = Object.assign({}, exist, {
      name, role: exist.role === 'owner' ? 'owner' : role,
      studentIds: kids.length ? kids : (exist.studentIds || []),
      status: status || 'active', updatedAt: now, srvAt: now
    });
    delete doc._id;
    await db.collection('members').doc(exist._id).update({ data: doc });
  } else {
    const id = newMemberId();
    doc = {
      id, orgId, userId: 'x' + id, openid,
      role, name,
      clsIds: [], courseIds: [], studentIds: kids,
      status: status || 'active', phone: '', wechat: '', photo: '',
      createdAt: now, updatedAt: now, srvAt: now
    };
    await db.collection('members').add({ data: doc });
  }
  return { ok: true, orgId, member: doc };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, msg: '未登录，拒绝调用' };
  const action = event && event.action;

  if (action === 'hello') {
    const want = String(event.orgId || '').slice(0, 64);
    const u = await userOf(OPENID);
    if (u) {
      const mine = orgsOf(u);
      // 客户端点名了某一家且我确实有那张工牌 → 就用它（切换机构后重新对齐）。
      // 点名的不是我家的（改参数/手工构造）→ 落回主机构，绝不因为客户端说了算就换空间。
      const pick = want && mine.indexOf(want) > -1 ? want : mine[0];
      return { ok: true, orgId: pick, orgIds: mine, firstTime: false, openid: OPENID };
    }
    if (!want) return { ok: false, msg: '缺少机构标识' };
    // 出厂号不是真实机构号：发一个新的，客户端会把本机数据整体改挂过来（minted=true）。
    // 这条分支只会在"这台设备第一次上云"时走到，云端这个号下一条数据都没有，改挂是安全的。
    const minted = want === FACTORY_ORG;
    const orgId = minted ? newOrgId() : want;
    await db.collection('users').add({ data: { _openid: OPENID, orgId, orgIds: [orgId], createdAt: db.serverDate() } });
    return { ok: true, orgId, orgIds: [orgId], firstTime: true, minted, openid: OPENID };
  }

  // 只读探测：这个微信绑过机构吗？换手机/重装时客户端用它判断"该恢复还是该从零开始"，
  // 不能在探测阶段就建立绑定——那会让新装家长的微信号被绑到出厂机构上，再也加入不了真正的机构。
  if (action === 'whoami') {
    const u = await userOf(OPENID);
    // openid 一起带回去：恢复数据后要靠它认出"我是成员表里的谁"，
    // 否则数据拉下来了却因为查不到身份而一条都看不见（actor 为空 → 权限过滤全挡）。
    return { ok: true, bound: !!u, orgId: u ? String(u.orgId) : '', orgIds: u ? orgsOf(u) : [], openid: OPENID };
  }

  // 我能进入的机构清单：顶部切换器与"加入新机构"判断都靠它。
  // 不需要已绑定（没有工牌时返回空数组，客户端据此显示"还没有加入任何机构"）。
  if (action === 'myOrgs') {
    const u = await userOf(OPENID);
    if (!u) return { ok: true, orgs: [], openid: OPENID };
    const out = [];
    for (const oid of orgsOf(u)) {
      const m = await memberOf(OPENID, oid);
      // 机构名从 orgs 集合取；机构还没同步上来时留空，客户端显示机构号后 6 位
      const o = await db.collection('orgs').where({ id: oid }).limit(1).get().catch(() => ({ data: [] }));
      out.push({
        orgId: oid,
        orgName: (o.data[0] && o.data[0].name) || '',
        role: (m && m.role) || '',
        status: (m && m.status) || '',
        memberId: (m && m.id) || 0
      });
    }
    return { ok: true, orgs: out, openid: OPENID };
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

    // 家长必须提供学号：孩子是谁，由机构自己发的号来定，不让家长自由勾选别人的孩子
    let kids = [];
    if (d.role === 'parent') {
      const got = await kidsFor(d.orgId, { stuNo: event.stuNo });
      if (got.err) return got.err;
      kids = got.kids;
    }
    const out = await finishJoin(d.orgId, d.role, OPENID, name, kids, 'active');
    if (!out.ok) return out;
    // 用量只做记录，不限制次数（一个机构码本来就该给全班家长用）
    await db.collection(INVITES).doc(code).update({
      data: { uses: (Number(d.uses) || 0) + 1, lastAt: Date.now() }
    }).catch(() => {});
    return out;
  }

  // ---- 家长邀请卡：这两个动作也必须在"已绑定机构"之前（家长还没加入） ----
  if (action === 'cardInfo') {
    const token = String(event.token || '').trim().toLowerCase();
    const got = await readCard(token);
    if (got.err) return got.err;
    const d = got.d;
    if (d.status !== 'unused') return { ok: false, code: 'USED', msg: '这张卡片已被确认过，请让老师重发' };
    // 只回卡面需要的三个名字：不回学号、不回手机号、不回邀请码，也不回任何业务数据。
    // 群里谁都能点开卡片，这里多返回一个字段就是多泄露一份全班信息。
    return {
      ok: true, orgName: String(d.orgName || '该机构'), clsName: String(d.clsName || ''),
      stuName: String(d.stuName || '孩子'), expiresAt: Number(d.expiresAt) || 0
    };
  }

  if (action === 'cardClaim') {
    const token = String(event.token || '').trim().toLowerCase();
    const name = String(event.name || '').trim().slice(0, 20);
    if (!name) return { ok: false, code: 'NO_NAME', msg: '请填写你的姓名' };
    const got = await readCard(token);
    if (got.err) return got.err;
    const d = got.d;
    if (d.status !== 'unused') return { ok: false, code: 'USED', msg: '这张卡片已被确认过，请让老师重发' };

    // ---- 同一个孩子识别：必须放在消耗卡片之前 ----
    // 家长可能还要想一想；先把卡标成已用，他就再也确认不了了。
    const kidGot = await kidsFor(d.orgId, { studentId: d.sid });
    if (kidGot.err) return kidGot.err;
    const target = kidGot.kid || {};
    const u0 = await userOf(OPENID);
    const mine = u0 ? await findMyKids(OPENID, orgsOf(u0)) : [];
    // 排除这张卡上的孩子本身（重复点同一张卡、或他本来就绑在这一家）
    const others = mine.filter(k => !(String(k.orgId) === String(d.orgId) && Number(k.sid) === Number(target.id)));
    const cand = others.find(k => sameKid(k, {
      name: target.name, pid: target.pid, phone: target.parentPhone, wechat: target.wechat
    })) || null;

    // merge 三种取值：
    //   ''      第一次调用 —— 有候选就停下来问家长
    //   'new'   家长说不是同一个（比如老二恰巧同名）
    //   <pid>   家长确认是同一个孩子 —— 归并到这条平台身份
    const merge = String(event.merge || '');
    if (cand && !merge) {
      // 老数据没有 pid：先给那条补一个，否则家长确认时没有东西可传回，会原地打转
      if (!cand.pid) {
        const fresh = newPid();
        if (await setStudentsPid(cand.orgId, [cand.sid], fresh)) cand.pid = fresh;
      }
      if (cand.pid) {
        // 机构名一起回去：家长要看到"你已经在【XX 机构】绑过张小明"才判断得了
        const so = await db.collection('orgs').where({ id: String(cand.orgId) }).limit(1)
          .get().catch(() => ({ data: [] }));
        return {
          ok: false, code: 'SAME_KID', needConfirm: true,
          pid: String(cand.pid), sameName: String(cand.name || ''),
          sameOrgId: String(cand.orgId || ''), sameOrgName: (so.data[0] && so.data[0].name) || '',
          stuName: String(target.name || '')
        };
      }
    }
    // 回传的 pid 必须是我自己孩子身上的那个（过期/伪造一律重来），
    // 否则等于给了别人一条"把自家孩子并到别人孩子名下"的路
    if (cand && merge && merge !== 'new' && merge !== String(cand.pid)) {
      return { ok: false, code: 'STALE_MERGE', msg: '确认信息已失效，请重新打开卡片再试一次' };
    }

    // 一次性：条件更新，谁先改成功谁拿到。两个人同时点同一张卡也只会有一个生效，
    // 先读后写在这种并发下会双双通过 —— 那正是群发场景最怕的冒领。
    const upd = await db.collection(CARDS).where({ _id: token, status: 'unused' })
      .update({ data: { status: 'claimed', usedAt: Date.now(), usedBy: OPENID, claimName: name } })
      .catch(() => ({ stats: { updated: 0 } }));
    if (!upd || !upd.stats || upd.stats.updated !== 1) {
      return { ok: false, code: 'USED', msg: '这张卡片已被确认过，请让老师重发' };
    }
    const rollback = () => db.collection(CARDS).doc(token).update({
      data: { status: 'unused', usedAt: 0, usedBy: '', claimName: '' }
    }).catch(() => {});

    // 最终落到这个孩子身上的平台身份
    const pid = (cand && merge !== 'new' && merge) ? String(cand.pid) : newPid();

    // 令牌在服务端换回具体孩子，家长端从头到尾没见过码和学号
    const out = await finishJoin(d.orgId, 'parent', OPENID, name, kidGot.kids, 'active');
    if (!out.ok) { await rollback(); return out; }
    // pid 只落到这张卡上的那个孩子：kidsFor 里多出来的是兄弟姐妹，
    // 他们是同一家长的不同孩子，各自该有各自的平台身份。
    const pidOk = await setStudentsPid(d.orgId, [target.id], pid);
    await db.collection(CARDS).doc(token).update({
      data: { status: 'approved', approvedAt: Date.now(), pid: pidOk ? pid : '' }
    }).catch(() => {});
    return Object.assign({}, out, { sid: d.sid, pid: pidOk ? pid : '', merged: !!(cand && merge && merge !== 'new') });
  }

  const u = await userOf(OPENID);
  if (!u) return { ok: false, code: 'NO_BIND', msg: '账号未绑定机构，请先 hello' };
  const orgId = String(event.orgId || '');
  // 【多机构】校验的是"我有没有这一家的工牌"，不是"这是不是我唯一那家"。
  // 一个老师可以在两家任教，但能进 A 不代表能进 B —— 没工牌照样 fail-closed。
  if (orgsOf(u).indexOf(orgId) < 0) return { ok: false, code: 'FORBIDDEN', msg: '无权访问该机构数据' };

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

  // ---- 老师端发卡 / 作废（已绑定机构才可调，权限按成员表判） ----
  if (action === 'cardCreate') {
    const sid = Number(event.sid) || 0;
    if (!sid) return { ok: false, code: 'NO_STU', msg: '请先选择学生' };
    const me = await memberOf(OPENID, orgId);
    if (!me) return { ok: false, code: 'NO_MEMBER', msg: '本账号不在该机构成员表里' };
    const isManager = me.role === 'owner' || me.role === 'admin';
    if (!isManager && me.role !== 'teacher') {
      return { ok: false, code: 'FORBIDDEN', msg: '没有发卡权限' };
    }
    // 学生必须已同步上云；刚建好还没推上去时给一句能照做的提示，而不是"不存在"
    const sr = await db.collection('students').where({ orgId, id: sid }).limit(5).get().catch(() => ({ data: [] }));
    const s = sr.data.filter(x => !x.removed)[0];
    if (!s) return { ok: false, code: 'NO_STUDENT', msg: '云端还没有这个学生，请先同步一轮再发卡' };
    // 老师只能给自己带的班发家长卡（负责人/管理员不限）
    if (!isManager) {
      const clsIds = (s.clsIds || []).map(Number);
      const mine = (me.clsIds || []).map(Number);
      if (!clsIds.some(c => mine.indexOf(c) > -1)) {
        return { ok: false, code: 'FORBIDDEN', msg: '只能给自己班上的学生发卡' };
      }
    }
    const code = await parentCode(orgId, OPENID);
    if (!code) return { ok: false, msg: '邀请码生成失败，请重试' };
    // 卡面三个名字在创建时固化：家长点开时不必再查业务表，也不会因改名而查不到
    let orgName = '', clsName = '';
    const o = await db.collection('orgs').where({ id: orgId }).limit(1).get().catch(() => ({ data: [] }));
    orgName = (o.data[0] && o.data[0].name) || '';
    const cid = Number((s.clsIds || [])[0]) || 0;
    if (cid) {
      const cr = await db.collection('classes').where({ orgId, id: cid }).limit(1).get().catch(() => ({ data: [] }));
      clsName = (cr.data[0] && cr.data[0].name) || '';
    }
    const stuName = String(s.name || '孩子');
    await ensureCollections();
    let token = '', expiresAt = 0;
    for (let i = 0; i < 5; i++) {
      const t = newCardToken();
      const dup = await db.collection(CARDS).doc(t).get().catch(() => null);
      if (dup && dup.data) continue;
      const now = Date.now();
      expiresAt = now + CARD_DAYS * 86400000;
      // token 就是文档 _id；data 里绝不能带 _id（云端会报 -501007 不能更新 _id）
      await db.collection(CARDS).doc(t).set({ data: {
        orgId, clsId: cid, sid, code, role: 'parent',
        stuNo: String(s.no || ''), orgName, clsName, stuName,
        expiresAt, usedAt: 0, usedBy: '', claimName: '', claimPhone: '',
        status: 'unused', by: OPENID, createdAt: now
      } });
      token = t;
      break;
    }
    if (!token) return { ok: false, msg: '卡片生成失败，请重试' };
    return { ok: true, token, orgName, clsName, stuName, expiresAt };
  }

  if (action === 'cardRevoke') {
    const token = String(event.token || '').trim().toLowerCase();
    if (!CARD_RE.test(token)) return { ok: false, code: 'BAD_CARD', msg: '卡片链接不对' };
    const r = await db.collection(CARDS).doc(token).get().catch(() => null);
    const d = r && r.data;
    if (!d) return { ok: false, code: 'NO_CARD', msg: '这张卡片不存在' };
    const me = await memberOf(OPENID, orgId);
    const isManager = !!me && (me.role === 'owner' || me.role === 'admin');
    if (d.by !== OPENID && !isManager) {
      return { ok: false, code: 'FORBIDDEN', msg: '只能作废自己发的卡片' };
    }
    if (d.status !== 'unused') {
      return { ok: false, code: 'USED', msg: '这张卡片已被确认，作废不会移除已加入的家长' };
    }
    await db.collection(CARDS).doc(token).update({
      data: { status: 'revoked', revokedAt: Date.now(), revokedBy: OPENID }
    });
    return { ok: true };
  }

  // ---- 版本历史：某条核心资产改过什么 / 退回某一版 ----
  // 为什么在云端做：手机里的旧版本会随下一次覆盖消失，只有服务端见过"改之前长什么样"。
  if (action === 'history' || action === 'revert') {
    const c = String(event.c || '');
    const id = Number(event.id) || 0;
    if (HIST_COLLS.indexOf(c) < 0) return { ok: false, code: 'BAD_COLL', msg: '这类数据没有历史版本' };
    if (!id) return { ok: false, code: 'BAD_ID', msg: '缺少数据标识' };
    const me = await memberOf(OPENID, orgId);
    // 家长能看到的是自家孩子发布后的评语；翻改档记录、回滚档案必须是有管理权限的人
    if (!me || me.role === 'parent') return { ok: false, code: 'FORBIDDEN', msg: '没有权限' };

    const hs = await db.collection(HISTORY).where({ orgId, c, id }).limit(50).get();
    const items = hs.data
      .map(h => ({ at: Number(h.at) || 0, by: String(h.by || ''), doc: h.doc || {} }))
      .sort((a, b) => b.at - a.at);
    if (action === 'history') return { ok: true, items, kept: HIST_KEEP };

    const at = Number(event.at) || 0;
    const hit = items.find(x => x.at === at);
    if (!hit) return { ok: false, code: 'NO_VERSION', msg: '这一版已被清理掉' };
    if ((c === 'members' || c === 'orgs') && me.role !== 'owner' && me.role !== 'admin') {
      return { ok: false, code: 'FORBIDDEN', msg: '只有管理员能还原成员或机构' };
    }
    const cur = await db.collection(c).where({ orgId, id }).limit(1).get();
    if (!cur.data.length) return { ok: false, code: 'GONE', msg: '云端已经没有这条数据' };
    const back = Object.assign({}, hit.doc, { orgId, id, updatedAt: Date.now(), srvAt: nextSrvAt() });
    delete back._id; delete back._openid;
    // 回滚出来的内容同样要过一遍硬约束：老版本里可能有当时合法、现在冲突的值
    const bad = await checkCore(c, back, orgId);
    if (bad) return { ok: false, code: bad.code, msg: bad.msg };
    // 回滚本身也是一次改动：先把当前值留一版，滚错了还能再滚回来
    await keepHistory(orgId, c, id, cur.data[0], OPENID);
    await db.collection(c).doc(cur.data[0]._id).update({ data: back });
    return { ok: true, c, id, at };
  }

  if (action === 'push') {
    const docs = Array.isArray(event.docs) ? event.docs.slice(0, 100) : [];
    const now = Date.now();
    // 【每条一个 srvAt，不能整批共用一个时间戳】
    // 整批共用 now 时，一次 push 100 条会产生 100 条 srvAt 完全相同的文档；
    // 而 pull 是「srvAt > since，每次 100 条」，游标推到这一毫秒后，
    // 同一毫秒里没取到的那些就永远拉不到了 —— 静默丢数据，且没有任何报错。
    // 这里让它在一批内严格递增，pull 端的游标就能一条条推进。
    // 同实例内上一次用到的时间戳：同一毫秒的两次 push 也不会撞号（跨实例靠 pull 端的组保护兜底）
    let at = now > lastSrvAt ? now : lastSrvAt + 1;
    let accepted = 0, newer = 0, denied = 0;
    // 被服务端拒绝的改动要回传给客户端：静默丢弃等于让人以为改成功了
    const rejected = [];
    const mine = await memberOf(OPENID, orgId);
    const isMgr = !!mine && (mine.role === 'owner' || mine.role === 'admin');
    for (const it of docs) {
      const c = String((it && it.c) || '');
      let d = it && it.d;
      if (COLLS.indexOf(c) < 0 || !d || d.id === undefined || d.id === null) continue;
      // 核心资产的硬约束（机构不可删、学号不重、一个微信一条成员、一个机构一个负责人）
      const bad = await checkCore(c, d, orgId);
      if (bad) { rejected.push({ c, id: d.id, code: bad.code, msg: bad.msg }); continue; }
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
        // 核心资产：内容真的变了就先留一版旧值，改错了能退回去
        if (HIST_COLLS.indexOf(c) > -1 && !sameContent(found.data[0], d)) {
          await keepHistory(orgId, c, d.id, found.data[0], OPENID);
        }
        await col.doc(found.data[0]._id).update({
          data: Object.assign({}, d, { orgId, srvAt: at })
        });
      } else {
        await col.add({ data: Object.assign({}, d, { orgId, srvAt: at }) });
      }
      lastSrvAt = at;
      at++;
      accepted++;
    }
    return { ok: true, accepted, newer, denied, rejected };
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
        // 必须按 srvAt 升序：没有排序时数据库返回顺序不确定，取到的 100 条可能是
        // 一段时间里最晚的那些，游标一推就越过了中间没取到的数据（下面的截断保护只能兜住
        // 同一毫秒的边界，兜不住这种跳跃）。升序 + 复合索引（orgId, srvAt）才是增量拉取的形状。
        r = await db.collection(c).where({ orgId, srvAt: _.gt(since) })
          .orderBy('srvAt', 'asc').limit(PAGE).get();
      } catch (e) {
        await ensureCollections();
        continue;
      }
      if (!r.data.length) continue;

      let batch = r.data;
      let maxAt = 0;
      batch.forEach(d => { const v = Number(d.srvAt) || 0; if (v > maxAt) maxAt = v; });

      /* ---------------- 截断保护 ----------------
       * 这批正好取满 100 条，说明后面很可能还有。此时不能简单把游标推到本批最大值：
       * 万一 maxAt 那一组还有没取到的（同一毫秒写入的、或老数据），
       * "srvAt > maxAt" 就会把它们永久跳过 —— 数据明明在云端，客户端却再也拉不到，
       * 而且两端都不报错，只有老师发现"少了几条"时才可能察觉。
       * 做法：先确认 maxAt 这一组是否完整；不完整就整组退回，游标停在它之前。 */
      if (batch.length >= PAGE) {
        more = true;
        const got = batch.filter(d => (Number(d.srvAt) || 0) === maxAt).length;
        let total = got;
        try {
          const cnt = await db.collection(c).where({ orgId, srvAt: maxAt }).count();
          total = Number(cnt && cnt.total) || got;
        } catch (e) { total = got; }
        if (total > got) {
          const rest = batch.filter(d => (Number(d.srvAt) || 0) < maxAt);
          if (rest.length) {
            // 整组退回：只交出严格小于 maxAt 的部分，下次用同一个边界再来
            batch = rest;
            maxAt = 0;
            batch.forEach(d => { const v = Number(d.srvAt) || 0; if (v > maxAt) maxAt = v; });
          } else {
            // 极端情况：整页都是同一时间戳且还没取完（新写入已经不会产生这种数据，
            // 只可能来自旧版本或外部批量导入）。退回会导致永远拉不动，所以照常返回并留日志。
            console.warn('[syncv2] 同一 srvAt 的文档超过单页上限，可能漏拉', c, maxAt, total);
          }
        }
      }

      batch.forEach(d => {
        const { _id, srvAt, ...rest } = d;
        // srvAt 单独带在条目上（不进文档本体，免得回推时污染数据）
        docs.push({ c, d: rest, srvAt: srvAt || 0 });
        if ((srvAt || 0) > cursor) cursor = srvAt || 0;
      });
    }
    return { ok: true, docs, cursor, more };
  }

  return { ok: false, msg: '未知 action' };
};
