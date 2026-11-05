const db = require('../../utils/db');
const api = require('../../utils/api');
const stt = require('../../utils/stt');
const voice = require('../../utils/voice');
const icons = require('../../utils/icons');
const media = require('../../utils/media');
const sec = require('../../utils/sec');
const photocloud = require('../../utils/photocloud');
const theme = require('../../utils/theme');

// 媒体限制：单个文件 50MB；照片/视频张数取数据层那一份（db.LIMITS），不在这里再写一遍
const MAX_FILE = 50 * 1024 * 1024;
const MAX_PHOTOS = db.LIMITS.photos;
const MAX_VIDEOS = db.LIMITS.videos;

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
    // 补录切换：归入哪次课（默认本次）。只有班上已经结清过（sessMax>1）才出现
    sessMax: 1, sessOpts: ['第1次课'], sessIdx: 0,
    score: 85, tags: TAGS, tag: '',
    note: '', photos: [], videos: [], audio: null, recording: false, recognizing: false, canSend: false, aiBusy: false,
    selCount: 0, editing: false, saving: false,
    tplOpen: false, tplList: [], sel: [],
    icoCamera: icons.camera, icoAlbum: icons.album, icoAudio: icons.audio,
    icoOrange: icons.mic(icons.brand()),
    icoWhite: icons.mic('#FFFFFF'),
    icoChevD: icons.chevronDown
  },
  onLoad(q) {
    const pick = getApp().globalData.pick || {};
    // 录入入口只开「进行中」学期的班级；编辑已有记录时其班级始终保留（哪怕已归档）
    const activeIds = db.terms.activeList().map(t => t.id);
    let classes = db.classes.list().filter(c => activeIds.indexOf(c.termId) > -1);
    if (pick.cls && !classes.some(c => c.id === pick.cls)) {
      const old = db.classes.get(pick.cls);
      if (old) classes = [old].concat(classes);
    }
    if (!classes.length) classes = db.classes.list();   // 兜底：一个进行中学期都没有时不至于无班可选
    const clsId = pick.cls || (classes[0] && classes[0].id);
    const courses = db.courses.of(clsId);
    const students = db.students.of(clsId); // 已按姓氏拼音排序
    // 编辑已有记录时按记录里的课程名定位到下拉项，避免默认落到第一门课
    const ci = Math.max(0, courses.findIndex(c => c.name === pick.course));
    // 课次：默认归入班级当前课次；编辑老记录时默认落在它本来的课次上
    const clsRaw = db.classes.get(clsId);
    const sessMax = Math.max(1, (clsRaw && clsRaw.session) || 1);
    let sess = sessMax;
    let wasSent = false;
    if (pick.rid) {
      const r0 = db.records.get(pick.rid);
      if (r0) {
        if (r0.session >= 1 && r0.session <= sessMax) sess = r0.session;
        // 已发布过的记录再进来是「修改」，不是首发布：按钮文案与提示都要跟着变
        wasSent = !!r0.sent;
      }
    }
    const sessOpts = [];
    for (let i = 1; i <= sessMax; i++) sessOpts.push('第' + i + '次课' + (i === sessMax ? '（本次）' : ''));
    this.setData({
      clsId, students, courses, courseIdx: ci,
      sessMax, sessOpts, sessIdx: sess - 1,
      over45: students.length > 45,
      course: courses[ci] ? courses[ci].name : '',
      sid: pick.sid || null, score: pick.score || 85, tag: pick.tag || '',
      note: pick.note || '', photos: pick.photos || [], videos: pick.videos || [], audio: pick.audio || null,
      rid: pick.rid || null, editing: !!pick.rid, wasSent,
      // 模板统一由机构维护：老师可选用，改模板需负责人/管理员权限
      canTplEdit: db.auth.can('template.write')
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
  // 阻止弹窗内点击冒泡到遮罩层的空处理
  noop() {},
  onShow() {
    theme.apply(this); // 主题：根类名 + 图标 + 原生 chrome
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
    this.setData({ canSend: db.canSend(this.data) });
  },
  pickStu(e) { this.setData({ sid: e.currentTarget.dataset.sid }); this.refreshCan(); },
  onScore(e) { this.setData({ score: e.detail.value }); },
  pickTag(e) {
    const t = e.currentTarget.dataset.t;
    const hit = TAGS.find(x => x.t === t);
    // 点选等级时，分数自动落到该档代表分，保持等级与分数一致
    this.setData({ tag: t, score: hit ? hit.anchor : this.data.score });
  },
  onCourse(e) {
    const c = this.data.courses[e.detail.value];
    this.setData({ courseIdx: e.detail.value, course: c ? c.name : '' });
  },
  // 归入课次（补录用）：默认本次，可改选更早的课
  onSess(e) { this.setData({ sessIdx: +e.detail.value }); },
  onNote(e) { this.setData({ note: e.detail.value }); this.refreshCan(); },

  // 一键清空课堂评语（字数左侧的 ✕）：评语可能是 AI 生成长文，误触代价高，先确认一次
  clearNote() {
    if (!this.data.note) return;
    wx.showModal({
      title: '清空课堂评语',
      content: '评语内容将全部清空，不可恢复',
      confirmText: '清空',
      confirmColor: '#C0564A',
      success: res => {
        if (res.confirm) this.setData({ note: '' });
      }
    });
  },
  goTpls() { wx.navigateTo({ url: '/pages/tpls/tpls?mode=select' }); },

  // AI 评：把第一张照片交给 aiEval 云函数（智谱 GLM-4V-Flash 识图），生成评价草稿填入输入框
  // 图片通道：云存储图直接传 fileID；本地图压缩后转 base64（callFunction 有包体上限，必须先压）
  async aiDraft() {
    if (this.data.aiBusy) return;
    if (!this.data.photos.length) { wx.showToast({ title: '先拍或选一张照片，AI 才有得看', icon: 'none' }); return; }
    if (String(this.data.note || '').trim()) {
      const go = await new Promise(res => wx.showModal({
        title: '覆盖当前评价？', content: 'AI 将根据照片重新生成，替换已输入的内容',
        success: r => res(!!(r && r.confirm)), fail: () => res(false)
      }));
      if (!go) return;
    }
    this.setData({ aiBusy: true });
    wx.showLoading({ title: 'AI 正在识图…', mask: true });
    try {
      const src = this.data.photos[0];
      const payload = { hint: this.data.course || '' };
      if (String(src).indexOf('cloud://') === 0) {
        payload.fileID = src;
      } else {
        let p = src;
        try {
          p = await new Promise((res, rej) => wx.compressImage({ src, quality: 'low', success: r => res(r.tempFilePath), fail: rej }));
        } catch (e) { /* 压缩失败用原图 */ }
        payload.imageBase64 = await new Promise((res, rej) =>
          wx.getFileSystemManager().readFile({ filePath: p, encoding: 'base64', success: r => res(r.data), fail: rej }));
      }
      const r = await api.aiEvalDraft(payload);
      if (!r || !r.ok) {
        const err = new Error((r && r.msg) || '生成失败');
        err.code = r && r.code;   // 业务错误码（如 NO_KEY）比 msg 文本更可靠
        throw err;
      }
      const text = String(r.text || '').trim().slice(0, 500);
      if (!text) throw new Error('AI 没有返回内容，请重试');
      this.setData({ note: text });
      this.refreshCan();
      wx.showToast({ title: '已生成，可自由修改', icon: 'success' });
    } catch (e) {
      const m = String((e && e.message) || '');
      const tip = (e && e.code) === 'NO_KEY' ? 'AI 未配置：云函数缺 ZHIPU_API_KEY 环境变量'
        : m.indexOf('CLOUD_OFF') > -1 ? '云开发未开通：需开通环境并部署 aiEval 云函数'
        : m.indexOf('NO_KEY') > -1 ? 'AI 未配置：云函数缺 ZHIPU_API_KEY 环境变量'
        : m.indexOf('超时') > -1 || m.indexOf('timeout') > -1 ? 'AI 响应超时，请重试'
        : (m || '生成失败，请重试');
      wx.showToast({ title: tip, icon: 'none' });
    } finally {
      wx.hideLoading && wx.hideLoading();
      this.setData({ aiBusy: false });
    }
  },

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
        let over = 0, lost = 0;
        (r.tempFiles || []).forEach(f => {
          if ((f.size || 0) > MAX_FILE) { over++; return; }
          // 必须转存到用户目录：tempFilePath 在小程序退出后会被系统清理，历史记录会全部裂图
          const isVideo = f.fileType === 'video' || /\.mp4$/i.test(f.tempFilePath || '');
          // 转存失败会返回空串：宁可这次少一张，也不要存一条注定裂图的引用
          const p = media.persist(f.tempFilePath, isVideo ? 'video' : 'photo');
          if (!p) { lost++; return; }
          if (isVideo) videos.push(p); else photos.push(p);
        });
        const tips = [];
        if (over) tips.push('跳过 ' + over + ' 个超大文件');
        if (lost) tips.push(lost + ' 个没能保存（存储空间可能已满）');
        if (tips.length) wx.showToast({ title: tips.join('，'), icon: 'none' });
        this.setData({ photos: photos.slice(0, MAX_PHOTOS), videos: videos.slice(0, MAX_VIDEOS) });
        this.refreshCan();
      },
      fail: err => media.handleChooseFail(err, this)
    });
  },
  // 注意：这里只从表单里移除引用，不删物理文件。
  // 编辑旧记录时删掉的照片可能仍被这条记录的原始版本引用，而用户中途放弃保存时
  // 删文件就会把库里还在用的图片删掉。垃圾文件的清理留到上云后统一做（媒体走云存储）。
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
      // 先转存为持久文件，再尝试上传云存储；未接云端时用的是本地持久路径
      const local = media.persist(res.tempFilePath, 'audio');
      api.uploadFile(res.tempFilePath, 'audio').then(url => {
        const src = url || local || null;
        this.setData({ audio: src });
        this.refreshCan();
        // 本地与云端都没存下来：如实说，不要让用户以为录上了
        wx.showToast({ title: src ? '语音已录入' : '语音没能保存，请重试', icon: src ? 'success' : 'none' });
      });
    });
    this.rec.onError(() => { this.setData({ recording: false }); wx.showToast({ title: '录音失败', icon: 'none' }); });
    this.rec.start({ format: 'mp3', duration: 60000 });
    this.setData({ recording: true });
  },
  // 播放语音：复用同一个 innerAudioContext。
  // 以前每点一次就 new 一个，连点十次就有十个实例在后台挂着、且从不 destroy()。
  playAudio() {
    if (!this.data.audio) return;
    if (!this._audioCtx) this._audioCtx = wx.createInnerAudioContext();
    this._audioCtx.stop();          // 上一次还没播完就重播，不要叠着放
    this._audioCtx.src = this.data.audio;
    this._audioCtx.play();
  },
  onUnload() {
    if (this._audioCtx) { this._audioCtx.destroy(); this._audioCtx = null; }
    if (this.rec && this.data.recording) this.rec.stop();
    voice.stop(this); // 语音输入的录音也别带到页面外
  },
  // 语音输入：点搜索框后的麦克风说话，再点一次结束
  onMic(e) { voice.dictate(this, e.currentTarget.dataset.k); },
  onHide() { voice.stop(this); },
  rmAudio() { this.setData({ audio: null }); this.refreshCan(); },
  preview() {
    // 预览页要一并展示照片/视频/语音，跳转前把当前媒体同步进 pick
    const pick = getApp().globalData.pick || (getApp().globalData.pick = {});
    pick.photos = this.data.photos.slice();
    pick.videos = this.data.videos.slice();
    pick.audio = this.data.audio || null;
    wx.navigateTo({ url: '/pages/tpls/tpls?mode=preview' });
  },
  save(e) {
    // 【防重】保存是同步的，但成功后有 800ms 的停留再返回上一页。
    // 这段时间里再点一次 = 再存一条记录 + 结转班再扣一次课时，账就错了。
    // setData 是异步的，所以用一个同步标志而不是只靠按钮 disabled。
    if (this._saving) return;
    const send = e.currentTarget.dataset.send === '1';
    // 只回传业务字段：data 里的班级叫 clsId，而记录模型用 cid，这里显式映射一次
    const payload = {
      cls: this.data.clsId, sid: this.data.sid, rid: this.data.rid,
      course: this.data.course, score: this.data.score, tag: this.data.tag,
      note: this.data.note, photos: this.data.photos, videos: this.data.videos, audio: this.data.audio,
      // 归入课次：默认本次；补录时是老师改选的那一课（编辑记录时数据层会忽略它，保留原课次）
      session: this.data.sessIdx + 1
    };
    this._saving = true;
    this.setData({ saving: true });
    // 评语属 UGC：云在线时先过内容安全再落库（87014 拦下让老师改）；
    // 离线（本地开发/测试环境没有 wx.cloud）保持同步直存，不引入无谓的异步。
    if (api.enabled() && this.data.note && this.data.note.trim()) {
      sec.checkMany([this.data.note]).then(secOut => {
        if (secOut.risky.size) {
          this._saving = false;
          this.setData({ saving: false });
          wx.showModal({
            title: '评语未通过安全检查', content: '这段评语可能含有不合适的内容，请修改后再发布。', showCancel: false
          });
          return;
        }
        this._doSave(payload, send);
      });
      return;
    }
    this._doSave(payload, send);
  },
  _doSave(payload, send) {
    const res = db.records.save(payload, send);
    if (!res.ok) {
      this._saving = false;
      this.setData({ saving: false });
      wx.showToast({ title: res.msg, icon: 'none' });
      return;
    }
    api.pushRecord(res.record); // 线上模式自动上推，本地模式静默跳过
    // 照片云备份：后台直传云存储，传完把记录里的本地路径换成 fileID；
    // 慢/失败都不阻塞保存主流程（失败保留本地路径，首页空闲时会补传）
    if (api.enabled() && (res.record.photos || []).length) photocloud.flushRecord(res.rid);
    // 直接发布给家长时，顺手把订阅通知交出去（未配模板/云未通时 familyNotify 静默跳过）
    if (res.record.sent) api.familyNotify({ items: sec.itemsFromRecords([res.record], db.students.name, db.classes.name) });
    // warn：记录已存下，但关联的课时账没记上（空间不足），得让老师知道
    // 已发布过的记录再保存 = 修改，文案不骗人说「已发布」
    wx.showToast({ title: res.warn || (send ? (this.data.wasSent ? '已保存修改' : '已发布') : '已存草稿'), icon: res.warn ? 'none' : 'success' });
    setTimeout(() => wx.navigateBack(), 800);
  },
  /* ================= 模板：页内全屏面板（多选/增删改） ================= */
  toggleTpl() {
    if (this.data.tplOpen) { this.setData({ tplOpen: false }); return; }
    const pick = getApp().globalData.pick || {};
    this._sel = (pick.tplSel || []).slice();
    this._reloadTpls();
    this.setData({ tplOpen: true, tplList: this._render(), sel: this._sel, selCount: this._sel.length });
  },
  // 从模板实体重新取一份本地副本（每次增删改后都要重取，保证下标与库一致）
  _reloadTpls() {
    this._tpl = db.templates.list().map(t => ({ id: t.id, n: t.name, opts: t.options.slice() }));
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
    const di = +e.currentTarget.dataset.di;
    const g = this._tpl[di];
    if (!g) return;
    wx.showModal({
      title: '新增选项 · ' + g.n, editable: true, placeholderText: '输入选项内容',
      success: r => {
        if (!r.confirm || !r.content || !r.content.trim()) return;
        const res = db.templates.addOption(g.id, r.content.trim());
        if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
        this._reloadTpls(); this._sync();
      }
    });
  },
  tplEdit(e) {
    const di = +e.currentTarget.dataset.di, oi = +e.currentTarget.dataset.oi;
    const g = this._tpl[di];
    if (!g) return;
    wx.showModal({
      title: '编辑选项', editable: true, content: g.opts[oi],
      success: r => {
        if (!r.confirm || !r.content || !r.content.trim()) return;
        const res = db.templates.updateOption(g.id, oi, r.content.trim());
        if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
        this._reloadTpls(); this._sync();
      }
    });
  },
  tplDel(e) {
    const di = +e.currentTarget.dataset.di, oi = +e.currentTarget.dataset.oi;
    const g = this._tpl[di];
    if (!g) return;
    wx.showModal({ title: '删除这个选项？', success: r => {
      if (!r.confirm) return;
      const res = db.templates.removeOption(g.id, oi);
      if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
      // 选中项随删除位移：同维度中排在被删项之后的整体前移一位，否则会错位选中其它评语
      this._sel = this._sel.filter(k => k !== di + ':' + oi).map(k => {
        const p = k.split(':'), d = +p[0], o = +p[1];
        return (d === di && o > oi) ? (d + ':' + (o - 1)) : k;
      });
      this._reloadTpls(); this._sync();
    } });
  },
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
