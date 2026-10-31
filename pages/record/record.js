const store = require('../../utils/store');
const api = require('../../utils/api');
const stt = require('../../utils/stt');

Page({
  data: {
    clsId: null, students: [], courses: [], courseIdx: 0, course: '',
    score: 85, tags: ['待提高', '良好', '优秀'], tag: '',
    note: '', photos: [], audio: null, recording: false, recognizing: false, canSend: false,
    selCount: 0, editing: false
  },
  onLoad(q) {
    const pick = getApp().globalData.pick || {};
    const db = store.get();
    const clsId = pick.cls || (db.classes[0] && db.classes[0].id);
    const courses = store.coursesOf(clsId);
    this.setData({
      clsId, students: store.studentsOf(clsId), courses,
      course: courses[0] ? courses[0].name : '',
      sid: pick.sid || null, score: pick.score || 85, tag: pick.tag || '',
      note: pick.note || '', photos: pick.photos || [], audio: pick.audio || null,
      rid: pick.rid || null, editing: !!pick.rid
    });
    this.refreshCan();
  },
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
  // 拍照 / 相册：wx.chooseMedia 二合一
  addMedia(e) {
    const src = e.currentTarget.dataset.src; // camera | album
    wx.chooseMedia({
      count: src === 'camera' ? 1 : 9,
      mediaType: ['image'],
      sourceType: [src],
      sizeType: ['compressed'],
      success: r => {
        const photos = this.data.photos.concat(r.tempFiles.map(f => f.tempFilePath));
        this.setData({ photos: photos.slice(0, 9) });
        this.refreshCan();
      }
    });
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
  goTplsSel() { wx.navigateTo({ url: '/pages/tpls/tpls?mode=select' }); }
});
