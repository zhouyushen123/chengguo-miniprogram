// 模板面板：mode=select 多选插入留言 / mode=preview 通知文本预览；也承载模板管理（新增/编辑/删除/语音录入）
const db = require('../../utils/db');
const stt = require('../../utils/stt');
const icons = require('../../utils/icons');

Page({
  data: { mode: 'manage', groups: [], sel: [], previewText: '', addingIdx: -1,
    icoMic: icons.mic('#E8590C'), icoEdit: icons.edit, icoClose: icons.close, icoPlus: icons.plus('#E8590C') },
  onLoad(q) {
    this.mode = q.mode || 'manage';
    const pick = getApp().globalData.pick || {};
    this.sel = pick.tplSel || [];
    this.setData({ mode: this.mode, sel: this.sel.slice() });
    this.render();
    if (this.mode === 'preview') this.buildPreview();
  },
  onShow() { this.render(); },
  render() {
    const t = db.templates.list();
    this.setData({ groups: t.map((g, i) => ({ id: g.id, n: g.name, i, opts: g.options.map((o, j) => ({ o, j, on: this.sel.includes(i + ':' + j) })) })) });
  },
  toggleOpt(e) {
    const k = e.currentTarget.dataset.k;
    const i = this.sel.indexOf(k);
    if (i >= 0) this.sel.splice(i, 1); else this.sel.push(k);
    this.setData({ sel: this.sel.slice() });
    this.render();
  },
  // 保留选择并返回录入页（record 页 onShow 时读取 pick.tplSel 写入 note）
  confirmSel() {
    const pick = getApp().globalData.pick || (getApp().globalData.pick = {});
    pick.tplSel = this.sel.slice();
    const list = db.templates.list();
    const lines = this.sel.map(k => {
      const [d, j] = k.split(':').map(Number);
      const g = list[d];
      return g ? (g.name + '：' + g.options[j]) : '';
    }).filter(Boolean);
    pick.noteInsert = lines.join('\n');
    wx.navigateBack();
  },
  clearSel() { this.sel = []; this.setData({ sel: [] }); this.render(); },
  // —— 模板管理 ——
  addOpt(e) {
    const i = +e.currentTarget.dataset.i;
    const g = db.templates.list()[i];
    if (!g) return;
    wx.showModal({
      title: '新增「' + g.name + '」选项', editable: true, placeholderText: '输入选项内容',
      success: r => {
        if (!r.confirm || !r.content || !r.content.trim()) return;
        const res = db.templates.addOption(g.id, r.content.trim());
        if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
        this.render(); wx.showToast({ title: '已添加' });
      }
    });
  },
  editOpt(e) {
    const i = +e.currentTarget.dataset.i, j = +e.currentTarget.dataset.j;
    const g = db.templates.list()[i];
    if (!g) return;
    wx.showModal({
      title: '编辑选项', editable: true, content: g.options[j],
      success: r => {
        if (!r.confirm || !r.content || !r.content.trim()) return;
        const res = db.templates.updateOption(g.id, j, r.content.trim());
        if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
        this.render(); wx.showToast({ title: '已修改' });
      }
    });
  },
  delOpt(e) {
    const i = +e.currentTarget.dataset.i, j = +e.currentTarget.dataset.j;
    const g = db.templates.list()[i];
    if (!g) return;
    wx.showModal({
      title: '删除该选项？', success: r => {
        if (!r.confirm) return;
        const res = db.templates.removeOption(g.id, j);
        if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
        // 选中项随删除位移：同维度中被删项之后的整体前移一位
        this.sel = this.sel.filter(k => k !== i + ':' + j).map(k => {
          const p = k.split(':'), d = +p[0], o = +p[1];
          return (d === i && o > j) ? (d + ':' + (o - 1)) : k;
        });
        this.setData({ sel: this.sel.slice() });
        this.render(); wx.showToast({ title: '已删除' });
      }
    });
  },
  // 语音录入新选项：接入「微信同声传译」插件后，说话内容自动成为该维度的新选项
  voiceOpt(e) {
    const i = +e.currentTarget.dataset.i;
    const g = db.templates.list()[i];
    if (!g) return;
    if (!stt.available()) { wx.showToast({ title: '需配置同声传译插件，详见 README', icon: 'none', duration: 2500 }); return; }
    if (this.recog) { this.recog.stop(); return; }
    this.setData({ addingIdx: i });
    this.recog = stt.createRecognizer({
      onDone: t => {
        this.recog = null; this.setData({ addingIdx: -1 });
        if (!t) return;
        const res = db.templates.addOption(g.id, t);
        this.render();
        wx.showToast({ title: res.ok ? ('已加入「' + g.name + '」') : res.msg, icon: 'none' });
      },
      onError: () => { this.recog = null; this.setData({ addingIdx: -1 }); wx.showToast({ title: '识别失败，请重试', icon: 'none' }); }
    });
    this.recog.start();
  },
  // —— 通知文本预览 ——
  buildPreview() {
    const pick = getApp().globalData.pick || {};
    const s = db.students.get(pick.sid);
    const lines = (pick.note || '').split('\n').filter(Boolean).map(l => '· ' + l);
    const txt = `【橙果·课后成果】${s ? s.name : '—'} 同学今天的${db.classes.name(pick.cls)}·${pick.course || ''}课成果：${pick.score}分${pick.tag ? '（' + pick.tag + '）' : ''}\n${lines.join('\n')}`;
    this.setData({ previewText: txt });
  },
  copyPreview() {
    wx.setClipboardData({ data: this.data.previewText, success: () => wx.showToast({ title: '已复制，可发给家长', icon: 'none' }) });
  }
});
