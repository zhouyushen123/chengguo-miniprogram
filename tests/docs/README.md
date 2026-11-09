# QA Documentation - 橙果课堂

**Status**: 🟢 Ready for Execution
**Created**: 2026-11-09
**QA Framework**: Google Testing Standards + OWASP Top 10
**Plan**: 60 条用例 / 精简档 / 1.5 周 / LLM 自主执行 + 真机人工分工

---

## 📋 Quick Start

### Option 1: Autonomous Execution (Recommended)
复制 `MASTER-QA-PROMPT.md` 代码块整段 → 粘贴到 LLM 会话 → 自动执行 43 条 LLM 用例。

### Option 2: Manual Execution
1. 读本文档 + `BASELINE-METRICS.md`（基线与风险 RISK-001~004）
2. 从分类文档读用例步骤（唯一真实来源）
3. 每测完一条立即更新 `TEST-EXECUTION-TRACKING.csv`

---

## 📚 Document Index

### 基线与状态
- `BASELINE-METRICS.md` — 基线快照（46 套件绿 / lint 0 / 主包 62% / OWASP 8/10）
- `TEST-EXECUTION-TRACKING.csv` — **执行状态唯一来源**（60 条）
- `BUG-TRACKING.csv` — 缺陷清单（P0~P4）
- `templates/WEEKLY-PROGRESS-REPORT.md` — 周报模板

### 测试用例（权威来源，AAA 格式）
- `01-PAGE-TEST-CASES.md` — 页面与路由（12）
- `02-SYNC-TEST-CASES.md` — 同步复制（14）
- `03-CLOUD-TEST-CASES.md` — 云函数 API（12）
- `04-SEC-TEST-CASES.md` — OWASP 安全（12）
- `05-REAL-DEVICE-TEST-CASES.md` — 真机人工（10）

### 自动化
- `MASTER-QA-PROMPT.md` — LLM 自主执行主提示词（定制版）

---

## 🎯 Quality Gates（发版闸门）

| Gate | Target | 状态 |
|------|--------|------|
| 执行率 | 100%（含人工项清零） | ⏳ |
| 通过率 | ≥80% | ⏳ |
| P0 缺陷 | 0 | ✅ 暂无 |
| P1 缺陷 | ≤5 | ⏳ |
| OWASP 覆盖 | 9/10 | ⏳（A02 待 M-2） |

门禁计算：`python <qa-testing skill>/scripts/calculate_metrics.py tests/docs/TEST-EXECUTION-TRACKING.csv`

---

## 分工与节奏

- **Day 1-2**: LLM 跑 SEC/SYNC/CLOUD + PAGE 静态项（43 条）
- **Day 3**: 缺陷整理 + metrics 面板
- **Day 4+**: 人工真机 17 条（⭐ TC-REAL-003 新班补齐 / TC-REAL-004 冲突找回为核心验证点）+ 控制台 2 条

**铁律**: 用例文档 = 步骤权威；CSV = 只记状态；缺陷必须有编号复现步骤；P0 发现即停即报。
