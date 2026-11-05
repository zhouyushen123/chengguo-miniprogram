// tools/schema-doc.js —— 从实体注册表生成数据字典（npm run docs:schema）
//
// 【为什么必须自动生成】上一版数据字典是手写的，两天后就跟代码对不上了（字段名改了、
// 表加了两张、口径换了，文档还是旧的），然后没人再信它。这里把"文档"变成代码的投影：
//   - 字段来源：utils/db/entities.js（注册表）
//   - 枚举与校验来源：utils/db/schema.js
//   - tests/verify_datamodel.js 再断言注册表字段 == normalize() 实际输出，
//     所以"改了字段没登记"会在 CI 红，而不是等人某天发现文档过期。
//
// 用法：
//   node tools/schema-doc.js          重新生成 docs/data-dictionary.md
//   node tools/schema-doc.js --check  只比对，不一致退出 1（挂进 npm run check / CI）
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'data-dictionary.md');
const entities = require(path.join(ROOT, 'utils', 'db', 'entities'));
const schema = require(path.join(ROOT, 'utils', 'db', 'schema'));

const idLabel = e => (e.idType === 'str' ? 'string' : (e.idGen === 'stamp' ? 'int（登记时刻）' : 'int 自增'));

function render() {
  const L = [];
  L.push('# 数据字典（自动生成，请勿手改）');
  L.push('');
  L.push('> 由 `npm run docs:schema` 从 `utils/db/entities.js` + `utils/db/schema.js` 生成。');
  L.push('> 门禁：`npm run check` 会跑 `node tools/schema-doc.js --check`，代码与本文不一致即失败。');
  L.push('> 改字段的正确顺序：改 `schema.js` 的 normalize/validate → 改 `entities.js` 登记 → 重新生成本文。');
  L.push('');
  L.push('共 **' + entities.ENTITIES.length + '** 张表；参与同步的 **' + entities.SYNC_COLLS.length + '** 张。');
  L.push('');
  L.push('## 1. 总览');
  L.push('');
  L.push('| 集合 | 名称 | 域 | id | 同步 | 写入方 | 保留期 |');
  L.push('|---|---|---|---|---|---|---|');
  entities.ENTITIES.forEach(e => {
    L.push('| `' + e.coll + '` | ' + e.label + ' | ' + e.domain + ' | ' + idLabel(e) +
      ' | ' + (e.sync ? '✅' : '—') + ' | ' + e.writer + ' | ' + e.retention + ' |');
  });
  L.push('');

  L.push('## 2. 表结构');
  entities.ENTITIES.forEach(e => {
    L.push('');
    L.push('### `' + e.coll + '` ' + e.label);
    L.push('');
    L.push('- 域：' + e.domain + '　id：' + idLabel(e) + '　同步：' + (e.sync ? '是' : '否（仅本机）'));
    L.push('- 写入方：' + e.writer);
    L.push('- 保留期：' + e.retention);
    L.push('- 索引：' + (e.indexes || []).map(x => '`' + x[0] + '`（' + x[1] + '）').join('；'));
    L.push('');
    L.push('| 字段 | 类型 | 说明 |');
    L.push('|---|---|---|');
    e.fields.forEach(f => { L.push('| `' + f.k + '` | ' + f.t + ' | ' + f.d + ' |'); });
  });

  L.push('');
  L.push('## 3. 枚举与常量');
  L.push('');
  L.push('| 名称 | 取值 | 出处 |');
  L.push('|---|---|---|');
  const enums = [
    ['评分五档 TAGS', schema.TAGS],
    ['记录类型 RECORD_TYPES', schema.RECORD_TYPES],
    ['角色 ROLES', schema.ROLES],
    ['成员状态 MEMBER_STATUS', schema.MEMBER_STATUS],
    ['机构状态 ORG_STATUS', schema.ORG_STATUS],
    ['学期状态 TERM_STATUS', schema.TERM_STATUS],
    ['班级模式 CLASS_MODES', schema.CLASS_MODES],
    ['报名状态 ENROLL_STATUS', schema.ENROLL_STATUS],
    ['学科类别 SUBJECT_KINDS', schema.SUBJECT_KINDS],
    ['知识点来源 KP_SOURCES', schema.KP_SOURCES],
    ['媒体上限 LIMITS', ['photos=' + schema.LIMITS.photos, 'videos=' + schema.LIMITS.videos]]
  ];
  enums.forEach(x => {
    L.push('| ' + x[0] + ' | ' + x[1].map(v => '`' + v + '`').join(' / ') + ' | `utils/db/schema.js` |');
  });
  L.push('');
  L.push('## 4. 内置学科（gid 永不变）');
  L.push('');
  L.push('| gid | 名称 | 类别 | 排序 |');
  L.push('|---|---|---|---|');
  schema.SUBJECT_SEEDS.forEach(s => {
    L.push('| `' + s.gid + '` | ' + s.name + ' | ' + s.kind + ' | ' + s.sort + ' |');
  });
  L.push('');
  L.push('> `gid` 是不可逆决策：阶段二题目按它永久引用，机构可改学科名，但 gid 绝不改、不复用。');
  L.push('');
  return L.join('\n');
}

const text = render();
if (process.argv.indexOf('--check') > -1) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
  if (cur !== text) {
    console.error('✘ 数据字典与代码不一致：docs/data-dictionary.md');
    console.error('  请运行 npm run docs:schema 重新生成后再提交（不要手改这份文件）。');
    process.exit(1);
  }
  console.log('✔ 数据字典与代码一致（' + entities.ENTITIES.length + ' 张表）');
} else {
  fs.writeFileSync(OUT, text, 'utf8');
  console.log('✔ 已生成 docs/data-dictionary.md（' + entities.ENTITIES.length + ' 张表）');
}
