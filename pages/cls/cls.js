const store = require('../../utils/store');

// 班级详情页：上方学生录入状态（已录/未录色块），下方本班全部成果记录
Page({
  data: {
    cls: null, tiles: [], doneCount: 0,
    recs: [], recTotal: 0
  },
  onLoad(q) {
    this.clsId = +q.id || 0;
  },
  onShow() { this.render(); },
  render() {
    const db = store.get();
    const cls = db.classes.find(c => c.id === this.clsId);
    if (!cls) return;
    wx.setNavigationBarTitle({ title: cls.name });
    const t = store.today();
    const students = store.studentsOf(this.clsId);
    const doneSids = new Set(db.records.filter(r => r.cid === this.clsId && r.date === t).map(r => r.sid));
    const tiles = students.map(s => ({ id: s.id, name: s.name, done: doneSids.has(s.id) }));
    const all = db.records.filter(r => r.cid === this.clsId).sort((a, b) => b.id - a.id);
    const recs = all.slice(0, 50).map(r => {
      const s = store.student(r.sid) || { name: '—' };
      return { id: r.id, sid: r.sid, name: s.name, course: r.course, date: r.date, score: r.score, tag: r.tag || '' };
    });
    this.setData({
      cls: { id: cls.id, name: cls.name },
      tiles, doneCount: tiles.filter(x => x.done).length,
      recs, recTotal: all.length
    });
  },
  // 点学生色块 → 录入页（班级、学生已带好）
  goRecord(e) {
    getApp().globalData.pick = {
      cls: this.clsId, sid: +e.currentTarget.dataset.sid,
      score: 85, photos: [], videos: [], audio: null, tag: '', note: '', rid: null, course: ''
    };
    wx.navigateTo({ url: '/pages/record/record' });
  },
  openStu(e) {
    wx.navigateTo({ url: '/pages/student/student?id=' + e.currentTarget.dataset.sid });
  },
  openRec(e) {
    wx.navigateTo({ url: '/pages/student/student?id=' + e.currentTarget.dataset.sid + '&rid=' + e.currentTarget.dataset.rid });
  }
});
