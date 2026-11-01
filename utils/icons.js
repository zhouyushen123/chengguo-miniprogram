// utils/icons.js —— 抽象线性图标（SVG data URI），多页面复用
function svg(stroke, body) {
  const s = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='"
    + stroke + "' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>" + body + "</svg>";
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
}

const icons = {
  // 相机（拍摄）
  camera: svg('#4a4a4a', "<rect x='3' y='7' width='18' height='13' rx='3'/><circle cx='12' cy='13.5' r='3.5'/><path d='M9 7l1.4-2.3a1 1 0 0 1 .9-.5h1.4a1 1 0 0 1 .9.5L15 7'/>"),
  // 图片（相册）
  album: svg('#4a4a4a', "<rect x='3' y='4' width='18' height='16' rx='3'/><circle cx='8.5' cy='9.5' r='1.6'/><path d='M3.5 16.5l4.5-4.5 4 4 3-3 5.5 5.5'/>"),
  // 搜索
  search: svg('#9c948a', "<circle cx='11' cy='11' r='6'/><path d='M15.5 15.5L20 20'/>"),
  // 耳机（语音）
  audio: svg('#9c948a', "<path d='M4 14a8 8 0 0 1 16 0'/><rect x='3' y='13.5' width='4' height='6.5' rx='2'/><rect x='17' y='13.5' width='4' height='6.5' rx='2'/>")
};
// 麦克风（支持变色：默认橙，录音时白）
icons.mic = function (color) {
  return svg(color, "<rect x='9' y='3' width='6' height='11' rx='3'/><path d='M5 11a7 7 0 0 0 14 0'/><path d='M12 18v3'/>");
};
// 播放 / 暂停（语音条用，支持变色）
icons.play = function (color) {
  return svg(color, "<path d='M8 5.5v13l10.5-6.5z'/>");
};
icons.pause = function (color) {
  return svg(color, "<path d='M8.5 5.5v13'/><path d='M15.5 5.5v13'/>");
};

module.exports = icons;
