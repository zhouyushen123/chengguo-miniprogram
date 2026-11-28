// utils/firstrun.js —— 首次进入的一次性标记
//
// 为什么单独一个文件：页面不许直接碰本地存储（架构守卫会红），
// 而"自动跳过一次开通向导之后别再跳"这种一次性标记又不属于任何数据实体，
// 塞进 db 会让数据层多一个跟业务无关的字段。所以放在工具层，跟 utils/apply.js 同一套路。
const KEY = 'chengguo_firstrun_v1';

// 读过就代表已经自动跳过；存储读失败时当作"已经跳过"（宁可少跳一次，也不要每次启动都弹）
function autoShown() {
  try { return !!wx.getStorageSync(KEY); } catch (e) { return true; }
}

function markAutoShown() {
  try { wx.setStorageSync(KEY, 1); } catch (e) { /* 记不住就算了，最多下次再自动跳一次 */ }
}

// 一次性轻提示：同一个 key 只在第一次返回 true（之后自动标记，不再打扰）。
// 给「功能发现性」类提示用 —— 冯老师访谈（2026-11-28）的核心结论是好功能都在、
// 但用户不知道；这类提示必须轻（toast/提示条），且绝不能每次都弹。
// 存储读写失败时返回 false：宁可少提示一次，也不要每次启动都弹。
const HINTS_KEY = 'chengguo_hints_v1';
function hintOnce(key) {
  if (!key) return false;
  try {
    const o = wx.getStorageSync(HINTS_KEY) || {};
    if (o[key]) return false;
    o[key] = 1;
    wx.setStorageSync(HINTS_KEY, o);
    return true;
  } catch (e) { return false; }
}

module.exports = { KEY, autoShown, markAutoShown, HINTS_KEY, hintOnce };
