const store = require('../../utils/store');

Page({
  data: {
    s: null, tab: 0, latest: null, history: [], rec: null, photoUrls: [], videoUrls: [],
    filters: [], filt: '全部', total: 0, shown: 0, expandId: 0
  },
  onLoad(q) {
    this.sid = +q.id || +q.sid || 0; // 兼容 id / sid 两种参数名
    this.rid = +q.rid || 0;
  },
  onShow() { this.render(); },
  // 统一渲染：拉记录 → 按筛选过滤 → 首条做详情，其余进历史列表
  render() {
    const db = store.get();
    // 兼容只带 rid 的入口（如首页最近成果）：先从记录反查学生
    if (!this.sid && this.rid) {
      const r0 = db.records.find(r => r.id === this.rid);
      if (r0) this.sid = r0.sid;
    }
    const s = store.student(this.sid);
    if (!s) return;
    const recs = db.records.filter(r => r.sid === this.sid).sort((a, b) => b.id - a.id);
    const withLines = r => r ? Object.assign({}, r, { noteLines: (r.note || '').split('\n').filter(Boolean) }) : r;

    // 指定某条记录（从记录列表点入）
    if (this.rid) {
      const rec = withLines(recs.find(r => r.id === this.rid) || null);
      this.setData({
        s: this.stuView(s), rec, latest: null, history: [],
        photoUrls: (rec || {}).photos || [], videoUrls: (rec || {}).videos || [],
        filters: [], filt: '全部', total: 0, shown: 0
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
      // 历史条目带全量字段，行内展开详情用（不再跳新页）
      history: list.slice(1).map(withLines),
      photoUrls: (list[0] || {}).photos || [],
      videoUrls: (list[0] || {}).videos || []
    });
  },
  stuView(s) {
    return { name: s.name, meta: (s.clsIds || []).map(store.clsName).join(' · '), wechat: s.wechat || '' };
  },
  pickFilter(e) {
    this.setData({ filt: e.currentTarget.dataset.f, expandId: 0 }, () => this.render());
  },
  // 历史条目行内展开/收起（同一时间只展开一条）
  toggleExpand(e) {
    const id = +e.currentTarget.dataset.rid;
    this.setData({ expandId: this.data.expandId === id ? 0 : id });
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
  previewPhoto(e) { wx.previewImage({ urls: this.data.photoUrls, current: this.data.photoUrls[e.currentTarget.dataset.i] }); }
});
