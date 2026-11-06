// utils/db/integrity.js —— 引用完整性：体检（只读）与自愈（写回）
//
// 抽成独立文件的原因：启动维护（maintenance.js）已经顶到 500 行门槛，
// 而这套东西是"库级"的，不属于任何一个业务领域，单独一层最清楚。
// 依赖：core（全量集合）+ ctx（机构/时间）。不依赖任何领域模块，不产生环。
const core = require('./core');
const { now, org } = require('./ctx');

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
function integrity() {
  const out = [];
  const bad = (kind, id, msg) => out.push({ kind, id, msg });
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
    if (!cls[b.clsId]) bad('binding.cls', b.id, '绑定指向不存在的班级 ' + b.clsId);
    else if (cls[b.clsId].removed) bad('binding.clsDead', b.id, '绑定指向已删除的班级 ' + b.clsId);
    if (!crs[b.courseId]) bad('binding.course', b.id, '绑定指向不存在的课程 ' + b.courseId);
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
    if (r.cid && !classAlive(cls, r.cid)) bad('record.cid', r.id, '记录挂在不存在/已删的班级 ' + r.cid);
    if (r.sid && !stu[r.sid]) bad('record.sid', r.id, '记录指向不存在的学生 ' + r.sid);
    if (r.courseId && !courseAlive(crs, r.courseId)) bad('record.courseId', r.id, '记录的课程指针悬空 ' + r.courseId);
  });

  // 学生 / 成员的班级范围
  Object.keys(stu).forEach(k => {
    const s = stu[k];
    (s.clsIds || []).forEach(cid => { if (!classAlive(cls, cid)) bad('student.clsIds', s.id, '学生挂在不存在/已删的班级 ' + cid); });
  });
  (core.coll('members') || []).forEach(m => {
    if (!m) return;
    (m.clsIds || []).forEach(cid => { if (!classAlive(cls, cid)) bad('member.clsIds', m.id, '成员负责范围含不存在/已删的班级 ' + cid); });
    (m.courseIds || []).forEach(cid => { if (!courseAlive(crs, cid)) bad('member.courseIds', m.id, '成员课程授权悬空 ' + cid); });
  });

  // 报名（课时账）
  (core.coll('enrollments') || []).forEach(en => {
    if (!en || en.removed) return;
    if (en.clsId && !classAlive(cls, en.clsId)) bad('enroll.cls', en.id, '课时账挂在不存在/已删的班级 ' + en.clsId);
    if (en.studentId && !stu[en.studentId]) bad('enroll.stu', en.id, '课时账指向不存在的学生 ' + en.studentId);
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

  // 跨机构残留：读取已经按 orgId 过滤，但残留行会污染计数、也会被整表推上云
  const o = org();
  ['classes', 'courses', 'class_courses', 'students', 'records', 'enrollments', 'members'].forEach(name => {
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

module.exports = { integrity, repairLinks };
