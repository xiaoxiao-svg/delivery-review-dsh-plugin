---
name: dsh-delivery
description: DSH 专属交付协作工作流（修复↔只读审查 loop，Web 面板实时进度，按任务规模自动分级）。当用户说"交付"、"审查"、"review"、"验收"、"完成任务"、"检查改动"、"code-review"时激活。流程：上下文确认 → 方案（双轨+自动分级）→ 修复 Agent(delivery-fixer) ↔ 审查 Agent(delivery-reviewer，隔离只读+结构化提交)循环迭代 → 人工验收（裁决权归用户）→ 交付报告。执行入口 /dsh-delivery。
whenToUse: 用户要求审查交付、验收改动、检查代码时；执行入口为 /dsh-delivery 命令。
---

# 交付协作工作流（DSH 专属版）

> "你不知道远比你知道的要重要的得多。"——塔勒布

**执行入口：`/dsh-delivery` 命令。** 本文件是方法论与数据模型参考。命令注入的决策指引（workflow/delivery-review.md）驱动编排，状态机由插件确定性代码承载（`src/state.js`），不依赖模型记忆轮次或手写状态。

---

## 架构（DSH 专属版与移植版的本质区别）

| 维度 | 移植版（已废弃） | DSH 专属版 |
|---|---|---|
| 状态机 | 编排者（LLM）读长流程文本手写 state.json、心算 risk 差集 | **插件 JS 纯函数**（src/state.js）：推进/去重/振荡/退出全确定性，可单测 |
| 审查结论通道 | 自由文本最终回复，编排者解析 | **delivery_submit_review 工具**：schema 强校验（severity/evidence/location/summary/goal_relation），直接进状态机 |
| 交互 | 大段文本"选 A 还是 B" | **ask_user_question 结构化提问**（GUI 点选） |
| 直观性 | 无（Web GUI 里只有文本流） | **Web 活动面板**（右上角浮层：阶段/轮次/风险摘要/质量分，1s 轮询） |
| 流程分级 | 一律全流程 | **自动分级**：light（单轮）/ standard（loop≤3）/ heavy（+planner 方案审查），启动时探测并展示给用户 |
| 编排指令 | 284 行全量注入 | 精简决策指引（状态计算全由工具承载） |

## 元认知原则

### 边界感知三层

| 层级 | 含义 | 必须输出 |
|------|------|---------|
| 已知 | 确定检查过，结论明确 | ✅ 确认 / ❌ 有问题 |
| 不确定 | 检查了但没把握 | ⚠️ + 原因 |
| 未检查 | 根本没覆盖到的维度 | 🔍 列出（最重要） |

**每个交付节点必须输出「未知清单」——列出 AI 无法确认的风险点。这个清单比检查清单更重要。**

### 审查结论三通道

| 通道 | 含义 | 去向 |
|------|------|------|
| risk | 确定（或高置信）的问题，带证据等级 | 触发修复（经 delivery_submit_review 进状态机） |
| 存疑清单 | 看了但拿不准的点（含经验猜测） | 不触发修复，人工验收判断 |
| 未知清单 | 没看 / 无法确认的维度 | 人工验收补查 |

---

## 角色与隔离

| 角色 | 执行者 | 权限 | 职责 |
|------|--------|------|------|
| 修复工程师 | `subagent_fixer` 子代理 | 读写代码 | 改代码、自检、处理 risk、dispute |
| 资深审查者 | `subagent_reviewer` 子代理 | **工具层强制只读**（allow 白名单：read/read_image/glob/grep + delivery_submit_review） | 两段式独立审查（本质审查→症状审查）、结构化提交 risk/score/存疑/未知、对抗自查 |
| 方案审查者 | `subagent_planner` 子代理（heavy 级触发） | **零命令权限（工具层强制）** | 方案输出后从产品视角审查（四项检查），结论只呈现用户，不进状态机 |
| 编排者 | 主 Agent / `/dsh-delivery` | 读写 + spawn + ask_user_question | 确认上下文、输出方案与目标、驱动 loop（只决策不计算）、人工验收、交付报告 |

> 审查者的「只读」由 `subagent_reviewer` 工具实例的 toolFilter allow 白名单在工具层强制；它看不到 diff 的问题由插件自动生成审查材料解决，因此不需要任何命令权限。

---

## 数据模型

### 存储（插件管理，编排者不手写）

- 审查材料（自动生成）：`<仓库根>/.delivery-review/review_material.md`——插件监听 `tools/post-execute`（write/edit/pwsh/bash 后）自动刷新（模块级串行队列，防竞态）；编排者每轮审查前可用 `refresh_review_material` 工具兜底。含改动清单 / 完整 diff（>800 行截断，写入前 800 行）/ 新建文件清单
- 循环状态（机器判定）：`<仓库根>/.delivery-review/state.json`（src/state.js 的 advance 产出，字段见下）
- 轮次记录：`<仓库根>/.delivery-review/rounds/R<N>.json`（每次 delivery_submit_review 提交落盘，交付报告数据源）
- 状态查询：`delivery_status` 工具（编排者每轮决策前调用）
- 路径落位：`.delivery-review/` 与交付报告 `docs/` 固定在仓库根目录（git rev-parse --show-toplevel），不在子目录创建

```json
{
  "round": 0,
  "consecutive_clean": 0,
  "last_score": 0,
  "exit_reason": "",
  "max_rounds": 3,
  "file_mod_counts": {},
  "last_round_risk_ids": [],
  "last_round_file_fingerprints": {}
}
```

| 字段 | 类型 | 用途 |
|------|------|------|
| `round` | int | 当前轮次 |
| `consecutive_clean` | int | 连续无新增正式 risk 轮数（converged 判定） |
| `last_score` | int | 上一轮质量分（quality_gate 判定） |
| `exit_reason` | string | 退出原因（空 = 继续） |
| `max_rounds` | int | 最大轮次上限 |
| `file_mod_counts` | object | 各文件修改次数（振荡检测：**文件级 diff 内容指纹对比**——指纹相对上轮变化才算再次修改，`git diff HEAD --name-only` 的跨轮累计集合不误报） |
| `last_round_risk_ids` | string[] | 上轮 risk 内容指纹（**跨轮去重**：同问题换措辞不算新增，修复移植版「新增==0 不可达」缺陷） |
| `last_round_file_fingerprints` | object | 上轮各文件 diff 内容指纹（振荡检测的跨轮对比基线） |

### risk 条目（结构化 schema，delivery_submit_review 强校验）

| 字段 | 必填 | 说明 |
|------|------|------|
| `severity` | ✅ | P0-阻塞（需 verified/reproducible 证据）/ P1-重要 / P2-建议 |
| `evidence` | ✅ | verified / reproducible / code-inference（禁 P0）/ guess（不算正式 risk） |
| `location` | ✅ | 文件:行号 |
| `summary` | ✅ | 问题描述（一句话） |
| `goal_relation` | ✅ | 与目标的关系（填不出 = 非本质问题，降 P2 或进存疑清单） |
| `reason` / `fix_direction` | — | 原因分析 / 修改方向 |

---

## Loop 退出条件（src/state.js 确定性判定，优先级从高到低）

1. **oscillation**：任一文件 `file_mod_counts >= 3` → 强制退出，人工裁决
2. **dispute**：reviewer confirm 后仍坚持 → 强制退出，人工裁决
3. **converged**：连续两轮无新增正式 risk（内容指纹去重）→ 理想退出
4. **quality_gate**：`质量分 >= 7` 且无 P0/P1 → 次优退出（比收敛优先，score≥7 不必等满两轮）
5. **max_rounds**：达到 `max_rounds`（light=1 / standard=3 / heavy=3）→ 兜底退出

> risk 数 / 新增 risk / P0/P1 判定均只统计**正式 risk**（evidence ≠ guess）。新增 = 与上轮指纹集合相比新提出的。状态机全部由代码判定，编排者不做任何心算。

## Dispute 机制

```
审查方发 risk → 修复方不同意 → dispute（最终回复）
  → 编排者将反驳转达审查方 → 审查方经 delivery_submit_review 的
    dispute_response 提交
     ├─ confirm → 状态机 dispute 退出 → 人工裁决
     └─ withdraw → 撤回原 risk → 继续 loop
```

> guess 级问题不算 risk，不存在 dispute 流程；存疑清单在人工验收时统一判断。

---

## 用户介入（任意时刻）

- **检查点**：每轮子代理返回后、下一轮 spawn 前，编排者检查用户是否有新消息，有则先输出进度摘要再对齐
- **目标变更** = 回 Step 1 重走方案与目标声明（按用户确认重置状态），轮次重新计
- **仅澄清** = 轮次延续，不重置

> fixer 被打断可能留下半成品：重新对齐后以**当前工作区状态**为起点，不基于旧目标续写。

## 人工验收（最后一道防线：裁决权不可由 AI 代理）

红线拆两层：
- **裁决权**（通过/不通过）不可由 AI 代理——必须用户行使（ask_user_question 点选）
- **验证执行**（跑测试 / 查日志 / 收集证据）可由用户声明交由 AI 代验，输出标注证据等级（已验证 / 代码推断），最终裁决仍由用户拍板

| 范围 | 内容 | 必须/可选 |
|------|------|----------|
| 改动点 | 修复方修改过的代码对应功能 | 必须 |
| 未解决项 | loop 中未解决的 risk | 必须 |
| 审查方存疑清单 | 拿不准的点（含经验猜测） | 必须 |
| 双方未知清单 | 修复方与审查方都无法确认的风险 | 必须 |
| 震荡点 | 反复修改的部分 | 必须 |
| 回归测试 | 原有功能是否被破坏 | 可选 |
| 体验检查 | 操作顺畅度、提示清晰度 | 可选 |

## 交付报告

Loop 结束后（无论验收结果），编排者把本轮轮次记录（rounds/R<N>.json）与子代理叙述整理为交付报告写入运行项目 `docs/delivery-review-<日期>-<HHmm>.md`：目标 / 方案（含分级档位）/ 轮次摘要 / 已解决与未解决 risk / 存疑清单 / 未知清单 / 验收结论 / AI 代验结果（如有）。报告是否提交 git 由用户决定。

---

## 附：塔勒布元认知速查

1. **我知道什么？** —— 确定检查过的
2. **我不确定什么？** —— 检查了但没把握的
3. **我不知道什么？** —— 根本没想到要检查的（最重要）
4. **如果我错了，后果是什么？** —— 下行风险不对称性
5. **这个改动重复一万次，会在某一次崩溃吗？** —— 遍历性检验

> 火鸡在被杀前的每一天都通过了「自检清单」。未知清单才是真正的防线。
