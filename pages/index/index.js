const db = require('../../utils/db');
const api = require('../../utils/api');
const icons = require('../../utils/icons');

Page({
  data: {
    isParent: false, kids: [],
    roleLabel: '', uName: '', dateStr: '',
    q: '', results: [], moreCount: 0,
    clsCount: 0, stuCount: 0, pending: 0,
    myClasses: [], recent: [],
    icoSearch: icons.search, icoClose: icons.close, icoChev: icons.chevron
  },
  onShow() {
    const u = db.users.current() || { role: 'teacher', name: '' };
    const d = new Date();
    const dateStr = (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + '日一二三四五六'[d.getDay()];
    // 身份与数据范围统一由权限层给出：下面拿到的 list 已经是过滤后的结果，
    // 页面不再自己写 role/clsIds 判断（那种写法漏一处就是越权）
    const isParent = db.auth.isParent();

    if (isParent) {
      const kids = db.students.list().map(s => {
        const r = db.records.latest(s.id);
        return { id: s.id, name: s.name, latest: r ? (r.course + ' · ' + r.score + '分 · ' + r.date) : '暂无记录' };
      });
      this.setData({ isParent: true, kids, roleLabel: '家长端', uName: u.name, dateStr });
      return;
    }

    const vis = db.classes.list();
    const stu = db.students.list();
    const t = db.today();
    const recs = db.records.list();
    const recOf = s => recs.filter(r => r.sid === s.id);
    const notToday = s => !recOf(s).some(r => r.date === t);

    const myClasses = vis.map(c => {
      const cs = db.students.of(c.id);
      return { id: c.id, name: c.name, count: cs.length, pending: cs.some(notToday) };
    });
    const recent = recs.slice(0, 5).map(r => ({
      id: r.id, sid: r.sid, name: db.students.name(r.sid) || '—',
      clsName: db.classes.name(r.cid), date: r.date,
      sd: (r.date || '').slice(5), score: r.score,
      ci: Math.max(0, vis.findIndex(c => c.id === r.cid)) % 3
    }));

    const label = { parent: '家长端', admin: '管理员端' }[db.auth.role()] || '老师端';
    this.setData({
      isParent: false,
      roleLabel: label,
      uName: u.name || db.settings().teacher,
      dateStr,
      clsCount: vis.length, stuCount: stu.length,
      pending: stu.filter(notToday).length,
      myClasses, recent
    });
  },
  onSearch(e) {
    // 模糊搜索：输入单字（如"周"）即可匹配所有名字中含该字的学生
    const q = (e.detail.value || '').trim().replace(/\s+/g, '');
    const LIMIT = 20;
    let results = [], moreCount = 0;
    if (q) {
      const hit = db.students.search(q);
      results = hit.slice(0, LIMIT).map(s => ({
        id: s.id, name: s.name,
        meta: (s.clsIds || []).map(db.classes.name).join(' · ') || '未分班',
        ci: s.id % 3
      }));
      moreCount = Math.max(0, hit.length - LIMIT);
    }
    this.setData({ q, results, moreCount });
  },
  clearSearch() { this.setData({ q: '', results: [], moreCount: 0 }); },
  goRecord() {
    // 进入录入页前给一个默认班级（已在可见范围内），避免无权限班被当默认值传下去
    const vis = db.classes.list();
    getApp().globalData.pick = { cls: vis[0] ? vis[0].id : null, sid: null, score: 85, photos: [], audio: null, tag: '', note: '', rid: null, course: '' };
    wx.navigateTo({ url: '/pages/record/record' });
  },
  goRecords() { wx.switchTab({ url: '/pages/records/records' }); },
  goCls(e) { wx.navigateTo({ url: '/pages/cls/cls?id=' + e.currentTarget.dataset.id }); },
  goMgr() { wx.switchTab({ url: '/pages/mgr/mgr' }); },
  openRec(e) { wx.navigateTo({ url: '/pages/student/student?rid=' + e.currentTarget.dataset.rid + '&sid=' + e.currentTarget.dataset.sid }); },
  goStudent(e) {
    wx.navigateTo({ url: '/pages/student/student?id=' + e.currentTarget.dataset.sid });
    this.setData({ q: '', results: [], moreCount: 0 });
  },
  onPullDownRefresh() {
    api.pull().then(d => { if (d) db.merge(d); this.onShow(); wx.stopPullDownRefresh(); })
      .catch(() => wx.stopPullDownRefresh());
  }
});
