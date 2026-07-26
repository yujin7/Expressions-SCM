---
name: alert-budget
description: Decide whether an alert, exception, badge, detector, threshold, or notification in this project deserves to exist. Use before adding or tuning alerts, when counts are noisy or unactionable, or when an alert may reflect coverage or caliber errors. Use caliber-change for shared-number definitions and reconcile-supply-chain-truth for factual claims.
---

> **ARCHIVE ONLY** — Historical evidence, not executable guidance. Do not run commands or follow
> routing in this file; use [the quarantine index](README.md) and current `.claude/skills/`.

# 先证明它配存在，再加这条告警

> 下文数字、行号和“今天”均来自一次 2026-07-25 事故审计，用来解释五道门为什么存在，
> 不是永久基线或当前 backlog。做任何告警决策前，在当前 revision 和当前数据上重跑命中量、
> 去重后对象数、误报归因、处置率与抑制数。

补货页曾经对 128 个成品同时喊「可销天数不足 30 天，紧急」。真正缺货的只有 20 个。另外 108 个的货就躺在
海外仓和其他部门仓里——那些仓不在系统快照源里，系统看不见（E054-000 一个 SKU 就差 176,216 件，固化在
`tests/rules/fusion.test.ts:7`）。照着这批告警下单，等于把已经有的库存原样再买一遍。而 108 条误报里
**105 条的根因是数据覆盖缺口**（`src/server/rules/fusion.ts:38-42`：绝对差>10 且相对差>20%），不是阈值
定高了——换任何一套更聪明的统计阈值，一条都救不回来。

**默认答案是「不加」。** 要加先过下面五道闸；已经在跑的，按同样五道复审。

---

## 五道闸

### 1. 先收口径，再调阈值

那 108 条里只有 3 条靠「在订未出/存量在途」解释，wip 贡献 0；换全管道口径 `coverFull` 后 128 → 20。**这是一次口径
修复，不是阈值调优。** 同类活雷还挂在登录首屏：`src/server/modules/workbench/focus.ts:282` 算在库直接
`select sum(qty) from stock_balances`，只算实时账、漏掉全部快照仓；同一文件 `:120` 用的却是 CLAUDE.md 规定的唯一权威
`core/stock-view.getOnHandBySku`。同一批 339 个可评估成品，错口径判 **261** 个「可销 < 生产周期」，全网 D20 口径只有
**111**（补货页同概念 `rules/fusion.ts:67` `belowLeadtime` 正是 111）。2.35 倍，**150 条幻影急单挂在所有 PMC 第一屏**，
还被 `src/jobs/notify.ts:118-121` 每天推一次飞书。`focus.ts:6-7` 头注释写着「可销天数口径与驾驶舱一致」——对这块是假的。

### 2. 模型不可信，就不许它发告警

`src/server/modules/replenish/service.ts:351-359` 先算 backtest FVA，只有 `fva > 0` 的 SKU 才允许发预测偏离告警。今天
`forecastTrusted = 152/1026`、`forecastDivergent = 43`；去掉可信闸（只留「Holt 日均与朴素日均相对差 > 30%」）复算是
**181**，**降噪 76.2%**。闸门不是保守，是有账的：`getForecastAccuracy({})` 今天 `evaluated=441`、`worseThanNaiveCount=243`
（口径为 FVA < −2%，`src/server/modules/report/forecast-accuracy.ts:141`）、`overallFva = −0.063`。**全局上 Holt 还不如
朴素**——不设闸就是拿一个平均而言更差的模型去打扰人。

### 3. 抑制 ≠ 隐藏：四要素缺一不可

补货页是全仓唯一四要素齐全的地方，照抄它：

| 要素 | 实现 | 今天的数 |
|---|---|---|
| 原因字符串 | `service.ts:424` `suppressReason` | distinct 集合大小 = 1 |
| 计数上屏 | `service.ts:479` + `replenish-client.tsx:343` | 放行 80 / 抑制 **91**（抑制的比放行的多） |
| 原始值不丢 | `service.ts:425` `heldQty` | 抑制行仍带原始建议量 |
| 人能推翻 | `replenish-client.tsx:420`（仅 suggestQty 与 heldQty 都为 null 才禁勾）+ `:184` 按 heldQty 生成草稿 + `:498-503` 二次确认 | 可放行，弹「请确认已核实全口径库存后再放行」 |

反面：`src/db/schema/system.ts:165-176` 的 `system_alerts` 只有 `category/refKey/title/detail/severity/status(open|
resolved)/autoResolved`——**没有 suppressReason、没有 ackBy、没有 snooze、没有 note**；`src/app/api/alerts/route.ts`
全文只有一个 GET。人在 UI 上**根本关不掉一条系统告警**，唯一出路是等看门狗下轮 auto-resolve。对照组就在同一文件
`:87-99`：`review_items` 的 status 允许 `overruled`，带 `note/decidedBy/decidedAt`，改判路径完整
（`src/server/modules/review/checklist.ts:108-130`，写审计 `action=review_overrule`）。

### 4. 零命中必须零 DOM

`src/server/modules/report/data-health.ts:60-70` 定义 `StructuralWarning` 并注明「无命中则数组为空，页面不占位」，三处
push 全包在命中判断里（`:154`/`:184`/`:203`）；UI 侧 `data-health-client.tsx:134-135` 是 `(data?.structural ?? []).map(...)`，
零命中即零 DOM，`tests/report/data-health-structural.test.ts:71-77` 守着。控制塔同理：`workbench/focus.ts:238-315` 的
`computeExceptions` **全文只有 5 种异常**，每种都包在 `if (count > 0)` 里（`:248/:264/:270/:295/:311`），`:315` 按
severity→count 排序，今天真实产出 **3 条**。**种类上限写死在代码里**，这是全仓最该抄的一段。

### 5. 必须能量化影响，且能点到动作

控制塔每条异常强制带 impact 字符串（「95 个 SKU · 3,224 件」而不是「有过期库存」）和 href 直达处置页。写不出量化影响的，
说明作者也不知道它意味着什么；给不出处置入口的，只会变成焦虑。

---

## 判定表：看到这些，直接砍

| 你看到的 | 结论 | 该做什么 |
|---|---|---|
| 同概念两处实现、两个数（261 vs 111） | 口径分叉，不是告警问题 | 收口到唯一权威，告警自己消失 |
| 命中率 ≈100%（`shelf_life_missing` 今天 **1026/1026**，`data-health.ts:184-198`） | 没有区分度，是待办不是告警 | 转一次性数据任务；注意它挡住的 `near_expiry_below_channel` 因 hasShelf 为空**永远算不出来** |
| 一个对象同时中多条（`detectors` 里 119 个 SKU 中 2 条、**46 个中全部 3 条**） | 探测器之间不去重 | 按对象合并成一条、列出命中原因 |
| 兜底类目占多数（`/report/risk` 341 行里「滞销关注」**219 条 = 64%**） | 分类等于没分类 | 拆兜底桶，或降级为列表不发告警 |
| 正文自带免责声明（`report/detectors.ts:206`「小幅偏离属口径噪音，请以趋势看待」） | 作者自己都不信 | 删掉，或把门槛提到作者敢信 |
| 阈值写死且不在 `PARAM_DEFS`（`detectors.ts:34-43`：salesDrop=0.7 / channelShift=15 / velocityDeviation=0.4） | 注释里的「便于日后参数化」= 至今没参数化 | 进 `sys_params`，或承认硬编码并写清依据 |
| 阈值卡 40%，而 402 个可评估 SKU 的偏离分布是 <40% 191 / 40-60% 52 / 60-100% 85 / ≥100% 74 | 拍脑袋，无逐 SKU 波动性基准 | 给出基准，否则别发 |
| 顶层限到 3-5 条，下面挂着 **1771** 条待复核计数器（`focus.ts:355-361`） | 预算只做在了看得见的那一屏 | 队列也分层：uncoded 629 / bom_version 501 / segment 335 … 各自有主 |

`detectors.ts` 今天真实产出 **554 行、覆盖 343 个 SKU**（销量骤停 164 / 渠道迁移 179 / 速度突变 211），跨类不去重、不合并、不带抑制原因——**它是这个仓库唯一没有预算的告警页**。

---

## 生命周期纪律（已做对，照抄别重造）

- **没数据不告警**：`src/jobs/freshness.ts:70` `latest != null && ageDays > maxAge`，注释「从未导入不告警（未启用的口径不扰民）」——把「没启用」和「过期了」分开。
- **同一对象只开一条**：`freshness.ts:44-49` 与 `src/jobs/doc-aging.ts:64-68` 先按 `(category, refKey, status=open)` 查重再插入，双调度并存无害。
- **条件消失自动关闭**：`freshness.ts:56` / `doc-aging.ts:86` 写 `status:"resolved", autoResolved:true`。告警要有生命周期，不能只有出生。
- **推送再加日频去重**：`notify.ts:120` `dedupeKey = ${ex.key}:${today}`，同一异常一天最多推一次。

---

## 四个陷阱

- **参数化幻觉**：`src/server/modules/admin/params.ts:29-41` 定义了 13 个可调阈值，`sys_params` 实存只有 **6 行**、global 只有
  4 个 key；`cover_alert_days`、`cover_target_days*`、`safety_days_fallback`、`service_level_pct` 全在跑代码兜底（实测 `minCoverAlert=30`、`serviceLevel=95`）。说「阈值可配」之前先查表里有没有那一行。
- **写好了没接，等于没有**：`src/server/rules/spc.ts` 设计克制（`:93-97` 中位数+MAD、`:125-132` 样本<8 直接返回「样本不足」、
  `:140-147` σ=0 不产生信号、`:164` 一点只留最严重一条）且有 11 个单测，但 `/usr/bin/grep -rn "rules/spc\|detectSignals"
  src/ tests/` 只命中它自己和它的测试，`rules/index.ts` 也没导出它，真正在跑的仍是 `detectors.ts` 三个写死阈值。更关键：
  `sales_monthly` 只有 2026-01~2026-06，441 条序列跑 `detectSignals` **全部**返回「样本不足（6/8 点）」→ 0 信号。**接上去
  也发不出，别把它算成已生效的降噪成果。**
- **战功记错人**：`spc.ts:4-6` 把「128 条紧急里 106 条误报」归因于固定阈值不认识序列波动；按 `fusion.ts:2-13` 的原始归因与实测分解，根因是**数据覆盖缺口**（105/108），统计方法一条都救不回来。归因写错，下一轮就会去优化错的东西。
- **注释说的表不是代码写的表**：`doc-aging.ts:5` 与 `freshness.ts:5-7` 都写「开 review_items…由人工在复核清单关闭」，两处实际
  insert 的都是 `systemAlerts`（`doc-aging.ts:69` / `freshness.ts:54`），而 `system_alerts` 恰恰没有人工关闭入口。
  **连产出告警的代码自己都说不清告警落在哪张表。**

---

## 上线前必须给出的数

不许拿样例数据估，对 dev 全量真实数据跑：

```bash
DATABASE_URL=pglite:.data/dev npx tsx /tmp/count-alerts.ts   # 调服务层，务必 allRows: true（分页默认值会静默截断）
/usr/bin/grep -rn "suppressReason\|overruled\|autoResolved\|ackBy" src/server src/db | /usr/bin/grep -av Binary
/usr/bin/grep -rn "PARAM_DEFS" src/server/modules/admin/params.ts   # 阈值是不是真的可配
```

历史事故基线（2026-07-25，仅用于复现归因，不能当当前目标）：补货 daysCover<30 系统口径 128 / 全管道 20；forecastDivergent 43（无闸 181）；
suggest 80 / suppressed 91；detectors 554 行 / 343 SKU；控制塔异常 3 条；待复核 1771。

**报告口径**：给「上线后每天发多少条 / 多少条有人处置 / 抑制了多少条及原因」，不要给「已加告警覆盖 X 场景」。
覆盖率是加告警的人的 KPI，不是看告警的人的收益。
