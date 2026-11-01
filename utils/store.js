// utils/store.js —— 【兼容层，已废弃】
//
// 数据已拆成规范实体，统一入口是 utils/db。此文件只为一处遗漏的老调用兜底，
// 新代码请一律使用：const db = require('./utils/db');
// 保留的原因：避免任何遗漏的旧调用点直接崩页面。确认全站迁移完可删除本文件。
const db = require('./db');
const schema = require('./db/schema');

const legacyTpls = () => db.templates.list().map(t => ({ n: t.name, opts: t.options.slice() }));

module.exports = {
  init: db.init,
  // 只读快照：给旧代码读数据用，禁止直接改（改了不会更新 updatedAt，也不会同步到云端）
  get: db.raw,
  save: db.flush,
  replaceDb: next => db.merge(next),
  tpls: legacyTpls,
  saveTpls: t => db.templates.replaceAll(t),
  clsName: db.classes.name,
  student: db.students.get,
  coursesOf: db.courses.of,
  studentsOf: db.students.of,
  allStudents: db.students.list,
  today: db.today,
  latestRecord: db.records.latest,
  canSend: db.canSend,
  saveRecord: db.records.save,
  DEFAULT_TPLS: schema.DEFAULT_TEMPLATES.map(t => ({ n: t.name, opts: t.options.slice() })),
  KEY: 'chengguo_v2'
};
