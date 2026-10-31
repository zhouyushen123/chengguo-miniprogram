const store = require('../../utils/store');

Page({
  data: { s: null, courses: [], tab: 0, latest: null, history: [], rec: null, photoUrls: [] },
  onLoad(q) {
    this.sid = +q.id || 0;
    this.rid = +q.rid || 0;
  },
  onShow() {
    const db = store.get();
    const s = store.student(this.sid);
    if (!s) return;
    const courses = store.coursesOf(db.classes.find(c => (s.clsIds || []).includes(c.id)).id).map(c => c.name);
    const recs = db.records.filter(r => r.sid === this.sid).sort((a, b) => b.id - a.id);
    let latest = null, history = [], rec = null;
    const withLines = r => r ? Object.assign({}, r, { noteLines: (r.note || '').split('\n').filter(Boolean) }) : r;
    if (this.rid) {
      rec = withLines(recs.find(r => r.id === this.rid) || null);
    } else {
      latest = withLines(recs[0] || null);
      history = recs.slice(1).map(r => ({ id: r.id, course: r.course, date: r.date, score: r.score, tag: r.tag, note1: (r.note || '').split('\n')[0] }));
    }
    this.setData({
      s: { name: s.name, meta: (s.clsIds || []).map(store.clsName).join(' · '), wechat: s.wechat || '' },
      courses, latest, history, rec,
      photoUrls: (rec || latest || ({})).photos || []
    });
  },
  goRecord() {
    getApp().globalData.pick = { cls: (store.get().classes.find(c => (this.data.s && true)) || {}).id, sid: this.sid, score: 85, photos: [], audio: null, tag: '', note: '', rid: null, course: '' };
    const s = store.student(this.sid);
    if (s && s.clsIds && s.clsIds[0]) getApp().globalData.pick.cls = s.clsIds[0];
    wx.navigateTo({ url: '/pages/record/record' });
  },
  goProfile() { wx.navigateTo({ url: '/pages/profile/profile?id=' + this.sid }); },
  openHistory(e) {
    wx.navigateTo({ url: '/pages/student/student?rid=' + e.currentTarget.dataset.rid + '&id=' + this.sid });
  },
  previewPhoto(e) { wx.previewImage({ urls: this.data.photoUrls, current: this.data.photoUrls[e.currentTarget.dataset.i] }); }
});
