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
function inviteGet(role, orgId) {
  if (!cloudReady) return Promise.resolve({ ok: false, code: 'CLOUD_OFF', msg: '网络未就绪' });
  // 服务端按「event.orgId 必须等于我绑定的机构」判权限（fail-closed），
  // 漏传等于自报空机构 → FORBIDDEN「无权访问该机构数据」。2026-11-06 真机踩坑。
  return callFn('syncv2', { action: 'inviteGet', role, orgId: String(orgId || '') }).catch(() => ({ ok: false, code: 'NET', msg: '网络不通，请重试' }));
}

/* ---------------- 多机构身份 ----------------
 * 一个微信可以有多张机构工牌（老师在两家上课）。myOrgs 回可进入的机构清单，
 * 顶部切换器与"再加一家"都靠它。同样不走 syncOn 闸门：和加入机构是一类事。
 */
function myOrgs() {
  if (!cloudReady) return Promise.resolve({ ok: false, code: 'CLOUD_OFF', orgs: [] });
  return callFn('syncv2', { action: 'myOrgs' }).catch(() => ({ ok: false, code: 'NET', orgs: [] }));
}

/* ---------------- 家长邀请卡（一人一卡，免记码） ----------------
 * 和邀请码同一条云函数、同样不走 syncOn 闸门：家长点卡片进来时还没绑机构。
 * 卡片链接里只有一个一次性 token，机构码和学号从头到尾只在服务端出现。
 */
function cardCreate(sid, orgId) {
  if (!cloudReady) return Promise.resolve({ ok: false, code: 'CLOUD_OFF', msg: '网络未就绪' });
  return callFn('syncv2', { action: 'cardCreate', sid, orgId: String(orgId || '') })
    .catch(() => ({ ok: false, code: 'NET', msg: '网络不通，请重试' }));
}
function cardInfo(token) {
  if (!cloudReady) return Promise.resolve({ ok: false, code: 'CLOUD_OFF', msg: '网络未就绪' });
  return callFn('syncv2', { action: 'cardInfo', token: String(token || '') })
    .catch(() => ({ ok: false, code: 'NET', msg: '网络不通，请重试' }));
}
function cardClaim(token, name, merge) {
  if (!cloudReady) return Promise.resolve({ ok: false, code: 'CLOUD_OFF', msg: '网络未就绪' });
  // merge：'' 第一次问；'new' 不是同一个孩子；<pid> 确认是同一个孩子
  return callFn('syncv2', { action: 'cardClaim', token: String(token || ''), name, merge: String(merge || '') })
    .catch(() => ({ ok: false, code: 'NET', msg: '网络不通，请重试' }));
}
function cardRevoke(token, orgId) {
  if (!cloudReady) return Promise.resolve({ ok: false, code: 'CLOUD_OFF', msg: '网络未就绪' });
  return callFn('syncv2', { action: 'cardRevoke', token: String(token || ''), orgId: String(orgId || '') })
    .catch(() => ({ ok: false, code: 'NET', msg: '网络不通，请重试' }));
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
// AI 识图 / 全班评语：调 aiEval 云函数（智谱 GLM-4V-Flash / glm-4-flash）。
// 入参三选一：{ fileID } 云存储图片；{ imageBase64, hint } 压缩图兜底；{ action:'batch' } 批量评语。
// 不走 callSync（它把 ok:false 当 reject，这里的业务错误码要用 result 原样带回）
//
// 真机 2026-11-07 14:10：云端 aiEval 超时只有 3 秒，识图通常 5~10 秒，第一次几乎必被掐断，
// 老师得连点两三次才出结果。这里只对「网络 / 超时」类失败自动补 2 次（0.8s / 1.5s 退避），
// 业务错误（NO_KEY / 缺照片 / GLM 报错）原样返回不重试；三次都失败时把真实 errMsg 抛出去，
// 绝不吞成「网络不通」——上午修 admin 账号时已经吃过这个亏。
function aiEvalDraft(data, opts) {
  if (!cloudReady) return Promise.reject(new Error('CLOUD_OFF'));
  const onRetry = opts && typeof opts.onRetry === 'function' ? opts.onRetry : null;
  const once = () => new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'aiEval',
      data: data || {},
      success: r => resolve(r.result || { ok: false, msg: '云函数无返回' }),
      fail: e => reject(new Error((e && e.errMsg) || '云函数调用失败'))
    });
  });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const attempt = n => once().catch(e => {
    if (n >= 2) throw e;                  // 一次点击最多补两次，别无限转圈
    if (onRetry) onRetry(n + 1);
    return wait(n === 0 ? 800 : 1500).then(() => attempt(n + 1));
  });
  return attempt(0);
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

/* ---------------- 家长已读回执与留言（family 云函数） ----------------
 * 这两张表不进同步集合，走云函数按「这个微信绑的是哪个孩子」鉴权。
 * 云未通时全部返回 ok:false/CLOUD_OFF：前端据此把入口藏起来，绝不弹「网络错误」吓家长。
 */
function fbView(rid, sid) {
  if (!cloudReady) return Promise.resolve({ ok: false, code: 'CLOUD_OFF' });
  return callFn('family', { action: 'fbView', rid: Number(rid) || 0, sid: Number(sid) || 0 })
    .catch(() => ({ ok: false, code: 'NET' }));
}
function fbNote(rid, sid, text) {
  if (!cloudReady) return Promise.resolve({ ok: false, code: 'CLOUD_OFF', msg: '网络未就绪' });
  return callFn('family', { action: 'fbNote', rid: Number(rid) || 0, sid: Number(sid) || 0, text: String(text || '') })
    .catch(() => ({ ok: false, code: 'NET', msg: '网络不通，请重试' }));
}
function fbList(scope) {
  if (!cloudReady) return Promise.resolve({ ok: false, code: 'CLOUD_OFF' });
  return callFn('family', { action: 'fbList', scope: scope || '' })
    .catch(() => ({ ok: false, code: 'NET' }));
}
function fbStats(rids) {
  if (!cloudReady) return Promise.resolve({ ok: false, code: 'CLOUD_OFF', stats: {} });
  return callFn('family', { action: 'fbStats', rids: (rids || []).slice(0, 50) })
    .catch(() => ({ ok: false, code: 'NET', stats: {} }));
}
function fbHandle(id) {
  if (!cloudReady) return Promise.resolve({ ok: false, code: 'CLOUD_OFF' });
  return callFn('family', { action: 'fbHandle', id: String(id || '') })
    .catch(() => ({ ok: false, code: 'NET', msg: '网络不通，请重试' }));
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
// admin 云函数默认超时只有 3 秒，首次调用要冷启动 + 建 admin_accounts 集合，常被掐断；
// 第二次函数已热、集合已建，基本都能过。自动重试 2 次只覆盖这种一次性失败，网络真断
// 最多多等 2 秒。真实 errMsg 必须带回去——超时 / 函数不存在 / 环境错处理方式完全不同。
function adminAccount() {
  if (!cloudReady) return Promise.resolve({ ok: false, code: 'CLOUD_OFF', msg: '网络未就绪' });
  const once = () => callFn('admin', { action: 'mkAccount' });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  return once()
    .catch(() => wait(800).then(once))
    .catch(() => wait(1500).then(once))
    .catch(e => ({
      ok: false, code: 'NET', msg: '云函数没响应，请重试',
      err: String((e && e.message) || e || '').slice(0, 140)
    }));
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

module.exports = { initCloud, enabled, syncOn, syncCall, login, pushRecord, pull, uploadFile, uploadPhoto, aiEvalDraft, stuImport, secText, secImage, requestSubscribe, familyBind, familyNotify, fbView, fbNote, fbList, fbStats, fbHandle, inviteInfo, inviteJoin, inviteGet, myOrgs, adminAccount, cloudBackup, cardCreate, cardInfo, cardClaim, cardRevoke, CLOUD_ENV };
