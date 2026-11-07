const db = require('../../utils/db');
const api = require('../../utils/api');
const sec = require('../../utils/sec');
const icons = require('../../utils/icons');
const theme = require('../../utils/theme');

// 班级详情页：学生「本次录入」三状态（未录/已录/已发布）+ 筛选；下方本班记录支持按课次、日期、等级筛选
// 三状态按【课次】算而不是自然日：同一节课两个老师分两天录，状态依然准确。
// 节点由老师手动「结清」推进，不要求全员录完（请假/缺席的直接略过）。
// 色块排序：未录入 > 已录入 > 已发布（未录入的排最前，提醒优先录入），同状态内保持姓氏拼音序
const TAGS = ['待提高', '加油', '良好', '优秀', '最佳'];
const ST_WEIGHT = { none: 0, rec: 1, sent: 2 };

Page({
  data: {
    cls: null,
    tiles: [], shown: [],
    counts: { none: 0, rec: 0, sent: 0 }, pending: 0,
    filts: [{ n: '全部', c: 0 }, { n: '未录入', c: 0 }, { n: '已录入', c: 0 }, { n: '已发布', c: 0 }], filt: '全部',
    // 记录筛选：课次 + 日期 + 等级
    sess: 1, sessOpts: ['不限课次'], sessIdx: 0,
    dateOpts: ['不限日期'], dateIdx: 0,
    tagOpts: ['全部等级'].concat(TAGS), tagIdx: 0,
    recs: [], recTotal: 0, allCount: 0,
    canSettle: false, hasCurRecs: false,
    icoChevD: icons.chevronDown, icoChev: icons.chevron
  },
  onLoad(q) {
    this.clsId = +q.id || 0;
  },
  onShow() { theme.apply(this); this.render(); },
  render() {
    const cls = db.classes.get(this.clsId);
    // 班级不在可见范围内时给出明确提示，而不是留一个白屏
    if (!cls) {
      wx.showToast({ title: '该班级不在你的管理范围', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 900);
      return;
    }
    wx.setNavigationBarTitle({ title: cls.name });
    // 本次录入 = 班级当前课次（session），不再按自然日
    const cur = Math.max(1, cls.session || 1);
    const students = db.students.of(this.clsId);
    const all = db.records.ofClass(this.clsId);
    // 本次课每名学生的记录 → 三状态
    const curRecs = {};
    all.forEach(r => {
      if (r.session !== cur) return;
      const arr = curRecs[r.sid] || (curRecs[r.sid] = []);
      arr.push(r);
    });
    const statusOf = sid => {
      const arr = curRecs[sid];
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
    // 本次待发布记录数（已录入但未发布）
    const pending = all.filter(r => r.session === cur && !r.sent).length;
    // 结清按钮的显隐只看「本次课有没有记录」：下面班级记录里全是往期课次时，
    // 不该出现「结清本次课」——空课次没有可发布、可收尾的成果。
    const curCount = all.filter(r => r.session === cur).length;
    // 记录筛选：课次（从新到旧）+ 日期（从新到旧）
    const sesses = [...new Set(all.map(r => r.session).filter(s => s > 0))].sort((a, b) => b - a);
    const sessOpts = ['不限课次'].concat(sesses.map(s => '第' + s + '课'));
    const dates = [...new Set(all.map(r => r.date))].sort((a, b) => b.localeCompare(a));
    const dateOpts = ['不限日期'].concat(dates);
    this._all = all;
    // 统计直接融进筛选页签：「未录入 2」一眼看出各状态多少人，不再单独占一行
    const filts = [
      { n: '全部', c: tiles.length },
      { n: '未录入', c: counts.none },
      { n: '已录入', c: counts.rec },
      { n: '已发布', c: counts.sent }
    ];
    this.setData({
      cls: { id: cls.id, name: cls.name },
      sess: cur, sessOpts, tiles, counts, filts, dateOpts, pending,
      // 结清 = 开启下一课的节点动作，能往这个班录课的人才能做；
      // 且本次课至少录了 1 条才显示（历史课次的记录不算）
      canSettle: db.auth.can('record.create', { clsId: this.clsId }),
      hasCurRecs: curCount > 0,
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
  // 记录筛选：课次 + 日期 + 等级
  onSess(e) { this.setData({ sessIdx: +e.detail.value }, () => this._applyRecs()); },
  onDate(e) { this.setData({ dateIdx: +e.detail.value }, () => this._applyRecs()); },
  onTag(e) { this.setData({ tagIdx: +e.detail.value }, () => this._applyRecs()); },
  _applyRecs() {
    const sessV = this.data.sessOpts[this.data.sessIdx];
    const date = this.data.dateOpts[this.data.dateIdx];
    const tag = this.data.tagOpts[this.data.tagIdx];
    const list = this._all.filter(r =>
      (this.data.sessIdx === 0 || r.session === Number(sessV.replace(/[^0-9]/g, ''))) &&
      (this.data.dateIdx === 0 || r.date === date) &&
      (this.data.tagIdx === 0 || r.tag === tag)
    );
    const recs = list.slice(0, 50).map(r => {
      return { id: r.id, sid: r.sid, name: db.students.name(r.sid) || '—', course: r.course, date: r.date, score: r.score, tag: r.tag || '', sent: r.sent, sess: r.session || 0 };
    });
    this.setData({ recs, recTotal: list.length });
  },
  // 结清本次课：发布本次未发布的记录 + 进入下一课。不要求全员录完（请假/缺席直接略过）。
  sendAll() {
    if (!this.data.canSettle) {
      wx.showToast({ title: db.auth.denyReason('record.create'), icon: 'none' });
      return;
    }
    const cur = this.data.sess;
    const recs = db.records.ofClass(this.clsId).filter(r => r.session === cur);
    // 按钮已按本次记录数隐藏；这里再兜一层，防止旧渲染/外部调起把空课次白白推进
    if (!recs.length) {
      wx.showToast({ title: '本次课还没有录入记录', icon: 'none' });
      return;
    }
    const unSent = recs.filter(r => !r.sent).length;
    const unRec = this.data.counts.none;
    const parts = ['本次已录 ' + (recs.length ? this.data.counts.rec + this.data.counts.sent : 0) + ' 人'];
    if (unRec) parts.push('未录 ' + unRec + ' 人（请假/缺席将略过）');
    if (unSent) parts.push(unSent + ' 条将发布给家长');
    wx.showModal({
      title: '结清第 ' + cur + ' 次课？',
      content: parts.join('，') + '。结清后进入第 ' + (cur + 1) + ' 次课的录入。',
      confirmText: '结清',
      success: res => {
        if (!res.confirm) return;
        // 结清前记下要发布的清单：settle 成功后把这批推到云端（数据层不碰 api，推送归页面）
        const toPush = recs.filter(r => !r.sent).map(r => r.id);
        const out = db.records.settle(this.clsId);
        if (!out.ok) { wx.showToast({ title: out.msg || '结清失败，请重试', icon: 'none' }); return; }
        toPush.forEach(id => {
          const r = db.records.get(id);
          if (r && r.sent) api.pushRecord(r);
        });
        let tip = '已进入第 ' + out.session + ' 次课';
        if (out.sent) tip = '已发布 ' + out.sent + ' 条，' + tip;
        if (out.denied) tip += ('，' + out.denied + ' 条无权发布');
        wx.showToast({ title: tip, icon: out.denied ? 'none' : 'success' });
        // 触达已订阅的家长（未配模板/没人订阅时云端静默跳过，不阻塞结清主流程）
        const published = db.records.ofClass(this.clsId)
          .filter(r => r.session === cur && r.sent);
        if (out.sent || published.length) {
          api.familyNotify({ items: sec.itemsFromRecords(published, db.students.name, db.classes.name) });
        }
        this.render(); // 课次已推进，三状态/计数/筛选即时刷新
      }
    });
  },
  // 成绩单批量录入：全班一次补本次课（课后凭记忆/课堂照片批量处理的主入口）
  goBatch() {
    wx.navigateTo({ url: '/pages/batch/batch?id=' + this.clsId });
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
