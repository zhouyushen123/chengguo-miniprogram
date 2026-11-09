// tests/verify_owner_naming.js —— 负责人「我是谁」的命名链路守卫（2026-11-09）
//
// 起因：用户填完机构入驻（联系人写了名字），我的页仍是「未命名」；
// 同步页还刷出三条「机构已有负责人「」」——引号里是空的，等于没说清是谁。
//
// 三个入口各说各话才是根因，三条断言分别钉住：
//   1. 入驻提交时，联系人要能回填负责人姓名（仅限「本人是负责人 + 还没名字」）
//   2. 开通向导的出厂名（空串 / 测试老师）都算"没起名"，都要换成联系人
//   3. 我的页「未命名」必须是个能点的入口，而不是一句死文案
//   4. 负责人冲突的报错必须带「谁 + 哪家 + 下一步」（云端与本地两处文案）
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✘ ' + name + '\n      ' + ((e && e.message) || e).split('\n')[0]); }
}

console.log('\n【入驻表单 → 负责人姓名】');

ok('提交成功后，联系人回填到自己名下（负责人 + 姓名为空才触发）', () => {
  const src = read('pages/apply/apply.js');
  assert.ok(/db\.setTeacher\(/.test(src), '入驻提交没有回填姓名，我的页会一直「未命名」');
  const seg = src.slice(src.indexOf('setTeacher('), src.indexOf('const courses'));
  assert.ok(/role === 'owner'/.test(src), '只该给负责人回填，别把管理员/老师也叫成联系人');
  assert.ok(/\|\| ''\)\.trim\(\)\)|!String\(a\.name/.test(src), '已有姓名的人不能被覆盖');
});

console.log('\n【开通向导：出厂名算什么】');

ok('空名与「测试老师」都当作没起名，一起换成联系人', () => {
  const src = read('pages/setup/setup.js');
  const i = src.indexOf('_renameMe(name)');
  const seg = src.slice(i, i + 500);
  assert.ok(/!cur/.test(seg), '空名字（新装不预置姓名）也要回填');
  assert.ok(/\^测试老师\$/.test(seg), '老出厂名「测试老师」仍要回填');
});

console.log('\n【我的页：未命名要能点】');

ok('身份卡姓名为空时，点卡片先改名而不是跳转', () => {
  const js = read('pages/mine/mine.js');
  assert.ok(/noName/.test(js), '缺 noName 标记，界面不知道姓名为空');
  assert.ok(/onUserCard\(\)/.test(js), '缺身份卡的点击入口');
  const seg = js.slice(js.indexOf('onUserCard()'), js.indexOf('goSetting()'));
  assert.ok(/editable:\s*true/.test(seg), '改名要用可输入的弹窗，别跳一个没有入口的页面');
  assert.ok(/db\.setTeacher\(/.test(seg), '弹窗确认后要真写进去');
});

ok('界面给出「点此设置姓名」的可见提示（不是只留一个未命名）', () => {
  const wxml = read('pages/mine/mine.wxml');
  assert.ok(/bindtap="onUserCard"/.test(wxml), '卡片还绑在旧跳转上');
  assert.ok(/uc-setname/.test(wxml), '缺「点此设置姓名」提示');
  assert.ok(/uc-setname/.test(read('pages/mine/mine.wxss')), '提示有文案没样式');
});

console.log('\n【负责人冲突文案：谁 + 哪家 + 下一步】');

ok('云端报错带机构名与人名，空名兜底「机构创始人」', () => {
  const src = read('cloudfunctions/syncv2/index.js');
  assert.ok(!/'机构已有负责人「' \+ \(clash\[0\]\.name \|\| ''\)/.test(src), '空引号的老文案还在');
  const i = src.indexOf("role === 'owner'");
  const seg = src.slice(i, i + 900);
  assert.ok(/机构创始人/.test(seg), '姓名没填时要有人看懂的兜底称呼');
  assert.ok(/collection\('orgs'\)/.test(seg), '要带上是哪家机构');
  assert.ok(/移交负责人/.test(seg), '要告诉用户下一步该用哪个功能');
});

ok('本地建成员报错同样带人名与指引（两处口径一致）', () => {
  const src = read('utils/db/identity.js');
  const i = src.indexOf("d.role === 'owner'");
  const seg = src.slice(i, i + 400);
  assert.ok(/机构创始人/.test(seg), '本地文案缺兜底称呼');
  assert.ok(/移交负责人/.test(seg), '本地文案缺下一步指引');
});

console.log('');
console.log((fail ? '有 ' + fail + ' 项失败' : '全部 ' + pass + ' 项负责人命名断言通过'));
console.log('verify_owner_naming: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
