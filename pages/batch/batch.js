// pages/batch/batch.js —— 成绩单批量录入（本次课）
//
// 场景：老师上课没空单个录，课后凭记忆/回忆一次性补全班。
// 一屏一列学生：等级 chips（默认沿用上次）+ 评语（AI 一键全班生成）+ 长按标请假。
// 保存走 db.records.batch（一个事务批量落库，归当前课次）。
const db = require('../../utils/db');
const api = require('../../utils/api');
const sec = require('../../utils/sec');
const theme = require('../../utils/theme');
const draft = require('../../utils/draft');

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
    total: 0, filled: 0, leaveCount: 0
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
          this.setData({ rows: d.rows, topic: d.topic || '' });
          this._count();
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
    draft.set(this.clsId, { rows: this.data.rows, topic: this.data.topic });
  },
  onHide() { this._saveDraft(); },
  onUnload() { this._saveDraft(); },
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
    const items = rows.map(r => ({
      cls: this.clsId, sid: r.id, score: r.score, tag: r.tag,
      note: r.note, course: r.course, courseId: r.courseId,
      session: this.data.sess
    }));
    const leaveTip = this.data.leaveCount ? ('，' + this.data.leaveCount + ' 人请假已跳过') : '';
    wx.showModal({
      title: '保存本次课记录？',
      content: '将为 ' + items.length + ' 名学生保存第 ' + this.data.sess + ' 次课记录' + leaveTip + '。',
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
        let tip = '已保存 ' + out.saved + ' 条';
        if (out.failed) tip += '，' + out.failed + ' 条失败';
        wx.showToast({ title: tip, icon: out.failed ? 'none' : 'success' });
        setTimeout(() => wx.navigateBack(), out.failed ? 1400 : 800);
      }
    });
  },
  noop() {}
});
