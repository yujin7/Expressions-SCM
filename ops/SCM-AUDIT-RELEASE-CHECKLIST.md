# SCM 独立审计整改发布清单

适用候选：记录发布时的 commit、分支、工作区状态、构建产物/镜像摘要、目标数据库与配置版本，以及验证时间。`e5a69c8` 只是这份清单的历史整改起点，不代表当前候选或已部署版本。

2026-09-06 按当前代码修正迁移与连接器说明。正式发布证据须来自同一冻结候选；`npm run check:release` 要求干净且验证期间不变的候选，缺少 live 验证或任一门失败均为 `NOT READY`。共享工作区的未提交候选与隔离测试结果应单列，不得冒充已提交、已发布或业务 UAT 完成。

## 1. 发布责任与停止条件

发布前必须填写：

| 责任 | 姓名 | 联系方式 |
|---|---|---|
| 发布负责人 |  |  |
| 数据库备份/恢复负责人 |  |  |
| 库存与批次业务验收人 |  |  |
| 安全与账号验收人 |  |  |
| 回滚决策人 |  |  |

任一条件触发即停止发布；涉及批次过账风险时，另由有权限的负责人按已批准应急方案把 `batch_posting_enabled` 恢复为 `0`。关闭批次闸门不能替代停止发布、故障修复或回滚：

- `/api/health` 非 200、`ok` 不为 true、`drift:true`、迁移账本无法识别（如 `applied < 0`），或迁移数/候选版本不一致；
- 任一库存过账 500、重复过账、负库存越界或 SKU×仓总量不平；
- 批次余额合计与 SKU×仓余额出现无法解释的差异；
- 非授权角色看到采购价、成本、银行账户、税率或结算金额；
- smoke、页面/API 扫描出现非预期 500；
- 无可验证备份，或恢复演练失败。
- 已有应用的旧镜像无法确定、保存或验证；部署脚本在构建前拒绝，不能把Docker查询失败解释成首次部署。
  停止容器也包含在保护范围，多个容器必须先核对目标。`SCM_INITIAL_DEPLOY=1`仅供明确全新空环境，无应用容器
  只是必要条件，不证明已有数据库/附件为空；已有应用时脚本拒绝该标记。回滚标签为`rollback-image-<旧镜像完整摘要>`，
  不使用新源码HEAD命名；保护原镜像不等于可逆迁移，数据库恢复方案另行签核。

## 2. dev/PGlite 恢复

1. 用 `lsof -nP -iTCP -sTCP:LISTEN` 定位唯一写者及端口归属。
2. 只由进程所有者优雅停止；禁止全机 `pkill`，禁止并发打开 `.data/dev`。
3. `npm run db:backup`。脚本必须拒绝任何外置 writer lock 或打开中的数据文件。
4. `npm run db:restore-drill`，确认 `ok:true`、`counts._migrations === migrationFiles`。
5. 真恢复时运行：

   ```bash
   npm run db:restore -- /absolute/path/dev_YYYYMMDDHHMMSS.tgz
   ```

6. 原库会保留为 `.data/dev.pre-restore-<timestamp>`；验证完成前不得删除。
7. 不使用 `pg_resetwal` 作为常规恢复方案。

## 3. 迁移门禁

### PGlite

1. 停止唯一 dev writer。
2. 核对候选与目标数据目录后启动服务器；PGlite 会按文件名顺序应用该候选 `drizzle/*.sql` 中尚未登记到 `_migrations` 的迁移，不再仅指历史的 0019/0020。不可用启动别的会话/目录来代替目标迁移。
3. 核对目标 origin；以下 3000 仅为端口示例，须替换为已确认的实际目标：

   ```bash
   curl -fsS http://127.0.0.1:3000/api/health
   ```

4. 必须满足 HTTP 200、`ok:true`、`dbOk:true`、`migrationState:"current"`、`drift:false`、`migrationFiles > 0`、`migrationFiles === applied`，并与该候选的迁移清单相符。计数相等只是必要条件，不证明 SQL 内容、约束或业务数据完全一致。

### PostgreSQL

1. 先完成数据库备份与恢复演练。
2. 在发布窗口对明确的目标运行该候选 `npm run db:migrate`（`drizzle-kit migrate`），核对 `drizzle/meta/_journal.json`、SQL 文件和 `drizzle.__drizzle_migrations`，不只看退出码。Compose 发布使用同一候选的 `migrate` 服务；按 `ops/deploy.sh` 同时构建 `app` 与 `migrate`，构建前先保存并验证当前运行镜像的回滚点。
3. 再重启应用并核对 `/api/health`：2026-09-06 候选将公开接口和管理页收口到同一只读判定，先 `SELECT 1` 探活，再核对迁移账本。只有明确的缺表（SQLSTATE `42P01`）才接受另一账本；无账本、两个账本同时存在、读取错误或非法计数均为 `unknown`，不可挑选碰巧匹配的一张或直接删表，须人工核对目标与账本归属。`behind` / `ahead` 均为已确认数量漂移（`drift:true`）；`unknown` 不冒称已确认漂移，但同样返回 HTTP 503 / `ok:false`。文件清单不可读/为空亦不能就绪。`dbOk:true` 只表示连接探活通过，不等于 schema 已就绪。两种模式均须满足上列条件；上线前须以实际候选镜像验证，不能把本说明当作已部署证据。
4. 在明确授权的 CI/staging PostgreSQL 目标执行 `npm run check:postgres`：该脚本迁移后只读核对 SQL/journal 集合、迁移时间戳与哈希，以及已登记的关键列、约束、索引和仅追加守卫。它不自动迁移，也不是全量 schema 等价或业务 UAT 证明；结果须绑定候选与目标环境。
5. 涉及事务/并发的真实 PG 契约另在显式隔离的一次性测试库验证；不得把需要合成写入的契约当作生产只读检查。应用镜像回滚不撤销已执行迁移，数据库恢复/前滚方案仍须数据库负责人确认。

## 4. 账号门禁

- 轮换所有既有 seed 账号口令；
- 需要初始化账号时显式设置不少于 12 位的 `SEED_ADMIN_PASSWORD`；seed 跳过已存在账号，重跑 seed 不会轮换其口令。既有账号须走受控重置/轮换流程，不把新 seed 配置当作旧口令已更新的证据；
- smoke 必须显式设置统一的 `SMOKE_PASSWORD`，或同时设置
  `SMOKE_ADMIN_PASSWORD` 与 `SMOKE_ROLE_PASSWORD`；质量账号使用独立口令时再设置
  `SMOKE_QUALITY_PASSWORD`，不得使用公开默认口令；
- 验证 admin、ops、purchasing、warehouse、quality、pmc、finance 七类账号；
- 用 ops/warehouse 核对采购价、成本、银行账户、税率和结算金额脱敏。

## 5. 批次数据迁移与 UAT

启用前导出并签字确认：

- `batchId=null` 的实时余额行数、SKU 数、仓库数和数量合计；
- 已分批余额按 SKU×仓聚合后与总余额的差异；
- 无效期、已过期、有生产日期但无效期的在库批次；
- 需要盘点补录批次身份的库存清单。

业务 UAT 至少覆盖：

| 场景 | 必验结果 |
|---|---|
| PO→SH→QC→入库 | 批次身份写入；合格+让步入可用，不合格不入 |
| 分次收货 | 累计收货正确，不提前完成整单 |
| FL 自动分配 | 按 FEFO；过期批次不参与；不足则整单阻断 |
| 显式指定批次 | SKU、仓库、效期与余额均校验 |
| TL/CT | 原批次身份保留，数量与方向正确 |
| 手工出库/调拨 | 批次拆行稳定，目标仓继承批次 |
| 并发出库 | 不超扣、不重复过账、失败整笔回滚 |
| 历史无批次余额 | 回落行为有提示且总量不丢 |

全部签字后才可由管理员将 `batch_posting_enabled` 从 `0` 改为 `1`。首周每天核对：

- 批次余额合计；
- SKU×仓总余额；
- 过账失败、负库存、重复幂等命中；
- 过期批次被拦截次数。

发现不可解释差异时先关闸；已过账单据只能红字冲销，不直接改流水或余额。

## 6. HTTP 与界面门禁

`ops/deploy.sh`的就绪门在选定Compose配置的`app`容器内检查HTTP、数据库与迁移状态，避免误查宿主机另一实例。
它只证明容器内部就绪，不能代替以下真实外部入口、代理、TLS、账号、权限和业务路径验证。

2026-09-07起，`/api/health.build`报告构建时固化的完整提交与来源状态；仅`git-clean`或受控Docker
`build-arg`可匹配发布候选，`git-dirty`/`unknown`不可代替精确版本。公开字段不含路径、分支或凭据。
`ops/deploy.sh`从干净仓库根目录取HEAD，构建前后复核，并给app/migrate传同一构建参数；健康门核对该HEAD。
`check:release`强制将自己的锚定HEAD传给冒烟，不接受调用环境把期望版本换成旧提交。
单独执行冒烟时也应显式提供`SCM_EXPECTED_REVISION`（完整40位提交）；不匹配时在账号请求前停止。
该字段证明版本声明与候选一致，不是密码学镜像签名，也不证明配置、数据库、外部入口或业务UAT一致。
无Git源码导出默认仍可构建但版本unknown；不能随手传旧SHA把未核对的目录当作已验收版本。

```bash
SMOKE_BASE=https://staging.example \
SCM_EXPECTED_REVISION='<完整40位已验收提交>' \
SMOKE_ADMIN_PASSWORD='<admin-staging-password>' \
SMOKE_ROLE_PASSWORD='<role-staging-password>' \
SMOKE_QUALITY_PASSWORD='<quality-staging-password>' \
node --import tsx scripts/smoke-e2e.ts
```

随后按 `.claude/skills/release-sweep/SKILL.md` 对同一候选执行 `npm run check:release`；仅在已明确目标与测试授权时设置 `SCM_VERIFY_LIVE=1`。该门串行检查运维契约、真实 PG 元数据、lint、三套 TypeScript、全量测试、生产构建与 live smoke；live 缺失或 smoke 中有跳过项不能取得 `READY`。另外保留以下浏览器与业务验收，脚本退出成功不能替代它们：

- 全业务页面扫描；
- 全静态 API GET 扫描，非预期 500 必须为零；
- 表格容器/表头水合指纹；
- 有真实单号的动态打印页；
- admin 与非价格角色的权限/脱敏对照。

## 7. 外部连接器

- 当前注册表中聚水潭、简道云、用友和飞书的 `implementation` 为 `ready`，这是代码能力，不是可修改为 `contract_only` 的业务开关。真实凭据、逐接口授权、字段契约、适用的限流/分页/游标/重放及沙箱 UAT 未完成前，不得宣称该范围业务就绪；未获批能力不得启用。
- 按实际能力分别核对 `configured`、启用状态、精确契约选择、作用域身份清理与当前 Live UAT 证据。`configurationReady` / `operational` 是注册表派生状态，不应手工绕过；证据须绑定当前应用/契约/目标等适用范围且未过期，范围变化后重新验收。最新逐流运行与实际数据覆盖仍需另外核对，配置门通过不证明本轮取数成功。
- 简道云全量、滚动窗口与空观察分别验收；逐记录删除确认不能绕过完整性守卫，一条流失败不等于整连接器停摆。保税订单现为无拉取时间窗的全量归档观察，不得用报表的 7/30 天统计窗口推断当前数据新鲜。
- 用友现有八条契约仅只读观察，不提供凭证/结算回写；仍须完成 D2 成本口径及目标组织、账簿、币种、税、期间和映射签核。等待授权、部分读取、读取完成与未知/矛盾结果分开验收，不能把技术运行结束或 token 成功当作业务成功；结构漂移阻断和下游 UAT 另行核对。
- 飞书先核对实际选路 `activeAuthPath`（webhook 或 app_bot），在已授权目标群发送测试告警并确认去重，登记该路径的真实投递/UAT 证据。仅配置 `FEISHU_WEBHOOK_URL` 不足以证明实际走 webhook；app_bot 还须同次只读权限证据、最小权限复核和当前应用/目标群绑定。不得把测试消息发送到未授权群。
- “代码存在”“配置就绪”“单次读取/投递完成”“身份与业务口径已验收”不得合并。具体只读/写入边界与历史探针见 `docs/integrations/EXTERNAL-SYSTEMS.md`；历史成功不能替代本次验证。

## 8. 最终签字

| 门禁 | 证据链接/输出 | 结果 | 签字 |
|---|---|---|---|
| commit/构建/测试 |  |  |  |
| 备份与恢复演练 |  |  |  |
| 迁移与 health |  |  |  |
| HTTP/页面/API |  |  |  |
| 权限与脱敏 |  |  |  |
| 批次迁移/UAT |  |  |  |
| 连接器 |  |  |  |
| 回滚负责人确认 |  |  |  |
