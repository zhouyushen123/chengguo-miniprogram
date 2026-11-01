const store = require('../../utils/store');
const api = require('../../utils/api');
const icons = require('../../utils/icons');

Page({
  data: {
    isParent: false, kids: [],
    roleLabel: '', uName: '', dateStr: '',
    q: '', results: [], moreCount: 0,
    clsCount: 0, stuCount: 0, pending: 0,
    myClasses: [], recent: [],
    icoSearch: icons.search
  },
  onShow() {
    const db = store.get();
    const u = db.users.find(x => x.id === db.me) || db.users[0];
    const d = new Date();
    const dateStr = (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + '日一二三四五六'[d.getDay()];

    if (u.role === 'parent') {
      const kids = db.students
        .filter(s => !(u.studentIds || []).length || (u.studentIds || []).includes(s.id))
        .map(s => {
          const r = store.latestRecord(s.id);
          return { id: s.id, name: s.name, latest: r ? (r.course + ' · ' + r.score + '分 · ' + r.date) : '暂无记录' };
        });
      this.setData({ isParent: true, kids, roleLabel: '家长端', uName: u.name, dateStr });
      return;
    }

    // 老师按"负责班级"过滤；未分配则看全部（管理员看全部）
    const vis = (u.clsIds || []).length ? db.classes.filter(c => u.clsIds.includes(c.id)) : db.classes;
    const visIds = vis.map(c => c.id);
    const stu = db.students.filter(s => (s.clsIds || []).some(id => visIds.includes(id)));
    const t = store.today();
    const recOf = s => db.records.filter(r => r.sid === s.id).sort((a, b) => b.id - a.id);
    const notToday = s => !recOf(s).some(r => r.date === t);

    const myClasses = vis.map(c => {
      const cs = db.students.filter(s => (s.clsIds || []).includes(c.id));
      return { id: c.id, name: c.name, count: cs.length, pending: cs.some(notToday) };
    });
    const recent = db.records
      .filter(r => visIds.includes(r.cid))
      .sort((a, b) => b.id - a.id)
      .slice(0, 5)
      .map(r => {
        const s = store.student(r.sid) || { name: '—' };
        return {
          id: r.id, name: s.name, clsName: store.clsName(r.cid), date: r.date,
          sd: (r.date || '').slice(5), score: r.score,
          ci: Math.max(0, vis.findIndex(c => c.id === r.cid)) % 3
        };
      });

    this.setData({
      isParent: false,
      roleLabel: u.role === 'admin' ? '管理员端' : '老师端',
      uName: u.name || db.teacher,
      dateStr,
      clsCount: vis.length, stuCount: stu.length,
      pending: stu.filter(notToday).length,
      myClasses, recent
    });
  },
  onSearch(e) {
    // 模糊搜索：输入单字（如"周"）即可匹配所有名字中含该字的学生
    const q = (e.detail.value || '').trim().replace(/\s+/g, '');
    const db = store.get();
    const LIMIT = 20;
    let results = [], moreCount = 0;
    if (q) {
      const hit = db.students.filter(s => s.name.indexOf(q) > -1);
      results = hit.slice(0, LIMIT).map(s => ({
        id: s.id, name: s.name,
        meta: (s.clsIds || []).map(store.clsName).join(' · ') || '未分班',
        ci: s.id % 3
      }));
      moreCount = Math.max(0, hit.length - LIMIT);
    }
    this.setData({ q, results, moreCount });
  },
  clearSearch() { this.setData({ q: '', results: [], moreCount: 0 }); },
  goRecord() {
    const db = store.get();
    const u = db.users.find(x => x.id === db.me) || db.users[0];
    const vis = (u.clsIds || []).length ? db.classes.filter(c => u.clsIds.includes(c.id)) : db.classes;
    getApp().globalData.pick = { cls: vis[0] ? vis[0].id : null, sid: null, score: 85, photos: [], audio: null, tag: '', note: '', rid: null, course: '' };
    wx.navigateTo({ url: '/pages/record/record' });
  },
  goRecords() { wx.switchTab({ url: '/pages/records/records' }); },
  goCls(e) {
    getApp().globalData.recTab = e.currentTarget.dataset.name;
    this.goRecords();
  },
  goMgr() { wx.switchTab({ url: '/pages/mgr/mgr' }); },
  openRec(e) { wx.navigateTo({ url: '/pages/student/student?rid=' + e.currentTarget.dataset.rid }); },
  goStudent(e) {
    wx.navigateTo({ url: '/pages/student/student?id=' + e.currentTarget.dataset.sid });
    this.setData({ q: '', results: [], moreCount: 0 });
  },
  onPullDownRefresh() {
    api.pull().then(d => { if (d) store.replaceDb(d); this.onShow(); wx.stopPullDownRefresh(); })
      .catch(() => wx.stopPullDownRefresh());
  }
});
