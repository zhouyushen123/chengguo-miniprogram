// feedback —— 家长反馈（已读回执 + 家长留言）
//
// 数据在云端两张专属表里（record_views / parent_notes），不在同步集合：
// 家长端不会全量拉到别家孩子的留言，老师端也只回自己可见班级的。
// 这页只做展示与「标记已处理」，权限判断全在 family 云函数（fail-closed）。
//
// 一期不推微信通知给老师（没有订阅额度、模板也没申请）：靠首页入口的红点触达。
const db = require('../../utils/db');
const api = require('../../utils/api');
const theme = require('../../utils/theme');

const fmt = ts => {
  const t = Number(ts) || 0;
  if (!t) return '';
  const d = new Date(t);
  const hh = ('0' + d.getHours()).slice(-2), mm = ('0' + d.getMinutes()).slice(-2);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hh + ':' + mm;
};

Page({
  data: {
    loading: true, err: '',
    notes: [], shown: [], unhandled: 0, total: 0,
    tabs: ['全部'], tabIds: [null], tab: 0
  },
  onLoad(q) {
    // 从班级页跳进来时定位到该班
    this._clsWant = Number(q && q.id) || 0;
  },
  onShow() {
    theme.apply(this);
    this.load();
  },
  load() {
    this.setData({ loading: true, err: '' });
    api.fbList('teacher').then(r => {
      if (!r || !r.ok) {
        this.setData({ loading: false, err: (r && r.msg) || '云端暂不可用，稍后再试' });
        return;
      }
      const rows = (r.notes || []).map(n => {
        const s = db.students.get(n.sid) || {};
        const clsIds = (s.clsIds || []).map(Number);
        return Object.assign({}, n, {
          clsIds,
          clsName: clsIds.map(id => db.classes.name(id)).filter(Boolean).join(' · '),
          time: fmt(n.createdAt)
        });
      });
      // 未处理的排前面，同组内按时间从新到旧
      rows.sort((a, b) => ((a.handled ? 1 : 0) - (b.handled ? 1 : 0)) || (b.createdAt - a.createdAt));
      // 班级页签只列真的有留言的班级：一排空页签点进去都是「暂无」，比没有还难用
      const used = [];
      rows.forEach(x => x.clsIds.forEach(id => { if (used.indexOf(id) < 0) used.push(id); }));
      const tabs = ['全部'].concat(used.map(id => db.classes.name(id) || '未分班'));
      const tabIds = [null].concat(used);
      let tab = this.data.tab;
      if (this._clsWant) {
        const i = tabIds.indexOf(this._clsWant);
        if (i > 0) tab = i;
        this._clsWant = 0;
      }
      tab = Math.min(tab, tabs.length - 1);
      this.setData({
        loading: false, notes: rows, unhandled: r.unhandled || 0, total: r.total || rows.length,
        tabs, tabIds, tab
      }, () => this._apply());
    });
  },
  _apply() {
    const cid = this.data.tabIds[this.data.tab];
    const shown = cid ? this.data.notes.filter(x => x.clsIds.indexOf(Number(cid)) > -1) : this.data.notes;
    this.setData({ shown });
  },
  pickTab(e) { this.setData({ tab: +e.currentTarget.dataset.i }, () => this._apply()); },
  markHandled(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    api.fbHandle(id).then(r => {
      if (!r || !r.ok) {
        wx.showToast({ title: (r && r.msg) || '操作失败，请重试', icon: 'none' });
        return;
      }
      const notes = this.data.notes.map(n => (n.id === id ? Object.assign({}, n, { handled: true }) : n));
      const left = notes.filter(n => !n.handled).length;
      this.setData({ notes, unhandled: left }, () => this._apply());
      wx.showToast({ title: '已标记处理', icon: 'success' });
    });
  }
});
