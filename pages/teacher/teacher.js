const db = require('../../utils/db');
const theme = require('../../utils/theme');
const icons = require('../../utils/icons');

// 评价分档配色：与学生档案页同一套（优秀/最佳绿、良好橙、加油/待提高蓝灰）
const TAG_GOOD = ['优秀', '最佳'];
const tagCls = t => !t ? '' : TAG_GOOD.indexOf(t) > -1 ? 'good' : t === '良好' ? 'mid' : 'low';

Page({
  data: {
    m: null,          // 老师视图（姓名/角色/负责班级/联系方式），null = 未找到
    stats: null,      // 班级/课程/学生/成果 四项统计
    clsList: [],      // 负责班级（名称 + 模式 + 人数）
    crsNames: [],     // 负责课程名
    recent: [],       // 最近成果（最多 10 条）
    recTotal: 0,      // 成果总数
    icoUser: icons.userWhite
  },

  onLoad(o) { this.mid = +o.id || 0; },
  onShow() { theme.apply(this); this.refresh(); },

  refresh() {
    const m = db.members.get(this.mid);
    if (!m) { this.setData({ m: null, stats: null, clsList: [], crsNames: [], recent: [], recTotal: 0 }); return; }
    const v = db.members.view(m);

    // 负责班级：走权限过滤后的班级列表再按成员的 clsIds 取交集
    const stuAll = db.students.list();
    const clsList = db.classes.list()
      .filter(c => m.clsIds.indexOf(c.id) > -1)
      .map(c => ({
        id: c.id,
        name: c.name,
        modeLabel: db.classes.mode(c.id) === 'carry' ? '课时结转' : '学期制',
        stuN: stuAll.filter(s => (s.clsIds || []).indexOf(c.id) > -1).length
      }));
    const crsList = db.courses.list().filter(c => m.courseIds.indexOf(c.id) > -1);
    const stuN = stuAll.filter(s => (s.clsIds || []).some(cid => m.clsIds.indexOf(cid) > -1)).length;

    // 成果记录：tid = 录入老师（user id），配合当前身份的可见性过滤
    const recs = db.records.list().filter(r => r.tid === m.userId);
    const recent = recs.slice(0, 10).map(r => ({
      id: r.id, course: r.course, date: r.date, score: r.score,
      stuName: db.students.name(r.sid), tag: r.tag, tcls: tagCls(r.tag)
    }));

    this.setData({
      m: {
        name: v.name, roleLabel: v.roleLabel,
        photo: v.photo,
        clsText: v.clsText,
        phone: v.phone, wechat: v.wechat
      },
      stats: { clsN: clsList.length, crsN: crsList.length, stuN, recN: recs.length },
      clsList,
      crsNames: crsList.map(c => c.name),
      recent,
      recTotal: recs.length
    });
  },

  // 手机号行整行可点：直接拨打
  callPhone() {
    if (this.data.m && this.data.m.phone) wx.makePhoneCall({ phoneNumber: this.data.m.phone });
  },
  // 微信号行整行可点：复制到剪贴板（系统自带「已复制」提示）
  copyWechat() {
    if (this.data.m && this.data.m.wechat) wx.setClipboardData({ data: this.data.m.wechat });
  }
});
