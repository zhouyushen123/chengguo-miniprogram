// 复现真机「点胶囊崩溃」：以真机方式触发 mgr 弹窗的各个 tap 处理链
// 真机 dataset 的取值可能为字符串，这里按最严格情况模拟
const path = require('path');
const mem = {};
const fs = require('fs');
const os = require('os');
global.wx = {
  getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete mem[k]; },
  showToast: () => {}, showModal: o => { o && o.success && o.success({ confirm: true }); },
  navigateTo: () => {}, switchTab: () => {}, navigateBack: () => {},
  setNavigationBarTitle: () => {}, stopPullDownRefresh: () => {},
  previewImage: () => {}, setClipboardData: o => { o && o.success && o.success(); },
  setNavigationBarColor: () => {}, setTabBarStyle: () => {},
  getSystemInfoSync: () => ({ platform: 'devtools' }),
  canIUse: () => true,
  createInnerAudioContext: () => ({ onEnded() {}, onError() {}, play() {}, stop() {} }),
  env: { USER_DATA_PATH: fs.mkdtempSync(path.join(os.tmpdir(), 'cg-')) },
  getFileSystemManager: () => ({ copyFileSync() {}, mkdirSync() {}, accessSync() {}, statSync() { throw new Error('no'); } })
};
const appInst = { globalData: { pick: null } };
global.getApp = () => appInst;
global.App = () => {};
let captured = null;
global.Page = cfg => { captured = cfg; };

function loadPage(rel) {
  captured = null;
  const full = path.join(__dirname, '..', rel.replace(/^\//, ''));
  delete require.cache[require.resolve(full)];
  require(full);
  const page = Object.assign({}, captured);
  page.data = JSON.parse(JSON.stringify(captured.data || {}));
  page.setData = function (p) {
    Object.keys(p).forEach(k => {
      if (k.indexOf('.') > -1) {
        const ps = k.split('.'); let o = page.data;
        for (let i = 0; i < ps.length - 1; i++) { if (!o[ps[i]]) o[ps[i]] = {}; o = o[ps[i]]; }
        o[ps[ps.length - 1]] = p[k];
      } else page.data[k] = p[k];
    });
  };
  return page;
}

const db = require('../utils/db');
db.init();

const errors = [];
const tap = (page, fn, dataId, label) => {
  try {
    // 真机场景 A：dataset 为字符串；场景 B：数字。都试一遍
    page[fn]({ currentTarget: { dataset: { id: String(dataId) } } });
    page[fn]({ currentTarget: { dataset: { id: dataId } } });
    console.log('PASS', label);
  } catch (e) {
    errors.push(label + ': ' + (e && e.stack || e));
    console.log('FAIL', label, '->', e.message);
  }
};

const mgr = loadPage('pages/mgr/mgr.js');
mgr.onShow();

// 打开编辑学生弹窗，点班级胶囊
mgr.editStudent({ currentTarget: { dataset: { id: String(mgr.data.students[0].id) } } });
console.log('stuForm open:', !!mgr.data.stuForm, 'stuClsChips:', JSON.stringify(mgr.data.stuClsChips));
mgr.data.stuClsChips.forEach(c => tap(mgr, 'stuClsTgl', c.id, 'stuClsTgl cls=' + c.name));

// 成员弹窗：老师 → 负责班级/课程权限；家长 → 关联孩子
mgr.addUserTeacher();
console.log('userForm(teacher) chips cls/crs:', mgr.data.userClsChips.length, mgr.data.userCrsChips.length);
mgr.data.userClsChips.forEach(c => tap(mgr, 'userClsTgl', c.id, 'userClsTgl cls=' + c.name));
mgr.data.userCrsChips.forEach(c => tap(mgr, 'userCrsTgl', c.id, 'userCrsTgl crs=' + c.name));

mgr.pickRole({ currentTarget: { dataset: { k: 'parent' } } });
console.log('userForm(parent) chips stu:', mgr.data.userStuChips.length);
mgr.data.userStuChips.slice(0, 10).forEach(c => tap(mgr, 'userStuTgl', c.id, 'userStuTgl stu=' + c.name));

// 保存路径也走一遍
try { mgr.userSave(); console.log('PASS userSave(parent)'); } catch (e) { errors.push('userSave: ' + e.stack); console.log('FAIL userSave', e.message); }

console.log('----');
console.log(errors.length ? errors.join('\n\n') : '逻辑层无异常');
