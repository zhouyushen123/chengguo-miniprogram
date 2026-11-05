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

// 首次调用时集合还不存在（云数据库不会自动建表）→ 一个一个建，已存在就忽略。
// 这样用户不用在控制台手工点十次，部署完直接用。
async function ensureCollections() {
  for (const c of COLLS.concat(['users'])) {
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

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, msg: '未登录，拒绝调用' };
  const action = event && event.action;

  if (action === 'hello') {
    const want = String(event.orgId || '').slice(0, 64);
    const u = await userOf(OPENID);
    if (u) return { ok: true, orgId: u.orgId, firstTime: false };
    if (!want) return { ok: false, msg: '缺少机构标识' };
    await db.collection('users').add({ data: { _openid: OPENID, orgId: want, createdAt: db.serverDate() } });
    return { ok: true, orgId: want, firstTime: true };
  }

  const u = await userOf(OPENID);
  if (!u) return { ok: false, code: 'NO_BIND', msg: '账号未绑定机构，请先 hello' };
  const orgId = String(event.orgId || '');
  if (orgId !== u.orgId) return { ok: false, code: 'FORBIDDEN', msg: '无权访问该机构数据' };

  if (action === 'push') {
    const docs = Array.isArray(event.docs) ? event.docs.slice(0, 100) : [];
    const now = Date.now();
    let accepted = 0, newer = 0;
    for (const it of docs) {
      const c = String((it && it.c) || '');
      const d = it && it.d;
      if (COLLS.indexOf(c) < 0 || !d || d.id === undefined || d.id === null) continue;
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
    return { ok: true, accepted, newer };
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
