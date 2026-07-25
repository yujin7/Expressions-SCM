---
name: new-rule
description: Builds a new business rule, report, or decision-support screen in this supply-chain system end to end — pure rule plus unit test, then service, then API route, then page. Use when asked to add a report, a suggestion, a score, an alert, a ranking, a projection, or any screen that computes a number the business will act on. Encodes the layering that keeps calculations testable and calibers single-sourced, plus the four design tenets that make a number trustworthy: honest degradation, an explanation chain, a human gate, and never guessing. Do not use for CRUD on an existing master table, for pure styling, or for changing a calculation that already exists — that is caliber-change.
---

# 新建规则 / 报表

一个新数字上线，业务就会拿它下单、结算、付款。所以这里的顺序不是审美，是**可测性与可信度**。

---

## 分层（自下而上做，别倒着来）

```
rules/<name>.ts       纯函数：无 IO、无 DB、无时间副作用（today 由调用方传入）
tests/rules/<name>    单测：正常 + 边界 + 降级路径
modules/<域>/<name>   服务层：取数 + 组合规则 + writeAudit + maskSensitive
app/api/<路径>/route  路由：guardRead/guardWrite + 参数校验
app/(app)/<路径>/     页面：列表平台 + CaliberNote
```

**判据**：`rules/` 里出现 `await db.` 就是分层错了，退回去。

---

## 1. 纯函数

模块头注释必须回答三件事——这是本仓库的硬约定，不是文风：

```ts
/**
 * E7-05 预测回测（纯函数）。
 *
 * 问题：系统在用 Holt 驱动展示，却从未回答"它准不准"——无法判断该不该信它。   ← 解决什么问题
 * 口径：MAPE 仅统计实际>0 的期（实际=0 时无定义）；WAPE 对零值稳健。            ← 口径来源
 * 诚实降级：样本 <3 期时 σ 不可信 → method='fallback' 并标原因，              ← 降级条件
 *          绝不假装算出了统计结果。
 */
```

取数一律走既有唯一权威，别自己写：`core/stock-view` / `core/supply` / `core/velocity` /
`rules/abc`。要写第二遍时，改用 `caliber-change` skill。

## 2. 单测

```
tests/rules/<name>.test.ts
```
必测：正常路径、**降级路径**、边界（0 销量 / 单条样本 / 全零序列 / 除零）。
断言里写清**为什么**（`expect(x, "样本不足时不得给出统计结论").toBe(...)`）——
失败信息是给未来的人看的。

## 3. 服务层

- 写路径必须 `writeAudit`（同事务内）。
- 含价格/金额的行必须过 `maskSensitive`（`core/dto.ts`）——前端隐藏不算数。
- 内部消费者传 `allRows: true`；任何封顶要 `log()` 说明丢了什么（静默截断是本项目惯犯）。

## 4. 路由

```ts
if (!sku) throw new ApiError(400, "缺少 sku 参数");   // 不是裸 Error
```
裸 `Error` 会被兜底成「系统错误，请联系管理员（错误码 xxx）」并污染 `error_logs`。

## 5. 页面

- 列表用 `components/useListState` + `ListToolbar`；
  该页 `page.tsx` **必须**包 `<Suspense>`（缺了会整页水合失败，且 HTTP 仍是 200）。
- 同页多个独立列表各给不同 `paramPrefix`，否则互相清空 URL 参数。
- 口径说明用 `CaliberNote`（一句人话 + Popover 全文），不要堆 Alert 横幅墙。
- `"use client"` 文件**禁止值导入** `@/server/*`（类型用 `import type`；
  常量由服务端 API 下发）。违反会毒化整台 dev server。

---

## 让数字可信的四条

这四条比功能本身更重要——它们是业务愿不愿意用这个系统的原因。

1. **诚实降级**：算不出就说算不出，并给原因与出路。绝不编一个看起来合理的数。
   *坏例：售价源没接就按成本×2 估毛利。好例：毛利列留白并注明"售价源未接入"。*
2. **可解释**：建议要带推导链（`planExplain: string[]`），逐条写清安全库存怎么来的、
   为什么施加 MOQ、为什么这次不建议下单。用户不接受"系统说的"。
3. **人工闸**：自动化只产**草稿**，审批永远是人（R13 教义，系统级红线）。
   报表可以陈述事实，**不许自动开单**。
4. **绝不猜**：歧义变成人工队列，不是默认值。猜不出就打 `needsReview` 标。

配套：**告警只在有价值时发**。固定阈值不认识"这条 SKU 本来就这么波动"；
命中才渲染，无命中不占位；抑制必须可见、带原因、可人工推翻。

---

## 收尾

```bash
npx tsc --noEmit 2>&1 | /usr/bin/grep -v "\.next/types"
npx vitest run
```
新页面或新路由 → 跑 `release-sweep`（单测绿 ≠ 页面能用）。
