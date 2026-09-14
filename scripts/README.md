# scripts/ 说明

`verify-postgres-stock-replacement.ts`：显式设置 `SCM_ALLOW_MUTATING_PG_CONTRACT=1`，仅迁移至0076的 loopback `scm_contract_*`。四连接验证同原单不同请求防分叉、同键恢复、审计故障整笔回滚、新鲜身份撤销及外键/唯一/无环约束。保留合成单、回执和审计，不过账；只移除本次唯一故障触发器，不在正式库运行，不代替发布/真实UAT。

`verify-postgres-stock-lifecycle-exit.ts`：显式设置 `SCM_ALLOW_MUTATING_PG_CONTRACT=1`，仅已迁移的 loopback `scm_contract_*`。三连接真实锁等待验证作废/提交、审批/撤回及身份撤销；审计注入失败回滚、CA来源保护、原因读取与审批重放。保留合成账号、7张库存单、1笔精确0.0001入库及审计；只移除本次唯一故障触发器，不在正式库运行，不代替发布/真实UAT。

目录里有两类脚本，按「是否被 package.json / 文档 / 代码引用」区分。**新增脚本请归到对应类别并在本文登记**。

## 一、现行入口（被 `package.json` 或文档引用）

| 用途 | 脚本 | 入口 |
|---|---|---|
| 门禁 | `verify-fast.ts` `verify-release.ts` `verify-ops.ts` `verify-postgres*.ts` | `npm run check:*` |
| 缓存清理 | `clean-caches.ts`，经`scm.ts`亦可调用 | 默认预览；`--all`仅扩大预览。先停已确认owner，`--apply --target .next-dev`等逐项移到`.cache-cleanup-trash/<批次>/`，不自动删除；占用或检查失败即拒绝 |
| PostgreSQL 复核原子性 | `verify-postgres-review-atomicity.ts` | `npm run check:postgres:review-atomicity`；仅一次性本机 `scm_contract_*` 库，须 `SCM_ALLOW_MUTATING_PG_CONTRACT=1`；先运行迁移。保留合成记录与审计，不用于生产库或发布后清理 |
| PostgreSQL 采购退货原草稿纠正/作废 | `verify-postgres-ct-draft.ts` | 手动 `SCM_ALLOW_MUTATING_PG_CONTRACT=1 DATABASE_URL=<隔离库> node --import tsx scripts/verify-postgres-ct-draft.ts`；仅已迁移loopback `scm_contract_*`，关闭后台任务。13项真实并发/审计故障验证：双编辑、编辑与提交双向、已收减少、撤权；双作废、作废与编辑/提交双向、作废撤权、两类审计故障回滚。保留合成原料/期初入库/退货草稿及审计，只移除本次唯一命名故障触发器/函数。纠正/作废本身不写库存，不在正式库执行 |
| PostgreSQL 采购退货建单恢复 | `verify-postgres-ct-create-recovery.ts` | 手动 `SCM_ALLOW_MUTATING_PG_CONTRACT=1 DATABASE_URL=<隔离库> node --import tsx scripts/verify-postgres-ct-create-recovery.ts`；仅已迁移0074的loopback `scm_contract_*`，关闭后台任务。四连接17项验证重放/GET等待、未提交不可见、唯一草稿/回执/审计、不可变回执、异参拒绝、作废回读、取消先赢阻断迟到创建、创建先赢保留原单、取消审计失败回滚及撤会话拒绝。只清理本次故障触发器/函数，保留合成回执/草稿及期初流水，不对CT过账、不改正式库，不代替真实业务验收 |
| PostgreSQL 库存建单引用资格 | `verify-postgres-stock-create-references.ts` | 手动 `SCM_ALLOW_MUTATING_PG_CONTRACT=1 DATABASE_URL=<隔离库> node --import tsx scripts/verify-postgres-stock-create-references.ts`；仅已迁移的loopback `scm_contract_*`，关闭后台任务。12项真实双向锁等待覆盖源/目标仓停用及快照模式、SKU停用、报废登记关闭；检查取号/草稿/审计原子提交和拒绝零写入。保留合成资料，不改正式库，不代替发布门或真实UAT |
| PostgreSQL 库存建单恢复 | `verify-postgres-stock-create-recovery.ts` | 手动 `SCM_ALLOW_MUTATING_PG_CONTRACT=1 DATABASE_URL=<隔离库> node --import tsx scripts/verify-postgres-stock-create-recovery.ts`；仅已迁移0075（76项）的loopback `scm_contract_*`。四连接真实等待验证同键恢复、异参拒绝、创建/取消两种先后、审计故障整笔回滚及身份撤销；保留2张合成单、4份请求回执及4条审计，零库存流水，不碰正式库或代签真实UAT |
| PostgreSQL 调拨费用/加工计划并发 | `verify-postgres-transfer-fees.ts`、`verify-postgres-jg-plan.ts` | CI现有PG门禁自动运行；手动用`node --import tsx scripts/<对应脚本>`。先迁移隔离loopback `scm_contract_*` 库，显式`SCM_ALLOW_MUTATING_PG_CONTRACT=1`、`SCM_RUN_JOBS=0`；3项费用锁与7项JG锁证明，保留合成记录，不用于生产库 |
| PostgreSQL 加工费申请/结算并发 | `verify-postgres-pc-write.ts` | 同一隔离PG门自动运行；相同显式loopback/一次性库守卫。8项真实多连接竞争：重复申请、审批后取现价、审批重放、历史重复申请冲突、停用身份、结算创建/提交及财务冻结；保留合成记录与审计，不在生产执行 |
| PostgreSQL 发退料/结算/入库核对与工单生成并发 | `verify-postgres-settlement-basis.ts` | 手动 `SCM_ALLOW_MUTATING_PG_CONTRACT=1 DATABASE_URL=<隔离库> node --import tsx scripts/verify-postgres-settlement-basis.ts`；只允许loopback `scm_contract_*`。50项真实PG验证：收发/结算冻结、入库估算、批次资格、同SH恢复/不同SH共用WO锁/采购来源改挂、初次生成重放及与自动批次双向竞争；WO创建的工厂/成品/BOM/身份竞争、重复提交/批准、停用提交、撤审批资格，撤回vs批准、停用vs撤回、撤管理角色vs短关，以及同键同意图/不同意图建单竞争、核对回执vs撤权；PO撤角色vs短关、完成vs短关、重复短关单次审计；同PO并发R1复用PC、撤回vs批准、撤采购角色vs代录、关闭vs生成链接；暂停WO vs 自动建批。测试临时启用建批开关后恢复原值/缺省，保留合成业务数据，不在生产执行，不代替完整发布门 |
| PostgreSQL 备货明细生成与恢复并发 | `verify-postgres-bh-line-generation.ts` | 手动 `SCM_ALLOW_MUTATING_PG_CONTRACT=1 DATABASE_URL=<隔离库> node --import tsx scripts/verify-postgres-bh-line-generation.ts`；仅loopback `scm_contract_*`，须先迁移0067。5项真实锁等待：两人同明细复用、同SKU不同明细分别生成、来源关闭拒绝、手工未分配工单先提交后拒绝自动认领、账号停用拒绝。验证凭据/草稿/审计及库存不变，保留合成夹具，不代替正式UAT |
| PostgreSQL 备货写入资格与流转并发 | `verify-postgres-bh-write-authority.ts` | 手动 `SCM_ALLOW_MUTATING_PG_CONTRACT=1 DATABASE_URL=<隔离库> node --import tsx scripts/verify-postgres-bh-write-authority.ts`；仅loopback `scm_contract_*`。5项真实锁等待：编辑/提交、审批/撤回、双人审批重放、撤销审批标记、SKU停用/创建；核对状态、精确明细、审批/审计及库存不变。保留合成夹具，不修改正式数据 |
| PostgreSQL 新品/冻结计划回执并发 | `verify-postgres-source-replay.ts` | 手动 `SCM_ALLOW_MUTATING_PG_CONTRACT=1 DATABASE_URL=<隔离库> node --import tsx scripts/verify-postgres-source-replay.ts`；仅loopback `scm_contract_*`。9项真实锁等待覆盖同键重试、只读恢复等待提交、原意冲突、来源关闭、跨新品项目竞争与写入/恢复时当前身份撤销；保留合成夹具和审计，不修改正式数据 |
| PostgreSQL 月度冻结与实时补货互斥 | `verify-postgres-sop-mode.ts` | 同样显式启用 `SCM_ALLOW_MUTATING_PG_CONTRACT=1`，仅已迁移的loopback `scm_contract_*`，且上海当月尚无周期；存在则拒绝，不重置旧周期。10项覆盖建单/冻结双向竞争、冻结事务回滚、关闭后解锁、跨月不互锁、6条治理/开单路径等待身份撤销；保留合成草稿与双审计，库存不动 |
| PostgreSQL 用友重试与并发 | `verify-postgres-yonyou-concurrency.ts` | `npm run check:postgres:yonyou-concurrency`；仅临时复制候选 + 一次性 loopback PG16 `scm_contract_*` 库；显式 `NODE_ENV=test`、`SCM_RUN_JOBS=0`、`SCM_ALLOW_MUTATING_PG_CONTRACT=1`、`DATABASE_URL` 及候选内绝对 `FILE_STORAGE_DIR`；先迁移并运行 `check:postgres`。库内不得已有用友 run/checkpoint，重跑用新库，不删除合成事实绕过守卫 |
| 局域网/公网访问 | `install-public-tunnel.sh` `public-tunnel-daemon.sh` `remove-public-tunnel.sh` `show-access-link.sh` `sync-lan-auth-url.sh` `*mdns-alias.sh` `setup-public-tunnel.sh`（具名隧道，需域名）`setup-tailscale-access.sh`（需注册） | `npm run access:*` / `lan:*`；见 `docs/guides/对外访问方案-选型与步骤.md` |
| 账号 | `set-initial-passwords.ts`（逐人独立初始口令、首登改密）`reset-admin-emergency.ts`（三重开关）`reset-local-admin.ts`（仅 PGlite） | `docs/engineering/本机实跑指南.md` |
| 主数据纠正（逐条审计） | `recode-sku.ts`（零历史坏码改码）`fill-blank-sku-name.ts`（只补空名）`backfill-sku-names-from-transit.ts`（名称=编码时按源表品名回填） | 同上 |
| 简道云 | `jiandaoyun-survey.ts`（297 表单时效普查）`jiandaoyun-barcode-gap.ts` | `npm run jdy:*` |
| 冒烟 | `smoke-e2e.ts`（只读；`SMOKE_PASSWORD_<用户名>`）`perf-smoke.ts` | `npm run check:release` |
| 其它 | `dev-session.ts` `sanitize-standalone.ts` `normalize-next-env.ts` `patch-minimatch-brace-api.mjs` `make-square-icon.mjs`（由宽幅 logo 生成正方形标签页图标） | 构建/开发链 |

用友 PG 合约已注册在现有 CI **PostgreSQL migration contract** 作业内：沿用同一个临时 PG 服务，
另建空库 `scm_contract_yonyou_ci`，只复制 `src`、迁移、脚本和必需配置至 `mktemp` 候选目录，
复用已安装的 `node_modules`；不复制 `.env`、本机数据或上传目录。失败直接使原有 PG 门禁失败。
它核验等待授权→重试→恢复→重放、真零行、同 scope 互斥、真实 advisory 锁及迟到结果隔离；
全部响应均为合成，不证明真实平台授权、生产同步或 UAT。脚本保留合成记录和证据，CI 作业结束后由临时运行器回收环境。

### 备货创建恢复并发验证

`verify-postgres-bh-create.ts`：显式启用 `SCM_ALLOW_MUTATING_PG_CONTRACT=1`，仅允许已迁移的loopback `scm_contract_*`；当月实时开单须未冻结。7项真实锁等待覆盖手工/实时同键竞争、原意冲突、创建中只读找回及身份撤销。保留合成账号、SKU、5张BH和仅追加回执/审计；不改库存，不对正式库执行。

`verify-postgres-sop-create.ts`：同样显式启用 `SCM_ALLOW_MUTATING_PG_CONTRACT=1`，仅允许已迁移的loopback `scm_contract_*`。验证周期同键并发、异参拒绝、提交中GET等待、换计划后原意恢复及身份撤销，5场景中4项实际锁等待。保留合成账号、计划版本、2个远期合成周期与审计，不签认、不冻结、不改库存；不能对正式库执行。

### 产能依据当前权限并发验证

`verify-postgres-capacity-authority.ts`：手动 `SCM_ALLOW_MUTATING_PG_CONTRACT=1 DATABASE_URL=<隔离库> node --import tsx scripts/verify-postgres-capacity-authority.ts`，仅已迁移的loopback `scm_contract_*`。6项实际锁等待覆盖撤角色与保存双向竞争、同请求复用原审计、会话失效与重放，以及只读GET等待原保存和撤权后拒绝GET；核对仅1条产能审计、待办/源告警和库存不变。保留唯一合成账号/商品/待办及审计，不下单、不锁产能，不对正式库执行，不代替真实协议/UAT。

### 待办当前身份并发验证

`verify-postgres-todo-authority.ts`：同样显式设置`SCM_ALLOW_MUTATING_PG_CONTRACT=1`，仅已迁移loopback `scm_contract_*`，三连接/提交屏障。9场景实际锁等待覆盖停用先完成后创建/修改/跟进/历史/原回执拒绝，状态/跟进先提交后才停用，同键跟进复用，以及原回执等待新跟进实际提交后返回原记录。保留唯一合成账号、待办及create/update/两条不同请求follow_up四审计；不关闭真实来源、不发消息、不写库存，不代替负责人/全部范围并发或真实业务UAT。

### 手工待办创建并发验证

`verify-postgres-todo-create.ts`：显式设置`SCM_ALLOW_MUTATING_PG_CONTRACT=1`，仅已迁移0070的loopback `scm_contract_*`；三连接/提交屏障验证6场景，其中5项实际Lock等待。覆盖同请求单任务/单审计、GET等待创建提交、相同内容新键独立创建、同键异意409、停用后GET/重放拒绝及直接重复审计23505。保留唯一合成账号、3条手工任务和创建审计；不写库存/来源、不发通知，不代替真实负责人/全部范围竞争或正式UAT。

### 待办状态与改派原回执验证

`verify-postgres-todo-mutation.ts`：显式设置`SCM_ALLOW_MUTATING_PG_CONTRACT=1`，仅已迁移0071的loopback `scm_contract_*`；三连接/提交屏障验证7场景、6次真实Lock等待。覆盖同键完成一次、重开后旧完成重放不再改变任务、GET等待提交、不同新键旧版本冲突、当前身份停用后的回执/重放拒绝及直接重复审计23505。保留唯一合成账号与3条手工任务及原回执；不写库存/来源、不发通知。界面跨刷新恢复已有[独立验收](../docs/engineering/待办原操作持久恢复与紧凑确认验收-2026-09-13.md)，分页人员与明确改派见[后续验收](../docs/engineering/待办人员搜索与紧凑改派验收-2026-09-13.md)；本PG脚本不代替这些浏览器证据或正式UAT。

### 仓库执行身份与过账并发验证

`verify-postgres-warehouse-identity.ts`：显式设置`SCM_ALLOW_MUTATING_PG_CONTRACT=1`，仅已迁移的loopback `scm_contract_*`，不加载环境文件。三连接/提交屏障验证4项实际锁等待：改为快照仓后拒绝过账、委外改普通仓后拒绝负库存、过账先提交后拒绝改厂、未过账草稿先提交后拒绝改厂。核对1条合成库存流水、2条仓库审计以及告警/通知不变；保留合成夹具和证据，不在正式库执行，不代替发布门或真实业务验收。

`verify-postgres-matflow-warehouse.ts`：相同显式opt-in与loopback `scm_contract_*`保护，不读环境文件。4项真实锁等待验证：FL建单等待改厂后重查拒绝、FL草稿先落库后拒绝改厂、SH入库等待停用后重查拒绝、SH建单等待JG时不提前持有仓锁。保留合成资料/审计；拒绝路径没有库存流水，告警/通知不变；不是工单预留或正式发布证明。

## 二、历史一次性脚本（2026-07/08 首批数据入库时使用，已被 staging→release 导入管道取代）

保留原因：它们是当时入库方式的证据，不再作为日常操作指引。停dev不等于可安全重跑；必须重新核对输入、目标库、授权、幂等与审计边界，先在隔离副本验证，不能对正式库照抄执行。
不要从这里复制逻辑到新代码——导入一律走 `src/server/import/*` 与放行引擎。

| 脚本 | 当时用途 | 最后改动 |
|---|---|---|
| `load-transit.ts` | 在途进度表全量入库（staging → 在途参考放行 + 起订量放行） | 2026-07-24 |
| `load-demand.ts` | 需求达成表入库 | 2026-07-24 |
| `load-pallet.ts` | 货盘表入库 | 2026-07-24 |
| `load-npd-stock.ts` | NPD 三件套 + 总库存汇总入库与核对 | 2026-08-10 |
| `release-sku-params.ts` | sku_leadtime staging → sku_params | 2026-07-24 |
| `claim-brands.ts` | 品牌别名认领 | 2026-07-24 |
| `peek-fee-blocks.ts` | 费用行放行阻塞探查 | 2026-07-24 |
| `verify-three-files.ts` | 三文件入库核验（hash×行数×重复×消费方） | 2026-07-27 |

引用审计覆盖package/CI/hooks/ops/docs/src/tests、动态注册/文件路径拼装及Git历史。搜索零命中仅是候选，不证明无人调用。删除须记录替代入口、保留义务、受影响调用者和验证；没有新证据时保留，不因目录整齐而退役兼容入口。

## 三、生成物与恢复

`.artifacts`、交付证据、冻结包和迁移回执保留；`tmp`可能含输入/证据，不作为通用缓存删。数据库、uploads、备份、共享node_modules、未知自定义`.next-*`也不在清理范围。`.cache-cleanup-trash`是本机可恢复隔离区，不进Git；移存不释放磁盘，后续永久删除需另外核对。恢复前停对应进程，确认原路径不存在，再把该批次的单个目录移回；不得覆盖新生成缓存。lsof检查不能代替所有者持续停机，禁止边构建边清理。
