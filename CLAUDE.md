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
  （2026-09-05 起由 `tests/architecture/posting-single-writer.test.ts` 钉住：写语句只允许出现在
  `src/server/posting/` 下。此前这条全仓风险最高的纪律**只写在本文件里、没有门**）
- 仅追加事实表（stock_ledger、audit_logs、alert_events 等，以 `reject_immutable_fact_mutation` 触发器为准）由数据库强制仅追加；纠错一律红字冲销，无反审批
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
  - 告警写入 → `modules/alerts/engine.ts` 的 `upsertAlerts`（2026-09-04 起 `src/` 里不得有第二处 `insert(systemAlerts)`）
  - 告警责任角色 → `rules/task-triggers.ts` 的 `ALERT_OWNER_ROLE`（看门狗禁止硬编码 `ownerRole:` 字面量；
    派单、关闭权限、通知受众三处读同一个值，写死过一次就出现「通知给 ops、待办给 pmc」的分裂）
  - 断货事实核验（流水回放判断是否真断货）→ 只能有一处实现；`jobs/alert-outcome.ts` 与
    `report/closed-loop.ts` 各写一套曾对同一 SKU 给出相反结论
  - 业务日/月/调度小时 → `core/business-day.ts`（`shanghaiDay` / `shanghaiDayOf` / `todayShanghai` /
    `shanghaiMonthOf` / `shanghaiHourKeyOf` / `shanghaiTimestampOf` / `dayDiff`）。
    本模块**必须保持零 import**（它被 rules/、server/modules、src/jobs 和客户端组件同时引用）。
    第一次收口是因为日界在告警引擎、例外打盹、闭环报表、看门狗四处各写一份，`daysBetween` 又各写一份；
    2026-09-05 发现收口时没留守卫，
    `new Intl.DateTimeFormat("en-CA"|"sv-SE", { timeZone: "Asia/Shanghai" })` 又长回 39 份，
    其中两个模块的注释还互相写着「同准」——注释维持不了口径。现由
    `tests/architecture/business-day-single-authority.test.ts` 守。给人看的
    `toLocaleString("zh-CN", …)` 不在此列（那是展示串，不是业务键）。
  - 敏感字段名只能指一件事 → `SENSITIVE_FIELDS`（`core/constants.ts`）里的名字**不得**被非金额字段借用。
    `maskSensitive` 按字段名深剥，分不清「价格偏差」与「偏差阈值」：同名即同权限。
    2026-09-05 实测事故：`report/transfer-routes` 的 `params.deviationPct` 是配置阈值却被整键删掉，
    仓管看到「偏差 > undefined%」，而剥掉它什么都没保护到。门是**行为**门不是文本扫描
    （同一模块里既有真金额又有阈值，静态扫名字分不出来）：`tests/architecture/sensitive-name-collision.test.ts`。
  - 展示格式化 → `components/format.ts`（`formatCount`/`formatYuan`/`formatPct`；驾驶舱趋势层不得再自写一套）；
    比例→百分数只在**服务端**换算后下发，唯一权威 `report/cockpit.ts` 的 `otifRatePctOf`/`ratePctNumOf`
    （驾驶舱 OTIF 曾把 0.83 显示成 0.83%；客户端那对自称权威的 `ratioToPct`/`pctFromRatio` 零调用，已删）
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
    CI 镜像随即装不齐；改依赖前记录 `package.json` / `package-lock.json` 基线与已有改动归属，
    改完逐差异核对 `git diff package-lock.json`。若出现非预期删除，保留当前工作区，在明确指定已核对
    commit 的全新干净临时 worktree 重建并验证候选，再逐差异修复本次误删，保留用户和并行会话修改；
    不得整文件还原或只手拼根块猜测依赖树。差异混合且无法确定归属时先停止覆盖并协调确认
    （平台条目由 `tests/architecture/agility-loop.test.ts` 钉住，恢复指导由 skill-governance-contract 测试守护）。
  - **观察读模型的批次选择三档**（2026-09-03 生产实况）：交易流（拼多多订单）review 即不用；对照表/维表只经 `_identity` 引用，review 不影响；
    平台日快照若 review 只因业务键重复/缺失仍可用、读模型按业务键 `DISTINCT ON` 去重。被 supersede 的批次任何情况下不再可用——
    否则一次重同步就把外部销速从 1,703 个平台 SKU 静默打回 681（`tests/report/external-velocity.test.ts`、`channel-observation.test.ts` 钉住）。
  - **合并多个 agent 分支后、构建镜像前必须本地跑一次 `NEXT_DIST_DIR=.next-buildcheck npx next build`**：
    模块环只在 `next build` 收集页面数据时炸（`Cannot access 'X' before initialization`），`tsc`/`lint`/`vitest` 全绿也照样失败
    （2026-09-04：todo/service → jobs/notify → workbench/focus → todo/stats）。用
    `npx madge --circular --extensions ts,tsx --ts-config tsconfig.json <route>` 定位，动态 import 断环。
    构建可能改写 `next-env.d.ts` / `tsconfig.json`；先记录基线，结束后只撤回本次构建生成的差异，
    不得用整文件 checkout 覆盖并行会话或用户修改。缓存清理由 `npm run clean:cache` 的受控流程处理。
  - **迁移撞号重出后必须逐条比对手写约束**：`drizzle-kit generate` 从 schema 反推 SQL，
    只写在迁移里的东西会被**静默丢弃**。2026-09-05：`fk_qc_record_quality_case` 因此消失过一次
    （它只能写在迁移里——在 `db/schema/docs.ts` 里声明会形成 `docs.ts ↔ quality.ts` 模块环，
    正是上面那条 `next build` 失败形态）。重出后 grep 一遍旧 SQL 里的
    `ADD CONSTRAINT` / `CREATE .* INDEX`，确认一条不少。
  - **并行分支上「干净合并」不等于「正确合并」**：2026-09-05 `projection.ts` 无冲突自动合并，
    结果同时留下新旧两套机制、返回对象出现重复键——文本合并看不出来，只有 `tsc` 报。
    合并后 `tsc`（app + test）必须跑，且对两边都改过语义的模块要人工读一遍返回结构。
  - **静默丢筛选条件比 500 更糟**：`createdWithinShanghaiDays` 原本对非法日期串「直接忽略」，
    于是用户筛了区间、串写错了，拿回来的是**整张未筛选的列表**，界面看起来却像筛选生效——
    一个没有任何迹象的错误答案。非法入参一律 400（`tests/architecture/doc-date-window-rejects.test.ts`）。
    同理：只验形状不验日历也不算校验（`"2026-13-45"` 能过正则，进 SQL 就是 500）。
  - **拒绝必须说清楚拒了什么**：2026-09-04 一条简道云全量镜像流因
    「行数下降 6447 < 6448」受阻，旧报文没有缺失 ID 或人工确认路径；父任务失败不代表所有流停摆。
    拒绝要给出缺失 ID、流/批次、完整性风险与下一步。历史 `rowNo` 是规范化 ID 顺序，
    不是 API 分页顺序；「尾部整段消失」只提示疑似截断，「零散缺失」也不能证明真实删除。
    必须回源核实，签墓碑不绕过完整性守卫。放行路径见 `integrations/deletion-ack.ts`（D69）。
  - **文档里的「唯一权威」若没有门，等于没有**：本仓已四次演示——业务日收口后长回 39 份、
    分域参数权限表只在一层生效、过账唯一写入方从来没有门、SSOT 入口页引用的台账条数漂了 116 条。收口的同一个提交里就要加门，
    并**植入违规验证它会红**（只验证绿的门可能什么都没测）。
  - **`autoCloseAfterDays` 三态语义**（`upsertAlerts`）：`0`＝条件消失即刻关闭（单据流转/凭据刷新这类硬事实）；
    `null`＝永不自动关闭（某周期数据质量不达标属于**已发生的周期事实**，下周没命中不代表上周的问题没了）；
    缺省 `3`＝迟滞关闭，容忍一天的数据缺口。
  - **读模型缓存按 60 天保留期清理**（`housekeeping`，`READ_MODEL_CACHE_RETENTION_DAYS`）：口径升版后旧 `/vN` 键再没有读者，
    缓存丢了只会重算。**升版时同步改 `source` 展示文案**——曾出现驾驶舱标着 `/v1`、趋势层标着 `/v2` 读同一份 payload。
  - **台账正文（标题/范围段/汇总表）与行数据必须一致**：行一直对是因为被测试钉住，正文错是因为没被钉住
    （2026-09-04 漂到「标题 582、单元格 260、合计 653、各行相加 650」）；`system-audit-500` 现已钉住正文。
  - **并行分支合并注册表用 union 会吞掉闭合括号**（2026-09-04：metrics.ts 4 处 `};`/`},` 丢失，tsc 才发现）：union 解决后必须 tsc，并检查 `^  \w+: \{$` 开与 `^  \},$` 闭计数相等；`src/lib/route-access.ts` 变更后用注册表重生成 `tests/architecture/route-registry-derivation.test.ts` 的 LEGACY_* 快照（scratchpad/regen 脚本思路：buildMenuTree(["admin"]) / menuRolesFromRegistry() / PALETTE_PAGES），不要手改快照。
  - **Agent/Workflow 的 worktree 可能基于 main 而非当前分支**：进入后先核对当前 commit、状态与所需基线。
    基线不符时停止在该 worktree 继续，保留其中已提交、暂存、未暂存及未跟踪工作；确认任务需要的
    commit 后在全新路径创建干净临时 worktree，不原地重置或覆盖。确需迁移已有工作时先核对归属，
    逐差异迁入并复核；无法区分用户或并行修改时协调确认。每个域只在自己分支提交，合并前
    `git merge-tree --write-tree HEAD <branch>` 预检冲突。
  - **门禁结论只认汇总行**：`npm run check:pr | tail` 会吞掉失败退出码，必须看 `Test Files … passed` 且无 `failed`；
    加护栏后要验证它对真实违规写法变红。
- 并行会话（`parallel-sessions`）：提交只 `git add` 自己改过的路径，提交前 `git status` 核对别人在改的文件；
  临时脚本用唯一文件名（曾因同名 tmp 文件互删丢过输出）。
