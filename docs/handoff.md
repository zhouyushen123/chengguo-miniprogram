# 接续档案 · 橙果课堂小程序

> **接续话术**：新会话第一句让 AI 读本文件即可 ——
> 「橙果项目继续。先读 `E:\新建文件夹\chengguo-miniprogram\docs\handoff.md`，再按里面的待办往下做。」
> 本文件路径固定（不带日期），内容随进度更新，git 历史保留旧版本。
> 维护规则：每完成一批功能就更新「已完成/待办」，不要覆盖历史结论；过期项标注「已完成/已废弃」。

---

## 0. 仓库与环境

| 项 | 值 |
|---|---|
| 代码仓库 | `E:\新建文件夹\chengguo-miniprogram`（唯一克隆，分支 main） |
| 远程 | `git@github.com:zhouyushen123/chengguo-miniprogram.git` |
| 我的工作区 | `C:\Users\zhouy\WorkBuddy\橙果`（只放记忆，不放代码） |
| 技术栈 | 微信原生小程序（JS）+ 云开发目录 `cloudfunctions/` |
| 验证基线 | `npm test` = 251 项同步断言 + 4 项 AI 链路（异步）= **255 项全绿**；`npm run lint` 87 文件 0 提醒；`npm run size` 主包 885.1 KB / 2 MB（43.2%）；`npm run check` = lint + size + test 一条跑完 |
| 提交习惯 | 沙箱常拦 `git push`（读不到 `~/.ssh`），仓库有「5 分钟自动同步」任务会以 `auto: 自动同步 时间戳` 提交并推送 |

---

## 1. 这一轮（11-03 ~ 11-04）已完成

### 数据模型
- **学号**：学生实体新增 `no`（纯数字、机构唯一、1001 起递增、删除不复用），`schema.VERSION` 5 → **6**；老数据由 `schema.assignStudentNos()` 按 id 升序补号，接入 `upgrade()`、v2 遗留构建、演示数据构建三条路径。
- **家长归并**：家长标识 = 学生的 `wechat` 字段（去空格/短横、转小写后比较；空值不参与比较）。`students.studentLinkParents()` 在学生建档/改档后自动把该生挂进"同号码家长"的成员账号；`identity.expandKidIds()` 在家长勾孩子时自动带齐兄弟姐妹。
- **成员档案字段**：`member` 增 `phone` / `wechat`（选填）；`memberView` 透出；**`memberCreate` 的字段白名单必须同步加新字段**（漏过一次，导致落库静默丢失，已被测试盯住）。

### 新页面
- `pages/teacher`（老师档案）：个人卡 + 四项统计 + 联系方式（手机可拨、微信可复制）+ 负责班级 + 负责课程 + 最近成果。入口 = 管理页「人员」页签点成员卡。

### AI 评价草稿（新增能力）
- 云函数 `cloudfunctions/aiEval`：直连 `https://open.bigmodel.cn/api/paas/v4/chat/completions`，模型 `glm-4v-flash`，零第三方依赖（只用 `https` / `wx-server-sdk`）。
- 密钥：**只读 `process.env.ZHIPU_API_KEY`**，绝不写进代码或前端。`{ action: 'ping' }` 返回 `hasKey` 用于自检。
- 图片双通道：`fileID`（云存储下载转 base64）/ `imageBase64`（前端压缩兜底）；base64 上限 4MB。
- **关键坑（已修）**：图片 `data:` 前缀的 MIME 必须与真实内容一致，否则智谱报 `1210 图片格式/解析错误`。现由 `mimeOf()` 按 base64 魔数识别 PNG/JPEG/WEBP。
- 前端：录入页「AI 评」按钮 → `api.aiEvalDraft()` → 回填评价输入框；已有评价先弹确认覆盖；`aiBusy` 防连点；错误按 `code`（`NO_KEY` / `CLOUD_OFF` / 超时）映射中文提示。
- 实测结论（2026-11-04）：Key 鉴权、`glm-4-flash` 文本、`glm-4v-flash` 识图、云函数完整链路（本地桩 wx-server-sdk）全部通过，生成文本质量可用。

### 视觉 / 交互（用户逐条提的，均已落地）
- 全局 `.note` 淡黄说明条，全 App 解释类文字统一（空态提示不套）。
- slogan 定稿：**「橙果 · 让每一次进步都被看见」**，`.slogan` 收进 `app.wxss` 全局居中。
- 导航栏/窗口底色 `#ffffff` / `#f7f6f3` → **`#FAF9F7`**（与默认主题 `--bg` 一致，消除顶部白断层；换主题时原生导航栏跟不上，已知限制）。
- 我的页统计：5 项一行 → **两行三列 6 维**（上行 学生/家长/老师，下行 班级/课程/学期）；学期项 manager-only，点按走 `data-k` 分流到 `/pages/terms/terms`。
- 弹层：`.sheet` 高度统一 **94vh**；**标题去掉 sticky 吸顶改普通流式**（吸顶会在拉键盘后把第一行输入框永久压在标题下）。
- 学期日期三处改 `picker mode="date"`（未选默认今天）；`onF` / `onWzTerm` 直接兼容 picker 事件。
- 头像占位：无照片 → 浅底 + 人形剪影（`user-gray`）；老师档案渐变色底 + `user-white`（`tools/gen_icons.py` 的 `user` 配色组合已加 `white`）。
- 记录列表：姓名/课程/分数行**通栏**，照片下移到与评价同行、在评价左侧（原来照片占整卡左侧把姓名挤成竖排）。
- 班级条目：圆形色块 → 8×52rpx 品牌渐变圆角竖杠；学生条目：色块 → 头像缩略图。

### 工程门禁与文案（11-04 晚）
- **CI 门禁（原 P0-3，已完成）**：`deploy.yml` 拆成 `verify` → `upload` 两段。`verify` 跑 `npm run lint` / `npm test` / `npm run size`，红一条就不上传；`upload` 需要 `needs: verify`。加了 `concurrency: deploy-mini-<ref>`（同一分支取消旧运行，避免倒序发布），`pull_request` 只跑门禁不发版（`if: github.event_name != 'pull_request'`）。
- **主包体积检查**：新增 `tools/size.js`（`npm run size`）。按 `project.config.json` 的 `packOptions.ignore` + 固定排除（`.git/.github/.workbuddy/node_modules/cloudfunctions/隐藏项`）复算，80% 提示、超 2MB 直接 `exit 1`，`--list` 打印 Top 10。当前 885.1 KB / 43.2%，最大单文件是 `utils/demo-data.js` 47.8 KB。
- **送达文案去误导（原 B-2，已完成）**：`发送给家长` → `发布到家长端`、`已发送/待发送` → `已发布/待发布`（cls / records / student / record 四个页面的 js + wxml，共 12 处），弹窗改成"对家长开放可见"的说法，并在录入页与记录列表各加一条 `.note`：**"发布后家长打开小程序即可看到，目前不会收到微信消息通知。"** `sent` 字段语义与权限规则一个字没动。新增架构守卫断言：`pages/` `components/` 的 js/wxml 里再出现 `已发送 / 待发送 / 发送给家长` 就红——**接通订阅消息后要连同这条断言一起反转**。

---

## 2. 刻意的设计与约定（改之前先看这里）

1. **`sent` 只是本地状态，不是真实送达**。全仓零 `subscribeMessage` / 客服消息 / 短信调用。所以「已发布」目前只代表"老师这边标记完毕"，家长需自己打开小程序查看。**改文案或接推送前不要动 `sent` 的语义**（权限层 `permissions.js` 的家长可见性依赖它）。
2. **格式化字段不配麦克风**：手机号、微信号、生日、日期、邀请码——语音识别产出自然语言，填不进格式化字段。
3. **家长标识只有 `wechat` 一个字段**，学生实体没有独立家长手机号；两个都没填号码的学生不会被误判成一家人。
4. **云开关拆成两个**：`CLOUD_ENABLED`（默认 true，控 `wx.cloud.init`；`CG_CLOUD=0` 可强制关）与 `SYNC_ENABLED`（默认 false，控 `pushRecord/pull/uploadFile`）。开云 ≠ 开同步——sync 云函数模型没对齐前，记录只在本地，这是刻意的，不要为了"看上去更完整"打开它。
5. **测试编排两个坑**：
   - `verify_pages.js` 里「重启：数据持久化」用例会清 db 模块缓存重建实例，**新用例必须放在它之前**，否则页面模块拿旧快照查不到新数据；
   - 异步测试不能包进"注册时不等待"的包装函数（mock 同步 resolve 会竞态），必须纯顺序 `await`，且放文件末尾 IIFE + `process.exit(1)` 兜底。
6. **版本号断言一律引用 `schema.VERSION`**，不要再硬编码数字。

---

## 3. 待办（按阻塞关系排序）

### A. 需要用户在微信开发者工具 / 后台操作
> 资质进度（11-04 用户截图）：**微信认证已完成**（云开发门槛已过）；小程序备案管局审核中（只挡提审发布，不挡开发）。
> 云开发已开通（11-04 22:33），环境 ID **`cloud1-d9gca4e7q307c4564`**，已填进 `utils/api.js`，`CLOUD_ENABLED` 默认 true。剩下只有「部署 aiEval + 配 Key」两步（见下 2~4），完成后 ping 自检。
> ⚠️ `SYNC_ENABLED` 仍为 false：`pushRecord` / `pull` / `uploadFile` 一律空转，因为 sync 云函数还是旧 openid 模型（CR-005）。**AI 评不受影响**（`aiEvalDraft` 只要求云通）。
1. ~~云开发环境还没开通~~ ✅ 已开通（免费体验版），ID 已配。
2. 部署 `cloudfunctions/aiEval`（右键 → 上传并部署：云端安装依赖）。
3. 云开发控制台 → 云函数 → aiEval → 配置 → 环境变量加 `ZHIPU_API_KEY`（值由用户自己粘贴，**不要写进任何文件**）；**超时时间默认 3 秒不够，改 30 秒**。
4. 部署后云端测试 `{"action":"ping"}` 应返回 `hasKey: true`。
5. ~~拿到环境 ID 后改 `api.js`~~ ✅ 已改（`CLOUD_ENV` + `CLOUD_ENABLED=true`）。

### B. 备案 / 认证通过后
1. **订阅消息（唯一官方免费触达）**：申请教育-培训机构类目模板 → 云函数发 `subscribeMessage.send` → 家长端首次进入弹订阅授权。**这是「真正送达」的唯一正路。**
   - 接通后要**一起翻转两处**：界面文案改回「已发送」，以及 `tests/verify_arch.js` 的「送达文案」断言（现在它会拦住「已发送」）。
2. P1-9 `msgSecCheck` / `imgSecCheck`：全仓零调用，属 UGC，提审前必须处理（AI 生成的评价同样要走审核）。

> 已完成并从本清单移除：~~发送文案去误导~~、~~CI 测试门禁（P0-3）~~ → 见 §1「工程门禁与文案」。

### C. 技术债
- `utils/demo-data.js` 2367 行仍在主包内（体积没超，属整洁问题）。
- 图标 webp 化未做。
- 智谱 Key 目前出现在聊天记录里，**上线前建议作废重建**，只配在云函数环境变量。

---

## 4. 关键文件地图

```
utils/db/schema.js       实体规范化 / 校验 / VERSION / assignStudentNos
utils/db/students.js     studentCreate|Update|Remove / no 生成 / studentLinkParents
utils/db/identity.js     memberCreate|Update|View / expandKidIds（家长归并）
utils/db/records.js      markSent（本地状态）/ cid 别名（cid|cls|clsId）
utils/db/storage.js      分片 + 脏片写（djb2 指纹，只写变化片）
utils/api.js             云开关 / callSync / aiEvalDraft
cloudfunctions/aiEval/   AI 识图生成评价（ZHIPU_API_KEY）
cloudfunctions/sync/     记录与学生资料上推
pages/record/            录入页（AI 评 / 模板 / 语音）
pages/records/           记录列表（发布按钮在此）
pages/teacher/           老师档案（本轮新增）
pages/mine/              我的（统计两行三列）
app.wxss                 全局：.note / .slogan / .vin·.vmic
tools/gen_icons.py       图标生成（三套主题；user 有 gray/ink/white）
tools/size.js            主包体积检查（npm run size；CI 门禁用）
.github/workflows/deploy.yml  verify（lint+test+size）→ upload 两段门禁
```

---

## 5. 下一步建议（给接手的人）

先做 A 的 1~5（用户 GUI，5 分钟），打通 aiEval 后让老师实测三张真实作业照片，收集评价质量反馈再调 prompt；然后等备案/认证，做 B 的 1（订阅消息），这是产品从"记录工具"变成"能触达家长的工具"的关键一步——B-2 的文案与守卫断言要跟它一起反转。
