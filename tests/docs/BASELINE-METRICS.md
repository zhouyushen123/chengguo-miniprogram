# Baseline Metrics - 橙果课堂

**Date**: 2026-11-09
**Version**: 小程序 1149（体验版待设），云函数 syncv2 / aiEval 已部署
**Purpose**: Pre-QA snapshot for comparison during testing

---

## 1. Test Coverage (Current State)

### Unit / Integration Tests（node tests/run.js）
- **Total Suites**: 46（verify_*.js，含 verify_pull 13 项、verify_sync 28 项、verify_server_guard 16 项、verify_owner_naming 6 项等）
- **Passing**: 46/46（100%）
- **Failing**: 0
- **Coverage**: 无语句级覆盖率工具；以断言数与守卫测试（server_guard 逐条比对前端 ACTIONS 与云端白名单）替代

### E2E Tests
- **Total Tests**: 0（本 QA 计划新增真机人工场景 10 条，见 05-REAL-DEVICE-TEST-CASES.md）
- **Browsers Covered**: 微信开发者工具 + 真机（iOS/Android 待覆盖）

---

## 2. Known Issues (Pre-QA)

### Critical Issues
- 无（Critical-1/Critical-2 已于 1148 修复并配守卫测试）

### Technical Debt（待拍板，未修）
- [ ] M-2：admin 6 位口令明文存储（建议 HMAC+盐+存量迁移）
- [ ] M-4：platExport 全量 sid 塞 _.in + findAll skip 翻页，机构规模大时超时
- [ ] Minor-1：同班同名学生评语可能错位（建议置 null）

---

## 3. Security Status

### OWASP Top 10 Coverage（1148/1149 整改后）
- [x] A01: Broken Access Control — 服务端 push 白名单 + pull 按角色/班级收窄 + aiEval 角色校验（verify_server_guard 16 项守卫）
- [ ] A02: Cryptographic Failures — 部分覆盖；admin 口令仍明文（M-2）
- [x] A03: Injection — prompt 出口两道闸 + 输出结构校验；无 SQL（云数据库 SDK 参数化）
- [x] A04: Insecure Design — aiEval 限流 80/天 + batch 上限 10 人
- [x] A05: Security Misconfiguration — 上传包排除 .workbuddy/，错误码不回显堆栈
- [x] A06: Vulnerable Components — 依赖极简（wx-server-sdk + 内置插件），无常驻第三方依赖
- [x] A07: Authentication Failures — 云函数统一 openid 鉴权，removed/disabled 成员 fail-closed
- [x] A08: Data Integrity Failures — LWW 冲突败者副本可找回（1149-A2）
- [ ] A09: Logging Failures — 仅部分云函数有日志，无统一审计口径
- [x] A10: SSRF — aiEval 出网仅固定 HOST/PATH，已收敛 callGLMApi 单点（1149-A3）

**Current Coverage**: 8/10（80%）→ 目标 9/10（90%）：补 A02（M-2）即可达标；A09 列为已知豁免

---

## 4. Performance Metrics

- **主包体积**: 1269.2 KB / 2048 KB（62.0%）；分包 pkg-low 109.3 KB（5.3%）
- **Page Load Time**: 未采集（真机轮补充）
- **API Response Time**: syncv2 pull 截断上限 500 条/集合；未采集 p95

---

## 5. Code Quality

- **Linting Errors**: 0（tools/lint.js，121 文件）
- **TypeScript Strict Mode**: No（纯 JavaScript）
- **Code Duplication**: callGLM 重复已消除（1149-A3）；架构守卫：utils/db/index.js ≤260 行

---

## 6. Predicted Issues（本 QA 计划重点盯防）

**RISK-001**: 教师被分新班后历史不补齐
- **Predicted Severity**: P1
- **Root Cause**: rescoped 队列依赖客户端检测工牌范围变化，真机冷启动路径未验证
- **Test Case**: TC-REAL-003 / TC-SYNC-006 will verify
- **Mitigation**: 已有 meta.sync.rescoped 持久化 + 游标归零重拉，上限一轮防死循环

**RISK-002**: LWW 冲突找回在真机不可用
- **Predicted Severity**: P2
- **Root Cause**: conflicts 存本地 meta，两台设备时间偏差可能导致误判败者
- **Test Case**: TC-REAL-004 / TC-SYNC-011 will verify
- **Mitigation**: restoreConflict 以 Date.now() 写回重新参战

**RISK-003**: 分包页面跳转路径遗漏
- **Predicted Severity**: P1
- **Root Cause**: 6 页迁 pkg-low 后主包仍有硬编码 /pages/ 跳转可能漏改
- **Test Case**: TC-PAGE-009 ~ TC-PAGE-014 will verify
- **Mitigation**: tools/size.js 分包感知门禁 + verify_pages 套件

**RISK-004**: aiEval 限流在多实例下失效
- **Predicted Severity**: P2
- **Root Cause**: 限流用实例内存 Map，云函数多实例并发时计数分片
- **Test Case**: TC-SEC-007 will verify（文档级评估）
- **Mitigation**: 单实例场景可接受；规模化后迁移云数据库计数

---

**Next Steps**: Begin Week 1 testing with baseline established.
