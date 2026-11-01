const db = require('../../utils/db');
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
    const cls = db.classes.get(this.clsId);
    // 班级不在可见范围内时给出明确提示，而不是留一个白屏
    if (!cls) {
      wx.showToast({ title: '该班级不在你的管理范围', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 900);
      return;
    }
    wx.setNavigationBarTitle({ title: cls.name });
    const t = db.today();
    const students = db.students.of(this.clsId);
    const all = db.records.ofClass(this.clsId);
    // 今日该班每名学生的记录 → 三状态
    const today = {};
    all.forEach(r => {
      if (r.date !== t) return;
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
    const pending = all.filter(r => r.date === t && !r.sent).length;
    // 记录日期选项（从新到旧）
    const dates = [...new Set(all.map(r => r.date))].sort((a, b) => b.localeCompare(a));
    const dateOpts = ['不限日期'].concat(dates);
    this._all = all;
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
      return { id: r.id, sid: r.sid, name: db.students.name(r.sid) || '—', course: r.course, date: r.date, score: r.score, tag: r.tag || '', sent: r.sent };
    });
    this.setData({ recs, recTotal: list.length });
  },
  // 统一发送：把今日该班所有「已录入未发布」的记录发给家长
  sendAll() {
    const t = db.today();
    // 权限：只有能对这批记录执行"发送"的人才进得来（家长/无关老师直接挡回）
    const targets = db.records.ofClass(this.clsId).filter(r => r.date === t && !r.sent);
    if (!targets.length) { wx.showToast({ title: '今天没有待发送的记录', icon: 'none' }); return; }
    if (!db.auth.can('record.send', { record: targets[0] })) {
      wx.showToast({ title: db.auth.denyReason('record.send'), icon: 'none' });
      return;
    }
    wx.showModal({
      title: '统一发送给家长',
      content: '将把今天已录入的 ' + targets.length + ' 条成果记录发送给学生家长，确认发送？',
      confirmText: '发送',
      success: res => {
        if (!res.confirm) return;
        const out = db.records.markSent(targets.map(r => r.id));
        if (!out.count) { wx.showToast({ title: '没有可发送的记录', icon: 'none' }); return; }
        targets.forEach(r => api.pushRecord(Object.assign({}, r, { sent: true })));
        const tip = out.denied ? ('已发送 ' + out.count + ' 条，' + out.denied + ' 条无权发送') : ('已发送 ' + out.count + ' 条');
        wx.showToast({ title: tip, icon: out.denied ? 'none' : 'success' });
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
