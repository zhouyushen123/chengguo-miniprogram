const db = require('../../utils/db');
const api = require('../../utils/api');
const stt = require('../../utils/stt');
const voice = require('../../utils/voice');
const icons = require('../../utils/icons');
const media = require('../../utils/media');
const sec = require('../../utils/sec');
const photocloud = require('../../utils/photocloud');
const theme = require('../../utils/theme');
const aipref = require('../../utils/aipref');

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

// AI 评价的「重点看什么」。k 与云函数 aiEval 的 VIEWS 一一对应：
// 改这里必须同步那边，否则勾了却没生效（tests/verify_ai_guide.js 会拦）。
const AI_VIEWS = [
  { k: 'skill', t: '专业技法' },
  { k: 'compose', t: '画面与结构' },
  { k: 'habit', t: '课堂状态' },
  { k: 'progress', t: '和上次比' },
  { k: 'mood', t: '情绪与状态' }
];

Page({
  data: {
    clsId: null, students: [], stuShow: [], stuQuery: '', stuExpanded: false, over45: false,
    courses: [], courseIdx: 0, course: '',
    // 补录切换：归入哪次课（默认本次）。只有班上已经结清过（sessMax>1）才出现
    sessMax: 1, sessOpts: ['第1次课'], sessIdx: 0,
    score: 85, tags: TAGS, tag: '',
    note: '', photos: [], videos: [], audio: null, recording: false, recognizing: false, canSend: false,
    // AI 引导层：aiChips 是五个可选视角，aiWho 只用来告诉老师「这一条是写给谁、什么课」
    aiBusy: false, aiOpen: false, aiSay: '', aiWho: '',
    aiChips: AI_VIEWS.map(v => ({ k: v.k, t: v.t, on: false })),
    selCount: 0, editing: false, saving: false,
    tplOpen: false, tplList: [], sel: [],
    icoCamera: icons.camera, icoAlbum: icons.album, icoAudio: icons.audio,
    icoOrange: icons.mic(icons.brand()),
    icoWhite: icons.mic('#FFFFFF'),
    icoChevD: icons.chevronDown
  },
  onLoad(q) {
    const app = getApp();
    let pick = app.globalData.pick || {};
    // 【I-09 / J-07】编辑态一律以「记录 id」为准，回库里取原内容，不再信调用方塞满的 pick：
    // 学生档案页只把 rid 放在 URL 上（?rid=），以前 onLoad 完全不读 q，就变成空白新建态，
    // 还残留上一次录入的班级/学生，看起来像「改到别的同学头上」、底部还是「发布到家长端」。
    // 现在两个入口（URL rid / pick.rid）都走同一条路，重建后的 pick 也写回 globalData，
    // 预览页、模板页读到的就是同一条记录的内容。
    const urlRid = q && q.rid ? Number(q.rid) : 0;
    const rid = urlRid || Number(pick.rid) || 0;
    const rec = rid ? db.records.get(rid) : null;
    if (rec) {
      pick = {
        cls: rec.cid, sid: rec.sid, rid: rec.id, score: rec.score,
        tag: rec.tag || '', note: rec.note || '', course: rec.course || '',
        photos: rec.photos || [], videos: rec.videos || [], audio: rec.audio || null,
        sent: !!rec.sent, date: rec.date, session: rec.session
      };
      app.globalData.pick = pick;
    }
    // 录入入口只开「进行中」学期的班级；编辑已有记录时其班级始终保留（哪怕已归档）
    const activeIds = db.terms.activeList().map(t => t.id);
    let classes = db.classes.list().filter(c => activeIds.indexOf(c.termId) > -1);
    if (pick.cls && !classes.some(c => c.id === pick.cls)) {
      const old = db.classes.get(pick.cls);
      if (old) classes = [old].concat(classes);
    }
    if (!classes.length) classes = db.classes.list();   // 兜底：一个进行中学期都没有时不至于无班可选
    const clsId = pick.cls || (classes[0] && classes[0].id);
    // 编辑老记录时若课程已从班上解绑，仍把它留在下拉里，别悄悄换成第一门课
    let courses = db.courses.of(clsId);
    if (pick.course && !courses.some(c => c.name === pick.course)) {
      courses = [{ id: 0, name: pick.course }].concat(courses);
    }
    let students = db.students.of(clsId); // 已按姓氏拼音排序
    // 学生转班后仍要能看见/选中记录原本属于谁
    if (pick.sid && !students.some(s => s.id === pick.sid)) {
      const oldStu = db.students.get(pick.sid);
      if (oldStu) students = [oldStu].concat(students);
    }
    // 编辑已有记录时按记录里的课程名定位到下拉项，避免默认落到第一门课
    const ci = Math.max(0, courses.findIndex(c => c.name === pick.course));
    // 课次：默认归入班级当前课次；编辑老记录时默认落在它本来的课次上
    const clsRaw = db.classes.get(clsId);
    const sessMax = Math.max(1, (clsRaw && clsRaw.session) || 1);
    let sess = sessMax;
    let wasSent = false;
    if (rec) {
      if (rec.session >= 1 && rec.session <= sessMax) sess = rec.session;
      // 已发布过的记录再进来是「修改」，不是首发布：按钮文案与提示都要跟着变
      wasSent = !!rec.sent;
    }
    // H-23 双保险：记录列表跳转时直接带上 sent，即使本地按 rid 没查到（权限/同步中）
    // 也必须是「保存修改」，绝不能把已发布的记录显示成「发布到家长端」。
    if (pick.sent) wasSent = true;
    const sessOpts = [];
    for (let i = 1; i <= sessMax; i++) sessOpts.push('第' + i + '次课' + (i === sessMax ? '（本次）' : ''));
    this.setData({
      clsId, students, courses, courseIdx: ci,
      sessMax, sessOpts, sessIdx: sess - 1,
      over45: students.length > 45,
      course: courses[ci] ? courses[ci].name : pick.course || '',
      // 0 分也是合法分数，不能用 || 兜底成 85
      sid: pick.sid || null, score: (pick.score === undefined || pick.score === null) ? 85 : pick.score,
      tag: pick.tag || '',
      note: pick.note || '', photos: pick.photos || [], videos: pick.videos || [], audio: pick.audio || null,
      rid: rid || null, editing: !!rid, wasSent,
      // 编辑态顶部明写改的是谁：老师一眼能看出没串到别的同学
      editStuName: pick.sid ? (db.students.name(pick.sid) || '') : '',
      editCourse: pick.course || '', editDate: pick.date || '',
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

  // AI 评：先让老师把"这节课想让人看见什么"勾一下，再交给 aiEval 生成。
  // 以前是直接把照片丢给模型：它不知道这孩子学什么、上次写到哪、今天想让他被夸什么，
  // 只能吐「孩子们表现非常棒」这种谁都能用的话——家长看完等于没看。
  aiDraft() {
    if (this.data.aiBusy) return;
    if (!this.data.photos.length) { wx.showToast({ title: '先拍或选一张照片，AI 才有得看', icon: 'none' }); return; }
    if (String(this.data.note || '').trim()) {
      wx.showModal({
        title: '覆盖当前评价？', content: 'AI 将根据照片重新生成，替换已输入的内容',
        success: r => { if (r && r.confirm) this._openAi(); }
      });
      return;
    }
    this._openAi();
  },
  // 引导层：上次勾过的视角默认带上，省得每节课重选一遍
  _openAi() {
    const pref = aipref.views();
    const kid = this.data.sid ? (db.students.name(this.data.sid) || '') : '';
    this.setData({
      aiOpen: true,
      aiSay: '',
      aiChips: AI_VIEWS.map(v => ({ k: v.k, t: v.t, on: pref.indexOf(v.k) > -1 })),
      aiWho: [kid, this.data.course].filter(Boolean).join(' · ')
    });
  },
  aiPickView(e) {
    const k = e.currentTarget.dataset.k;
    this.setData({ aiChips: this.data.aiChips.map(c => (c.k === k ? { k: c.k, t: c.t, on: !c.on } : c)) });
  },
  onAiSay(e) { this.setData({ aiSay: e.detail.value }); },
  aiSayClear() { this.setData({ aiSay: '' }); },
  aiClose() { this.setData({ aiOpen: false }); },
  // 什么都不勾也允许生成：默认路径已经带上姓名 / 课程 / 学科维度 / 上次评语，
  // 引导是加分项，不是必经步骤——录入现场老师赶时间，多一道强制就是负担。
  aiGo() {
    const views = this.data.aiChips.filter(c => c.on).map(c => c.k);
    const say = String(this.data.aiSay || '').trim().slice(0, 120);
    aipref.save(views);
    this.setData({ aiOpen: false });
    // 返回 promise：调用方（含测试）能等它跑完，不用猜加载圈什么时候结束
    return this._aiRun(views, say);
  },
  // 该生上一次已发布的评语：让 AI 接着上次说，而不是每次都像第一次见这孩子
  _prevNote(sid, rid) {
    if (!sid) return '';
    try {
      const hit = db.records.ofStudent(sid)
        .filter(r => r.id !== rid && r.sent && String(r.note || '').trim())
        .sort((a, b) => (a.date === b.date ? b.id - a.id : (a.date < b.date ? 1 : -1)))[0];
      return hit ? String(hit.note).slice(0, 200) : '';
    } catch (e) { return ''; }
  },
  // 课程名 → 学科 gid：让云端挑对专业词表（美术说线条明暗，数学说算理步骤）
  _subjectGid(course) {
    try {
      const id = db.subjects.guessFor(course);
      const s = id ? db.subjects.get(id) : null;
      return s ? String(s.gid || '') : '';
    } catch (e) { return ''; }
  },
  // 图片通道：云存储图直接传 fileID；本地图压缩后转 base64（callFunction 有包体上限，必须先压）
  async _aiRun(views, say) {
    this.setData({ aiBusy: true });
    // 识图本来就要几秒，先说清楚要等，免得老师以为没反应就反复点
    wx.showLoading({ title: 'AI 识图中，约需几秒…', mask: true });
    try {
      const src = this.data.photos[0];
      // 老师脑子里的上下文全在这一包里：谁、什么课、什么学科、什么等第、第几次、
      // 想强调什么（views/say）、上次写到哪（prev）。少一项，AI 就退回说套话。
      const payload = {
        hint: this.data.course || '',
        kid: this.data.sid ? (db.students.name(this.data.sid) || '') : '',
        course: this.data.course || '',
        subjectGid: this._subjectGid(this.data.course),
        tag: this.data.tag || '',
        session: (this.data.sessIdx || 0) + 1,
        views: views || [],
        say: say || '',
        prev: this._prevNote(this.data.sid, this.data.rid)
      };
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
      // 网络 / 云函数超时由 api 层自动补两次，这里只负责把重试进度显示出来
      const r = await api.aiEvalDraft(payload, {
        onRetry: n => wx.showLoading({ title: '第 ' + (n + 1) + ' 次尝试…', mask: true })
      });
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
      // 微信侧掐断云函数是 -504003 / time out，别只说「请重试」：多半是 aiEval 超时还停在 3 秒。
      // 云函数自己回的「GLM 请求超时」是 AI 服务慢，走普通 toast，不误报配置问题
      const timeout = /-504003|time\s*out|timeout|云函数超时/i.test(m);
      if (timeout) {
        wx.hideLoading && wx.hideLoading();
        wx.showModal({
          title: 'AI 生成超时',
          content: '已自动重试 2 次仍没拿到结果。云函数 aiEval 的超时多半还是 3 秒，而识图要 5~10 秒。请到云开发控制台 → 云函数 → aiEval → 配置，把超时改成 20 秒（只需设一次，之后一次就能出结果）。\n\n错误：' + m.slice(0, 120),
          showCancel: false, confirmText: '知道了'
        });
        return;
      }
      const tip = (e && e.code) === 'NO_KEY' ? 'AI 未配置：云函数缺 ZHIPU_API_KEY 环境变量'
        : m.indexOf('CLOUD_OFF') > -1 ? '云开发未开通：需开通环境并部署 aiEval 云函数'
        : m.indexOf('NO_KEY') > -1 ? 'AI 未配置：云函数缺 ZHIPU_API_KEY 环境变量'
        : m.indexOf('GLM 请求超时') > -1 ? 'AI 服务响应慢，请稍后再试'
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
    if (this.data.recognizing) { if (this.recog) this.recog.stop(); return; }
    if (stt.available()) {
      // 开录前已有的文字是「底稿」。识别过程中每次回调都拿全文重新拼一次（替换），
      // 绝不能把中间结果一行行追加到 note 后面 —— 插件的 onRecognize 给的是累计全文，
      // 追加会把同一句话越叠越长（11-07 真机截图的 8 行重复评语）。
      const base = String(this.data.note || '').replace(/\s+$/, '');
      const join = t => (base ? base + '\n' : '') + String(t || '').trim();
      let last = '';
      this.recog = stt.createRecognizer({
        onPartial: t => { if (this._leaving) return; last = t || ''; const v = join(t); if (v !== this.data.note) this.setData({ note: v }); },
        onDone: t => {
          if (this._leaving) return;
          this.recog = null;
          this.setData({ recognizing: false });
          const final = t || last;
          const v = join(final);
          if (v !== this.data.note) this.setData({ note: v });
          this.refreshCan();
          wx.showToast({ title: final ? '已转成文字，可修改' : '没听清，再试一次？', icon: 'none' });
        },
        onError: () => {
          if (this._leaving) return;
          this.recog = null;
          this.setData({ recognizing: false, note: base });
          wx.showToast({ title: '识别失败，请重试或手输', icon: 'none' });
        }
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
    this._leaving = true;
    if (this._audioCtx) { this._audioCtx.destroy(); this._audioCtx = null; }
    if (this.rec && this.data.recording) this.rec.stop();
    if (this.recog) { this.recog.stop(); this.recog = null; }
    voice.stop(this); // 语音输入的录音也别带到页面外
  },
  // 语音输入：点搜索框后的麦克风说话，再点一次结束
  onMic(e) { voice.dictate(this, e.currentTarget.dataset.k); },
  onHide() {
    if (this.recog) { this.recog.stop(); this.recog = null; this.setData({ recognizing: false }); }
    voice.stop(this);
  },
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
