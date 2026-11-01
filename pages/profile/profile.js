const db = require('../../utils/db');

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
  onLoad(q) {
    this.sid = +q.id;
    const s = db.students.get(this.sid);
    const p = (s && s.profile) || {};
    this.setData({ f: { nick: p.nick || '', birth: p.birth || '', school: p.school || '', phone: p.phone || '', wechat: p.wechat || '', level: p.level || '', goal: p.goal || '', note: p.note || '' } });
  },
  onInput(e) {
    const f = Object.assign({}, this.data.f);
    f[e.currentTarget.dataset.k] = e.detail.value;
    this.setData({ f });
  },
  submit() {
    const f = this.data.f;
    if (f.phone && !/^1\d{10}$/.test(f.phone)) { wx.showToast({ title: '手机号格式不对', icon: 'none' }); return; }
    const r = db.students.updateProfile(this.sid, f);
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    // 家长填写的是孩子资料，属于学生实体的 profile 字段，一并推云端
    require('../../utils/api').pushRecord({ type: 'profile', sid: r.item.id, profile: r.item.profile });
    wx.showToast({ title: '资料已提交', icon: 'success' });
    setTimeout(() => wx.navigateBack(), 800);
  }
});
