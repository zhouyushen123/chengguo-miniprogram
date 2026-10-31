const store = require('../../utils/store');
const api = require('../../utils/api');

Page({
  data: { clsId: null, clsNames: [], students: [], isParent: false, kids: [], dbName: '' },
  onShow() {
    const db = store.get();
    const u = db.users.find(x => x.id === db.me) || db.users[0];
    const isParent = u.role === 'parent';
    if (isParent) {
      const kids = db.students.map(s => {
        const r = store.latestRecord(s.id);
        return { id: s.id, name: s.name, latest: r ? (r.course + ' · ' + r.score + '分 · ' + r.date) : '暂无记录' };
      });
      this.setData({ isParent: true, kids });
    } else {
      const cls = db.classes;
      const clsId = this.data.clsId || (cls[0] && cls[0].id);
      this.refresh(clsId);
    }
    this.setData({ dbName: db.teacher });
  },
  refresh(clsId) {
    const db = store.get();
    const students = store.studentsOf(clsId).map(s => {
      const r = store.latestRecord(s.id);
      return {
        id: s.id, name: s.name, meta: (s.clsIds || []).map(store.clsName).join(' · '),
        latest: r ? { tag: r.tag, score: r.score, course: r.course, date: r.date, sent: r.sent, note: (r.note || '').split('\n')[0] } : null
      };
    });
    this.setData({
      clsId, clsNames: cls.map(c => ({ id: c.id, name: c.name })),
      students, isParent: false
    });
  },
  pickCls(e) { this.refresh(e.currentTarget.dataset.id); },
  goRecord(e) {
    const db = store.get();
    getApp().globalData.pick = { cls: this.data.clsId, sid: e.currentTarget.dataset.sid || null, score: 85, photos: [], audio: null, tag: '', note: '', rid: null, course: '' };
    wx.navigateTo({ url: '/pages/record/record' });
  },
  goStudent(e) { wx.navigateTo({ url: '/pages/student/student?id=' + e.currentTarget.dataset.sid }); },
  goMgr() { wx.switchTab({ url: '/pages/mgr/mgr' }); },
  onPullDownRefresh() {
    api.pull().then(d => { if (d) store.replaceDb(d); this.onShow(); wx.stopPullDownRefresh(); })
      .catch(() => wx.stopPullDownRefresh());
  }
});
