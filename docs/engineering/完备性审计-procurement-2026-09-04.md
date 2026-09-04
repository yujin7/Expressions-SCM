# 采购 / 委外 / 供应商 / 质量 —— 完备性审计

审计范围：`/Users/yj/Downloads/供应链系统 PRD/supply-chain`，只读，未修改任何文件。
总体判断：**交易层（BH→WO→PO/JG→FL/TL→SH+QC→CT→JS）基本闭环且质量很高；断裂集中在「承诺版本链只写不读」「质量案件与库存/供应商完全隔离」「价目表无维护入口」「短关按钮缺失」「简道云历史只出现在一个页签」五处。**

---

## (a) 页面清单：状态与主缺口

| 页面 / 路由 | 目的与业务决策 | 状态 | 主要缺口（file:line 证据） |
|---|---|---|---|
| `/outsource/bh` 备货申请 | 渠道提报成品备货量 → PMC 决定是否开工单 | **COMPLETE** | 唯一有「短关」按钮的委外单据（`bh-client.tsx:210`）；渠道范围隔离 `route-access.ts:100` |
| `/outsource/wo` 委外工单 | 选加工厂 + 生效 BOM 快照 → 冻结净需求 R11 → 生成 PO/JG | **PARTIAL** | ① 选供应商只有裸 `RemoteSelect`（`wo-client.tsx:550,703`），无价格/交期/OTIF/评分辅助；② 只挡黑名单，**不挡 `paused`**（`wo.ts:56`、`generateDocs` `wo.ts:357`）；③ `transitionWO`（完成/短关）有服务与路由，**UI 无按钮** |
| `/outsource/po` 采购订单 | 向物料供应商下单；R1 比价硬门；供应商确认交期 | **PARTIAL（含一处功能性断裂）** | ① 列表 API 已返回 `expectedDate/confirmedAt`（`po.ts:383-384`），客户端 `PoRow` **未声明也未渲染**（`po-client.tsx:17-26`，columns `191-232`）→ 无「预计 vs 实际」；② `getPo` 行查询**漏掉 `poLines.expectedDate`**（`po.ts:329-348`）→ 供应商门户唯一的行级承诺写入在内部界面**永远看不到**；③ 无承诺改期历史面板（`po_promise_revisions` 从不在前端出现）；④ 行只有「已收量」没有「应收/已收%/逾期」；⑤ 无短关按钮 |
| `/outsource/po/[id]/print` | 打印发给供应商 | COMPLETE | 244 行，含脱敏 |
| `/outsource/pc` 价格变更 | 价格异动审批放行 PO；加工费改价立即生效 | **COMPLETE** | 服务端手工剥离价格（`po.ts:400-406`）；`jg_fee` 同事务写现价+分段（`po.ts:242-252`）；`po_line` PC 审批**刻意不改任何价**（`po.ts:259`），基准由下一次已批 PO 自然滚动 |
| `/outsource/jg` 加工通知单 | 下加工批次，带产能软约束与费率分段 | **COMPLETE** | 产能信号 P90 + 进度条（`jg-client.tsx:454-490`）；费率分段表 `285-300`；仅打印条款是占位（`jg/[id]/print/page.tsx:37,78`，业务待定稿，非工程缺陷） |
| `/outsource/jg/[id]/print` | 委外合同/通知单 | PARTIAL（业务待定） | 条款为占位框架，页面已自曝 |
| `/outsource/auto-chain` 自动链预演 | 上线前看清自动化会生成什么 | **COMPLETE** | 只产草稿、审批永远人工（`auto-chain-client.tsx:119`）；旧台账只作第二条旁证不改结论 |
| `/master/supplier` 供应商主档 | 建档、账期、产能、资质 | **PARTIAL** | 页面只有「生命周期 / 资质证照」两个跳转（`supplier-client.tsx:38-43`）；**无任何 OTIF / 交期 / 质检 / 评分 / 采购额并列**；无到记分卡的链接（全仓 grep 无 `/report/supplier-scorecard` 引用，除 `data-product-work-queue.ts:51`） |
| `/master/supplier/lifecycle` 准入与整改 | 准入评审 / 整改闭环，可「暂停新订单」 | **BROKEN（半闭环）** | 勾选 `pauseNewOrders` 会把供应商置 `paused`（`supplier-lifecycle.ts:232-238`），但**全仓没有任何写路径检查 `paused`**——`wo.ts:56` 与 `wo.ts:357` 只挡 `blacklisted`。按钮名不副实 |
| `/quality` 质量与合规（3 页签：案件与行动 / 监管证据 / 电子标签） | 投诉、不良事件、召回、GMP 自查的受控流程 | **COMPLETE 但孤岛** | 2349 行，状态机 + 到期分级 + 召回范围固化 + 摘要哈希（`quality/service.ts:861,943`）；**`qualityCases` 在全仓只被 `schema/quality.ts` 与 `quality/service.ts` 引用**——不冻结批次、不阻断出库、不进供应商评分、不进任何预警 |
| `/matflow/sh` 收货检验（真正的 QI 环节） | 收货 → 审批 → 三分检验 → 入库过账 | **COMPLETE**（两处口径断点） | 收货必检硬门 `sh.ts:337`；一单一检 `sh.ts:269`；照片证据链 `sh-client.tsx:1135`。断点：① PO 源**只过账 `passQty`，让步件不入库也不退货**（`sh.ts:505-507, 528-531`）；② `qcRecords` 无单号（`docs.ts:257-263`），扣款争议只能引 SH 号 |
| `/report/supplier-scorecard`（5 页签） | 记分卡 / 质检透视 / 价格偏差 / 账期候选 / 历史交期观察 | **COMPLETE（本仓质量标杆）** | 逐维度可解释拆解、样本不足不评级、人工「采纳」才写档案（`supplier-scorecard-client.tsx:278,404`）；无数据显示「无数据」不显示 0%（`:180-184`）；QC 按月堆叠有趋势（`:612`）。缺：**记分卡本身无历史分数趋势**（只有当前窗口） |
| ├ 账期候选（D64） | 谁该谈账期、谈到没有、账期类采购额占比 | **COMPLETE** | 排名趋势 up/down/flat（`supplier-payment-term.ts:38`）、金额按角色剥离、写路径走专用审计接口（`payment-term-tab.tsx:117`）；自曝「**代理指标不是应付余额**」（`supplier-payment-term.ts:14,372`） |
| └ 历史交期观察（B4） | 简道云历史下单→收货交期，与系统学习值并列 | **COMPLETE** | `lead-history-tab.tsx` 全 236 行；「阈值依据」列明确显示阈值**未因观察改变**（`:138-146`）；`observation_only` 声明 `:172` |
| `/report/purchase-orders` 采购订单指标（D63） | 下了多少、多久到、省了多少、OTIF | **COMPLETE** | OTIF 四桶（命中/可评/待评/缺承诺日不可评）`purchase-orders-client.tsx:42-50`；降本与涨本**不轧差**；样本<3 显示「样本不足」不显示 0；金额 `stripPurchaseOrderMoney` 按角色剥离（`api/report/purchase-orders/route.ts:27`） |
| `/report/price-compare` 物料比价 | 同物料多家横比，找议价空间 | **PARTIAL（数据源无入口）** | 逻辑与口径注释非常严谨（`price-compare.ts:1-26`），但**唯一数据源 `price_lists` 在全仓没有任何 CRUD 页面或导入路由**——只有 `db/seed.ts:236` 会写 |
| `/report/inbound-calendar` 到货日历 | 承诺可信度（原始 vs 当前承诺） | **COMPLETE** | 全仓**唯一**消费 `po_promise_revisions` 的地方（`supply-commitment.ts:437-462`，页面 `inbound-calendar-client.tsx:277-335`） |
| `/settlement/js` 结算单 | 委外加工费应付的唯一载体 | **COMPLETE** | JG 收货关闭是硬前置（`js.ts:391-393`）；一 JG 一 JS `:401`；结余（负损耗）409 闸门 + 短溢确认；扣款价自曝为 `price_list_proxy` 代理口径（`js-client.tsx:141-143`） |
| `/settlement/month-close` 月结控制台 | 六道收口检查 | COMPLETE | `month-close.ts:22-28` |
| `/report/settlement-summary` 结算汇总 | 财务金额报表 | COMPLETE | 整表 403 而非脱敏（`settlement-summary.ts:11-12`） |

---

## (b) 按价值排序的 12 项补全（含 S/M/L）

| # | 事项 | 证据 | 规模 |
|---|---|---|---|
| 1 | **PO 详情显示行级承诺交期 + 承诺改期时间线**。供应商门户逐行写 `po_lines.expected_date` 与 `po_promise_revisions`（`po-confirm.ts:198-217`），但 `getPo` 行查询不 select 它（`po.ts:329-348`），前端也没有该字段。花钱做的供应商确认门户，其唯一独有产出在内部完全不可见。 | `po.ts:344`（缺列）、`po-client.tsx:28-45`、`docs.ts:117-146` | **S**（加一列 + 一个 Timeline） |
| 2 | **PO 列表补「预计到货 / 已确认 / 已收%/ 逾期」四列**。API 已经返回 `expectedDate`、`confirmedAt`，客户端丢弃。目前列表看不出任何一张单是否延期。 | `po.ts:383-384` vs `po-client.tsx:17-26,191-232` | **S** |
| 3 | **PO/WO 补「完成 / 短关」按钮**。`transitionPO`/`transitionWO` 服务、路由、测试俱全（`tests/outsource/short-close-supply.test.ts:52,65`），**UI 完全不可达**——与 po-client 里自己记录过的「回调编译进包却不可达」是同一类事故。少送尾数的 PO 会永久卡 `in_progress`，污染 OTIF「待评」桶与 `doc_aging` 告警。 | `po.ts:474-509`、`api/outsource/po/[id]/transition/route.ts`、`po-client.tsx`（无 transition 调用） | **S** |
| 4 | **`pause_new_orders` 落地为真的下单闸**。整改暂停只改主档状态，无人检查。 | `supplier-lifecycle.ts:232`、`wo.ts:56`、`wo.ts:357`、`auto-chain.ts:260` | **S**（三处 `blacklisted` 改为集合判断 + 一条测试） |
| 5 | **供应商 360：把 OTIF / 交期 / 质检 / 价格偏差 / 账期 / 历史观察并列到 `/master/supplier` 行内抽屉**。所有数字都已存在于五个读模型，只是分散在记分卡页签里；主档页至今是纯 CRUD。`data-products.ts:400-431` 已把 "supplier-360" 定义为正式数据产品。 | `supplier-client.tsx:38-43`、`data-products.ts:400` | **M** |
| 6 | **记分卡/OTIF 改用「原始承诺」口径**。记分卡准时率用 `coalesce(行交期, 表头交期)`（`supplier-scorecard.ts:266`），采购指标 OTIF 同样只看当前承诺（`purchase-order-metrics.ts:218-224`）。供应商通过 token 改期即可把自己的准时率洗白。`supply-commitment.ts` 已经算好 original/current 双口径，只在到货日历露出。 | 三文件同上 | **M** |
| 7 | **价目表 `price_lists` 的维护入口（CRUD 或导入放行流）**。它同时是 R1 比价兜底基准（`po.ts:72-84`）、物料比价页唯一数据源、JS 扣款单价代理（`js.ts` + `js-client.tsx:141`）。目前只能靠 `db/seed.ts:236`。三个下游功能挂在一个没有入口的表上。 | `masters.ts:252-261`、`price-compare.ts:14-21` | **M** |
| 8 | **质量案件 ↔ 库存/供应商打通**：召回/严重投诉冻结批次（已有 `bin.kind='quarantine'`、`bin_movements.operation='quarantine'`），案件计入供应商评分与预警。当前 `qualityCases` 是纯孤岛。 | `quality.ts:25-60`、`rollup.ts:71-78`、`inventory.ts:73-83`、grep：`qualityCases` 仅 2 文件 | **L** |
| 9 | **QC 不合格的下一步动作**：`fail_handling ∈ {rework, scrap}` 目前只是一个枚举值——不生成 CT 退货、不生成质量案件、不通知供应商、不产生扣款依据。PO 源的让步件既不入库也不退货（`sh.ts:505-507`）。 | `docs.ts:265-273`、`sh.ts:528-531` | **M** |
| 10 | **采购侧供应商/资质告警缺失**：`license-alert` 每日 9 点跑（`scheduler.ts:23`），产出**没有任何 UI 消费者**（全仓仅 `interval-runner`/`cli` 调用）；告警类别表里没有 supplier/OTIF/承诺违约/质量案件逾期任何一项。 | `license-alert.ts:1-8`、`alerts/engine.ts:117`、`jobs/*.ts` 的 `category:` 清单 | **M** |
| 11 | **把简道云采购历史接进「阈值依据」行**。`observedLeadForSku()` 是刻意的预置件，注释自曝「当前只有测试调用」（`supplier-lead-history.ts:630-640`），`inventory-alerts.ts` 未传 `observedHistory`。这是把外部历史带出单页签的最低风险第一步（仍 observation_only，不改 days）。 | `alert-threshold.ts:69-77,176-196`、`supplier-lead-history.ts:632` | **M**（需同批升读模型键到 /v3 + 改驾驶舱两处文案，注释已写明） |
| 12 | **WO「生成单据」时的供应商决策辅助**：在选供应商的下拉旁给出该 (SKU×供应商) 的基准价 / 系统学习 P90 / 历史观察 P50 / OTIF / 评分。这是整条链上唯一真正的采购决策点，目前零信息。 | `wo-client.tsx:688-740` | **M** |

---

## (c) Procure-to-Pay 链路：逐箭头状态

```
需求 ──①──▶ 寻源 ──②──▶ PO ──③──▶ 承诺 ──④──▶ 收货 ──⑤──▶ 检验 ──⑥──▶ 结算 ──⑦──▶ 账期/付款
```

| # | 箭头 | 状态 | 依据 |
|---|---|---|---|
| ① | 需求 → 寻源 | **exists（成品）/ missing（物料）** | BH→WO→auto-chain 自动出草稿（`auto-chain.ts`）；但物料侧的「向谁买」没有任何建议来源，MRP `report/material-demand` 不产生 PO 候选 |
| ② | 寻源 → PO | **manual** | PO 只能由 WO「生成单据」派生（`po-client.tsx:352`「本页不提供手工创建」）；供应商靠人工下拉选，比价页/记分卡与开单页无任何连接 |
| ③ | PO → 承诺 | **exists（写）/ missing（读）** | token 门户写 `po_lines.expected_date` + `po_promise_revisions`（`po-confirm.ts:198-217`）；`getPo` 不读回（`po.ts:344`），无 buyer_revision 写入者（全仓仅 `po-confirm.ts` 调 `appendPoPromiseRevisions`） |
| ④ | 承诺 → 收货（OTIF） | **exists，但口径是「当前承诺」** | `purchase-order-metrics.ts:218` / `supplier-scorecard.ts:266` 用 coalesce 现值；只有 `supply-commitment.ts` 走版本链，且只出现在到货日历 |
| ⑤ | 收货 → 检验 | **exists（强制）** | 收货必检硬门 `sh.ts:337`；三分必须完整覆盖实收 `sh-client.tsx:548` |
| ⑥ | 检验 → 放行/入库 | **exists（数量层）/ missing（质量事件层）** | 合格数才过账 `sh.ts:528-531`；不合格无 CT、无案件、无供应商动作；质量案件不能反向冻结已入库批次 |
| ⑦ | 检验 → 结算 | **exists（加工费）/ missing（物料）** | JS 直接由 `qc_lines.passQty` 聚合并以 JG 收货关闭为前置（`js.ts:137-175,391`）；**物料采购根本没有结算单据**——`docs.ts:77` 明确「加工费应付唯一载体=JS」 |
| ⑧ | 结算 → 账期 → 现金 | **missing** | 全仓无发票、无应付、无付款、无到期排程（grep `应付|发票|invoice|payable` 只命中 `feePayable` 与免责声明）。账期只是主档字段 + 候选看板，`supplier-payment-term.ts:372` 自认「不是应付余额」 |
| ⑨ | 价格变更 → 计价/估值 | **partial → missing** | PC 通过后基准价随下一张已批 PO 自然滚动（`po.ts:259`，设计如此）；但 `sku_costs` 是纯人工录入（`masters.ts:286-291`），PC/PO 从不写它 → 价格变更**不进存货估值与毛利** |
| ⑩ | 供应商评分 → 寻源决策 | **manual** | 评分只写 `suppliers.level`，且必须人工点「采纳」（设计正确）；但 level 在开单侧无任何作用（`wo.ts` 只读 status） |

---

## (d) 协同机会

**计划**
- `supply-commitment` 的 original/current 承诺兑现率是补货安全库存的天然输入，目前只作展示。补货引擎仍用 `rollup_supplier_lead`（`replenish` 侧），承诺违约率没有进任何缓冲计算。
- `report/material-demand`（MRP 展开）与 `outsource/wo` 生成 PO 之间没有桥：MRP 算出物料缺口后，没有「按此生成 PO 草稿」的路径。

**库存**
- `bin.kind='quarantine'` 隔离位与 `bin_movements.operation='quarantine'/'release'` 已建（`rollup.ts:71-78`、`inventory.ts:73-83`），但检验不合格与质量召回都不驱动它——隔离能力建好了没人调用。
- `batch-trace`（`inventory/batch-trace.ts:2` 明说是为召回而建）与 `quality_cases.scopeSnapshot` 各算各的召回范围。

**预警**
- 缺 4 类采购/质量告警，全部数据已就绪：资质到期（`license-alert.ts` 已算好，无出口）、承诺违约（`po_promise_revisions` 有 previousDate/promisedDate）、OTIF 塌方（`purchase-order-metrics` 已按供应商出 rate）、质量案件/整改逾期（`classifyDueState` 已在 `quality/service.ts` 存在）。
- `alert-outcome.ts` 已有告警精确率复盘框架，新类别可直接复用。

**驾驶舱**
- `cockpit.ts:112` 已接采购 OTIF 块；可低成本加「承诺改期次数」「资质到期」「整改逾期」三个红线项（`RedlineItem` 结构已在 `cockpit.ts:70`）。
- 第 4 屏部门目标已把账期达成率作为 auto 来源（`supplier-payment-term.ts:1`），说明该管道可复用给 OTIF 目标。

**财务**
- 账期候选（谁该谈）→ 应付到期日程（何时付）→ 现金视图，是一条只差最后两段的完整链。中段材料齐备：`js_docs.settleAmount` 是已确认应付、`suppliers.credit_days/payment_term_effective_from` 是结构化账期。
- `month-close.ts:22-28` 六道收口里没有「采购承诺与收货差异」一项，而 `supply-commitment` 正好产出这个例外清单。

---

## (e) 已验证完备（无需返工）

1. `/outsource/jg` 加工通知单 —— 产能软约束、费率分段、扫码回报 token、打印（占位条款是业务待办非工程债）。
2. `/outsource/pc` 价格变更 —— R1 硬门、jg_fee 同事务生效、价格服务端剥离、PO 提交 409 带 PC 单号回链（`po-client.tsx:171-181`）。
3. `/matflow/sh` 收货检验 —— 收货必检、一单一检、三分覆盖校验、并发累计兜底重查（`sh.ts:231`）、检验照片证据链。
4. `/settlement/js` + `jg-close` + `/settlement/month-close` + `/report/settlement-summary` —— 前置门、一 JG 一 JS、结余闸门、整表 403 而非脱敏。
5. `/report/supplier-scorecard` 全部 5 个页签 —— 可解释评分、人工采纳、样本不足不评级、无数据显示「无数据」、QC 月度趋势、账期排名趋势、历史观察 observation_only 纪律。
6. `/report/purchase-orders` 采购订单指标 —— OTIF 四桶、降本涨本不轧差、年份取自事实不取浏览器时钟、金额角色剥离。
7. `/report/inbound-calendar` 承诺可信度 —— 原始/当前双口径、`promiseVersionState` 三态、例外证据导出。
8. `/outsource/auto-chain` —— 只产草稿、护栏齐全、旧台账严格降级为旁证。
9. `/quality` 三页签本身 —— 状态机、可报告性人工判定（`unknown` 不被 `false` 吞）、召回范围固化 + 摘要哈希、电子标签生命周期。**（完备但与其余系统零耦合，见 (b)#8）**
10. 供应商确认公开门户 `/supplier/confirm/[token]` —— UUID token + 30 天 + 单次使用 + 原子消费 + 脱敏不含内部价（`po-confirm.ts:173-195`）。
11. 规则层测试覆盖 —— `tests/rules/` 下 `scorecard / price / po-cycle / settlement / leadtime-stats / cost-saving / supplier-capacity / quality-compliance` 全在；读模型侧 `supply-commitment / supplier-lead-history / supplier-payment-term / supplier-price-variance / purchase-order-metrics` 全在。

**唯一未覆盖的测试空白**：`server/modules/report/supplier-scorecard.ts` 的服务层（规则层 `tests/rules/scorecard.test.ts` 有，取数/聚合口径无），以及 `outsource/po.ts` 的 R1 `findBaseline` 兜底到 `price_lists` 的分支。