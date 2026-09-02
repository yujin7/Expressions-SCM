# 供应链系统 — 项目约定

- **本项目只有 7 个 active skill，canonical 正文只在 `.claude/skills/`**；`.agents/skills/`
  是同一批目录的发现层。只有从仓库根目录启动的会话才把这些仓库 skill 视为可发现；
  `description` 命中只表示可被隐式激活，不保证一定激活。Codex 显式调用写 `$skill-name`，
  Claude Code 写 `/skill-name`。
- 每个任务确定一个主责 skill，再按实施阶段加载完成任务所需的**最少安全门**；数据/迁移、
  写路径、并行会话与发布检查可以组合，不预加载无关整套：
  - 编排：`supply-chain`
  - 产品/工作流：`design-supply-chain-flows`
  - 数据/迁移/事实核验：`integrate-supply-chain-data`
  - 交易写路径：`write-path`
  - 性能：`measure-first`
  - 发布/红队：`release-sweep`
  - 并行会话安全：`parallel-sessions`
  详细领域资料在 `.claude/skills/supply-chain/reference/`；旧版 playbook 完整保存在
  `docs/skill-history/`，只在需要具体案例时读取。
- 仓库内只有两个 live authority：`docs/NOW.md` 管当前状态与下一优先级，
  `docs/spec/CURRENT.md` 管当前业务意图、决议与宿主规格导航。其余规格、README、skill reference、
  历史审计和代码注释都只是支撑材料；冲突不得静默裁决，实施/验证/部署事实仍须在当前 revision 取证。
- 单据前缀: BH/WO/PO/PC/JG/FL/TL/SH/CT/RK/CK/DB/JS/PD/CA/QI/RC/GA；取号走 doc_counters（`src/server/docflow/doc-no.ts`），禁止 MAX+1
- 精度按字段契约：单据金额/价格通常 decimal(14,2)，基础单位成本等 schema 明示字段可 decimal(14,4)；
  业务数量通常 decimal(14,4)，导入控制总量等聚合字段可更宽。不得凭本摘要改 schema；
  禁 float 运算（用字符串/decimal 工具 `src/server/core/decimal.ts`）；时区 Asia/Shanghai
- 库存只能经 `src/server/posting/registry.ts` 过账；禁止直接写 stock_balances/stock_ledger
- stock_ledger 与 audit_logs 由数据库触发器强制仅追加；纠错一律红字冲销，无反审批
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
- 所有业务 service 写路径必须在同一事务边界 writeAudit（core/audit.ts）；低层 helper 可委托调用方，
  但调用链与测试必须证明审计边界；写守卫用 getFreshSessionUser 回查 DB
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
- 运维与集成护栏（2026-08/09 真实事故沉淀，均有测试钉住）：
  - **构建期 env 必须走 Dockerfile `ARG`**：`next.config.ts` 的 `headers()` 在 `next build` 烘焙进 routes-manifest，
    放 compose `environment:` 永远不生效（`tests/architecture/build-time-env.test.ts`）。
  - **`set -o pipefail` 的脚本禁止 `… | grep -q`**：命中即 SIGPIPE，退出码 141，把"命中"判成"失败"
    （曾把健康的守护判成没跑、会把健康的部署判成失败；`tests/architecture/shell-pipefail-grep.test.ts`）。
  - **读模型缓存键随口径升版**（`report_read_model_cache` 的 `key` 带 `/vN`）：只改逻辑不改键，旧缓存会把新线索藏起来。
  - **外部平台身份绝不自动认领**：确定性线索也只进 exactHits 供人一键确认，落库唯一入口 `master/platform-sku-claim.ts`
    （`tests/integrations/jiandaoyun-identity-boundary.test.ts` 钉住"同码也不自动"）。
  - **简道云时间窗契约**（`contract.window`）每批是滚动快照：不适用"全量行数不得下降/旧记录必须仍在"守卫，读模型必须跨批次按业务键去重。
  - **公网隧道必须 `--protocol http2`**（QUIC 出境实测慢一倍，`tests/architecture/public-tunnel-transport.test.ts`）；
    守护脚本运行在 `~/Library/Application Support/exp-scm/`，仓库在 `~/Downloads` 下 launchd 读不到（TCC）。
  - **mac 上 `npm install` 会剪掉 lock 里 Linux/wasm 专属嵌套条目**（`@unrs/resolver-binding-wasm32-wasi/node_modules/@emnapi/*`），
    CI 镜像随即装不齐；改依赖后 `git diff package-lock.json` 只允许出现你要的条目，多删的先 `git checkout` 再手改根块
    （`tests/architecture/agility-loop.test.ts` 钉住）。
  - **观察读模型的批次选择三档**（2026-09-03 生产实况）：交易流（拼多多订单）review 即不用；对照表/维表只经 `_identity` 引用，review 不影响；
    平台日快照若 review 只因业务键重复/缺失仍可用、读模型按业务键 `DISTINCT ON` 去重。被 supersede 的批次任何情况下不再可用——
    否则一次重同步就把外部销速从 1,703 个平台 SKU 静默打回 681（`tests/report/external-velocity.test.ts`、`channel-observation.test.ts` 钉住）。
  - **门禁结论只认汇总行**：`npm run check:pr | tail` 会吞掉失败退出码，必须看 `Test Files … passed` 且无 `failed`；
    加护栏后要验证它对真实违规写法变红。
- 并行会话（`parallel-sessions`）：提交只 `git add` 自己改过的路径，提交前 `git status` 核对别人在改的文件；
  临时脚本用唯一文件名（曾因同名 tmp 文件互删丢过输出）。
