// tests/verify_ava.js —— 全站统一头像口径
// 规则：有照片显示照片，无照片显示色块+白色首字；展示一律走 components/ava，
// 任何页面不得再自己拼头像块（旧的 icoUser 占位 / ava pav 私拼都算违规）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mem = {};
global.wx = {
  getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem), currentSize: 1, limitSize: 10240 })
};
const db = require('../utils/db');

let pass = 0, fail = 0;
function ok(desc, fn) {
  try { fn(); console.log('  ok - ' + desc); pass++; }
  catch (e) { console.log('  FAIL - ' + desc + '\n    ' + e.message); fail++; }
}

/* ---------- 1. 数据层：photo 字段贯通 ---------- */
db.init();
ok('成员与人员都带 photo 档案字段', () => {
  const m = db.members.list()[0];
  assert.ok('photo' in m, 'member 缺 photo');
  const u = db.users.list()[0];
  assert.ok('photo' in u, 'user 缺 photo');
});

ok('memberUpdate 写头像：成员表落库，账号表同步冗余', () => {
  const me = db.members.list()[0];
  const r = db.members.update(me.id, { photo: '/store/a1.jpg' });
  assert.ok(r.ok, r.msg);
  assert.strictEqual(r.item.photo || db.members.get(me.id).photo, '/store/a1.jpg');
  const u = db.users.get(me.userId);
  assert.strictEqual(u.photo, '/store/a1.jpg', '账号表应同步头像');
});

ok('memberView 对外暴露 photo（列表/详情页的数据来源）', () => {
  const m = db.members.list()[0];
  assert.ok('photo' in db.members.view(m));
});

ok('换头像再写一次：以最后一次为准', () => {
  const me = db.members.list()[0];
  db.members.update(me.id, { photo: '/store/a2.jpg' });
  assert.strictEqual(db.members.get(me.id).photo, '/store/a2.jpg');
  assert.strictEqual(db.users.get(me.userId).photo, '/store/a2.jpg');
});

/* ---------- 2. 展示层：组件存在且口径唯一 ---------- */
const ROOT = path.join(__dirname, '..');
ok('components/ava 组件齐备（wxml/js/wxss/json 四件套）', () => {
  ['wxml', 'js', 'wxss', 'json'].forEach(ext => {
    assert.ok(fs.existsSync(path.join(ROOT, 'components/ava/ava.' + ext)), '缺 ava.' + ext);
  });
});

ok('组件在 app.json 全局注册，所有页面可直接用 <ava>', () => {
  const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  assert.strictEqual(app.usingComponents && app.usingComponents.ava, '/components/ava/ava');
});

const PERSON_PAGES = [
  'pages/student/student.wxml',   // 学生个人卡
  'pages/teacher/teacher.wxml',   // 老师/成员个人卡
  'pages/mine/mine.wxml',         // 我的名片
  'pages/index/index.wxml',       // 家长端孩子卡
  'pages/mgr/mgr.wxml'            // 学生列表×2、成员列表
];
ok('五处人物头像页面全部改用 <ava> 组件', () => {
  PERSON_PAGES.forEach(f => {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(s.indexOf('<ava ') > -1, f + ' 未使用 <ava> 组件');
  });
});

ok('旧私拼头像已清干净：页面不再有 stuava 占位块 / ava pav / 头像位 icoUser', () => {
  PERSON_PAGES.forEach(f => {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.strictEqual(s.indexOf('stuava'), -1, f + ' 残留 stuava');
    assert.strictEqual(s.indexOf('ava pav'), -1, f + ' 残留私拼 pav');
    assert.ok(!/class="tava"/.test(s), f + ' 残留 tava 私拼');
  });
});

ok('组件 wxss 三种角色色块齐全（brand/owner/parent），白色首字', () => {
  const s = fs.readFileSync(path.join(ROOT, 'components/ava/ava.wxss'), 'utf8');
  ['ava-brand', 'ava-owner', 'ava-parent'].forEach(c => assert.ok(s.indexOf('.' + c) > -1, '缺 ' + c));
  assert.ok(s.indexOf('color: #fff') > -1, '首字应为白色');
});

console.log('\n全部 ' + pass + ' 项头像统一断言通过');
if (fail) { console.log(fail + ' 项失败'); process.exit(1); }
