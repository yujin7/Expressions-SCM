---
name: schema-change
description: Change this project's Drizzle schema and migrations safely. Use for any edit under src/db/schema, generated migration, column or constraint change, drift or health mismatch, schema-related 500, backfill decision, or direct .data/dev script. Use caliber-change for calculation semantics and integrate-supply-chain-data for imports into unchanged schemas.
---

> **ARCHIVE ONLY** — Historical evidence, not executable guidance. Do not run commands or follow
> routing in this file; use [the quarantine index](README.md) and current `.claude/skills/`.

# 改完 schema，重启进程

> 下文迁移数、调用点数、表/约束数量、行号和性能数是历史审计样本。迁移流程与失败模式
> 是 durable contract；当前基线必须从 `drizzle/*.sql`、schema、health、目标数据库和本次
> candidate 动态取得。

给 `schema.ts` 加一个字段、忘了重启 dev server——挂掉的不是「用到新列的那个页面」，
是那张表的**每一次读取**。drizzle 的无列名 `db.select().from(t)` 会展开 schema 里声明的
全部列，本仓这么写的地方有 **127 处**（`src/server/core/dto.ts:83`、`src/server/docflow/approval.ts:49`、
`src/server/modules/settlement/js.ts:123` …）。实测 DB 落后一个迁移时，`select id,name` 照常返回，
`db.select().from()` 当场 `Failed query: select "id","name","new_col" from "demo"`。

dev/PGlite 的哨兵是 `/api/health`：正常时 `migrationFiles === applied` 且 `drift:false`，
漂移时 `drift:true` + HTTP 503 + hint「schema 漂移：请重启 dev server」（`src/app/api/health/route.ts:10-23`）。

---

## 迁移在哪（不在 src/db/migrations，那个目录不存在）

| 东西 | 位置 |
|---|---|
| 迁移 SQL | 仓库根 `drizzle/`，`drizzle.config.ts:6 out:"./drizzle"` |
| schema 入口 | `src/db/schema/index.ts`，按域拆 10 个文件（enums/masters/bom/docs/inventory/system/dimensions/refs/npd/rollup） |
| 命名 | drizzle-kit 自动生成 `NNNN_随机代号.sql`；当前范围必须从 `drizzle/*.sql` 动态读取 |
| 账本（prod） | `drizzle/meta/_journal.json`（version 7） |
| 账本（dev） | 手写表 `_migrations(name text PRIMARY KEY, applied_at)`，`src/db/index.ts:32` |

---

## 标准流程

```bash
npx drizzle-kit generate                       # 改完 src/db/schema/<域>.ts 后产出 drizzle/00NN_xxx.sql
# 读一遍生成的 SQL —— 下面所有事故的共同前提是没读
lsof -nP -iTCP -sTCP:LISTEN                    # 确认自己启动的 dev PID/端口
kill <owned-dev-pid>                            # 只停自己拥有的进程，禁止全机 pkill
npm run dev                                     # 重新启动后才应用新迁移
curl -s http://127.0.0.1:3000/api/health       # 验收：三个数必须对上
```

## 判定表

| 你看到的 | 结论 | 动作 |
|---|---|---|
| `drift:true` / 503 / `applied < migrationFiles` | DB 落后于 `drizzle/` 的文件数 | 重启进程，**不要改代码** |
| `Failed query: select "…","new_col" from "x"` | 同上，且爆炸半径是整张表 | 同上 |
| `applied: -2` | 非 PGlite（postgres）模式，此端点**检测不到漂移** | 以 `drizzle-kit migrate` 的退出码为准 |
| 重启后 applied 仍不涨，且每个请求都同一个错 | `createDb()` reject 被永久缓存 | 看进程首条报错，修 SQL 或清 `.data/dev` 重来 |
| 脚本打印「已更新 N 行」但页面没变 | dev server 没停，写入被它落盘覆盖 | 停 server 再跑脚本 |

## 重启为什么是唯一手段

`src/db/index.ts:14` 把实例挂在 `globalThis`（`__scmDb`），`:49` 是 `g.__scmDb ??= createDb()`；
而读迁移目录、逐文件 apply 的整个循环在 `createDb()` 内部（`:33-44`）。
HMR 只换路由模块，`globalThis` 上的 PGlite 实例和那个 promise 不重建 → 新 `.sql` 永远不会被应用。

## 迁移失败会拖死整个应用

`src/db/index.ts:35-44`：每个文件按 `--> statement-breakpoint` 切开后逐条 `client.exec(s)`，
**没有事务**，全部成功才 `INSERT INTO _migrations`。中途失败 → 已执行的 DDL 留在库里、文件未记账，
下次启动从头重放必撞 `already exists`。更糟的是 `:49` 缓存的是 promise 本身：reject 之后
`??=` 不会重试，此后每个请求都拿到同一个失败——重启前整个应用不可用。
所以手写 SQL 的每条语句要么可重放，要么就准备好清 `.data/dev`。

## 写迁移的四条硬约束（都有先例）

1. **`ADD COLUMN … NOT NULL` 必须带 `DEFAULT`**。全部 60 处 ADD COLUMN 中 15 处 NOT NULL，
   无一例外都带 DEFAULT（grep「NOT NULL 且不含 DEFAULT」结果为空）。
2. **收紧 UNIQUE 必须在同一个迁移里先 backfill**。`drizzle/0007_vengeful_sunfire.sql:2-19` 是
   当时迁移集里少数有手写 SQL 的一个：加 `uq_batch_stock_key` 之前，先用
   `SUM(qty) OVER (PARTITION BY sku_id, warehouse_id, stocktake_date, prod_date, expiry_date, batch_no)`
   把同自然键多行的 qty 合并到最早一行，再 `DELETE … WHERE rn > 1`，最后才 `ADD CONSTRAINT`，
   并用三行中文注释解释为什么合并在口径内安全。少了 backfill，ADD CONSTRAINT 直接失败 → 见上一节。
3. **可空列进 UNIQUE 必须 `NULLS NOT DISTINCT`**。用在 4 个键上：`uq_balance_key`
   （`src/db/schema/inventory.ts:42`）、`uq_batch_stock_key`（`refs.ts:39`）、
   `uq_sales_velocity`（`dimensions.ts:105`）、`uq_price_sku_sup_chan_date`（`masters.ts:125`）。
   `batchId` / `channelId` 可空，普通 UNIQUE 在 PG 里放行无限多行 NULL，余额表会长出重复行，
   幂等直接失效。`tests/schema.smoke.test.ts:6-18` 专门断言（同 sku+仓、batchId 皆 null 的第二行必须被拒）。
4. **不要无迁移方案地 DROP**。以下数量是历史审计样本，不是当前基线：当时 0 处 DROP COLUMN、
   0 处 DROP TABLE；4 处 DROP CONSTRAINT
   （0003 / 0009 / 0012 / 0016）每一处都在同一文件内立刻以**更宽的键**加回，例如 0003 给 approvals
   加 `cycle`（DEFAULT 0 NOT NULL）后把 `uq_approval_idem` 从 4 列换成 5 列。

## 动 UNIQUE 就是在动幂等

| 键 | 定义 | 谁靠它 |
|---|---|---|
| `uq_ledger_source(source_doc_type,…,warehouse_id)` | `src/db/schema/inventory.ts:24`「防双重过账（R10 硬约束）」 | `src/server/posting/post.ts:5-6` 写明是「并发硬兜底」 |
| `uq_balance_key(sku,warehouse,batch)` | `inventory.ts:42`，nullsNotDistinct | `post.ts:140` `.onConflictDoUpdate({ set:{ qty: qty + excluded.qty }})` |
| `uq_approval_idem(doc_type,doc_id,node,action,cycle)` | `src/db/schema/system.ts:20` | `src/server/docflow/approval.ts:91-107` `.onConflictDoNothing`，插 0 行即 `idempotent:true` |

全仓规模：迁移里 52 处 UNIQUE 约束子句，schema 里 37 处 `unique(` 声明。
放宽或删掉其中任何一个 = 双重过账 / 重复审批，而且不报错。

## dev 与 prod 是两套账本

dev/PGlite 的文件清单来自 `readdirSync(drizzle/).filter(.sql).sort()`（`src/db/index.ts:34`）——
**纯字典序，不读 `_journal.json`**；prod 走 `npx drizzle-kit migrate`（`ops/deploy.sh:8`），用 drizzle 自己的账本。
后果：手工丢进 `drizzle/` 的 `.sql` 在 dev 和测试里会被应用、在 prod 不会。要么全程 `drizzle-kit generate`，要么两边都手工登记。
prod 侧迁移是**发布窗口内的独立门禁步骤**（`ops/deploy.sh:2` 注释「迁移=门禁步骤，非启动时自动跑」），
先 migrate 再滚动重启（`:8` → `:10`）。

## 脚本与 dev server 不能同时开——不是报错，是骗你

实测（PGlite 0.3.x）：进程 A 常驻打开 `.data/dev` 看到 `[1]`；进程 B 打开同一目录，
`INSERT 2` 成功返回 `[1,2]` 并优雅关闭；A 全程只看到 `[1]`，退出落盘后第三个进程重开读到 `[1,99]`——
**B 写的那行被整个覆盖，双方都没有拿到任何锁错误**。全部 20 个 `scripts/*.ts` 默认
`process.env.DATABASE_URL ??= "pglite:.data/dev"`（`scripts/db-peek.ts:7`、`scripts/rt4-repair.ts:29`），
即默认直连同一个目录。所以跑脚本前先用 `lsof` 找到自己启动且占用目标端口的 PID，
再精确 `kill <owned-dev-pid>`；禁止全机 `pkill`。

## 每加一个迁移文件，测试就整体变慢一次

`tests/helpers/db.ts:12-25`：每次 `createTestDb()` 起一个内存 PGlite，并把 `drizzle/` 下全部 `.sql`
依序 exec（没有 `_migrations` 表，无条件全量重放）。112 个测试文件里 69 个用 `createTestDb`，
历史采样中，机器 18 核时多个测试进程会同时重放全部迁移。`vitest.config.ts:8-11` 的 `hookTimeout: 30000`
就是为此而设，**不要调小**。参考量级：单跑 `npx vitest run tests/schema.smoke.test.ts` = 513ms。

## 报告口径

说「迁移已应用」之前，贴 `/api/health` 的实际三个数（`migrationFiles` / `applied` / `drift`），
不贴等于没验。并且记住这句限定：`applied === -2` 时该端点恒 `ok:true`
（`src/app/api/health/route.ts:16-19`，`drift = applied >= 0 && applied < files`），
而 `ops/deploy.sh:50` 的部署门禁正是 `curl … | grep -q '"ok":true'`，`scripts/smoke-e2e.ts:99` 也显式放行 `-2`。
**它是 dev 专用哨兵；生产 postgres 路径上它检测不到任何 schema 漂移。**
