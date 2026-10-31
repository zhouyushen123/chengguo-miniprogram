// utils/api.js —— 线上同步层（微信云开发版）
// 依赖：project.config.json cloudfunctionRoot 已配置；先部署 cloudfunctions/sync 云函数
// 云数据库集合：records（课后记录）、profiles（学生资料）
const CLOUD_ENV = 'chengguo-0gxxx'; // ← 改成你的云环境 ID（开发者工具-云开发控制台可查）

let cloudReady = false;
function initCloud() {
  if (cloudReady || !wx.cloud) return;
  try { wx.cloud.init({ env: CLOUD_ENV, traceUser: true }); cloudReady = true; } catch (e) { cloudReady = false; }
}
const enabled = () => cloudReady;

function callSync(action, data) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'sync',
      data: Object.assign({ action }, data || {}),
      success: r => (r.result && r.result.ok ? resolve(r.result) : reject(r.result)),
      fail: reject
    });
  });
}
function login() { return Promise.resolve(); } // 云开发免登录，openid 由云函数自动获取

// 上推一条记录 / 学生资料（photo/audio 用云存储 fileID）
function pushRecord(record) {
  if (!cloudReady) return Promise.resolve();
  return callSync('push', { doc: record }).catch(() => null);
}
// 拉取云端最新数据（记录 + 学生资料），返回 { records, profiles } 供合并
function pull() {
  if (!cloudReady) return Promise.resolve(null);
  return callSync('pull').then(r => ({ records: r.db.records, profiles: r.profiles })).catch(() => null);
}
// 媒体上传 → 云存储，返回 cloud:// fileID（可直接用作 image src / audio src）
function uploadFile(filePath, kind) {
  if (!cloudReady) return Promise.resolve(null);
  const ext = (filePath.match(/\.\w+$/) || ['jpg'])[0];
  const p = 'chengguo/' + kind + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
  return new Promise(resolve => {
    wx.cloud.uploadFile({
      cloudPath: p, filePath,
      success: r => resolve(r.fileID),
      fail: () => resolve(null)
    });
  });
}
module.exports = { initCloud, enabled, login, pushRecord, pull, uploadFile, CLOUD_ENV };
