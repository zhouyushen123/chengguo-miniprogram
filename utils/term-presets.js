// utils/term-presets.js —— 中小学历学期预设（开通向导与学期管理页共用一份）
//
// 为什么独立成文件：向导第 2 步和「管理 · 学期」的新建弹层都要按中小学历给默认起止日期，
// 两处各写一份必然漂移（一处改了寒假边界另一处忘改），所以抽成纯函数共用。
//
// 历法口径（四段首尾相接，覆盖全年）：
//   秋季学期  9/1  ~ 次年 1/20
//   寒假班    1/21 ~ 2/19
//   春季学期  2/20 ~ 6/30
//   暑假班    7/1  ~ 8/31
// 秋季跨自然年，名称统一用开学那年的年份（「2026 秋季学期」2027 年 1 月才结束），
// 避免出现"2027 秋季"到底指哪一期的歧义。
//
// 长期班（ongoing）：老师长期带几个学生的场景。结束日期留空 = 一直进行中，
// 向导里选它直接复用内置「长期班」学期（见 pages/setup/setup.js commitTerm）。

const pad = n => (n < 10 ? '0' + n : '' + n);
const dateStr = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

const KINDS = [
  { k: 'autumn', t: '秋季学期' },
  { k: 'winter', t: '寒假班' },
  { k: 'spring', t: '春季学期' },
  { k: 'summer', t: '暑假班' },
  { k: 'ongoing', t: '长期班' }
];

// 某个时间点的四段预设。Y = 学年（从 9 月起算）：2026-11 → 学年 2026，
// 2027-03 → 学年 2026（春季/暑假属于 2026 学年的下一段，名称用 2027）。
function presets(now) {
  const m = now.getMonth() + 1;
  const y = now.getFullYear();
  const Y = m >= 9 ? y : y - 1;
  const mk = (yy, mm, dd) => yy + '-' + pad(mm) + '-' + pad(dd);
  return {
    autumn: { name: Y + ' 秋季学期', start: mk(Y, 9, 1), end: mk(Y + 1, 1, 20) },
    winter: { name: (Y + 1) + ' 寒假班', start: mk(Y + 1, 1, 21), end: mk(Y + 1, 2, 19) },
    spring: { name: (Y + 1) + ' 春季学期', start: mk(Y + 1, 2, 20), end: mk(Y + 1, 6, 30) },
    summer: { name: (Y + 1) + ' 暑假班', start: mk(Y + 1, 7, 1), end: mk(Y + 1, 8, 31) }
  };
}

// 今天落在哪一段（1/1~1/20 仍是秋季的尾巴，2/20 起算春季……）
function currentKind(now) {
  const m = now.getMonth() + 1;
  const d = now.getDate();
  if (m >= 9 || (m === 1 && d <= 20)) return 'autumn';
  if (m === 1 || (m === 2 && d <= 19)) return 'winter';
  if (m <= 6) return 'spring';
  return 'summer';
}

// 取某一段的表单值。学期中途才建班的（比如 11 月建秋季班），
// 开始日期从今天算起而不是 9/1；到期当天及以后仍用整段，避免出现起止同日。
function pick(k, now) {
  const today = dateStr(now);
  if (k === 'ongoing') return { name: '长期班', startDate: today, endDate: '' };
  const p = presets(now)[k];
  if (!p) return null;
  const startDate = (today >= p.start && today < p.end) ? today : p.start;
  return { name: p.name, startDate, endDate: p.end };
}

// 智能默认：当前时段 + 对应表单值
function smart(now) {
  const k = currentKind(now);
  return Object.assign({ k }, pick(k, now));
}

module.exports = { KINDS, dateStr, currentKind, pick, smart };
