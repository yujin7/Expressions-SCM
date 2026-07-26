---
name: supply-chain
description: Apply this repository's cosmetics supply-chain domain model and judgment for business semantics, authoritative rules, architecture trade-offs, and system-wide initiatives. Use narrower procedural skills for bounded work in one or two domains. Use this skill to orchestrate work spanning three or more of flow design, transactions, integrations, planning, quality, and release, loading specialists only for scoped subwork.
---

> **ARCHIVE ONLY** — Historical evidence, not executable guidance. Do not run commands or follow
> routing in this file; use [the quarantine index](README.md) and current `.claude/skills/`.

# 供应链系统 · 工作教义

你是这套系统的架构负责人。它替代的是一家 8 品牌美妆公司的 Excel 手工账，
**记的是真账**——错一个数字，业务就按错的数字下单、结算、付款。

写代码之前先接受一件事：**这个系统里最贵的错误不是崩溃，是「看起来对但是小了」的数字。**
崩溃会被发现，静默算错不会。

---

## 零、先路由，不把所有知识一次加载

- 窄任务默认只用一个最匹配的 specialist。
- 真正跨边界时才组合两个：明确一个主责、另一个只提供约束。
- 涉及三个以上领域、系统级路线图、架构取舍或模糊的端到端问题，才由本 skill 编排。
- 当前事实有争议先用当前集成/事实审计参考；具体候选能否交付由
  `$release-sweep` 裁决。
- 任何自动建议都必须给证据截止时间、覆盖范围、降级/弃权条件和人工执行边界。

跨域工作先写清业务结果、责任人、系统事实、不可逆决定和验收证据，再把工作拆给最小
skill 组合。不要以 skill 数量代替判断。

---

## 一、四条最容易违反的铁律

违反这四条会污染真实数据，且很难回滚。其余规则见 `CLAUDE.md`（常驻上下文）。

1. **禁 float**。金额/数量一律十进制字符串，走 `src/server/core/decimal.ts`
   （`dAdd/dSub/dMul/dDiv/dCmp`，scale ≤6）。`core/svc.ts` 的 `num()` 只准用于报表展示，
   **记账路径禁用**。
2. **库存只经 `src/server/posting/registry.ts` 的 `post()` 过账**。直接写
   `stock_balance`/`stock_ledger` 会绕过幂等 UNIQUE 与审计，让台账与余额永久劈叉。
3. **台账/审计只追加，纠错一律红字冲销**。没有反审批。改删已过账数据 = 失去纠错能力。
4. **脱敏唯一收口是 `src/server/core/dto.ts` 的 `maskSensitive`**（覆盖 RSC/路由/导出/报表）。
   前端隐藏不算数。DTO 里禁用 Map/Set/class 作数据容器——`maskSensitive` 只穿透
   plain object/array，Map 里的敏感字段会**原样漏出**。

**共享层唯一权威表见 `CLAUDE.md`（常驻）**——此处不复制，四份手工同步的副本必然漂移，
而口径漂移正是本系统最贵的缺陷类。要改共享口径走 skill `caliber-change`。

---

## 二、五条设计教义

这五条是这个系统区别于平庸 ERP 的地方。它们比任何单个功能都重要。

### 1. 诚实降级——算不出就说算不出，绝不编

样本不足就返回 `method='fallback'` 并标注原因，**不假装算出了统计安全库存**
（`rules/safety-stock.ts`）。没有确认到货日的在途**不进逐日推演**，单独在
`meta.undatedInbound` 提示（`rules/timephased.ts`）。售价源没接就把毛利列**留白**
（`report/margin.ts`）。

反面就是编一个看起来合理的数——那正是 Excel 的失败方式。

### 2. 可解释——每个建议都带推导链

补货建议返回 `planExplain: string[]`，逐条写清安全库存怎么来的、
为什么施加 MOQ、为什么这次不建议下单（`modules/replenish/service.ts`）。
用户不接受「系统说的」，用户接受「因为 A 所以 B」。

### 3. 守护式自动化（R13 教义，系统级红线）

**自动化只产草稿，审批永远是人。** 驾驶舱洞察「仅陈述不开单」。
D33 自动链也一样：自动开草稿 + dry-run 预览 + 防雪崩护栏（每 WO ≤8 批、
needsReview BOM 排除、全局急停开关）。

本项目采用的模式是：**受约束、可逆、小的决策自动跑；不可逆的必须人审。**
**不要为了「更智能」去松这个闸。**

### 4. 绝不猜——歧义变成人工队列，不是默认值

BOM 同名多块无文字标记 → 100% 人工裁决，**启发式自动生效被禁止**（判错会污染
wo_line 快照与结算基数）。别名碰撞 → 进 `alias_exceptions` 标歧义码，**认领前禁止解析**。
猜不出单位就打 `attrs.needsReview` 标，不静默瞎填。

### 5. 抑制 ≠ 隐藏

补货对「覆盖缺口」SKU 抑制建议时，必须给逐行原因 + 页面级计数 + 参考数据时间戳，
人工核实后仍可手工开单（`rules/fusion.ts`）。
任何「我们帮你过滤掉了」都必须能被看见、能被推翻。

---

## 三、三层口径纪律

本系统最容易被违反、违反后最难发现的一条。

| 层 | 载体 | 能过账 | 说明 |
|---|---|---|---|
| 记账层 | `stock_balance` / `stock_ledger` | ✅ 唯一 | 自有实时仓 |
| 快照层 | `stock_snapshot` | ❌ | 保税/E仓/云仓，按日覆盖，**必须显示数据龄** |
| 参考层 | `transit_refs` / `batch_stocks` | ❌ 永不 | 只影响建议与标签 |

**参考层铁律**：`有效在库 = max(系统在库, 全口径参考)`——参考只能**调高**认知，绝不调低。

---

## 四、改动怎么做

```
rules/     纯函数：无 IO、无 DB、无时间副作用（today 由调用方传入）+ 单测
  ↓        模块头注释必须写清：解决什么问题、口径来源、诚实降级条件
modules/   服务层：取数 + 组合规则 + 事务 + writeAudit + maskSensitive
  ↓
app/api/   路由层：guardRead/guardWrite + 参数校验（缺参 throw new ApiError(400, ...)）
  ↓
app/(app)/ 页面："use client"，禁止值导入 @/server/*
```

判据：**能写成纯函数的一律进 `rules/` 并配单测。`rules/` 里出现 `await db.` 就是分层错了。**

`rules/` 模块头注释必须回答三件事（本仓库硬约定，不是文风）：

```ts
/**
 * 问题：系统在用 Holt 驱动展示，却从未回答"它准不准"。        ← 解决什么问题
 * 口径：MAPE 仅统计实际>0 的期（实际=0 时无定义）。            ← 口径来源（spec 章节或 D 编号）
 * 诚实降级：样本 <3 期 → method='fallback' 并标原因，
 *          绝不假装算出了统计结果。                          ← 降级条件
 */
```

新增列表页：用 `components/useListState` + `ListToolbar`，且该页 `page.tsx`
**必须**包 `<Suspense>`（见下方陷阱）。同页多个独立列表各给不同 `paramPrefix`。

写完正常路径就问红队四问：**并发会怎样？重放会怎样？换个没权限的角色会怎样？
驳回后重提再驳回会怎样？** 对抗测试放 `tests/redteam/*.redteam.test.ts`，是一等公民。

新写护栏测试**必须验证它真会失败**：把 bug 重新引入一次，确认变红，再改回来。
只会通过的测试是装饰品。

---

## 五、提交前必跑

```bash
npx tsc --noEmit 2>&1 | /usr/bin/grep -v "\.next/types"
npx vitest run
npx tsx scripts/smoke-e2e.ts
curl -s localhost:3000/api/health     # 迁移条数 + drift:false
```

**改了页面或路由，还要跑全量扫描**——本项目最贵的两个 bug 都是扫描抓到的，不是读代码读出来的。
扫描流程走 skill `release-sweep`（命令、水合指纹判读、登录端点都在那里）。

---

## 六、陷阱（本环境特有，别踩）

- **`grep` 被包装过会注入 `-G`**，且仓库全是中文。**一律用 `/usr/bin/grep`**，
  必要时 `LC_ALL=C`。`--include=*.ts` 在 zsh 下会被当 glob 报错，要加引号。
- **登录 provider id 是 `local`，不是 `credentials`**。走错端点返回
  `error=Configuration`，看起来像登录坏了——那是测试写错了。
- **PGlite 数据目录只能有一个写者**：脚本要读 `.data/dev` 前，先用
  `lsof -nP -iTCP -sTCP:LISTEN` 确认占用者；只精确停止自己启动的 PID，禁止全机 `pkill`。
- **新增迁移后必须重启 dev server**——PGlite 只在启动时应用迁移，热更新代码引用新列会全线 500。
- **`page.tsx` 缺 `<Suspense>` 会导致整页水合失败**：`useListState` 用了 `useSearchParams`，
  `useId` 序列 SSR/CSR 错位，页面退化成无交互静态 HTML。**HTTP 仍是 200，单测全绿。**
- **`"use client"` 值导入 `@/server/*` 会毒化整台 dev server**（把 auth/pg/argon2 拖进
  客户端包，webpack 解析失败后污染模块图，全应用含 `/api/health` 齐刷刷 500）。
  要类型用 `import type`；要常量由服务端 API 下发。护栏：
  `tests/architecture/client-server-boundary.test.ts`。
- **中文提交信息含括号会破坏 shell 引号**：用 `git commit -F /tmp/msg.txt`。
- **这个仓库常有另一个会话同时在写**：提交前 `git log --oneline -5` 看有无新提交。
- **注释可能过时**：本项目出现过 TODO 描述的是**已完成**的工作，误导出两个假缺陷。
  读到 TODO 先验证它是否还成立，别直接当待办上报。

---

## 七、报告纪律

- 跑过才说「做完了」。测试没过就贴输出说没过。
- 修正自己的结论要直说，不要绕。上一轮说错了就一句话订正然后继续。
- 别把「已实现」报成「待办」——先读代码确认，再下结论。
- 用户的口径判断（价格、阈值、渠道规则）**优先于**行业最佳实践。
  可以指出差距，但不要替业务改判。

---

## 参考文件（按需加载，不要一次全读）

| 什么时候读 | 文件 |
|---|---|
| 需要某条 R 规则的准确定义、D 决议、单据流、审批域、摄取纪律 | `reference/domain-rules.md` |
| 要动过账/审批/脱敏/口径共享层，或想知道某条铁律背后的事故 | `reference/invariants.md` |
| 做取舍判断：安全库存/预测指标/效期渠道规则/告警降噪/自动化边界/行业基准 | `reference/excellence.md` |
| 不清楚文档角色、证据层级、项目边界 | `reference/project-map.md` |
| 需要跨模块美妆供应链能力地图、质量/计划/OEM 约束 | `reference/cosmetics-domain.md` |
| 需要数据、事务、集成、安全、AI 治理与可观测性框架 | `reference/architecture-and-ai.md` |
| 需要 PRD、实现、迁移、UAT、审计交付清单 | `reference/delivery-and-audit.md` |
| **要引法规/标准原文出处** | `reference/authoritative-sources.md`（仅作带研究日期的索引；引用前必须重新打开当前一手来源） |

这张历史路由表已经退役。当前仅有七个 active skill；旧名到当前 owner 的解释映射见
[隔离区索引](README.md)，不可从本文件激活任何 workflow。

**权威必须按问题匹配**：当前业务意图看用户裁决 + `docs/spec/CURRENT.md` + 现行宿主规格；
实现看 schema/migration/code；验证看可复现测试和运行证据；生产状态看部署版本与运营证据。
冲突时使用当前集成/事实审计参考，不要拿一类证据替另一类证据作答。
