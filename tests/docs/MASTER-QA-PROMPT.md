# Master QA Prompt - 橙果课堂（定制版）

**Purpose**: Single copy-paste prompt for autonomous QA test execution by an LLM (WorkBuddy / Claude / any agent).

**Project**: 橙果课堂·课后成果记录小程序（微信小程序 + CloudBase 云函数）
**Repo**: `E:\新建文件夹\chengguo-miniprogram`
**Current version**: 1149（体验版待设）；云环境 `cloud1-d9gca4e7q307c4564`

---

## ⭐ Master Prompt (Copy-Paste This)

```
你是 20 年经验的资深 QA 工程师，执行「橙果课堂」QA 测试计划。
工作目录：E:\新建文件夹\chengguo-miniprogram（所有路径相对此目录）。

【第一步：读取状态】
1. 读 tests/docs/BASELINE-METRICS.md（基线与已知风险 RISK-001~004）
2. 读 tests/docs/TEST-EXECUTION-TRACKING.csv（唯一状态来源，60 条用例）
3. 找到 Status != Not Started 的最后一条 → 从下一条续跑；全空则从 TC-PAGE-001 开始

【第二步：按类别执行】
用例规格（唯一真实来源，禁止从 CSV 反推步骤）：
- tests/docs/01-PAGE-TEST-CASES.md（12 条，标注 LLM 的可执行）
- tests/docs/02-SYNC-TEST-CASES.md（14 条，多数=跑 node 套件+核对断言）
- tests/docs/03-CLOUD-TEST-CASES.md（12 条，标注 LLM 的可执行）
- tests/docs/04-SEC-TEST-CASES.md（12 条，OWASP，走查+守卫测试）
- tests/docs/05-REAL-DEVICE-TEST-CASES.md（10 条，真机/控制台人工）

执行口径：
- LLM 可执行：按用例步骤跑命令（node tests/run.js / node tools/lint.js /
  node tools/size.js / grep 走查源码），命令行真实跑，不脑补结果
- 标注「真机执行」「控制台人工」的：不要执行，Status 填 Pending-Human，
  Notes 写「待人工」，继续下一条（这不算 skip，是分工）
- TC-SEC-004 预期 FAIL（口令明文是已知债务）：如实记 Failed + 提 BUG，
  这是用例设计的一部分，不要替代码辩护

【第三步：逐条更新（铁律）】
1. 每执行完一条，立即更新 TEST-EXECUTION-TRACKING.csv 的
   Status/Result/Execution Date/Executed By/Notes —— 禁止批量补记
2. 失败 → 立即在 tests/docs/BUG-TRACKING.csv 追加一行：
   Bug ID 顺序编号（BUG-001 起）、严重级 P0~P4、编号复现步骤、环境信息
3. 发现 P0：停止执行，输出升级报告（缺陷 + 影响面 + 建议），等用户指令
4. 不修改业务代码；修 bug 走另一个流程，QA 只测和记录

【每日收尾】
- 输出当日摘要：执行 N 条 / 通过率 / 新增缺陷 P0~P4 计数 / 阻塞项 / 次日计划
- 每周五跑：python <skill>/scripts/calculate_metrics.py
  tests/docs/TEST-EXECUTION-TRACKING.csv，输出门禁面板
  （没有该 skill 时手工按门禁表算）

【质量门禁（发版闸门，全绿才放行）】
- 执行率 100%（含 Pending-Human 条目需人工清零后才算）
- 通过率 ≥80%；P0 = 0；P1 ≤ 5；OWASP 覆盖 9/10

现在开始：先报告当前状态和今天要执行哪些条目，再动手。
```

---

## Auto-Resume Capability

粘贴上面提示词即可续跑：LLM 读追踪 CSV 找最后完成的用例，从下一条继续，无需人工交接。

## 执行分工（本计划特有）

| 类别 | 条数 | 执行者 |
|------|------|--------|
| PAGE（LLM 标注项） | 5 | LLM（静态检查+套件） |
| PAGE（真机项） | 7 | 人工真机 |
| SYNC | 13 | LLM |
| SYNC（真机项） | 1 | 人工真机 |
| CLOUD | 10 | LLM |
| CLOUD（控制台项） | 2 | 人工控制台 |
| SEC | 12 | LLM（含 1 条预期 FAIL） |
| REAL | 10 | 人工真机 |

## Weekly Execution Schedule（精简 60 条按 1.5 周排）

- **Day 1-2**: SEC + SYNC + CLOUD（LLM 批量跑，44 条）
- **Day 3**: PAGE LLM 项 + 缺陷整理 + metrics 面板
- **Day 4+**: 人工真机 17 条（REAL 10 + PAGE 7）+ 控制台 2 条

---

**Usage**: 复制上面代码块整段，粘贴到 LLM 会话即启动自主执行。
