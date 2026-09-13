# scripts/ 说明

目录里有两类脚本，按「是否被 package.json / 文档 / 代码引用」区分。**新增脚本请归到对应类别并在本文登记**。

## 一、现行入口（被 `package.json` 或文档引用）

| 用途 | 脚本 | 入口 |
|---|---|---|
| 门禁 | `verify-fast.ts` `verify-release.ts` `verify-ops.ts` `verify-postgres*.ts` | `npm run check:*` |
| 缓存清理 | `clean-caches.ts`，经`scm.ts`亦可调用 | 默认预览；`--all`仅扩大预览。先停已确认owner，`--apply --target .next-dev`等逐项移到`.cache-cleanup-trash/<批次>/`，不自动删除；占用或检查失败即拒绝 |
| PostgreSQL 复核原子性 | `verify-postgres-review-atomicity.ts` | `npm run check:postgres:review-atomicity`；仅一次性本机 `scm_contract_*` 库，须 `SCM_ALLOW_MUTATING_PG_CONTRACT=1`；先运行迁移。保留合成记录与审计，不用于生产库或发布后清理 |
| PostgreSQL 调拨费用/加工计划并发 | `verify-postgres-transfer-fees.ts`、`verify-postgres-jg-plan.ts` | CI现有PG门禁自动运行；手动用`node --import tsx scripts/<对应脚本>`。先迁移隔离loopback `scm_contract_*` 库，显式`SCM_ALLOW_MUTATING_PG_CONTRACT=1`、`SCM_RUN_JOBS=0`；3项费用锁与7项JG锁证明，保留合成记录，不用于生产库 |
| PostgreSQL 加工费申请/结算并发 | `verify-postgres-pc-write.ts` | 同一隔离PG门自动运行；相同显式loopback/一次性库守卫。8项真实多连接竞争：重复申请、审批后取现价、审批重放、历史重复申请冲突、停用身份、结算创建/提交及财务冻结；保留合成记录与审计，不在生产执行 |
| PostgreSQL 发退料/结算/入库核对与工单生成并发 | `verify-postgres-settlement-basis.ts` | 手动 `SCM_ALLOW_MUTATING_PG_CONTRACT=1 DATABASE_URL=<隔离库> node --import tsx scripts/verify-postgres-settlement-basis.ts`；只允许loopback `scm_contract_*`。49项真实PG验证：收发/结算冻结、入库估算、批次资格、同SH恢复/不同SH共用WO锁/采购来源改挂、初次生成重放及与自动批次双向竞争；WO创建的工厂/成品/BOM/身份竞争、重复提交/批准、停用提交、撤审批资格，撤回vs批准、停用vs撤回、撤管理角色vs短关，以及同键同意图/不同意图建单竞争、核对回执vs撤权；PO撤角色vs短关、完成vs短关、重复短关单次审计；同PO并发R1复用PC、撤回vs批准、撤采购角色vs代录、关闭vs生成链接。测试临时启用建批开关后恢复原值/缺省，保留合成业务数据，不在生产执行，不代替完整发布门 |
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
