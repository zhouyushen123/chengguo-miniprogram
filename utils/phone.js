// utils/phone.js —— 手机号录入：格式化与校验的唯一口径
//
// 为什么单独一个文件：全项目有四个录入手机号的地方（开通向导、入驻申请、人员管理、
// 学生档案），格式化和校验各写一套迟早腐烂。展示统一 3-4-4（186-7488-2783），
// 存储永远存 11 位裸数字——显示是渲染的事，落库是数据的事，两件事不能搅在一起。
//
// 输入处理套路（各页面共用）：
//   input 的 value 绑定格式化后的字符串，用户输入/粘贴什么都先 digits() 再 fmt()；
//   提交时 digits() 拿裸数字做校验和落库。maxlength 设 13（11 位 + 2 个横线）。
const RE = /^1[3-9]\d{9}$/;

// 只留数字，最多 11 位（防粘贴超长、防误输字母）
function digits(v) { return String(v == null ? '' : v).replace(/\D/g, '').slice(0, 11); }

// 3-4-4 分段：186 / 7488 / 2783。不够长就不补横线，删着删着横线自然消失。
function fmt(v) {
  const d = digits(v);
  if (d.length <= 3) return d;
  if (d.length <= 7) return d.slice(0, 3) + '-' + d.slice(3);
  return d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7);
}

// 合法手机号：11 位、1 开头、第二位 3-9
function valid(v) { return RE.test(digits(v)); }

module.exports = { digits, fmt, valid };
