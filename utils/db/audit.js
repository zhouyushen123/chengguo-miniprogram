// utils/db/audit.js —— 核心资产体检（学生 / 成员 / 机构）
//
// 【为什么单独一个模块】数据出问题的方式很多，但"哪几种是能安全自动修的"必须写死：
//   - 能修：悬空引用（学生的班已删、成员的班/孩子已删）→ 摘掉即可，不丢任何实体
//   - 能修：学号重复或缺失 → 重新发号，学生本身一条不动
//   - 不能修：两条学生记录重复（哪个是真的？）、记录指向不存在的学生（删还是改挂？）
//     —— 这类只报告，交给人判断。自动"合并"是最容易把一个小学员彻底搞丢的操作。
//
// 【只做只读体检也要便宜】这个函数会在「存储空间」页被点开，数据几千条时不能卡住。
// 所以全部是单次遍历 + Set 查找，不做嵌套循环。
const core = require('./core');
const { org, now } = require('./ctx');

const MAX_ITEMS = 20;          // 每类问题最多列 20 条，界面不会因为一次几百条卡死
const NO_START = 1001;

const sameOrg = (x, o) => x && !x.removed && (x.orgId || o) === o;

function pick(list, fields) {
  return list.slice(0, MAX_ITEMS).map(x => {
    const o = {};
    fields.forEach(f => { o[f] = x[f]; });
    return o;
  });
}

/* =====================================================================
 * 体检：只读，不改任何数据
 * ===================================================================*/
function scan() {
  const o = org();
  const allStu = core.coll('students') || [];
  const allCls = core.coll('classes') || [];
  const allMem = core.coll('members') || [];
  const allRec = core.coll('records') || [];
  const allOrg = core.coll('orgs') || [];

  const students = allStu.filter(x => sameOrg(x, o));
  const classes = allCls.filter(x => sameOrg(x, o));
  const members = allMem.filter(x => sameOrg(x, o));
  const records = allRec.filter(x => sameOrg(x, o));

  const clsId = {};
  classes.forEach(c => { clsId[c.id] = 1; });
  const stuId = {};
  students.forEach(s => { stuId[s.id] = 1; });

  const issues = [];
  const add = (k, level, title, items, tip) => {
    if (!items.length) return;
    issues.push({ k, level, title, count: items.length, items: pick(items, tip || []), });
  };

  /* ---- 机构本身 ---- */
  const orgRow = allOrg.filter(x => !x.removed && String(x.id) === String(o))[0];
  if (!orgRow) {
    issues.push({ k: 'orgMissing', level: 'error', title: '机构档案缺失', count: 1, items: [{ id: o }] });
  }
  const owners = members.filter(m => m.role === 'owner' && m.status === 'active');
  if (owners.length > 1) {
    issues.push({
      k: 'multiOwner', level: 'warn', title: '有多个负责人（权限会互相覆盖）',
      count: owners.length, items: pick(owners, ['id', 'name'])
    });
  }
  if (!owners.length && members.length) {
    issues.push({ k: 'noOwner', level: 'warn', title: '没有负责人（没人能改机构设置）', count: 1, items: [] });
  }

  /* ---- 学生：学号 ---- */
  const byNo = {};
  const noMissing = [];
  students.forEach(s => {
    const n = String(s.no || '').trim();
    if (!n) { noMissing.push(s); return; }
    (byNo[n] || (byNo[n] = [])).push(s);
  });
  const dupNo = [];
  Object.keys(byNo).forEach(n => {
    if (byNo[n].length > 1) byNo[n].forEach(s => dupNo.push({ id: s.id, name: s.name, no: s.no }));
  });
  add('dupNo', 'error', '学号重复（家长凭学号认孩子，重复会认错人）', dupNo);
  add('noNo', 'warn', '学生没有学号（家长无法绑定孩子）', noMissing, ['id', 'name']);

  /* ---- 学生：班级引用 ---- */
  const dangleStuCls = [];
  students.forEach(s => {
    const bad = (s.clsIds || []).filter(id => !clsId[id]);
    if (bad.length) dangleStuCls.push({ id: s.id, name: s.name, bad: bad.join(',') });
  });
  add('stuDanglingCls', 'warn', '学生挂在已删除的班级上', dangleStuCls, ['id', 'name', 'bad']);

  /* ---- 学生：没有班级 ---- */
  const noCls = students.filter(s => !(s.clsIds || []).length);
  add('stuNoCls', 'info', '学生不属于任何班级（不会出现在班级名单里）', noCls, ['id', 'name']);

  /* ---- 记录：指向不存在的学生/班级 ---- */
  const orphanRec = [];
  const orphanRecCls = [];
  records.forEach(r => {
    if (!stuId[r.sid]) orphanRec.push({ id: r.id, sid: r.sid, date: r.date });
    if (r.cid && !clsId[r.cid]) orphanRecCls.push({ id: r.id, cid: r.cid, date: r.date });
  });
  add('recOrphanStu', 'error', '课堂记录挂在不存在的学生上（家长永远看不到）', orphanRec, ['id', 'sid', 'date']);
  add('recOrphanCls', 'warn', '课堂记录挂在不存在的班级上', orphanRecCls, ['id', 'cid', 'date']);

  /* ---- 成员（老师/家长） ---- */
  const byOpenid = {};
  const byUser = {};
  members.forEach(m => {
    if (m.openid) (byOpenid[m.openid] || (byOpenid[m.openid] = [])).push(m);
    if (m.userId) (byUser[m.userId] || (byUser[m.userId] = [])).push(m);
  });
  const dupOpenid = [];
  Object.keys(byOpenid).forEach(k => {
    if (byOpenid[k].length > 1) byOpenid[k].forEach(m => dupOpenid.push({ id: m.id, name: m.name, openid: k }));
  });
  add('memDupOpenid', 'error', '同一个微信绑定了多个成员（权限会串）', dupOpenid, ['id', 'name']);

  const dangleMem = [];
  members.forEach(m => {
    const bc = (m.clsIds || []).filter(id => !clsId[id]);
    const bs = (m.studentIds || []).filter(id => !stuId[id]);
    if (bc.length || bs.length) {
      dangleMem.push({ id: m.id, name: m.name, badCls: bc.join(','), badStu: bs.join(',') });
    }
  });
  add('memDangling', 'warn', '成员的班级/孩子范围指向已删除的数据', dangleMem, ['id', 'name', 'badCls', 'badStu']);

  const noName = members.filter(m => !String(m.name || '').trim());
  add('memNoName', 'info', '成员没有姓名（记录署名会空着）', noName, ['id', 'role']);

  /* ---- 数据规模（给用户一个"我现在有多少资产"的直观数字） ---- */
  const counts = {
    students: students.length,
    members: members.length,
    classes: classes.length,
    records: records.length,
    orgs: orgRow ? 1 : 0
  };

  const errors = issues.filter(i => i.level === 'error').length;
  const warns = issues.filter(i => i.level === 'warn').length;
  return { ok: true, at: Date.now(), orgId: o, counts, issues, errors, warns, healthy: !errors && !warns };
}

/* =====================================================================
 * 修复：只做"绝不会更糟"的那几种
 * ===================================================================*/
function fix(kinds) {
  const want = {};
  (kinds && kinds.length ? kinds : ['dangling', 'noNo']).forEach(k => { want[k] = 1; });

  return core.tx(() => {
    const o = org();
    const t = now();
    const classes = (core.coll('classes') || []).filter(x => sameOrg(x, o));
    const students = (core.coll('students') || []).filter(x => sameOrg(x, o));
    const members = (core.coll('members') || []).filter(x => sameOrg(x, o));
    const clsId = {};
    classes.forEach(c => { clsId[c.id] = 1; });
    const stuId = {};
    students.forEach(s => { stuId[s.id] = 1; });

    let dangle = 0, reno = 0;

    // 1) 悬空引用：把指向"已经不存在的东西"的 id 摘掉。
    //    不删任何实体，最坏结果只是某个人少看到一个已删除的班级。
    if (want.dangling) {
      students.forEach(s => {
        const cur = s.clsIds || [];
        const next = cur.filter(id => clsId[id]);
        if (next.length !== cur.length) { s.clsIds = next; s.updatedAt = t; dangle++; }
      });
      members.forEach(m => {
        const c0 = m.clsIds || [], s0 = m.studentIds || [];
        const c1 = c0.filter(id => clsId[id]);
        const s1 = s0.filter(id => stuId[id]);
        let hit = false;
        if (c1.length !== c0.length) { m.clsIds = c1; hit = true; }
        if (s1.length !== s0.length) { m.studentIds = s1; hit = true; }
        if (hit) { m.updatedAt = t; dangle++; }
      });
    }

    // 2) 学号缺失或重复：重新发号。学生本身（姓名、班级、家长、记录）一条不动。
    //    保留哪一个：按 id 从小到大（先建档的先保留），结果可预期。
    if (want.noNo) {
      const ordered = students.slice().sort((a, b) => (a.id || 0) - (b.id || 0));
      const used = {};
      let max = NO_START - 1;
      ordered.forEach(s => { const n = Number(s.no); if (n > max) max = n; });
      ordered.forEach(s => {
        const n = String(s.no || '').trim();
        if (n && !used[n]) { used[n] = 1; return; }
        max += 1;
        s.no = String(max);
        used[String(max)] = 1;
        s.updatedAt = t;
        reno++;
      });
    }

    if (!dangle && !reno) return { ok: true, fixed: { dangling: 0, noNo: 0 } };

    if (!core.persist('students')) return { ok: false, msg: core.SAVE_FAIL };
    if (dangle && !core.persist('members')) return { ok: false, msg: core.SAVE_FAIL };
    return { ok: true, fixed: { dangling: dangle, noNo: reno } };
  });
}

module.exports = { scan, fix, NO_START };
