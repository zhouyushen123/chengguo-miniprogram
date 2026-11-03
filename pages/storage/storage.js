// pages/storage/storage.js —— 存储空间：本地数据与媒体的占用、清理
//
// 【为什么需要这个页面】小程序本地文件空间约 200MB，课堂视频 10–50MB 一条，
// 两条带满视频的记录就能吃掉 150MB。以前 media.usage() 写好了却没有页面调用，
// 空间满了只会表现为"新照片存不下来"，用户完全不知道为什么。
//
// 【清理策略】只删"没有任何记录引用、且不是最近两小时内新建"的文件：
//   - 已删除的记录仍算引用 —— 照片删掉就找不回来，多占几百 KB 可以接受
//   - 两小时内新建的不动 —— 可能是用户在录入页选好、还没保存的素材
const db = require('../../utils/db');
const media = require('../../utils/media');
const theme = require('../../utils/theme');

const KB = 1024;
const MB = 1024 * 1024;

function size(bytes) {
  const n = Number(bytes) || 0;
  if (n >= MB) return (n / MB).toFixed(n >= 10 * MB ? 0 : 1) + ' MB';
  if (n >= KB) return Math.round(n / KB) + ' KB';
  return n + ' B';
}

Page({
  data: {
    kvText: '暂不可用', kvPct: 0, kvNote: '',
    mdText: '0 B', mdPct: 0, mdFiles: 0, mdLimit: '200 MB',
    orphanCount: 0, orphanText: '0 B', recent: 0, cleanText: '暂无可清理的文件',
    students: 0, records: 0, classes: 0,
    failed: false
  },

  onShow() { theme.apply(this); this.refresh(); },

  refresh() {
    const h = db.health();
    const kv = h.usage;
    const md = media.scan(db.mediaRefs());
    const c = h.counts || {};
    this.setData({
      kvText: kv ? (size(kv.current * KB) + ' / ' + size(kv.limit * KB)) : '暂不可用',
      kvPct: (kv && kv.limit) ? Math.min(100, Math.round(kv.current / kv.limit * 100)) : 0,
      kvNote: kv ? (kv.keys + ' 个存储项') : '',
      mdText: size(md.bytes) + ' / ' + size(media.LIMIT),
      mdPct: Math.min(100, Math.round(md.bytes / media.LIMIT * 100)),
      mdFiles: md.files,
      orphanCount: md.orphan.length,
      orphanText: size(md.orphanBytes),
      // WXML 里不做字符串拼接：文案统一在这里算好，模板只负责展示
      cleanText: md.orphan.length ? ('清理这 ' + md.orphan.length + ' 个文件') : '暂无可清理的文件',
      recent: md.recent,
      students: c.students || 0,
      records: c.records || 0,
      classes: c.classes || 0,
      failed: !!h.lastFail
    });
  },

  clean() {
    if (!this.data.orphanCount) {
      wx.showToast({ title: '没有可清理的文件', icon: 'none' });
      return;
    }
    const n = this.data.orphanCount, s = this.data.orphanText;
    wx.showModal({
      title: '清理 ' + n + ' 个文件？',
      content: '这些照片/视频已经没有任何课堂记录引用（约 ' + s + '）。已保存的记录不受影响。',
      confirmText: '清理',
      confirmColor: theme.danger(),
      success: r => {
        if (!r.confirm) return;
        const res = media.prune(db.mediaRefs());
        this.refresh();
        wx.showToast({
          title: res.removed ? ('已释放 ' + size(res.bytes)) : '没有可清理的文件',
          icon: 'none'
        });
      }
    });
  }
});
