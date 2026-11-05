// utils/db/subject-seeds.js —— 学科种子常量与「课程名 → 学科」猜测
//
// 单独成文件的两个原因：
//   1. schema.js 已经接近 500 行的模块上限（超了就该拆），而这两块是纯数据/纯函数，
//      拆出去不改变任何调用方（schema 仍然把常量与方法原样导出）。
//   2. 它们是"跨机构共享的内容资产"，与 schema 的字段规范化职责不同：
//      gid 一旦发出去就永不改，改动它等于让所有历史题目的引用失效（见不可逆决策 #1）。
//
// 不 require 任何模块：这样它可以被 schema（第 0 层）直接依赖，不会引入环。

// 学科类别：academic 学科类 / art 艺术类 / skill 技能类（决定阶段二的题型集合）
const SUBJECT_KINDS = ['academic', 'art', 'skill'];

// 知识点来源：platform 平台公共 / org 机构私有
const KP_SOURCES = ['platform', 'org'];

// 内置 7 条学科：gid 固定且跨机构一致（阶段二公共题库按 gid 引用，一旦发出去就不能改）。
// 机构可以改名（"数学"改成"思维数学"），但 gid 不动。
const SUBJECT_SEEDS = [
  { gid: 'sub_chinese', name: '语文', kind: 'academic', sort: 1 },
  { gid: 'sub_math', name: '数学', kind: 'academic', sort: 2 },
  { gid: 'sub_english', name: '英语', kind: 'academic', sort: 3 },
  { gid: 'sub_science', name: '科学', kind: 'academic', sort: 4 },
  { gid: 'sub_calligraphy', name: '书法', kind: 'art', sort: 5 },
  { gid: 'sub_art', name: '美术', kind: 'art', sort: 6 },
  { gid: 'sub_coding', name: '编程', kind: 'skill', sort: 7 }
];

// 课程名 → 学科的一次性猜测（只用于建课/升级时补默认值，猜不中留 0，绝不阻塞任何人）。
// 顺序有意义：先匹配到的先赢，所以把更有辨识度的词排前面（"素描"归美术，不会被"思维"抢走）。
const SUBJECT_KEYWORDS = [
  ['sub_calligraphy', ['书法', '楷书', '行书', '隶书', '硬笔', '软笔', '写字', '练字']],
  ['sub_art', ['美术', '素描', '绘画', '国画', '油画', '水彩', '水粉', '手工', '创意画', '儿童画']],
  ['sub_math', ['数学', '奥数', '口算', '算术', '数感', '思维']],
  ['sub_english', ['英语', '英文', '口语', '自然拼读', '新概念', '剑桥']],
  ['sub_chinese', ['语文', '作文', '阅读', '拼音', '识字', '国学', '古文']],
  ['sub_science', ['科学', '物理', '化学', '生物', '实验', '自然']],
  ['sub_coding', ['编程', '机器人', 'scratch', 'python', '信息学', '乐高', '代码']]
];

// 课程名 → 学科 id。subjects 传当前机构的学科列表（要有 id 与 gid）。
// 猜不中返回 0 —— 调用方保留"未指定"语义，不做强制归类。
function guessSubjectId(name, subjects) {
  const list = Array.isArray(subjects) ? subjects : [];
  const s = String(name === null || name === undefined ? '' : name).trim().toLowerCase();
  if (!s) return 0;
  for (let i = 0; i < SUBJECT_KEYWORDS.length; i++) {
    const words = SUBJECT_KEYWORDS[i][1];
    if (words.some(w => s.indexOf(w) > -1)) {
      const hit = list.find(x => x && x.gid === SUBJECT_KEYWORDS[i][0]);
      return hit ? hit.id : 0;
    }
  }
  return 0;
}

module.exports = { SUBJECT_KINDS, KP_SOURCES, SUBJECT_SEEDS, SUBJECT_KEYWORDS, guessSubjectId };
