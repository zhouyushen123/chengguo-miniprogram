// deploy.js —— 小程序自动上传（CI）脚本，基于官方 miniprogram-ci
// 用法：
//   1. npm i miniprogram-ci
//   2. mp.weixin.qq.com → 开发管理 → 开发设置 → 小程序代码上传 → 下载「代码上传密钥」保存为 private.key 放到本目录
//      （同时把 IP 白名单关掉或加入你服务器的 IP）
//   3. 把下面 APPID 换成你的小程序 AppID
//   4. node deploy.js 1.0.<timestamp>   ← 版本号参数可省略
const ci = require('miniprogram-ci');
const path = require('path');

const APPID = 'wx_your_appid'; // ← 必填（CI 下由 deploy.yml 用 Secret 注入）
const KEY_PATH = path.join(__dirname, 'private.key');
const PROJECT_PATH = path.join(__dirname, '..'); // 小程序工程根目录

(async () => {
  if (APPID.startsWith('wx_your')) { console.error('请先把 APPID 改成你的小程序 AppID'); process.exit(1); }
  const project = new ci.Project({
    appid: APPID,
    type: 'miniProgram',
    projectPath: PROJECT_PATH,
    privateKeyPath: KEY_PATH,
    ignores: ['node_modules/**/*', 'deploy.js', 'private.key', '.github/**/*', 'server/**/*', 'README.md']
  });
  const version = process.argv[2] || '1.0.' + Math.floor(Date.now() / 1000);
  try {
    // 上传代码 → 开发版本（后台设置为体验版即可给老师/家长体验）
    await ci.upload({ project, version, desc: '橙果·课后成果记录', setting: { es6: true, minify: true } });
    console.log('✔ 上传成功，版本', version, '→ 到 mp.weixin.qq.com「版本管理」设为体验版/提交审核');
    // 如需机器人自动提交审核，再调用 ci.submitReview({ project, version, ... })
  } catch (e) {
    console.error('✘ 上传失败：', e.message);
    process.exit(1);
  }
})();
