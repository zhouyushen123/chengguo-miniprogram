// utils/db/integrity.js —— 引用完整性：体检（只读）与自愈（写回）
//
// 抽成独立文件的原因：启动维护（maintenance.js）已经顶到 500 行门槛，
// 而这套东西是"库级"的，不属于任何一个业务领域，单独一层最清楚。
// 依赖：core（全量集合）+ ctx（机构/时间）。不依赖任何领域模块，不产生环。
const core = require('./core');
const { now, org, markRemoved } = require('./ctx');
const schema = require('./schema');
const entities = require('./entities');

/* =====================================================================
 * 引用完整性：体检与自愈（V10 起有了纯关系表，这一层必须兜住）
 * ---------------------------------------------------------------------
 * class_courses 是唯一一张"只有关系、没有内容"的表，它最容易留下指向空气的行：
 *   ① 课程或班级整行没了（清库、迁移、别的设备的老版本推上来的）
 *   ② 同一个班同一门课两条活绑定（多端各建一次、合并课程时撞车）
 *   ③ 记录上的 courseId 指向已被合并/删除的课程
 *   ④ 成员 courseIds、学生/成员 clsIds 里的悬空 id
 * 这些不修也不会崩，但会变成"这个班选不到课""老师忽然看不到课""按课程统计少一条"
 * 这类偶发怪事——查起来极贵。所以每次启动扫一遍，成本是 O(行数)，可以忽略。
 *
 * 判定口径：**只认"整行不存在"**。班级在回收站里、绑定跟着软删，这是正常状态，
 * 不能当成悬空删掉——班级还原要靠它认回来。
 * ===================================================================*/
function tableIndex() {
  const cls = {}, crs = {};
  (core.coll('classes') || []).forEach(c => { if (c) cls[c.id] = c; });
  (core.coll('courses') || []).forEach(c => { if (c) crs[c.id] = c; });
  return { cls, crs };
}

// 课程是否还"能用"：存在、没删、不是合并墓碑
function courseAlive(crs, id) {
  const c = crs[id];
  return !!(c && !c.removed && !c.mergedInto);
}
function classAlive(cls, id) {
  const c = cls[id];
  return !!(c && !c.removed);
}

// 只报告、不修改：给测试与"数据体检"用。返回空数组 = 地基是干净的。
//
// wait=true 表示「这一行整行不存在」——它极可能只是还没被同步下来（新设备分批拉取），
// 不是坏了。界面上要把这一类单独说清楚，否则用户一看到红点就去点"修复"，
// 而修复对这类故意不动，会显得点了没反应。
function integrity() {
  const out = [];
  const bad = (kind, id, msg, wait) => out.push({ kind, id, msg, wait: !!wait });
  const { cls, crs } = tableIndex();
  const ids = (name) => {
    const seen = {};
    (core.coll(name) || []).forEach(d => {
      if (!d || d.id === undefined) return;
      if (seen[d.id]) bad(name + '.dupId', d.id, name + ' 里 id 重复：' + d.id);
      seen[d.id] = 1;
    });
  };

  ['classes', 'courses', 'class_courses', 'students', 'records', 'enrollments', 'members'].forEach(ids);

  // 绑定
  const bind = {};
  (core.coll('class_courses') || []).forEach(b => {
    if (!b || b.removed) return;
    if (!cls[b.clsId]) bad('binding.cls', b.id, '绑定指向不存在的班级 ' + b.clsId, true);
    else if (cls[b.clsId].removed) bad('binding.clsDead', b.id, '绑定指向已删除的班级 ' + b.clsId);
    if (!crs[b.courseId]) bad('binding.course', b.id, '绑定指向不存在的课程 ' + b.courseId, true);
    else if (!courseAlive(crs, b.courseId)) bad('binding.courseDead', b.id, '绑定指向已删除/已合并的课程 ' + b.courseId);
    const k = b.clsId + '/' + b.courseId;
    if (bind[k]) bad('binding.dup', b.id, '同一个班有两门同名课程绑定：' + k);
    bind[k] = 1;
  });

  // 记录：班级、学生、课程三个外键
  const stu = {};
  (core.coll('students') || []).forEach(s => { if (s) stu[s.id] = s; });
  (core.coll('records') || []).forEach(r => {
    if (!r || r.removed) return;
    if (r.cid && !classAlive(cls, r.cid)) bad('record.cid', r.id, '记录挂在不存在/已删的班级 ' + r.cid, !cls[r.cid]);
    if (r.sid && !stu[r.sid]) bad('record.sid', r.id, '记录指向不存在的学生 ' + r.sid, true);
    if (r.courseId && !courseAlive(crs, r.courseId)) bad('record.courseId', r.id, '记录的课程指针悬空 ' + r.courseId, !crs[r.courseId]);
  });

  // 学生 / 成员的班级范围
  Object.keys(stu).forEach(k => {
    const s = stu[k];
    (s.clsIds || []).forEach(cid => { if (!classAlive(cls, cid)) bad('student.clsIds', s.id, '学生挂在不存在/已删的班级 ' + cid, !cls[cid]); });
  });
  (core.coll('members') || []).forEach(m => {
    if (!m) return;
    (m.clsIds || []).forEach(cid => { if (!classAlive(cls, cid)) bad('member.clsIds', m.id, '成员负责范围含不存在/已删的班级 ' + cid, !cls[cid]); });
    (m.courseIds || []).forEach(cid => { if (!courseAlive(crs, cid)) bad('member.courseIds', m.id, '成员课程授权悬空 ' + cid, !crs[cid]); });
  });

  // 报名（课时账）
  (core.coll('enrollments') || []).forEach(en => {
    if (!en || en.removed) return;
    if (en.clsId && !classAlive(cls, en.clsId)) bad('enroll.cls', en.id, '课时账挂在不存在/已删的班级 ' + en.clsId, !cls[en.clsId]);
    if (en.studentId && !stu[en.studentId]) bad('enroll.stu', en.id, '课时账指向不存在的学生 ' + en.studentId, true);
  });

  // 软删必须带"哪一批删的"：回收站靠 removedAt 认批（删班级要连报名、绑定一起回来），
  // 少了这个值，还原时认不回来，或者和别的批次串在一起"复活"错的东西。
  ['classes', 'courses', 'class_courses', 'students', 'records', 'enrollments', 'members'].forEach(name => {
    (core.coll(name) || []).forEach(d => {
      if (d && d.removed === true && !(Number(d.removedAt) > 0)) {
        bad('tombstone.' + name, d.id, name + ' 里有一条软删行没有 removedAt（回收站认不回批次）');
      }
    });
  });

  // 跨机构残留：读取已经按 orgId 过滤，但残留行会污染计数、也会被整表推上云。
  // orgs 例外：它的 id 本身就是机构号、行上 orgId 语义不同，单独处理不在这里查。
  const o = org();
  ['classes', 'courses', 'class_courses', 'students', 'records', 'enrollments',
    'members', 'terms', 'templates', 'subjects'].forEach(name => {
    (core.coll(name) || []).forEach(d => {
      if (!d) return;
      if (!d.orgId) bad('orgId.' + name, d.id, name + ' 里有一行没有 orgId（会被当成当前机构推上云）');
      else if (d.orgId !== o) bad('org.' + name, d.id, name + ' 里有别的机构的行：' + d.orgId);
    });
  });

  return out;
}

// 自愈：只修"能证明已经死了"的引用。
//
// 【为什么不能见悬空就删】一台新设备刚上云时，拉取是按集合分批的：
// 可能先到 students、后到 classes。这时学生身上的 clsIds 在本机看起来就是悬空的，
// 若启动就"修掉"，再推回云端，等于用一次本地修复把全班名单清空——比原来的问题严重得多。
// 所以口径是：
//   - **墓碑可证明**（那一行在本地存在，且 removed / mergedInto）→ 修；
//   - **整行不存在**（可能还没同步下来）→ 只报不修，等下一次同步自己长出来。
// 去重（同一个班同一门课两条活绑定）属于纯冗余，直接修，与同步无关。
function repairLinks() {
  const n = { bindings: 0, dupBind: 0, records: 0, members: 0, students: 0 };
  if (core.isReadOnly()) return n;
  const { cls, crs } = tableIndex();
  const t = now();
  // 本地这一行存在、但已经删了/合并了 —— 这种引用一定是死的
  const clsDead = id => !!cls[id] && cls[id].removed;
  const crsDead = id => !!crs[id] && (crs[id].removed || !!crs[id].mergedInto);

  // ① 绑定：两端有墓碑就摘掉；② 活着的按（班, 课）去重
  const keep = {};
  (core.coll('class_courses') || []).forEach(b => {
    if (!b || b.removed) return;
    if (clsDead(b.clsId) || crsDead(b.courseId)) {
      b.removed = true;
      b.removedAt = b.removedAt || (crs[b.courseId] && crs[b.courseId].removedAt)
        || (cls[b.clsId] && cls[b.clsId].removedAt) || t;
      b.updatedAt = t;
      n.bindings++;
      return;
    }
    const k = b.clsId + '/' + b.courseId;
    (keep[k] = keep[k] || []).push(b);
  });
  Object.keys(keep).forEach(k => {
    const g = keep[k].sort((a, b) => a.id - b.id);
    g.slice(1).forEach(b => {
      b.removed = true; b.removedAt = b.removedAt || t; b.updatedAt = t;
      n.dupBind++;
    });
  });

  // ③ 记录的课程指针：指向已删/已合并的课 → 按课程名重新认一次，认不出来才清零
  //    （文字还在，历史照样可读；清零只是断开题库关联，不删内容）
  (core.coll('records') || []).forEach(r => {
    if (!r || r.removed) return;
    if (!r.courseId || !crsDead(r.courseId)) return;
    const hit = r.course
      ? Object.keys(crs).map(k => crs[k]).find(c => c && !c.removed && !c.mergedInto && c.name === r.course)
      : null;
    r.courseId = hit ? hit.id : 0;
    r.updatedAt = t;
    n.records++;
  });

  // ④ 成员/学生的范围数组：只摘掉"本地确认已删"的 id
  (core.coll('members') || []).forEach(m => {
    if (!m) return;
    const clsIds = (m.clsIds || []).filter(id => !clsDead(id));
    const courseIds = (m.courseIds || []).filter(id => !crsDead(id));
    if (clsIds.length !== (m.clsIds || []).length || courseIds.length !== (m.courseIds || []).length) {
      m.clsIds = clsIds; m.courseIds = courseIds; m.updatedAt = t;
      n.members++;
    }
  });
  (core.coll('students') || []).forEach(s => {
    if (!s) return;
    const next = (s.clsIds || []).filter(id => !clsDead(id));
    if (next.length !== (s.clsIds || []).length) { s.clsIds = next; s.updatedAt = t; n.students++; }
  });

  const touched = n.bindings + n.dupBind + n.records + n.members + n.students;
  if (touched) {
    core.persist('class_courses'); core.persist('records');
    core.persist('members'); core.persist('students');
  }
  return n;
}

// 给人看的分组汇总。映射表放在这里而不是页面：kind 由数据层定义，
// 页面只负责画——以后加一类检查，只要在这里补一行，界面自动跟着出现。
const KIND_LABEL = {
  binding_cls: '课程开设指向缺失的班级',
  binding_clsDead: '课程开设指向已删除的班级',
  binding_course: '课程开设指向缺失的课程',
  binding_courseDead: '课程开设指向已删除的课程',
  binding_dup: '同班同课重复开设',
  record_cid: '记录挂在失效的班级',
  record_sid: '记录指向缺失的学生',
  record_courseId: '记录的课程指针已失效',
  student_clsIds: '学生班级范围含失效班级',
  member_clsIds: '老师负责范围含失效班级',
  member_courseIds: '老师课程授权已失效',
  enroll_cls: '课时账挂在失效的班级',
  enroll_stu: '课时账指向缺失的学生'
};
function labelOf(kind) {
  if (/\.dupId$/.test(kind)) return '数据主键重复';
  if (/^tombstone\./.test(kind)) return '删除记录缺少批次时间';
  // 带上具体哪张表：只说"混入其它机构的数据"，用户没法定位、也没法判断要不要紧
  if (/^orgId\./.test(kind)) return '缺少机构号的数据（' + collLabel(kind.slice(6)) + '）';
  if (/^org\./.test(kind)) return '混入其它机构的数据（' + collLabel(kind.slice(4)) + '）';
  return KIND_LABEL[kind.replace(/\./g, '_')] || kind;
}

function collLabel(name) {
  const e = entities.byColl(name);
  return (e && e.label) || name;
}

function integrityGroups() {
  const groups = {};
  integrity().forEach(x => {
    const g = groups[x.kind] = groups[x.kind] || { kind: x.kind, label: labelOf(x.kind), count: 0, wait: true };
    g.count += 1;
    // 只要有一处是真故障，这一组就当故障算
    if (!x.wait) g.wait = false;
  });
  return Object.keys(groups).map(k => groups[k]).sort((a, b) => (a.wait - b.wait) || (b.count - a.count));
}

// 【骨架收编】新装设备的骨架（内置学期、模板、学科、示例账号）在登录前用出厂号建
// （buildFresh 全部挂 schema.DEFAULT_ORG）；首次 hello 时云端发真实机构号、
// 本机 meta.orgId 切换过去，但已经落盘的骨架行不会自己跟着换——
// 它们从此被机构过滤挡住：学期页/模板页看不见、体检报「混入其它机构的数据」。
//
// 这里把这些行统一收编到指定机构号。
// 【为什么安全】云端拉取按 orgId 过滤，本机的出厂号行只可能是本机自己建的骨架，
// 不可能是别人的数据（别人的数据根本拉不进来）；收编只是把它们挂到本来
// 就该属于的机构号上，一条内容都不改。
// 【orgs 为什么跳过】它的 id 本身就是机构号，云端登录后会拉回本机构的行，
// 出厂那行留着无害；改它的 id 会牵连 ownerId 引用，不值得。
// 【幂等】收编后行上不再有出厂号，重复调用是空操作。
function adoptFactoryRows(newOrgId) {
  const n = { rows: 0, colls: [] };
  if (core.isReadOnly()) return n;
  if (!newOrgId || schema.isFactoryOrg(newOrgId)) return n;
  const touched = {};
  entities.ALL_COLLS.forEach(name => {
    if (name === 'orgs') return;
    (core.coll(name) || []).forEach(d => {
      if (!d || !schema.isFactoryOrg(d.orgId)) return;
      d.orgId = newOrgId;
      d.updatedAt = now();
      n.rows++;
      touched[name] = 1;
    });
  });
  n.colls = Object.keys(touched);
  if (n.rows) n.colls.forEach(core.persist);
  return n;
}

// 同一微信绑了多条成员关系（自救重建过负责人、向导重走都可能造成）。
// 云端对「一个 openid 一条成员关系」有硬约束，重复的那条永远推不上去（报 MEM_TAKEN），
// 本机权限判定又按第一条取，等于随机生效 —— 启动时收口：每组保留一条，其余打墓碑进回收站。
// 保留谁：me 指着的 > 有姓名的 > 建得早的。me 若断链（空或指向被删行）改指保留行；
// 保留行没姓名就向账号表借（记录署名要用）。
function dedupeBindings() {
  const n = { rows: 0, renamed: 0 };
  if (core.isReadOnly()) return n;
  const o = org();
  if (!o || schema.isFactoryOrg(o)) return n;
  const alive = (core.coll('members') || []).filter(x => x && !x.removed && String(x.orgId) === String(o) && x.openid);
  const meta = core.meta() || {};
  const byOpen = {};
  alive.forEach(m => (byOpen[m.openid] || (byOpen[m.openid] = [])).push(m));
  Object.keys(byOpen).forEach(k => {
    const g = byOpen[k];
    if (g.length < 2) return;
    const score = m =>
      (String(meta.me || '') === String(m.userId) ? 4 : 0) +
      (String(m.name || '').trim() ? 2 : 0) -
      (Number(m.createdAt) || Number(m.id) || 0) / 1e15;
    g.sort((a, b) => score(b) - score(a));
    const keep = g[0];
    g.slice(1).forEach(m => {
      markRemoved(m, now());
      m.updatedAt = now();
      n.rows++;
    });
    const meAlive = String(meta.me || '') && alive.some(x => String(x.userId) === String(meta.me));
    if (!meAlive) core.updateMeta({ me: keep.userId });
    if (!String(keep.name || '').trim()) {
      const u = (core.coll('users') || []).find(x => x && String(x.id) === String(keep.userId) && !x.removed);
      if (u && String(u.name || '').trim()) {
        keep.name = String(u.name).trim();
        keep.updatedAt = now();
        n.renamed++;
      }
    }
  });
  if (n.rows || n.renamed) core.persist('members');
  return n;
}

module.exports = { integrity, repairLinks, integrityGroups, adoptFactoryRows, dedupeBindings };
