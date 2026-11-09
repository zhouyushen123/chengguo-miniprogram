# 预发（staging）环境使用说明

## 背景
目前只有一个云开发环境（生产），云函数改动直接上线，真机验证全靠体验版。
拉真实用户前应加一道预发闸：先在 staging 部署验证，再上生产。

## 开环境（一次性，控制台手动）
1. 微信开发者工具 → 云开发 → 左上角环境下拉 →「创建新环境」，命名如 `chengguo-staging`；
2. 复制新环境的完整 ID（形如 `chengguo-staging-xxxxx`）；
3. 新环境里要建同名集合（首次部署云函数后由 `ensureCollections` 自动补建大部分）；
4. 给 `aiEval` 配置同样的环境变量 `ZHIPU_API_KEY`（函数配置 → 环境变量）。

## 用法
```bash
# 部署全部函数到预发
npm run cloud -- --env chengguo-staging-xxxxx

# 只部署改过的函数到预发
npm run cloud -- syncv2 --env chengguo-staging-xxxxx

# 看预发的函数清单/超时
npm run cloud:ls -- --env chengguo-staging-xxxxx
npm run cloud:info -- --env chengguo-staging-xxxxx
```
也可用环境变量：`WX_ENV=chengguo-staging-xxxxx npm run cloud`。

## 切流验证
小程序客户端仍指向生产（`utils/api.js` 的 `CLOUD_ENV`）。要在预发环境联调，
临时把 `CLOUD_ENV` 改成预发 ID → 上传体验版 → 验证 → **改回生产再发版**。
（不做双环境自动切换：切换开关的复杂度大于「改一行 + 注释」，出错面反而更大。）

## 红线
- **预发数据是可丢的**：不要在预发环境录真实学生数据；
- **发版前必查** `git diff utils/api.js`，确认 CLOUD_ENV 还是生产 ID。
