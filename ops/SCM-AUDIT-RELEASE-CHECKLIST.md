# SCM 独立审计整改发布清单

适用候选：以发布时 `git rev-parse HEAD` 为准。当前整改基线从 `e5a69c8` 开始。

## 1. 发布责任与停止条件

发布前必须填写：

| 责任 | 姓名 | 联系方式 |
|---|---|---|
| 发布负责人 |  |  |
| 数据库备份/恢复负责人 |  |  |
| 库存与批次业务验收人 |  |  |
| 安全与账号验收人 |  |  |
| 回滚决策人 |  |  |

任一条件触发即停止发布或把 `batch_posting_enabled` 恢复为 `0`：

- `/api/health` 非 200、`drift:true`，或迁移数不一致；
- 任一库存过账 500、重复过账、负库存越界或 SKU×仓总量不平；
- 批次余额合计与 SKU×仓余额出现无法解释的差异；
- 非授权角色看到采购价、成本、银行账户、税率或结算金额；
- smoke、页面/API 扫描出现非预期 500；
- 无可验证备份，或恢复演练失败。

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
2. 启动服务器，让 PGlite 应用 `drizzle/0019_*`、`drizzle/0020_*`。
3. 核对：

   ```bash
   curl -fsS http://127.0.0.1:3000/api/health
   ```

4. 必须满足 `ok:true`、`drift:false`、`migrationFiles === applied`。

### PostgreSQL

1. 先完成数据库备份与恢复演练。
2. 在发布窗口单独运行 `npm run db:migrate`，以退出码和迁移账本为准。
3. 再滚动重启应用；PostgreSQL 模式下不能只靠 `/api/health` 判断迁移漂移。

## 4. 账号门禁

- 轮换所有既有 seed 账号口令；
- 环境中显式设置不少于 12 位的 `SEED_ADMIN_PASSWORD`；
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

```bash
SMOKE_BASE=https://staging.example \
SMOKE_ADMIN_PASSWORD='<admin-staging-password>' \
SMOKE_ROLE_PASSWORD='<role-staging-password>' \
SMOKE_QUALITY_PASSWORD='<quality-staging-password>' \
node --import tsx scripts/smoke-e2e.ts
```

随后按 `.claude/skills/release-sweep/SKILL.md` 执行：

- 全业务页面扫描；
- 全静态 API GET 扫描，非预期 500 必须为零；
- 表格容器/表头水合指纹；
- 有真实单号的动态打印页；
- admin 与非价格角色的权限/脱敏对照。

## 7. 外部连接器

- 聚水潭和用友在真实凭据、字段契约、限流、分页、增量游标、重放和沙箱 UAT
  完成前保持 `contract_only`；
- 用友还必须完成 D2 成本口径签字；
- 飞书配置 `FEISHU_WEBHOOK_URL` 后发送测试告警并确认去重；
- “代码存在”“配置存在”“实际运行成功”三种状态不得合并。

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
