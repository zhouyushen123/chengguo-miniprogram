const db = require('../../utils/db');
const api = require('../../utils/api');
const icons = require('../../utils/icons');

Page({
  data: {
    isParent: false, kids: [], kidId: 0,
    kName: '', kCls: '', stats: null, kLatest: null, latestPhotos: [],
    kHistory: [], kCare: [],
    roleLabel: '', uName: '', dateStr: '',
    q: '', results: [], moreCount: 0,
    clsCount: 0, stuCount: 0, pending: 0,
    myClasses: [], recent: [],
    icoSearch: icons.search, icoClose: icons.close, icoChev: icons.chevron, icoCam: icons.camera
  },
  onShow() {
    const u = db.users.current() || { role: 'teacher', name: '' };
    const d = new Date();
    const dateStr = (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + '日一二三四五六'[d.getDay()];
    // 身份与数据范围统一由权限层给出：下面拿到的 list 已经是过滤后的结果，
    // 页面不再自己写 role/clsIds 判断（那种写法漏一处就是越权）
    const isParent = db.auth.isParent();

    if (isParent) {
      // 家长端首页：统计 + 最近一次详情 + 需要注意 + 历史列表（数据已经权限层过滤，只见已发布）
      const kids = db.students.list().map(s => ({ id: s.id, name: s.name, photo: s.photo || '' }));
      const kidId = kids.some(k => k.id === this.data.kidId) ? this.data.kidId : (kids[0] ? kids[0].id : 0);
      this.setData({ isParent: true, kids, kidId, roleLabel: '家长端', uName: u.name, dateStr });
      if (kidId) this.renderKid(kidId);
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
  /* ================= 家长端：孩子主页数据 ================= */
  // 评价分档配色：优秀/最佳绿、良好橙、加油/待提高蓝灰
  renderKid(sid) {
    const s = db.students.get(sid);
    if (!s) return;
    const GOOD = ['优秀', '最佳'], CARE = ['加油', '待提高'];
    const tcls = t => !t ? '' : GOOD.indexOf(t) > -1 ? 'good' : t === '良好' ? 'mid' : 'low';
    // 评价行拆分：维度名 + 正文（与 student 页一致）
    const parseLine = t => {
      const i = t.indexOf('：') > -1 ? t.indexOf('：') : t.indexOf(':');
      return i > -1
        ? { label: t.slice(0, i), text: t.slice(i + 1).replace(/^\s+/, '') }
        : { label: '', text: t };
    };
    const deco = r => {
      const lines = (r.note || '').split('\n').filter(Boolean).map(parseLine);
      const first = lines[0] || null;
      let snip = first ? (first.text || first.label) : '';
      if (snip.length > 16) snip = snip.slice(0, 16) + '…';
      return {
        id: r.id, course: r.course, tag: r.tag, tcls: tcls(r.tag),
        date: r.date, score: r.score, clsName: db.classes.name(r.cid),
        pcnt: (r.photos || []).length, snip, noteLines: lines
      };
    };
    const recs = db.records.ofStudent(sid);
    const daySet = {};
    recs.forEach(r => { daySet[r.date] = 1; });
    const stats = {
      lessons: recs.length,
      great: recs.filter(r => GOOD.indexOf(r.tag) > -1).length,
      days: Object.keys(daySet).length,
      care: recs.filter(r => CARE.indexOf(r.tag) > -1).length
    };
    const latest = recs[0] ? deco(recs[0]) : null;
    this.setData({
      kName: s.name,
      kPhoto: s.photo || '',
      kCls: (s.clsIds || []).map(db.classes.name).join(' · '),
      stats,
      kLatest: latest,
      latestPhotos: latest ? ((db.records.get(latest.id) || {}).photos || []).slice(0, 3) : [],
      kHistory: recs.slice(1).map(deco),
      // 需要注意：评价为加油/待提高的最近几次
      kCare: recs.filter(r => CARE.indexOf(r.tag) > -1).slice(0, 3).map(deco)
    });
  },
  pickKid(e) {
    const id = +e.currentTarget.dataset.id;
    this.setData({ kidId: id });
    this.renderKid(id);
  },
  goKidPage() { wx.navigateTo({ url: '/pages/student/student?id=' + this.data.kidId }); },
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
  // mgr 已从 tab 降为二级页，只能 navigateTo（switchTab 会静默失败）
  goMgr() { wx.navigateTo({ url: '/pages/mgr/mgr' }); },
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
