const store = require('../../utils/store');

Page({
  data: { tabs: [], tab: 0, list: [], role: 'teacher' },
  onShow() {
    const db = store.get();
    const tabs = ['全部'].concat(db.classes.map(c => c.name));
    // 从首页班级卡跳入：定位到对应班级页签
    const preset = getApp().globalData.recTab;
    let tab = this.data.tab;
    if (preset) {
      const i = tabs.indexOf(preset);
      if (i > 0) tab = i;
      getApp().globalData.recTab = null;
    }
    this.setData({ tabs, tab, role: db.role });
    this.refresh();
  },
  refresh() {
    const db = store.get();
    const t = this.data.tabs[this.data.tab];
    const u = db.users.find(x => x.id === db.me) || db.users[0];
    const kidIds = u.role === 'parent' ? (u.studentIds || []) : null;
    const visCls = u.role === 'teacher' && (u.clsIds || []).length ? u.clsIds : null;
    const cid = t === '全部' ? null : (db.classes.find(c => c.name === t) || {}).id;
    const list = db.records
      .filter(r => !cid || r.cid === cid)
      .filter(r => !kidIds || kidIds.includes(r.sid))
      .filter(r => !visCls || visCls.includes(r.cid))
      .sort((a, b) => b.id - a.id)
      .map(r => {
        const s = store.student(r.sid) || { name: '—' };
        return {
          id: r.id, name: s.name, course: r.course, date: r.date, score: r.score, tag: r.tag,
          sent: r.sent, note: (r.note || '').split('\n')[0],
          photoCount: (r.photos || []).length, hasAudio: !!r.audio,
          photo: (r.photos || [])[0] || ''
        };
      });
    this.setData({ list });
  },
  pickTab(e) { this.setData({ tab: e.currentTarget.dataset.i }); this.refresh(); },
  openRec(e) { wx.navigateTo({ url: '/pages/student/student?rid=' + e.currentTarget.dataset.rid }); },
  editRec(e) {
    const db = store.get();
    const r = db.records.find(x => x.id === e.currentTarget.dataset.rid);
    if (!r) return;
    if (db.role === 'parent') { wx.showToast({ title: '家长为只读身份', icon: 'none' }); return; }
    getApp().globalData.pick = {
      cls: r.cid, sid: r.sid, score: r.score, photos: r.photos || [], audio: r.audio,
      tag: r.tag || '', note: r.note || '', rid: r.id, course: r.course
    };
    wx.navigateTo({ url: '/pages/record/record' });
  }
});
