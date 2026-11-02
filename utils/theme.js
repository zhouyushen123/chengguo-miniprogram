// utils/theme.js —— 全局换肤控制器（暖橙 warm / 清透蓝 blue）
// ------------------------------------------------------------------
// 职责：持久化主题选择；在每次页面 onShow 时应用（CSS 变量类名 + 图标整包刷新）；
// 切换时同步原生 chrome（导航栏 / 底部 tabBar / 窗口背景），保证换肤彻底、同色系一致。
// 页面接入方式（三行，不改业务逻辑）：
//   1. wxml 最外层包 <view class="theme-root {{themeCls}}">…</view>
//   2. onShow 首行调用 theme.apply(this)
//   3. wxss 里颜色一律用 var(--token)（见 app.wxss 的 page{} 与 .theme-blue{}）
const icons = require('./icons');

const KEY = 'chengguo_theme';
const LIST = [
  { k: 'warm', name: '暖橙', desc: '橙果经典', dot: '#E8590C', dot2: '#F7A23B' },
  { k: 'blue', name: '清透蓝', desc: '轻盈学习风', dot: '#59A8FF', dot2: '#A2DCFD' }
];

// 各主题的原生 chrome 取值（导航栏 / tabBar / 窗口背景）
const CHROME = {
  warm: {
    navBg: '#FFFFFF', winBg: '#FAF9F7', line: '#F0EEEA',
    tab: { color: '#9C948A', selectedColor: '#E8590C', backgroundColor: '#FFFFFF', borderStyle: 'white' },
    tabDir: '/assets/tabbar/warm/'
  },
  blue: {
    navBg: '#EAF4FF', winBg: '#F3F8FE', line: '#E4EEF8',
    tab: { color: '#8FA3BC', selectedColor: '#59A8FF', backgroundColor: '#FDFEFF', borderStyle: 'white' },
    tabDir: '/assets/tabbar/blue/'
  }
};
const TAB_ITEMS = ['home', 'records', 'mine'];

function safe(fn) { try { fn(); } catch (e) { /* 测试环境/低版本基础库无这些 API，静默跳过 */ } }

function current() {
  try { return wx.getStorageSync(KEY) === 'blue' ? 'blue' : 'warm'; } catch (e) { return 'warm'; }
}
function cls() { return current() === 'blue' ? 'theme-blue' : ''; }

// 同步原生部分的配色（导航栏 / tabBar / 窗口底色）。
// 部分接口仅能在对应场景调用（如 setTabBarItem 需在 tab 页），失败静默，下次 onShow 再补。
function applyChrome() {
  const c = CHROME[current()];
  safe(() => wx.setNavigationBarColor({ frontColor: '#000000', backgroundColor: c.navBg, fail: () => {} }));
  safe(() => wx.setBackgroundColor({ backgroundColor: c.winBg, fail: () => {} }));
  safe(() => wx.setTabBarStyle(Object.assign({}, c.tab, { fail: () => {} })));
  TAB_ITEMS.forEach((name, index) => {
    safe(() => wx.setTabBarItem({
      index,
      iconPath: c.tabDir + name + '.png',
      selectedIconPath: c.tabDir + name + '-on.png',
      fail: () => {}
    }));
  });
}

// 页面 onShow 统一入口：根类名（CSS 变量切主题）+ 图标整包刷新 + 原生 chrome
// cBrand / cLine：给无法使用 CSS 变量的原生组件属性用（如 slider 的 activeColor）
function apply(page) {
  const t = current();
  icons.setTheme(t);
  const c = CHROME[t];
  page.setData(Object.assign(
    { themeCls: cls(), cBrand: t === 'blue' ? '#59A8FF' : '#E8590C', cLine: c.line },
    icons.std()
  ));
  applyChrome();
}

// 用户切换主题：落盘 → 同步 icons 模块 → 立即刷新原生 chrome（调用方页面随后自己 apply）
function setTheme(k) {
  const t = k === 'blue' ? 'blue' : 'warm';
  try { wx.setStorageSync(KEY, t); } catch (e) { /* 存不上就仅本次会话生效 */ }
  icons.setTheme(t);
  applyChrome();
  return t;
}

// app.js onLaunch 调用：先同步 icons 模块的主题态，页面数据初始化与首屏渲染即用新皮肤
function init() {
  icons.setTheme(current());
  applyChrome();
}

module.exports = { LIST, current, cls, apply, setTheme, init, CHROME };
