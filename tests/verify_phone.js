// tests/verify_phone.js —— 手机号录入：格式化（3-4-4）与校验的唯一口径
//
// 守三件事：
//   1. utils/phone.js 本身的格式化/校验规则（正着格式化、反着还原裸数字）
//   2. 四个录入页面全部走同一套口径（不许哪个页面自己再写一份正则）
//   3. 展示串带横线，落库必须还原成 11 位裸数字（显示与存储分离）
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const tel = require(path.join(ROOT, 'utils/phone'));

console.log('\n【格式化】');
ok('空输入：格式化结果为空串', () => {
  assert.strictEqual(tel.fmt(''), '');
  assert.strictEqual(tel.fmt(null), '');
  assert.strictEqual(tel.fmt('abc'), '', '非数字字符全部剥掉');
});
ok('逐位输入：够 4 位才出现第一个横线，够 8 位才出现第二个', () => {
  assert.strictEqual(tel.fmt('1'), '1');
  assert.strictEqual(tel.fmt('186'), '186');
  assert.strictEqual(tel.fmt('1867'), '186-7');
  assert.strictEqual(tel.fmt('18674'), '186-74');
  assert.strictEqual(tel.fmt('1867488'), '186-7488');
  assert.strictEqual(tel.fmt('18674882'), '186-7488-2');
  assert.strictEqual(tel.fmt('18674882783'), '186-7488-2783');
});
ok('粘贴带横线/带空格/超长的串：剥成裸数字再截到 11 位', () => {
  assert.strictEqual(tel.fmt('186 7488 2783'), '186-7488-2783');
  assert.strictEqual(tel.fmt('1867488278312345678'), '186-7488-2783', '粘贴超长只留 11 位');
});
ok('用户删掉一个横线也不会卡死：digits 还原裸数字', () => {
  assert.strictEqual(tel.digits('186-7488-2783'), '18674882783');
  assert.strictEqual(tel.digits('186-748'), '186748');
});

console.log('\n【校验】');
ok('合法号：11 位、1 开头、第二位 3-9', () => {
  assert.strictEqual(tel.valid('18674882783'), true);
  assert.strictEqual(tel.valid('186-7488-2783'), true, '带横线的展示串也能判');
});
ok('非法号：位数不够/超长/前缀不对/全字母', () => {
  assert.strictEqual(tel.valid('1867488278'), false, '10 位');
  assert.strictEqual(tel.valid('12674882783'), false, '第二位不在 3-9');
  assert.strictEqual(tel.valid('08674882783'), false, '0 开头');
  assert.strictEqual(tel.valid('abc'), false);
  assert.strictEqual(tel.valid(''), false);
});

console.log('\n【页面口径统一】');
const PAGES = [
  ['pages/setup/setup.js', 'org.phone'],
  ['pages/apply/apply.js', 'form.phone'],
  ['pages/mgr/mgr.js', 'userForm.phone'],
  ['pages/profile/profile.js', "k === 'phone'"]
];
PAGES.forEach(([rel, marker]) => {
  ok(rel + ' 走 utils/phone 的格式化与校验，不再自写正则', () => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(src.indexOf("require('../../utils/phone')") > -1, '应引入 utils/phone');
    assert.ok(src.indexOf(marker) > -1, '应格式化自己的手机号字段');
    assert.ok(src.indexOf('PHONE_RE') === -1, '不许再留页面级正则');
  });
});
ok('四个输入框 maxlength 都是 13（11 位数字 + 2 个横线）', () => {
  PAGES.forEach(([rel]) => {
    const wxml = fs.readFileSync(path.join(ROOT, rel.replace(/\.js$/, '.wxml')), 'utf8');
    const phoneRows = wxml.split('\n').filter(l => l.indexOf('phone') > -1 && l.indexOf('<input') > -1);
    assert.ok(phoneRows.length > 0, rel + ' 应有手机号输入框');
    phoneRows.forEach(l => assert.ok(l.indexOf('maxlength="13"') > -1, rel + ' 手机号输入框应允许 13 个字符'));
  });
});
ok('落库是裸数字：向导提交存 digits，不存带横线的展示串', () => {
  const src = fs.readFileSync(path.join(ROOT, 'pages/setup/setup.js'), 'utf8');
  assert.ok(/phone:\s*tel\.digits\(f\.phone\)/.test(src), '申请单留档应存裸数字');
});

console.log('\n全部 ' + pass + ' 项手机号断言通过');
if (fail) process.exit(1);
