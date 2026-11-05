// utils/api.js —— 线上层（微信云开发版）
// 依赖：project.config.json cloudfunctionRoot 已配置；云函数在 cloudfunctions/ 下
// 云数据库集合：records（课后记录）、profiles（学生资料）
const CLOUD_ENV = 'cloud1-d9gca4e7q307c4564'; // 云开发环境 ID（微信认证已完成，2026-11-04 开通）
// ★ 云开关：控制 wx.cloud.init 要不要跑。现在开的是「AI 评」这一条（aiEval 云函数）。
// 离线/纯本地调试时用 CG_CLOUD=0 强制关掉（测试若要打开需在 require 本模块之前设值）。
// 测试环境才有 process.env，小程序运行时没有，必须先判存在再取值
const ENV = (typeof process !== 'undefined' && process.env) || {};
const CLOUD_ENABLED = ENV.CG_CLOUD !== '0';
// ★ 同步链路开关：默认开启，靠 `syncv2` 云函数（orgId 隔离模型，取代旧 openid 模型）。
// 云函数没部署时全部调用失败但静默降级——本地照样能用，只是不上云。CG_SYNC=0 可强制关掉。
const SYNC_ENABLED = ENV.CG_SYNC !== '0';

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
      name: 'syncv2',
      data: Object.assign({ action }, data || {}),
      success: r => resolve(r.result || { ok: false, msg: '云函数无返回' }),
      fail: reject
    });
  });
}
// 同步协议调用（hello / push / pull）：业务错误码原样带回，由 utils/sync.js 决定降级
function syncCall(action, data) {
  if (!syncOn()) return Promise.reject(new Error('SYNC_OFF'));
  return callSync(action, data);
}
function login() { return Promise.resolve(); } // 云开发免登录，openid 由云函数自动获取

/* ---------------- 邀请码（成员绑定） ----------------
 * 加入机构和同步是两件事：没开通同步也要能加入，所以这三个走 callFn，不经过 syncOn 闸门。
 * 云没通时全部返回 ok:false，页面提示"请先联网"，绝不假装成功。
 */
function inviteInfo(code) {
  if (!cloudReady) return Promise.resolve({ ok: false, code: 'CLOUD_OFF', msg: '网络未就绪' });
  return callFn('syncv2', { action: 'inviteInfo', code }).catch(() => ({ ok: false, code: 'NET', msg: '网络不通，请重试' }));
}
function inviteJoin(data) {
  if (!cloudReady) return Promise.resolve({ ok: false, code: 'CLOUD_OFF', msg: '网络未就绪' });
  return callFn('syncv2', Object.assign({ action: 'inviteJoin' }, data)).catch(() => ({ ok: false, code: 'NET', msg: '网络不通，请重试' }));
}
function inviteGet(role) {
  if (!cloudReady) return Promise.resolve({ ok: false, code: 'CLOUD_OFF', msg: '网络未就绪' });
  return callFn('syncv2', { action: 'inviteGet', role }).catch(() => ({ ok: false, code: 'NET', msg: '网络不通，请重试' }));
}

// 上推一条记录：已由 utils/sync.js 的脏集合机制接管，保留空实现兼容旧调用点
function pushRecord() { return Promise.resolve(); }
// 拉取云端数据：由 sync 引擎统一处理，保留接口给旧调用点
function pull() { return Promise.resolve(null); }
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

// 学生批量导入云函数（表格解析 / 纸质名单拍照识别），返回 { ok, students|msg }
// 业务错误码用 result 原样带回，不走 callSync
function stuImport(data) {
  if (!cloudReady) return Promise.reject(new Error('CLOUD_OFF'));
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'stuImport',
      data: data || {},
      success: r => resolve(r.result || { ok: false, msg: '云函数无返回' }),
      fail: e => reject(new Error((e && e.errMsg) || '云函数调用失败'))
    });
  });
}

// 通用云函数调用：业务错误码用 result 原样带回，不走 callSync（它把 ok:false 当 reject）
function callFn(name, data) {
  if (!cloudReady) return Promise.reject(new Error('CLOUD_OFF'));
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name, data: data || {},
      success: r => resolve(r.result || { ok: false, msg: '云函数无返回' }),
      fail: e => reject(new Error((e && e.errMsg) || '云函数调用失败'))
    });
  });
}

// 内容安全：文本（老师/AI 评语等 UGC）。云没通时跳过（fail-open，本地开发不拦人），
// 云函数侧只拦 87014，接口抖动不误伤业务。
function secText(content) {
  if (!cloudReady) return Promise.resolve({ ok: true, skipped: true });
  return callFn('secCheck', { action: 'msg', content }).catch(() => ({ ok: true, warn: true }));
}
// 内容安全：图片（云存储 fileID）
function secImage(fileID) {
  if (!cloudReady) return Promise.resolve({ ok: true, skipped: true });
  return callFn('secCheck', { action: 'img', fileID }).catch(() => ({ ok: true, warn: true }));
}

// ===== 家长订阅消息（备案通过 + 模板申请好之前，全家链路静默降级，零影响） =====
// 家长授权订阅：模板 ID 从 family 云函数取（mp 后台配环境变量 NOTIFY_TEMPLATE_ID）
function requestSubscribe() {
  if (!cloudReady) return Promise.resolve({ ok: false, code: 'CLOUD_OFF' });
  return callFn('family', { action: 'tpl' }).then(r => {
    if (!r.ready || !r.tpl) return { ok: false, code: 'NO_TPL' };
    return new Promise(resolve => {
      wx.requestSubscribeMessage({
        tmplIds: [r.tpl],
        success: res => resolve({ ok: res[r.tpl] === 'accept', res }),
        fail: e => resolve({ ok: false, code: (e && e.errMsg) || 'SUB_FAIL' })
      });
    });
  }).catch(() => ({ ok: false, code: 'CLOUD_OFF' }));
}
// 家长 openid 登记到云端（openid 由云函数上下文自动取，前端只交孩子列表）
function familyBind(data) {
  if (!cloudReady) return Promise.resolve({ ok: false, code: 'CLOUD_OFF' });
  return callFn('family', Object.assign({ action: 'bind' }, data)).catch(() => ({ ok: false }));
}
// 老师发布后触达：未配模板/没通云时静默跳过，绝不阻塞发布主流程
function familyNotify(data) {
  if (!cloudReady) return Promise.resolve({ ok: false, code: 'CLOUD_OFF' });
  return callFn('family', Object.assign({ action: 'send' }, data)).catch(() => ({ ok: false }));
}

// 照片上云：前端直传云存储（不经过云函数）。与记录同步（SYNC_ENABLED）解耦：
// 云通就能传，照片存云端后不怕清缓存/换手机，家长端将来也能直接看。
// 传失败返回 null（调用方保留本地路径，不阻塞保存）。
function uploadPhoto(filePath) {
  if (!cloudReady) return Promise.resolve(null);
  const ext = (String(filePath).match(/\.\w+$/) || ['jpg'])[0];
  const p = 'chengguo/photo/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
  return new Promise(resolve => {
    wx.cloud.uploadFile({
      cloudPath: p, filePath,
      success: r => resolve(r.fileID || null),
      fail: () => resolve(null)
    });
  });
}

// 电脑端后台：取后台账号与口令（服务端按 members 表判角色，只有负责人/管理员能拿）。
// 走 callFn 而不是 syncOn：后台和同步是两条链路，同步没通也不该挡着"看口令"。
function adminAccount() {
  if (!cloudReady) return Promise.resolve({ ok: false, code: 'CLOUD_OFF', msg: '网络未就绪' });
  return callFn('admin', { action: 'mkAccount' }).catch(() => ({ ok: false, code: 'NET', msg: '网络不通，请重试' }));
}

// 云端每日备份（backup 云函数）：
//   info/list 看最近备份（老师以上）；run 立刻备份一个集合（限负责人/管理员）
// 一次只备一个集合：云函数 60 秒超时，整包一次数据多一点就会被掐断，掐断时还不知道停在哪。
// 角色判断在服务端做，这里不重复写规则。
function cloudBackup(action, data) {
  if (!cloudReady) return Promise.resolve({ ok: false, code: 'CLOUD_OFF', msg: '网络未就绪' });
  return callFn('backup', Object.assign({ action }, data || {}))
    .catch(() => ({ ok: false, code: 'NET', msg: '网络不通，请重试' }));
}

module.exports = { initCloud, enabled, syncOn, syncCall, login, pushRecord, pull, uploadFile, uploadPhoto, aiEvalDraft, stuImport, secText, secImage, requestSubscribe, familyBind, familyNotify, inviteInfo, inviteJoin, inviteGet, adminAccount, cloudBackup, CLOUD_ENV };
