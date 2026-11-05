// utils/draft.js —— 成绩单批量录入的草稿保护
//
// 为什么单独一个文件：页面不许直接碰本地存储（架构守卫会红），
// 而"录到一半退出/来电话"的半成品又不属于任何数据实体，塞进 db 会污染业务模型。
// 草稿按班级分开存，保存成功后由页面显式 clear。
const KEY = id => {
  const n = Number(id);
  return 'chengguo_batchdraft_v1_' + (isFinite(n) ? n : 0);
};

function get(clsId) {
  try { return wx.getStorageSync(KEY(clsId)) || null; } catch (e) { return null; }
}
function set(clsId, data) {
  try { wx.setStorageSync(KEY(clsId), data); } catch (e) { /* 存不下就算了，草稿丢了不致命 */ }
}
function clear(clsId) {
  try { wx.removeStorageSync(KEY(clsId)); } catch (e) { /* 同上 */ }
}

module.exports = { get, set, clear };
