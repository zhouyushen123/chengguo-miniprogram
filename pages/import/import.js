// pages/import/import.js —— 学生批量导入
// 两条来源路：①文件表格（Excel/CSV/Word，微信聊天里的文件也算"线上表格"）
//            ②纸质名单拍照 → 云端 GLM-4V 识图
// 都汇成预览清单（可勾选）→ 选定班级 → 批量建档。班内重名默认不勾，避免重复导入。
const db = require('../../utils/db');
const theme = require('../../utils/theme');
const api = require('../../utils/api');
const roster = require('../../utils/roster');

Page({
  data: {
    step: 'pick',            // pick 选来源 | review 预览确认
    classes: [], clsIdx: 0,  // 导入到哪个班（必选：学生没班=看不见）
    srcLabel: '',            // 来源描述（文件名 / 「纸质名单照片」）
    list: [],                // [{name,gender,parent,on,dupe}]
    busy: false,
    result: null             // {ok, added, skippedDupes, failed}
  },

  onLoad() {
    theme.apply(this);
    if (!db.auth.can('student.write')) {
      wx.showToast({ title: db.auth.denyReason('student.write'), icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    // 只列当前身份能写学生的班（老师只能导进自班；管理员是全部）
    const a = db.auth.actor ? db.auth.actor() : null;
    const classes = db.classes.list().filter(c => !a || a.all || db.perms.canSeeClass(a, c.id));
    this.setData({ classes: classes.map(c => ({ id: c.id, name: c.name })) });
  },

  onCls(e) { this.setData({ clsIdx: +e.detail.value }); },

  _clsId() {
    const c = this.data.classes[this.data.clsIdx];
    return c ? c.id : 0;
  },

  // ---------- 来源 1：文件（聊天里的线上表格 / 本地 Excel CSV Word） ----------
  pickFile() {
    wx.chooseMessageFile({
      count: 1, type: 'file',
      extension: ['xlsx', 'xls', 'csv', 'docx', 'txt'],
      success: r => {
        const f = r.tempFiles && r.tempFiles[0];
        if (!f) return;
        if (f.size > 3 * 1024 * 1024) { wx.showToast({ title: '文件超过 3MB，请拆分后导入', icon: 'none' }); return; }
        this._readAndParse(f.path, f.name, 'parseFile', f.name);
      }
    });
  },

  // ---------- 来源 2：纸质名单拍照 ----------
  pickPhoto() {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'],
      success: r => {
        const f = r.tempFiles && r.tempFiles[0];
        if (!f) return;
        this._readAndParse(f.tempFilePath, 'photo.jpg', 'parsePhoto', '纸质名单照片');
      },
      fail: err => {
        if (err && err.errMsg && err.errMsg.indexOf('cancel') === -1) {
          wx.showToast({ title: '照片获取失败', icon: 'none' });
        }
      }
    });
  },

  // 读文件 → base64 → 云函数解析 → 进预览
  _readAndParse(path, name, action, label) {
    if (!this._clsId()) { wx.showToast({ title: '请先选择导入到哪个班', icon: 'none' }); return; }
    if (!api.CLOUD_ENV || !wx.cloud) { wx.showToast({ title: '云开发未开通，无法解析', icon: 'none' }); return; }
    this.setData({ busy: true, srcLabel: label });
    const fs = wx.getFileSystemManager();
    fs.readFile({
      filePath: path,
      encoding: 'base64',
      success: rf => {
        api.stuImport({ action, fileBase64: rf.data, imageBase64: rf.data, name })
          .then(out => {
            this.setData({ busy: false });
            if (!out.ok) { wx.showToast({ title: out.msg || '解析失败', icon: 'none' }); return; }
            const students = roster.markDupes(out.students || [], this._existingNames());
            if (!students.length) { wx.showToast({ title: '没识别出学生名单，请换张清晰的照片或检查表格', icon: 'none' }); return; }
            this.setData({ step: 'review', list: students.map(s => Object.assign({ on: !s.dupe }, s)) });
          })
          .catch(e => {
            this.setData({ busy: false });
            wx.showToast({ title: (e && e.message) === 'CLOUD_OFF' ? '云开发未开通' : ((e && e.message) || '解析失败'), icon: 'none' });
          });
      },
      fail: () => { this.setData({ busy: false }); wx.showToast({ title: '文件读取失败', icon: 'none' }); }
    });
  },

  // 班内已有学生名单：用来标记重复
  _existingNames() {
    const cid = this._clsId();
    return db.students.list().filter(s => (s.clsIds || []).indexOf(cid) > -1).map(s => s.name);
  },

  toggle(e) {
    const i = +e.currentTarget.dataset.i;
    this.setData({ ['list[' + i + '].on']: !this.data.list[i].on });
  },

  back() { this.setData({ step: 'pick', list: [], result: null }); },

  // ---------- 批量建档 ----------
  commit() {
    const cid = this._clsId();
    const picks = this.data.list.filter(s => s.on);
    if (!picks.length) { wx.showToast({ title: '请至少勾选一名学生', icon: 'none' }); return; }
    this.setData({ busy: true });
    let added = 0, failed = 0, failMsg = '';
    picks.forEach(s => {
      const r = db.students.create({ name: s.name, gender: s.gender, parent: s.parent, clsIds: [cid] });
      if (r.ok) added++; else { failed++; failMsg = r.msg || failMsg; }
    });
    const dupes = this.data.list.filter(s => s.dupe).length;
    this.setData({ busy: false, result: { ok: true, added, failed, failMsg, dupes } });
  },

  done() { wx.navigateBack(); }
});
