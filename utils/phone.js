// utils/phone.js —— 手机号录入：格式化与校验的唯一口径
//
// 为什么单独一个文件：全项目有四个录入手机号的地方（开通向导、入驻申请、人员管理、
// 学生档案），格式化和校验各写一套迟早腐烂。展示统一 3-4-4（186-7488-2783），
// 存储永远存 11 位裸数字——显示是渲染的事，落库是数据的事，两件事不能搅在一起。
//
// 输入处理套路（各页面共用，2026-11-05 修订）：
//   输入中 value 只绑裸数字（digits），失焦（bindblur）才 fmt() 成 3-4-4。
//   以前是边输边 fmt —— 但 input 是 type="number"，数字键盘容不下 "-"，
//   真机上组件遇到非法字符会重排/吞字符，用户看到的就是"输入自动调乱"（模拟器看不出来）。
//   maxlength 因此设 11（裸数字），不再是 13。提交时 digits() 拿裸数字校验和落库。
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
