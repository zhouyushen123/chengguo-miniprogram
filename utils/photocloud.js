// utils/photocloud.js —— 照片云端备份的编排层
//
// 【为什么要有这层】照片之前只存手机本地：清缓存/换手机就没了，家长端也看不到。
// 现在保存记录后把照片异步直传云存储（wx.cloud.uploadFile，不经过云函数），
// 传成功后把记录里的本地路径替换成 cloud:// fileID——<image> 标签原生支持 fileID，
// 任何装了这个小程序、初始化过同一云环境的设备都能直接显示。
//
// 【设计要点】
// - 全程后台：上传慢不能阻塞保存，失败/离线就保留本地路径（下次 migrateAll 再试）
// - 每张照片过内容安全（secImage）：违规图从记录里剔除（fail-open：检查挂了不误删）
// - 只处理照片，视频/语音体积大（几十 MB），云存储免费额度有限，先不动（handoff 有记录）
// - 依赖可注入（io 参数），逻辑可在 Node 测试里验证

const db = require('./db');
const api = require('./api');

const isCloud = p => String(p || '').indexOf('cloud://') === 0;

// 把一条记录里的本地照片全部传云端。io = { upload, check } 仅供测试注入。
// 返回 { ok, uploaded, dropped, kept, total }（kept = 上传失败暂留本地的张数）
function flushRecord(rid, io) {
  const dep = io || { upload: api.uploadPhoto, check: api.secImage };
  const r = db.records.get(rid);
  if (!r) return Promise.resolve({ ok: false, uploaded: 0, dropped: 0, kept: 0, total: 0 });
  const photos = r.photos || [];
  if (!photos.length) return Promise.resolve({ ok: true, uploaded: 0, dropped: 0, kept: 0, total: 0 });
  const out = [];
  let uploaded = 0, dropped = 0, kept = 0;
  const chain = photos.reduce((acc, p) => acc.then(() => {
    if (!p || isCloud(p)) { out.push(p); return null; }        // 已是云端 / 空槽原样保留
    return dep.upload(p).then(fid => {
      if (!fid) { out.push(p); kept++; return null; }          // 上传失败：留本地，下次再试
      // 内容检查挂在文件已传成功之后：fail-open 保留 fileID（照片已在云端，别误删）
      return dep.check(fid).then(sec =>
        (sec && sec.ok === false && sec.hit)
          ? (dropped++, null)                                   // 内容违规：从记录里剔除
          : (out.push(fid), uploaded++, null)
      ).catch(() => (out.push(fid), uploaded++, null));
    }).catch(() => { out.push(p); kept++; return null; });      // 上传链路异常：留本地
  }), Promise.resolve());
  return chain.then(() => {
    const next = out.filter(p => p);
    const changed = next.join('|') !== photos.join('|');
    if (changed) db.records.attachCloud(rid, next);
    return { ok: true, uploaded, dropped, kept, total: next.length };
  });
}

let running = false;   // 防重入：onShow 可能连发，别排队传两遍
// 全库迁移：把所有还挂着本地照片的老记录逐条补传（后台静默，失败留下次）。
// 首次开启上云时把历史照片也搬上去；传完的记录不再进队列，天然幂等。
// io 注入时视为云在线（供测试；生产恒用 api.enabled() 判断）。
function migrateAll(io) {
  const on = io ? true : api.enabled();
  if (running || !on) return Promise.resolve({ ok: false, skipped: true });
  const todo = db.records.list()
    .filter(r => !r.removed && (r.photos || []).some(p => p && !isCloud(p)))
    .map(r => r.id);
  if (!todo.length) return Promise.resolve({ ok: true, uploaded: 0, records: 0 });
  running = true;
  let uploaded = 0, records = 0;
  return todo.reduce((acc, rid) => acc.then(res => {
    if (res && res.uploaded) { uploaded += res.uploaded; records++; }
    return flushRecord(rid, io);
  }), Promise.resolve(null))
    .then(res => {
      if (res && res.uploaded) { uploaded += res.uploaded; records++; }
      running = false;
      return { ok: true, uploaded, records };
    })
    .catch(() => { running = false; return { ok: false, uploaded, records }; });
}

module.exports = { flushRecord, migrateAll, isCloud };
