# 供应链系统 — 项目约定

- **本项目只有 7 个 active skill，canonical 正文只在 `.claude/skills/`**；`.agents/skills/`
  是同一批目录的发现层。依据 `description` 自动匹配，明确写 `$skill-name` 可强制调用。
  一次选一个主责、最多一个约束 skill，不并行加载整套：
  - 编排：`supply-chain`
  - 产品/工作流：`design-supply-chain-flows`
  - 数据/迁移/事实核验：`integrate-supply-chain-data`
  - 交易写路径：`write-path`
  - 性能：`measure-first`
  - 发布/红队：`release-sweep`
  - 并行会话安全：`parallel-sessions`
  详细领域资料在 `.claude/skills/supply-chain/reference/`；旧版 playbook 完整保存在
  `docs/skill-history/`，只在需要具体案例时读取。
- 当前入口是 `docs/NOW.md`，需求与决议入口是 `docs/spec/CURRENT.md`；它所指向的宿主规格共同定义需求。
  `docs/spec/01-系统完整规格-v2.0.md` 是核心宿主规格之一，不单独凌驾于后续显式改判；
  术语用《00》A4 统一命名。
- 单据前缀: BH/WO/PO/PC/JG/FL/TL/SH/CT/RK/CK/DB/JS/PD；取号走 doc_counter（`src/server/docflow/doc-no.ts`），禁止 MAX+1
- 金额 decimal(14,2)，数量 decimal(14,4)；禁 float 运算（用字符串/decimal 工具 `src/server/core/decimal.ts`）；时区 Asia/Shanghai
- 库存只能经 `src/server/posting/registry.ts` 过账；禁止直接写 stock_balance/stock_ledger
- stock_ledger 与 audit_log 仅追加；纠错一律红字冲销，无反审批
- 业务规则在 `src/server/rules/*.ts` 纯函数+单测；R5 逐物料计算，禁止跨物料轧差
- 脱敏唯一收口 `src/server/core/dto.ts` 的 `maskSensitive`（含导出/RSC）；前端隐藏不算数
- 余额更新事务内按 (skuId, warehouseId, batchId) 排序；过账/审批靠 UNIQUE 约束幂等
- UI: AntD5 + 中文界面；列表可导出（>5000 行走异步任务）
- 测试: 纯规则用 vitest 直测；涉库测试用 PGlite（`tests/helpers/db.ts`），不依赖 Docker
- Lint: `npm run lint`（eslint@9 flat config，2026-07-26 引入）。**门禁是 0 error / 0 warning**。
  写 `eslint-disable` 必须带 `--` 理由（豁免要能被复核，
  否则又会退回「65 条豁免指向一个没装的 linter」那种状态）。
- DTO 禁止 Map/Set/class 实例作数据容器（maskSensitive 只穿透 plain object/array——红队第二轮裁决）
- 审批幂等键含 cycle=单据版本（驳回→重提→再驳回属新轮次）；期初/盘点审批域=opening/count（财务），勿并回 stock_doc
- 所有 service 写路径必须 writeAudit（core/audit.ts）；写守卫用 getFreshSessionUser 回查 DB
- 生成新迁移后必须重启 dev server（PGlite 迁移仅在启动时应用——热更新代码引用新列会全线 500；/api/health 暴露漂移）
- 路由域约定（Wave U）：新页面路由按业务域取路径（/npd、/inventory/expiry），/report/* 仅限真报表；存量 /report/risk 等为历史遗留不迁移（菜单键稳定优先）
- 结构约定（Wave GG 体检结论，新代码遵循，存量不迁移以保稳定）：
  - struct#6 NPD 模板存 transit_refs(kind=npd_node/role)：建项目时快照进 npd_tasks，模板重导不影响在跑项目（已验证）；后续如拆独立表另议
  - struct#11 报表服务目录 report/ 按域归类为目标，但既有文件不批量移动（30+ import 回归风险>收益）；菜单已按域组织
  - struct#12/#13 /report/* 仅新真报表用；risk/auto-replenish 等写页/工具为历史遗留不改路由（菜单键稳定优先）
- 共享层唯一权威（禁止本地重实现，口径漂移根因）：
  - 在库/快照 → `core/stock-view.ts`（getOnHandBySku / getLatestSnapshotRows）
  - 在途/未结供给 → `core/supply.ts`（getOpenSupplyLines）
  - 销速窗口/日均 → `core/velocity.ts`（lastMonths / dailyFromWindow）
  - ABC 分层 → `rules/abc.ts`（classifyAbc，标准帕累托；窗口统一近 6 月）
  - 服务脚手架 → `core/svc.ts`（AnyDb / num / r1 / r2 / resolveDb）
- 列表页状态平台（`components/useListState` + `ListToolbar`）：新列表页一律采用；
  **必须**在该页 `page.tsx` 包 `<Suspense>`（hook 内用 useSearchParams，缺边界会导致
  useId 序列 SSR/CSR 不一致 → 整页水合失败、退化为无交互静态 HTML）。
  同页多个独立列表（每 Tab 一份）必须给每个实例不同的 `paramPrefix`（URL 参数变 `fg_q`/`fg_page`，
  写入只增删自己的参数、保留兄弟）；fetch 查询串不带前缀，后端参数名不变。
- 客户端/服务端边界（真实事故护栏）：`"use client"` 文件禁止**值导入** `@/server/*`——
  一次值导入会把 auth/pg/原生依赖拖进客户端包，webpack 解析失败后污染模块图，
  导致全应用（含 /api/health）齐刷刷 500 且随编译顺序漂移。需要类型用 `import type`；
  需要常量则由服务端 API 下发，或放进零依赖纯常量模块。
  自动化护栏：`tests/architecture/client-server-boundary.test.ts`（含白名单防腐化断言）。
