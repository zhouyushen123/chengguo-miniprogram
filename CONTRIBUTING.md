# 一起开发橙果小程序

> 给新加入的协作者。2026-11-07 整理。**以本文和 `docs/handoff.md` 为准**：
> `README.md` 是项目早期的架构说明，里面的 `cloudfunctions/sync`、`touristappid`、
> "多机构共享需 V2 扩展"、只建两个集合等内容**均已过时**，别照着做。

## 一、开工前：三样权限

| 要做什么 | 谁给 | 在哪加 |
|---|---|---|
| 读 / 写代码 | 仓库主人 | 仓库是**公开**的，两种参与方式见下 |
| 编译、预览、上传小程序 | 小程序管理员 | mp.weixin.qq.com → 管理 → 成员管理 → 项目成员（开发者），填对方微信号 |
| 云开发（部署云函数、看数据库） | 同上 | 随开发者权限一起生效；云环境跟 AppID 走 |

**推荐：Fork + Pull Request**（不用给写权限，最安全）

1. 打开 https://github.com/zhouyushen123/chengguo-miniprogram → 右上角 **Fork**
2. 改完在自己仓库提 **Pull Request** → 仓库主人 review 后合并

**如果给了 Collaborator**：仓库 Settings → Collaborators → Add people，填对方 GitHub 用户名或邮箱，对方接受邀请后即有 push 权限。此时请注意：

- **push 到 `main` 会触发 GitHub Actions 自动上传小程序开发版**。建议同时在
  Settings → Branches 保护 `main`：要求 PR + 至少 1 人审核 + 状态检查通过。
- 没开保护时，请所有人自觉走「分支 → PR」，别直接推 main。
- GitHub Secrets 里的 `MINI_UPLOAD_KEY` / `MINI_APPID` 不要改、不要打印、不要写进代码。
  Fork 出来的 PR 默认拿不到这两个 secret，所以外部 PR 不会触发上传（这是安全的）。

> 仓库是公开的：任何人都读得到代码。**不要把口令、密钥、token 写进仓库**。

## 二、把项目跑起来

```bash
git clone git@github.com:<你的用户名>/chengguo-miniprogram.git
cd chengguo-miniprogram
npm install        # 只装 miniprogram-ci 等工具依赖，几十秒
npm run check      # 门禁：lint + 结构文档 + 主包体积 + 全量测试
```

`npm run check` 预期看到 `全部 29 个套件通过` 和 `主包 1xxx.x KB`；**红了不要提交**。

微信开发者工具：导入项目 → 目录选**仓库根目录**（`app.js` 就在根上）→ AppID 用真实的
（在 `project.config.json` 里）。工具栏登录的微信号必须是上面加过的开发者，
否则云函数调用会失败。

**预览（最常用，不上传、不占版本号）**：

```bash
npm run preview    # 生成 .preview/qr.png，微信扫码直接跑当前代码
```

如果开发者工具没装在默认路径，用环境变量指定：

```bash
WX_CLI="D:\你的路径\微信web开发者工具\cli.bat" npm run preview
```

## 三、日常改动流程

```bash
git checkout -b feat/xxx      # 别在 main 上直接改
# ……改代码……
npm run check                 # 必须全绿
git add -A
git commit -m "一句话说明改了什么、为什么"
git push -u origin feat/xxx
```

然后到 GitHub 提 Pull Request。**合并请由仓库主人确认**；合并后 CI 会自动上传开发版，
但**不会自动设为体验版**——那一步仍要在 mp.weixin.qq.com 版本管理里人工点一次。

## 四、常用命令

| 命令 | 作用 |
|---|---|
| `npm run check` | 完整门禁，提交前必跑 |
| `npm run preview` | 生成预览二维码，真机看当前代码 |
| `npm run ship` | 门禁 + 上传体验版，版本号自增（仓库主人用） |
| `npm run cloud:ls` | 只看差异：云端有哪些函数、代码需要哪些、谁缺 |
| `npm run cloud` | 串行部署客户端用到的全部云函数（失败自动重试） |

`npm run cloud` 的部署清单**不是手写的**，从 `utils/api.js` 自动推导；新加云函数只要在
`api.js` 里调用一次，脚本就会自动带上。

## 五、几条会咬人的规矩

1. **云环境是共享的生产环境**（`cloud1-d9gca4e7q307c4564`），不是测试库。
   真机调试请用演示模式，**别在真机上点「立即同步」**——会把调试数据推给所有人，
   也可能把本地空库覆盖成别人的数据。
2. **别改 `.release.json`**：由 `npm run ship` 自动维护，手改会让版本号错乱。
3. **架构守卫限制单文件行数**（`tests/verify_arch.js`）。`utils/db/index.js` 等门面文件
   已经贴着上限，加接口时优先压缩注释 / 空行，不要硬塞；守卫红了会写明是哪个模块。
4. **云环境 ID 结尾是 `4564` 不是 `456e`**：抄错报 `ResourceNotFound.Namespace`，
   看着像"环境没开通"。唯一真相在 `utils/api.js` 的 `CLOUD_ENV`。
5. **IDE 里不要同时右键上传多个云函数**：会撞 `ResourceInUse.FunctionName`
   （"请勿重复创建"其实是并发撞车）。用 `npm run cloud`。
6. **CLI 收尾会报 `reg.exe` / `WMIC.exe` 被安全策略拦**：只要前面打印过
   `✔ deploy` / `✔ upload` 就是成功了，别去撤黑名单（这两个程序能改注册表）。
7. **改了 `cloudfunctions/` 必须 `npm run cloud`**：只上传小程序代码，云端函数不会变。
8. **客户端不直连数据库**：所有读写走云函数，集合由 `syncv2.ensureCollections()`
   首次调用时自动建齐，**不需要去控制台手点新建集合**。

## 六、资料索引

| 文件 | 看什么 |
|---|---|
| `docs/handoff.md` | 按时间倒序的开发记录、踩坑与决策，**信息密度最高** |
| `docs/architecture/` | 架构说明 |
| `docs/console-todo.md` | 只能人工在控制台做的事（索引 / HTTP 路径 / 备案 / 体验版） |
| `docs/user-manual.md`、`docs/user-test-cases.md` | 功能说明与验收用例 |
| `tests/` | 29 个套件，行为规格的可执行版本 |
