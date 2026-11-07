// pages/batch/batch.js —— 成绩单批量录入（本次课）
//
// 场景：老师上课没空单个录，课后凭记忆/回忆一次性补全班。
// 一屏一列学生：等级 chips（默认沿用上次）+ 评语（AI 一键全班生成）+ 长按标请假。
// 【统一上传图片】一次拍/选一节课的全部照片进「照片池」，点照片勾给哪些学生（或全班共用），
// 保存时每人只带自己那几张。落库前不做上传：保存后由 photocloud.flushBatch 把照片池
// 去重上传一次、再把 fileID 回填到全班记录，老师点保存不用等网络。
// 保存走 db.records.batch（一个事务批量落库，归当前课次）。
const db = require('../../utils/db');
const api = require('../../utils/api');
const sec = require('../../utils/sec');
const theme = require('../../utils/theme');
const draft = require('../../utils/draft');
const voice = require('../../utils/voice');
const media = require('../../utils/media');
const icons = require('../../utils/icons');
const photocloud = require('../../utils/photocloud');

// 一次课最多传 30 张（约 10MB 压缩图），每人记录仍受数据层 9 张上限约束
const MAX_POOL = 30;
const MAX_PER_STU = db.LIMITS.photos;
const MAX_FILE = 50 * 1024 * 1024;
const uniq = arr => arr.filter((p, i) => p && arr.indexOf(p) === i);

// 评分五档与代表分，与单人录入页（pages/record）同一套口径
const TAGS = [
  { t: '待提高', anchor: 60 },
  { t: '加油', anchor: 75 },
  { t: '良好', anchor: 85 },
  { t: '优秀', anchor: 92 },
  { t: '最佳', anchor: 98 }
];
// AI 批量评语每批人数：一次太多云函数容易超时
const AI_BATCH = 10;

Page({
  data: {
    cls: null, sess: 1,
    rows: [], topic: '',
    tags: TAGS.map(x => x.t),
    aiBusy: false, aiProg: '', saving: false,
    total: 0, filled: 0, leaveCount: 0,
    // 统一上传图片：照片池 + 渲染角标 + 全班共用开关
    photos: [], photoCells: [], shared: false,
    maxPhotos: MAX_POOL, unassigned: 0,
    // 分拣弹层：mode=photo 从一张照片进（勾学生）/ mode=stu 从学生行进（勾照片）
    sheet: false, sheetMode: '', sheetTitle: '', sheetPhoto: '',
    sheetStus: [], sheetPhotos: [], sheetIdx: -1, sheetSid: 0,
    icoCamera: icons.camera, icoAlbum: icons.album
  },
  onLoad(q) {
    this.clsId = +q.id || 0;
    const cls = db.classes.get(this.clsId);
    if (!cls) { wx.showToast({ title: '该班级不在你的管理范围', icon: 'none' }); setTimeout(() => wx.navigateBack(), 900); return; }
    const deny = db.auth.can('record.create', { clsId: this.clsId }) ? null : db.auth.denyReason('record.create');
    if (deny) { wx.showToast({ title: deny, icon: 'none' }); setTimeout(() => wx.navigateBack(), 900); return; }
    const sess = Math.max(1, cls.session || 1);
    this.setData({ cls: { id: cls.id, name: cls.name }, sess });
    this._build(sess, q);
  },
  onShow() { theme.apply(this); this._count(); },
  // 组装成绩单：每行默认「沿用上次课」的等级和分数（高亮但语义是沿用，老师可改可不改）
  _build(sess, q) {
    const students = db.students.of(this.clsId);
    const recs = db.records.ofClass(this.clsId);   // 按 id 倒序（最近在前）
    // 上一次课（session-1）各学生的记录；没有上一课的就退回「该生最近一条」
    const lastBySid = {};
    recs.forEach(r => { if (r.session === sess - 1 && !lastBySid[r.sid]) lastBySid[r.sid] = r; });
    const rows = students.map(s => {
      const last = lastBySid[s.id] || recs.find(r => r.sid === s.id) || null;
      return {
        id: s.id, name: s.name, photo: s.photo || '',
        score: last ? last.score : 85,
        tag: last ? (last.tag || '') : '',
        note: '',
        prev: (last && last.note) || '',              // 上次评语：给 AI 做差异化参考
        leave: false,
        photos: [],                                   // 分给这位学生的照片（引用 photos 池里的路径）
        carried: !!(last && last.tag),                // 「沿用上次」小标：点过 chips 后消失
        course: (last && last.course) || '',
        courseId: (last && last.courseId) || 0
      };
    });
    this.setData({ rows, total: rows.length });
    // 草稿恢复：上次录到一半退出的，问一声
    const d = draft.get(this.clsId);
    if (d && d.rows && d.rows.length === rows.length) {
      wx.showModal({
        title: '恢复未保存的录入？',
        content: '上次有一次没录完的批量录入，恢复后继续。',
        confirmText: '恢复',
        cancelText: '不要',
        success: res => {
          if (!res.confirm) { draft.clear(this.clsId); return; }
          // 老草稿没有 photos 字段：按空池恢复，不让旧数据把页面卡住
          this.setData({
            rows: (d.rows || []).map(r => Object.assign({}, r, { photos: (r.photos || []).slice() })),
            topic: d.topic || '',
            photos: Array.isArray(d.photos) ? d.photos.slice(0, MAX_POOL) : [],
            shared: !!d.shared
          }, () => { this._syncPhotos(); this._count(); });
        }
      });
    }
    void q;
  },
  _count() {
    const rows = this.data.rows;
    this.setData({
      filled: rows.filter(r => !r.leave && (r.tag || r.note)).length,
      leaveCount: rows.filter(r => r.leave).length
    });
  },
  // ---------- 统一上传图片：照片池 → 分拣 → 随记录保存 ----------
  // 角标显示每张照片分给了几人；没分出去的照片不会出现在任何学生记录里，必须让老师看得见
  _syncPhotos() {
    const pool = this.data.photos;
    const rows = this.data.rows;
    const cells = pool.map((p, i) => ({
      p, i, n: rows.filter(r => !r.leave && (r.photos || []).indexOf(p) > -1).length
    }));
    this.setData({
      photoCells: cells,
      unassigned: this.data.shared ? 0 : cells.filter(c => !c.n).length
    });
  },
  addPhotos(e) {
    const src = e.currentTarget.dataset.src;  // camera | album
    const left = MAX_POOL - this.data.photos.length;
    if (left <= 0) { wx.showToast({ title: '一次课最多 ' + MAX_POOL + ' 张照片', icon: 'none' }); return; }
    wx.chooseMedia({
      count: Math.min(9, left), mediaType: ['image'], sourceType: [src], sizeType: ['compressed'],
      camera: 'back',
      success: r => {
        const photos = this.data.photos.slice();
        let lost = 0, over = 0;
        (r.tempFiles || []).forEach(f => {
          if ((f.size || 0) > MAX_FILE) { over++; return; }
          // 临时路径退出小程序即被清理，必须先转存到用户目录，否则历史记录全是裂图
          const p = media.persist(f.tempFilePath || f.path, 'photo');
          if (!p) { lost++; return; }
          if (photos.indexOf(p) < 0 && photos.length < MAX_POOL) photos.push(p);
        });
        const tips = [];
        if (over) tips.push('跳过 ' + over + ' 个超大文件');
        if (lost) tips.push(lost + ' 张没能保存（存储可能已满）');
        if (tips.length) wx.showToast({ title: tips.join('，'), icon: 'none' });
        this.setData({ photos }, () => this._syncPhotos());
        this._saveDraft();
      },
      fail: err => media.handleChooseFail(err, this)
    });
  },
  // 从池里删掉一张：同时清掉所有学生行里的引用，别留下指向已删图片的空壳
  rmPoolPhoto(e) {
    const i = +e.currentTarget.dataset.i;
    const p = this.data.photos[i];
    if (!p) return;
    const photos = this.data.photos.filter((x, k) => k !== i);
    const rows = this.data.rows.map(r => Object.assign({}, r, {
      photos: (r.photos || []).filter(x => x !== p)
    }));
    this.setData({ photos, rows }, () => this._syncPhotos());
    this._saveDraft();
  },
  previewPoolPhoto(e) {
    const i = +e.currentTarget.dataset.i;
    wx.previewImage({ urls: this.data.photos, current: this.data.photos[i] });
  },
  toggleShared() {
    this.setData({ shared: !this.data.shared }, () => this._syncPhotos());
    this._saveDraft();
  },
  // 从一张照片进：勾有哪些学生要用它
  openPhoto(e) {
    const i = +e.currentTarget.dataset.i;
    const p = this.data.photos[i];
    if (!p) return;
    const stus = this.data.rows.filter(r => !r.leave).map(r => ({
      id: r.id, name: r.name, on: (r.photos || []).indexOf(p) > -1
    }));
    if (!stus.length) { wx.showToast({ title: '没有人可分配（都请假了）', icon: 'none' }); return; }
    this.setData({
      sheet: true, sheetMode: 'photo', sheetIdx: i, sheetSid: 0,
      sheetTitle: '这张照片给哪些同学？', sheetPhoto: p,
      sheetStus: stus, sheetPhotos: []
    });
  },
  // 从学生行进：勾他要哪几张照片
  openStuPhotos(e) {
    if (!this.data.photos.length) { wx.showToast({ title: '先拍照或从相册选照片', icon: 'none' }); return; }
    const sid = this.data.rows[+e.currentTarget.dataset.i].id;
    const row = this.data.rows.find(r => r.id === sid) || {};
    this.setData({
      sheet: true, sheetMode: 'stu', sheetIdx: -1, sheetSid: sid,
      sheetTitle: '给「' + (row.name || '这位同学') + '」选照片',
      sheetPhoto: '', sheetStus: [],
      sheetPhotos: this.data.photos.map((p, i) => ({ p, i, on: (row.photos || []).indexOf(p) > -1 }))
    });
  },
  toggleSheetStu(e) {
    this.setData({ ['sheetStus[' + e.currentTarget.dataset.i + '].on']: !this.data.sheetStus[+e.currentTarget.dataset.i].on });
  },
  toggleSheetPhoto(e) {
    this.setData({ ['sheetPhotos[' + e.currentTarget.dataset.i + '].on']: !this.data.sheetPhotos[+e.currentTarget.dataset.i].on });
  },
  closeSheet() { this.setData({ sheet: false }); },
  confirmSheet() {
    let rows = this.data.rows;
    if (this.data.sheetMode === 'photo') {
      const p = this.data.sheetPhoto;
      const want = this.data.sheetStus.filter(s => s.on).map(s => s.id);
      let over = '';
      rows = rows.map(r => {
        const has = (r.photos || []).indexOf(p) > -1;
        const need = want.indexOf(r.id) > -1;
        if (has === need) return r;
        if (!need) return Object.assign({}, r, { photos: (r.photos || []).filter(x => x !== p) });
        const next = (r.photos || []).concat([p]);
        if (next.length > MAX_PER_STU) { over = over || r.name; return r; }
        return Object.assign({}, r, { photos: next });
      });
      if (over) { wx.showToast({ title: over + ' 最多 ' + MAX_PER_STU + ' 张照片', icon: 'none' }); return; }
    } else {
      const picked = this.data.sheetPhotos.filter(x => x.on).map(x => x.p);
      if (picked.length > MAX_PER_STU) { wx.showToast({ title: '每人最多 ' + MAX_PER_STU + ' 张照片', icon: 'none' }); return; }
      rows = rows.map(r => r.id === this.data.sheetSid ? Object.assign({}, r, { photos: picked }) : r);
    }
    this.setData({ rows, sheet: false }, () => this._syncPhotos());
    this._saveDraft();
  },
  pickTag(e) {
    const i = +e.currentTarget.dataset.i;
    const t = e.currentTarget.dataset.t;
    const hit = TAGS.find(x => x.t === t);
    this.setData({
      ['rows[' + i + '].tag']: t,
      ['rows[' + i + '].score']: hit ? hit.anchor : this.data.rows[i].score,
      ['rows[' + i + '].carried']: false
    }, () => this._count());
    this._saveDraft();
  },
  onNote(e) {
    const i = +e.currentTarget.dataset.i;
    // 改评语即视为已重写，撤销安全检查标红
    this.setData({ ['rows[' + i + '].note']: e.detail.value, ['rows[' + i + '].hit']: false });
    this._saveDraft();
  },
  onTopic(e) { this.setData({ topic: e.detail.value }); this._saveDraft(); },
  // 长按学生行 = 标记/取消请假（请假的人本次不落库，结清时不算未录）
  toggleLeave(e) {
    const i = +e.currentTarget.dataset.i;
    const v = !this.data.rows[i].leave;
    this.setData({ ['rows[' + i + '].leave']: v }, () => this._count());
    this._saveDraft();
  },
  _saveDraft() {
    if (this.data.saving) return;
    // 照片池与分配关系一起进草稿：录到一半被打断，回来不用重选图、重分一遍
    draft.set(this.clsId, {
      rows: this.data.rows, topic: this.data.topic,
      photos: this.data.photos, shared: this.data.shared
    });
  },
  // 语音输入：本课主题与每位学生的评语框都能说；data-k 支持 rows[0].note 这种路径
  onMic(e) { voice.dictate(this, e.currentTarget.dataset.k); },
  onHide() { voice.stop(this); this._saveDraft(); },
  onUnload() { voice.stop(this); this._saveDraft(); },
  // AI 一键全班评语：只对「未请假且评语为空」的行生成，10 人一批串行调用防超时
  aiAll() {
    if (this.data.aiBusy || this.data.saving) return;
    const targets = [];
    this.data.rows.forEach((r, i) => { if (!r.leave && !r.note) targets.push(i); });
    if (!targets.length) { wx.showToast({ title: '评语都已填写，无需生成', icon: 'none' }); return; }
    if (!api.enabled()) { wx.showToast({ title: 'AI 评语需要云开发环境', icon: 'none' }); return; }
    this.setData({ aiBusy: true, aiProg: '准备生成…' });
    const self = this;
    let done = 0;
    function next() {
      if (!self.data.aiBusy) return;   // 用户中途退出
      const slice = targets.slice(done, done + AI_BATCH);
      if (!slice.length) {
        self.setData({ aiBusy: false, aiProg: '' });
        wx.showToast({ title: '评语已生成，请过一遍再保存', icon: 'success' });
        return;
      }
      self.setData({ aiProg: '生成中 ' + (done + 1) + '-' + (done + slice.length) + ' / ' + targets.length + ' 人…' });
      const students = slice.map(i => ({
        name: self.data.rows[i].name,
        tag: self.data.rows[i].tag || '',
        prev: (self.data.rows[i].prev || '').slice(0, 80)
      }));
      api.aiEvalDraft({ action: 'batch', students, topic: self.data.topic })
        .then(out => {
          if (!out.ok) {
            self.setData({ aiBusy: false, aiProg: '' });
            wx.showToast({ title: out.msg || 'AI 生成失败，可手写后直接保存', icon: 'none' });
            return;
          }
          const patch = {};
          out.notes.forEach(n => {
            if (!n.note) return;   // 云函数没对上号的返回 null，保留空让老师手写
            const i = slice.find(idx => self.data.rows[idx].name === n.name);
            if (i !== undefined) patch['rows[' + i + '].note'] = n.note;
          });
          self.setData(patch, () => self._count());
          done += slice.length;
          next();
        })
        .catch(() => {
          self.setData({ aiBusy: false, aiProg: '' });
          wx.showToast({ title: '网络不给力，稍后再试或手写评语', icon: 'none' });
        });
    }
    next();
  },
  // 保存：云在线时先全班评语过内容安全（只查不同的文本，重复评语不重复计费），命中行标红不保存；
  // 离线（本地开发/测试）直接走同步确认，不引入无谓的异步。
  save() {
    if (this.data.saving) return;
    const rows = this.data.rows.filter(r => !r.leave);
    if (!rows.length) { wx.showToast({ title: '除了请假没有人要录', icon: 'none' }); return; }
    if (!api.enabled()) { this._confirmSave(rows); return; }
    sec.checkMany(rows.map(r => r.note)).then(secOut => {
      if (secOut.risky.size) {
        const rows2 = this.data.rows.map(r => Object.assign({}, r, { hit: !r.leave && !!r.note && secOut.risky.has(String(r.note || '').trim()) }));
        this.setData({ rows: rows2, risky: rows2.filter(r => r.hit).length });
        wx.showModal({
          title: '有评语未通过安全检查',
          content: rows2.filter(r => r.hit).length + ' 条评语可能含有不合适的内容（已标红），请修改后再保存。',
          showCancel: false
        });
        return;
      }
      this._confirmSave(rows);
    });
  },
  _confirmSave(rows) {
    const pool = this.data.photos.slice();
    const shared = this.data.shared;
    // 只认池里还存在的路径（删过的照片不会残留在某条记录里）；全班共用时池 + 个人专属合并去重
    const lists = rows.map(r => {
      const own = uniq((r.photos || []).filter(p => pool.indexOf(p) > -1));
      return uniq(shared ? pool.concat(own) : own);
    });
    const items = rows.map((r, i) => ({
      cls: this.clsId, sid: r.id, score: r.score, tag: r.tag,
      note: r.note, course: r.course, courseId: r.courseId,
      session: this.data.sess,
      photos: lists[i].slice(0, MAX_PER_STU)
    }));
    const clipped = lists.filter(a => a.length > MAX_PER_STU).length;
    const leaveTip = this.data.leaveCount ? ('，' + this.data.leaveCount + ' 人请假已跳过') : '';
    let photoTip = '';
    if (pool.length) {
      photoTip = shared
        ? '；' + pool.length + ' 张照片全班共用'
        : (this.data.unassigned ? '；还有 ' + this.data.unassigned + ' 张照片没分给学生，不会出现在任何记录里' : '；照片已分给学生');
    }
    const clipTip = clipped ? '（' + clipped + ' 人超过 ' + MAX_PER_STU + ' 张，只取前 ' + MAX_PER_STU + ' 张）' : '';
    wx.showModal({
      title: '保存本次课记录？',
      content: '将为 ' + items.length + ' 名学生保存第 ' + this.data.sess + ' 次课记录' + leaveTip + photoTip + clipTip + '。',
      confirmText: '保存',
      success: res => {
        if (!res.confirm) return;
        this.setData({ saving: true });
        const out = db.records.batch(items, false);
        if (!out.ok) {
          this.setData({ saving: false });
          wx.showToast({ title: out.msg || '保存失败，请重试', icon: 'none' });
          return;
        }
        draft.clear(this.clsId);
        this.setData({ saving: false, saving0: true });
        // 照片池后台去重上传一次 → fileID 回填到每条记录；不等待、不阻塞保存主流程。
        // 云未通/上传失败保留本地路径，首页 migrateAll 会幂等补传。
        if (api.enabled() && out.results) {
          const mediaRows = out.results.map((r, i) => (r && r.ok && r.rid && items[i].photos.length)
            ? { rid: r.rid, photos: items[i].photos } : null).filter(Boolean);
          if (mediaRows.length) photocloud.flushBatch(mediaRows);
        }
        let tip = '已保存 ' + out.saved + ' 条';
        if (out.failed) tip += '，' + out.failed + ' 条失败';
        wx.showToast({ title: tip, icon: out.failed ? 'none' : 'success' });
        setTimeout(() => wx.navigateBack(), out.failed ? 1400 : 800);
      }
    });
  },
  noop() {}
});
