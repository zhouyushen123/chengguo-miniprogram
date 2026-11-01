// utils/db/migrate.js —— 版本迁移
//
// 两条入口，绝不混淆：
//   有 meta（已有数据）→ upgrade()：就地加字段 / 加集合 / 搬权限，一条数据都不重建
//   无 meta（全新安装）→ buildFresh()：建默认班级与演示账号
//   v2 大对象（chengguo_v2）→ build()：从旧的单对象搬家
//
// 铁律：升级只做加法。任何"重建集合"的写法都等于把老师手机上的学生和记录清零。
const schema = require('./schema');

const ORG = schema.DEFAULT_ORG;

function buildFresh(stamp) {
  const cls = [
    schema.normalizeClass({ id: 1, name: '书法班' }, ORG, stamp),
    schema.normalizeClass({ id: 2, name: '素描班' }, ORG, stamp)
  ];
  const courses = [
    schema.normalizeCourse({ id: 1, name: '楷书', clsId: 1 }, ORG, stamp),
    schema.normalizeCourse({ id: 2, name: '素描', clsId: 2 }, ORG, stamp)
  ];
  const users = [
    schema.normalizeUser({ id: 't1', name: '测试老师', role: 'owner' }, ORG, stamp),
    schema.normalizeUser({ id: 'p1', name: '家长演示', role: 'parent' }, ORG, stamp)
  ];
  const templates = schema.DEFAULT_TEMPLATES.map((t, i) =>
    schema.normalizeTemplate({ id: i + 1, name: t.name, options: t.options, sort: i }, ORG, stamp));

  // 机构创建者即负责人；负责人不受数据范围限制，不需要分配班级
  const orgs = [schema.normalizeOrg({ id: ORG, name: '我的机构', ownerId: 't1', status: 'active' }, stamp)];
  const members = [
    schema.normalizeMember({ id: stamp + 1, orgId: ORG, userId: 't1', role: 'owner', name: '测试老师' }, ORG, stamp),
    // 家长在绑定孩子之前没有可见数据，status 置 invited，绑定后转 active
    schema.normalizeMember({ id: stamp + 2, orgId: ORG, userId: 'p1', role: 'parent', name: '家长演示', status: 'invited' }, ORG, stamp)
  ];

  return {
    meta: {
      version: schema.VERSION, orgId: ORG, orgName: '我的机构',
      teacher: '测试老师', me: 't1', demoVersion: 0, createdAt: stamp, updatedAt: stamp
    },
    orgs, members, classes: cls, courses, students: [], records: [], users, templates
  };
}

/* ---------------- 已有数据就地升级（v3 → v4：user 上的权限搬到 member） ---------------- */
function upgrade(loaded, stamp) {
  const meta = loaded.meta || {};
  const orgId = schema.str(meta.orgId, ORG) || ORG;

  // 除权限两类之外，全部按当前 schema 过一遍（保留 id，不重建）
  const classes = (loaded.classes || []).map(c => schema.normalizeClass(c, orgId, stamp));
  const allClsIds = classes.filter(c => !c.removed).map(c => c.id);

  const rawUsers = Array.isArray(loaded.users) ? loaded.users : [];
  const users = rawUsers.map(u => schema.normalizeUser(u, orgId, stamp));

  // 机构：没有就按现有信息补一个，负责人取第一个非家长用户
  const orgs = (Array.isArray(loaded.orgs) && loaded.orgs.length)
    ? loaded.orgs.map(o => schema.normalizeOrg(o, stamp))
    : [schema.normalizeOrg({
      id: orgId,
      name: meta.orgName || '我的机构',
      ownerId: ((users.find(u => u.role !== 'parent') || users[0] || {}).id) || '',
      status: 'active'
    }, stamp)];

  let seq = 0;
  const nextMemberId = () => { seq += 1; return stamp + seq; };

  const source = (Array.isArray(loaded.members) && loaded.members.length)
    ? loaded.members
    : rawUsers.map((u, i) => {
      const oldRole = u.role === 'admin' ? 'admin' : u.role === 'parent' ? 'parent' : 'teacher';
      // 第一个老师升为负责人：他就是这个机构唯一的经营者
      const role = (oldRole === 'teacher' && i === 0) ? 'owner' : oldRole;
      const staff = role !== 'parent';
      const clsIds = schema.numList(u.clsIds);
      return {
        id: nextMemberId(), orgId, userId: u.id, role, name: u.name,
        // 关键：旧版「没分配班级 = 看到全部」是隐式放行。新版 fail-closed，
        // 这里把隐式授权显式化，否则老师升级后会突然什么都看不到。
        clsIds: staff ? (clsIds.length ? clsIds : allClsIds) : [],
        courseIds: staff ? schema.numList(u.courseIds) : [],
        studentIds: role === 'parent' ? schema.numList(u.studentIds) : [],
        status: (role === 'parent' && !schema.numList(u.studentIds).length) ? 'invited' : 'active'
      };
    });

  const members = source.map(m => schema.normalizeMember(m, orgId, stamp));

  return {
    meta: Object.assign({}, meta, {
      version: schema.VERSION,
      orgId,
      orgName: (orgs[0] && orgs[0].name) || meta.orgName || '我的机构',
      updatedAt: stamp
    }),
    orgs, members,
    classes,
    courses: (loaded.courses || []).map(c => schema.normalizeCourse(c, orgId, stamp)),
    students: (loaded.students || []).map(s => schema.normalizeStudent(s, orgId, stamp)),
    records: (loaded.records || []).map(r => schema.normalizeRecord(r, orgId, stamp)),
    users,
    templates: (loaded.templates || []).map(t => schema.normalizeTemplate(t, orgId, stamp))
  };
}

// 遗留模板结构 [{n, opts[]}] → 实体 [{id, name, options[]}]
function buildTemplates(legacyTpls, stamp) {
  if (!Array.isArray(legacyTpls) || !legacyTpls.length) {
    return schema.DEFAULT_TEMPLATES.map((t, i) =>
      schema.normalizeTemplate({ id: i + 1, name: t.name, options: t.options, sort: i }, ORG, stamp));
  }
  return legacyTpls.map((t, i) => schema.normalizeTemplate({
    id: i + 1,
    // 历史改名：知识点掌握→知识掌握，下次课程注意→课程注意
    name: (t.n === '知识点掌握' ? '知识掌握' : t.n === '下次课程注意' ? '课程注意' : t.n),
    options: t.opts || t.options || [],
    sort: i
  }, ORG, stamp));
}

function build(loaded) {
  const stamp = Date.now();
  const legacy = loaded && loaded.meta ? null : require('./storage').readLegacy();
  const old = (legacy && legacy.db) || null;

  if (!old) return buildFresh(stamp);

  // id 只需在各自集合内唯一：每类实体各用一个去重器，避免班级占号把课程 id 顶走
  const uniqOf = () => {
    const used = new Set();
    return id => { let x = Number(id) || 0; while (used.has(x)) x++; used.add(x); return x; };
  };
  const uniqCls = uniqOf(), uniqCrs = uniqOf(), uniqStu = uniqOf(), uniqRec = uniqOf();

  const classes = (old.classes || []).map(c =>
    schema.normalizeClass({ id: uniqCls(c.id), name: c.name, sort: c.sort }, ORG, stamp));
  const classIds = {};
  (old.classes || []).forEach((c, i) => { classIds[c.id] = classes[i].id; });

  const courses = (old.courses || []).map(c =>
    schema.normalizeCourse({ id: uniqCrs(c.id), name: c.name, clsId: classIds[c.clsId] || c.clsId }, ORG, stamp));

  const students = (old.students || []).map(s =>
    schema.normalizeStudent({
      id: uniqStu(s.id), name: s.name,
      clsIds: (s.clsIds || []).map(id => (classIds[id] !== undefined ? classIds[id] : id)),
      parent: s.parent, wechat: s.wechat, photo: s.photo, profile: s.profile, demo: s.demo
    }, ORG, stamp));

  const records = (old.records || []).map(r =>
    schema.normalizeRecord({
      id: uniqRec(r.id), sid: r.sid, cid: classIds[r.cid] !== undefined ? classIds[r.cid] : r.cid,
      course: r.course, date: r.date, score: r.score, tag: r.tag, note: r.note,
      photos: r.photos, videos: r.videos, audio: r.audio, sent: r.sent, demo: r.demo,
      createdAt: r.createdAt, updatedAt: r.updatedAt
    }, ORG, stamp));

  const users = (old.users || []).map(u =>
    schema.normalizeUser({
      id: u.id || ('u' + stamp + Math.floor(Math.random() * 1000)),
      name: u.name, role: u.role,
      clsIds: (u.clsIds || []).map(id => (classIds[id] !== undefined ? classIds[id] : id)),
      courseIds: u.courseIds, studentIds: u.studentIds
    }, ORG, stamp));
  if (!users.length) users.push(schema.normalizeUser({ id: 't1', name: '测试老师', role: 'teacher' }, ORG, stamp));

  const me = users.some(u => u.id === old.me) ? old.me : users[0].id;

  return {
    meta: {
      version: schema.VERSION, orgId: ORG,
      teacher: old.teacher || '测试老师',
      me,
      demoVersion: Number(old.demoVersion) || 0,
      createdAt: stamp, updatedAt: stamp,
      migratedFrom: 'v2'
    },
    classes, courses, students, records, users,
    templates: buildTemplates(legacy.tpls, stamp)
  };
}

module.exports = { build, buildFresh, buildTemplates };
