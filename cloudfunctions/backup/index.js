// cloudfunctions/backup —— 云端每日全量备份（学生 / 老师 / 机构为核心）
//
// 【为什么要在云端再备一份】本机快照救的是"这台手机坏了/换手机"，云端的定时备份救的是
// "云数据库被改坏了"：一次错误的批量操作、一次同步风暴、甚至控制台误删集合，都会让
// 手机端拉回来的也是坏数据。备份必须放在业务数据之外的地方，并且是自动跑的——
// 需要人记得点的备份，等于没有。
//
// 【跑法】
//   · 定时触发（config.json 的 dailyBackup，每天 03:00）：没有 openid，遍历所有机构各备一份
//   · 小程序 / 电脑后台手动触发：带 openid，只允许操作自己绑定的机构，且要 owner/admin
//   · 保留 30 天，每次跑完顺手清掉过期清单与文件
//
// 【产物】
//   云存储  chengguo/backup/<机构号>/<日期>/<集合>[-n].json   每 2000 条一个文件
//   数据库  backups 集合，一机构一天一条清单（重复跑覆盖，不堆副本）
//
// 【恢复原则】只写回、不删除。恢复是用来"把改坏的改成昨天那样"，不是"回到昨天"——
// 顺手删掉备份之后新录的数据，是比不恢复更糟的事。
const cloud = require('wx-server-sdk');
const lib = require('./lib');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const BACKUP = 'backups';
const PAGE = 100;          // 云数据库单次 get 上限
const CONC = 10;           // 恢复时的并发（云函数有连接数限制，别开太大）
const TIME_BUDGET = 45000; // 留 15 秒给收尾：云函数默认 60 秒超时，跑不完就存"不完整"的清单

const now = () => Date.now();
const str = v => (v === undefined || v === null ? '' : String(v));

async function ensure() {
  try { await db.createCollection(BACKUP); } catch (e) { /* 已存在即可 */ }
}

async function readAll(coll, orgId, cap) {
  // orgs 的主键就是机构号（id），没有 orgId 外键；其余集合都带 orgId
  const where = coll === 'orgs' ? { id: orgId } : { orgId };
  const out = [];
  let skip = 0;
  for (;;) {
    const r = await db.collection(coll).where(where).skip(skip).limit(PAGE)
      .get().catch(() => ({ data: [] }));
    const rows = r.data || [];
    for (const d of rows) {
      if (out.length >= cap) break;
      out.push(d);
    }
    if (rows.length < PAGE || out.length >= cap) break;
    skip += PAGE;
  }
  return out;
}

// 机构清单：orgs 里一行一个机构。这里只取 id，不读内容。
async function allOrgs() {
  const out = [];
  let skip = 0;
  for (;;) {
    const r = await db.collection('orgs').skip(skip).limit(PAGE).get().catch(() => ({ data: [] }));
    const rows = r.data || [];
    rows.forEach(o => {
      const id = str(o.id || o.orgId);
      if (id && out.indexOf(id) < 0) out.push(id);
    });
    if (rows.length < PAGE) break;
    skip += PAGE;
    if (skip > 1000) break;
  }
  return out;
}

async function roleOf(openid, orgId) {
  try {
    const r = await db.collection('members').where({ orgId, openid }).limit(5).get();
    const m = (r.data || []).filter(x => !x.removed)[0];
    return m ? str(m.role) : '';
  } catch (e) { return ''; }
}

async function boundOrgOf(openid) {
  try {
    const r = await db.collection('users').where({ _openid: openid }).limit(1).get();
    return str((r.data[0] || {}).orgId);
  } catch (e) { return ''; }
}

async function saveManifest(orgId, date, doc) {
  const data = Object.assign({}, doc);
  delete data._id;
  const id = lib.manifestId(orgId, date);
  try {
    await db.collection(BACKUP).doc(id).set({ data });
  } catch (e) {
    await ensure();
    await db.collection(BACKUP).doc(id).set({ data });
  }
  return id;
}

// 备份一个机构。默认跑全部集合；传 colls 时只跑其中几个，结果合并进当天的清单。
// 合并是必须的：小程序/后台一次调用只跑一个集合（每一步都要在云函数超时前回来），
// 不合并的话后一步会把前一步的文件记录覆盖掉，清单看起来只有最后跑的那一个集合。
async function runOrg(orgId, opt) {
  const o = opt || {};
  const t0 = now();
  const date = lib.ymd(t0);
  const colls = (o.colls && o.colls.length) ? o.colls : lib.COLLS;
  const prev = (await listManifests(orgId, 5)).filter(m => m.date === date)[0] || null;
  const prevFiles = (prev && prev.files) || [];
  // 这次没跑的集合沿用今天已经备好的那份
  const files = prevFiles.filter(f => colls.indexOf(f.c) < 0);
  const counts = Object.assign({}, (prev && prev.counts) || {});
  const stale = [];   // 重跑同一集合时旧分片要删掉，否则它会永远留在云存储里没人引用
  let stopped = '';
  for (const c of colls) {
    const docs = (await readAll(c, orgId, lib.MAX_DOCS)).map(lib.cleanDoc);
    counts[c] = docs.length;
    const parts = lib.chunk(docs, lib.PART_DOCS);
    if (!parts.length) files.push({ c, part: 0, count: 0, bytes: 0, fileID: '' });
    const keep = [];
    for (let i = 0; i < parts.length; i++) {
      const body = JSON.stringify({
        format: 'chengguo-cloud-backup-v1',
        orgId, date, c, part: i + 1, at: now(), docs: parts[i]
      });
      const buf = Buffer.from(body, 'utf8');
      const up = await cloud.uploadFile({ cloudPath: lib.pathOf(orgId, date, c, i + 1), fileContent: buf });
      keep.push(up.fileID);
      files.push({ c, part: i + 1, count: parts[i].length, bytes: buf.length, fileID: up.fileID });
    }
    prevFiles.forEach(f => {
      if (f.c === c && f.fileID && keep.indexOf(f.fileID) < 0) stale.push(f.fileID);
    });
    if (now() - t0 > TIME_BUDGET) { stopped = c; break; }
  }
  if (stale.length) await cloud.deleteFile({ fileList: stale }).catch(() => ({}));
  const done = {};
  files.forEach(f => { done[f.c] = 1; });
  const missing = lib.COLLS.filter(c => !done[c]);
  const total = Object.keys(counts).reduce((n, k) => n + (Number(counts[k]) || 0), 0);
  const bytes = files.reduce((n, f) => n + (Number(f.bytes) || 0), 0);
  const doc = {
    orgId, date, at: now(), counts, total, bytes, files,
    status: missing.length ? 'partial' : 'ok',
    stoppedAt: missing.length ? (stopped || missing[0]) : '',
    truncated: Object.keys(counts).some(k => counts[k] >= lib.MAX_DOCS),
    safety: !!o.safety || !!(prev && prev.safety)
  };
  await saveManifest(orgId, date, doc);
  doc.missing = missing;
  return doc;
}

async function listManifests(orgId, limit) {
  try {
    const r = await db.collection(BACKUP).where({ orgId }).orderBy('date', 'desc')
      .limit(Number(limit) || 30).get();
    return r.data || [];
  } catch (e) {
    return [];
  }
}

// 过期清理：清单和它指向的文件一起删。只删 backups 自己的东西，业务集合一个字节都不碰。
async function prune(orgId) {
  const rows = await listManifests(orgId, 100);
  const dead = lib.expired(rows, lib.ymd(now()), lib.KEEP_DAYS);
  if (!dead.length) return { removed: 0, files: 0 };
  const fileList = [];
  dead.forEach(m => (m.files || []).forEach(f => { if (f.fileID) fileList.push(f.fileID); }));
  if (fileList.length) await cloud.deleteFile({ fileList }).catch(() => ({}));
  let removed = 0;
  for (const m of dead) {
    const r = await db.collection(BACKUP).doc(m._id).remove().catch(() => null);
    if (r) removed++;
  }
  return { removed, files: fileList.length };
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  const width = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  const workers = [];
  for (let k = 0; k < width; k++) {
    workers.push((async () => {
      for (;;) {
        const idx = i++;
        if (idx >= list.length) return;
        out[idx] = await fn(list[idx], idx);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

async function upsertOne(coll, orgId, doc) {
  const where = coll === 'orgs' ? { id: orgId } : { orgId, id: doc.id };
  const r = await db.collection(coll).where(where).limit(1).get();
  if (r.data && r.data.length) {
    await db.collection(coll).doc(r.data[0]._id).update({ data: doc });
  } else {
    await db.collection(coll).add({ data: doc });
  }
}

// 恢复一个集合（浏览器/后台分集合多次调用，单次不超过 60 秒）
async function restoreColl(orgId, date, coll, t0) {
  if (lib.COLLS.indexOf(coll) < 0) return { ok: false, code: 'BAD_COLL', msg: '不认识的集合名' };
  const rows = await listManifests(orgId, 40);
  const man = rows.filter(m => m.date === date)[0];
  if (!man) return { ok: false, code: 'NO_BACKUP', msg: '没有这一天的备份' };
  const parts = (man.files || []).filter(f => f.c === coll && f.fileID);
  if (!parts.length) return { ok: false, code: 'NO_PART', msg: '这份备份里没有 ' + coll + '（可能当天没跑完）' };
  let docs = [];
  for (const p of parts) {
    const dl = await cloud.downloadFile({ fileID: p.fileID });
    let j = null;
    try { j = JSON.parse(dl.fileContent.toString('utf8')); } catch (e) { j = null; }
    if (j && Array.isArray(j.docs)) docs = docs.concat(j.docs);
  }
  const list = docs.slice(0, lib.RESTORE_CAP);
  const skipped = docs.length - list.length;
  let srv = now();
  const out = await mapLimit(list, CONC, async d => {
    if (!d || d.id === undefined || d.id === null) return 0;
    srv += 1;                                   // 严格递增，手机端增量拉取才捞得到
    const doc = lib.restoreDoc(d, { now: now(), srvAt: srv, orgId });
    try { await upsertOne(coll, orgId, doc); return 1; } catch (e) { return 0; }
  });
  const written = out.reduce((n, x) => n + x, 0);
  return {
    ok: true, coll, date, written, failed: list.length - written, skipped,
    ms: now() - t0
  };
}

async function main(event) {
  const ev = event || {};
  const ctx = cloud.getWXContext() || {};
  const openid = str(ctx.OPENID);
  const action = str(ev.action) || 'run';
  await ensure();

  const target = lib.resolveOrg({
    openid,
    boundOrgId: openid ? await boundOrgOf(openid) : '',
    askedOrgId: str(ev.orgId)
  });

  if (action === 'ping') {
    return { ok: true, keepDays: lib.KEEP_DAYS, colls: lib.COLLS, at: now() };
  }

  if (!target.internal) {
    if (!target.orgId) return { ok: false, code: 'NO_ORG', msg: '这个微信号还没有加入机构' };
    const role = await roleOf(openid, target.orgId);
    const needWrite = action === 'run' || action === 'restore';
    const pass = needWrite ? lib.canWrite(role) : lib.canRead(role);
    if (!pass) return { ok: false, code: 'FORBIDDEN', msg: '只有机构负责人或管理员可以操作云端备份' };
  }

  if (action === 'run') {
    // coll 可选：一次只备一个集合，给手机/后台分步调用留的入口（每步都在超时之内）
    const coll = str(ev.coll);
    if (coll && lib.COLLS.indexOf(coll) < 0) return { ok: false, code: 'BAD_COLL', msg: '不认识的集合名' };
    const colls = coll ? [coll] : null;
    const orgs = target.all ? await allOrgs() : [target.orgId].filter(Boolean);
    if (!orgs.length) return { ok: false, code: 'NO_ORG', msg: '还没有机构需要备份' };
    const items = [];
    for (const orgId of orgs) {
      const m = await runOrg(orgId, { colls, safety: !!ev.safety });
      const p = await prune(orgId);
      items.push({
        orgId: m.orgId, date: m.date, at: m.at, total: m.total, bytes: m.bytes,
        counts: m.counts, status: m.status, stoppedAt: m.stoppedAt, missing: m.missing, pruned: p.removed
      });
    }
    return { ok: true, at: now(), orgs: items.length, items };
  }

  if (action === 'list' || action === 'info') {
    if (target.all) return { ok: false, code: 'NEED_ORG', msg: '请指定机构' };
    const rows = await listManifests(target.orgId, action === 'info' ? 1 : 30);
    const items = rows.map(m => ({
      date: m.date, at: m.at, total: m.total, bytes: m.bytes, counts: m.counts,
      status: m.status, stoppedAt: m.stoppedAt, truncated: m.truncated, safety: m.safety
    }));
    return { ok: true, keepDays: lib.KEEP_DAYS, latest: items[0] || null, items };
  }

  if (action === 'restore') {
    if (target.all) return { ok: false, code: 'NEED_ORG', msg: '请指定机构' };
    const date = str(ev.date);
    if (!lib.isDate(date)) return { ok: false, code: 'BAD_DATE', msg: '日期格式应为 2026-11-05' };
    return restoreColl(target.orgId, date, str(ev.coll), now());
  }

  if (action === 'prune') {
    const orgs = target.all ? await allOrgs() : [target.orgId].filter(Boolean);
    let removed = 0;
    for (const orgId of orgs) removed += (await prune(orgId)).removed;
    return { ok: true, removed };
  }

  return { ok: false, code: 'BAD_ACTION', msg: '未知操作：' + action };
}

exports.main = async (event) => {
  try {
    return await main(event);
  } catch (e) {
    // 定时任务失败没人看日志，把原因放在返回值里，后台"云端备份"卡片能看到
    console.error('backup failed', e);
    return { ok: false, code: 'ERR', msg: (e && e.message) || String(e) };
  }
};
