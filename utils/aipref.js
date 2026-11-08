// utils/aipref.js —— AI 评价的偏好（老师上次勾的「重点看什么」）
//
// 【为什么单独一层】页面里不许直接读写 Storage（见 tools/lint.js 第 5 条），
// 换肤、首启状态都是先例。放在这里还有第二个好处：将来给偏好加版本迁移
// （比如视角从 5 个扩到 8 个、旧值要过滤），只改这一处，不用满页面找。
const KEY = 'ai_views_v1';

// 读回来一律是数组：本地存过脏值（手改、旧版本写了别的结构）不能让录入页崩掉
function views() {
  try {
    const v = wx.getStorageSync(KEY);
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  } catch (e) { return []; }
}

// 存不进去也不能挡住生成：偏好只是省事，不是功能前提
function save(list) {
  try { wx.setStorageSync(KEY, Array.isArray(list) ? list : []); } catch (e) { /* 忽略 */ }
}

module.exports = { views, save };
