# ADR-004：权限双层 + 一致性守卫测试（而非把规则复制进云函数）

## 状态
Accepted（2026-11-09；背景是当日两轮安全审查收口）

## 背景
2026-11-09 审查发现：权限规则只活在客户端 `utils/db/permissions.js`（纯函数），
云函数从未引用 → 家长工牌可 pull 全机构数据、push 改全班评语（Critical×2）。

## 决策
1. **服务端闸门**（`syncv2`）：push 写权限白名单 + 老师 inTeacherScope 班级范围；
   pull 按角色收窄（家长=自家孩子、老师=自己的班、负责人/管理员=全量）；
   被移除/停用成员 fail-closed。
2. **前后端一致性靠守卫测试，不靠复制文件**：`tests/verify_server_guard.js`
   直接 require 客户端 `permissions.js` 的规则表，与 syncv2 白名单逐条比对——
   两边谁改了忘跟另一边，测试立刻红。权限语义本体仍只有一份（permissions.js）。

## 后果
- **得**：不产生「没人 require 的死代码副本」；规则漂移有机器兜底。
- **失**：服务端闸门是 permissions.js 语义的**转写**而非引用（云函数目录互相隔离，
  require 不到 utils/）——守卫测试是唯一的防漂移保险，删测试=拆保险。
- aiEval 的角色闸门（owner/admin/teacher）同理受守卫覆盖。
