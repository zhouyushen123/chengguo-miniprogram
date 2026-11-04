// parse.js —— 名单解析纯函数（不依赖 wx-server-sdk，本地测试可直接 require）
//
// 两种来源统一成一个出口：{ name, gender, parent } 列表
//   ① 表格（xlsx/xls/csv）：按列名/列序确定性解析
//   ② 拍照 / Word 文档：AI 抽出的 JSON 再做清洗校验

// 姓名清洗：去序号（"1. 张三" / "1、张三" / "1 张三"）、空白与标点
function cleanName(s) {
  return String(s || '')
    .replace(/^[\s\d０-９]+[.、．)）]?\s*/, '')   // 行首序号
    .replace(/[\s　]+/g, '')                      // 各类空白
    .replace(/[。．.,，、;；:："'‘’“”!！?？*#]/g, '')
    .trim();
}

// 性别归一：只认 男/女，其余一律空（schema 只接受这两个值）
function normGender(s) {
  const t = String(s || '');
  if (t.indexOf('男') > -1) return '男';
  if (t.indexOf('女') > -1) return '女';
  return '';
}

// 名字是否像人名：2~20 字、不含数字与常见干扰字符
function likeName(s) {
  if (!s || s.length < 2 || s.length > 20) return false;
  if (/[\d０-９a-zA-Z@/\\]{1}/.test(s)) return false;
  return true;
}

// 表格行 → 学生列表。rows: 二维数组（sheet_to_json header:1 的输出）
// 有表头（任一单元格含 姓名/名字/学生）按列名取列；没有表头默认第一列是姓名。
function tableFromRows(rows) {
  const grid = (rows || []).filter(r => Array.isArray(r) && r.some(c => String(c || '').trim() !== ''));
  if (!grid.length) return [];
  let nameCol = 0, genderCol = -1, parentCol = -1, start = 0;
  for (let i = 0; i < Math.min(3, grid.length); i++) {
    const head = grid[i].map(c => String(c || ''));
    if (head.some(c => c.indexOf('姓名') > -1 || c.indexOf('名字') > -1 || c === '学生')) {
      head.forEach((c, j) => {
        if (c.indexOf('姓名') > -1 || c.indexOf('名字') > -1 || c === '学生') nameCol = j;
        else if (c.indexOf('性别') > -1) genderCol = j;
        else if (c.indexOf('家长') > -1 || c.indexOf('监护人') > -1 || c.indexOf('联系') > -1) parentCol = j;
      });
      start = i + 1;
      break;
    }
  }
  const out = [], seen = {};
  for (let i = start; i < grid.length; i++) {
    const name = cleanName(grid[i][nameCol]);
    if (!likeName(name) || seen[name]) continue;
    seen[name] = 1;
    out.push({
      name,
      gender: normGender(genderCol > -1 ? grid[i][genderCol] : ''),
      parent: parentCol > -1 ? cleanName(grid[i][parentCol]) : ''
    });
  }
  return out;
}

// csv/txt 文本 → 行数组（分隔符兼容英文逗号 / 中文逗号 / Tab）
function parseCsvText(text) {
  return String(text || '').split(/\r?\n/).map(line => line.split(/[,，\t]/));
}

// docx 的 document.xml → 纯文本行（段落断行，其余标签剔除）
function stripDocxXml(xml) {
  return String(xml || '')
    .replace(/<w:p[\s>][\s\S]*?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// AI 抽出的 JSON → 合法学生列表（防御式：AI 输出不可信）
function pickAiStudents(raw) {
  let arr = raw;
  if (typeof raw === 'string') {
    const m = raw.match(/\[[\s\S]*\]/);          // 容忍模型带 markdown 代码块或前后废话
    if (!m) return [];
    try { arr = JSON.parse(m[0]); } catch (e) { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const out = [], seen = {};
  arr.forEach(it => {
    const o = it || {};
    const name = cleanName(typeof o === 'string' ? o : o.name);
    if (!likeName(name) || seen[name]) return;
    seen[name] = 1;
    out.push({ name, gender: normGender(o.gender), parent: cleanName(o.parent || '') });
  });
  return out;
}

// 与班级已有学生合并去重：标记哪些是班内重名（前端预览用）
function markDupes(list, existingNames) {
  const have = {};
  (existingNames || []).forEach(n => { have[n] = 1; });
  return (list || []).map(it => Object.assign({}, it, { dupe: !!have[it.name] }));
}

module.exports = { cleanName, normGender, likeName, tableFromRows, parseCsvText, stripDocxXml, pickAiStudents, markDupes };
