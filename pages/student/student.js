const store = require('../../utils/store');

Page({
  data: {
    s: null, tab: 0, latest: null, history: [], rec: null, photoUrls: [],
    filters: [], filt: '全部', total: 0, shown: 0
  },
  onLoad(q) {
    this.sid = +q.id || 0;
    this.rid = +q.rid || 0;
  },
  onShow() { this.render(); },
  // 统一渲染：拉记录 → 按筛选过滤 → 首条做详情，其余进历史列表
  render() {
    const s = store.student(this.sid);
    if (!s) return;
    const db = store.get();
    const recs = db.records.filter(r => r.sid === this.sid).sort((a, b) => b.id - a.id);
    const withLines = r => r ? Object.assign({}, r, { noteLines: (r.note || '').split('\n').filter(Boolean) }) : r;

    // 指定某条记录（从记录列表点入）
    if (this.rid) {
      const rec = withLines(recs.find(r => r.id === this.rid) || null);
      this.setData({
        s: this.stuView(s), rec, latest: null, history: [],
        photoUrls: (rec || {}).photos || [], filters: [], filt: '全部', total: 0, shown: 0
      });
      return;
    }

    const courses = [];
    recs.forEach(r => { if (r.course && courses.indexOf(r.course) === -1) courses.push(r.course); });
    const filters = ['全部'].concat(courses);
    const filt = filters.indexOf(this.data.filt) > -1 ? this.data.filt : '全部';
    const list = filt === '全部' ? recs : recs.filter(r => r.course === filt);

    this.setData({
      s: this.stuView(s), rec: null,
      filters, filt, total: recs.length, shown: list.length,
      latest: withLines(list[0] || null),
      history: list.slice(1).map(r => ({
        id: r.id, course: r.course, date: r.date, score: r.score, tag: r.tag,
        sent: r.sent, note1: (r.note || '').split('\n')[0]
      })),
      photoUrls: (list[0] || {}).photos || []
    });
  },
  stuView(s) {
    return { name: s.name, meta: (s.clsIds || []).map(store.clsName).join(' · '), wechat: s.wechat || '' };
  },
  pickFilter(e) {
    this.setData({ filt: e.currentTarget.dataset.f }, () => this.render());
  },
  goRecord() {
    const s = store.student(this.sid);
    getApp().globalData.pick = {
      cls: (s && s.clsIds && s.clsIds[0]) || null, sid: this.sid,
      score: 85, photos: [], audio: null, tag: '', note: '', rid: null, course: ''
    };
    wx.navigateTo({ url: '/pages/record/record' });
  },
  goProfile() { wx.navigateTo({ url: '/pages/profile/profile?id=' + this.sid }); },
  openHistory(e) {
    wx.navigateTo({ url: '/pages/student/student?rid=' + e.currentTarget.dataset.rid + '&id=' + this.sid });
  },
  previewPhoto(e) { wx.previewImage({ urls: this.data.photoUrls, current: this.data.photoUrls[e.currentTarget.dataset.i] }); }
});
