// pages/trash/trash.js —— 回收站
//
// 【边界】这里只做两件事：列出最近删掉的东西、把它们放回去。
// 不提供"彻底删除"：小程序的本地存储本来就只有 10MB 量级，
// 真需要腾空间走「存储空间」页的清理，而不是让用户在这里做不可逆的决定。
const db = require('../../utils/db');

const KINDS = [
  { k: '', label: '全部' },
  { k: 'students', label: '学生' },
  { k: 'classes', label: '班级' },
  { k: 'courses', label: '课程' },
  { k: 'records', label: '记录' },
  { k: 'members', label: '成员' }
];

function fmtTime(ts) {
  const n = Number(ts) || 0;
  if (!n) return '';
  const d = new Date(n);
  const p = x => (x < 10 ? '0' + x : '' + x);
  return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

Page({
  data: {
    kinds: KINDS, kind: '',
    items: [], total: 0, loading: true, msg: ''
  },

  onShow() { this.refresh(); },

  refresh() {
    const r = db.trash.list(this.data.kind);
    if (!r.ok) {
      this.setData({ items: [], total: 0, loading: false, msg: r.msg || '打不开回收站' });
      return;
    }
    this.setData({
      // key 要带类型：学生 id=1 和班级 id=1 会撞（wx:key 撞了会错行渲染）
      items: r.items.map(x => Object.assign({}, x, { key: x.kind + '-' + x.id, time: fmtTime(x.at) })),
      total: r.total, loading: false, msg: ''
    });
  },

  onKind(e) {
    this.setData({ kind: e.currentTarget.dataset.k || '' }, () => this.refresh());
  },

  onRestore(e) {
    const { kind, id, title } = e.currentTarget.dataset;
    wx.showModal({
      title: '恢复「' + title + '」？',
      content: '会连同这次删除带走的内容一起回来（记录、报名、课程、名单关联），之后自动同步到云端和其他设备。',
      confirmText: '恢复',
      success: r => {
        if (!r.confirm) return;
        const res = db.trash.restore(kind, id);
        if (!res || !res.ok) {
          wx.showToast({ title: (res && res.msg) || '恢复失败', icon: 'none' });
          return;
        }
        this.refresh();
        wx.showToast({ title: '已恢复', icon: 'none' });
      }
    });
  }
});
