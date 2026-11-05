const db = require('../../utils/db');
const theme = require('../../utils/theme');
const voice = require('../../utils/voice');
const tel = require('../../utils/phone');

Page({
  data: { fields: [
    { k: 'nick', label: '昵称', ph: '孩子的小名' },
    { k: 'birth', label: '生日', ph: '如 2018-06-01' },
    { k: 'school', label: '学校/班级', ph: '如 实验小学一年级' },
    { k: 'phone', label: '联系电话', ph: '11 位手机号', type: 'number' },
    { k: 'wechat', label: '微信号', ph: '方便老师联系' },
    { k: 'level', label: '当前水平', ph: '如 已学 1 年' },
    { k: 'goal', label: '学习目标', ph: '如 考级/兴趣培养' },
    { k: 'note', label: '备注', ph: '其他需要老师了解的信息' }
  ], f: {} },
  onShow() { theme.apply(this); },

  onLoad(q) {
    this.sid = +q.id;
    const s = db.students.get(this.sid);
    const p = (s && s.profile) || {};
    this.setData({ f: { nick: p.nick || '', birth: p.birth || '', school: p.school || '', phone: p.phone || '', wechat: p.wechat || '', level: p.level || '', goal: p.goal || '', note: p.note || '' } });
  },
  onInput(e) {
    const f = Object.assign({}, this.data.f);
    const k = e.currentTarget.dataset.k;
    // 手机号输入中只放裸数字（type="number" 容不下 "-"，真机边输边格式化会调乱），失焦再分段
    f[k] = k === 'phone' ? tel.digits(e.detail.value) : e.detail.value;
    this.setData({ f });
  },
  onPhoneBlur() { this.setData({ 'f.phone': tel.fmt(this.data.f.phone) }); },
  submit() {
    const f = this.data.f;
    const ph = tel.digits(f.phone);
    if (ph && !/^1\d{10}$/.test(ph)) { wx.showToast({ title: '手机号需 11 位、1 开头', icon: 'none' }); return; }
    f.phone = ph;
    const r = db.students.updateProfile(this.sid, f);
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    // 家长填写的是孩子资料，属于学生实体的 profile 字段，一并推云端
    require('../../utils/api').pushRecord({ type: 'profile', sid: r.item.id, profile: r.item.profile });
    wx.showToast({ title: '资料已提交', icon: 'success' });
    setTimeout(() => wx.navigateBack(), 800);
  },
  // 语音输入：点输入框右端的麦克风说话，再点一次结束
  onMic(e) { voice.dictate(this, e.currentTarget.dataset.k); },
  onHide() { voice.stop(this); }
});
