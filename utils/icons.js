// utils/icons.js —— 全站统一线性图标库（映射到 assets/icons/ 预渲染 PNG）
// ------------------------------------------------------------------
// 为什么是 PNG：小程序 image 组件对 SVG data URI 支持不稳定（真机常显示空白），
// 预渲染 PNG 全端可靠。图标由 tools/gen_icons.py 统一生成：
//   · 24×24 网格，图形约束在 3~21 光学框内 → 视觉大小统一
//   · 线宽统一 1.75、圆头圆角、不填充 → 笔画粗细一致
//   · 72px 输出适配 3x 屏
// 三主题：warm → assets/icons/；blue → assets/icons/blue/；min → assets/icons/min/（同名文件、同色系键名）。
// setTheme() 决定后续取图路径；页面在 onShow 里经 theme.apply() 重新取一次标准键。
// 新增图标：在 gen_icons.py 里加绘制函数与配色组合，重跑脚本，再在此登记。
let theme = 'warm'; // 'warm' | 'blue' | 'min'，由 theme.js 在启动与切换时同步
const SRC = { warm: '/assets/icons/', blue: '/assets/icons/blue/', min: '/assets/icons/min/' };
const BRAND = { warm: '#E8590C', blue: '#59A8FF', min: '#1F2329' };
const setTheme = t => { theme = SRC[t] ? t : 'warm'; };
const dirOf = () => SRC[theme];
// 品牌色十六进制（JS 里需要色值参数时用，如播放按钮图标）
const brand = () => BRAND[theme];

const I = (name, color) => dirOf() + name + '-' + color + '.png';

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
  plus: c => I('plus', c === '#FFFFFF' ? 'white' : 'orange'),
  send: I('send', 'white'),
  chevron: I('chevron', 'gray'),
  chevronDown: I('chevron-down', 'gray'),
  // —— 业务 ——
  user: I('user', 'gray'),
  userWhite: I('user', 'white'),
  users: I('users', 'ink'),
  calendar: I('calendar', 'gray'),
  clock: I('clock', 'gray'),
  chart: I('chart', 'ink'),
  home: I('home', 'gray'),
  doc: I('doc', 'gray'),
  filter: I('filter', 'gray'),
  tpl: I('tpl', 'ink')
};

// 标准键集合：键名与各页面 data 里的 ico* 一一对应，
// theme.apply() 在每次 onShow 时整包刷新，保证换肤后已加载页面的图标立即换色。
function std() {
  return {
    icoAlbum: icons.album,
    icoAudio: icons.audio,
    icoCam: icons.camera,
    icoCamera: icons.camera,
    icoChev: icons.chevron,
    icoChevD: icons.chevronDown,
    icoClose: icons.close,
    icoEdit: icons.edit,
    icoSearch: icons.search,
    icoMic: icons.mic(brand()),
    icoOrange: icons.mic(brand()),
    icoWhite: icons.mic('#FFFFFF'),
    icoPlay: icons.play(brand()),
    icoPause: icons.pause(brand()),
    icoPlus: icons.plus(brand())
  };
}

// 挂在同一个导出对象上：既有用法（icons.search / icons.mic('#E8590C')）不受影响
icons.setTheme = setTheme;
icons.brand = brand;
icons.std = std;

module.exports = icons;
