// utils/icons.js —— 全站统一线性图标库（映射到 assets/icons/ 预渲染 PNG）
// ------------------------------------------------------------------
// 为什么是 PNG：小程序 image 组件对 SVG data URI 支持不稳定（真机常显示空白），
// 预渲染 PNG 全端可靠。图标由 .workbuddy/gen_icons.py 统一生成：
//   · 24×24 网格，图形约束在 3~21 光学框内 → 视觉大小统一
//   · 线宽统一 1.75、圆头圆角、不填充 → 笔画粗细一致
//   · 72px 输出适配 3x 屏
// 新增图标：在 gen_icons.py 里加绘制函数与配色组合，重跑脚本，再在此登记。
const I = (name, color) => '/assets/icons/' + name + '-' + color + '.png';

const icons = {
  // —— 媒体 ——
  camera: I('camera', 'ink'),
  album: I('album', 'ink'),
  audio: I('audio', 'gray'),
  mic: c => I('mic', c === '#FFFFFF' ? 'white' : 'orange'),
  play: c => I('play', c === '#FFFFFF' ? 'white' : 'orange'),
  pause: c => I('pause', c === '#FFFFFF' ? 'white' : 'orange'),
  // —— 操作 ——
  search: I('search', 'gray'),
  edit: I('edit', 'ink'),
  trash: I('trash', 'red'),
  close: I('close', 'gray'),
  check: I('check', 'white'),
  plus: I('plus', 'orange'),
  send: I('send', 'white'),
  chevron: I('chevron', 'gray'),
  chevronDown: I('chevron-down', 'gray'),
  // —— 业务 ——
  user: I('user', 'gray'),
  users: I('users', 'ink'),
  calendar: I('calendar', 'gray'),
  clock: I('clock', 'gray'),
  chart: I('chart', 'ink'),
  home: I('home', 'gray'),
  doc: I('doc', 'gray'),
  filter: I('filter', 'gray'),
  tpl: I('tpl', 'ink')
};

module.exports = icons;
