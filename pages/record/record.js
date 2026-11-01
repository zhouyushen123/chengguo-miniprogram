const store = require('../../utils/store');
const api = require('../../utils/api');
const stt = require('../../utils/stt');
const icons = require('../../utils/icons');

// 媒体限制：单个文件 50MB，视频最多 3 个，照片最多 9 张
const MAX_FILE = 50 * 1024 * 1024;
const MAX_PHOTOS = 9;
const MAX_VIDEOS = 3;

// 评分五档阶梯：待提高（最差）→ 加油（稍差）→ 良好 → 优秀 → 最佳
// anchor 为点击该档时自动填入的代表分
const TAGS = [
  { t: '待提高', anchor: 60 },
  { t: '加油', anchor: 75 },
  { t: '良好', anchor: 85 },
  { t: '优秀', anchor: 92 },
  { t: '最佳', anchor: 98 }
];

Page({
  data: {
    clsId: null, students: [], stuShow: [], stuQuery: '', stuExpanded: false, over45: false,
    courses: [], courseIdx: 0, course: '',
    score: 85, tags: TAGS, tag: '',
    note: '', photos: [], videos: [], audio: null, recording: false, recognizing: false, canSend: false,
    selCount: 0, editing: false,
    tplOpen: false, tplList: [], sel: [],
    icoCamera: icons.camera, icoAlbum: icons.album, icoAudio: icons.audio,
    icoOrange: icons.mic('#E8590C'),
    icoWhite: icons.mic('#FFFFFF')
  },
  onLoad(q) {
    const pick = getApp().globalData.pick || {};
    const db = store.get();
    const clsId = pick.cls || (db.classes[0] && db.classes[0].id);
    const courses = store.coursesOf(clsId);
    const students = store.studentsOf(clsId); // 已按姓氏拼音排序
    this.setData({
      clsId, students, courses,
      over45: students.length > 45,
      course: courses[0] ? courses[0].name : '',
      sid: pick.sid || null, score: pick.score || 85, tag: pick.tag || '',
      note: pick.note || '', photos: pick.photos || [], videos: pick.videos || [], audio: pick.audio || null,
      rid: pick.rid || null, editing: !!pick.rid
    });
    this._applyStuFilter();
    this.refreshCan();
  },
  // 学生选择区：默认只展示 45 人，超出部分折叠；搜索时在全体中匹配
  _applyStuFilter() {
    const q = (this.data.stuQuery || '').trim();
    let list = this.data.students;
    if (q) {
      list = list.filter(s => s.name.indexOf(q) > -1);
    } else if (!this.data.stuExpanded) {
      list = list.slice(0, 45);
    }
    // 已选中的学生始终可见
    if (this.data.sid && !list.some(s => s.id === this.data.sid)) {
      const sel = this.data.students.find(s => s.id === this.data.sid);
      if (sel) list = [sel].concat(list);
    }
    this.setData({ stuShow: list });
  },
  onStuQuery(e) { this.setData({ stuQuery: e.detail.value }); this._applyStuFilter(); },
  toggleStuExpand() { this.setData({ stuExpanded: !this.data.stuExpanded }); this._applyStuFilter(); },
  onShow() {
    // 从模板页返回：应用所选模板与语音状态
    const pick = getApp().globalData.pick;
    if (pick && pick.noteInsert) {
      const add = pick.noteInsert;
      this.setData({ note: (this.data.note ? this.data.note.replace(/\s+$/, '') + '\n' : '') + add });
      pick.noteInsert = '';
      pick.tplSel = [];
    }
    if (pick) this.setData({ selCount: (pick.tplSel || []).length });
    this.refreshCan();
  },
  refreshCan() {
    this.setData({ canSend: store.canSend(this.data) });
  },
  pickStu(e) { this.setData({ sid: e.currentTarget.dataset.sid }); this.refreshCan(); },
  onScore(e) { this.setData({ score: e.detail.value }); },
  pickTag(e) { this.setData({ tag: e.currentTarget.dataset.t }); },
  onCourse(e) {
    const c = this.data.courses[e.detail.value];
    this.setData({ courseIdx: e.detail.value, course: c ? c.name : '' });
  },
  onNote(e) { this.setData({ note: e.detail.value }); this.refreshCan(); },
  goTpls() { wx.navigateTo({ url: '/pages/tpls/tpls?mode=select' }); },
  // 拍摄 / 相册：均支持照片与小视频（同微信），单文件上限 50MB
  addMedia(e) {
    const src = e.currentTarget.dataset.src; // camera | album
    const left = MAX_PHOTOS - this.data.photos.length + MAX_VIDEOS - this.data.videos.length;
    if (left <= 0) { wx.showToast({ title: '最多 ' + MAX_PHOTOS + ' 张照片 + ' + MAX_VIDEOS + ' 个视频', icon: 'none' }); return; }
    wx.chooseMedia({
      count: src === 'camera' ? 1 : Math.min(9, left),
      mediaType: ['image', 'video'],
      sourceType: [src],
      sizeType: ['compressed'],
      maxDuration: 60,
      camera: 'back',
      success: r => {
        const photos = this.data.photos.slice(), videos = this.data.videos.slice();
        let over = 0;
        (r.tempFiles || []).forEach(f => {
          if ((f.size || 0) > MAX_FILE) { over++; return; }
          if (f.fileType === 'video' || /\.mp4$/i.test(f.tempFilePath || '')) videos.push(f.tempFilePath);
          else photos.push(f.tempFilePath);
        });
        if (over) wx.showToast({ title: '单个文件需小于 50MB，已跳过 ' + over + ' 个', icon: 'none' });
        this.setData({ photos: photos.slice(0, MAX_PHOTOS), videos: videos.slice(0, MAX_VIDEOS) });
        this.refreshCan();
      }
    });
  },
  rmVideo(e) {
    const i = e.currentTarget.dataset.i;
    const videos = this.data.videos.slice();
    videos.splice(i, 1);
    this.setData({ videos });
    this.refreshCan();
  },
  rmPhoto(e) {
    const i = e.currentTarget.dataset.i;
    const photos = this.data.photos.slice();
    photos.splice(i, 1);
    this.setData({ photos });
    this.refreshCan();
  },
  previewPhoto(e) { wx.previewImage({ urls: this.data.photos, current: this.data.photos[e.currentTarget.dataset.i] }); },
  // 留言条麦克风：优先语音转文字（同声传译插件），识别结果写入留言可手动修改；
  // 插件不可用时降级为录音（MediaRecorder 等价物），语音作为附件随记录发送
  toggleRec() {
    if (this.data.recognizing) { this.recog.stop(); return; }
    if (stt.available()) {
      this.recog = stt.createRecognizer({
        onPartial: t => { if (t) this.setData({ note: (this.data.note ? this.data.note.replace(/\s+$/, '') + '\n' : '') + t }); },
        onDone: t => {
          this.setData({ recognizing: false });
          if (t) { this.setData({ note: (this.data.note ? this.data.note.replace(/\s+$/, '') + '\n' : '') + t }); this.refreshCan(); }
          wx.showToast({ title: '已转成文字，可修改', icon: 'none' });
        },
        onError: () => { this.setData({ recognizing: false }); wx.showToast({ title: '识别失败，请重试或手输', icon: 'none' }); }
      });
      this.setData({ recognizing: true });
      this.recog.start();
      return;
    }
    if (this.data.recording) { this.rec.stop(); return; }
    this.rec = wx.getRecorderManager();
    this.rec.onStop(res => {
      this.setData({ recording: false });
      if (!res.tempFilePath) return;
      api.uploadFile(res.tempFilePath, 'audio').then(url => {
        this.setData({ audio: url || res.tempFilePath });
        this.refreshCan();
        wx.showToast({ title: '语音已录入', icon: 'success' });
      });
    });
    this.rec.onError(() => { this.setData({ recording: false }); wx.showToast({ title: '录音失败', icon: 'none' }); });
    this.rec.start({ format: 'mp3', duration: 60000 });
    this.setData({ recording: true });
  },
  playAudio() { if (this.data.audio) wx.createInnerAudioContext().src = this.data.audio; },
  rmAudio() { this.setData({ audio: null }); this.refreshCan(); },
  preview() {
    const d = this.data;
    wx.navigateTo({ url: '/pages/tpls/tpls?mode=preview' });
  },
  save(e) {
    const send = e.currentTarget.dataset.send === '1';
    const res = store.saveRecord(Object.assign({}, this.data), send);
    if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
    api.pushRecord(res.record); // 线上模式自动上推，本地模式静默跳过
    wx.showToast({ title: send ? '已发送' : '已存草稿', icon: 'success' });
    setTimeout(() => wx.navigateBack(), 800);
  },
  /* ================= 模板：页内全屏面板（多选/增删改） ================= */
  toggleTpl() {
    if (this.data.tplOpen) { this.setData({ tplOpen: false }); return; }
    const pick = getApp().globalData.pick || {};
    this._sel = (pick.tplSel || []).slice();
    this._tpl = store.tpls().map(t => ({ n: t.n, opts: t.opts.slice() }));
    this.setData({ tplOpen: true, tplList: this._render(), sel: this._sel, selCount: this._sel.length });
  },
  _render() {
    // WXML 不支持方法调用，选中态在此预计算
    return this._tpl.map((d, di) => ({
      n: d.n,
      opts: d.opts.map((t, oi) => ({ t, on: this._sel.indexOf(di + ':' + oi) >= 0 }))
    }));
  },
  _sync(extra) {
    const pick = getApp().globalData.pick || (getApp().globalData.pick = {});
    pick.tplSel = this._sel.slice();
    this.setData(Object.assign({ tplList: this._render(), sel: this._sel.slice(), selCount: this._sel.length }, extra || {}));
  },
  tplClose() { this.setData({ tplOpen: false }); },
  tplToggle(e) {
    const k = e.currentTarget.dataset.k, i = this._sel.indexOf(k);
    i >= 0 ? this._sel.splice(i, 1) : this._sel.push(k);
    this._sync();
  },
  tplAdd(e) {
    const di = e.currentTarget.dataset.di;
    wx.showModal({
      title: '新增选项 · ' + this._tpl[di].n, editable: true, placeholderText: '输入选项内容',
      success: r => {
        if (!r.confirm || !r.content || !r.content.trim()) return;
        this._tpl[di].opts.push(r.content.trim());
        this._saveTpls(); this._sync();
      }
    });
  },
  tplEdit(e) {
    const { di, oi } = e.currentTarget.dataset;
    wx.showModal({
      title: '编辑选项', editable: true, content: this._tpl[di].opts[oi],
      success: r => {
        if (!r.confirm || !r.content || !r.content.trim()) return;
        this._tpl[di].opts[oi] = r.content.trim();
        this._saveTpls(); this._sync();
      }
    });
  },
  tplDel(e) {
    const { di, oi } = e.currentTarget.dataset;
    wx.showModal({ title: '删除这个选项？', success: r => {
      if (!r.confirm) return;
      this._tpl[di].opts.splice(oi, 1);
      this._sel = this._sel.filter(k => k !== di + ':' + oi);
      this._saveTpls(); this._sync();
    } });
  },
  _saveTpls() { store.saveTpls(this._tpl.map(d => ({ n: d.n, opts: d.opts.slice() }))); },
  tplClear() { this._sel = []; this._sync(); },
  tplApply() {
    const sel = this._sel, byDim = {};
    sel.forEach(k => {
      const [di, oi] = k.split(':').map(Number);
      const opt = this._tpl[di] && this._tpl[di].opts[oi];
      if (opt) (byDim[di] = byDim[di] || []).push(opt);
    });
    const lines = Object.keys(byDim).sort((a, b) => a - b)
      .map(di => this._tpl[di].n + '：' + byDim[di].join('；'));
    const add = lines.join('\n');
    if (!add) { wx.showToast({ title: '请先勾选选项', icon: 'none' }); return; }
    this.setData({ note: (this.data.note ? this.data.note.replace(/\s+$/, '') + '\n' : '') + add, tplOpen: false });
    this.refreshCan();
    wx.showToast({ title: '已插入 ' + lines.length + ' 个维度', icon: 'none' });
  }
});
