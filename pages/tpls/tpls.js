// 模板面板：mode=select 多选插入留言 / mode=preview 通知文本预览；也承载模板管理（新增/编辑/删除/语音录入）
const store = require('../../utils/store');
const api = require('../../utils/api');
const stt = require('../../utils/stt');

Page({
  data: { mode: 'manage', groups: [], sel: [], previewText: '', addingIdx: -1 },
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
    const t = store.tpls();
    this.setData({ groups: t.map((g, i) => ({ n: g.n, i, opts: g.opts.map((o, j) => ({ o, j, on: this.sel.includes(i + ':' + j) })) })) });
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
    const lines = this.sel.map(k => { const [d, j] = k.split(':').map(Number); const g = store.tpls()[d]; return g.n + '：' + g.opts[j]; });
    pick.noteInsert = lines.join('\n');
    wx.navigateBack();
  },
  clearSel() { this.sel = []; this.setData({ sel: [] }); this.render(); },
  // —— 模板管理 ——
  addOpt(e) {
    const i = e.currentTarget.dataset.i;
    wx.showModal({
      title: '新增「' + store.tpls()[i].n + '」选项', editable: true, placeholderText: '输入选项内容',
      success: r => {
        if (r.confirm && r.content && r.content.trim()) {
          const t = store.tpls(); t[i].opts.push(r.content.trim());
          store.saveTpls(t); this.render(); wx.showToast({ title: '已添加' });
        }
      }
    });
  },
  editOpt(e) {
    const { i, j } = e.currentTarget.dataset;
    const old = store.tpls()[i].opts[j];
    wx.showModal({
      title: '编辑选项', editable: true, content: old,
      success: r => {
        if (r.confirm && r.content && r.content.trim()) {
          const t = store.tpls(); t[i].opts[j] = r.content.trim();
          store.saveTpls(t); this.render(); wx.showToast({ title: '已修改' });
        }
      }
    });
  },
  delOpt(e) {
    const { i, j } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除该选项？', success: r => {
        if (r.confirm) {
          const t = store.tpls(); t[i].opts.splice(j, 1);
          store.saveTpls(t);
          this.sel = this.sel.filter(k => k !== i + ':' + j);
          this.setData({ sel: this.sel.slice() });
          this.render(); wx.showToast({ title: '已删除' });
        }
      }
    });
  },
  // 语音录入新选项：接入「微信同声传译」插件后，说话内容自动成为该维度的新选项
  voiceOpt(e) {
    const i = e.currentTarget.dataset.i;
    if (!stt.available()) { wx.showToast({ title: '需配置同声传译插件，详见 README', icon: 'none', duration: 2500 }); return; }
    if (this.recog) { this.recog.stop(); return; }
    this.setData({ addingIdx: i });
    this.recog = stt.createRecognizer({
      onDone: t => {
        this.recog = null; this.setData({ addingIdx: -1 });
        if (t) {
          const ts = store.tpls(); ts[i].opts.push(t); store.saveTpls(ts);
          this.render(); wx.showToast({ title: '已加入「' + ts[i].n + '」', icon: 'none' });
        }
      },
      onError: () => { this.recog = null; this.setData({ addingIdx: -1 }); wx.showToast({ title: '识别失败，请重试', icon: 'none' }); }
    });
    this.recog.start();
  },
  // —— 通知文本预览 ——
  buildPreview() {
    const pick = getApp().globalData.pick || {};
    const db = store.get();
    const s = db.students.find(x => x.id === pick.sid);
    const lines = (pick.note || '').split('\n').filter(Boolean).map(l => '· ' + l);
    const txt = `【橙果·课后成果】${s ? s.name : '—'} 同学今天的${store.clsName(pick.cls)}·${pick.course || ''}课成果：${pick.score}分${pick.tag ? '（' + pick.tag + '）' : ''}\n${lines.join('\n')}`;
    this.setData({ previewText: txt });
  },
  copyPreview() {
    wx.setClipboardData({ data: this.data.previewText, success: () => wx.showToast({ title: '已复制，可发给家长', icon: 'none' }) });
  }
});
