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

module.exports = { KEY, autoShown, markAutoShown };
