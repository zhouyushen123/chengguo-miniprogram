const db = require('../../utils/db');
const api = require('../../utils/api');
const icons = require('../../utils/icons');

// 筛选梯度：班级 → 录入日期 → 成果等级
// 上一层变化会重算下一层的可选项：选了班级，日期只列该班有记录的日期；选了日期，等级只列该批记录中出现过的等级
const TAGS = ['待提高', '加油', '良好', '优秀', '最佳'];

Page({
  data: {
    tabs: [], tab: 0, role: 'teacher',
    dateOpts: ['不限日期'], dateIdx: 0,
    tagOpts: ['全部等级'].concat(TAGS), tagIdx: 0,
    list: [], total: 0, allCount: 0,
    icoChevD: icons.chevronDown, icoCamera: icons.camera, icoAudio: icons.audio
  },
  onShow() {
    const tabs = ['全部'].concat(db.classes.list().map(c => c.name));
    // 从首页班级卡跳入：定位到对应班级页签
    const preset = getApp().globalData.recTab;
    let tab = this.data.tab;
    if (preset) {
      const i = tabs.indexOf(preset);
      if (i > 0) tab = i;
      getApp().globalData.recTab = null;
    }
    this.setData({ tabs, tab: Math.min(tab, tabs.length - 1), role: db.auth.role() });
    this.refresh();
  },
  // 第一层（班级）过滤。身份权限已由数据层在 list() 里按可见范围过滤过，
  // 页面只做业务维度筛选，不再重复写 role/clsIds 判断。
  _pool() {
    const t = this.data.tabs[this.data.tab];
    const cls = t === '全部' ? null : db.classes.list().find(c => c.name === t);
    const cid = cls ? cls.id : null;
    return db.records.list().filter(r => !cid || r.cid === cid);
  },
  refresh() {
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
    this.setData({ dateOpts, dateIdx, tagOpts, tagIdx, list, total: list.length, allCount });
  },
  // 班级变化：下层筛选全部归位
  pickTab(e) {
    this.setData({ tab: +e.currentTarget.dataset.i, dateIdx: 0, tagIdx: 0 });
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
      tag: r.tag || '', note: r.note || '', rid: r.id, course: r.course
    };
    wx.navigateTo({ url: '/pages/record/record' });
  },
  // 单条发送：已发送的记录按钮置灰不可再点
  sendRec(e) {
    const r = db.records.get(e.currentTarget.dataset.rid);
    if (!r || r.sent) return;
    if (!db.auth.can('record.send', { record: r })) {
      wx.showToast({ title: db.auth.denyReason('record.send'), icon: 'none' });
      return;
    }
    const s = db.students.get(r.sid) || { name: db.students.name(r.sid) || '学生' };
    wx.showModal({
      title: '发送给家长',
      content: '将把 ' + s.name + ' ' + (r.date || '') + ' 的这条成果记录发送给学生家长，确认发送？',
      confirmText: '发送',
      success: res => {
        if (!res.confirm) return;
        const out = db.records.markSent([r.id]);
        if (!out.count) { wx.showToast({ title: '该记录不在你的发送范围', icon: 'none' }); return; }
        api.pushRecord(Object.assign({}, r, { sent: true }));
        wx.showToast({ title: '已发送', icon: 'success' });
        this.refresh();
      }
    });
  }
});
