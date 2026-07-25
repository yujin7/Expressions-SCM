---
name: measure-first
description: Measure before performance optimization, caching, rollups, or large refactors in this project. Use to establish reproducible baselines, separate cold-start and rounding artifacts from real defects, and validate claimed speedups. Use caliber-change or reconcile-supply-chain-truth for correctness rather than latency.
---

# 没有基线数字的性能改动，改的是幻觉

> 下文数字、缓存状态、表行数、消费者数量和“今天”来自 2026-07-25 的历史审计。保留它们是
> 为了说明测量陷阱，不是宣称当前仍如此。每次优化必须在当前 revision、代表性数据和目标环境
> 重新建立冷/热、吞吐、尾延迟、资源与业务 SLO 基线。

提交信息写着：「struct#16 自动补货候选 60s 缓存：实测 1.48s→0.099s（15×）」。
缓存只有读没有写——`arCache` 在 `src/server/modules/report/auto-replenish.ts:71` 被读，函数 `:128-136` 直接 return 对象字面量，全函数没有一次赋值（`git show 0e7b9a6` 里它也只出现在 :66/:68/:72 三行）。真跑一遍：清缓存 105ms，不清缓存 105ms，一模一样；那个 15× 是同一进程里 call#1（521ms，建连+迁移检查+JIT）和 call#2（116ms）之差。
半个月后，E7-01 预聚合层——三张表、一次迁移、一个夜间任务——的立项理由写在 `src/db/schema/rollup.ts:4-7`：「靠 60 秒进程内缓存硬撑」。撑的是一个从没生效过的缓存。今天这三张表：2436 行、344 行、0 行，**零读取方**。

---

## 先量：三支被怀疑慢的报表，实测都不慢

数据规模：1026 个在售成品、7054 行 `sales_monthly`、441 个有销量 SKU。

| 报表 | 实测中位数 |
|---|---|
| `getSegmentation(allRows)` | 12ms（7 次 [12,13,13,13,13,13,13]） |
| `getReplenishSuggestions(allRows)` | 93–130ms |
| `getAutoReplenishCandidates` | 105–116ms（清缓存与不清完全一致） |
| `getDashboard(admin)` | 冷 108ms / 命中缓存 0ms |

全部在 150ms 以内 → **改接 rollup 表能省的绝对值 < 150ms**。

441 不是报表规模：`select count(distinct sku_id) from sales_monthly` = 441，报表实际扫的是
1026 行成品；`getForecastAccuracy` 的 `summary.evaluated` 恰好也是 441，别把两者当同一个量。

复现（不要对着 `.data/dev` 本体跑，另一个 session 可能正开着 dev server）：

```bash
cp -R .data/dev "$SCRATCH/devcopy"
DATABASE_URL=pglite:"$SCRATCH/devcopy" npx tsx scripts/_tmp-bench.ts   # 新进程内连调 5–7 次
/usr/bin/grep -rn "rollupSkuMonth|rollupWarehouseSku" --include="*.ts" src tests scripts
```

冷启动与稳定态分开报告；稳定态中位数可排除 call#1，但面向首个请求的场景不能把冷启动丢掉。

---

## 判定：这个数字是假象，还是缺陷

| 观察到的 | 它其实是 | 该做什么 |
|---|---|---|
| 改前一次 vs 改后一次，快了 10×+ | 冷启动 | 新进程连调 6 次实测 521/116/110/113/115/111ms——首调贵在建连+迁移检查+JIT，与改动无关。丢弃首调，比中位数 |
| 「缓存生效了」 | 可能只有读没有写 | 清缓存与不清各测一组中位数；相等即缓存从未跑过（arCache：105 vs 105） |
| 线上采到一个中间值 | 冷热混采 | dashboard 的 60s 缓存是真生效的：命中 0ms、冷 108ms，两者之间的任何数字都不是它的真值。冷/热分开报 |
| 两页数字对不上，差在 0.1 量级 | 展示层舍入 | `replenish/service.ts:340-342` 用未舍入的 dailyNum 算 daysCover，`:440-441` 才把 daily 与 daysCover 各自 r1；拿 r1 后的 daily 重算 cover，402 个有销量成品里 206 个对不上——这 206 条不是缺陷。比对必须用未舍入值 |
| 两页数字对不上，差的是分类/等级 | 口径漂移，真缺陷 | 两套帕累托各写一遍（边界约定不同 + 窗口不同），441 个 SKU 里 41 个分层不一致（`invariants.md:70`）；修法是唯一权威 `rules/abc.ts` 的 `classifyAbc`（提交 e5d3fc4）。转 caliber-change |

性能改动的门槛由用户可见 SLO、调用频率、并发、尾延迟、资源成本和风险共同决定；
该次历史样本的稳定态 <150ms，不足以证明需要重构。
正确性问题没有门槛：41/441 必须改，因为它**不报错**。

---

## 改接汇总表之前，算清楚换来的是什么

省 <150ms，同时引入三条静默偏差：

- **陈旧**：`src/jobs/interval-runner.ts:47` 24h 才跑一次
- **维度丢失**：`src/jobs/rollup.ts:41-43` 只按 (skuId, yearMonth) 聚合，把
  `sales_monthly.channelId`（`schema/dimensions.ts:89-95`）轧掉了，而 dashboard 的渠道/品牌块正靠它
- **预舍入**：`src/jobs/rollup.ts:22` 的 `dec()` 在物化时就 `Math.round(v*100)/100`，源表 `qty` 是 `numeric(14,4)`

落地后至今零消费者：上面那条 grep 除 `jobs/rollup.ts` 与 schema 外无命中。
`rollup_supplier_lead` 0 行，但 `replenish/service.ts:306-318` 每次调用仍要拿 1026 个 skuId 去 `inArray` 查它一遍。

---

## 缓存：全仓 9 处，只有 2 处能失效

| 位置 | TTL | 失效路径 |
|---|---|---|
| `core/params.ts:12-31` | 60s | 有——`modules/admin/params.ts:90` |
| `core/scoped-params.ts:94-115` | 60s | 有——`:185-186` |
| `report/dashboard.ts:66-82` | 60s，按角色分键 | 无——`clearDashboardCache` 零调用方。缓存是真生效的，所以写库后 60 秒内页面就是旧的 |
| `report/auto-replenish.ts:65-71` | 60s | 无——`clearAutoReplenishCache` 零调用方，且本来就没写入路径 |
| `components/useMe.ts:12` | 会话级 | 无 TTL 无失效 |
| `components/SkuHoverCard.tsx:34-52` | 60s | 失败不缓存 |
| `import/adapters/sku-cost.ts:104`、`jobs/reconcile-jst.ts:138` | 单次运行内 memo | 不适用 |
| `app/api/attachments/[id]/file/route.ts:17` | `private, max-age=0, must-revalidate` | 不适用 |

加缓存前先写下失效路径由谁调用。写不出调用方，这个缓存的实际语义就是「静默返回 60 秒旧数据」。

**这一类缺陷 CI 结构上抓不到，不是漏测。** 两处报表缓存都按「测试传 db 或 `NODE_ENV=test` 就 bypass」实现（`auto-replenish.ts:67,70`、`dashboard.ts:69,73`），理由正当——口径校验必须见实时数据——于是缓存路径在测试里永不执行。全仓 112 个 test 文件里 `/usr/bin/grep -rn "cache" tests` 零命中，`tests/report/` 下 8 个文件没有一个测 dashboard/segmentation/auto-replenish。只能手测。

---

## 正例：唯一一次真的测了，结论是负的

441 个成品滚动回测：Holt WAPE 55.9% vs 朴素法（下月＝上月）49.6%，FVA −6.3%，243 个 SKU（55%）不如照抄上月（`report/forecast-accuracy.ts:132-150`）。
处置不是删模型，是给「预测偏离」告警加可信闸——只有该 SKU 的 `fva>0` 才发警报（`replenish/service.ts:344-359`）：告警 176→43，降噪 76%；1026 行成品里 `forecastTrusted` 只有 152 个。
同段代码里那句「回测是纯计算（12 点序列，无 IO），不构成热路径开销」也被测了：1026 次 12 点序列 backtest 合计 **1ms**，占 replenish 全量 130ms 的 0.8%——声明成立。

可测的声明就去测；测出来是负的，改处置方式，不改数字。

---

## 合格的性能理由长什么样

`src/db/schema/inventory.ts:26-28`：「无筛选流水默认视图 ORDER BY occurredAt DESC, id DESC LIMIT——无此降序索引时 1M 行需全表排序（实测 662ms）；有则走索引扫描（perf-smoke 复测）」。有场景、有量级、有复测手段——这是本仓唯一一条带真实基线数字的性能决策。

反面：`scripts/perf-smoke.ts:1-5,63-72` 造 10 万行合成台账测 listBalances/listLedger，**没进 package.json 的任何 script**，全仓除自身文件头外只被 `inventory.ts:27` 提过一次，且从不触碰 segmentation/dashboard/auto-replenish 这三支真正被怀疑慢的报表。有工具 ≠ 测过。

---

## 报告口径

- 报中位数、样本数、是否丢弃首调：「segmentation 12ms（新进程 7 次中位数，丢弃 call#1）」。只报一个数字＝没测。
- 报绝对值，不报倍数。同一个「15×」在 105ms 上是省 98ms，在 1.48s 上是省 1.38s——不给基数的倍数没有信息量。
- 声称缓存生效，必须附「清 vs 不清」两组数字；声称缓存能失效，必须附失效函数的调用方 file:line。
- 建了物化表先 grep 读取方，再说做完了。2436 行 + 344 行 + 0 行、零消费者，不是成果。
- 结论允许是「不用改」。三支报表 12–116ms，这次的正确结论就是不动它们。
