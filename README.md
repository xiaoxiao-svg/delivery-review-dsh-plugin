# delivery-review-plugin（DeepSeek Harness 移植版）

[delivery-review-plugin](https://github.com/xiaoxiao-svg/delivery-review-plugin)（Claude Code 双 Agent 交付协作工作流插件）的 **DeepSeek Harness 移植版**。基于 DSH 的 Cordis 插件系统，以 bundle 方式分发，**不改动 DSH 源码**，全部能力由插件行在配置层挂载。

> 与 Claude 版的最大差异：**通信通道从 `git notes` 改为 DSH 原生子代理消息通道**——子代理结论由最终回复承载，编排者直接解析，不再需要"代写留言 / 留言 ID 编号 / git notes 解析"整套机制。

## 工作流一句话

`/delivery-review <描述>` → 上下文确认 → 双轨方案（用户选择）→ 方案审查（按需）→ 目标声明 → **fixer ↔ reviewer 隔离子代理循环迭代**（state.json 状态机驱动退出：震荡/dispute > 收敛 > 质量门禁 > 轮次上限）→ 人工验收（**裁决权归用户**）→ 交付报告 `docs/delivery-review-<日期>-<HHmm>.md`。

核心元认知：每个交付节点必须输出「未知清单」——你不知道的远比你知道的重要。

## 插件组成（cordis.patch.yml 挂载 8 行）

| 行 id | 能力 | 对应 Claude 版组件 |
|---|---|---|
| `delivery-review-command` | `/delivery-review` 命令：注入编排指令并唤醒编排者 | `commands/delivery-review.md` |
| `delivery-review-hook` | 监听 `tools/post-execute`，write/edit/pwsh/bash 后自动刷新审查材料 | `plugin.json` PostToolUse hook + `hooks/update-review-material.ps1` |
| `delivery-review-refresh` | `refresh_review_material` 工具：手动兜底刷新材料 | 编排流程里的兜底刷新一步 |
| `delivery-review-roles` | `delivery_review_role` 工具：按需取回 fixer/reviewer/planner 角色指令 | `agents/*.md` |
| `delivery-review-skills` | 方法论技能随插件注册进 `ctx.skills`，安装即用 | `skills/delivery-review/SKILL.md` |
| `delivery-review-subagent-fixer` | `subagent_fixer` 子代理工具（读写） | `agents/delivery-fixer.md` |
| `delivery-review-subagent-reviewer` | `subagent_reviewer` 子代理工具（**toolFilter allow 只读白名单**：仅 read/read_image/glob/grep） | `agents/delivery-reviewer.md`（disallowedTools） |
| `delivery-review-subagent-planner` | `subagent_planner` 子代理工具（同样只读，按需触发） | `agents/delivery-planner.md` |

另有 `src/material.js`（材料生成核心，纯 Node 可独立测试）、`workflow/delivery-review.md`（编排指令）、`roles/*.md`（角色定义）、`skills/delivery-review/SKILL.md`（方法论）。

## 安装

要求：DSH `>= 0.1.0-rc.6`（web profile）、git。

### 方式 A：从 GitHub 直接安装（推荐）

本插件是纯 JS（无 TypeScript 构建步骤），git 安装开箱即用：

```sh
dsh plugin --profile web add github:xiaoxiao-svg/delivery-review-dsh-plugin
```

该命令把插件装进 profile 依赖（pnpm 拉取源码），并因包声明了 `dsh.bundle` 自动追加进 `dsh.profile.bundles`——**无需手动编辑任何配置文件**。重启 web profile 即生效（bundle patch 位于 base bundle 之后），之后可按 id 在 profile 的 `cordis.patch.yml` 里覆盖任意行。

> 若后续发布到 npm 注册表，也可用包名安装：`dsh plugin --profile web add delivery-review-plugin`。

### 方式 B：本地开发调试（作者/贡献者）

改代码 → 同步 → 重启，三步循环：

```sh
node scripts/sync-installed.mjs   # 把工作区同步到 harness 实际加载的安装位置
```

然后重启 web profile 生效。详见下文「改动后部署」。

> 不要把安装位置换成 junction/symlink：Node 对链接做 realpath 解析，插件内部 `@deepseek-ai/*` 依赖会从真实路径（工作区，无依赖树）解析失败（见上文「踩坑速查」）。

## 使用

```
/delivery-review 我要修一下登录页的鉴权流程
```

- 全程人机协作：目标确认 / 方案选择 / 人工裁决都由你拍板，AI 不代做裁决
- 用户可随时插话；目标变更 = 完整重置（state.json 归零 + 删旧材料），仅澄清 = 轮次延续
- 审查材料自动生成在 `.delivery-review/review_material.md`（hook 自动 + `refresh_review_material` 兜底）

## 与 Claude 版的关键差异

| 维度 | Claude 版 | DSH 移植版 |
|---|---|---|
| 子代理间通信 | `git notes --ref=delivery-review`，审查者留言由编排者代写，递增留言 ID | **子代理最终回复承载结论**，编排者直接解析，risk 标识 `R<轮次>-<序号>` |
| 审查者只读隔离 | agent 定义 `disallowedTools: [Write, Edit, Bash]` | subagent 工具行 `toolFilter.allow: [read, read_image, glob, grep]`（工具层强制只读，无平台差异） |
| 命令入口 | `commands/*.md`（markdown prompt） | `ctx.commands` JS handler（注入编排指令 + `agent.followup` 唤醒编排者） |
| 材料 hook | PostToolUse → PowerShell 脚本（PS 5.1 编码坑） | `tools/post-execute` 事件 → JS 插件（UTF-8 直出，无编码坑） |
| 技能 | `skills/` 目录发现 | `ctx.skills.register` 运行时注册，安装即用 |
| 角色定义 | `agents/*.md` frontmatter | `roles/*.md` + `delivery_review_role` 工具按需取回 |
| 定时调度（未来） | `/loop --schedule` 未实现 | 可直接用 DSH `ctx.schedule` / `dsh-schedule` |

## 验证

```sh
node scripts/verify.mjs          # 语法 + cordis.patch.yml 结构 + 资源完整性
```

> 材料生成逻辑（src/material.js）在开发期用临时 git 仓库做过功能单测（有改动刷新 / 无变化不动 / untracked 进清单 / 子目录归位 / 非 git 报错，13 项全过）；测试脚本属开发期工具，未随仓库分发。

## 改动后部署（bundle 安装模式下）

bundle 安装是**实体拷贝**，harness 从 `%DSH_HOME%/profiles/<profile>/node_modules/delivery-review-plugin` 加载插件代码，改工作区源码不会自动生效。改完代码执行：

```sh
node scripts/sync-installed.mjs   # 同步到安装位置，然后重启 web profile
```

> 不要把安装位置换成 junction/symlink（Node realpath 会导致插件依赖解析失败），详见 `docs/pitfalls.md`。

## 踩坑速查

- 注入消息 content 必须是块数组（`[{ type: "text", text }]`）：裸字符串会触发误导性的 `DeepSeek API stream ... failed`（TRANSPORT）报错，GUI 显示为大量"未知内容块"
- 安装位置不要用 junction/symlink 链接：Node realpath 后插件依赖从真实路径解析会失败；改代码用 `node scripts/sync-installed.mjs` 同步后重启
- `ctx.skills.register` 必须带 `source` 字符串（如 `"bundled"`），否则加载技能时报 `source must be a string`

## 已知限制

- 审查材料只覆盖 write/edit/pwsh/bash（与 Claude 版 matcher 一致）；MCP 等其他工具的写入不在材料中，由审查者列入未知清单
- 三个 subagent 工具全局注册（所有 agent 可见），与 Claude 插件全局提供 agent 类型一致
- reviewer/planner 采用 allow 只读白名单，比 Claude 版"禁写但其余工具可用"更严格（审查者本来也只用读类工具）
- 本仓库已通过本地安装测试与端到端 loop 实测（2026-08-14，含命令注入 → 子代理往返 → 状态机全链路）

## 许可

MIT（与原插件一致）。
