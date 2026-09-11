# 驾驶舱四屏线框（2026-09，D50）

> 用途：按会议要求「先线框后开发」。本文逐屏逐卡给出：卡名、回答的决策问题、数据来源、指标 id、交互、可见角色、口径限制文案。
> 路由：`/cockpit`（业务域页，与 `/report/dashboard` 并列，D50）；Tab 写进 URL（`?tab=sources|alerts|inventory|ops`），
> 每屏列表用 `useListState` 且 paramPrefix 分别为 `ds_` / `al_` / `inv_` / `todo_`；`page.tsx` 必须包 `<Suspense>`。
> 实施映射见 `docs/engineering/总监需求-现状映射与实施计划-2026-09-03.md`。
> 可分享的可视化版本（供总监签认）：https://claude.ai/code/artifact/28b8af6e-f23c-45dc-aafd-3642725f3c62
>
> 数据来源列的记法：表 = 正式事实表；读模型 = `report_read_model_cache` 键；契约 = 简道云契约键（observation_only）；
> 指标 id：「已有」= `src/components/metrics.ts` 已登记；「新」= 命名建议，W3 登记。

---

## 0. 全屏通用约定

**顶栏（每屏固定，一行）**

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ 驾驶舱四屏   [数据来源与总量] [预警] [库存管控] [日常事务]        角色：pmc  范围：全渠道 │
│ 来源 SCM+简道云 · 数据截止 2026-09-03 10:32 · 覆盖 成本 63% / 身份 71% · 口径 v1 · 参数页 ↗ │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

- 顶栏四字段来自 `data-source-readiness`（最近成功批次）、`core/valuation` 覆盖率、`external-velocity` 身份覆盖；「口径 vN」= cockpit 读模型缓存键版本。
- 受限用户（ops 且有 `user_data_scopes`）顶栏显示「范围：天猫」并把渠道选择器改为只读标签；库存类卡片显示「不按渠道记账」提示（沿用 dashboard `scope.notAppliedTo`）。

**卡片契约（DecisionVisual）**：每卡必须有 决策问题 / metricId / 来源 / 时点 / 覆盖 / 限制 / 五态（loading·empty·error·insufficient·ready）。数值旁随带样本 n；n 不足显示「样本不足」，绝不补 0。

**例外表**：每屏 ≤ 一个视口高度，例外表 ≤ 20 行，「查看全部」进对应列表页。

**金额可见性**：库存金额 / 调拨费用 / 订单金额仅 PRICE_VISIBLE_ROLES（purchasing / pmc / finance / admin）；销售金额仅 finance / admin / pmc（D53，DTO 键 salesAmount 已入 SENSITIVE_FIELDS）。其他角色收到的是**服务端已剥离**的载荷，前端只负责折叠展示。

**手工改写入口**：唯一一处 = 屏 1「当月销售金额」卡的「录入/修正」按钮（finance/admin），写 `sales_amount_monthly`（append-only supersedes + writeAudit）；其他卡无手工改写。

**角色矩阵（D62）**

| 屏 / 卡 | admin | pmc | purchasing | warehouse | finance | quality | ops（受限） |
|---|---|---|---|---|---|---|---|
| 屏 1 数量类、数据来源 | 全 | 全 | 全 | 全 | 全 | 全 | 全（库存总量属公开内容） |
| 屏 1 库存金额 / 占比 | ● | ● | ● | ○ | ● | ○ | ○ |
| 屏 1 销售金额 | ● | ● | ○ | ○ | ● | ○ | ○ |
| 屏 2 预警表 / 爆单 | 全 | 全 | 全 | 全 | 全 | 只读 | 本渠道 SKU 的行 + 未映射平台 SKU（本渠道店铺） |
| 屏 2 订单系统（金额） | ● | ● | ● | ○ | ● | ○ | ○ |
| 屏 3 各仓明细 / 周转（数量） | 全 | 全 | 全 | 全 | 全 | 只读 | 全（公开内容） |
| 屏 3 调拨线路费用 / 异常 | ● | ● | ○ | ● 数量 | ● | ○ | ○ |
| 屏 4 待办 | 全员按人 | 同 | 同 | 同 | 同 | 同 | 同 |
| 屏 4 部门目标 | 全部门 | 本部门 | 本部门 | 本部门 | 本部门 | 本部门 | 本部门（ops） |

● 可见金额 ○ 服务端剥离（卡片显示「无权限查看金额」空态，不是 0）

---

## 1. 屏 1 · 数据来源与总量（tab=sources，paramPrefix ds_）

回答的问题：**今天的数在不在、到哪天了、总量多少、月度走势如何。**

```
┌ 顶栏 ─────────────────────────────────────────────────────────────────────────────┐
├ A 行（4 瓦片） ──────────────────────────────────────────────────────────────────┤
│ ┌ 当月库存数量 ┐ ┌ 当月库存金额 ┐ ┌ 当月销售金额 ┐ ┌ 库存占比 ┐                     │
│ │ 1,284,530 件 │ │ ¥ 12,340,210 │ │ ▒▒▒ 点开查看 │ │ 48.6% ▲1.2pp│                 │
│ │ 本月入 +xx   │ │ 覆盖 63% ⚠  │ │ 手工值·9月   │ │ 目标 45–47% │                 │
│ │ 本月出 −xx   │ │ 不完整       │ │ 参考 观察 ¥… │ │ 月均版 49.1%│                 │
│ └──────────────┘ └──────────────┘ └──────────────┘ └────────────┘                 │
├ B 行 ─────────────────────────────────────────────────────────────────────────────┤
│ 历史按月（近 12 月）  [数量] [金额] [销售金额] [占比]   环比列                        │
│ 月份 | 月末在库 | 环比 | 月末金额 | 环比 | 销售金额 | 环比 | 占比 | 环比(pp)          │
│ 2026-06 … 上线前月份：「系统上线前无逐日账，未补录」                                   │
├ C 行 ─────────────────────────────────────────────────────────────────────────────┤
│ 数据来源状态（≤20 行）                                                            │
│ 来源 | 流 | 状态 | 最近成功 | 业务截止 | 源行/落库行 | 下次计划 | 阻断原因            │
│ 简道云 | 天猫SKU日销 | 正常 | 09-03 10:31 | 09-02 | 12,4k/12,4k | 16:30 | —          │
│ 聚水潭 | 销售出库 | 授权阻断(110) | — | — | — | — | 出口 IP 未白名单                  │
│ 用友   | 应付     | 未授权(0/8)  | … │
│ SCM    | sales_monthly | 停更 | 2026-06 | … │
│ SCM    | 快照仓 E 仓 | 数据龄 2 天 | … │
└───────────────────────────────────────────────────────────────────────────────────┘
```

| 卡 | 决策问题 | 数据来源 | 指标 id | 交互 | 可见角色 | 口径限制文案（来源·时点·覆盖·限制） |
|---|---|---|---|---|---|---|
| A1 当月库存数量 | 现在全网有多少货，本月至今进出多少 | `core/stock-view.getOnHandBySku`（实时仓 stock_balances + 快照仓最新 stock_snapshots）；读模型 `inventory-daily-position/v1` 本月入/出 | 已有 onHandSystem、onHandExternal；新 inOutDaily | 点击 → 展开当月逐日出入库表（同读模型），每行深链 `/inventory/ledger?from&to`；快照仓行标「无流水」 | 全员 | 来源：SCM 账 + 快照仓最新快照 · 时点：实时仓即时 / 快照仓 bizDate · 覆盖：全部启用仓，跨 SKU 按基础单位直加仅作参考 · 限制：当月 = 当前时点（D52） |
| A2 当月库存金额 | 压了多少钱，估值可信度 | `core/valuation.ts`（sku_costs → 财务运营成本观察 → null）× A1 数量 | 新 inventoryValue、inventoryValueCoverage；已有 costCoverage | 点击 → 逐日出入库金额表；覆盖率 <80% 卡片标「不完整」并列出未计价 SKU 数，点「未计价清单」→ `/report/margin` | PRICE_VISIBLE_ROLES | 来源：手工成本基准（sku_costs）/ 财务运营成本观察 · 时点：随成本版本 · 覆盖：63%（示例）· 限制：非财务账面；成品+部件；实时仓/快照仓分列（D51） |
| A3 当月销售金额 | 本月卖了多少钱（财务口径） | 表 `sales_amount_monthly`（supersedes 链尾）；参考：读模型 `platform-sales-amount-monthly/v1`（天猫支付−退款、唯品会销售额；拼多多无金额） | 新 salesAmountMonthly；已有 netRevenue（观察，影子） | 默认折叠「点开查看」；finance/admin 有「录入/修正」按钮 → 抽屉（月份、范围 company/brand/channel、金额、来源 manual/prefill_observation、备注）→ 写路径审计；「用观察预填」按钮填入并标来源 | finance/admin/pmc（其他角色服务端剥离，卡片显示无权限空态） | 来源：财务手工月录 / 外部观察预填 · 时点：录入时间 · 覆盖：company 级必有，brand/channel 可选 · 限制：口径含税/退款待财务追认（D53）；不进入任何补货计算 |
| A4 库存占比 | 离 45–47% 目标还有多远 | `rules/inventory-sales-ratio.ts`（A2 月末 ÷ A3；月均版并列）；参数 inventory_sales_ratio_target_low/high | 新 inventorySalesRatio | 目标带着色（红 >50、黄 47–50、绿 45–47、蓝 <45）；点击 → B 行切到「占比」；「调整目标」链接 → `/admin/params` | 同 A2 ∩ A3 | 来源：A2/A3 · 时点：月末/当月 · 覆盖：两项都可用才出现 · 限制：分子按成本、分母按售价，非同口径；基线 50%（D54） |
| B 历史按月与环比 | 走势是否在改善 | 读模型 `inventory-daily-position/v1` 月末序列 + `sales_amount_monthly` + `rules/period-compare.ts` | 新 onHandMonthEnd、inventoryValue、salesAmountMonthly、inventorySalesRatio | Tab 切换四指标；环比缺上期显示「—」不补 0；上线前月份灰显「未补录」 | 按指标同 A 行 | 来源：同 A · 时点：月末日终（实时仓流水倒推、快照仓当月最后快照）· 覆盖：stock_ledger 最早 occurredAt 之后 · 限制：历史不强制补全（会议）|
| C 数据来源状态 | 今天该来的数来了没有、哪条被阻断 | `data-source-readiness.loadDataSourceReadiness`（安全摘要）+ `admin/health.getOpsHealth`（job_runs、快照数据龄）+ `sales-window` + import_jobs 最近批次 + `rules/schedule-next-run.ts`（SCHEDULES）| 新 dataSourceFreshness | 行点击 → `/admin/health` 或 `/import/jobs`；阻断行显示解锁清单链接 `docs/integrations/EXTERNAL-SYSTEMS.md §1a` | 全员（DTO 不含凭据/原始值） | 来源：integration_runs / job_runs / import_jobs · 时点：最近一次运行 · 覆盖：四源 33 条契约 + SCM 内部流 · 限制：聚水潭 6/6、用友 8/8 授权阻断如实显示（D50）|

---

## 2. 屏 2 · 预警（tab=alerts，paramPrefix al_）

回答的问题：**今天哪些 SKU 要动手（断货 / 爆单），采购链路健康吗。**

```
┌ 顶栏 ─────────────────────────────────────────────────────────────────────────────┐
├ A 行 红卡条 ──────────────────────────────────────────────────────────────────────┤
│ ■ 爆单预警 7（未知悉 5）  ■ 断货预警 S/A/B 23  ■ 断货时点 SKU 4  ▪ 系统告警 open 12  ▪ 风险处置 9 │
├ B 行 ─────────────────────────────────────────────────────────────────────────────┤
│ 库存预警表（≤20 行，按主预警优先级）                        │ 爆单预警（≤10 行）            │
│ 等级|SKU|日销|7日|15日|30日|在库|在库可销|阈值|预计断货|最晚下单|主预警|动作 │ SKU/平台SKU|3日数量|涨幅|来源|已知悉 │
│ S |A001|32|210|480|960|1,200|37d|50d|09-28|09-12|断货风险|[调拨][补货] │ A001 | 40/62/95 | +180% | 天猫 | [✓] │
│ A |B120| 8| 51|110|225| 190|24d|50d|09-15|已过 |最晚下单已过|[补货]    │ 未映射: 平台SKU 8871… | … | 拼多多 | [认领] │
│ … (C 级默认折叠，标「运营兜底」)                              │ 来源截止 09-02 · 身份覆盖 71% │
├ C 行 订单系统 ────────────────────────────────────────────────────────────────────┤
│ 已下单 本月 18 单 / 42,300 件 │ 已下单金额 未税 ¥1.2M（含税 ¥1.36M）│ 订单→交付 P50 21d / P90 34d (n=9) │ 成本下降 YTD ¥86k（涨本另列 ¥12k）│
└───────────────────────────────────────────────────────────────────────────────────┘
```

| 卡 | 决策问题 | 数据来源 | 指标 id | 交互 | 可见角色 | 口径限制文案 |
|---|---|---|---|---|---|---|
| A 红卡条 | 有多少事今天必须处理 | system_alerts open 计数（category=sales_spike / inventory_cover）；`workbench/focus.computeExceptions`（同源）；断货时点 = 在库 ≤0 且近 6 月有销 SKU 数（stock-view + sales_monthly，按分层）；`report/risk.getRiskWorklist` 计数 | 新 salesSpikeCount、inventoryCoverAlertCount；已有 riskActionCount、exceptionSlaRate | 红卡 = 共享 `AlertBanner` 组件（与工作台同一处）；点击 → `/inventory/alerts?tab=spike` / `?tab=cover` / `/alerts` / `/report/risk` | 全员；ops 只计本渠道 | 来源：system_alerts（11/17 点看门狗）· 时点：最近看门狗运行 · 覆盖：S/A/B 级开告警，C 级仅列表（D57）· 限制：计数与 B 行表格同一读模型 |
| B-左 库存预警表 | 哪个 SKU 什么时候断、最晚何时下单 | 读模型 `demand-daily/v1`（日销三源并列：平台净件数 / JST 出库 / 实时仓出库）+ `replenish/service.getReplenishSuggestions`（shortageDate / orderByDate / belowLead）+ `rules/alert-threshold.ts`（阈值与 source）+ `rules/alert-priority.ts`（主预警）+ `sku_planning_policy` 最新期 tier | 已有 daysCover、coverFull、safetyQty、suggestQty、salesQty、externalNetDemand；新 inventoryCoverAlertCount | 列头切换日销来源（平台/JST/实时仓，默认平台）；行「调拨」→ `/report/transfer-suggest?skuIds=`；「补货」→ `/replenish?sku=`；等级列点击 → `/report/segmentation`；阈值来源为 default 时行上标「按默认周期」；「查看全部」→ `/inventory/alerts` | 全员；ops 本渠道 SKU | 来源：日销 = 简道云平台支付−退款（observation_only）/ JST 手工模板 / SCM 实时仓出库（不含快照仓、剔除调拨）· 时点：平台 T+1 · 覆盖：已映射 1,703/2,076 平台 SKU · 限制：可销天数按「在库可销」；阈值 = 加工周期+在途周期+缓冲（D57）；观察序列只预警不定量（D55）；三源不相加 |
| B-右 爆单预警 | 哪个链接要爆了，要不要提前备 | 读模型 `demand-daily/v1` + `rules/sales-spike.ts`；system_alerts(sales_spike) | 新 salesSpikeCount | 「已知悉」→ `PATCH /api/alerts/[id]/ack`（写审计）；未映射平台 SKU 行「认领」→ `/report/decision-studio?tab=identity`；行点击 → 抽屉：三日序列、前 7 日均、主供应商产能余量（suppliers 申报 + P90）、运营计划事件（ops_plan_events）| 全员；ops 本渠道店铺 | 来源：简道云天猫日销 / 拼多多订单（3 天窗）· 时点：T+1 · 覆盖：未映射平台 SKU 另列 · 限制：规则 = 最近 3 天每日 ≥ 前 7 日均×1.5 且基线 ≥10（D56，可调）；缺日不判定；大促日历未接（参数位）|
| C 订单系统 | 采购下了多少、多久到、省了多少 | 读模型 `purchase-order-metrics/v3`（po_docs / po_lines / approvals / sh_docs / ct_lines；`rules/po-cycle.ts`、`rules/cost-saving.ts`、`core/supply.getOpenSupplyLines`）| 已有 openSupplyQty、onTimeRate、promiseReliability、supplierPriceVariance；新 orderedPoCount、orderedQty、orderedAmount、orderToDeliveryDays、costSavingYtd | 四瓦片点击 → `/report/purchase-orders`（月/供应商/品牌维）；P50/P90 n<3 显示「样本不足」 | 单数/数量全员；金额 PRICE_VISIBLE_ROLES | 来源：SCM PO 事实（不含简道云旧采购单）· 时点：rollup 每日重建 · 覆盖：2026-07 起 · 限制：已下单 = PO 审批通过；金额未税为主含税并列（采购订单口径，非应付）；交付 = 审批→首批 SH；降本只计降价、涨价另列不轧差（D63）|

---

## 3. 屏 3 · 库存管控（tab=inventory，paramPrefix inv_）

回答的问题：**货在哪、转得快不快、调拨贵不贵、哪条线路不正常。**

```
┌ 顶栏 ─────────────────────────────────────────────────────────────────────────────┐
├ A 行 ─────────────────────────────────────────────────────────────────────────────┤
│ 各地各仓库存明细（≤20 行）                                         │ 总周转 3.8 次/年 │
│ 地区|仓库|类型|在库|金额|窗口出库(90d)|周转|DIO|低于阈值SKU|数据截止      │ (仅实时仓, n=6) │
│ CN |总仓|实时|520k|¥5.1M|180k|3.9|94d|12|即时                        │ 启用仓库 9 / 12 │
│ CN |保税E|快照|210k|¥2.0M|无流水|—|—|—|09-01 (龄2天)                 │ [仓库主档 ↗]    │
├ B 行 ─────────────────────────────────────────────────────────────────────────────┤
│ 调拨线路（≤20 行，按 30 天单数）                                                    │
│ 线路 from→to|类型|30天单数|Σ件|元/件|基线元/件|偏差|n|状态                            │
│ 工厂A→总仓|工厂发仓|6|18,400|0.82|0.71|+15%|14|watch                                │
│ 总仓→保税E|保税转运|2|4,000|—|—|—|2|样本不足                                         │
├ C 行 ─────────────────────────────────────────────────────────────────────────────┤
│ 调拨异常（≤10）：单号|线路|类型|数量 vs 中位数|单位费 vs 基线|级别|动作   │ [启动调拨计算 →] │
│ DB2609-012|总仓→云仓|仓间|3.4×|+42%|alert|[看单据]                     │ 低于阈值 SKU 23 │
└───────────────────────────────────────────────────────────────────────────────────┘
```

| 卡 | 决策问题 | 数据来源 | 指标 id | 交互 | 可见角色 | 口径限制文案 |
|---|---|---|---|---|---|---|
| A 各地各仓明细 | 哪个仓压货、哪个仓转不动 | 读模型 `warehouse-inventory/v1`（stock-view 逐仓 + stock_ledger 窗口出库 + `rules/inventory-metrics.turnover` + `core/valuation` + warehouses.regionCode/parentId + alert-threshold 低于阈值计数）| 已有 turns、dio、onHandSystem；新 warehouseTurns、inventoryValue | 行点击 → `/inventory/balance?warehouseId=`；周转列头切换窗口 30/90/365；「查看全部」→ `/inventory/warehouses`；地区按 regionCode 分组、仓库树按 parentId 折叠 | 数量全员；金额 PRICE_VISIBLE_ROLES | 来源：SCM 账 + 快照仓最新快照 · 时点：实时/快照 bizDate · 覆盖：启用仓 · 限制：周转 = 窗口出库 ÷ (期初+期末)/2（期初由流水倒推），出库含调拨/发料/盘亏非纯销售；快照仓无流水不计算；跨 SKU 数量直加仅参考 |
| A-右 总周转 / 仓库数 | 总体转速；仓库是否过多 | 同上汇总（仅实时仓）；warehouses active 计数 vs 参数 warehouse_max_active | 新 warehouseTurns | 点击 → `/master/warehouse`；超上限显示提醒（不阻断，D60） | 全员 | 来源：同 A · 覆盖：仅实时仓 n 个 · 限制：上限 12 为提醒参数（D60，可调）|
| B 调拨线路 | 哪条线路贵了、样本够不够 | 读模型 `transfer-routes/v1`（stock_docs subtype=transfer + transfer_type + transfer_fees 净额 + `rules/transfer-cost.ts` 基线/偏差/n）；简道云 warehouse-transfer-observation 历史单独一段（observation_only）| 新 transferLaneAvgFee、transferDocCount | 行点击 → `/inventory/transfer-routes?from&to&type`；状态列：normal / watch（n<8 或 2<\|z\|≤3）/ alert（n≥8 且 \|z\|>3）/ 样本不足；「登记费用」→ 调拨单详情抽屉（warehouse/finance） | 单数/件数全员；元/件与费用 PRICE_VISIBLE_ROLES | 来源：SCM 已完成调拨单 + 人工登记费用 · 时点：单据完成日 / 费用 biz_date · 覆盖：费用从上线起累计，n 随数值显示 · 限制：线路 = (from,to,type)；基线 = 近 180 天数量加权均价；偏差 >20% 提醒不阻断（D60，可调）；不跨线路轧差、不进库存成本 |
| C 调拨异常 + 启动调拨计算 | 哪张单要复核；哪些 SKU 该调 | system_alerts(category=transfer_cost)；`rules/transfer-cost.ts` 数量异常（> 中位数×3）与零散（30 天 >4 单）；低于阈值 SKU 数来自 alert-threshold | 新 transferAnomalyCount、inventoryCoverAlertCount | 「看单据」→ `/inventory/docs?docNo=`；「启动调拨计算」→ `/report/transfer-suggest?skuIds=<低于阈值 SKU>`（只读建议，不开单）| 数量异常全员；费用异常 PRICE_VISIBLE_ROLES | 来源：看门狗 11/17 点 · 覆盖：仅正式调拨单 · 限制：调拨计算只出建议，成单走 `/inventory/docs` 人工审批；快照仓不作调出/调入方 |

---

## 4. 屏 4 · 日常事务（tab=ops，paramPrefix todo_）

回答的问题：**我今天要做什么、部门目标到哪了、数据这周核对了没有。**

```
┌ 顶栏 ─────────────────────────────────────────────────────────────────────────────┐
├ A 行 ─────────────────────────────────────────────────────────────────────────────┤
│ 待办进度                                              │ 待我审批 6 │ 复核清单 14 │ 未读通知 3 │
│ 我的：未完成 8 · 逾期 2 · 本月完成率 76%（按时 61%）   │ [→/inbox]  │ [→/review]  │ [→通知]   │
│ 部门(角色)：pmc ████████░░ 80%  purchasing ██████░░░░ 62% … [新建待办] [→/todo]          │
├ B 行 ─────────────────────────────────────────────────────────────────────────────┤
│ 供应链目标（本部门 · 2026-Q3）                                                     │
│ 指标|目标|实际|达成|方向|来源   │ 库存占比 47%|48.6%|未达|↓|auto │ 账期达成率 100%|40%|进行中|↑|auto │
│ 交付周期 P50 20d|21d|接近|↓|auto │ 数据准确率 95%|—|待核对|↑|manual │ [设置目标(admin/本角色)]        │
├ C 行 ─────────────────────────────────────────────────────────────────────────────┤
│ 调研数据 / 结论（4 条，每条附证据页）             │ 数据质量周核对（本周 W36）                 │
│ 1 物理仓日销已体现（出库）→ /inventory/ledger     │ RPA 仓库 98.7% ✓ · 人工采购链 91% ✓ · 外部 —│
│ 2 销售渠道数据 → /report/decision-studio?tab=external│ 状态：待签认（finance） [→/import/data-quality]│
│ 3 运营销售计划评估 → /replenish/reconcile          │ 手工改写指标数：1（销售金额 9 月）           │
│ 4 规则制定=备货负责；运营=数据支撑；20% 单品先磨合包材 → /replenish/sop │                       │
└───────────────────────────────────────────────────────────────────────────────────┘
```

| 卡 | 决策问题 | 数据来源 | 指标 id | 交互 | 可见角色 | 口径限制文案 |
|---|---|---|---|---|---|---|
| A 待办进度 | 我和我的部门欠了多少事 | 表 `work_items`；`todo/stats.ts`（按人×月、按 ownerRole×月：total/done/onTime/overdue/cancelled）；`workbench/focus.getWorkbenchFocus.queues` | 新 workItemCompletionRate、workItemOverdueCount | 「新建待办」→ `/todo` 抽屉（标题/责任人/角色/优先级/截止/关联单据）；进度条点击 → `/todo?todo_role=pmc`；他人明细对非 admin 隐藏（DTO 层） | 全员按人；部门汇总 admin 全见、其余本角色 | 来源：work_items · 时点：即时 · 覆盖：source_kind manual/alert/review · 限制：完成率只读统计不打分（D61）；取消项不计分母；逾期后完成计「完成不按时」 |
| A-右 队列计数 | 还有什么等我 | `inbox/service.getInbox` 计数、`review/checklist.countReviewItems`、notifications 未读 | 已有 exceptionSlaRate（可选） | 三个计数分别 → `/inbox`、`/review/checklist`、`/notifications` | 全员按人 | 来源：审批域 approval_configs / review_items / notifications · 时点：即时 |
| B 供应链目标 | 部门目标达成了吗 | 表 `department_goals`（dept_key=角色，period 月/季）；auto 实际值：库存占比（屏 1 A4）、账期达成率（`supplier-payment-term/v1`）、交付周期（`purchase-order-metrics/v3`）、数据准确率（`data-quality/v1`）；manual 值必带证据 | 新 goalAttainment、paymentTermAttainment；复用各来源指标 | 「设置目标」→ `/goals`（admin 或本角色，writeAudit）；行点击 → 来源指标所在屏/页；非本部门行服务端不返回 | 本部门（resolveScope(user,'dept')）；admin 全部门 | 来源：department_goals + 各只读指标 · 时点：指标各自时点 · 覆盖：auto 指标须已登记 metricId · 限制：观察型来源标 observation_only 不作达成事实；「部门」当前 = 角色（D61）|
| C-左 调研数据 / 结论 | 会议结论落在系统哪里 | 零依赖常量 `src/components/survey-conclusions.ts`（四条结论 + 证据页路径）| — | 每条附「证据」链接：`/inventory/ledger`、`/report/decision-studio?tab=external`、`/replenish/reconcile`、`/replenish/sop`；如需录入调研记录用 work_items（source_kind=manual）| 全员 | 来源：会议纪要 2026-09-02 / 需求表 2026-09-03 · 限制：措辞以 CURRENT.md 登记为准（待业务确认）|
| C-右 数据质量周核对 | 这周的数可信吗，签了没 | 表 `data_quality_reviews`（week/month × source_class）；`rules/data-accuracy.ts`；读模型 `data-quality/v1` | 新 dataAccuracyRate | 点击 → `/import/data-quality`；签认按钮仅 finance（getFreshSessionUser + writeAudit）；「手工改写指标数」独立列 | finance/pmc/warehouse/admin；其他角色只见状态 | 来源：recon_diffs / staging 计数 / 审计事件 · 时点：本周期 · 覆盖：rpa_warehouse / manual_po_chain / external_platform 三类 · 限制：准确率 = SKU 日级一致率，容差 1%（D65，可调）；人工链路为「首次正确率」代理；连续 4 周达标后转月核对 |

---

## 5. 交互与钻取总表

| 起点 | 目标页 | 参数 | 备注 |
|---|---|---|---|
| 屏 1 A1/A2 瓦片 | 同卡展开逐日表 → `/inventory/ledger` | from、to、warehouseId | listLedger 已支持 |
| 屏 1 A3 录入/修正 | 抽屉（不离屏） | — | 唯一手工改写入口；写 `sales_amount_monthly` |
| 屏 1 A4 调整目标 | `/admin/params` | key=inventory_sales_ratio_target_* | admin |
| 屏 1 C 行 | `/admin/health`、`/import/jobs`、`/report/decision-studio?tab=readiness` | — | 阻断行附解锁清单 |
| 屏 2 A 红卡 | `/inventory/alerts?tab=spike\|cover`、`/alerts`、`/report/risk` | — | AlertBanner 共享组件 |
| 屏 2 B-左 行动作 | `/report/transfer-suggest?skuIds=`、`/replenish?sku=`、`/report/segmentation` | skuIds | 只读建议 |
| 屏 2 B-右 已知悉 | `PATCH /api/alerts/[id]/ack` | — | 审计；不再命中 3 天自动关闭 |
| 屏 2 B-右 认领 | `/report/decision-studio?tab=identity` | platformSku | platform-sku-claim 唯一入口 |
| 屏 2 C 瓦片 | `/report/purchase-orders` | month、supplierId | 真报表 |
| 屏 3 A 行 | `/inventory/balance?warehouseId=`、`/inventory/warehouses` | — | — |
| 屏 3 B 行 | `/inventory/transfer-routes?from&to&type`；登记费用 → `/inventory/docs` 单据抽屉 | — | 费用写路径 warehouse/finance |
| 屏 3 C 启动调拨计算 | `/report/transfer-suggest?skuIds=` | 低于阈值 SKU 集 | 不自动开单 |
| 屏 4 A | `/todo`、`/inbox`、`/review/checklist`、`/notifications` | todo_role | — |
| 屏 4 B | `/goals`；行 → 来源指标页 | period、deptKey | — |
| 屏 4 C | `/import/data-quality`；证据页四条 | — | — |

---

## 6. 指标 id 汇总

| 指标 id | 状态 | 屏 | 定义（一句话） |
|---|---|---|---|
| onHandSystem / onHandExternal | 已有 | 1、3 | 全网在库（实时账 / 快照仓） |
| daysCover / coverFull / safetyQty / suggestQty | 已有 | 2 | 在库可销 / 全管道可销 / 安全库存 / 建议量 |
| salesQty / externalNetDemand | 已有 | 2 | 内部月销量 / 外部净需求（观察） |
| turns / dio | 已有 | 3 | 周转次数 / 库存天数 |
| openSupplyQty / onTimeRate / promiseReliability / supplierPriceVariance | 已有 | 2 | 未结供给 / 准时率 / 承诺兑现 / 价格偏差 |
| costCoverage | 已有 | 1 | 成本覆盖率 |
| riskActionCount / exceptionSlaRate / slowMoverCount / expiryRiskQty | 已有 | 2、4 | 风险处置 / 异常 SLA / 滞销 / 临期 |
| netRevenue | 已有（观察） | 1 | 平台净收入（销售金额参考影子） |
| onHandMonthEnd | 新 | 1 | 月末日终在库（D52） |
| inOutDaily | 新 | 1 | 逐日出入库数量/金额 |
| inventoryValue / inventoryValueCoverage | 新 | 1、3 | 库存估值 / 估值覆盖率（D51） |
| salesAmountMonthly | 新 | 1 | 月度销售金额（受控表，D53） |
| inventorySalesRatio | 新 | 1、4 | 库存占比（D54） |
| dataSourceFreshness | 新 | 1 | 来源新鲜度（按流） |
| salesSpikeCount | 新 | 2 | 爆单命中数（D56） |
| inventoryCoverAlertCount | 新 | 2、3 | 断货预警数（D57） |
| orderedPoCount / orderedQty / orderedAmount | 新 | 2 | 已下单单数 / 数量 / 金额（D63） |
| orderToDeliveryDays | 新 | 2、4 | 审批→首批 SH 天数 P50/P90（D63） |
| costSavingYtd | 新 | 2 | 年度降本额（D63） |
| warehouseTurns | 新 | 3 | 逐仓周转 |
| transferLaneAvgFee / transferDocCount / transferAnomalyCount | 新 | 3 | 线路元/件 / 单数 / 异常数（D60） |
| workItemCompletionRate / workItemOverdueCount | 新 | 4 | 待办完成率 / 逾期数（D61） |
| goalAttainment | 新 | 4 | 目标达成度 |
| paymentTermAttainment / creditTermSpendShare | 新 | 4 | 账期达成率 / 账期类采购额占比（D64） |
| dataAccuracyRate | 新 | 4 | 数据准确率（D65） |
| pilotSkuShare | 新 | （分层页） | 试点 SKU 数与销量占比（D59） |

---

## 7. 口径限制文案模板（四字段，每卡必填）

```
来源：<表/读模型/契约>（<信任层级：SCM 事实 | 快照 | 观察 observation_only | 手工>）
时点：<即时 | 业务截止 YYYY-MM-DD | 最近批次 HH:mm | 月末日终>
覆盖：<百分比或 n>（<分母说明>；不足时显示「样本不足 / 不完整」，不补 0）
限制：<口径决议 Dxx 与参数键> · <不适用范围（快照仓/未映射/上线前月份）> · <绝不做的事（不定量/不开单/不进成本）>
```

**五态**：loading（骨架）· empty（「无数据」+ 原因）· error（错误 + 重试）· insufficient（「样本不足 n=2」）· ready。

**空态 ≠ 0**：无权限、无数据、未映射、样本不足四种空态各自文案，绝不显示 0。

---

## 8. 与既有页面的关系

| 既有页 | 关系 |
|---|---|
| `/report/dashboard` 经营驾驶舱 | 并列不替代（D50）；四屏只复用其服务函数，不复制查询；菜单键不变 |
| `/workbench` 工作台 | 红卡 AlertBanner 与屏 2 同源；屏 4 队列计数同源 |
| `/report/decision-studio` | 屏 1 数据来源、屏 2 身份认领、屏 4 证据页的落点 |
| `/inventory/alerts`（新） | 屏 2 表格的全量页（含爆单 Tab） |
| `/inventory/warehouses`、`/inventory/transfer-routes`（新） | 屏 3 两张表的全量页 |
| `/todo`、`/goals`（新） | 屏 4 两张卡的全量页；`/inbox` 名称保留 |
| `/import/data-quality`（新） | 屏 4 周核对的全量页 |
