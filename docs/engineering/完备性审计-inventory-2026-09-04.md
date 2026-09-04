I have enough evidence. Here is the audit.

---

# 库存与仓储作业完整性审计 — supply-chain (Next.js 15 / AntD 5)

Read-only. All paths relative to `/Users/yj/Downloads/供应链系统 PRD/supply-chain`.

---

## (a) 页面清单 · 状态 + 主要缺口

| # | 页面 / 流程 | 物理动作 | 状态 | 主要缺口 |
|---|---|---|---|---|
| 1 | `/inventory/balance` 库存余额（SKU / SPU / 全仓快照 三页签）<br>`src/app/(app)/inventory/balance/balance-client.tsx` | 「这个 SKU 在哪个仓有多少」 | **PARTIAL** | 快照页签「业务用途」列是**死列**：`balance-client.tsx:341-351` 渲染 `commercialRole`，而 `src/server/modules/inventory/queries.ts:181-193` 的 select 根本不返回该字段 → 每行空 Tag。SKU 页签查了 `batchNo/batchExpiryDate`（`queries.ts:54-55`）却一列不显示。全页无金额、无可销天数，尽管 `core/valuation` 与 `core/velocity` 都在。`listSnapshotBalances`（`queries.ts:161-223`）是 `getLatestSnapshotRows` 的第 2 份本地重实现。 |
| 2 | `/inventory/docs` 库存单据 RK/CK/DB + 红字<br>`docs/docs-client.tsx`（771 行） | 期初建账、领料出、销售出、仓间调拨、红字冲销 | **COMPLETE**（写路径），UI 有 3 处缺口 | 建单仓库下拉 `docs-client.tsx:537` / `:549` **不过滤 accountingMode**——用户可选快照仓，直到提交才被 `stock-doc.ts:70-73` 顶回「快照仓 1.1 启用」。同仓页 `/inventory/count` 的下拉是过滤过的（`count-client.tsx:483`），两页对仓型的处理不一致。状态页签有「已关闭」（`docs-client.tsx:135`）但库存单**没有** `short_close/withdraw/void` 路由（`src/app/api/inventory/stock-doc/` 只有 `submit/approve/reverse`）→ 死页签 + 草稿无法作废。FEFO 预览受 `batch_posting_enabled` 闸门（seed 默认 0，`src/db/seed.ts:103`）保护，现网不可见。 |
| 3 | `/inventory/ledger` 库存流水 | 查台账 | **PARTIAL** | 只有 时间/SKU/仓库/数量±/来源/动作（`ledger-client.tsx:77-107`）。无批次列（`stock_ledger.batch_id` 存在）、无运行余额、无金额（`core/valuation` 可算）、来源只渲染 `类型 #id` 文本**不可点**（`ledger-client.tsx:104`）——从流水回不到单据。 |
| 4 | `/inventory/count` 盘点任务 PD | 全盘 / 抽盘 → 录实盘 → 财务审批 → 自动生成 CA 调整单过账 | **COMPLETE** | 唯一缺：盈亏只有数量（`count-client.tsx:320` 盈亏合计 / `:636` diffQty），无金额，尽管 `core/valuation` 在；差异审批即过账但 **`post()` 不传 `occurredAt`**（`count.ts:357`）→ 见 (c) 断点 6。 |
| 5 | `/inventory/count/[id]/print` 盘点表打印 | 拿纸清点 | **PARTIAL** | 表头无批次列（`pd_lines.batchId` 存在，`src/db/schema/docs.ts:363`）、无库位列（`bin_balances` 存在）、不打印盘点期 `pdDocs.bizDate`（只有「制单日期」＋空白「盘点日期」，`print/page.tsx:99-100`）。管效期 SKU 拿这张纸盘不出批次。 |
| 6 | `/inventory/expiry` 效期批次 | 逐批次×仓库实物处置 | **BROKEN（口径）** | `src/server/modules/inventory/expiry-list.ts:88` 的 `conds` 只有 `expiryDate NOT NULL` + `qty>0` + 可选仓库——**没有 `latestStocktakeRows` 收口**。`core/stock-view.ts:141-156` 明确写着多期直加会「效期量随盘点次数成倍虚增」。`replenish/expiry.ts:77`、`risk.ts:157`、`transfer-suggest.ts:225`、`risk-expiry-buckets` 都已修，**这一页没修**，且 `tests/report/calibre-audit.test.ts` 的 C5 用例不覆盖 `listExpiryBatches`。全页无金额（临期资金风险不可见）。 |
| 7 | `/inventory/alerts` 库存预警 + 爆单 | 断货/低库存/临期/超储/爆单看板 | **COMPLETE** | 见 (c) 断点 7：`inventory-alerts.ts:300` 的 `actions` 只有 `transfer`/`replenish`——`near_expiry` 与 `overstock` 主预警**没有下一步链接**。 |
| 8 | `/inventory/position` 库存日级走向 | 当月逐日出入、历史月末环比、各仓在库 | **COMPLETE** | 全系统最完整的一页：实时/快照分列、缺日留空不补零、`snapshot_delta` 明标、估值覆盖率标签、`CaliberNote`、深链流水。缺口只在一致性（见 (e)）。 |
| 9 | `/inventory/warehouses` 各仓库存与周转 | 各地各仓在库/金额/周转/DIO | **COMPLETE** | 唯一按仓做真周转（期初由流水倒推，`warehouse-inventory.ts:232-240`）、快照仓明标「无流水」、金额覆盖率 <80% 标「不完整」。缺：只能切窗口（30/90/365），**无跨时间比较**（没有上期周转/环比），也没有仓与仓的相对排名/基准。 |
| 10 | `/inventory/transfer-routes` 调拨线路与费用（3 页签） | 登记调拨运费、看线路基线、查异常单 | **COMPLETE** | 留一法基线、SPC 两档、金额按角色剥离、红字作废、异常明细可点回单据。缺：费用**不进库存成本、不过账**（`transfer-fees.ts:14`，刻意），所以调拨的真实到岸成本永远不进估值。 |
| 11 | `/inventory/locations` 库位作业 | 定位 / 移库 / 取消定位 / 隔离 / 放行 | **COMPLETE** | 不变式 `Σbin ≤ stock_balances` 由 `bin-operations.ts` 与 `post.ts:196-208`（`LOCATED_STOCK` 守卫 + 仓库行锁）双向钉住。缺：隔离量与质量案件/风险处置无联动。 |
| 12 | `/inventory/batch-trace` 批次追溯 | 召回：这批货从哪来、现在在哪 | **PARTIAL** | `batch-trace.ts:148-152` 的 `stockByWarehouse` 读 `batch_stocks` **不收口盘点期** → 两期并存时同一批次出现两行、无合计。且它把「登记批次（`batches`）」与「参考层批次（`batch_stocks`）」按 `batchNo` 字符串对上，两层本无外键。`coverage.note` 诚实地说明出库侧多半追不到（闸门未开）。 |
| — | `/report/transfer-suggest` 调拨建议 | 先挪后买 | **PARTIAL** | 见 (c) 断点 1：建议**无法变成单据**。服务端已算好 `lanes`（`transfer-suggest.ts:383-403`）并由 API 返回，**客户端整个不渲染**（`transfer-suggest-client.tsx:42-55` 的 interface 里没有 `lanes`）。行上无调拨成本（`transfer_fees` 基线就在隔壁页）。`transfer-suggest.ts:225` 的 `latestStocktakeRows(lotRowsAllPeriods)` **未传 authoritative 映射**，而 `:220` 在 `?skuIds=` 深链时是 SKU 子集查询——正是 `core/stock-view.ts:157-166` 警告的用法。 |
| — | `/report/inventory-analytics` 库存分析三视图 | 健康散点 / 账龄 / 周转 | **PARTIAL** | 见 (e)：`inventory-analytics.ts:143-159` 是 `getOnHandBySku` + `getLatestSnapshotRows` 的**逐字本地重实现**（还用 float `num()` 累加而非 `dAdd`），且不返回 `snapDate` → 页面没有快照口径注记。`avgOnHand ≈ 当前在库`（文件头自认），与 `/inventory/warehouses` 的真周转必然打架。 |
| — | `/settlement/js` 委外结算 | 损耗核销 → 委外仓 − | **COMPLETE** | `js.ts:568-570` 审批同事务过账 `js_loss_writeoff`；结余闸门 `js.ts:505-519` 强制先 TL 退料或短溢确认。诚实标注扣款单价是 `price_list_proxy` 代理口径（`js.ts:41-50`）。 |
| — | `/settlement/month-close` 月结控制台 | 六项控制签认 | **PARTIAL** | 见 (c) 断点 5：`month-close.ts:310` 的 `periodClosed = month < 当前月` 是**纯日历推导**，全库**没有期间锁表**，`posting/post.ts` 也没有任何期间校验 → 签认完的月份仍可被过账写入，签认沦为纸面动作。 |

---

## (b) 按价值排序的 Top-12 补全项

| # | 项 | 证据 | 影响 | 规模 |
|---|---|---|---|---|
| 1 | **`/inventory/expiry` 补盘点期收口** | `src/server/modules/inventory/expiry-list.ts:88`（`conds` 无 stocktakeDate）vs `src/server/core/stock-view.ts:141-176` | 两期并存时全页数量×2；仓管照着这张单去处置，处置量是虚的。风险页（已修）与本页（未修）会给出两个「已过期量」 | **S**（调用 `loadLatestStocktakeDates` + `latestStocktakeRows`，与 `replenish/expiry.ts:77` 同型） |
| 2 | **调拨建议 → 生成 DB 草稿单** | `transfer-suggest-client.tsx:210`「只读建议，不自动开单」；`stock-doc.ts:57-150` `createStockDoc` 已支持 transfer | 建议链到单据是整条「先挪后买」闭环的唯一断点；现在人要肉眼抄 SKU/数量/仓到 `/inventory/docs` | **M**（勾选行 → 预填建单表单；不改过账） |
| 3 | **期间锁（月结真闭环）** | `month-close.ts:310`；`posting/post.ts:88-232` 无期间校验；无 `closing_period` 表 | 已签认月份可被追加过账，月结证据与账实时漂移；`evidenceChanged` 只能事后提示 | **M**（新增期间表 + `post()` 守卫 + admin 解锁审批） |
| 4 | **盘点调整按盘点期入账** | `count.ts:357` `post(...)` 无 `occurredAt`；`pdDocs.bizDate` 在 `src/db/schema/docs.ts:357` | 8/31 的盘点 9/4 录入，差异落在 9 月流水 → `/inventory/position` 的 8 月末在库、`/inventory/warehouses` 的 90 天出库全部归错期 | **S**（`post()` 已支持 `occurredAt`，传 `pdDocs.bizDate` 即可） |
| 5 | **`inventory-analytics` 改用 `core/stock-view`** | `inventory-analytics.ts:143-159` vs `core/stock-view.ts:70-102` | 第 3 套在库口径（float 累加、无 snapDate、无口径注记）；周转数与 `/inventory/warehouses` 系统性不等 | **S**（替换为 `getOnHandBySku`；页面加 snapDate 注记） |
| 6 | **`transfer_suggest` 传 authoritative 盘点期** | `transfer-suggest.ts:220-225`（`skuIdsFilter` 子集 + 无 authoritative） | 预警行深链 `?skuIds=` 与全量列表会对同一 SKU 给出**不同**的已过期量/FEFO 批次——正是 `core/stock-view.ts:157-166` 点名的坑 | **S**（加 `await loadLatestStocktakeDates(db)`） |
| 7 | **快照页签修 `commercialRole` + 建单仓下拉过滤** | `balance-client.tsx:341-351` vs `queries.ts:181-193`；`docs-client.tsx:537,549` 无 `filterRow`（对照 `count-client.tsx:483`） | 一列永久空白；建单选到快照仓走到提交才报错 | **S** |
| 8 | **在途仓 / `transit_writeoff` 全链路** | `posting/registry.ts:44,59-62` 已注册；`src/db/seed.ts:200` 已建 `WH-ZT`；`src/db/seed-dimensions.ts:117-123` 已建别名；但 `stock-doc.ts:71-73` 把「转入=快照仓」直接 400「快照仓 1.1 启用」 | 保税/云仓的调拨**完全走不通**；已注册的过账动作是死代码，`labels.ts:92` 的「调拨核销」永不出现 | **L**（到仓确认单 + 核销 + 在途龄报表） |
| 9 | **调拨建议行上带成本 + 渲染 lanes** | `transfer-suggest.ts:383-403` 已算 lanes 但客户端不读；`transfer-routes.ts` 有元/件基线 | 建议只讲省了多少断货，不讲花多少运费；线路合并（`scattered` 零散线路）的省钱机会在另一页孤立着 | **M** |
| 10 | **`/inventory/ledger` 补批次 / 余额 / 单据链接 / 金额** | `ledger-client.tsx:77-107`；`queries.ts:134-144` select 无 `batchId` | 台账是唯一事实源却最不可用：查不到批次、点不回单据、看不到当时余额 | **M** |
| 11 | **临期/超储预警的下一步动作** | `inventory-alerts.ts:300` `actions` 只有 transfer/replenish | 临期主预警点不到 `/inventory/expiry`，超储点不到 `/report/risk` 处置——告警产出后无处置入口 | **S** |
| 12 | **`workbench/focus` + `sku-panorama` + `batch-trace` 三处补盘点期收口** | `workbench/focus.ts:230-234`、`:329-337`；`master/sku-panorama.ts:182-186`；`inventory/batch-trace.ts:148-152` | 首屏「近效期批次」「已过期库存待处置」按盘点期数虚增，与风险页（已收口）给出的数字不同 → 用户看到三个「已过期量」 | **S** ×3 |

---

## (c) 在库 → 单据 → 过账 → 台账 → 快照 链路（逐箭头状态）

```
建议/信号 ──①──► 单据 ──②──► 审批 ──③──► 过账 ──④──► stock_ledger ──⑤──► stock_balances
                                                                          │
   快照导入 ─────────────────⑥(旁路)───────────────────► stock_snapshots ─┴──⑦──► 合并在库口径
   效期导入 ─────────────────⑧(旁路)───────────────────► batch_stocks ────⑨──► 效期视图
   盘点 PD ──⑩──► CA 调整单 ──► 过账 ──► ledger        月结签认 ──⑪──► (无锁)
```

| 箭头 | 状态 | 证据 |
|---|---|---|
| ① 建议→单据 | **断** | `/report/transfer-suggest` 只读（`transfer-suggest-client.tsx:210`）；`/replenish` 同理。无「生成草稿单」按钮 |
| ② 单据→审批 | ✅ | `stock-doc.ts:157-186` submit + 乐观锁；`docflow/state.ts` 状态机 |
| ②' 单据 退出路径 | **断** | 无 `withdraw` / `void` / `short_close` 路由（`src/app/api/inventory/stock-doc/[id]/` 仅 3 个）；`docs-client.tsx:135`「已关闭」页签永远空 |
| ③ 审批→过账 | ✅ 原子 | `stock-doc.ts:206-260` 同事务：审批记录 + `post()` + `approved→in_progress→completed`；职责分离由 `docflow/approval.ts` 保证 |
| ④ 过账→台账 | ✅ 强 | `posting/post.ts`：registry 白名单（`:88-93`）、幂等短路（`:98-111`）、`(sku,wh,batch)` 排序防死锁、仓库行锁（`:143-145`）、R4 负库存、快照仓禁过账（`:130-138`）、`LOCATED_STOCK` 守卫 |
| ⑤ 台账→余额 | ✅ | `post.ts:167-190` 同事务 upsert `NULLS NOT DISTINCT` |
| ⑥ 快照导入→snapshots | ✅（旁路合法） | 快照仓不入 ledger，设计如此 |
| ⑦ 合并在库 | ⚠️ **三源** | 权威 `core/stock-view.getOnHandBySku`；`warehouse-inventory.ts:151` 只算 `active=true`；`inventory-analytics.ts:143-159` 本地重实现。见 (e) |
| ⑧ 效期导入→batch_stocks | ✅ | `release/engine/batch-stocks.ts`；唯一键含 `stocktake_date`（`refs.ts:39`） |
| ⑨ batch_stocks→效期视图 | ⚠️ **半收口** | 收口：`replenish/expiry.ts:77`、`risk.ts:157`、`transfer-suggest.ts:225`（缺 authoritative）、`quality/service.ts:762`、`risk-expiry-buckets`。**未收口**：`expiry-list.ts:88`、`workbench/focus.ts:230,332`、`sku-panorama.ts:184`、`batch-trace.ts:148`、`sku-brief.ts:117` |
| ⑨' batch_stocks ↔ FEFO 出库 | **断（两套批次真相）** | 出库 FEFO 用 `batches` + `stock_balances.batch_id`（`inventory/fefo.ts`），受 `batch_posting_enabled=0` 闸门（`seed.ts:103`）关闭；效期视图用 `batch_stocks`。二者无外键、无对账页 → `/inventory/expiry` 上的临期批次永远不可能被出库单选中 |
| ⑩ 盘点→调整→台账 | ✅（期间除外） | `count.ts:319-357` 生成 CA 并 `post(count_adjust)`；但 `occurredAt` 未按 `bizDate` |
| ⑪ 月结签认→期间锁 | **断** | `month-close.ts:310` 日历推导；`post()` 无期间校验；无锁表 |
| ⑫ 调拨费用→成本/估值 | **断（刻意）** | `transfer-fees.ts:14`「不进库存成本、不参与过账」——`core/valuation` 只认 `sku_costs` / 财务运营成本观察 |
| ⑬ 风险处置→报废出库 | ✅ 闭环 | `stock-doc.ts:96-118` 校验 `risk_disposal` 登记 → `:262-286` 过账后自动完成 → `:288-320` 红字冲销后自动重开 |

---

## (d) 协同机会

**与计划（replenish / planning）**
- `transfer-suggest` 与 `replenish` 各算各的：补货页 `daysCover` 含 PO 在途，其他页含在库——`core/stock-view.ts:107-125` 已明确警告两者不可比大小，但**没有一页把两者并列展示**。把「先挪（调拨可得）→ 再买（PO）」放进同一张决策表，是缺的那一层。
- `warehouse-inventory` 的窗口出库（发货强度）与 `replenish` 的销量预测互不引用；逐仓补货建议因此不存在。

**与告警（alerts）**
- `inventory-alerts.ts:300` 的动作只有两条；补 `near_expiry → /inventory/expiry?q=`、`overstock → /report/risk?q=` 后，`/inventory/expiry` 从被动清单变成告警落点。
- `transfer-routes` 的 `alert`/`watch` 费用异常与 `scattered` 零散线路**没有进 `system_alerts`**（不像库存预警有 ack/close 闭环）——异常只在页面上，没人被通知。

**与驾驶舱（cockpit）**
- `cockpit.ts:211` 与 `:224` 同时装配 `inventory-position` 和 `warehouse-inventory`，同一屏里放着两个口径不同的在库合计（见 (e)）。统一或明标差额，是驾驶舱可信度的前提。
- 屏 3「各调拨线路」已与 `/inventory/transfer-routes` 同缓存键（`transfer-routes.ts:1-4`），这是全系统做得最对的一处同源范例，值得复制到在库口径上。

**与质量（quality）**
- `/inventory/locations` 的 `quarantine`（隔离）与 `quality` 的案件/召回无任何链接：`quality/service.ts:709-722` 自己另查 `batch_stocks` 算召回范围，而实际被隔离的实物在 `bin_balances` 里。召回决定 → 库位隔离 → 报废出库，这条链现在要手工串。
- `batch-trace` 的 `coverage.note` 已诚实标注出库侧追不到；开 `batch_posting_enabled` 闸门（`admin/params/BatchPostingRolloutCard.tsx` 已有就绪度看板）是让召回真正可用的前置条件。

---

## (e) 库存真相模型 · 与偏离清单

**模型（现状）**

```
onHand(sku) = Σ stock_balances.qty            ← 实时记账仓，仅经 posting/post.ts 变更
            + Σ 各快照仓 (wh,sku) 的 max(biz_date) 快照 qty
                                               ← 快照仓无流水，只有期末数
批次/效期  = batch_stocks，逐仓取该仓 max(stocktake_date)
                                               ← 参考层，非账本，与 stock_balances 不同源
估值       = Σ qty × unitCost，unitCost = sku_costs → 财务运营成本观察 → null
                                               ← 按数量给覆盖率，<80% 标「不完整」
可销天数   = onHand ÷ 近3月日均(÷91)           ← 与补货页 daysCover（含PO在途）是两个口径
```
权威文件：`src/server/core/stock-view.ts`（在库 / 效期段位 / 盘点期收口）、`src/server/core/valuation.ts`（单位成本 + `valueOnHand`）、`src/server/core/velocity.ts`（月窗 / 日均）。

**偏离共享权威、存在本地重实现的位置**

| 文件:行 | 偏离内容 | 后果 |
|---|---|---|
| `src/server/modules/report/inventory-analytics.ts:143-159` | `getOnHandBySku` + `getLatestSnapshotRows` **整段重写**，float `num()` 累加，无 `snapDate` | 第 3 套在库口径；页面无快照口径注记 |
| `src/server/modules/inventory/queries.ts:161-223` | `getLatestSnapshotRows` 的 `latest` 子查询重写 | `/inventory/balance` 全仓页签与 position/warehouses 各算各的 |
| `src/server/modules/master/sku-panorama.ts:167-172` | 同上（第 3 份 `latest` 子查询） | SKU 全景在库分布 |
| `src/server/modules/report/warehouse-inventory.ts:151` | `.where(active = true)`——**唯一**过滤停用仓的在库口径 | 与 `core/stock-view`（不过滤）系统性不等 |
| `src/server/modules/inventory/expiry-list.ts:88` | 缺 `latestStocktakeRows` | 效期量按盘点期数虚增 |
| `src/server/modules/workbench/focus.ts:230-234, 329-337` | 缺 `latestStocktakeRows` | 首屏近效期/已过期虚增 |
| `src/server/modules/master/sku-panorama.ts:182-186`、`sku-brief.ts:116-120`、`inventory/batch-trace.ts:148-152` | 缺 `latestStocktakeRows` | 同一批次多期重复出现 |
| `src/server/modules/report/transfer-suggest.ts:225` | 调 `latestStocktakeRows` 但 SKU 子集查询下**未传 authoritative** | 深链结果 ≠ 全量结果 |

**同一数字、不同来源、可以对不上的具体对子**

1. **全网在库合计** — `/inventory/position` 顶部「全网合计在库」（`inventory-position.ts:270-281`，**不过滤 `active`**，与 `core/stock-view` 同）**vs** `/inventory/warehouses`「在库合计」（`warehouse-inventory.ts:151`，**只算 `active=true`**）。任一仓被停用而仍有余额，二者即差。且 `cockpit.ts:211/224` 把这两个模型**放进同一个驾驶舱**。两页均无口径差额说明。
2. **周转 / DIO** — `/inventory/warehouses`（逐仓，`avgOnHand=(期初+期末)/2`，期初由流水倒推，`warehouse-inventory.ts:232-240`）**vs** `/report/inventory-analytics`（逐 SKU，`avgOnHand ≈ 当前在库`，文件头 `:15-19` 自认失真）。同名「周转」，分母定义不同，必然不等。
3. **已过期数量** — `/report/risk`（收口，`risk.ts:157`）**vs** `/workbench` 首屏「已过期库存待处置」（未收口，`focus.ts:329-337`）**vs** `/inventory/expiry` 「已过期」桶（未收口，`expiry-list.ts:88`）。三处三个数。
4. **可销天数** — `/replenish` 的 `daysCover`（含 PO 在途，`replenish/service.ts`）**vs** 风险页/告警页/`sku-facts` 的 `coverDays`（仅在库）。`core/stock-view.ts:107-125` 已用表格写明「不要直接比大小」，但没有任何页面在 UI 上标出这个区别。
5. **批次/效期** — `/inventory/expiry`（`batch_stocks` 参考层）**vs** `/inventory/docs` FEFO 预览（`batches` + `stock_balances.batch_id` 账本层，闸门关闭）。两套批次互不可见。

---

## 已验证完整（可直接放行）

- **过账引擎** `src/server/posting/post.ts` — registry 白名单、幂等（`uq_ledger_source` 兜底）、排序防死锁、仓库行锁、R4 负库存分仓型、快照仓禁过账、`LOCATED_STOCK` 守卫、`reverse()` 防二次冲销。测试 `tests/posting/engine.test.ts`。
- **库存单据写路径** `src/server/modules/inventory/stock-doc.ts` — 创建/提交/审批+过账+完成同事务、红字冲销唯一纠错路径、负库存 409 人话化、风险处置自动闭环与冲销后重开。测试 `tests/inventory/stock-doc.test.ts`、`risk-disposal-auto-close.test.ts`、`opening-approval-role.test.ts`。
- **盘点 PD → CA → 过账** `src/server/modules/inventory/count.ts` — 财务审批域、账面快照、差异带符号过账、`adjustDocId` 回填、盘点期字段与小样分组。测试 `tests/inventory/count.test.ts`、`count-sample-period.test.ts`。
- **库位子账** `src/server/modules/inventory/bin-operations.ts` + `post.ts:196-208` — `Σbin ≤ stock_balances` 双向不变式、幂等键、负差额不再隐藏。测试 `tests/inventory/bin-operations.test.ts`。
- **`/inventory/position` + `inventory-position.ts`** — 实时/快照分列、缺日缺月留空不补零、`snapshot_delta` 标注、估值覆盖率、`source_binding` 缓存失效、`CaliberNote`。测试 `tests/report/inventory-position.test.ts`。
- **`/inventory/warehouses` + `warehouse-inventory.ts`** — 唯一正确的按仓周转、快照仓明标无流水、金额 <80% 标不完整、与驾驶舱屏 3 同缓存键。测试 `tests/report/warehouse-inventory.test.ts`。
- **`/inventory/transfer-routes` + `transfer-routes.ts` v2 + `transfer-fees.ts`** — 留一法基线、SPC 两档、判定文案不内嵌数值（金额剥离不被绕过）、红字作废一次性 DB 约束、异常回链单据。测试 `tests/report/transfer-routes.test.ts`、`tests/inventory/transfer-fees.test.ts`。
- **`/inventory/alerts` + `inventory-alerts.ts` v3** — 日销三口径并列不相加、阈值逐 SKU 带 basis、在途降级带依据、`source_binding` 含业务日、ack/close 权限前后端同口径。测试 `tests/report/inventory-alerts-supply.test.ts`、`inventory-alerts-spike.test.ts`、`tests/report/calibre-audit.test.ts` C2。
- **`/settlement/js` + `js.ts`** — 审批同事务核销、结余闸门、扣款价代理口径显式标注。测试 `tests/settlement/js.test.ts`。
- **共享权威三件套** `core/stock-view.ts` / `core/valuation.ts` / `core/velocity.ts` — 实现正确、注释把「为什么必须共享」写透（效期段位 92/183 分歧、盘点期翻倍、除数 91 分歧）。问题全部出在**消费方没接**，不在权威本身。