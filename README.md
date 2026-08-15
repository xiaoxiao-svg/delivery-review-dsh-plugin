# delivery-review-plugin（DeepSeek Harness 专属版 v2）

双 Agent 交付协作工作流的 **DeepSeek Harness 原生插件**（不再是从 Claude Code 移植的"忠实移植版"）。基于 DSH 的 Cordis 插件系统，以 bundle 方式分发，**不改动 DSH 源码**。

> 与移植版（v1，已废弃）的最大差异：**一切确定性逻辑从 LLM 下沉到插件代码**——状态机是 JS 纯函数（可单测）、审查结论经 schema 强校验的结构化提交（不再自由文本解析）、交互走 DSH 原生结构化提问（GUI 点选）、Web 活动面板实时显示进度（解决"Web 环境不直观"的核心痛点）。

## 工作流一句话

`/dsh-delivery <描述>` → 上下文确认 → 双轨方案 + **自动分级**（light/standard/heavy，启动时探测改动规模）→ 方案审查（heavy 级按需）→ 目标声明 → **fixer ↔ 只读 reviewer 隔离子代理循环**（状态机代码驱动：震荡/dispute > 收敛 > 质量门 > 轮次上限）→ 人工验收（**裁决权归用户**，ask_user_question 点选）→ 交付报告 `docs/delivery-review-<日期>-<HHmm>.md`。

核心元认知：每个交付节点必须输出「未知清单」——你不知道的远比你知道的重要。

## 插件组成（cordis.patch.yml 挂载 10 行）

| 行 id | 能力 |
|---|---|
| `delivery-review-command` | `/dsh-delivery` 命令：注入决策指引 + 唤醒编排者 + **自动任务分级探测**（改动文件数/行数 → light/standard/heavy） |
| `delivery-review-hook` | 监听 `tools/post-execute`，write/edit/pwsh/bash 后自动刷新审查材料（串行队列在 material.js 模块级，防竞态） |
| `delivery-review-refresh` | `refresh_review_material` 工具：手动兜底刷新材料 |
| `delivery-review-roles` | `delivery_review_role` 工具：按需取回 fixer/reviewer/planner 角色指令 |
| `delivery-review-skills` | 方法论技能随插件注册进 `ctx.skills`，安装即用 |
| `delivery-review-submit` | `delivery_submit_review` 工具：**reviewer 结论结构化提交**（schema 强校验 risk 数组/score/存疑/未知），自动推进状态机 + 轮次记录落盘 |
| `delivery-review-panel` | Web 活动面板：`/plugins/delivery-review/state` 状态路由 + 右上角浮层（tapIndex 注入，免构建，可拖动、位置记忆）+ `delivery_status` 状态查询工具（调用即激活面板） |
| `delivery-review-subagent-fixer` | `subagent_fixer` 子代理工具（读写） |
| `delivery-review-subagent-reviewer` | `subagent_reviewer` 子代理工具（**toolFilter allow 只读白名单 + delivery_submit_review**：read/read_image/glob/grep + 提交工具） |
| `delivery-review-subagent-planner` | `subagent_planner` 子代理工具（只读白名单，heavy 级按需触发） |

另有纯库模块（被上述插件 import，不单独挂载）：`src/state.js`（确定性状态机，纯函数可单测）、`src/store.js`（状态/轮次持久化）、`src/material.js`（审查材料生成核心）。

## 与移植版（v1）的关键差异

| 维度 | 移植版 v1（已废弃） | DSH 专属版 v2 |
|---|---|---|
| 状态机 | 编排者（LLM）读 284 行工作流文本，手写 state.json、心算 risk 差集 → 必然漂移（R1-6/R1-7 实证） | **`src/state.js` JS 纯函数**：推进/去重/振荡/退出全确定性，13 项单测覆盖 |
| 子代理结论 | 自由文本最终回复，编排者解析 risk/score/approve | **`delivery_submit_review` 结构化提交**：schema 强校验，直接进状态机 |
| 交互 | 大段文本"选 A 还是 B" | **`ask_user_question` 结构化提问**（DSH 基础能力，GUI 点选） |
| 直观性 | 无（Web GUI 里只有文本流） | **Web 活动面板**：右上角浮层实时显示阶段/轮次/风险摘要/质量分 |
| 流程分级 | 一律全流程 | **自动分级**：light 单轮 / standard loop≤3 / heavy +planner，启动时探测并向用户确认 |
| 编排指令 | 284 行全量注入 | 精简决策指引（状态计算全由工具承载） |
| risk 去重 | 轮次号标识 → 「新增==0」分支不可达 | **内容指纹跨轮去重**（同问题换措辞不算新增） |
| 振荡检测 | LLM 解析 `git diff --stat` 自由文本 | **`git diff --name-only` 机器可解析清单** |
| 命令 | `/delivery-review` | `/dsh-delivery`（新命名） |

## 安装

要求：DSH `>= 0.1.0-rc.6`（web profile）、git。

### 方式 A：从 GitHub 直接安装（推荐）

```sh
dsh plugin --profile web add github:xiaoxiao-svg/delivery-review-dsh-plugin
```

该命令把插件装进 profile 依赖（pnpm 拉取源码），并因包声明了 `dsh.bundle` 自动追加进 `dsh.profile.bundles`——**无需手动编辑任何配置文件**。重启 web profile 即生效，之后可按 id 在 profile 的 `cordis.patch.yml` 里覆盖任意行。

### 方式 B：本地开发调试（作者/贡献者）

```sh
node scripts/sync-installed.mjs   # 把工作区同步到 harness 实际加载的安装位置
```

然后重启 web profile 生效。详见「改动后部署」。

> 不要把安装位置换成 junction/symlink：Node 对链接做 realpath 解析，插件内部 `@deepseek-ai/*` 依赖会从真实路径（工作区，无依赖树）解析失败。

## 使用

```
/dsh-delivery 我要修一下登录页的鉴权流程
```

- 全程人机协作：目标确认 / 方案选择 / 分级确认 / 人工裁决都由你拍板（ask_user_question 点选），AI 不代做裁决
- 用户可随时插话；目标变更 = 重新对齐方案与目标（按确认重置状态），仅澄清 = 轮次延续
- 审查材料自动生成在 `.delivery-review/review_material.md`（hook 自动 + `refresh_review_material` 兜底）
- **Web 活动面板**：右上角浮层实时显示当前阶段 / 轮次 / 质量分 / 风险摘要（1s 轮询）；未运行时灰点常驻（点开提示"未在运行"），运行中蓝点脉冲；浮层可拖动、位置记忆

## 验证

```sh
node scripts/verify.mjs          # 语法 + cordis.patch.yml 结构 + 资源完整性 + 模块导出
node scripts/test-state.mjs      # 状态机纯函数单测（13 项：去重/门禁/退出四级/归一化/纯函数）
node scripts/test-integration.mjs # 集成测试（临时 git 仓库：材料刷新/清单/竞态/截断/存储）
```

> 集成测试在临时 git 仓库运行、结束自动清理；测试脚本属开发期工具，未随仓库分发（npm pack 时被 files 字段排除）。

## 改动后部署（bundle 安装模式下）

bundle 安装是**实体拷贝**，harness 从 `%DSH_HOME%/profiles/<profile>/node_modules/delivery-review-plugin` 加载插件代码，改工作区源码不会自动生效。改完代码执行：

```sh
node scripts/sync-installed.mjs   # 同步到安装位置，然后重启 web profile
```

> 不要把安装位置换成 junction/symlink（Node realpath 会导致插件依赖解析失败），详见 `docs/pitfalls.md`。

## 踩坑速查

- 注入消息 content 必须是块数组（`[{ type: "text", text }]`）：裸字符串会触发误导性的 `DeepSeek API stream ... failed`（TRANSPORT）报错
- 安装位置不要用 junction/symlink 链接：Node realpath 后插件依赖从真实路径解析会失败
- `ctx.skills.register` 必须带 `source` 字符串（如 `"bundled"`），否则加载技能时报 `source must be a string`
- webServer 服务键随 rc 版本可能改名（`webServer`/`httpServer`）：panel.js 双键探测，两者都兼容
- Web 浮层注入用 `tapIndex`（幂等：带标记则跳过）；状态路由/浮层脚本注册用 `webServer.register`

## 已知限制

- 审查材料只覆盖 write/edit/pwsh/bash（与 v1 一致）；MCP 等其他工具的写入不在材料中，由审查者列入未知清单
- 三个 subagent 工具全局注册（所有 agent 可见），与 v1 一致
- 多会话并发跑同一仓库 loop：state.json 与 rounds/ 按仓库落位，两个会话互踩会互相覆盖（文档化限制）
- Web 面板"当前活动仓库"为 DSH 进程内单值：多仓库并行交付时面板只指向最后启动/提交的仓库（文档化限制）
- 分级轮次上限（light=1）暂未落地为状态机 `max_rounds`（当前统一上限 3 轮，待设计）
- Web 面板为第一期（状态摘要浮层）；视觉美化（头像/动画/消息流）留待第二期
- 本仓库已通过静态校验、状态机单测、集成测试与组合挂载验证（2026-08）；真实 LLM 端到端 loop 验证见 docs/delivery-review-<日期>.md

## 许可

MIT。
