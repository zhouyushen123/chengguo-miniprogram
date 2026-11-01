// utils/db/migrate.js —— 版本迁移
//
// v2（单个大对象 chengguo_v2 + 独立模板 key）→ v3（按实体分集合）
// 迁移只做"搬家 + 补字段"，不删除旧 key：万一新版出问题，旧数据还在，回退不会丢东西。
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
    schema.normalizeUser({ id: 't1', name: '测试老师', role: 'teacher' }, ORG, stamp),
    schema.normalizeUser({ id: 'p1', name: '家长演示', role: 'parent' }, ORG, stamp)
  ];
  const templates = schema.DEFAULT_TEMPLATES.map((t, i) =>
    schema.normalizeTemplate({ id: i + 1, name: t.name, options: t.options, sort: i }, ORG, stamp));
  return {
    meta: {
      version: schema.VERSION, orgId: ORG,
      teacher: '测试老师', me: 't1', demoVersion: 0, createdAt: stamp, updatedAt: stamp
    },
    classes: cls, courses, students: [], records: [], users, templates
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
