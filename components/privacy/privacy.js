// components/privacy/privacy.js —— 微信隐私授权弹窗（全局组件，各页面挂一个）
//
// 【为什么要自定义弹窗】
// 微信要求：使用相机/相册/录音/手机号等隐私接口前，必须先让用户同意《隐私保护指引》。
// 官方只提供「同意」按钮组件（open-type="agreePrivacyAuthorization"），
// 弹窗外观要自己做——所以是组件而不是 wx.showModal（后者无法承载这个按钮）。
//
// 【流程】
// 1. 页面显示时 wx.getPrivacySetting 查是否需要授权 → 需要就弹
// 2. 用户点「同意并继续」→ 微信记录同意，触发 bindagreeprivacyauthorization
// 3. 用户直接点拍照/录音、此前没同意时，微信会走 wx.onNeedPrivacyAuthorization，
//    这里把 resolve 暂存起来，用户点同意后放行，不会卡住他的操作
Component({
  data: { show: false },

  lifetimes: {
    attached() {
      if (wx.onNeedPrivacyAuthorization) {
        wx.onNeedPrivacyAuthorization(resolve => {
          this._resolve = resolve;
          this.setData({ show: true });
        });
      }
    }
  },

  // 页面栈里每个页面都挂了这个组件，只有被显示的那个页面的组件会执行 show
  pageLifetimes: {
    show() { this.check(); }
  },

  methods: {
    check() {
      if (!wx.getPrivacySetting) return; // 低版本基础库不支持，直接放行
      wx.getPrivacySetting({
        success: res => {
          // 已同意过的用户不会再弹（needAuthorization 为 false）
          this.setData({ show: !!res.needAuthorization });
        }
      });
    },
    agree() {
      this.setData({ show: false });
      const r = this._resolve;
      this._resolve = null;
      // 放行此前被拦下的隐私接口（如拍照），buttonId 对应下面的同意按钮
      if (r) r({ buttonId: 'privacy-agree', event: 'agree' });
    },
    reject() {
      this.setData({ show: false });
      const r = this._resolve;
      this._resolve = null;
      if (r) r({ event: 'disagree' });
      wx.showToast({ title: '未同意隐私指引，拍照、录音等功能不可用', icon: 'none' });
    },
    openDetail() {
      if (wx.openPrivacyContract) {
        wx.openPrivacyContract({ fail: () => wx.showToast({ title: '隐私指引尚未发布', icon: 'none' }) });
      }
    },
    noop() {}
  }
});
