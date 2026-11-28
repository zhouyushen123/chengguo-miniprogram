// utils/draft.js —— 录入草稿保护（批量页 / 单条录入页共用一份基建）
//
// 为什么单独一个文件：页面不许直接碰本地存储（架构守卫会红），
// 而"录到一半退出/来电话"的半成品又不属于任何数据实体，塞进 db 会污染业务模型。
// 草稿按班级分开存，保存成功后由页面显式 clear。
// kind：同一班级批量页和单条录入页的草稿结构完全不同，必须分桶，
// 否则一边的"恢复弹窗"会读到另一边的行结构把页面卡住。批量页沿用默认 'batch'。
const KEY = (id, kind) => {
  const n = Number(id);
  const k = kind === 'rec' ? 'rec' : 'batch';
  return 'chengguo_draft_v1_' + k + '_' + (isFinite(n) ? n : 0);
};

function get(clsId, kind) {
  try { return wx.getStorageSync(KEY(clsId, kind)) || null; } catch (e) { return null; }
}
function set(clsId, data, kind) {
  try { wx.setStorageSync(KEY(clsId, kind), data); } catch (e) { /* 存不下就算了，草稿丢了不致命 */ }
}
function clear(clsId, kind) {
  try { wx.removeStorageSync(KEY(clsId, kind)); } catch (e) { /* 同上 */ }
}

module.exports = { get, set, clear };
