# 页面代码级走查报告 — 橙果课堂

**日期**: 2026-11-09
**执行**: Horizon(LLM)
**范围**: 全部 21 页（主包 15 + pkg-low 分包 6）
**方法**: `node tools/pagewalk.js`（静态交叉核对）+ 3 个高频页人工深读

---

## 结论

**无 P0/P1/P2 页面问题。** 21 页的绑定、事件、跳转、注册全部核对通过，
发现 2 个 P3 界面级缺陷（BUG-003、BUG-004），均已入缺陷单。

## 走查工具

新增 `tools/pagewalk.js`（可重复执行，纳入日常门禁）：

| 检查项 | 口径 |
|--------|------|
| 绑定变量 | WXML `{{ }}` 顶层标识符 vs JS data/setData + theme/icons/voice 共享注入 + 页面 JS 全文提及兜底 |
| 事件函数 | bind/catch 绑定函数名 vs JS 定义 |
| 跳转注册 | JS 中 url 指向的页面必须在 app.json（含 subPackages） |
| setData 量级 | 单页 >20 处提示（信息项，不计硬伤） |
| 自定义组件 | 未注册组件提示（不计硬伤） |

结果：**21 页 / 1 项硬伤（BUG-003）+ 17 项提示**。

口径校准记录（防后人误用）：初版误报 407 → 修正三处后收敛至真信号：
1. `{{item.name}}` 只取点链首段，wx:for 默认 item/index 与别名不查
2. 三元里的字符串字面量（`{{x?'on':'off'}}`）不是变量
3. `<template data="{{vk:'rec',...}}">` 传参键是模板局部作用域
4. theme.js/icons.std()/voice.js 注入页面的键全页共享

## 缺陷

- **BUG-003（P3）**：`pkg-low/batch/batch.wxml:71` `bindfocus="clearHit"` 函数不存在——
  标红行点进输入框不清红标，须敲字才清（onNote 有兜底，故仅体验问题）
- **BUG-004（P3）**：8 页使用 WXML 不支持的 `<b>`/`<br/>`——加粗/换行意图静默失效
  （cls/feedback/index/mgr/records 的 <b>；join.wxml:35 的 <br/>）

## 提示项（不计缺陷，记录备查）

- setData 量级 Top：mgr 77 处、record 44 处、index 29 处、join 29 处、batch 25 处
  （mgr 78 处为既有已知 Minor；如遇低端机渲染卡顿再批量合并优化）
- `<b>`/`<br/>` 之外无未注册组件

## 人工深读（3 个高频页）

- **index**：loading×3 + 空态文案（「还没有班级，去我的里创建」等）+ catch×5 — 合格
- **record**：loading×4 + 发布条件空态 + 编辑态上下文提示（I-09/J-07 注释可见）+ catch×4 — 合格
- **mine**：纯本地读库（118 行，无云调用）— 无需 loading/catch，合格

## 真机剩余关注点（与 TC-REAL 重叠，不重复记录）

视觉/手感/低端机分包加载仍依赖 TC-REAL-001/009 真机人工项。
