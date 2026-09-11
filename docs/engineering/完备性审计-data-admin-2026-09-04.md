I have enough evidence. Here is the audit.

# 数据地基与系统管理 — 完整性审计

范围：`import/*`、`admin/*`、`master/*`、`jobs/*`、`account/*`、`src/server/integrations/*`、参数体系、读模型缓存绑定。全部结论有 `file:line` 证据。

---

## (a) 页面状态表

### 数据中心 `/import/*`（菜单组「数据中心」）

| 页面 | 用途 / 使用者 | 状态 | 关键缺口 |
|---|---|---|---|
| `/import/upload` `upload-client.tsx` | PMC/财务上传 xlsx 入 staging | **COMPLETE** | 无模板下载。`public/` 只有 `logo.png`，全仓无 `templates/` 目录。`TEMPLATE_OPTS`(upload-client.tsx:15-26) 只有 10 项，但适配器绑死具体 sheet 名（`leadtime.ts:31-32` 要求页名 `生产周期统计`/`生产周期明细`），业务无法自造文件 |
| `/import/jobs` `jobs-client.tsx` | 看导入/连接器任务与拒收明细 | **COMPLETE** | 无状态/模板筛选（`useListState(... defaults: {})` jobs-client.tsx:183）；60+ 模板标签(jobs-client.tsx:12-69)全靠翻页找；无导出；连接器任务只读不能重跑 |
| `/import/exceptions` `exceptions-client.tsx` | 别名认领队列（PMC/采购/仓管） | **PARTIAL** | 逐条认领/忽略(exceptions-client.tsx:294-338)，**无批量、无按金额优先级排序、无导出**。NOW.md:410 记 482 个开放条码异常 + 1,938 缺条码 — 一条一条点不完 |
| `/import/data-quality` `data-quality-client.tsx` | DQ 六维 + 周核对包 + 一致性例外 | **COMPLETE**（本域最完整的页） | 唯一小缺：4 个 `dq_snapshot_*`/`dq_sales_consistency_*` 阈值在页面上只读展示（:425），改值要跳 `/admin/params` |
| `/import/release` `release-client.tsx` (772 行) | 放行工作台：预演→执行→BOM 生效 | **COMPLETE** | preflight 阈值门、`blockedReasons`(release-client.tsx:370)、SoD 都在。无缺口 |

### 系统管理 `/admin/*`

| 页面 | 用途 | 状态 | 关键缺口 |
|---|---|---|---|
| `/admin/users` | 建号/角色/审批人/范围/飞书解绑/重置密码 | **COMPLETE** | 无导出 |
| `/admin/params` `params-client.tsx` (133 行) | 47 个全局数值参数 | **PARTIAL** | ① `tier_basis`(文本)、`alert_learned_lead_tolerance_days`、`loss_rate_pct` 三个在跑的键**根本不在表里**；② **分域参数（sku/brand/segment）全系统零 UI**；③ 三个 `dq_sales_consistency_*` 显示的「缺省」与引擎实际缺省不一致 |
| `/admin/health` `health-client.tsx` (716 行) | 运维面板 | **PARTIAL** | 观测极完整，但**任何任务/同步/探针都没有手动触发按钮**——空态文案 health-client.tsx:607 写着「可手动运行已登记任务」，实际只有 `src/jobs/cli.ts` 命令行。契约选择只读展示(:82)，真正开关在 `JIANDAOYUN_SYNC_CONTRACTS` 环境变量，改一条要重部署 |
| `/admin/audit` | 审计日志检索 | **COMPLETE** | 无导出（合规场景通常要） |
| `/admin/approval-config` | 单据类型→审批角色 | **COMPLETE** | — |

**路由守卫不一致（真 bug）**：`route-access.ts:179` 的 `admin_health` 没写 `roles`，按 `isRouteVisible`(route-access.ts:215-219) 语义 = **全员可见**；但 `admin/health/page.tsx:9` 与 `api/admin/health/route.ts:13` 都是 `admin` 硬门。非管理员在菜单里看得见「运维面板」，点进去是 `NoAccess`。

### 主数据 `/master/*`（菜单组共 11 项）

| 页面 | 状态 | 缺口 |
|---|---|---|
| `/master/sku` (499 行 + 全景/标识/附件抽屉) | **COMPLETE** | 有批量设业务用途(sku-client.tsx:78-95)、S1 取号、命名治理。但表单只有「物流/调拨周期」(:412)、**没有「加工周期」**——同一张 `sku_params` 表，两个字段分两个页面维护 |
| `/master/spu` + `spu-regroup-drawer` | COMPLETE | — |
| `/master/supplier` + `/master/supplier/lifecycle` (544 行) | COMPLETE | — |
| `/master/warehouse` (+ 全景) | COMPLETE | — |
| `/master/bin` / `category` / `feeref` / `bom`(+diff) | COMPLETE | 均为标准 `CrudTable` |
| `/master/supply-params` (221 行) | **PARTIAL — 这是本次审计的核心** | 见 (d) 第 4 节 |
| `/report/data-health`（挂在主数据组） | **PARTIAL** | 470 行的缺失清单，**没有一个跳转到可编辑页的链接**（全文件零 `href`/`Link`），看得见改不了 |
| **渠道 channels** | **缺页** | `api/master/channel/route.ts` 只有 GET；全仓唯一写路径是 `db/seed-dimensions.ts:104`。6 个页面用它做下拉选择器（sku-client.tsx:391、users-client.tsx:332、dashboard、decision-studio、reconcile），**业务永远无法新增/停用一个渠道** |

### 其它

| 页面 | 状态 | 缺口 |
|---|---|---|
| `/jobs/recon` (291 行) | **COMPLETE** | 是全系统**唯一**有「立即执行」按钮的任务(recon-client.tsx:97-101 → `/api/jobs/recon/run`) |
| `/jobs`（索引） | **不存在** | 目录下只有 `recon/`，注册表里也只有 `jobs_recon`(route-access.ts:148) |
| `/account/password` | **COMPLETE** | 首登强制改密由 `(app)/layout.tsx:12` 驱动 |

---

## (b) 按价值排序的 12 项完成项

> 权重说明：#1–#5 直接决定 167 个试点候选能否解冻、外部销速能否从 23.8% 涨上去。

**1. `/master/supply-params` 批量补录（S→M）** — 今天只有逐行 `PATCH /api/master/sku/{id}/supply-params`（`supply-params-client.tsx:97-114`；`api/master/supply-params/route.ts` **只有 GET**）。520/5,376 覆盖率（NOW.md:694）意味着要点 4,856 次。需要：勾选多行 → 批量填同一值 + 「按分层/品牌套用默认」+ `POST /api/master/supply-params/bulk`。**这是解冻 167 个直出候选的唯一路径**（NOW.md:693：「补录 `/master/supply-params` 是唯一解」）。

**2. 周期主数据「导出待办 → 改 → 导回」闭环（M）** — `supply-params-client.tsx:189-207` 的 `ListToolbar` **没有 `onExport`**，`leadtime.ts:31-32` 的导入适配器又绑死两个供应商工作簿页名。业务拿不到一份「SKU编码/加工周期/在途周期」的空表去线下填。做法：导出当前筛选（含 `blockedOnly=1`）为 CSV + 新增一个通用 `sku_leadtime_simple` 适配器接受同样的列。

**3. 分域参数 UI（M）** — `src/server/core/scoped-params.ts`（295 行，含 `setScopedParam`/`clearScopedParam`/`listScopedOverrides`）+ `api/admin/params/scoped/route.ts` + `tests/core/scoped-params.test.ts` 全部到位，**前端零调用**（`grep -rn "params/scoped" src/app --include=*.tsx` 无结果）。路由自己的注释(scoped/route.ts:9-14)说这套是为了让 ABC/XYZ 九宫格「落参」，结果落参的按钮没造。生产里只有 2 个键真走分域解析（`replenish/service.ts:515` `cover_target_days`、`:635` `safety_days_fallback`），其余 45 个永远是全局值。**并且 `/admin/params` 只读 `scope='global'`（admin/params.ts:122-125），已存在的 sku/brand 覆盖在 UI 上完全不可见** —— 一旦有人用 API 写过，页面就在说谎。

**4. `inventory-alerts` 读模型缓存绑定漏掉全部运行参数（S，但影响面最大）** — `computeInventoryAlerts` 读 9 个参数（`inventory-alerts.ts:176-188`：`default_production_lead_days`/`default_logistics_lead_days`/`alert_buffer_days`/`cover_target_days`/`grade_s|a|b_pct`/`slow_days_threshold`/`alert_learned_lead_tolerance_days`），但 `binding()`（:132-149）只绑事实表和 `todayShanghai()`，**一个参数值都没进指纹**。PMC 在 `/admin/params` 把预警缓冲从 5 天改成 10 天，`/inventory/alerts` 会继续返回旧结论直到某张事实表变动。对照组：`risk-expiry-buckets.ts:225,235` 绑了 `slow:${slowThreshold}`、`sales-spike.ts:90` 绑了 `spike_%`、`supplier-payment-term`/`purchase-order-metrics`/`transfer-routes`/`sales-consistency` 都绑了 —— 只有最要紧的断货预警漏了。

**5. 平台身份认领队列搬进主数据域（S）** — 唯一的认领 UI 是 `report/decision-studio/platform-sku-gap-card.tsx`（495 行，功能其实很强：一键认领精确命中 300 条、拼多多批量、批量补条码 500 条、按金额排序、候选打分）。但它埋在「决策工作室」的一个标签页里，`master` 菜单组和 `import/exceptions` 都不指向它。23.8% 覆盖率（NOW.md:410）的清账入口，PMC 在菜单里找不到。做法：`master` 组加一条指向 `/report/decision-studio?tab=identity` 的入口，或把这张卡复用到 `/import/exceptions` 的一个标签页。

**6. 工作台的「缺生产周期」卡片指向了只读页（XS）** — `workbench/focus.ts:421` 的 `href: "/report/data-health?missing=生产周期"` 指向一个不能编辑的清单；同一件事 `replenish/pilot/pilot-client.tsx:123` 已经正确地指向 `/master/supply-params?blockedOnly=1`。改一个字符串，PMC 从工作台一步到可编辑页。

**7. `loss_rate_pct` 没有任何 UI（S）** — `settlement/js.ts:58-64` 用 `scope=category:<lossCategory>` 的 `loss_rate_pct` 做 R2 允许损耗率，直接进结算金额。种子写死 `packaging=5 / raw=2`（`db/seed.ts:104-105`，注记还写着「D5 待定」）。它不在 `PARAM_DEFS` 里，所以 `/admin/params` 看不见，`setScopedParam` 也会因 `requireDef`(scoped-params.ts:100-104) 拒绝。**要改这个直接影响钱的数字，今天只能手写 SQL。**

**8. `tier_basis` 与 `alert_learned_lead_tolerance_days` 无 UI（S）** — `segmentation.ts:181` 的 `tier_basis`（qty|value，决定九宫格主口径）走 `getTextParam`，而 `PARAM_DEFS` 只承载数值（admin/params.ts:32 注释自认）。`alert_learned_lead_tolerance_days` 被 `inventory-alerts.ts:187,341` 和 `supplier-lead-history.ts:441` 读，且**写进了给用户看的口径说明文案**，用户却改不了它。需要在参数页加一个「枚举/开关」分区。

**9. 运维面板加「立即运行」按钮（M）** — 33 个 cron 任务（`jobs/scheduler.ts:13-69`）、5 个连接器同步、2 个权限探针，**在 App 内一个都触发不了**。`interval-runner.ts` 已导出 `runNamedIntervalJobOnce`，`cli.ts:78` 已有 `run-job <name>` 通道，只差一条 admin-only 的 `POST /api/admin/jobs/{name}/run`。今天数据不新，管理员要 SSH 进机器。

**10. `data-quality/v2` 缓存指纹认不出参数改动（S）** — `data-quality.ts:397` 用 `(SELECT max(id) FROM sys_params) AS sp`，但 `updateParam`(admin/params.ts:177-180) 走 `onConflictDoUpdate`，**改值不会改 id**。指纹里只显式带了 `tol:${tol}`（:402），所以改 `dq_snapshot_qty_jump_pct`/`dq_snapshot_vanished_pct` 后页面照旧。改成把这三个键的值直接拼进指纹即可。

**11. `dq_sales_consistency_*` 的「缺省」标错（XS）** — `PARAM_DEFS` 写 15/20/50（admin/params.ts:79-81），引擎实际用 `DEFAULT_SALES_CONSISTENCY_THRESHOLDS = {10, 5, 10}`（sales-consistency.ts:36,161-163）。参数页对着从未设过值的行打「缺省」标签并显示 15，引擎在用 10。同类还有 `cover_target_days`：`replenish/service.ts:388` 缺省 45、`inventory-alerts.ts:182` 缺省 0（语义是"无目标"）。缺省值应当只有一处权威。

**12. 渠道主数据写入口（S）** — 见上表。`master` 组补一个标准 `CrudTable` 页 + `POST/PATCH /api/master/channel`，与 `category`/`bin` 完全同构。

---

## (c) sys_param 全表

图例：**UI** = `/admin/params` 是否渲染（含 label/range）；**绑定** = 改值是否让消费它的读模型缓存失效。

### 交易规则类（写路径直读，无读模型缓存）

| key | 读取处 | UI | 缺省 | 绑定 |
|---|---|---|---|---|
| `price_tolerance_pct` | `outsource/po.ts:33`（绕过 `getNumParam` 直查 DB） | ✅ admin | 3（seed.ts:100） | n/a ✅ |
| `over_receive_tolerance_pct` | `matflow/sh.ts:95` → `matflow/common-notes.ts:27` | ✅ admin | 0（seed.ts:101） | n/a ✅ |
| `concession_price_ratio` | `settlement/js.ts:214` → 本地 `getGlobalParam`(js.ts:69) | ✅ admin | 100（seed.ts:102） | n/a ✅ |
| **`loss_rate_pct`**（scope=`category:*`） | `settlement/js.ts:64` | ❌ **无 UI** | 5 / 2（seed.ts:104-105） | n/a ❌ |
| `po_expected_date_required` | `outsource/po.ts:100` | ✅ admin | 0 | n/a ✅ |
| `auto_wo_on_bh` | `outsource/auto-chain.ts:350`, `api/outsource/auto-chain/preview:14` | ✅ admin | 0 | n/a ✅ |
| `auto_jg_on_ready` | `outsource/auto-chain.ts:379`, preview:15 | ✅ admin | 0 | n/a ✅ |
| `batch_posting_enabled` | `inventory/batch-allocation.ts:28` | ⚠️ 只读（专项闸门，走 `BatchPostingRolloutCard`；`updateParam` 直接 409，admin/params.ts:171-176） | 0（seed） | n/a ✅ |
| `warehouse_max_active` | `master/warehouse.ts:82,105` | ✅ admin | 12 | n/a ✅ |

### 补货 / 分层（`PMC_WRITABLE_PARAM_KEYS`，admin/params.ts:89-111）

| key | 读取处 | UI | 缺省 | 绑定 |
|---|---|---|---|---|
| `slow_days_threshold` | `dashboard.ts:408`, `risk.ts:100`, `risk-expiry-buckets.ts:225`, `cockpit-trends.ts:1069`, `inventory-analytics.ts:116`, `inventory-alerts.ts:186` | ✅ pmc | 180 | risk-expiry ✅(`:235 slow:`) / **inventory-alerts ❌** / 其余未缓存 ✅ |
| `cover_alert_days` | `workbench/focus.ts:171`, `replenish/service.ts:394`, `inventory-analytics.ts:115` | ✅ pmc | 30 | 未缓存 ✅ |
| `cover_target_days` | `replenish/service.ts:388` + `:515` **makeResolver（分域）**, `transfer-suggest.ts:152`, `inventory-alerts.ts:182`（缺省 0，不一致） | ✅ pmc（**仅 global；分域覆盖不可见不可设**） | 45 | **inventory-alerts ❌** |
| `cover_target_days_a/b/c` | `replenish/service.ts:390-392` | ✅ pmc | 60/45/25 | 未缓存 ✅ |
| `safety_days_fallback` | `replenish/service.ts:635` **makeResolver（分域）** | ✅ pmc（仅 global） | 7 | 未缓存 ✅ |
| `service_level_pct` | `replenish/service.ts:634` | ✅ pmc | 95 | 未缓存 ✅ |
| `default_production_lead_days` | `inventory-alerts.ts:179`, `supplier-lead-history.ts:438`, `transfer-suggest.ts:153` | ✅ pmc | 30 | supplier-lead-history ✅(`:571`) / **inventory-alerts ❌** |
| `default_logistics_lead_days` | 同上 :180/:439/:154 | ✅ pmc | 15 | 同上 |
| `alert_buffer_days` | 同上 :181/:440/:155 | ✅ pmc | 5 | 同上 |
| **`alert_learned_lead_tolerance_days`** | `inventory-alerts.ts:187,341`, `supplier-lead-history.ts:441,571` | ❌ **不在 PARAM_DEFS** | 3（硬编码） | supplier-lead-history ✅ / inventory-alerts ❌ |
| `grade_s_pct` / `grade_a_pct` / `grade_b_pct` | `segmentation.ts:188-190`, `inventory-alerts.ts:183-185` | ✅ pmc | 50/80/95（`rules/abc.ts:62`一致 ✅） | replenish-pilot ✅(`:194`) / **inventory-alerts ❌** / segmentation 未缓存 |
| **`tier_basis`**（文本 qty\|value） | `segmentation.ts:181`, `replenish-pilot.ts:84,194` | ❌ **无 UI**（PARAM_DEFS 只承载数值） | `"qty"`（segmentation.ts:163） | replenish-pilot ✅ |
| `spike_consecutive_days` / `spike_rise_pct` / `spike_min_base_qty` | `sales-spike.ts:100-102` | ✅ pmc | 3/50/10 | ✅ `sales-spike.ts:90` 绑 `spike_%` 全量 |
| `detector_sales_drop_pct` / `_channel_shift_pct` / `_velocity_dev_pct` | `detectors.ts:185-187` | ✅ pmc | 70/15/40（与 `DETECTOR_THRESHOLDS` 一致 ✅） | 未缓存 ✅ |
| `ops_demand_diff_pct` | `replenish/reconcile.ts:293` | ✅ pmc | 30 | 未缓存 ✅ |

### 经营口径 / 数据质量（admin-only）

| key | 读取处 | UI | 缺省 | 绑定 |
|---|---|---|---|---|
| `valuation_coverage_min_pct` | `segmentation.ts:214`, `inventory-position.ts:242,263` | ✅ admin | 80 ✅ | inventory-position ✅(`:247 min${minPct}`) |
| `inventory_sales_ratio_target_low` / `_high` | `inventory-sales-ratio.ts:95-96` | ✅ admin | 45/47 ✅ | ✅(`:108 target:`) |
| `transfer_cost_window_days` / `_deviation_pct` | `inventory/transfer-fees.ts:87-88`, `transfer-routes.ts:305-306` | ✅ admin | 180/20 | transfer-routes ✅ |
| `transfer_qty_deviation_x` / `transfer_batch_max_docs` | `transfer-routes.ts:307-308` | ✅ admin | 3/4 | ✅ |
| `payment_term_min_years` / `_target_min_days` / `_target_max_days` | `supplier-payment-term.ts:137-139` | ✅ admin | 2/45/60 | ✅(`:393`) |
| `otif_window_days` / `otif_qty_tolerance_pct` | `purchase-order-metrics.ts:269-270` | ✅ admin | 2/0 | ✅(`:639`) |
| `dq_tolerance_pct` | `data-quality.ts:271,400` | ✅ admin | 1 | ✅(`:402 tol:`) |
| `dq_snapshot_qty_jump_pct` / `dq_snapshot_vanished_pct` | `data-quality.ts:272-273`, `release/engine/snapshots.ts:56-57` | ✅ admin | 30/10 | **❌** — 指纹只有 `max(id) FROM sys_params`，UPDATE 不改 id |
| `dq_sales_consistency_rel_pct` / `_abs_floor_qty` / `_min_base_qty` | `sales-consistency.ts:161-163` | ⚠️ 显示 15/20/50，引擎实际 **10/5/10**（sales-consistency.ts:36） | 不一致 | ✅(`:436 t:`) |

**跨切关注**：`getNumParam` 的 60s 进程内缓存（`core/params.ts:27`）在写时 `clearParamCache()`，但只清**当前副本**。`docker-compose.prod.yml` 是多副本部署 → 参数改动最多 60s 内在其它副本仍是旧值。可接受，但没写进任何文档。

---

## (d) 协同机会

**1. 一个「主数据补录中心」，而不是四个散落的入口。** 今天要清完 NOW.md:694 列的四笔欠账，PMC 要跑四个地方，其中两个不在主数据菜单里：

| 欠账 | 现有入口 | 批量? | 模板? | 进度? | 队列优先级? |
|---|---|---|---|---|---|
| `sku_params` 周期（520/5,376，167 个候选被卡） | `/master/supply-params` | ❌ 逐行 | ❌ | ✅ 分层×维度统计 | ⚠️ 只有 `blockedOnly` 开关 |
| `sku_costs`（1 行） | `/report/margin`（财务，逐行 `margin-client.tsx:124-129`）+ `import/upload` 模板 `sku_cost` | ⚠️ 仅 Excel | ❌ | ✅ 「待录入成本」计数(:356) | ❌ |
| 平台身份认领（23.8%） | `/report/decision-studio` 的一张卡 | ✅ 300/500 一批 | n/a | ✅ 覆盖率 + 「若采纳全部建议可达」 | ✅ 按支付金额排序 |
| 快照（只有 2026-07-21 一天） | `/import/upload` 模板 `inventory` | n/a | ❌ | ✅ `/admin/health` 快照数据龄 | n/a |

**规律很清楚：唯一做对了批量+优先级+进度三件事的是身份认领卡，而它是这四项里唯一不在主数据菜单里的。** 把它的三个模式（按价值排序的队列 / 系统给候选人工确认 / 批量提交上限 + 预览）复制到周期补录页，是投入产出最高的一次改造。

**2. 缺省值单一权威。** 现在 `PARAM_DEFS.fallback`、调用点的字面量、`DEFAULT_*` 常量三处各写一份，已经漂了 3 个键（#11）。让 `getNumParam` 的第二参数强制从 `PARAM_DEFS` 取（`getNumParam("k")` 自查表），漂移在编译期就没了。

**3. 缓存绑定护栏。** 已经有 `tests/architecture/` 34 个契约测试的传统。加一条：扫描每个 `report/*.ts` 里的 `getNumParam("X"` 与同文件 `binding()` 返回串，要求 key 出现在指纹拼接里。这一条测试同时钉死 #4 和 #10，且防止再犯。

**4. 连接器契约的「已同步但无人读」。** 34 条简道云契约（`jiandaoyun-contracts.ts`）里，本地 `.env` 启用 29 条，其中 **4 条零消费者**：`jst-bundle-bom-mirror-observation`、`vip-bundle-crosswalk-observation`、`finance-operating-cost-observation`、`vip-sku-cost-observation`（`grep -rl` 在 `src/server/modules` + `src/app` 全无命中）。每轮同步 8.5 万行/约 12 分钟（scheduler.ts:17），这四条在白烧配额。同理 **用友 8 条只读契约**（`yonyou-contracts.ts:23-72`，662 行 `yonyou-sync.ts`）写进 staging 的 `yonyou_observation`，全仓唯一引用是 `import/jobs/jobs-client.tsx:34` 的一个中文标签；`jst_inventory_observation`/`jst_item_master_observation`/`jst_inbound_receipts_observation` 同样只有标签、没有读者。建议：`/admin/health` 的契约卡上加一列「下游读模型」，零消费者的标灰并给出停用建议。

**5. dev/prod 契约漂移。** `.env` 29 条 vs `.env.prod` 33 条；本地缺 `tmall-unit-daily`/`pdd-order`/`vip-shop-trading`/`tmall-product-pnl`/`bonded-warehouse-order` —— 而 `platform-sku-identity-gap.ts`、`external-velocity.ts`、`channel-observation.ts`、`bonded-outbound.ts` 都读它们。本地跑这几个读模型必然「数据不足」，容易被误判成代码问题。`tests/architecture/env-example-coverage.test.ts` 已有 env 契约测试的先例，可扩到契约集。

**6. 新人上手（PMC）。** 菜单结构本身没问题：16 个分组、`route-access.ts` 单一注册表、`keywords` 拼音+英文双检索（如 master_supply_params:162 带 `"supply params lead time zhouqi bulu 周期 补录"`）。**但全系统没有任何「先做什么」的引导态** —— `grep -rn "首次|新手|引导|onboard|第一步"` 只命中首登强制改密（`(app)/layout.tsx:12`）。工作台 `workbench/focus.ts` 的例外引擎只产出 5 类卡片（`:341/351/358/359/364/421`），其中只有 1 类（`missing_lead`）关于主数据，而且指向只读页（见 (b)#6）；**没有身份认领缺口卡、没有 sku_costs 缺口卡、没有别名认领队列卡**。一个新 PMC 登录后看到的是「你有几个断货预警」，而不是「你的系统还没准备好给出可信的断货预警，先补这三样」。

---

## (e) 已验证完整（无需返工）

- `/import/release` — 772 行放行工作台。预演/执行分离、preflight 阈值门 + override token、SPU 簇与 BOM 歧义块显式裁决、BOM 生效 SoD。
- `/import/data-quality` — 六维来源矩阵 + 快照相邻批次对比 + 周/月核对包（生成/完成/豁免，豁免原因前端预校验 `:494`）+ 一致性例外 + 手工改写逐条 + 低于量下限，5 个独立 `paramPrefix` 列表，全部可导出并标注「仅导出当前页」。
- `/import/jobs` 的拒收明细闭环 — 失败行按需生成 CSV 并受控下载（jobs-client.tsx:205-216、`api/import/jobs/[id]/errors`），有 `tests/architecture/import-rejection-download.test.ts` 钉住。
- `/admin/users` — 建号/编辑/角色/审批人标记/数据范围/飞书解绑/重置密码兼解锁，`session_version` 立即作废旧 JWT。
- `/admin/audit` — 7 个筛选维度（entity/entityId/user/action/日期/全文），`api/admin/audit/entities` 动态供 entity 选项。
- `/admin/approval-config` — 单据类型→审批角色自助配置，拒绝把 `admin` 设为审批角色，逐条审计。
- `/admin/health` 的**观测面** — 迁移漂移、任务运行史、连接器就绪五态分离判定（代码/凭据/启用/契约/真实 UAT）、只读权限探针逐项结果、检查点版本与对齐状态、字段结构漂移阻断、备份新鲜度、快照数据龄。这是本仓最认真的一页，唯一的缺是没有动作按钮。
- `/jobs/recon` — 手动执行 + 差异明细 + 实时 `unresolvedRows`。
- `/account/password` — 原密码校验、全会话失效、首登强制。
- `/master/*` 的 8 个标准 CRUD 页（spu / sku / category / supplier / lifecycle / warehouse / bin / bom / feeref）— 统一 `CrudTable`、角色化 `canCreate`/`canEdit`、敏感金额服务端剥离（feeref `feeRate` 走 `maskSensitive`）。
- `master/sku` 的批量业务用途设置（sku-client.tsx:78-95）— **这是全仓批量主数据编辑的正确样板**，`/master/supply-params` 照抄它即可。
- `core/scoped-params.ts` 服务端实现本身 — 继承顺序、`clearScopedParam` 回退、global 层提权口子已封（`:201-203`，注释记录了 2026-07-26 红队实证）、双缓存一并失效、审计 entity 与 admin 路径对齐。**代码是对的，只差 UI。**