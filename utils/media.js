// utils/media.js —— 媒体文件持久化（照片 / 视频 / 语音）
//
// 【为什么必须有这一层】
// wx.chooseMedia / RecorderManager 返回的 tempFilePath 指向系统临时目录，
// 小程序退出后系统会清理，历史记录里的课堂照片就会变成裂图——这是不可逆的丢失，
// 因为原图已经不在任何地方了。所以落库前必须复制到 USER_DATA_PATH（用户目录，
// 只有用户主动清理小程序存储或卸载时才会消失）。
//
// 【容量】小程序本地文件空间上限约 200MB。照片按 1-3MB、视频按 10-50MB 估算，
// 不做清理的话大约 2-3 个月会满。usage() 给页面做容量提示，清理策略留到上云后（媒体走云存储）。
//
// 【上云怎么改】只需要替换 provider：setProvider(fn) 注入一个把临时文件上传到云存储、
// 返回 fileID 的异步函数，其余调用点都不用改。这里默认是本地实现。

const fs = () => wx.getFileSystemManager();
// 测试环境（Node）下 wx.env 可能不存在，这里必须容错，否则整个数据层加载失败
const ROOT = (wx.env && wx.env.USER_DATA_PATH) || '';
const DIR = ROOT + '/media';

// 空间上限（字节），仅用于提示，不做硬拦截
const LIMIT = 200 * 1024 * 1024;

let seq = 0;
let provider = null;   // 云端上传实现，签名 (tempPath, kind) => Promise<fileID>
let readyDir = false;

// kind 只能是这三类，决定子目录与默认扩展名
const KINDS = { photo: 'jpg', video: 'mp4', audio: 'mp3' };

function ensureDir() {
  if (readyDir) return true;
  try {
    fs().accessSync(DIR);
    readyDir = true;
    return true;
  } catch (e) {
    try { fs().mkdirSync(DIR, true); readyDir = true; return true; }
    catch (e2) { console.error('[media] 建目录失败', e2); return false; }
  }
}

// 判断是否已是持久路径：USER_DATA_PATH 下的文件不会被系统清理
function isPersist(p) {
  const s = String(p || '');
  // ROOT 为空时必须直接返回 false：indexOf('') 恒为 0，否则任何路径都会被误判成持久路径
  if (!ROOT || !s) return false;
  return s.indexOf(ROOT) === 0;
}

// 从临时路径猜扩展名；临时路径常带查询串，需要剥掉
function extOf(p, kind) {
  const s = String(p || '').split('?')[0];
  const m = s.match(/\.([a-zA-Z0-9]{1,6})$/);
  const ext = m ? m[1].toLowerCase() : '';
  if (ext && /^(jpg|jpeg|png|gif|webp|heic|mp4|mov|m4v|mp3|m4a|aac|wav|silk)$/.test(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  return KINDS[kind] || 'jpg';
}

// 把单个临时文件转成持久文件。失败时返回原路径：宁可留个可能失效的路径，也不能让整条记录保存失败
function persist(tmpPath, kind) {
  const s = String(tmpPath || '');
  const k = KINDS[kind] ? kind : 'photo';
  if (!s) return '';
  if (isPersist(s)) return s;
  if (provider) { provider(s, k); return s; }   // 云端模式下由 provider 异步接管，先返回原路径占位
  if (!ensureDir()) return s;
  const dest = DIR + '/' + k + '_' + Date.now() + '_' + (seq++) + '.' + extOf(s, k);
  try {
    fs().copyFileSync(s, dest);
    return dest;
  } catch (e) {
    // 常见原因是临时文件已被系统清理。用 warn 而非 error：这是可预期的降级路径，
    // 不是程序错误，调用方拿到原路径继续走。
    console.warn('[media] 转存失败，保留原路径', k, (e && e.message) || e);
    return s;
  }
}

function persistMany(list, kind) {
  return (Array.isArray(list) ? list : []).map(p => persist(p, kind)).filter(Boolean);
}

// 清掉已失效的临时文件引用（文件确实不存在时置空比留个裂图好）
function exists(p) {
  const s = String(p || '');
  if (!s) return false;
  try { fs().accessSync(s); return true; } catch (e) { return false; }
}

// 本地媒体占用（字节）。页面可用于容量提示
function usage() {
  let total = 0, count = 0;
  try {
    const files = fs().readdirSync(DIR);
    files.forEach(name => {
      try {
        const st = fs().statSync(DIR + '/' + name);
        total += (st.size || 0); count++;
      } catch (e) { /* 单个文件读取失败不影响统计 */ }
    });
  } catch (e) { /* 目录还不存在 = 0 */ }
  return { bytes: total, count, limit: LIMIT, percent: Math.min(100, Math.round(total / LIMIT * 100)) };
}

// 删除某个媒体文件（移除照片时调用，避免垃圾文件越积越多）
function remove(p) {
  const s = String(p || '');
  if (!isPersist(s)) return false;   // 临时路径交给系统自己清理
  try { fs().unlinkSync(s); return true; } catch (e) { return false; }
}

function setProvider(fn) { provider = typeof fn === 'function' ? fn : null; }

// chooseMedia 统一失败处理：不写 fail 回调时，相册被隐私/权限拦截会表现为「点了没反应」
// page 传当前 Page 实例，用于唤起页面上的隐私弹窗组件（<privacy-popup id="privacy" />）
function handleChooseFail(err, page) {
  const msg = (err && err.errMsg) || String(err || '');
  if (msg.indexOf('cancel') > -1) return; // 用户取消，不算错误
  if (/privacy|not declared/i.test(msg)) {
    // 隐私协议未同意（或后台「用户隐私保护指引」未配置）→ 唤起隐私弹窗
    const comp = page && page.selectComponent && page.selectComponent('#privacy');
    if (comp && comp.forceShow) { comp.forceShow(); return; }
    wx.showToast({ title: '请先同意《隐私保护指引》', icon: 'none' });
    return;
  }
  if (/auth|denied|deny|permission/i.test(msg)) {
    // 相册/相机权限被用户永久拒绝 → 引导去设置页打开
    wx.showModal({
      title: '没有相册权限',
      content: '请在设置中允许「橙果」使用照片和相机，否则无法添加课堂照片',
      confirmText: '去设置',
      success: r => { if (r.confirm) wx.openSetting(); }
    });
    return;
  }
  wx.showToast({ title: '选择失败，请重试', icon: 'none' });
}

module.exports = { ROOT, DIR, LIMIT, isPersist, persist, persistMany, exists, usage, remove, setProvider, extOf, handleChooseFail };
