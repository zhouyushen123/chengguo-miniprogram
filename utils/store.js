// utils/store.js —— 本地数据层（与 H5 版数据结构一致，DB: chengguo_v2）
const KEY = 'chengguo_v2';
const TPL_KEY = 'chengguo_tpls';

const DEFAULT_TPLS = [
  { n: '上课态度', opts: ['认真专注，积极举手发言', '听讲认真，偶有走神，提醒后能改正', '状态放松，与同学互动积极'] },
  { n: '反馈交流', opts: ['能主动和老师交流，回答问题思路清晰', '愿意表达自己的想法，敢于提问', '与老师配合默契，反馈及时'] },
  { n: '课堂记录', opts: ['本节课完成新内容练习，整体完成度较高', '本节课以复习巩固为主，练习认真', '课堂纪律良好，练习节奏跟得上'] },
  { n: '知识掌握', opts: ['已基本掌握本节内容，细节还需多加练习', '重点内容掌握扎实，可进入下一阶段', '部分知识点还需课后加强，建议多练'] },
  { n: '课程注意', opts: ['请课后复习本节内容，下节课将巩固练习', '请提前完成课后作业，下节课检查讲评', '下节课将学习新内容，请保持状态'] }
];

// 演示数据（45 位书法班学生 + 历史成果记录），见 utils/demo-data.js
const demo = require('./demo-data');
const pinyin = require('./pinyin');

let db = null;

// 一键灌入/刷新演示数据：旧版演示学生与记录先清掉再灌入，避免重复
function seedDemo() {
  if (db.demoVersion === demo.DEMO_VERSION) return;
  db.records = (db.records || []).filter(r => !r.demo);
  const demoIdSet = {};
  demo.DEMO_STUDENTS.forEach(s => { demoIdSet[s.id] = 1; });
  const OLD_DEMO_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]; // 早期种子与第一版演示学生
  // 旧演示学生整批移除（新旧 id 相同，属同一批演示数据，直接替换）
  db.students = (db.students || []).filter(s =>
    !(s.demo || OLD_DEMO_IDS.indexOf(s.id) > -1 || demoIdSet[s.id])
  );
  db.students = db.students.concat(demo.DEMO_STUDENTS.map(s => Object.assign({}, s, { clsIds: s.clsIds.slice() })));
  db.records = db.records.concat(demo.DEMO_RECORDS.map(r => Object.assign({}, r)));
  const p = (db.users || []).find(u => u.role === 'parent');
  if (p) p.studentIds = [demo.DEMO_STUDENTS[0].id]; // 家长演示账号绑定第一个孩子
  db.demoVersion = demo.DEMO_VERSION;
  delete db.seedStudents;
  save();
}

function init() {
  db = wx.getStorageSync(KEY) || null;
  if (!db) {
    db = {
      teacher: '测试老师', me: 't1', role: 'teacher',
      users: [{ id: 't1', name: '测试老师', role: 'teacher' }, { id: 'p1', name: '家长演示', role: 'parent' }],
      classes: [{ id: 1, name: '书法班' }, { id: 2, name: '素描班' }],
      courses: [{ id: 1, name: '楷书', clsId: 1 }, { id: 2, name: '素描', clsId: 2 }],
      students: [],
      records: [],
      profile: {}
    };
    save();
  }
  seedDemo();
  // 模板维度名历史改名：知识点掌握→知识掌握、下次课程注意→课程注意（就地迁移，选项内容不变）
  const storedTpls = wx.getStorageSync(TPL_KEY);
  if (!storedTpls) wx.setStorageSync(TPL_KEY, DEFAULT_TPLS);
  else if (storedTpls.some(t => t.n === '知识点掌握' || t.n === '下次课程注意')) {
    storedTpls.forEach(t => {
      if (t.n === '知识点掌握') t.n = '知识掌握';
      if (t.n === '下次课程注意') t.n = '课程注意';
    });
    wx.setStorageSync(TPL_KEY, storedTpls);
  }
}
function get() { return db; }
function save() { wx.setStorageSync(KEY, db); }
function replaceDb(next) { if (next && next.classes) { db = next; save(); } }
function tpls() { return wx.getStorageSync(TPL_KEY) || DEFAULT_TPLS; }
function saveTpls(t) { wx.setStorageSync(TPL_KEY, t); }
function clsName(id) { const c = db.classes.find(x => x.id === id); return c ? c.name : ''; }
function student(id) { return db.students.find(s => s.id === id); }
function coursesOf(clsId) { return db.courses.filter(c => c.clsId === clsId); }
// 学生列表统一按姓氏拼音首字母排序（全站一致），同姓保持原相对顺序
function allStudents() { return pinyin.sortStudents(db.students); }
function studentsOf(clsId) { return pinyin.sortStudents(db.students.filter(s => (s.clsIds || []).includes(clsId))); }
function today() { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
function latestRecord(sid) {
  // 记录 id 随时间递增，统一按 id 倒序取最近一条
  const list = db.records.filter(r => r.sid === sid).sort((a, b) => b.id - a.id);
  return list[0] || null;
}
// 记录状态机：内容补齐（有学生 && 有照片/视频/语音/留言）才可发送
function canSend(pick) {
  return !!(pick.sid && ((pick.photos && pick.photos.length) || (pick.videos && pick.videos.length) || pick.audio || (pick.note && pick.note.trim())));
}
function saveRecord(pick, send) {
  if (send && !canSend(pick)) return { ok: false, msg: '内容还没补齐' };
  const fields = {
    sid: pick.sid, cid: pick.cls, course: pick.course || '', score: pick.score,
    note: pick.note || '', tag: pick.tag || '', audio: pick.audio || null,
    photos: pick.photos || [], videos: pick.videos || [], sent: !!send, updatedAt: Date.now()
  };
  let rid = pick.rid;
  if (rid) {
    const r = db.records.find(x => x.id === rid);
    if (r) Object.assign(r, fields);
  } else {
    rid = Date.now();
    db.records.push(Object.assign({ id: rid, date: today() }, fields));
  }
  save();
  return { ok: true, rid, record: db.records.find(x => x.id === rid) };
}
module.exports = { init, get, save, replaceDb, tpls, saveTpls, clsName, student, coursesOf, studentsOf, allStudents, today, latestRecord, canSend, saveRecord, DEFAULT_TPLS, KEY };
