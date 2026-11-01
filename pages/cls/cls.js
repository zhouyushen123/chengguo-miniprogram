const store = require('../../utils/store');
const api = require('../../utils/api');
const icons = require('../../utils/icons');

// 班级详情页：学生今日录入三状态（未录/已录/已发布）+ 筛选；下方本班记录支持按日期、等级筛选
// 色块排序：未录入 > 已录入 > 已发布（未录入的排最前，提醒优先录入），同状态内保持姓氏拼音序
const TAGS = ['待提高', '加油', '良好', '优秀', '最佳'];
const ST_WEIGHT = { none: 0, rec: 1, sent: 2 };

Page({
  data: {
    cls: null,
    tiles: [], shown: [],
    counts: { none: 0, rec: 0, sent: 0 }, pending: 0,
    filts: ['全部', '未录入', '已录入', '已发布'], filt: '全部',
    // 记录筛选：日期 + 等级
    dateOpts: ['不限日期'], dateIdx: 0,
    tagOpts: ['全部等级'].concat(TAGS), tagIdx: 0,
    recs: [], recTotal: 0, allCount: 0,
    icoChevD: icons.chevronDown, icoChev: icons.chevron
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
    // 今日该班每名学生的记录 → 三状态
    const today = {};
    db.records.forEach(r => {
      if (r.cid !== this.clsId || r.date !== t) return;
      const arr = today[r.sid] || (today[r.sid] = []);
      arr.push(r);
    });
    const statusOf = sid => {
      const arr = today[sid];
      if (!arr || !arr.length) return 'none';
      return arr.some(r => r.sent) ? 'sent' : 'rec';
    };
    const tiles = students.map(s => ({ id: s.id, name: s.name, st: statusOf(s.id) }))
      .sort((a, b) => ST_WEIGHT[a.st] - ST_WEIGHT[b.st]);
    const counts = {
      none: tiles.filter(x => x.st === 'none').length,
      rec: tiles.filter(x => x.st === 'rec').length,
      sent: tiles.filter(x => x.st === 'sent').length
    };
    // 今日待发送记录数（已录入但未发布）
    const pending = db.records.filter(r => r.cid === this.clsId && r.date === t && !r.sent).length;
    // 记录日期选项（从新到旧）
    const dates = [...new Set(db.records.filter(r => r.cid === this.clsId).map(r => r.date))].sort((a, b) => b.localeCompare(a));
    const dateOpts = ['不限日期'].concat(dates);
    this._all = db.records.filter(r => r.cid === this.clsId).sort((a, b) => b.id - a.id);
    this.setData({
      cls: { id: cls.id, name: cls.name },
      tiles, counts, dateOpts, pending,
      allCount: this._all.length
    }, () => { this._applyTiles(); this._applyRecs(); });
  },
  // 学生状态筛选
  pickFilt(e) {
    this.setData({ filt: e.currentTarget.dataset.f }, () => this._applyTiles());
  },
  _applyTiles() {
    const f = this.data.filt;
    const map = { '全部': null, '未录入': 'none', '已录入': 'rec', '已发布': 'sent' };
    const st = map[f];
    this.setData({ shown: st ? this.data.tiles.filter(x => x.st === st) : this.data.tiles });
  },
  // 记录筛选：日期 + 等级
  onDate(e) { this.setData({ dateIdx: +e.detail.value }, () => this._applyRecs()); },
  onTag(e) { this.setData({ tagIdx: +e.detail.value }, () => this._applyRecs()); },
  _applyRecs() {
    const date = this.data.dateOpts[this.data.dateIdx];
    const tag = this.data.tagOpts[this.data.tagIdx];
    const list = this._all.filter(r =>
      (this.data.dateIdx === 0 || r.date === date) &&
      (this.data.tagIdx === 0 || r.tag === tag)
    );
    const recs = list.slice(0, 50).map(r => {
      const s = store.student(r.sid) || { name: '—' };
      return { id: r.id, sid: r.sid, name: s.name, course: r.course, date: r.date, score: r.score, tag: r.tag || '', sent: r.sent };
    });
    this.setData({ recs, recTotal: list.length });
  },
  // 统一发送：把今日该班所有「已录入未发布」的记录发给家长
  sendAll() {
    const db = store.get();
    const t = store.today();
    const targets = db.records.filter(r => r.cid === this.clsId && r.date === t && !r.sent);
    if (!targets.length) { wx.showToast({ title: '今天没有待发送的记录', icon: 'none' }); return; }
    wx.showModal({
      title: '统一发送给家长',
      content: '将把今天已录入的 ' + targets.length + ' 条成果记录发送给学生家长，确认发送？',
      confirmText: '发送',
      success: res => {
        if (!res.confirm) return;
        targets.forEach(r => { r.sent = true; api.pushRecord(r); });
        store.save();
        wx.showToast({ title: '已发送 ' + targets.length + ' 条', icon: 'success' });
        this.render(); // 返回后色块绿变蓝、计数即时刷新
      }
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
  openRec(e) {
    wx.navigateTo({ url: '/pages/student/student?id=' + e.currentTarget.dataset.sid + '&rid=' + e.currentTarget.dataset.rid });
  }
});
