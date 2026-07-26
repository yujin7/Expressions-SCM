---
name: caliber-change
description: Change shared business calculations in this project without caliber drift, including on-hand, supply, velocity, days of cover, ABC, safety stock, net requirement, and settlement loss. Use when adding, editing, duplicating, or reconciling a calculation shown in multiple places. Do not use for display-only formatting or one-off local numbers.
---

> **ARCHIVE ONLY** — Historical evidence, not executable guidance. Do not run commands or follow
> routing in this file; use [the quarantine index](README.md) and current `.claude/skills/`.

# 改口径

口径漂移是这个系统最贵的缺陷类，因为它**不报错**——两个页面各自算得好好的，
只是同一个 SKU 在这边是 A 类、那边是 B 类。用户先信任，后发现，然后不再信任任何数字。

**规则：口径只有一个实现。第二次写同一个计算时就抽出来，不要等第三次。**

---

## 现有唯一权威（先查这张表，再动手）

| 口径 | 唯一实现 |
|---|---|
| 在库 / 最新快照 | `core/stock-view.ts` — `getOnHandBySku` / `getLatestSnapshotRows` |
| 在途 / 未结供给 | `core/supply.ts` — `getOpenSupplyLines` |
| 销速窗口 / 日均 | `core/velocity.ts` — `lastMonths` / `dailyFromWindow` |
| ABC 分层 | `rules/abc.ts` — `classifyAbc`（标准帕累托，窗口近 6 月） |
| 安全库存 | `rules/safety-stock.ts` |
| 净需求 | `rules/netreq.ts` / `rules/timephased.ts` |
| 委外结算 | `rules/settlement.ts`（逐物料，禁跨物料轧差） |

表里有 → 调它。表里没有但你要写第二遍 → 先抽到 `rules/` 或 `core/`，再用。

---

## 四步

### 1. 先找重复（几乎总有）

```bash
# 按概念找，不按变量名找——各处命名不同才是问题所在
/usr/bin/grep -rn "max(bizDate)\|latest.*snapshot" src/server | /usr/bin/grep -av Binary
/usr/bin/grep -rn "0.8\|0.95" src/server/rules src/server/modules | /usr/bin/grep -av Binary   # 帕累托边界
```

找到 N 处实现时，**先逐处读出它们的口径差异并列出来**，不要直接合并。
差异本身就是发现：ABC 那次合并前，两处的边界约定不同 **且** 窗口不同，是两个 bug 叠在一起。

### 2. 抽成纯函数

放 `src/server/rules/`（业务判定）或 `src/server/core/`（取数口径）。
铁律：无 IO、无 DB、无时间副作用（`today` 由调用方传入）。
模块头注释必须写清：**解决什么问题 / 口径来源（spec 章节或 D 编号）/ 诚实降级条件**。

### 3. 证明合并前后一致 —— 这一步不能跳

改口径必须给出**收敛证据**，不能只说"应该一样"。

```bash
# 起 dev server，登录（provider 是 local 不是 credentials），逐 SKU 比对两个来源
curl -s -b /tmp/j.jar "http://localhost:3000/api/report/segmentation?allRows=true" > /tmp/a.json
curl -s -b /tmp/j.jar "http://localhost:3000/api/replenish?allRows=true"          > /tmp/b.json
# 然后写个一次性 python 比对，输出「不一致条数」——目标是 0
```

ABC 统一后实测 **0 处不一致**（此前 41/441）。这个数字必须真的跑出来，写进提交信息。

### 4. 迁移调用方，并留反向护栏

- 全部调用方改调唯一实现；旧实现**删掉**，不要留着"以防万一"。
- 内部消费者传 `allRows: true`——分页默认值会造成静默截断（MRP 曾只看到 999 个产品）。
- 纯函数配单测；边界值（0 销量、单 SKU、并列）单独测。

---

## 口径变更的三条纪律

1. **参考层只能调高认知，绝不调低**：`有效在库 = max(系统在库, 全口径参考)`。
   参考层（`transit_refs` / `batch_stocks`）永不过账。
2. **算不出就诚实降级**，不要编一个看起来合理的数——降级要带 `method` 与中文原因
   （见 `rules/safety-stock.ts` 的 `fallback`）。
3. **改口径要改 `CaliberNote`**：页面上那句人话必须跟着改，否则用户看到的解释是旧的。

---

## 提交前

```bash
npx tsc --noEmit 2>&1 | /usr/bin/grep -v "\.next/types"
npx vitest run
```

提交信息里必须有**收敛证据**（"统一后逐 SKU 比对 0 处不一致"），
没有这句就说明第 3 步没做。
