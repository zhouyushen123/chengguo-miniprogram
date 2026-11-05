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
| 验证基线 | `npm test` = 304 项同步断言 + 4 项 AI 链路（异步）= **308 项全绿**；`npm run lint` 102 文件 0 提醒；`npm run size` 主包 932 KB / 2 MB（45.5%）；`npm run check` = lint + size + test 一条跑完 |
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

### 学生批量导入（11-05 早，用户要求"表格/拍照导入"）
- **入口**：管理 · 学生 tab 底栏改双按钮「批量导入 + 添加学生」→ 新页 `pages/import`。
- **三条路一个出口 `{ok, students:[{name,gender,parent}]}`**（云函数 `cloudfunctions/stuImport`，**需在开发者工具右键「上传并部署：云端安装依赖」**）：
  - `parseFile`：xlsx/xls 走 `xlsx` 包确定性解析；csv/txt 直接切列；**docx 用 jszip 抽 document.xml 纯文本 → glm-4-flash 抽名单**；微信聊天里收到的表格文件（"线上表格"）用 `wx.chooseMessageFile` 选。
  - `parsePhoto`：纸质名单拍照 → glm-4v-flash 识图抽名单（prompt 强约束：只收 2~20 字中文人名、拿不准留空、同去重）。
  - `ping`：部署后自检 `hasKey`。密钥复用 aiEval 的 `ZHIPU_API_KEY`（同一环境变量，**两个云函数都要配**）。
- **解析纯函数在 `cloudfunctions/stuImport/parse.js`**（不依赖 wx-server-sdk，测试直接 require）；前端预览辅助在 `utils/roster.js`。
- **预览确认制**：识别结果先进预览清单（可勾选），班内已有同名默认不勾并划线提示「班内已有已有同名」；导入时逐条 `db.students.create`（学号自动分配、同家长号码自动归并）。
- **权限**：页面 onLoad 校验 `student.write`；班级下拉只列 `db.auth.canSeeClass` 的班（老师只能导进自班）。
- **体积红线**：文件/照片 base64 上限 4MB（约 3MB 原文件），前端选文件时就拦 3MB。
- 守卫：`tests/verify_import.js` 12 项（表头列名识别含「家长姓名 vs 姓名」坑、序号清洗、班级名行剔除、AI 烂输出防御、重名标记、批量落库）。

### 成绩单批量录入（11-05 午，方案三选一先落 P0）
- **场景**：老师上课没空单个录，课后凭记忆补全班——单人录 45 次没人坚持得下来。整体方案（已和用户对齐）：一个入口三条路 = ①成绩单模式（P0，本次已做）②口述模式（P1，微信同声传译插件已在 app.json 注册）③照片分拣（P2）。
- **页面 `pages/batch`**：班级页新按钮「成绩单批量录入本次课」。一屏一列学生：等级 chips（默认**沿用上次课**的等级/分数，显示"沿用上次"小标，点过即改）+ 评语 input（可空）+ **长按行标记请假**（请假的不落库、结清不算未录）。
- **AI 一键全班评语**：顶部填一次「本课主题」→ aiEval 云函数 `action:'batch'`（glm-4-flash 纯文本，输入=姓名+等第+上次评语，输出严格 JSON 数组，剥 ```json 围栏容错）。**前端每 10 人一批串行调用**（防云函数超时），进度条显示"第 x-y / N 人"；没对上号的返回 null 留空让老师手写。
- **批量落库 `db.records.batch(items)`**：一个事务逐条跑单条 recordSave（权限/校验/课次/消课全复用单条口径），提交一次写盘；**单条业务失败只记账不连累整批**（saved/failed 分开报），落盘失败事务整体回滚。归当前课次，支持逐条传 session 补录。
- **草稿保护 `utils/draft.js`**：修改即存本地（按班级隔离），重进询问恢复，保存成功清掉。页面不碰 storage 的守卫规则由这个工具层文件满足。
- 守卫：`tests/verify_batch.js` 10 项（批量落库/消课/部分失败/家长拒绝/课次闭环/补录/草稿隔离）。
- **待办**：aiEval 云函数改过（加 batch），**需在开发者工具重新「上传并部署：云端安装依赖」**才能用 AI 批量评语；不部署只影响 AI 按钮，成绩单本身可用。

### 课次结清（11-05 早，用户提出"同一节课分两天录没有节点概念"）
- **模型**：班级加 `session`（当前是第几次课，从 1 起），`schema.VERSION` 6 → **7**；每条记录落库时盖上班级当前课次（补录可显式传更早课次，未来课次拒绝）。老数据升级按「同班同一天 = 同一课」补算（`schema.assignRecordSessions`，幂等），班级 session 对齐最新一课，行为无感。
- **节点由老师手动结清推进，不再按自然日切换**：班级页「今日录入」→「第 N 次课 · 本次录入」，三状态/待发布数全部按课次算——同一节课两个老师分两天录，第二天不再误报未录。
- **结清 = `db.records.settle(clsId)`**：发布本课次全部未发布记录（逐条过 record.send，denied 如实报）+ 课次 +1，一个事务失败整体回滚。**不要求全员录完**（请假/缺席直接略过，本次没有记录）；空课次也能结清（这周没上课直接跳过）。权限 = `record.create`（能录才能结清）。
- **补录切换**：录入页班级结清过（session>1）才显示「归入课次」picker，默认本次，可改选更早课次；编辑记录永远保留原课次。
- 首页「今日未录入」→「本次未录入」（口径：学生任一所在班的当前课次没记录）；学生页记录行展示「第 N 课」；班级记录筛选加「课次」picker（并列于日期/等级）。
- 守卫：`tests/verify_session.js` 16 项（盖课次/结清/空白批次/补录边界/跨天不串课/编辑不改课次/家长无权/迁移幂等/混合数据安全）。

### 全站统一头像（11-05 早，用户要求"全小程序统一"）
- **口径（唯一，写在 `components/ava/ava.js`）**：①有真实照片（上传缩略图 / 微信头像同步）→ 显示照片；②没有 → 色块（品牌渐变）+ 白色姓名首字。任何页面不得私拼头像块。
- **组件 `components/ava`**，app.json 全局注册为 `<ava>`；props：`src`（照片）、`name`（取首字）、`size/radius`（rpx）、`tone`（brand=老师 / owner=负责人与管理员（蓝）/ parent=家长（绿），色值沿用原 mgr 配色）。
- **覆盖五页七处**：student 个人卡、teacher 个人卡、mine 名片、index 家长端孩子卡、mgr（学生列表×2 + 成员列表）。守卫测试 `verify_ava.js` 断言这五页必须用 `<ava>` 且不得残留 `stuava`/`pav`/`tava` 私拼。
- **人员（老师/家长/管理员）新增 photo 档案字段**：`schema.normalizeMember/normalizeUser` 带 `photo`；`memberUpdate` 写 photo 时同步冗余到 user 表（与 name 同一套事务）；`memberView` 对外暴露。学生本就有 `photo`。
- **微信头像同步**：mgr 成员表单新增头像行——点头像 `chooseMedia` 上传，或点「用微信头像」按钮（`open-type="chooseAvatar"` 头像填写能力），两条路都经 `media.persist` 转存。学生表单大头像占位从白色相机图标改为"色块+首字"，相机改右下角小角标。

### 工程门禁与文案（11-04 晚）
- **CI 门禁（原 P0-3，已完成）**：`deploy.yml` 拆成 `verify` → `upload` 两段。`verify` 跑 `npm run lint` / `npm test` / `npm run size`，红一条就不上传；`upload` 需要 `needs: verify`。加了 `concurrency: deploy-mini-<ref>`（同一分支取消旧运行，避免倒序发布），`pull_request` 只跑门禁不发版（`if: github.event_name != 'pull_request'`）。
- **主包体积检查**：新增 `tools/size.js`（`npm run size`）。按 `project.config.json` 的 `packOptions.ignore` + 固定排除（`.git/.github/.workbuddy/node_modules/cloudfunctions/隐藏项`）复算，80% 提示、超 2MB 直接 `exit 1`，`--list` 打印 Top 10。当前 885.1 KB / 43.2%，最大单文件是 `utils/demo-data.js` 47.8 KB。
- **送达文案去误导（原 B-2，已完成）**：`发送给家长` → `发布到家长端`、`已发送/待发送` → `已发布/待发布`（cls / records / student / record 四个页面的 js + wxml，共 12 处），弹窗改成"对家长开放可见"的说法，并在录入页与记录列表各加一条 `.note`：**"发布后家长打开小程序即可看到，目前不会收到微信消息通知。"** `sent` 字段语义与权限规则一个字没动。新增架构守卫断言：`pages/` `components/` 的 js/wxml 里再出现 `已发送 / 待发送 / 发送给家长` 就红——**接通订阅消息后要连同这条断言一起反转**。

### 新手引导（11-04 深夜，用户提的"一进来是空的像烂东西"）
- **痛点是第一印象**：全新安装时首页是三块 0 加一片空白，看起来像坏掉的程序。用户要求把「机构入驻 → 学期 → 班级 → 学生」做成一条引导线。
- 新页面 `pages/setup`（开通向导）：四步一页走完，顶部四段进度条，每步一句问句 + 只问必填项（机构名/类型/联系人/手机 → 学期名+起止日期 → 班级名+第一门课程（默认同名）+上课方式 → 学生姓名可连续加）。每步落库失败就停在原地报原因，不吞错。任意一步可「稍后再说」直接到完成页；完成页给摘要 + 「录入第一条成果」（带好 cls/sid 跳录入页）。
- 默认值省输入：学期名按当前月份推（3–8 月开春季，9 月到次年 2 月算秋季）、起止日期默认今天起半年、班级名按机构名给出建议值。
- **首页空态换脸**：`empty = 没学生且没记录`（班级空壳不算）；此时不显示"开始录入"和三块 0，改显示 `.onboard` 开通卡（四步说明 + 开始开通 + 先看示例数据）。首次进入自动跳一次向导，跳过后只在首页留卡片（标记走 `utils/firstrun.js`——页面不许直接碰本地存储）。
- **出厂数据清干净**：`migrate.buildFresh(stamp, {sample:false})` 让真实新库不再自带「书法班/素描班/楷书/素描」；示例内容只留给演示数据包（`maintenance.buildDemoData` 仍用默认 sample:true）。内置「长期班」学期保留（历史数据兜底）。
- **真·初始状态（11-04 二次清理）**：真实新库只留「1 个机构 + 1 个负责人（姓名为空）+ 内置长期班 + 默认评价模板」，实测落盘 2 KB / 12 个 key。三处"测试痕迹"已删：①出厂姓名不再叫「测试老师」（空串，页面兜底显示「老师」）；②不再生成「家长演示」这个假成员（`buildFresh(stamp,{demoParent:true})` 只给演示包用）；③**演示数据包改为「点了才建」**——以前每次安装都往手机写 12 个 `chengguo_demo_*` key，现在只有用户点「看演示数据」时才生成，启动阶段仅当磁盘上已有包（含老版本需重建）或本次升级要把人送进演示时才备好。
- **改名**：向导第 1 步提交时，若当前成员名还是出厂的「测试老师」，自动换成他填的联系人（`db.members.update`，失败不影响流程）。
- 测试：新增 `tests/verify_onboard.js`（18 项，从空库起步跑到完成页）；`verify_term` / `verify_perm` 里"全新安装有 2 个默认班"的断言随产品决策改为"不带示例班"。总数 255 → **287**（含 11-04 新增的手机号套件 12 项）。

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
7. **真实新库不许带示例内容**：`migrate.buildFresh(stamp, {sample:false})` 是真实安装走的路，示例班级/课程只给演示数据包。想让首次体验更有内容，改首页的开通卡和向导（`pages/setup`），不要往真实库里塞假数据——用户分不清"示例"和"别人剩的"。
8. **空库判定看学生，不看班级**：`empty = 没有学生 && 没有记录`。班级可能是空壳（向导中途退出就会留下），拿它判断会把新用户误判成老用户。

---

## 3. 待办（按阻塞关系排序）

### A. 需要用户在微信开发者工具 / 后台操作
> 资质进度（11-04 用户截图）：**微信认证已完成**（云开发门槛已过）；小程序备案管局审核中（只挡提审发布，不挡开发）。
> 云开发已开通（11-04 22:33），环境 ID **`cloud1-d9gca4e7q307c4564`**，已填进 `utils/api.js`，`CLOUD_ENABLED` 默认 true。剩下只有「部署 aiEval + 配 Key」两步（见下 2~4），完成后 ping 自检。
> ⚠️ `SYNC_ENABLED` 仍为 false：`pushRecord` / `pull` / `uploadFile` 一律空转，因为 sync 云函数还是旧 openid 模型（CR-005）。**AI 评不受影响**（`aiEvalDraft` 只要求云通）。
1. ~~云开发环境还没开通~~ ✅ 已开通（免费体验版），ID 已配。
2. ~~部署 `cloudfunctions/aiEval`~~ ✅ 11-04 22:56 部署成功，`{"action":"ping"}` 返回 `hasKey:true`，链路全通。剩余：真机实测 AI 评生成质量，按反馈调 prompt。
5. ~~拿到环境 ID 后改 `api.js`~~ ✅ 已改（`CLOUD_ENV` + `CLOUD_ENABLED=true`）。

### B. 备案 / 认证通过后
> **代码已全部备好（11-05）**，通过后只差配置，不用再写代码：
1. **订阅消息**（唯一官方免费触达）：mp 后台申请教育类目模板 → 把模板 ID 配到 `family` 云函数环境变量 `NOTIFY_TEMPLATE_ID` → 家长端首页自动出现「开启成绩通知」横幅（此前横幅不显示、通知静默跳过，零影响）。
   - 链路：家长授权 → `family/bind` 登记 openid+额度（openid_map 集合）→ 老师发布/结清 → `family/send` 按学生找家长发订阅消息。
   - 模板字段名与申请到的不一致时，只需改 `cloudfunctions/family/index.js` 里 `send` 的 `data` 结构。
   - 接通后要**一起翻转两处**：界面文案改回「已发送」，以及 `tests/verify_arch.js` 的「送达文案」断言（现在它会拦住「已发送」）。
2. **内容安全已上线**（`cloudfunctions/secCheck`）：老师评语（单录+批量，云在线时保存前送检 87014 拦截）、AI 批量评语（aiEval 服务端逐条查，命中置 null）、图片检查能力就绪（`secImage` 未接到媒体上传，等同步链路开了再接）。fail-open：安全接口抖动不拦业务，只拦 87014。
   - 部署提醒：`secCheck`、`family` 是新云函数，需在开发者工具「上传并部署：云端安装依赖」；`aiEval` 改过也要重新部署。

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
pages/index/              首页（空库时显示开通卡 onboard 块）
pages/setup/             开通向导（机构→学期→班级→学生，四步一页）
pages/record/            录入页（AI 评 / 模板 / 语音）
pages/records/           记录列表（发布按钮在此）
pages/teacher/           老师档案（本轮新增）
pages/mine/              我的（统计两行三列）
app.wxss                 全局：.note / .slogan / .vin·.vmic
tools/gen_icons.py       图标生成（三套主题；user 有 gray/ink/white）
tools/size.js            主包体积检查（npm run size；CI 门禁用）
utils/firstrun.js        首次进入的一次性标记（自动跳向导只跳一次）
.github/workflows/deploy.yml  verify（lint+test+size）→ upload 两段门禁
```

---

## 5. 下一步建议（给接手的人）

先做 A 的 1~5（用户 GUI，5 分钟），打通 aiEval 后让老师实测三张真实作业照片，收集评价质量反馈再调 prompt；然后等备案/认证，做 B 的 1（订阅消息），这是产品从"记录工具"变成"能触达家长的工具"的关键一步——B-2 的文案与守卫断言要跟它一起反转。
