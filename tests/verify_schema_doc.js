// tests/verify_schema_doc.js —— 数据字典"不许漏表"守卫
//
// 数据字典是从代码生成的，但云端专用表（邀请卡、已读回执、留言、后台账号、备份清单…）
// 不在 entities.js 里，只能人工登记在 tools/schema-doc.js。人一忙就会漏。
// 这里反过来查：把云函数真正用到的集合名扫出来，逐个要求字典里有一节。
//
// 排除项只有两个，且都有理由：
//   · cloudfunctions/sync —— 旧同步函数，未部署、零引用（cloud:ls 会列出来）
//   · 系统字段集合（以 _ 开头的临时名）
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const entities = require(path.join(ROOT, 'utils', 'db', 'entities'));

// 从云函数里找出所有被真正访问的集合名
function cloudColls() {
  const out = new Set();
  const dir = path.join(ROOT, 'cloudfunctions');
  fs.readdirSync(dir).forEach(fn => {
    if (fn === 'sync') return;                       // 旧函数，未部署
    const p = path.join(dir, fn, 'index.js');
    if (!fs.existsSync(p)) return;
    const src = fs.readFileSync(p, 'utf8');
    // ① 字面量：db.collection('students')
    const lit = /\.collection\('([a-z][a-z0-9_]*)'\)/g;
    let m;
    while ((m = lit.exec(src))) out.add(m[1]);
    // ② 常量：const CARDS = 'invite_cards' + db.collection(CARDS)
    const consts = {};
    const cre = /^const ([A-Z][A-Z0-9_]*) = '([a-z][a-z0-9_]*)';/gm;
    while ((m = cre.exec(src))) consts[m[1]] = m[2];
    const use = /\.collection\(([A-Z][A-Z0-9_]*)\)/g;
    while ((m = use.exec(src))) if (consts[m[1]]) out.add(consts[m[1]]);
  });
  return Array.from(out).sort();
}

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + (e && e.message)); fail++; }
}

console.log('\n【数据字典完整性】');
const doc = read('docs/data-dictionary.md');
const has = n => new RegExp('\\| `' + n + '` \\|').test(doc) || new RegExp('#### `' + n + '`').test(doc);

ok('本机库的 13 张表全部在字典里', () => {
  const missing = entities.ALL_COLLS.filter(c => !has(c));
  assert.deepStrictEqual(missing, [], '字典缺表：' + missing.join('、'));
});

ok('云函数真正用到的集合全部在字典里（新增集合必须补登记）', () => {
  const missing = cloudColls().filter(c => !has(c));
  assert.deepStrictEqual(missing, [], '这些集合在云端被用到、字典里却没有：' + missing.join('、'));
});

ok('字典标注了总数，且与本机库对得上', () => {
  assert.ok(/共 \*\*23\*\* 张集合/.test(doc), '总数变了就同步改断言（本机 13 + 云端 10）');
});

ok('废弃的 sync/profiles 已明确标注，不会被当成"漏掉的表"', () => {
  assert.ok(/历史遗留，不算数据表/.test(doc), '要写明 profiles 的来源，否则下一个人会去找这张表');
});

ok('每张表都写了字段表（空表头是生成器坏了）', () => {
  const heads = (doc.match(/\| 字段 \| 类型 \| 说明 \|/g) || []).length;
  assert.ok(heads >= 23, '字段表数量 ' + heads + ' 少于 23，说明有表没展开');
});

console.log('\nverify_schema_doc: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
