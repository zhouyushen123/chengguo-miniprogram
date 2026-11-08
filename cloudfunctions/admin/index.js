// cloudfunctions/admin —— 电脑端后台（HTTP 访问服务 + 小程序内取口令）
//
// 【为什么是一个云函数而不是"静态站 + 接口"】老师/负责人要的是"打开浏览器就能用"，
// 不想学部署。云开发的 HTTP 访问服务给一个固定网址，前端 HTML 直接塞在函数目录里
// 由同一个函数返回：一次上传部署，网址就能用，不用开静态托管、不用配域名、不用管 CORS。
//
// 【身份】后台不走微信登录（浏览器里拿不到 openid），用「后台账号 + 6 位口令」：
//   · 账号口令由小程序「我的 → 电脑端后台」在服务端生成（只有负责人/管理员能看）
//   · 登录换 token（7 天），token 存 admin_sessions，口令错 5 次锁 10 分钟
//   · 所有读写都带 orgId，接口层面没有"跨机构"这个入口
//
// 【和小程序的一致性】后台改数据必须盖新的 updatedAt + srvAt：前者让 LWW 判定后台更新，
// 后者让小程序 pull 的增量游标能捞到这次改动。少一个，改动就只停在云端，手机上看不见。
const cloud = require('wx-server-sdk');
const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const plat = require('./platform');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const ACCOUNTS = 'admin_accounts';
const SESSIONS = 'admin_sessions';
const PAGE = 100;      // 云数据库单次 get 的上限
const COL = {
  students: 'students', classes: 'classes', records: 'records', members: 'members'
};

/* ============================ 小工具 ============================ */
const now = () => Date.now();
const str = v => (v === undefined || v === null ? '' : String(v));
// 本地日期（不能 toISOString：那是 UTC，早上 8 点前会算成昨天，补录的日期就错一天）
function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type,authorization',
      'access-control-allow-methods': 'POST,GET,OPTIONS'
    },
    body: JSON.stringify(obj)
  };
}
function htmlResp(html) {
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    body: html
  };
}
// 集合不存在（新环境第一次用）→ 建一次再重试，避免用户被"collection not exists"劝退
async function ensure(coll) {
  try { await db.createCollection(coll); } catch (e) { /* 已存在 */ }
}
async function findAll(coll, where, max) {
  const out = [];
  const cap = Math.min(Number(max) || 1000, 5000);
  for (let skip = 0; skip < cap; skip += PAGE) {
    let r;
    try {
      r = await db.collection(coll).where(where).skip(skip).limit(PAGE).get();
    } catch (e) {
      await ensure(coll);
      r = { data: [] };
    }
    out.push.apply(out, r.data || []);
    if ((r.data || []).length < PAGE) break;
  }
  return out;
}
async function countOf(coll, where) {
  try {
    const r = await db.collection(coll).where(where).count();
    return r.total || 0;
  } catch (e) { return 0; }
}
const alive = orgId => ({ orgId, removed: _.neq(true) });

/* ============================ 账号与登录 ============================ */
// 小程序里取后台账号：只有本机构的负责人/管理员能拿。角色以 members 表为准，不信客户端。
async function mkAccount(openid) {
  if (!openid) return { ok: false, code: 'NO_LOGIN', msg: '请在微信小程序内打开' };
  let mem = [];
  try {
    const r = await db.collection('members').where({ openid }).limit(5).get();
    mem = (r.data || []).filter(m => !m.removed && (m.role === 'owner' || m.role === 'admin'));
  } catch (e) {
    await ensure('members');
  }
  if (!mem.length) return { ok: false, code: 'FORBIDDEN', msg: '只有机构负责人/管理员能打开电脑端后台' };
  const me = mem[0];
  const orgId = str(me.orgId);
  let acc = null;
  try {
    const r = await db.collection(ACCOUNTS).where({ orgId }).limit(1).get();
    acc = (r.data || [])[0] || null;
  } catch (e) {
    await ensure(ACCOUNTS);
  }
  // 没账号就发一个；有就原样返回（同事换手机、换人接手都靠这一份，不要每次刷新就变）
  if (!acc) {
    for (let i = 0; i < 5; i++) {
      const account = lib.newAccount();
      const dup = await db.collection(ACCOUNTS).doc(account).get().catch(() => null);
      if (dup && dup.data) continue;
      // doc(id).set 的 data 里绝对不能带 _id：云数据库会报 -501007
      // 「invalid parameters. 不能更新 _id」，函数抛错 → 客户端只看到「网络不通」。
      // backup.saveManifest 早就 delete data._id 避开了，这里曾漏掉。
      const doc = {
        account, orgId, pin: lib.newPin(),
        fail: 0, lockUntil: 0, createdAt: now(), by: openid
      };
      await db.collection(ACCOUNTS).doc(account).set({ data: doc });
      acc = doc;   // 后面只用 account / pin，不需要本地补 _id
      break;
    }
    if (!acc) return { ok: false, msg: '后台账号生成失败，请重试' };
  }
  let orgName = '';
  try {
    const o = await db.collection('orgs').where({ id: orgId }).limit(1).get();
    orgName = (o.data[0] && o.data[0].name) || '';
  } catch (e) { /* 机构名还没同步上去也不影响登录 */ }
  return { ok: true, account: acc.account, pin: acc.pin, orgId, orgName, url: lib.adminUrl(process.env.ADMIN_ENV || '') };
}

// 重置口令：负责人手上那份丢了（换人、被同事改过）时用，旧口令立刻失效
async function resetPin(orgId) {
  const r = await db.collection(ACCOUNTS).where({ orgId }).limit(1).get().catch(() => ({ data: [] }));
  const acc = (r.data || [])[0];
  if (!acc) return { ok: false, msg: '还没有后台账号，请先在小程序里打开一次「电脑端后台」' };
  const pin = lib.newPin();
  await db.collection(ACCOUNTS).doc(acc._id).update({ data: { pin, fail: 0, lockUntil: 0, resetAt: now() } });
  // 口令换了，所有旧会话一起作废——否则改了等于没改
  await db.collection(SESSIONS).where({ account: acc._id }).remove().catch(() => {});
  return { ok: true, account: acc.account, pin };
}

async function doLogin(data) {
  const account = lib.normAccount(data.account);
  if (!lib.isAccount(account)) return { ok: false, code: 'BAD_INPUT', msg: '后台账号是 6 位字母数字' };
  let rec = null;
  try {
    const r = await db.collection(ACCOUNTS).doc(account).get();
    rec = r && r.data;
  } catch (e) { rec = null; }
  // 账号不存在和口令错误回同一句话，不告诉对方"账号对了、口令错了"
  if (!rec) return { ok: false, code: 'BAD_PIN', msg: '账号或口令不对' };
  const t = now();
  const lock = lib.lockedUntil(rec, t);
  if (lock) return { ok: false, code: 'LOCKED', until: lock, msg: '试错了太多次，请 ' + Math.ceil((lock - t) / 60000) + ' 分钟后再试' };
  if (str(data.pin).trim() !== str(rec.pin)) {
    const next = lib.afterFail(rec, t);
    await db.collection(ACCOUNTS).doc(account).update({ data: next }).catch(() => {});
    if (next.lockUntil) return { ok: false, code: 'LOCKED', until: next.lockUntil, msg: '试错了太多次，请 10 分钟后再试' };
    return { ok: false, code: 'BAD_PIN', msg: '账号或口令不对' };
  }
  const token = lib.newToken();
  await ensure(SESSIONS).catch(() => {});
  // 同上：会话也用 doc(token).set，data 不带 _id（改 add 为 set 只是统一写法，token 随机唯一）
  await db.collection(SESSIONS).doc(token).set({
    data: { token, account, orgId: str(rec.orgId), exp: t + lib.SESSION_MS, at: t }
  });
  await db.collection(ACCOUNTS).doc(account).update({ data: { fail: 0, lockUntil: 0, lastAt: t } }).catch(() => {});
  let orgName = '';
  try {
    const o = await db.collection('orgs').where({ id: str(rec.orgId) }).limit(1).get();
    orgName = (o.data[0] && o.data[0].name) || '';
  } catch (e) { /* 忽略 */ }
  return { ok: true, token, account, orgId: str(rec.orgId), orgName, exp: t + lib.SESSION_MS };
}

async function auth(headers) {
  const h = headers || {};
  const raw = h.authorization || h.Authorization || '';
  const token = str(raw).replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const r = await db.collection(SESSIONS).doc(token).get();
    const s = r && r.data;
    if (!s || Number(s.exp) < now()) return null;
    return s;
  } catch (e) { return null; }
}

/* ============================ 读取 ============================ */
// 列表：翻页 + 关键字。云数据库的正则只走服务器，别在前端过滤——一页 50 条在前端过滤会漏。
async function listData(orgId, data) {
  const coll = COL[str(data.col)] ? str(data.col) : '';
  if (!coll) return { ok: false, msg: '未知的数据类型' };
  const { page, size, skip } = lib.normPage(data);
  const where = alive(orgId);
  const kw = str(data.q).trim();

  if (coll === 'records') {
    if (data.cid) where.cid = Number(data.cid);
    if (data.sid) where.sid = Number(data.sid);
    if (data.session) where.session = Number(data.session);
    if (data.from || data.to) {
      where.date = _.gte(str(data.from) || '0000-00-00').and(_.lte(str(data.to) || '9999-99-99'));
    }
    if (kw) where.note = db.RegExp({ regexp: kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' });
  } else if (coll === 'students') {
    if (data.clsId) where.clsIds = Number(data.clsId);
    if (kw) where.name = db.RegExp({ regexp: kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' });
  } else if (coll === 'classes') {
    if (data.termId) where.termId = Number(data.termId);
    if (kw) where.name = db.RegExp({ regexp: kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' });
  }

  const total = await countOf(coll, where);
  let rows = [];
  try {
    const r = await db.collection(coll).where(where).orderBy('id', 'desc').skip(skip).limit(size).get();
    rows = r.data || [];
  } catch (e) {
    await ensure(coll);
  }
  // 名字字段：记录/班级页要显示"谁、哪个班"，前端拿着 id 干瞪眼
  const names = { students: {}, classes: {} };
  if (coll === 'records') {
    const ss = await findAll('students', alive(orgId), 2000);
    ss.forEach(s => { names.students[s.id] = s.name; });
    const cs = await findAll('classes', alive(orgId), 500);
    cs.forEach(c => { names.classes[c.id] = c.name; });
  }
  return { ok: true, col: coll, total, page, size, rows, names };
}

async function overview(orgId) {
  const [stu, cls, rec, mem] = await Promise.all([
    countOf('students', alive(orgId)), countOf('classes', alive(orgId)),
    countOf('records', alive(orgId)), countOf('members', alive(orgId))
  ]);
  const all = await findAll('records', alive(orgId), 5000);
  const today = new Date();
  const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    days.push({ d: ymd(d), n: all.filter(r => r.date === ymd(d)).length });
  }
  const sent = all.filter(r => r.sent).length;
  const photos = all.reduce((n, r) => n + ((r.photos || []).length), 0);
  return {
    ok: true,
    stat: { students: stu, classes: cls, records: rec, members: mem, sent, draft: rec - sent, photos, rate: lib.pct(sent, rec) },
    days,
    recent: all.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 8)
  };
}

/* ============================ 写入 ============================ */
async function updateData(orgId, data) {
  const coll = COL[str(data.col)] ? str(data.col) : '';
  const allow = lib.EDIT[coll];
  if (!coll || !allow) return { ok: false, msg: '这一类数据不支持在后台修改' };
  const id = Number(data.id);
  if (!id) return { ok: false, msg: '缺少要修改的记录' };
  const patch = lib.safePatch(data.patch, allow);
  if (!Object.keys(patch).length) return { ok: false, msg: '没有要改的内容' };
  if (patch.name !== undefined && !str(patch.name).trim()) return { ok: false, msg: '名称不能为空' };
  const t = now();
  const found = await db.collection(coll).where({ orgId, id }).limit(1).get().catch(() => ({ data: [] }));
  const doc = (found.data || [])[0];
  if (!doc) return { ok: false, msg: '这条数据不在本机构（或已被删除）' };
  // srvAt 必须给：小程序 pull 只认 srvAt 增量，不给就"改了但手机上看不见"
  await db.collection(coll).doc(doc._id).update({
    data: Object.assign({}, patch, { updatedAt: t, srvAt: t, removed: false })
  });
  return { ok: true, id, patch };
}

async function removeData(orgId, data) {
  const coll = COL[str(data.col)] ? str(data.col) : '';
  if (coll !== 'students' && coll !== 'records') return { ok: false, msg: '这一类数据不支持删除' };
  const id = Number(data.id);
  if (!id) return { ok: false, msg: '缺少要删除的记录' };
  const t = now();
  const found = await db.collection(coll).where({ orgId, id }).limit(1).get().catch(() => ({ data: [] }));
  const doc = (found.data || [])[0];
  if (!doc) return { ok: false, msg: '这条数据不在本机构（或已被删除）' };
  // 软删：小程序端靠 removed 字段同步"这条没了"，硬删会让另一端的同步游标捞不到
  await db.collection(coll).doc(doc._id).update({ data: { removed: true, updatedAt: t, srvAt: t } });
  return { ok: true, id, removed: true };
}

async function nextStudentNo(orgId) {
  const ss = await findAll('students', { orgId }, 2000);
  let max = 1000;
  ss.forEach(s => { const n = Number(s.no); if (isFinite(n) && n > max) max = n; });
  return String(max + 1);
}

async function createData(orgId, data) {
  const coll = COL[str(data.col)] ? str(data.col) : '';
  const allow = lib.CREATE[coll];
  if (!coll || !allow) return { ok: false, msg: '这一类数据不支持在后台新建' };
  const src = lib.safePatch(data.data, allow);
  const t = now();
  if (coll === 'students') {
    if (!str(src.name).trim()) return { ok: false, msg: '请填写学生姓名' };
    const doc = {
      id: t, orgId, name: str(src.name).trim(), no: await nextStudentNo(orgId),
      gender: src.gender === '男' || src.gender === '女' ? src.gender : '',
      enrollYear: Number(src.enrollYear) || new Date().getFullYear(),
      clsIds: (Array.isArray(src.clsIds) ? src.clsIds : []).map(Number).filter(Boolean),
      parent: str(src.parent).trim(), wechat: str(src.wechat).trim(),
      photo: '', profile: {}, demo: false,
      createdAt: t, updatedAt: t, srvAt: t, removed: false
    };
    await db.collection('students').add({ data: doc });
    return { ok: true, doc };
  }
  // 记录：后台补录（老师上课来不及录时，回办公室用电脑补）
  const sid = Number(src.sid);
  if (!sid) return { ok: false, msg: '请选择学生' };
  const stu = (await db.collection('students').where({ orgId, id: sid }).limit(1).get().catch(() => ({ data: [] }))).data[0];
  if (!stu) return { ok: false, msg: '学生不在本机构' };
  const cid = Number(src.cid) || Number((stu.clsIds || [])[0]) || 0;
  if (!cid) return { ok: false, msg: '这个学生还没分班，请先在小程序里分班' };
  const clsDoc = (await db.collection('classes').where({ orgId, id: cid }).limit(1).get().catch(() => ({ data: [] }))).data[0];
  const doc = {
    id: t, orgId, type: 'achievement', sid, cid, courseId: 0, course: '',
    date: str(src.date) || today(),
    score: Number(src.score) || 0, tag: str(src.tag).trim(), note: str(src.note),
    photos: [], videos: [], audio: null, sent: false,
    session: Number(src.session) || Number((clsDoc && clsDoc.session) || 1),
    tid: '', demo: false, createdAt: t, updatedAt: t, srvAt: t, removed: false
  };
  await db.collection('records').add({ data: doc });
  return { ok: true, doc };
}

/* ============================ 导出 ============================ */
async function exportData(orgId, data) {
  const coll = str(data.col) === 'students' ? 'students' : 'records';
  const all = await findAll(coll, alive(orgId), lib.MAX_ROWS);
  const clsName = {};
  const stuName = {};
  if (coll === 'records') {
    (await findAll('students', alive(orgId), 2000)).forEach(s => { stuName[s.id] = s.name; });
    (await findAll('classes', alive(orgId), 500)).forEach(c => { clsName[c.id] = c.name; });
  }
  if (coll === 'students') {
    const clsName2 = {};
    (await findAll('classes', alive(orgId), 500)).forEach(c => { clsName2[c.id] = c.name; });
    const rows = all.slice().sort((a, b) => Number(a.no) - Number(b.no));
    const csv = lib.csvOf(rows, [
      { k: 'no', t: '学号' }, { k: 'name', t: '姓名' }, { k: 'gender', t: '性别' },
      { t: '班级', f: r => (r.clsIds || []).map(i => clsName2[i] || i).join('、') },
      { k: 'enrollYear', t: '入学年份' }, { k: 'parent', t: '家长' }, { k: 'wechat', t: '微信/手机' }
    ]);
    return { ok: true, name: '学生名单-' + stamp() + '.csv', csv };
  }
  const rows = all.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  const csv = lib.csvOf(rows, [
    { k: 'date', t: '日期' }, { t: '学生', f: r => stuName[r.sid] || r.sid },
    { t: '班级', f: r => clsName[r.cid] || r.cid }, { k: 'session', t: '课次' },
    { k: 'tag', t: '等级' }, { k: 'score', t: '分数' }, { k: 'note', t: '评语' },
    { t: '照片数', f: r => (r.photos || []).length },
    { t: '发布', f: r => (r.sent ? '已发布' : '草稿') }
  ]);
  return { ok: true, name: '课堂记录-' + stamp() + '.csv', csv };
}
/* ============================ 核心资产：体检与完整备份 ============================ */
const BACKUP_COLLS = ['orgs', 'members', 'terms', 'classes', 'courses', 'class_courses', 'subjects', 'knowledge_points',
  'students', 'enrollments', 'records', 'templates'];
const BACKUP_CAP = 5000;

// 完整备份：一份能直接归档/迁移的 JSON（CSV 只适合看，不适合恢复）
async function backupData(orgId) {
  const data = {};
  const counts = {};
  for (const c of BACKUP_COLLS) {
    // orgs 的主键就是机构号，没有 orgId 外键
    const where = c === 'orgs' ? { id: orgId } : { orgId };
    const rows = await findAll(c, where, BACKUP_CAP);
    data[c] = rows.map(d => {
      const x = Object.assign({}, d);
      delete x._id;      // 云库内标识，不属于业务数据
      delete x.srvAt;    // 同步时间戳，恢复时不该沿用
      return x;
    });
    counts[c] = data[c].length;
  }
  const pack = { format: 'chengguo-backup-v1', at: Date.now(), orgId, counts, data };
  const body = JSON.stringify(pack);
  return {
    ok: true,
    name: '橙果备份-' + stamp() + '.json',
    json: body,
    bytes: Buffer.byteLength(body, 'utf8'),
    counts,
    // 记录超过上限时明确告诉用户"这份不全"，不能让人以为拿到的是全部
    truncated: counts.records >= BACKUP_CAP
  };
}

// 体检：学生 / 成员 / 机构之间的引用是否对得上（只读，不改任何数据）
async function auditData(orgId) {
  const [students, classes, members, records] = await Promise.all([
    findAll('students', alive(orgId), BACKUP_CAP),
    findAll('classes', alive(orgId), 1000),
    findAll('members', alive(orgId), 1000),
    findAll('records', alive(orgId), BACKUP_CAP)
  ]);
  const issue = (k, level, title, count, sample) => ({ k, level, title, count, sample: (sample || []).slice(0, 5) });
  const issues = [];
  const clsId = {}; classes.forEach(c => { clsId[c.id] = 1; });
  const stuId = {}; students.forEach(s => { stuId[s.id] = 1; });

  const byNo = {};
  students.forEach(s => {
    const n = str(s.no).trim();
    if (n) (byNo[n] || (byNo[n] = [])).push(s);
  });
  const dup = [];
  Object.keys(byNo).forEach(n => { if (byNo[n].length > 1) byNo[n].forEach(s => dup.push({ id: s.id, name: s.name, no: s.no })); });
  issues.push(issue('dupNo', 'error', '学号重复（家长凭学号认孩子，重复会认错人）', dup.length, dup));

  const noNo = students.filter(s => !str(s.no).trim());
  issues.push(issue('noNo', 'warn', '学生没有学号', noNo.length, noNo.map(s => ({ id: s.id, name: s.name }))));

  const dangleStu = [];
  students.forEach(s => {
    const bad = (s.clsIds || []).filter(id => !clsId[id]);
    if (bad.length) dangleStu.push({ id: s.id, name: s.name, bad: bad.join(',') });
  });
  issues.push(issue('stuDanglingCls', 'warn', '学生挂在已删除的班级上', dangleStu.length, dangleStu));

  const orphan = records.filter(r => !stuId[r.sid]);
  issues.push(issue('recOrphanStu', 'error', '课堂记录挂在不存在的学生上', orphan.length,
    orphan.map(r => ({ id: r.id, sid: r.sid, date: r.date }))));

  const byOpen = {};
  members.forEach(m => { if (m.openid) (byOpen[m.openid] || (byOpen[m.openid] = [])).push(m); });
  const dupOpen = [];
  Object.keys(byOpen).forEach(k => {
    if (byOpen[k].length > 1) byOpen[k].forEach(m => dupOpen.push({ id: m.id, name: m.name }));
  });
  issues.push(issue('memDupOpenid', 'error', '同一个微信绑定了多个成员（权限会串）', dupOpen.length, dupOpen));

  const orgRows = await findAll('orgs', { id: orgId }, 5);
  const orgMissing = orgRows.filter(x => !x.removed).length === 0;
  issues.push(issue('orgMissing', 'error', '机构档案缺失', orgMissing ? 1 : 0, []));

  const live = issues.filter(x => x.count > 0);
  const errors = live.filter(x => x.level === 'error').length;
  const warns = live.filter(x => x.level === 'warn').length;
  return {
    ok: true,
    at: Date.now(),
    counts: { students: students.length, members: members.length, classes: classes.length, records: records.length },
    issues: live, errors, warns, healthy: !errors && !warns
  };
}

function stamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}

/* ============================ 云端每日备份（backup 云函数） ============================ */
// 后台是"服务端调服务端"，没有 openid；backup 云函数对内部调用信任传入的 orgId，
// 而已登录的会话里本来就带 orgId，所以这里不存在"用户随便指一个机构"的口子。
const CB_COLLS = ['orgs', 'members', 'terms', 'classes', 'courses', 'class_courses', 'subjects', 'knowledge_points',
  'students', 'enrollments', 'records', 'templates'];

function cbCall(orgId, action, extra) {
  const data = Object.assign({ action, orgId }, extra || {});
  return cloud.callFunction({ name: 'backup', data }).then(r => (r && r.result) || { ok: false, msg: '备份函数没有返回' })
    .catch(e => {
      const msg = String((e && (e.errMsg || e.message)) || e);
      // 没部署时给出下一步，而不是一句"调用失败"让人去猜
      if (/FUNCTION_NOT_FOUND|not found|-501000|FunctionName/i.test(msg)) {
        return {
          ok: false, code: 'NO_FN',
          msg: '备份云函数还没部署：请在开发者工具里对 cloudfunctions/backup「上传并部署：云端安装依赖」，并上传定时触发器'
        };
      }
      return { ok: false, code: 'NET', msg: '备份服务调用失败：' + msg };
    });
}

/* ============================ 平台控制台（跨机构，只读） ============================
 * 【和机构后台的区别】机构后台一个会话绑定一个 orgId，接口层没有"跨机构"入口；
 * 平台控制台是给运营/我们自己看的，必须跨机构，所以单独一个 scope，且**只能读**：
 * 写接口一个都不开（下面 api() 里的 default 直接拒），避免"看数据的地方顺手改了数据"。
 *
 * 【登录】平台账号来自函数环境变量 PLATFORM_PIN（不配就关闭登录），不走数据库生成，
 * 因为机构负责人无权给自己发一个"能看全部机构"的账号。
 */
const PLAT_DOC = '__platform__';

async function doPlatformLogin(data) {
  let rec = null;
  try {
    const r = await db.collection(ACCOUNTS).doc(PLAT_DOC).get();
    rec = r && r.data;
  } catch (e) { await ensure(ACCOUNTS); }
  const out = plat.platAuth(data || {}, process.env, rec, now());
  // 失败也要落锁计数，否则环境变量口令可以被无限次试
  if (out.next) {
    await db.collection(ACCOUNTS).doc(PLAT_DOC)
      .set({ data: Object.assign({ account: PLAT_DOC, scope: 'platform' }, out.next) })
      .catch(() => {});
  }
  if (!out.ok) return { ok: false, code: out.code, until: out.until, msg: out.msg };
  const t = now();
  const token = lib.newToken();
  await ensure(SESSIONS).catch(() => {});
  await db.collection(SESSIONS).doc(token).set({
    data: { token, scope: 'platform', account: out.account, exp: t + lib.SESSION_MS, at: t }
  });
  return { ok: true, token, account: out.account, scope: 'platform', exp: t + lib.SESSION_MS };
}

/* ---------- 跨机构聚合 ----------
 * 优先用云数据库 aggregate（一次请求算完，不受单次 100 条限制）；
 * 老环境/权限不支持时退化为扫描并打 sampled 标记 —— 宁可让人看到"这份是抽样"，
 * 也不要静默少算。
 */
async function aggTry(build) {
  try { return await build(); } catch (e) { return null; }
}
async function countByOrg(coll, extra) {
  const $ = db.command.aggregate;
  const where = Object.assign({ removed: _.neq(true) }, extra || {});
  const r = await aggTry(() => db.collection(coll).aggregate()
    .match(where).group({ _id: '$orgId', n: $.sum(1) }).limit(2000).end());
  if (r) {
    const map = {};
    (r.list || []).forEach(x => { if (x._id !== undefined && x._id !== null) map[String(x._id)] = Number(x.n) || 0; });
    return { map, sampled: false };
  }
  const rows = await findAll(coll, where, 5000);
  const map = {};
  rows.forEach(x => { const k = String(x.orgId); map[k] = (map[k] || 0) + 1; });
  return { map, sampled: rows.length >= 5000 };
}
async function maxDateByOrg(coll) {
  const $ = db.command.aggregate;
  const r = await aggTry(() => db.collection(coll).aggregate()
    .match({ removed: _.neq(true) }).group({ _id: '$orgId', v: $.max('$date') }).limit(2000).end());
  if (r) {
    const map = {};
    (r.list || []).forEach(x => { if (x._id !== undefined && x._id !== null) map[String(x._id)] = str(x.v); });
    return { map, sampled: false };
  }
  const rows = await findAll(coll, { removed: _.neq(true) }, 5000);
  const map = {};
  rows.forEach(x => {
    const k = String(x.orgId); const d = str(x.date);
    if (!map[k] || d > map[k]) map[k] = d;
  });
  return { map, sampled: rows.length >= 5000 };
}
// 近 30 天按上课日期统计条数与已发布数
async function trend30() {
  const from = plat.addDays(plat.todayStr(), -29);
  const $ = db.command.aggregate;
  const r = await aggTry(() => db.collection('records').aggregate()
    .match({ removed: _.neq(true), date: _.gte(from) })
    .group({ _id: '$date', n: $.sum(1), s: $.sum($.cond({ if: '$sent', then: 1, else: 0 })) })
    .limit(500).end());
  const days = plat.lastDays(30);
  if (r) {
    const map = {};
    (r.list || []).forEach(x => { map[str(x._id)] = { n: Number(x.n) || 0, s: Number(x.s) || 0 }; });
    return { rows: days.map(d => ({ d, n: (map[d] || {}).n || 0, sent: (map[d] || {}).s || 0 })), sampled: false };
  }
  const rows = await findAll('records', { removed: _.neq(true), date: _.gte(from) }, 5000);
  return { rows: plat.trendOf(rows, 30), sampled: rows.length >= 5000 };
}
// 最近 N 条记录（评分/等级分布用）。按上课日期倒序取，不是全库扫描
async function recentRecords(limit) {
  const cap = Math.min(Number(limit) || 1000, 3000);
  const out = [];
  for (let skip = 0; skip < cap; skip += PAGE) {
    let r;
    try {
      r = await db.collection('records').where({ removed: _.neq(true) })
        .orderBy('date', 'desc').skip(skip).limit(PAGE).get();
    } catch (e) { await ensure('records'); r = { data: [] }; }
    out.push.apply(out, r.data || []);
    if ((r.data || []).length < PAGE) break;
  }
  return { rows: out, sampled: out.length >= cap };
}
// 某批学生的记录数 / 最近记录日期（学生总览列表要显示"这个孩子被记录过几次"）
async function recordStatsBySid(pairs) {
  const out = {};
  const key = (orgId, sid) => String(orgId) + ':' + sid;
  if (!pairs.length) return out;
  const sids = [];
  pairs.forEach(p => { if (sids.indexOf(p.sid) < 0) sids.push(p.sid); });
  const $ = db.command.aggregate;
  const r = await aggTry(() => db.collection('records').aggregate()
    .match({ removed: _.neq(true), sid: _.in(sids) })
    .group({ _id: { sid: '$sid', orgId: '$orgId' }, n: $.sum(1), last: $.max('$date') })
    .limit(2000).end());
  if (r) {
    (r.list || []).forEach(x => {
      const id = x._id || {};
      out[key(id.orgId, id.sid)] = { n: Number(x.n) || 0, last: str(x.last) };
    });
    return out;
  }
  const rows = await findAll('records', { removed: _.neq(true), sid: _.in(sids) }, 3000);
  rows.forEach(x => {
    const k = key(x.orgId, x.sid);
    const o = out[k] || (out[k] = { n: 0, last: '' });
    o.n += 1;
    if (str(x.date) > o.last) o.last = str(x.date);
  });
  return out;
}

async function orgRows() {
  const [orgs, stu, cls, rec, sent, last, members] = await Promise.all([
    findAll('orgs', { removed: _.neq(true) }, 500),
    countByOrg('students'), countByOrg('classes'), countByOrg('records'),
    countByOrg('records', { sent: true }), maxDateByOrg('records'),
    findAll('members', { removed: _.neq(true) }, 3000)
  ]);
  const mem = {}, tea = {}, par = {}, owner = {}, roleMap = {};
  members.forEach(m => {
    const id = String(m.orgId);
    mem[id] = (mem[id] || 0) + 1;
    roleMap[str(m.role)] = (roleMap[str(m.role)] || 0) + 1;
    if (m.role === 'teacher') tea[id] = (tea[id] || 0) + 1;
    if (m.role === 'parent') par[id] = (par[id] || 0) + 1;
    if (m.role === 'owner') owner[id] = str(m.name);
  });
  const rows = plat.mergeOrgs(
    orgs.map(o => Object.assign({}, o, { ownerName: owner[String(o.id)] || '' })),
    { students: stu.map, classes: cls.map, records: rec.map, members: mem,
      sent: sent.map, teachers: tea, parents: par, lastDate: last.map }
  );
  return { rows, roleMap, sampled: stu.sampled || rec.sampled || members.length >= 3000 };
}

async function platOverview() {
  const [base, tr, sample] = await Promise.all([orgRows(), trend30(), recentRecords(1000)]);
  const rows = base.rows;
  const g = plat.globalStat(rows, sample.rows, base.roleMap);
  // 总数以机构汇总为准（聚合结果），分布用最近 1000 条样本
  g.records = rows.reduce((n, r) => n + r.records, 0);
  g.sent = rows.reduce((n, r) => n + r.sent, 0);
  g.rate = lib.pct(g.sent, g.records);
  g.draft = Math.max(0, g.records - g.sent);
  const today = plat.todayStr();
  const weekFrom = plat.addDays(today, -6);
  g.todayRecords = tr.rows.filter(x => x.d === today).reduce((n, x) => n + x.n, 0);
  g.weekRecords = tr.rows.filter(x => x.d >= weekFrom).reduce((n, x) => n + x.n, 0);
  const activeOrgs = rows.filter(r => r.lastDate && r.lastDate >= weekFrom).length;
  return {
    ok: true, scope: 'platform', at: now(),
    stat: g,
    activeOrgs,
    trend: tr.rows, trendSampled: tr.sampled,
    dist: plat.scoreDist(sample.rows), tags: plat.tagDist(sample.rows),
    sampleSize: sample.rows.length, sampleSampled: sample.sampled,
    orgs: rows,
    warnings: warningsOf(rows, base.sampled)
  };
}
// 运营要看的"不对劲"：空机构、只建档不上课、草稿积压、长期没动静
function warningsOf(rows, sampled) {
  const out = [];
  const empty = rows.filter(r => !r.students);
  if (empty.length) out.push({ level: 'warn', t: empty.length + ' 个机构还没有学生', d: empty.slice(0, 3).map(r => r.name).join('、') + (empty.length > 3 ? ' 等' : '') });
  const noClass = rows.filter(r => r.students && !r.classes);
  if (noClass.length) out.push({ level: 'warn', t: noClass.length + ' 个机构有学生但没建班级', d: noClass.slice(0, 3).map(r => r.name).join('、') });
  const idle = rows.filter(r => r.students && (!r.lastDate || r.lastDate < plat.addDays(plat.todayStr(), -14)));
  if (idle.length) out.push({ level: 'info', t: idle.length + ' 个机构两周没有新记录', d: idle.slice(0, 3).map(r => r.name).join('、') });
  const draft = rows.reduce((n, r) => n + Math.max(0, r.records - r.sent), 0);
  if (draft > 0) out.push({ level: 'info', t: '全平台有 ' + draft + ' 条记录还是草稿（家长看不到）', d: '在机构后台的「课堂记录」里按草稿筛' });
  if (sampled) out.push({ level: 'warn', t: '数据量超过单次统计上限', d: '部分机构的数字是抽样结果' });
  return out;
}

async function platOrgs(data) {
  const base = await orgRows();
  const q = str((data || {}).q).trim().toLowerCase();
  const rows = q ? base.rows.filter(r => (r.name + ' ' + r.orgId + ' ' + r.owner).toLowerCase().indexOf(q) >= 0) : base.rows;
  const { page, size, skip } = lib.normPage(data || {});
  return { ok: true, total: rows.length, page, size, rows: rows.slice(skip, skip + size), all: rows, sampled: base.sampled };
}

async function platOrg(data) {
  const orgId = str((data || {}).orgId);
  if (!orgId) return { ok: false, msg: '缺少机构号' };
  const org = (await findAll('orgs', { id: orgId, removed: _.neq(true) }, 5))[0];
  if (!org) return { ok: false, msg: '找不到这个机构（可能已删除或从未同步到云）' };
  const [students, classes, members, records, terms, courses] = await Promise.all([
    findAll('students', alive(orgId), 3000),
    findAll('classes', alive(orgId), 1000),
    findAll('members', alive(orgId), 1000),
    findAll('records', alive(orgId), 5000),
    findAll('terms', alive(orgId), 200),
    findAll('courses', alive(orgId), 500)
  ]);
  const clsById = {};
  classes.forEach(c => { clsById[c.id] = c.name; });
  const termById = {};
  terms.forEach(t => { termById[t.id] = t.name; });
  const perClass = {};
  students.forEach(s => (s.clsIds || []).forEach(id => { perClass[id] = (perClass[id] || 0) + 1; }));
  const recByClass = {}, lastByClass = {}, topByStu = {};
  records.forEach(r => {
    recByClass[r.cid] = (recByClass[r.cid] || 0) + 1;
    if (!lastByClass[r.cid] || str(r.date) > lastByClass[r.cid]) lastByClass[r.cid] = str(r.date);
    const o = topByStu[r.sid] || (topByStu[r.sid] = { n: 0, last: '' });
    o.n += 1;
    if (str(r.date) > o.last) o.last = str(r.date);
  });
  const sent = records.filter(r => r.sent).length;
  const owner = members.filter(m => m.role === 'owner')[0] || {};
  const roleLabel = { owner: '负责人', admin: '管理员', teacher: '老师', parent: '家长' };
  return {
    ok: true,
    org: {
      orgId, name: str(org.name) || '未命名机构', status: str(org.status) || 'active',
      ownerName: str(owner.name) || '—', createdAt: Number(org.createdAt) || 0
    },
    kpi: {
      students: students.length, classes: classes.length, courses: courses.length,
      members: members.length,
      teachers: members.filter(m => m.role === 'teacher').length,
      parents: members.filter(m => m.role === 'parent').length,
      records: records.length, sent, draft: records.length - sent,
      rate: lib.pct(sent, records.length), avgScore: plat.avgScore(records),
      photos: records.reduce((n, r) => n + (r.photos || []).length, 0),
      videos: records.reduce((n, r) => n + (r.videos || []).length, 0),
      silentStudents: students.filter(s => !topByStu[s.id]).length
    },
    trend: plat.trendOf(records, 30),
    dist: plat.scoreDist(records), tags: plat.tagDist(records),
    classes: classes.map(c => ({
      id: c.id, name: str(c.name), term: str(termById[c.termId] || ''),
      students: perClass[c.id] || 0, records: recByClass[c.id] || 0,
      lastDate: lastByClass[c.id] || '', session: Number(c.session) || 0
    })).sort((a, b) => b.students - a.students),
    members: members.map(m => ({
      id: m.id, name: str(m.name) || '（未填姓名）', role: str(m.role), roleLabel: roleLabel[str(m.role)] || str(m.role),
      status: str(m.status) || 'active', openid: m.openid ? '已绑定' : '未绑定',
      scope: m.role === 'parent' ? ((m.studentIds || []).length + ' 个孩子') : m.role === 'teacher' ? ((m.clsIds || []).length + ' 个班') : '全机构'
    })),
    topStudents: students.map(s => ({ id: s.id, name: str(s.name), n: (topByStu[s.id] || {}).n || 0, last: (topByStu[s.id] || {}).last || '' }))
      .sort((a, b) => b.n - a.n).slice(0, 8),
    students: students.map(s => ({
      id: s.id, no: str(s.no), name: str(s.name), parent: str(s.parent), wechat: str(s.wechat),
      clsNames: (s.clsIds || []).map(i => clsById[i]).filter(Boolean),
      records: (topByStu[s.id] || {}).n || 0, lastDate: (topByStu[s.id] || {}).last || ''
    })).sort((a, b) => b.records - a.records)
  };
}

async function platStudents(data) {
  const d = data || {};
  const { page, size, skip } = lib.normPage(d);
  const where = { removed: _.neq(true) };
  const orgId = str(d.orgId);
  if (orgId) where.orgId = orgId;
  const kw = str(d.q).trim();
  if (kw) where.name = db.RegExp({ regexp: kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' });
  let total = await countOf('students', where);
  let rows = [];
  try {
    const r = await db.collection('students').where(where).orderBy('createdAt', 'desc').skip(skip).limit(size).get();
    rows = r.data || [];
  } catch (e) { await ensure('students'); }
  const orgs = await findAll('orgs', { removed: _.neq(true) }, 500);
  const orgName = {};
  orgs.forEach(o => { orgName[String(o.id)] = str(o.name); });
  const clsWhere = { removed: _.neq(true) };
  if (orgId) clsWhere.orgId = orgId;
  const classes = await findAll('classes', clsWhere, 2000);
  const clsById = {};
  classes.forEach(c => { clsById[String(c.orgId) + ':' + c.id] = str(c.name); });
  const stats = await recordStatsBySid(rows.map(s => ({ orgId: s.orgId, sid: s.id })));
  const out = rows.map(s => ({
    id: s.id, no: str(s.no), name: str(s.name), orgId: String(s.orgId),
    orgName: orgName[String(s.orgId)] || String(s.orgId),
    clsNames: (s.clsIds || []).map(i => clsById[String(s.orgId) + ':' + i]).filter(Boolean),
    enrollYear: Number(s.enrollYear) || 0, parent: str(s.parent), wechat: str(s.wechat),
    records: (stats[String(s.orgId) + ':' + s.id] || {}).n || 0,
    lastDate: (stats[String(s.orgId) + ':' + s.id] || {}).last || ''
  }));
  return { ok: true, total, page, size, rows: out, orgs: orgs.map(o => ({ orgId: String(o.id), name: str(o.name) })) };
}

async function platExport(data) {
  const kind = str((data || {}).kind) === 'students' ? 'students' : 'orgs';
  const orgsMap = {};
  (await findAll('orgs', { removed: _.neq(true) }, 500)).forEach(o => { orgsMap[String(o.id)] = str(o.name); });
  if (kind === 'orgs') {
    const base = await orgRows();
    // rows/truncated/cap 给前端提示用：导出被截断时不能装作"数据是全的"
    return { ok: true, name: '机构清单-' + stamp() + '.csv', csv: plat.orgsCsv(base.rows), rows: base.rows.length, truncated: false, cap: lib.MAX_ROWS };
  }
  const students = await findAll('students', { removed: _.neq(true) }, lib.MAX_ROWS);
  const classes = await findAll('classes', { removed: _.neq(true) }, 2000);
  const clsById = {};
  classes.forEach(c => { clsById[String(c.orgId) + ':' + c.id] = str(c.name); });
  const stats = await recordStatsBySid(students.map(s => ({ orgId: s.orgId, sid: s.id })));
  const rows = students.map(s => ({
    orgName: orgsMap[String(s.orgId)] || String(s.orgId), no: str(s.no), name: str(s.name),
    clsNames: (s.clsIds || []).map(i => clsById[String(s.orgId) + ':' + i]).filter(Boolean),
    records: (stats[String(s.orgId) + ':' + s.id] || {}).n || 0,
    lastDate: (stats[String(s.orgId) + ':' + s.id] || {}).last || '',
    parent: str(s.parent), wechat: str(s.wechat), enrollYear: Number(s.enrollYear) || ''
  })).sort((a, b) => (a.orgName === b.orgName ? 0 : a.orgName < b.orgName ? -1 : 1) || (b.records - a.records));
  return { ok: true, name: '全平台学生-' + stamp() + '.csv', csv: plat.studentsCsv(rows), rows: rows.length, truncated: students.length >= lib.MAX_ROWS, cap: lib.MAX_ROWS };
}

async function apiPlatform(action, data, s) {
  switch (action) {
    case 'me': return { ok: true, account: s.account, scope: 'platform' };
    case 'logout':
      await db.collection(SESSIONS).doc(s._id).remove().catch(() => {});
      return { ok: true };
    case 'platOverview': return platOverview();
    case 'platOrgs': return platOrgs(data || {});
    case 'platOrg': return platOrg(data || {});
    case 'platStudents': return platStudents(data || {});
    case 'platExport': return platExport(data || {});
    // 只读：平台会话调任何写接口都到这里，明确拒绝，而不是"没权限"让人以为是 bug
    default: return { ok: false, code: 'READONLY', msg: '平台控制台是只读的，修改数据请进对应机构的机构后台' };
  }
}

/* ============================ 路由 ============================ */
async function api(action, data, headers) {
  if (action === 'login') return doLogin(data || {});
  if (action === 'platLogin') return doPlatformLogin(data || {});
  const s = await auth(headers);
  if (!s) return { ok: false, code: 'AUTH', msg: '请先登录' };
  // 平台会话与机构会话共用同一个 auth，但走到这里就分叉：平台只能读跨机构数据
  if (str(s.scope) === 'platform') return apiPlatform(action, data || {}, s);
  const orgId = str(s.orgId);
  switch (action) {
    case 'me': return { ok: true, account: s.account, orgId };
    case 'logout':
      await db.collection(SESSIONS).doc(s._id).remove().catch(() => {});
      return { ok: true };
    case 'overview': return overview(orgId);
    case 'list': return listData(orgId, data || {});
    case 'update': return updateData(orgId, data || {});
    case 'create': return createData(orgId, data || {});
    case 'remove': return removeData(orgId, data || {});
    case 'export': return exportData(orgId, data || {});
    case 'backup': return backupData(orgId);
    case 'audit': return auditData(orgId);
    // 云端每日自动备份：列表、立刻备份、按集合分步恢复
    // tag 用来区分「日常备份」与「恢复前快照」——两者必须落在不同的清单和目录里，
    // 否则恢复到今天时，恢复前的快照会先把今天的好备份覆盖掉。
    case 'cbList': return cbCall(orgId, 'list');
    case 'cbRun': return cbCall(orgId, 'run', { coll: str((data || {}).coll), tag: str((data || {}).tag), safety: !!(data || {}).safety });
    case 'cbRestore': return cbCall(orgId, 'restore', {
      date: str((data || {}).date), coll: str((data || {}).coll), tag: str((data || {}).tag),
      from: Number((data || {}).from) || 0
    });
    case 'resetPin': return resetPin(orgId);
    default: return { ok: false, msg: '未知操作' };
  }
}

let pageCache = '';
function page() {
  if (pageCache) return pageCache;
  try {
    pageCache = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
  } catch (e) {
    pageCache = '<meta charset="utf-8"><h3>后台页面缺失，请重新部署 admin 云函数</h3>';
  }
  return pageCache;
}

// 平台控制台单独一页：机构后台和平台后台的入口、身份、能做的事都不一样，
// 混在一个页面里迟早会有人拿机构口令点进跨机构界面（然后看到"没有权限"）。
let platCache = '';
function platformPage() {
  if (platCache) return platCache;
  try {
    platCache = fs.readFileSync(path.join(__dirname, 'public', 'platform.html'), 'utf8');
  } catch (e) {
    platCache = '<meta charset="utf-8"><h3>平台页面缺失，请重新部署 admin 云函数</h3>';
  }
  return platCache;
}

exports.main = async (event) => {
  const ev = event || {};
  const { OPENID } = cloud.getWXContext() || {};
  // 小程序里调用（callFunction）：只开放"取后台账号"这一个动作。
  // HTTP 访问服务是公开入口，绝不能让浏览器请求也能生成/读到机构口令。
  if (ev.action === 'mkAccount' && !ev.httpMethod && !ev.requestContext) return mkAccount(OPENID);
  // HTTP 访问服务：GET 出页面、POST 走接口
  if (ev.httpMethod || ev.requestContext) {
    const method = str(ev.httpMethod || 'GET').toUpperCase();
    const headers = ev.headers || {};
    if (method === 'OPTIONS') return json(204, {});
    if (method === 'GET' || method === 'HEAD') {
      const q = ev.queryStringParameters || {};
      if (q && q.api) return json(200, await api(str(q.api), q, headers));
      if (q && str(q.view) === 'platform') return htmlResp(platformPage());
      return htmlResp(page());
    }
    let body = ev.body;
    if (ev.isBase64Encoded && typeof body === 'string') body = Buffer.from(body, 'base64').toString('utf8');
    let data = {};
    try { data = typeof body === 'string' ? JSON.parse(body || '{}') : (body || {}); } catch (e) {
      return json(200, { ok: false, msg: '请求格式不对' });
    }
    try {
      return json(200, await api(str(data.action), data, headers));
    } catch (e) {
      return json(200, { ok: false, msg: '服务器出错：' + ((e && e.message) || e) });
    }
  }
  return { ok: false, msg: '请通过后台网址访问，或在微信小程序里打开' };
};
