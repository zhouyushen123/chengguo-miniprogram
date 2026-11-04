// utils/api.js —— 线上层（微信云开发版）
// 依赖：project.config.json cloudfunctionRoot 已配置；云函数在 cloudfunctions/ 下
// 云数据库集合：records（课后记录）、profiles（学生资料）
const CLOUD_ENV = 'cloud1-d9gca4e7q307c4564'; // 云开发环境 ID（微信认证已完成，2026-11-04 开通）
// ★ 云开关：控制 wx.cloud.init 要不要跑。现在开的是「AI 评」这一条（aiEval 云函数）。
// 离线/纯本地调试时用 CG_CLOUD=0 强制关掉（测试若要打开需在 require 本模块之前设值）。
const CLOUD_ENABLED = process.env.CG_CLOUD !== '0';
// ★ 同步链路单独上锁：sync 云函数还是旧 openid 模型（CR-005，与新架构的记录/成员模型不对齐）。
// 重构完再打开，避免把本地记录推到还没对齐的库里、也避免云端半份数据反过来污染本地。
// 开通方式：CG_SYNC=1 或把下面这行改成 true。
const SYNC_ENABLED = process.env.CG_SYNC === '1';

let cloudReady = false;
function initCloud() {
  if (!CLOUD_ENABLED) { cloudReady = false; return; }
  if (cloudReady || !wx.cloud) return;
  try { wx.cloud.init({ env: CLOUD_ENV, traceUser: true }); cloudReady = true; } catch (e) { cloudReady = false; }
}
const enabled = () => cloudReady;
// 同步链路（push/pull/uploadFile）是否打开：云通了还不够，sync 云函数得先对齐模型
const syncOn = () => cloudReady && SYNC_ENABLED;

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
  if (!syncOn()) return Promise.resolve();
  return callSync('push', { doc: record }).catch(() => null);
}
// 拉取云端最新数据（记录 + 学生资料），返回 { records, profiles } 供合并
function pull() {
  if (!syncOn()) return Promise.resolve(null);
  return callSync('pull').then(r => ({ records: r.db.records, profiles: r.profiles })).catch(() => null);
}
// 媒体上传 → 云存储，返回 cloud:// fileID（可直接用作 image src / audio src）
function uploadFile(filePath, kind) {
  if (!syncOn()) return Promise.resolve(null);
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
// AI 识图生成评价草稿：调 aiEval 云函数（智谱 GLM-4V-Flash）。
// 入参二选一：{ fileID } 云存储图片；{ imageBase64, hint } 压缩图兜底。
// 不走 callSync（它把 ok:false 当 reject，这里的业务错误码要用 result 原样带回）
function aiEvalDraft(data) {
  if (!cloudReady) return Promise.reject(new Error('CLOUD_OFF'));
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'aiEval',
      data: data || {},
      success: r => resolve(r.result || { ok: false, msg: '云函数无返回' }),
      fail: e => reject(new Error((e && e.errMsg) || '云函数调用失败'))
    });
  });
}

module.exports = { initCloud, enabled, syncOn, login, pushRecord, pull, uploadFile, aiEvalDraft, CLOUD_ENV };
