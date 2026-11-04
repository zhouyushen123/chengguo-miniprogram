// components/ava/ava.js —— 全站统一人物头像
// 规则（全站唯一口径）：
//   ① 有真实照片（上传的缩略图 / 微信头像同步）→ 显示照片
//   ② 没有照片 → 品牌色渐变色块 + 白色姓名首字
// 尺寸/圆角由使用处传入（rpx），角色色块用 tone 区分（老师=品牌色，负责人/管理员=蓝，家长=绿）
Component({
  properties: {
    src: { type: String, value: '' },      // 照片路径（本地持久路径或临时路径），空 = 无照片
    name: { type: String, value: '' },     // 姓名，取首字做占位
    size: { type: Number, value: 92 },     // 边长 rpx
    radius: { type: Number, value: 30 },   // 圆角 rpx
    tone: { type: String, value: 'brand' } // brand | owner | parent
  },
  data: { char: '', fs: 36 },
  observers: {
    'name,size': function (name, size) {
      const n = (name || '').trim();
      this.setData({
        char: n ? n[0] : '',
        // 字号跟边长走：约 0.4 倍，小到 64rpx 也有可读的首字
        fs: Math.max(22, Math.round(size * 0.4))
      });
    }
  }
});
