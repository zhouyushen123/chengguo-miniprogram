// secCheck —— 微信内容安全（msgSecCheck / imgSecCheck）
// UGC（老师评语、AI 生成评语、家长昵称等）提审前必须过安全检查，微信审核会查。
// 云调用（cloud.openapi）免 access_token，openid 从上下文自动带。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const MSG_MAX = 2500; // msgSecCheck 单次文本上限

// 统一判读：87014 = 命中违规；其它错误不装死（打日志）但不阻断业务（fail-open），
// 内容安全接口抖动时把 45 个老师全拦在门外，比漏检一条文本伤害大；真正被拦的只有 87014。
function judge(e) {
  const code = (e && (e.errCode !== undefined ? e.errCode : e.errMsg)) || 0;
  if (code === 87014 || (typeof code === 'string' && code.indexOf('87014') > -1)) {
    return { ok: false, hit: true };
  }
  console.warn('secCheck 非拦截错误:', e && (e.errCode || e.errMsg || e));
  return { ok: true, warn: true };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, msg: '未登录，拒绝调用' };

  try {
    // 文本检查：老师/AI 评语、姓名、机构名等所有会展示给别人的文字
    if (event.action === 'msg') {
      const content = String(event.content || '').slice(0, MSG_MAX);
      if (!content.trim()) return { ok: true, empty: true };
      try {
        const r = await cloud.openapi.security.msgSecCheck({ content });
        return { ok: true, verdict: (r && r.result) ? r.result.suggest : 'pass' };
      } catch (e) { return judge(e); }
    }

    // 图片检查：云存储 fileID → 下载成 buffer → imgSecCheck（上限 1M，超限跳过并打标）
    if (event.action === 'img') {
      const fileID = String(event.fileID || '');
      if (!fileID) return { ok: false, msg: '缺少 fileID' };
      const dl = await cloud.downloadFile({ fileID });
      if (!dl.buffer || !dl.buffer.length) return { ok: false, msg: '图片下载失败' };
      if (dl.buffer.length > 1024 * 1024) return { ok: true, warn: true, tooBig: true };
      try {
        await cloud.openapi.security.imgSecCheck({ media: { contentType: 'image/png', value: dl.buffer } });
        return { ok: true };
      } catch (e) { return judge(e); }
    }

    return { ok: false, msg: '未知 action' };
  } catch (e) {
    return { ok: false, msg: (e && e.message) || '内容安全检查失败' };
  }
};
