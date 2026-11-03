// utils/apply.js —— 机构入驻申请单（本地留档）
//
// 现状：项目还没有后端（云开发在 P2 计划里），申请单先存在本地，一个机构一张单。
// 机构名称会同时写进机构表（org），但机构类型 / 地区 / 联系人 / 规模 / 课程方向
// 这些"资料字段"只存在这张单里 —— 它们不参与权限判定，不需要进 schema。
// 接入云开发后，save() 改成提交到服务端即可，页面无需改动。

const KEY = 'chengguo_apply_v1';

function pad(n) { return n < 10 ? '0' + n : '' + n; }

// 申请单号：CG + 年月日 + 4 位序号（同日多张单也不撞）
function makeNo() {
  const d = new Date();
  const day = '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  const rnd = Math.floor(Math.random() * 9000) + 1000;
  return 'CG' + day + rnd;
}

function get() {
  try {
    const v = wx.getStorageSync(KEY);
    return v && typeof v === 'object' ? v : null;
  } catch (e) { return null; }
}

// 覆盖保存（一个机构一张单）；首次提交分配单号，后续编辑沿用原单号
function save(data) {
  const prev = get();
  const item = Object.assign({}, data, {
    no: (prev && prev.no) || makeNo(),
    at: (prev && prev.at) || Date.now(),
    updatedAt: Date.now()
  });
  try { wx.setStorageSync(KEY, item); } catch (e) { /* 存储失败不阻断页面流程 */ }
  return item;
}

function clear() {
  try { wx.removeStorageSync(KEY); } catch (e) { /* ignore */ }
}

module.exports = { KEY, get, save, clear };
