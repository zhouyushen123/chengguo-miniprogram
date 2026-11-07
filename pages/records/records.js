const db = require('../../utils/db');
const api = require('../../utils/api');
const sec = require('../../utils/sec');
const icons = require('../../utils/icons');
const theme = require('../../utils/theme');

// 筛选梯度：班级 → 录入日期 → 成果等级
// 上一层变化会重算下一层的可选项：选了班级，日期只列该班有记录的日期；选了日期，等级只列该批记录中出现过的等级
const TAGS = ['待提高', '加油', '良好', '优秀', '最佳'];

Page({
  data: {
    tabs: [], tab: 0, role: 'teacher',
    missMode: false, missList: [],
    termOpts: ['全部学期'], termIdx: 0,
    dateOpts: ['不限日期'], dateIdx: 0,
    tagOpts: ['全部等级'].concat(TAGS), tagIdx: 0,
    list: [], total: 0, allCount: 0,
    icoChevD: icons.chevronDown, icoCamera: icons.camera, icoAudio: icons.audio
  },
  onLoad(q) {
    // 首页「本次未录入」卡直达：?miss=1 进页面就落在「今天未录」视图（B-06）
    if (q && q.miss) this._missWant = true;
  },
  onShow() {
    theme.apply(this); // 主题：根类名 + 图标 + 原生 chrome
    // 页签与班级 id 一一对应（tabIds[0] = null 表示「全部」）。
    // 以前是「按班级名反查 id」，遇到两个同名班（"书法班"跨学期重名很常见）会串到别的班去。
    const cls = db.classes.list();
    const tabs = ['全部'].concat(cls.map(c => c.name));
    const tabIds = [null].concat(cls.map(c => c.id));
    // 从首页班级卡跳入：定位到对应班级页签（首页传的是名字，按 id 再校准一次）
    const preset = getApp().globalData.recTab;
    let tab = this.data.tab;
    if (preset) {
      const i = tabs.indexOf(preset);
      if (i > 0) tab = i;
      getApp().globalData.recTab = null;
    }
    this.setData({ tabs, tabIds, tab: Math.min(tab, tabs.length - 1), role: db.auth.role() });
    // 首页「本次未录入」卡进来：落在今天未录视图（switchTab 不能带参，走 globalData）
    if (getApp().globalData.recMiss) {
      getApp().globalData.recMiss = false;
      this.setData({ missMode: true });
      this.buildMiss();
      return;
    }
    if (this._missWant) { this._missWant = false; this.setData({ missMode: true }); this.buildMiss(); return; }
    if (this.data.missMode) this.buildMiss();
    this.refresh();
  },
  // 今天未录视图：口径与首页 pending 一致——学生所在班已开课（有课次），
  // 但本课次还没有他/她的记录。班级页签（tab）继续生效：选中某个班就看那个班的。
  pickMiss() {
    const m = !this.data.missMode;
    this.setData({ missMode: m });
    if (m) this.buildMiss(); else this.refresh();
  },
  buildMiss() {
    const cid = (this.data.tabIds || [])[this.data.tab];
    const recs = db.records.list();
    const list = [];
    db.classes.list().forEach(c => {
      if (cid && c.id !== cid) return;
      const sess = Math.max(1, c.session || 1);
      db.students.of(c.id).forEach(s => {
        if (recs.some(r => r.sid === s.id && r.cid === c.id && r.session === sess)) return;
        list.push({ key: s.id + '-' + c.id, sid: s.id, cid: c.id, name: s.name, clsName: c.name, session: sess });
      });
    });
    this.setData({ missList: list });
  },
  // 从未录名单直达录入页：班级与学生都预选好，录完返回列表自动重算
  goMissRec(e) {
    getApp().globalData.pick = { sid: +e.currentTarget.dataset.sid, cls: +e.currentTarget.dataset.cid };
    wx.navigateTo({ url: '/pages/record/record' });
  },
  // 第一层（班级）过滤。身份权限已由数据层在 list() 里按可见范围过滤过，
  // 页面只做业务维度筛选，不再重复写 role/clsIds 判断。
  // 第零层（学期）过滤：班级挂了学期，按班级的学期归属筛
  _pool() {
    const cid = (this.data.tabIds || [])[this.data.tab];
    const termId = this.data.termIdx > 0 ? ((this.data._terms || [])[this.data.termIdx - 1] || {}).id : null;
    return db.records.list().filter(r => {
      if (cid && r.cid !== cid) return false;
      if (termId) {
        const rc = db.classes.get(r.cid);
        if (!rc || rc.termId !== termId) return false;
      }
      return true;
    });
  },
  refresh() {
    const terms = db.terms.list();
    const termOpts = ['全部学期'].concat(terms.map(t => t.name));
    let termIdx = this.data.termIdx >= termOpts.length ? 0 : this.data.termIdx;
    const pool = this._pool();
    const allCount = pool.length;
    // 第二层：日期选项 = 当前班级下有记录的日期（从新到旧）
    const dates = [...new Set(pool.map(r => r.date).filter(Boolean))].sort((a, b) => b.localeCompare(a));
    const dateOpts = ['不限日期'].concat(dates);
    let dateIdx = this.data.dateIdx >= dateOpts.length ? 0 : this.data.dateIdx;
    // 第三层：等级选项 = 当前班级 + 日期下实际出现过的等级（只列存在的，避免选了筛不出东西）
    const stage2 = pool.filter(r => dateIdx === 0 || r.date === dateOpts[dateIdx]);
    const tags = TAGS.filter(t => stage2.some(r => r.tag === t));
    const tagOpts = ['全部等级'].concat(tags);
    let tagIdx = this.data.tagIdx >= tagOpts.length ? 0 : this.data.tagIdx;
    const list = stage2
      .filter(r => tagIdx === 0 || r.tag === tagOpts[tagIdx])
      .map(r => {
        const s = { name: db.students.name(r.sid) || '—' };
        // 按钮按这条记录的实际权限渲染：老师只能改自己录的，就不必让他点进去才被拦
        return {
          id: r.id, sid: r.sid, name: s.name, course: r.course, date: r.date, score: r.score, tag: r.tag,
          sent: r.sent, note: (r.note || '').split('\n')[0],
          photoCount: (r.photos || []).length, hasAudio: !!r.audio,
          photo: (r.photos || [])[0] || '',
          canEdit: db.auth.can('record.update', { record: r }),
          canSend: db.auth.can('record.send', { record: r })
        };
      });
    this.setData({ _terms: terms, termOpts, termIdx, dateOpts, dateIdx, tagOpts, tagIdx, list, total: list.length, allCount });
    // 录完回来 / 下拉刷新时，未录名单跟着重算（不然刚录完的人还挂在名单上）
    if (this.data.missMode) this.buildMiss();
  },
  // 学期变化：下层筛选全部归位
  onTerm(e) {
    this.setData({ termIdx: +e.detail.value, dateIdx: 0, tagIdx: 0 });
    this.refresh();
  },
  // 班级变化：下层筛选全部归位
  pickTab(e) {
    this.setData({ tab: +e.currentTarget.dataset.i, dateIdx: 0, tagIdx: 0, missMode: false });
    this.refresh();
  },
  // 日期变化：等级归位
  onDate(e) {
    this.setData({ dateIdx: +e.detail.value, tagIdx: 0 });
    this.refresh();
  },
  onTag(e) {
    this.setData({ tagIdx: +e.detail.value });
    this.refresh();
  },
  openRec(e) { wx.navigateTo({ url: '/pages/student/student?rid=' + e.currentTarget.dataset.rid + '&id=' + e.currentTarget.dataset.sid }); },
  editRec(e) {
    const r = db.records.get(e.currentTarget.dataset.rid);
    if (!r) return;
    // 权限统一判定：家长只读；老师只能改自己录的（负责人/管理员不受限）
    if (!db.auth.can('record.update', { record: r })) {
      wx.showToast({ title: db.auth.denyReason('record.update'), icon: 'none' });
      return;
    }
    getApp().globalData.pick = {
      cls: r.cid, sid: r.sid, score: r.score, photos: r.photos || [], videos: r.videos || [], audio: r.audio,
      tag: r.tag || '', note: r.note || '', rid: r.id, course: r.course, sent: !!r.sent
    };
    wx.navigateTo({ url: '/pages/record/record' });
  },
  // 单条发布：已发布的记录按钮置灰不可再点
  sendRec(e) {
    const r = db.records.get(e.currentTarget.dataset.rid);
    if (!r || r.sent) return;
    if (!db.auth.can('record.send', { record: r })) {
      wx.showToast({ title: db.auth.denyReason('record.send'), icon: 'none' });
      return;
    }
    const s = db.students.get(r.sid) || { name: db.students.name(r.sid) || '学生' };
    wx.showModal({
      title: '发布到家长端',
      content: '将把 ' + s.name + ' ' + (r.date || '') + ' 的这条成果记录对家长开放可见，确认发布？',
      confirmText: '发布',
      success: res => {
        if (!res.confirm) return;
        const out = db.records.markSent([r.id]);
        if (!out.count) { wx.showToast({ title: '该记录不在你的发布范围', icon: 'none' }); return; }
        api.pushRecord(Object.assign({}, r, { sent: true }));
        // 触达已订阅的该生家长（未配模板/没人订阅时云端静默跳过）
        api.familyNotify({ items: sec.itemsFromRecords([Object.assign({}, r, { sent: true })], db.students.name, db.classes.name) });
        wx.showToast({ title: '已发布', icon: 'success' });
        this.refresh();
      }
    });
  }
});
