const store = require('../../utils/store');
const api = require('../../utils/api');

Page({
  data: { clsId: null, clsNames: [], students: [], isParent: false, kids: [], dbName: '' },
  onShow() {
    const db = store.get();
    const u = db.users.find(x => x.id === db.me) || db.users[0];
    const isParent = u.role === 'parent';
    if (isParent) {
      const kids = db.students
        .filter(s => !(u.studentIds || []).length || (u.studentIds || []).includes(s.id))
        .map(s => {
          const r = store.latestRecord(s.id);
          return { id: s.id, name: s.name, latest: r ? (r.course + ' · ' + r.score + '分 · ' + r.date) : '暂无记录' };
        });
      this.setData({ isParent: true, kids });
    } else {
      // 老师按"负责班级"过滤；未分配则看全部
      const vis = (u.clsIds || []).length ? db.classes.filter(c => u.clsIds.includes(c.id)) : db.classes;
      const clsId = vis.find(c => c.id === this.data.clsId) ? this.data.clsId : (vis[0] && vis[0].id);
      this.refresh(clsId, vis);
    }
    this.setData({ dbName: u.name || db.teacher });
  },
  refresh(clsId, vis) {
    const db = store.get();
    const cls = vis || db.classes;
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
