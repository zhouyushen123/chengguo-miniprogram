// tests/verify_import.js —— 学生批量导入
// 覆盖：云函数解析纯函数（表头/无表头/序号清洗/去重/性别归一/docx 抽文本/AI JSON 防御）
//       + 前端预览去重 + 批量建档落库
const assert = require('assert');
const path = require('path');
const parse = require('../cloudfunctions/stuImport/parse.js');
const roster = require('../utils/roster');

const mem = {};
global.wx = {
  getStorageSync: k => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : ''),
  setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); },
  removeStorageSync: k => { delete mem[k]; },
  getStorageInfoSync: () => ({ keys: Object.keys(mem), currentSize: 1, limitSize: 10240 })
};
const db = require('../utils/db');
db.init();

let pass = 0, fail = 0;
function ok(desc, fn) {
  try { fn(); console.log('  ok - ' + desc); pass++; }
  catch (e) { console.log('  FAIL - ' + desc + '\n    ' + (process.env.STACK ? e.stack : e.message)); fail++; }
}

console.log('【云函数 · 表格解析】');
ok('带表头：姓名/性别/家长三列按列名取', () => {
  const rows = [['序号', '姓名', '性别', '家长姓名'], ['1', '刘旭然', '男', '刘先生'], ['2', '周诺昭', '女', '周女士']];
  const s = parse.tableFromRows(rows);
  assert.deepStrictEqual(s, [
    { name: '刘旭然', gender: '男', parent: '刘先生' },
    { name: '周诺昭', gender: '女', parent: '周女士' }
  ]);
});

ok('无表头：默认第一列是姓名，性别/家长留空', () => {
  const s = parse.tableFromRows([['张小明'], ['李小花']]);
  assert.deepStrictEqual(s, [
    { name: '张小明', gender: '', parent: '' },
    { name: '李小花', gender: '', parent: '' }
  ]);
});

ok('姓名清洗：序号前缀、空白、标点都剥掉', () => {
  const s = parse.tableFromRows([['1.  王一二 '], ['2、陈三四。']]);
  assert.deepStrictEqual(s.map(x => x.name), ['王一二', '陈三四']);
});

ok('名单内去重 + 垃圾行剔除（空行/纯数字/班级名）', () => {
  const rows = [['姓名'], ['张小明明'], ['张小明明'], [''], ['101'], ['素描一班']];
  const s = parse.tableFromRows(rows);
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].name, '张小明明');
});

ok('性别归一：只认 男/女，其它留空', () => {
  assert.strictEqual(parse.normGender('男性'), '男');
  assert.strictEqual(parse.normGender('girl'), '');
});

ok('csv 文本：中英文逗号、Tab 都能切列', () => {
  const rows = parse.parseCsvText('姓名，性别\n赵钱孙,男\n李 四\t女');
  const s = parse.tableFromRows(rows);
  assert.deepStrictEqual(s.map(x => x.name), ['赵钱孙', '李四']);
  assert.strictEqual(s[0].gender, '男');
});

ok('docx 抽文本：段落断行、标签剔除、实体还原', () => {
  const xml = '<w:body><w:p><w:r><w:t>张三</w:t></w:r></w:p><w:p><w:r><w:t>李&amp;四</w:t></w:r></w:p></w:body>';
  const t = parse.stripDocxXml(xml);
  assert.strictEqual(t.indexOf('张三\n李&四') > -1, true);
});

console.log('【云函数 · AI 输出防御】');
ok('AI 返回带代码块/废话也能抽出 JSON 数组', () => {
  const s = parse.pickAiStudents('好的，以下是名单：\n```json\n[{"name":"王五","gender":"男"},{"name":"赵六"}]\n```');
  assert.deepStrictEqual(s, [{ name: '王五', gender: '男', parent: '' }, { name: '赵六', gender: '', parent: '' }]);
});

ok('AI 烂输出（非 JSON / 无数组 / 名字含数字）不炸，返回空或过滤', () => {
  assert.deepStrictEqual(parse.pickAiStudents('我看不清'), []);
  assert.deepStrictEqual(parse.pickAiStudents('{"a":1}'), []);
  const s = parse.pickAiStudents('[{"name":"1班"},{"name":"周七个字的名字也可以但数字123不行"}]');
  assert.strictEqual(s.length, 0);
});

console.log('【前端 · 预览与落库】');
ok('班内重名标记：已存在的默认不勾（dupe=true）', () => {
  const marked = roster.markDupes([{ name: '刘旭然' }, { name: '新同学' }], ['刘旭然']);
  assert.strictEqual(marked[0].dupe, true);
  assert.strictEqual(marked[1].dupe, false);
});

ok('批量建档：勾选的逐条 create 挂进所选班级', () => {
  const t = db.terms.list().find(x => x.builtIn) || db.terms.create({ name: '导入测试学期' }).item;
  const cls = db.classes.create({ name: '导入测试班', termId: t.id }).item;
  const picks = [{ name: '导入甲', gender: '男', parent: '' }, { name: '导入乙', gender: '', parent: '' }];
  let added = 0;
  picks.forEach(s => {
    const r = db.students.create({ name: s.name, gender: s.gender, parent: s.parent, clsIds: [cls.id] });
    if (r.ok) added++;
  });
  assert.strictEqual(added, 2);
  const inCls = db.students.list().filter(x => (x.clsIds || []).indexOf(cls.id) > -1);
  assert.ok(inCls.some(x => x.name === '导入甲' && x.no), '建档应自动分配学号');
});

ok('结果文案：导入数/重名跳过/失败都报清楚', () => {
  const t = roster.resultText({ added: 12, dupes: 2, failed: 1, failMsg: '学生姓名过长' });
  assert.ok(t.indexOf('已导入 12 名学生') > -1 && t.indexOf('2 名班内重名') > -1 && t.indexOf('1 名建档失败') > -1);
});

console.log('\n全部 ' + pass + ' 项批量导入断言通过');
if (fail) { console.log(fail + ' 项失败'); process.exit(1); }
