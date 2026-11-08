// utils/db/family.js —— 家长端的「我的孩子」（跨机构只读视图）
//
// 【为什么单独开一个域】其它模块一律"限当前机构"（ctx.oc），那是数据隔离的根本。
// 只有家长端需要一个例外：一个孩子在 A、B 两家上课，家长要在一页里看到两家的成果。
// 而他的心智里只有"我的孩子"，没有"我在哪家机构"。
//
// 【边界（很重要）】
//   1. 只读：这里不提供任何写操作。
//   2. 只读"我自己绑定的孩子"：范围来自 members.studentIds —— 那是家长认领卡片时
//      由服务端写进去的，客户端改不了；绝不按班级/机构去捞别的孩子。
//   3. 记录只看已发布（sent === true）：草稿永远不进家长视野。
//   4. 归并靠 pid：两条档案同一个 pid = 同一个孩子。没有 pid 的各自独立，不做猜测。
//
// 【和"平台合并一张表"的区别】这里没有任何汇总存储：数据仍然在各机构的 orgId 空间里，
// 只是读的时候把同一个 pid 的几条并到一起显示。
const core = require('./core');
const schema = require('./schema');
const pinyin = require('../pinyin');

// 我这个微信在所有机构的成员行。
// 有 openid 就以 openid 为准（换手机/重装后 userId 对不上，只有 openid 是靠得住的）；
// 还没有 openid（没上过云）时退回本机的 me —— 那种情况本来也只有一家。
function myMemberRows() {
  const meta = core.realMeta() || {};
  const openid = String(meta.openid || '');
  const all = (core.coll('members') || []).filter(m => m && !m.removed && m.status !== 'disabled');
  if (openid) {
    const mine = all.filter(m => String(m.openid || '') === openid);
    if (mine.length) return mine;
  }
  return all.filter(m => m.userId === meta.me);
}

// 机构名：从本地 orgs 集合取（切换/拉取过的机构都在）
function orgNameOf(orgId) {
  const o = (core.coll('orgs') || []).find(x => x && !x.removed && String(x.id) === String(orgId));
  return (o && o.name) || '';
}

// 一个孩子在没有 pid 时的临时归并键：机构 + 学生 id，保证不会被误并到别人身上
const keyOf = (orgId, sid) => 's:' + String(orgId || '') + ':' + String(sid);

/* ---------------- 我的孩子（按 pid 归并） ----------------
 * 返回 [{
 *   pid, name, photo,
 *   orgs: [{ orgId, orgName, sid, clsIds }],   // 这个孩子在几家机构各有哪条档案
 *   count                                       // 已发布记录总数
 * }]
 */
function kids() {
  const rows = myMemberRows();
  if (!rows.length) return [];
  const allStu = core.coll('students') || [];
  const allRec = core.coll('records') || [];
  const bucket = {};
  const order = [];

  rows.forEach(m => {
    const orgId = String(m.orgId || '');
    (m.studentIds || []).map(Number).filter(Boolean).forEach(sid => {
      const s = allStu.find(x => x && !x.removed && Number(x.id) === sid && String(x.orgId || '') === orgId);
      if (!s) return;
      const pid = String(s.pid || '') || keyOf(orgId, s.id);
      if (!bucket[pid]) { bucket[pid] = { pid, name: s.name || '', photo: s.photo || '', orgs: [] }; order.push(pid); }
      const b = bucket[pid];
      if (!b.name && s.name) b.name = s.name;
      if (!b.photo && s.photo) b.photo = s.photo;
      if (!b.orgs.some(o => o.orgId === orgId && o.sid === s.id)) {
        b.orgs.push({ orgId, orgName: orgNameOf(orgId), sid: s.id, clsIds: (s.clsIds || []).slice() });
      }
    });
  });

  // 记录条数：每家只数自己那个 sid 的，且只数已发布
  order.forEach(pid => {
    const b = bucket[pid];
    let n = 0;
    b.orgs.forEach(o => {
      n += allRec.filter(r => r && !r.removed && r.sent === true
        && Number(r.sid) === Number(o.sid) && String(r.orgId || '') === String(o.orgId)).length;
    });
    b.count = n;
  });

  return pinyin.sortStudents(order.map(p => bucket[p]));
}

function kid(pid) {
  const k = String(pid || '');
  return kids().find(x => x.pid === k) || null;
}

// 这个孩子在所有机构的已发布记录，按日期倒序。
// 每条都带上 orgId / orgName：页面上要能说清"这条是 A 家给的，那条是 B 家给的"，
// 否则两家评语混在一列里，家长根本分不出哪句是哪位老师说的。
function records(pid) {
  const k = kid(pid);
  if (!k) return [];
  const all = core.coll('records') || [];
  const out = [];
  k.orgs.forEach(o => {
    all.forEach(r => {
      if (!r || r.removed) return;
      if (r.sent !== true) return;                       // 草稿不进家长视野
      if (Number(r.sid) !== Number(o.sid)) return;
      if (String(r.orgId || '') !== String(o.orgId)) return;
      out.push(Object.assign({}, r, {
        orgId: o.orgId, orgName: o.orgName || '',
        clsName: className(o.orgId, r.cid)
      }));
    });
  });
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id - a.id)));
}

// 班级名：必须带 orgId 查。两家机构都有 id=11 的班，只按 id 查会张冠李戴。
function className(orgId, cid) {
  const c = (core.coll('classes') || []).find(x => x && !x.removed
    && Number(x.id) === Number(cid) && String(x.orgId || '') === String(orgId));
  return (c && c.name) || '';
}

// 课时账本（按机构分组）：两家各买各的课时包，加在一起是个没有意义的数字，
// 所以这里返回分组而不是总数。
function hours(pid) {
  const k = kid(pid);
  if (!k) return [];
  const all = core.coll('enrollments') || [];
  return k.orgs.map(o => {
    let remain = 0, hasCarry = false;
    all.forEach(en => {
      if (!en || en.removed) return;
      if (Number(en.studentId) !== Number(o.sid)) return;
      if (String(en.orgId || '') !== String(o.orgId)) return;
      if (en.status !== 'active') return;
      const c = (core.coll('classes') || []).find(x => x && !x.removed
        && Number(x.id) === Number(en.clsId) && String(x.orgId || '') === String(o.orgId));
      if (!c || c.mode !== 'carry') return;
      hasCarry = true;
      remain += Math.max(0, (en.totalHours || 0) - (en.usedHours || 0));
    });
    return { orgId: o.orgId, orgName: o.orgName, remain, hasCarry };
  }).filter(x => x.hasCarry);
}

module.exports = { kids, kid, records, className, hours, orgNameOf, myMemberRows, keyOf };
