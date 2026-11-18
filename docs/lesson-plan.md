# 课次（Lesson）功能方案 · 定稿

> 2026-11-12 · 状态：P1 已实施（门禁全绿），P2/P3 待做；行为规则即本文件第二节以下内容
> 经八轮讨论/复盘收敛，本文件为完整可实施设计；末尾附历轮决策记录。

## 〇、六项决策一览（全部已定）

| # | 问题 | 决策 |
|---|---|---|
| 1 | 课次挂哪 | 纯课程维度 + 挂学期（termId），seq 在"课程+学期"内计数 |
| 2 | 时间段 | 可选、结构化存储（weekday + start/end），为学生排课匹配预留 |
| 3 | 编辑已确认课次 | 方式 C：保持已确认 + contentEditedAt 打"有更新"标记 |
| 4 | 录入页快捷新建 | 弹窗（日期/课题/内容），不中断录入 |
| 5 | 学期计数 | 期班随学期归档重开；长期班挂内置「长期班」，按年节点自建学年学期 |
| 6 | 序号机制 | C'：seq 存储值 + 检测错乱时一键重排 |

## 一、数据模型

### `lessons` 课次（新增集合：本机 + 云端，参与同步）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | int | core.nextId()（时间戳单调递增，复用现有机制） |
| `orgId` | string | 归属机构 |
| `courseId` | int | 课程 id |
| `termId` | int | 学期 id（期班=所在学期；长期班=内置「长期班」；归档学期课次随之只读） |
| `seq` | int | 第几次课（同一 courseId+termId 内递增，1 起；存储值 + 一键重排，见三.4） |
| `date` | string | 上课日期 YYYY-MM-DD（可选；无日期=大纲型课次） |
| `weekday` | int | 1~7，一律由 date 推导，不手填 |
| `startTime` / `endTime` | string | HH:mm，可选（排课匹配的机器可读预留） |
| `title` | string | 课题，可空 |
| `content` | string | 详细内容/知识点/作业，可空（课后补充） |
| `status` | string | draft 待确认 / confirmed 已确认 |
| `confirmedBy` / `confirmedAt` | int / int(ms) | 确认人与时间，未确认为 0 |
| `contentEditedAt` | int(ms) | 仅内容类字段（date/title/content/时间段）变更时更新；≠updatedAt（同步也会动 updatedAt，会误报） |
| 审计/软删 | — | createdAt / updatedAt / removed / removedAt / removedBy，与现有资产一致 |

### `records` 加一个字段（向后兼容）

- `lessonId`：int，0 = 未关联。老记录按 0 处理，显示"未关联课次"。
- **不存 lessonSeq 冗余**：seq 可经重排变化，冗余会过期；展示时按 lessonId 实时查（本机/云端都是全量小表，成本可忽略）。

## 二、权限（新增动作，登记进 permissions.js 的 ACTIONS）

现有 `course.write` 仅 owner/admin，不满足"老师建课次/确认内容"的需求，故新增：

| 动作 | 角色 | 范围 |
|---|---|---|
| `lesson.write` | owner / admin / teacher | teacher 限 member.courseIds 内的课程（老师可管理课程清单，现有字段）；admin/owner 不限 |
| `lesson.confirm` | owner / admin / teacher | 同上范围；确认 = 软标记，非强制，不影响任何读写 |

- 家长：只读。课次内容随已发送记录对家长可见（P2）。
- 归档学期：lesson.write/confirm 对该学期课次一律拒绝（与"归档学期只读"一致）。

## 三、行为规则

### 1. 添加（单次）
- seq 默认取该课程+学期内**未删除**课次最大值 +1。
- termId 默认当前进行中学期（多个时弹选，与建班级同规则）；无进行中学期挂内置「长期班」。
- weekday 由 date 自动推导。

### 2. 批量生成
- 输入：起始日期 + 每周上课日（周一~周日多选）+ 次数 + 时间段（**可选**）。
- 生成 N 条课次：date 按周规则推算，seq 连续递增，startTime/endTime 批量填入，之后逐次可改。
- 无日期、无课题的空课次（"占位大纲"）也允许直接建，之后补。

### 3. 编辑与删除
- 随时可改（含事后补录），归档学期除外。
- 已确认课次的编辑 → status 不变，更新 contentEditedAt（方式 C）。
- 删除软删；若已有记录关联 → 提示改为"作废"（记录保留，展示回退"未关联"）。

### 4. 序号机制 C'：存储 + 错乱检测 + 一键重排
- **为什么不用派生序号**：①档案漂移——家长上周收到的"第 5 次课"补录后会变"第 6 次"，成绩单编号必须稳定；②多班共课时日期交错，与纯课程维度冲突。
- **错乱检测**：任何添加/改日期后，检查该课程+学期内**有日期**的课次，按（date, startTime, seq）排序若 seq 不单调 → 课次列表顶部提示"序号与日期顺序不一致，按日期重排？"。
- **重排算法**：有日期课次按（date, startTime）排序重编 1..K；无日期课次随后按 createdAt 续编 K+1..；已删除/作废的不参与。
- **重排安全**：records 只存 lessonId，改 seq 不影响任何关联——这是能做"一键重排"的前提。
- 不点不强制；大纲型课次（无日期）不参与检测。
- 删除后的 seq 空洞不自动补，介意空洞用一键重排补齐。

### 5. 老师确认（非强制）
- 课次列表中，该课授课老师看到"待确认"标签 + 一键确认按钮。
- 不确认不影响录入；确认只表示"内容我认了"。
- 已确认 + contentEditedAt > confirmedAt → 显示"已确认 · 内容有更新"；老师可再点确认刷新确认时间（可选动作）。

## 四、页面与交互

### 1. 录入成果页（pages/record）
- 选课程后出现课次下拉：`第 3 次 · 11-12 · 球体明暗`，按 seq 升序。
- 下拉按学期分组：当前学期在前展开，历史学期收起可展开（补录历史课）。
- 默认选中：日期最接近今天的课次；无课次显示"不关联课次"（默认项）。
- **快捷新建弹窗**：列表末尾"＋ 新建本次课"，弹层填日期（默认今天）/课题/内容，保存后自动选中。权限：lesson.write（老师只能给自己管理的课程建）。

### 2. 课程详情页（课次管理主入口）
- 课次区按学期分栏：当前学期展开、历史学期折叠。
- 操作：单次添加 / 批量生成 / 编辑 / 删除（作废）/ 一键重排 / 确认。
- 排课错乱提示条（见三.4）。

### 3. 班级管理页
- 班级每门开设课程旁加"课次"入口 → 同一套课次管理（纯课程维度下班级只是入口）。

## 五、实施清单（P1 ✅ 已完成，动工顺序）

1. `utils/db/schema.js`：normalizeLesson / validate（lessons）+ records 增加 lessonId（默认 0）。
2. `utils/db/entities.js`：登记 lessons 集合（sync: true, idType: num, idGen: stamp 同 records）。
3. `node tools/schema-doc.js` 重新生成数据字典（check 门禁）。
4. `utils/db/lessons.js`：新增领域模块（增删改查/批量生成/重排/确认），依赖 ctx+core+schema，不依赖其他领域模块（守单向规则；termId 取值可读 terms 集合原始数据，与 terms.js planSettle 同款写法）。
5. `utils/db/permissions.js`：登记 lesson.write / lesson.confirm（scoped: courseId）。
6. `cloudfunctions/syncv2/index.js`：COLLS 白名单加 'lessons'（**需重新部署云函数**，部署命令进 handoff）。
7. 页面：课程详情课次区 + 批量生成 + 录入页课次下拉/弹窗 + records 保存带 lessonId。
8. 测试：tools 目录下补课次用例（建/排/重排/确认/权限/归档只读）。

P2：确认流打磨 + 家长端"第 N 次课"展示 + AI 评语提示词带课次课题/内容。
P3：历史记录补挂工具 + 按课次汇总 + 学生排课匹配（weekday+时间结构化查询）+ 多班进度分叉时 class_lesson 覆盖表。

## 六、历轮决策记录（摘要）

- R2-3：纯课程维度、批量带可选时间段、快捷新建弹窗。
- R4：复盘修补 4 处（空洞、去冗余、contentEditedAt、weekday 推导）；方式 C 定稿。
- R5：挂 termId 分情况统一（期班归档/长期班按年节点），零新表。
- R6：发现存储 seq 补录错乱漏洞；提出派生方案（后被否）。
- R7：派生两硬伤（档案漂移、多班日期交错）→ 定 C'（存储+一键重排）。
- R8：全文自洽修缮 3 处、更新失效理由、补归档只读与下拉分组两规则。
- R9（定稿轮）：发现权限缺口（course.write 不含老师）→ 新增 lesson.write/confirm；确认 syncv2 白名单需改+重新部署；本文件定稿。
