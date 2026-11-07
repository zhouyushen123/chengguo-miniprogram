// tests/verify_feedback_round.js —— 16:19 真机反馈五项的回归守卫
//   G01 人员卡文字过长把操作按钮挤换行
//   G02 添加完老师不能改资料（列表要有「修改」，且编辑不丢联系方式）
//   G05 学号难记（绑定孩子改为点名字/搜索，不必背 1001）
//   H-20 预览效果只是一段通知文本 → 改成家长视角成果卡
//   H-23 已发布记录按钮态必须是「保存修改」
process.env.CG_CLOUD = '1';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ---------------- 模拟小程序运行环境 ---------------- */
const mem = {};
const toasts = [];
let copied = '';
global.wx = {
  getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete mem[k]; },
  showToast: o => { toasts.push(o && o.title); },
  showModal: o => { if (o && o.success) o.success({ confirm: true, content: '' }); },
  showActionSheet: o => { if (o && o.success) o.success({ tapIndex: 0 }); },
  chooseMedia: o => { if (o && o.success) o.success({ tempFiles: [] }); },
  getSystemInfoSync: () => ({}),
  setNavigationBarColor: () => {}, setNavigationBarTitle: () => {},
  navigateTo: () => {}, switchTab: () => {}, navigateBack: () => {},
  setClipboardData: o => { copied = o.data; o && o.success && o.success(); },
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

/* ---------- G01：按钮不许被文字挤换行 ---------- */
const css = read('pages/mgr/mgr.wxss');
const mw = read('pages/mgr/mgr.wxml');
ok('G01 人员卡：左侧可压缩并单行省略，右侧操作区 fixed 不换行', () => {
  assert.ok(/\.memmain\s*\{[^}]*flex:\s*1[^}]*min-width:\s*0/.test(css));
  assert.ok(/\.memacts\s*\{[^}]*flex:\s*none[^}]*white-space:\s*nowrap/.test(css));
  assert.ok(/\.memmeta\s*\{[^}]*text-overflow:\s*ellipsis/.test(css));
  assert.ok(/class="card item memitem"/.test(mw));
  assert.ok(/class="memmain"/.test(mw) && /class="memacts"/.test(mw));
});

/* ---------- G02：列表有「修改」，编辑不丢字段 ---------- */
const mgr = loadPage('pages/mgr/mgr.js');
mgr.onShow();
ok('G02 人员列表有明确「修改」入口，说明文字同步改口径', () => {
  assert.ok(/catchtap="editUser"[^>]*>修改</.test(mw), '按钮要叫修改，别只叫分配');
  assert.ok(!/>\s*分配\s*</.test(mw), '不该还留着「分配」按钮');
  assert.ok(/点「修改」可改资料/.test(mw));
});

const target = mgr.data.members.find(x => x.role === 'teacher') || mgr.data.members[0];
ok('G02 member 渲染带出 phone/wechat（以前漏字段导致编辑即清空）', () => {
  db.members.update(target.id, { phone: '13800007777', wechat: 'laoshi_wx' });
  mgr.onShow();
  const row = mgr.data.members.find(x => x.id === target.id);
  assert.strictEqual(row.phone, '13800007777');
  assert.strictEqual(row.wechat, 'laoshi_wx');
});

ok('G02 编辑老师：表单回填完整，保存后改资料且不新增成员', () => {
  const before = db.members.list().length;
  mgr.editUser({ currentTarget: { dataset: { id: target.id } } });
  assert.strictEqual(mgr.data.userForm.id, target.id);
  assert.strictEqual(mgr.data.userForm.phone, '13800007777');
  assert.strictEqual(mgr.data.userForm.wechat, 'laoshi_wx');
  assert.ok(/编辑.*资料/.test(mgr.data.userFormTitle));
  mgr.onUserName({ detail: { value: '改名后的老师' } });
  mgr.userSave();
  assert.strictEqual(db.members.list().length, before, '编辑不该多出一条成员');
  const after = db.members.get(target.id);
  assert.strictEqual(after.name, '改名后的老师');
  assert.strictEqual(after.phone, '13800007777', '保存不能把手机号清空');
  assert.strictEqual(after.wechat, 'laoshi_wx', '保存不能把微信清空');
});

/* ---------- G05：不必背学号 ---------- */
ok('G05 打开添加家长就有候选名单，不用输学号', () => {
  mgr.addUserParent();
  assert.ok(mgr.data.userStuCands.length > 0, '默认要列出学生供点选');
  assert.ok(mgr.data.userStuCands.every(c => c.name && c.sub), '候选要带姓名与识别信息');
  assert.ok(/不用记学号/.test(mw));
});

ok('G05 按姓名搜索 → 点名字绑定，学号输入仍可快捷使用', () => {
  const first = mgr.data.userStuCands[0];
  mgr.onUserStuQ({ detail: { value: first.name } });
  assert.ok(mgr.data.userStuCands.some(c => c.id === first.id), '按姓名要能搜到');
  mgr.pickStuCand({ currentTarget: { dataset: { id: first.id } } });
  assert.ok(mgr.data.userStuSel.indexOf(first.id) > -1, '点一下就该绑上');
  const s0 = db.students.list()[0];
  mgr.onBindNo({ detail: { value: s0.no } });
  mgr.bindByNo();
  assert.ok(mgr.data.userStuSel.indexOf(s0.id) > -1, '按学号仍是快捷方式');
  mgr.userCancel();
});

ok('G05 语音说完搜索框会刷新候选；列表学号点一下可复制', () => {
  const voice = read('utils/voice.js');
  assert.ok(/onVoiceDone/.test(voice) && /notify\(page, key\)/.test(voice));
  assert.ok(/onVoiceDone\(key\)/.test(read('pages/mgr/mgr.js')));
  const s0 = db.students.list()[0];
  mgr.copyStuNoList({ currentTarget: { dataset: { no: s0.no } } });
  assert.strictEqual(copied, s0.no);
  assert.ok(/copyStuNoList/.test(mw) && /点按复制/.test(mw));
});

/* ---------- H-20：预览是家长视角成果卡 ---------- */
const tw = read('pages/tpls/tpls.wxml');
ok('H-20 预览页是家长卡片结构，不再只有通知文本 + 附件列表', () => {
  ['pvcard', 'pvhead', 'pvscore', 'pvnote', 'pvfoot', '<ava '].forEach(c =>
    assert.ok(tw.indexOf(c) > -1, '缺 ' + c));
  assert.ok(/家长打开小程序时看到的样子/.test(tw));
  assert.ok(/微信通知文本/.test(tw), '通知文本降级为次要区，但保留可复制');
  assert.ok(/bindtap="pvPhoto"/.test(tw) && /bindtap="pvPlayAudio"/.test(tw), '照片语音仍可交互');
  assert.ok(!/家长收到的通知文本/.test(tw), '不该再把通知文本当主体');
});

const stu0 = db.students.list()[0];
const tpls = loadPage('pages/tpls/tpls.js');
ok('H-20 buildPreview 填出孩子/课程/分数/评语全文/媒体', () => {
  appInst.globalData.pick = {
    sid: stu0.id, cls: db.classes.list()[0].id, course: '素描', score: 92, tag: '优秀',
    note: '第一段评语\n第二段评语', photos: ['/store/a.jpg'], videos: [], audio: null
  };
  tpls.onLoad({ mode: 'preview' });
  assert.strictEqual(tpls.data.pvName, stu0.name);
  assert.strictEqual(tpls.data.pvScore, 92);
  assert.strictEqual(tpls.data.pvTag, '优秀');
  assert.deepStrictEqual(tpls.data.pvNoteLines, ['第一段评语', '第二段评语']);
  assert.strictEqual(tpls.data.hasMedia, true);
  assert.strictEqual(tpls.data.pvPhotos.length, 1);
});

/* ---------- H-23：已发布记录按钮态 ---------- */
const rw = read('pages/record/record.wxml');
ok('H-23 已发布记录：主按钮「保存修改」且不受内容齐全限制', () => {
  assert.ok(/canSend \|\| wasSent/.test(rw), '缺内容也要能保存修改');
  assert.ok(/wx:if="\{\{!wasSent\}\}"/.test(rw), '已发布不该再有「存草稿」');
  assert.ok(/wasSent \? '保存修改' : '发布到家长端'/.test(rw));
  assert.ok(/sentnote/.test(rw) && /改完点「保存修改」/.test(rw));
  assert.ok(/if \(pick\.sent\) wasSent = true/.test(read('pages/record/record.js')));
  assert.ok(/sent: !!r\.sent/.test(read('pages/records/records.js')));
});

ok('H-23 行为：打开已发布记录，wasSent 为真（含 rid 查不到的兜底）', () => {
  const r = db.records.save({
    cls: db.classes.list()[0].id, sid: stu0.id, course: '素描',
    note: '已发布的评语', photos: ['/store/a.jpg']
  }, true).record;
  appInst.globalData.pick = {
    cls: r.cid, sid: r.sid, rid: r.id, sent: true, score: r.score, tag: r.tag,
    note: r.note, photos: r.photos, videos: [], audio: null, course: r.course
  };
  const rp = loadPage('pages/record/record.js');
  rp.onLoad({});
  assert.strictEqual(rp.data.wasSent, true);
  assert.strictEqual(rp.data.editing, true);
});

console.log('\n全部 ' + pass + ' 项真机反馈断言通过');
if (fail) { console.log(fail + ' 项失败'); process.exit(1); }
