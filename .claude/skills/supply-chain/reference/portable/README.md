# 通用供应链知识库（不自动加载，按需查阅）

这里是**与本仓库无关**的通用供应链/化妆品领域知识，来自早前一套为另一个运行时
（OpenAI agents，见 `openai-agents/*.yaml` 的 `$skill-name` 调用语法）撰写的 8 个技能。
它们原先躺在 `supply-chain/.agents/`，**完全没有进版本控制**——176K 内容，一次
`git clean` 就没了。归集到这里是为了保住它们，并让 skill `supply-chain` 能引用。

## 为什么不做成可自动加载的 skill

1. **触发会打架**。`protect-supply-chain-ledgers` 和本仓的 `write-path` 会被同一句
   「我要写一个过账服务」同时命中，一个给通用原则、一个给本仓入口函数，
   两份都进上下文，既浪费又互相稀释。
2. **抽象层级不同**。这 8 份是「什么才算做对」的通用原则（英文、无代码引用）；
   `.claude/skills/` 的 14 份是「在这个仓库里具体怎么做」（中文、带 file:line 实测数字）。
   日常改这个仓库，后者永远更有用。
3. **运行时不同**。`openai.yaml` 里是 `$plan-beauty-supply` 这类调用语法，
   不是 Claude Code 的 skill 契约，原样放进 `.claude/skills/` 也不会正常工作。

所以：**playbooks 里的文件已从 `SKILL.md` 改名**，确保不会被当成可注册 skill 扫到。

## 什么时候来这里翻

| 场景 | 看哪份 |
|---|---|
| 需要法规原文出处（NMPA / 国务院令 727 / GMP / 注册备案） | `authoritative-sources.md` ← **本仓 14 个 skill 一个 URL 都没有，只有这里有** |
| 开新项目 / 给外部讲方法论，需要不绑定本仓的通用框架 | `playbooks/*.md` |
| 化妆品领域能力模型、批号效期召回、快增长品牌计划 | `cosmetics-domain.md` |
| 架构与 AI 边界、预测/优化选型、反模式 | `architecture-and-ai.md` |
| PRD / 架构决策 / 迁移 / UAT / 红队的交付物模板与严重度分级 | `delivery-and-audit.md` |
| 文档权威顺序、术语表、证据陷阱 | `project-map.md` |

## 注意

`authoritative-sources.md` 顶部标了 **Last researched: 2026-07-25**。
法规链接会失效、条文会修订——**引用前必须重新核实**，不要把这里的日期当成现在。
