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

// 备份时间戳：只到分钟，够用且不占宽度
function fmtTime(ts) {
  const n = Number(ts) || 0;
  if (!n) return '';
  const d = new Date(n);
  const p = x => (x < 10 ? '0' + x : '' + x);
  return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

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
    failed: false,
    // 数据体检：核心资产（学生 / 成员 / 机构）之间的引用是否对得上
    auditOk: true, auditErr: 0, auditWarn: 0, auditItems: [], fixable: false,
    // 本地备份：核心资产的滚动快照（最多 3 份）
    snaps: [], snapCount: 0, snapHint: '还没有备份',
    // 被云端拒绝的改动：本地改成功了、云端没接受，不说出来就是静默不一致
    rejects: [], rejectCount: 0, trashCount: 0
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
    this.refreshAudit();
    this.refreshSnaps();
    this.refreshRejects();
  },

  // 体检与备份要单独 try：它们是"附加信息"，坏了不能让整页白屏
  refreshAudit() {
    let a = null;
    try { a = db.audit.scan(); } catch (e) { a = null; }
    if (!a) { this.setData({ auditOk: true, auditItems: [] }); return; }
    this.setData({
      auditOk: a.healthy,
      auditErr: a.errors,
      auditWarn: a.warns,
      auditItems: (a.issues || []).map(x => ({ k: x.k, level: x.level, title: x.title, count: x.count })),
      // 只有这两类是"修了绝不会更糟"的，其它（比如重复学生）必须人来判断
      fixable: (a.issues || []).some(x => x.k === 'stuDanglingCls' || x.k === 'memDangling' || x.k === 'dupNo' || x.k === 'noNo')
    });
  },

  // 同步被拒 + 回收站条数：都是"数据没在预期位置"的信号，放在一起看
  refreshRejects() {
    let list = [];
    let trash = 0;
    try { list = db.sync.rejects() || []; } catch (e) { list = []; }
    try { const r = db.trash.list(); trash = (r && r.ok) ? r.total : 0; } catch (e) { trash = 0; }
    this.setData({
      rejectCount: list.length,
      rejects: list.slice(0, 5).map((x, i) => ({ idx: i, msg: x.msg || x.code, time: fmtTime(x.at) })),
      trashCount: trash
    });
  },

  goTrash() { wx.navigateTo({ url: '/pages/trash/trash' }); },

  clearRejects() {
    try { db.sync.clearRejects(); } catch (e) { /* 清不掉也不影响业务 */ }
    this.refreshRejects();
  },

  refreshSnaps() {
    let list = [];
    try { list = db.snapshots.list() || []; } catch (e) { list = []; }
    const snaps = list.map(x => ({
      id: x.id, tag: x.tag || '备份', at: x.at, time: fmtTime(x.at),
      text: x.counts ? (x.counts.students + ' 学生 · ' + x.counts.records + ' 记录') : ''
    }));
    this.setData({
      snaps,
      snapCount: snaps.length,
      snapHint: snaps.length ? ('最近 ' + snaps[0].time) : '还没有备份'
    });
  },

  // 只修悬空引用与学号，重复学生/孤儿记录只报告不自动处理
  fixData() {
    wx.showModal({
      title: '修复这些对不上的引用？',
      content: '会做两件事：把指向"已删除班级/学生"的引用摘掉；给重复或缺失的学号重新发号。学生、老师、机构本身一条都不会删。',
      confirmText: '修复',
      success: r => {
        if (!r.confirm) return;
        const res = db.audit.fix(['dangling', 'noNo']);
        if (!res || !res.ok) { wx.showToast({ title: (res && res.msg) || '修复失败', icon: 'none' }); return; }
        const n = (res.fixed.dangling || 0) + (res.fixed.noNo || 0);
        this.refresh();
        wx.showToast({ title: n ? ('已修复 ' + n + ' 处') : '没有需要修的', icon: 'none' });
      }
    });
  },

  doBackup() {
    const r = db.snapshots.save('手动备份');
    if (!r || !r.ok) { wx.showToast({ title: (r && r.msg) || '备份失败', icon: 'none' }); return; }
    this.refreshSnaps();
    wx.showToast({ title: '已备份到本机', icon: 'none' });
  },

  doRestore() {
    const list = this.data.snaps;
    if (!list.length) { wx.showToast({ title: '还没有备份', icon: 'none' }); return; }
    wx.showActionSheet({
      itemList: list.map(x => x.tag + ' · ' + x.time + '（' + x.text + '）'),
      success: r => {
        const s = list[r.tapIndex];
        if (!s) return;
        wx.showModal({
          title: '恢复到 ' + s.time + '？',
          content: '当前数据会先自动存一份「恢复前」，再回到这份备份。恢复后会自动与云端重新对齐。',
          confirmText: '恢复',
          confirmColor: theme.danger(),
          success: m => {
            if (!m.confirm) return;
            const res = db.snapshots.restore(s.id);
            if (!res || !res.ok) { wx.showToast({ title: (res && res.msg) || '恢复失败', icon: 'none' }); return; }
            this.refresh();
            wx.showToast({ title: '已恢复', icon: 'none' });
          }
        });
      }
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
