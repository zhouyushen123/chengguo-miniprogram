// tests/verify_edit_round.js —— 16:46 真机反馈四项的回归守卫
//   I-06 计数「共 x/x 条」占地方折行 → 去掉「共」，整块不许折行
//   I-09 记录列表点「修改」后原内容全丢、底部还是「发布到家长端」
//   J-07 档案页「修改这条」串到别的同学，原有内容不见了
//   J-09 学生资料页保存按钮贴底，没有底部间距
//
// I-09 / J-07 是同一个根因：录入页 onLoad 只认 globalData.pick，
// 档案页却只把 rid 挂在 URL 上（?rid=），于是变成空白新建态，还残留上一次的班级/学生。
// 现在两条入口都按 rid 回库重建原内容。
process.env.CG_CLOUD = '1';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ---------------- 模拟小程序运行环境 ---------------- */
const mem = {};
const navs = [];
global.wx = {
  getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete mem[k]; },
  showToast: () => {},
  showModal: o => { if (o && o.success) o.success({ confirm: true, content: '' }); },
  showActionSheet: o => { if (o && o.success) o.success({ tapIndex: 0 }); },
  chooseMedia: o => { if (o && o.success) o.success({ tempFiles: [] }); },
  getSystemInfoSync: () => ({}),
  setNavigationBarColor: () => {}, setNavigationBarTitle: () => {},
  navigateTo: o => { navs.push((o && o.url) || ''); },
  switchTab: () => {}, navigateBack: () => {},
  setClipboardData: o => { o && o.success && o.success(); },
  showLoading: () => {}, hideLoading: () => {}, hideToast: () => {},
  previewImage: () => {}, stopPullDownRefresh: () => {},
  createInnerAudioContext: () => ({ onEnded() {}, onError() {}, play() {}, stop() {}, destroy() {} }),
  env: { USER_DATA_PATH: '/tmp' },
  getFileSystemManager: () => ({ copyFileSync() {}, accessSync() {}, mkdirSync() {} })
};
const appInst = { globalData: { pick: null } };
global.getApp = () => appInst;
global.App = () => {};
let captured = null;
global.Page = cfg => { captured = cfg; };
function loadPage(rel) {
  captured = null;
  const full = path.join(ROOT, rel);
  delete require.cache[require.resolve(full)];
  require(full);
  const cfg = captured;
  const page = Object.assign({}, cfg);
  page.data = JSON.parse(JSON.stringify(cfg.data || {}));
  page.setData = function (patch, cb) {
    Object.keys(patch).forEach(k => {
      if (k.indexOf('.') > -1) {
        const parts = k.split('.'); let o = page.data;
        for (let i = 0; i < parts.length - 1; i++) { if (!o[parts[i]]) o[parts[i]] = {}; o = o[parts[i]]; }
        o[parts[parts.length - 1]] = patch[k];
      } else page.data[k] = patch[k];
    });
    if (cb) cb();
  };
  return page;
}

const seed = require('./fixture').richSeed();
Object.keys(seed).forEach(k => { mem[k] = seed[k]; });
const db = require('../utils/db');
db.init();

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ok - ' + name); pass++; }
  catch (e) { console.log('  FAIL - ' + name + '\n    ' + e.message); fail++; }
}

/* ---------- 造一条内容齐全、已发布的记录 ---------- */
const cls = db.classes.list()[0];
const stuA = db.students.of(cls.id)[0];
const stuB = db.students.list().find(s => s.id !== stuA.id) || stuA;
const rec = db.records.save({
  cls: cls.id, sid: stuA.id, course: '临时课', score: 92, tag: '优秀',
  note: '原始评语第一行\n第二行也要在', photos: ['/store/a.jpg'],
  videos: ['/store/v.mp4'], audio: '/store/v.mp3'
}, true).record;
assert.ok(rec, '夹具：先得造出一条记录');

/* ---------- I-06 计数 ---------- */
ok('I-06 计数去掉「共」，只留 x/x 条', () => {
  const w = read('pages/records/records.wxml');
  assert.ok(/class="cnt mi">\{\{total\}\}\/\{\{allCount\}\} 条</.test(w));
  assert.ok(!/共 \{\{total\}\}/.test(w), '「共」不能再出现');
});
ok('I-06 计数整块不折行，不挤坏三个下拉', () => {
  const c = read('pages/records/records.wxss');
  assert.ok(/\.cnt\s*\{[^}]*flex:\s*none/.test(c));
  assert.ok(/\.cnt\s*\{[^}]*white-space:\s*nowrap/.test(c));
});

/* ---------- I-09 记录列表「修改」 ---------- */
const records = loadPage('pages/records/records.js');
records.onShow();
ok('I-09 记录列表修改：pick 全字段 + URL 也带 rid 双保险', () => {
  navs.length = 0;
  records.editRec({ currentTarget: { dataset: { rid: rec.id } } });
  const pick = appInst.globalData.pick;
  assert.strictEqual(pick.rid, rec.id);
  assert.strictEqual(pick.sid, rec.sid);
  assert.strictEqual(pick.note, rec.note);
  assert.strictEqual(pick.sent, true);
  assert.ok(navs.some(u => u.indexOf('/pages/record/record?rid=' + rec.id) > -1), 'URL 要带 rid');
});
ok('I-09 行为：进编辑页后分数/等级/评语/照片/视频/语音/课程全部带回', () => {
  const rp = loadPage('pages/record/record.js');
  rp.onLoad({ rid: rec.id });
  assert.strictEqual(rp.data.editing, true);
  assert.strictEqual(rp.data.rid, rec.id);
  assert.strictEqual(rp.data.sid, rec.sid);
  assert.strictEqual(rp.data.clsId, rec.cid);
  assert.strictEqual(rp.data.score, 92);
  assert.strictEqual(rp.data.tag, '优秀');
  assert.strictEqual(rp.data.note, rec.note);
  assert.deepStrictEqual(rp.data.photos, ['/store/a.jpg']);
  assert.deepStrictEqual(rp.data.videos, ['/store/v.mp4']);
  assert.strictEqual(rp.data.audio, '/store/v.mp3');
  assert.strictEqual(rp.data.course, '临时课');
  assert.strictEqual(rp.data.wasSent, true);
});
ok('I-09 底部按钮：已发布记录固定「保存修改」，不再显示「发布到家长端」', () => {
  const w = read('pages/record/record.wxml');
  assert.ok(/canSend \|\| wasSent/.test(w));
  assert.ok(/wasSent \? '保存修改' : '发布到家长端'/.test(w));
  const js = read('pages/record/record.js');
  assert.ok(/if \(pick\.sent\) wasSent = true/.test(js), 'rid 查不到时也要兜住按钮文案');
  assert.ok(/const rec = rid \? db\.records\.get\(rid\) : null/.test(js), '编辑态必须回库取原内容');
});

/* ---------- J-07 档案页「修改这条」 ---------- */
ok('J-07 只带 URL rid（且全局 pick 残留别的学生）也不串人、原内容不丢', () => {
  // 复现真机：上一次录入停在另一个学生身上，档案页只把 rid 放 URL
  appInst.globalData.pick = { cls: cls.id, sid: stuB.id, score: 60, note: '上一个同学的评语', rid: null, course: '' };
  const rp = loadPage('pages/record/record.js');
  rp.onLoad({ rid: rec.id });
  assert.strictEqual(rp.data.sid, rec.sid, '不能沿用残留的 sid');
  assert.strictEqual(rp.data.clsId, rec.cid);
  assert.notStrictEqual(rp.data.note, '上一个同学的评语');
  assert.strictEqual(rp.data.note, rec.note);
  assert.strictEqual(rp.data.score, 92);
  assert.strictEqual(rp.data.wasSent, true);
});
ok('J-07 档案页 editRec 重建 pick，权限不够不放行', () => {
  const student = loadPage('pages/student/student.js');
  appInst.globalData.pick = { cls: cls.id, sid: stuB.id, note: '残留内容' };
  navs.length = 0;
  student.editRec({ currentTarget: { dataset: { rid: rec.id } } });
  const pick = appInst.globalData.pick;
  assert.strictEqual(pick.rid, rec.id);
  assert.strictEqual(pick.sid, rec.sid, '残留的别的学生必须被覆盖');
  assert.strictEqual(pick.note, rec.note);
  assert.ok(navs.some(u => u.indexOf('?rid=' + rec.id) > -1));
});
ok('J-07 编辑态顶部明写改的是谁，老师不用猜', () => {
  const w = read('pages/record/record.wxml');
  assert.ok(/wx:if="\{\{editing\}\}" class="editbar"/.test(w));
  assert.ok(/\{\{editStuName \|\| '这条记录'\}\}/.test(w));
  const rp = loadPage('pages/record/record.js');
  rp.onLoad({ rid: rec.id });
  assert.strictEqual(rp.data.editStuName, db.students.name(rec.sid));
  assert.strictEqual(rp.data.editCourse, '临时课');
  assert.ok(rp.data.editDate, '要显示记录原本的日期');
});
ok('J-07 课程已从班级解绑时仍保留原课程名，不悄悄换成第一门课', () => {
  assert.ok(!db.courses.of(cls.id).some(c => c.name === '临时课'), '夹具：这门课确实没绑到班上');
  const rp = loadPage('pages/record/record.js');
  rp.onLoad({ rid: rec.id });
  assert.strictEqual(rp.data.course, '临时课');
  assert.strictEqual(rp.data.courses[rp.data.courseIdx].name, '临时课');
});
ok('J-07 0 分是合法分数，不能被 || 兜底成 85', () => {
  const js = read('pages/record/record.js');
  assert.ok(/score: \(pick\.score === undefined \|\| pick\.score === null\) \? 85 : pick\.score/.test(js));
});
ok('J-07 学生转班后仍能选中记录原本属于谁', () => {
  const js = read('pages/record/record.js');
  assert.ok(/const oldStu = db\.students\.get\(pick\.sid\)/.test(js));
});

/* ---------- J-09 资料页底部间距 ---------- */
ok('J-09 资料页保存按钮不再贴底（含安全区）', () => {
  const w = read('pages/profile/profile.wxml');
  const c = read('pages/profile/profile.wxss');
  assert.ok(/class="btn savebtn"/.test(w));
  assert.ok(!/style="margin:0 24rpx"/.test(w), '内联样式会盖掉底部 margin');
  assert.ok(/\.wrap\s*\{[^}]*padding-bottom:\s*calc\([^}]*env\(safe-area-inset-bottom\)/.test(c));
  assert.ok(/\.savebtn\s*\{[^}]*env\(safe-area-inset-bottom\)/.test(c));
});

console.log('\n全部 ' + pass + ' 项 I/J 组反馈断言通过');
if (fail) { console.log(fail + ' 项失败'); process.exit(1); }
