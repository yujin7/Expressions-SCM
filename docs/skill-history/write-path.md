---
name: write-path
description: Build or modify database write paths through this project's mandatory posting, numbering, fresh-authorization, audit, error, transaction, precision, and idempotency boundaries. Use for services, write APIs, document flows, posting events, or application-owned inserts, updates, and deletes. Do not use for migration-owned schema backfills; use schema-change. Use redteam-pass after implementation.
---

> **ARCHIVE ONLY** — Historical evidence, not executable guidance. Do not run commands or follow
> routing in this file; use [the quarantine index](README.md) and current `.claude/skills/`.

# 没有唯一入口的规则，等于没写

> 下文调用点数量、行号与“今天”记录的是 2026-07-23 至 2026-07-25 的事故证据。
> 唯一写入边界与事务原则是 durable contract；具体调用者、薄弱点和计数必须在当前 revision
> 用 `rg`、schema 约束和对抗测试重新确认。

MVP 1.0 基线（commit 2d77242，2026-07-23）一次性交付 39 张表、四大引擎、全套主数据模块和种子数据。`audit_logs` 表在 `drizzle/0000_wandering_randall_flagg.sql:607`
就建好了，规格 §8 白纸黑字写着「审计全留痕」——而 `src/server/core/audit.ts` 当天**根本不存在**，全库调用点为零。是红队第二轮揪出来的（commit 1103347，同日，
BLOCKER×3 之一），同轮还揪出 `maskSensitive` 定义了但从未被调用。今天代码里 97 处 `writeAudit`、41 个文件——**那是补出来的，不是设计出来的。**

教训不在规则不够多，而在于：**一条只写在规格里、没有唯一入口 + 没有护栏测试的规则，等于没写。**

---

## 零、先写最小事务契约

动代码前先写清：

- 业务触发、授权角色、fresh authorization 与 maker-checker；
- 源单、版本、允许的前态与目标态；
- 不可变幂等键和数据库唯一边界；
- 数量、单位、货权、仓、批次、效期、质量状态、金额、币种、税与业务时间；
- 同一事务内的单据、流水、余额、审计和 outbox 效果；
- 超时重放、并发、部分失败、驳回重提与红字/补偿路径；
- 可复核的守恒式、对账规则和失败信号。

把效果写成 `guard → state transition → movement/audit/outbox → invariant`。两处组件都能写同一
invariant 时先停下来收口 owner。历史数量、调用点和事故清单只作线索；每次变更前用当前
revision 重新验证。

---

## 一、强制入口（动手前先对照）

| 你要写什么 | 唯一入口 | 绕过会错成什么样 |
|---|---|---|
| 库存流水 / 余额 | `post()` — `@/server/posting` | 全 src/ 只有 `post.ts:115`/`:133` 两处裸 insert（全库零 update/delete），第三处就是缺陷：绕过白名单、绕过排序防死锁、绕过幂等预检 |
| 冲销 | `reverse()`（经 `reverseStockDoc`） | 状态机 `state.ts:39-47` 里 `completed:{}`、`void:{}` 是空对象，不存在 approved→pending 逆向边；手改状态=造一条不存在的边 |
| 单据号 | `nextDocNo()` — `docflow/doc-no.ts:27-39` | `MAX(docNo)+1` 并发撞号。全库无此模式，别开先例 |
| 身份 / 角色 | `getFreshSessionUser()` — `core/dto.ts:77-86` | 信 token 里的 roles = 停用账号和降权在 JWT 过期前一直有效（设计动机见 dto.ts:74 注释） |
| 审计 | `writeAudit()` — `core/audit.ts:11-32` | 唯一写入器。不调 = 这次改动在 audit_logs 里不存在 |
| 客户端错误 | `ApiError(4xx)` | 见第三节，裸 Error = 500 + 一行 error_logs |

`post()` 准入守卫在 `post.ts:71-76`（`isRegisteredSource` 不过 → `PostingError UNREGISTERED_SOURCE`）；8 个调用方（inventory/{count,stock-doc}.ts、matflow/{ct,fl,sh,tl}.ts、
settlement/js.ts）无一例外都是 `import { post } from "@/server/posting"`。`getFreshSessionUser` 有两个包装器（`master/common.ts:116-131` guardWrite、`inventory/stock-doc.ts:29-43` guardWarehouseWrite），全库 55 处引用、21 个 API 路由文件。

**注册表是声明式白名单，会先于实现存在也会腐化。** 15 个条目里 2 个不可达：`transit_writeoff`（registry.ts:59-62）除注册表外只剩一个中文标签和一个枚举值；`reversal`（registry.ts:55-58）
永远走不到——stock-doc.ts:211-220 遇到 subtype=reversal 走 `reverse()`，落库命中的是 registry.ts:64-67。**新增注册表条目不会自动获得任何测试**：防旁路测试
`tests/posting/engine.test.ts:171` 硬编码两个 case，不随注册表增删而变。

---

## 二、事务边界：写进事务，展示层补查在事务外

`stock-doc.ts:180-237` 是标准形态，一个 `db.transaction` 包住五步：approveDoc（权限/幂等/乐观锁）→ `writeAudit(tx)` →
`post()`/`reverse()` → approved→in_progress→completed 两跳状态机 → 第二次 `writeAudit(tx)`。任一步失败全量回滚。

负库存的友好文案 `enrichNegativeStock`（:273-300）**刻意放在 catch 块里、事务已回滚之后**，用根连接 `db` 重查 sku/仓库/余额/需求量，
才拼得出「库存不足：<编码 名称>@<仓名>（现有 X，需出 Y）」的 409。在已回滚的事务句柄上查数会炸——展示层补查必须在事务外。

- `writeAudit` 传 `tx` 才原子（今天 56 处传 tx、39 处传根连接 db）；`post()` 自身总是 `db.transaction`（post.ts:78），传 tx 进去时 drizzle 退化成 SAVEPOINT，语义不变（post.ts:63-64）。
- **路由层补审计不原子，别照抄**：14 个 master 路由是 `await createSku(...)`（服务内事务已提交）再 `await auditFromRoute(...)`，
  而 `auditFromRoute`（master/common.ts:138-146）用 `getDbAsync()` 拿的是**新的根连接**。服务崩在中间 = 有数据无审计。新模块把 `writeAudit(tx)` 放进服务事务。

---

## 三、错误类型：裸 Error = 500 + 一行 error_logs

`master/common.ts:31-66`：`ApiError` → 原状态码直出；ZodError/23505 各有分支；**其余一律生成 8 位 errorId + `persistErrorLog()` 落 error_logs（logger.ts:56-76）+ 500「系统错误，请联系管理员」**。

今天 13:44 的 commit b8bc267 修的就是这个，diff 恰好两行：`throw new Error("缺少 sku 参数")` → `throw new ApiError(400, ...)`，
落在 `src/app/api/replenish/projection/route.ts:11` 与 `src/app/api/report/sku-timeline/route.ts:10`。少传一个查询参数，用户看到的是「系统错误，请联系管理员（错误码 xxxxxxxx）」。

**同一缺陷类今天仍有一批活着，入口从「缺参」换成「身份失效」**：`dto.ts:55` `throw new Error("未登录")`、`dto.ts:84` `throw new Error("账号已停用或不存在")` 都是裸 Error。
21 个引用 `getFreshSessionUser` 的路由里 13 个裸调（/api/admin/{health,users,users/[id],params,errors}、/api/outsource/auto-chain/{batch,preview,wo}、
/api/outsource/jg/[id]/{plan,revise-due}、/api/review/feedback、/api/report/{settlement-summary,dashboard}）——被停用的账号点开管理页就是 500 + 错误码 + 一行 error_logs 污染。

```bash
# 新路由是否裸调 getFreshSessionUser
for f in $(/usr/bin/grep -rln getFreshSessionUser src/app/api); do
  /usr/bin/grep -q "未登录或账号已停用\|catch {" "$f" || echo "UNWRAPPED: $f"
done
# 模块层裸 Error 基线：全 src/server/modules 只有 1 处（spu.ts:68，真·不可能状态，兜 500 是对的）
/usr/bin/grep -rn "throw new Error(" src/server/modules --include="*.ts"
```

---

## 四、构造技巧（不知道就撞唯一键 / 撞死锁）

- **同事件多腿用负数 sourceLineId**。`uq_ledger_source` 是 5 列 `(sourceDocType, sourceDocId, sourceLineId, action, warehouseId)`（inventory.ts:24）。
  调拨出仓行 `sourceLineId = l.id`、入仓行 `= -l.id`（stock-doc.ts:157-158，注释明写「保证互异」）；委外收货扣料行 `= -wl.id`（sh.ts:424，wl 是 WO 行，正负分区避免与 SH 行撞号）。
- **余额行必须排序**。`compareLines`（post.ts:56-60，`batchId ?? -1`，NULL 排最前）→ post.ts:94 排序后才插流水（:115）与 upsert 余额（:130，`qty = qty + excluded.qty`）。
  不排序 = 两事务反向持锁 = 死锁。护栏在 `tests/posting/engine.test.ts:193`。
- **幂等键要含轮次**。审批幂等键含 `cycle`=单据版本（approval.ts:81/:98/:104；约束 `system.ts:20 uq_approval_idem` 五列），
  由 `drizzle/0003_simple_sabretooth.sql` 从 4 列迁到 5 列。动机在 approval.ts:71：「驳回→重提→再驳回=新轮次」，不含 cycle 时第二次驳回被静默吃掉。
- **单据号双保险**：`doc_counters` 单语句 `onConflictDoUpdate(lastNo+1).returning()`（主键 `(prefix, bizDate)`）+ 列级 UNIQUE 兜底（docs.ts:13，10 张单据表各一条）。
  需要非日期的单调序列时复用它，别自己写：`master/spu.ts:43-69` 用哨兵 `bizDate="GLOBAL"` 取全局 P 号（含碰撞续取循环）。
- **精度按语义选，不要照抄**。金额 `(14,2)`（18 次）、数量 `(14,4)`（58 次），但**百分比/比率一律不是这两个**：
  损耗率 `bom.ts:36-38` (5,2)、税率 `docs.ts:103` (5,2)、偏差率 `docs.ts:118` (7,2)、交期天数 `rollup.ts:56-59` (8,2)、准时率 `rollup.ts:60` (5,4)。
- **仅追加表不写 update/delete**（`schema/inventory.ts:9` 注释）。纠错走红字：`reverseStockDoc`（stock-doc.ts:302-358）——:310 红字单不可再冲销、:313-318 一单最多一张非作废红字；`canEdit`（state.ts:57）只放行 draft。

---

## 五、已知薄弱处（在它旁边写代码时别当范本）

| 位置 | 真实状态 | 你该怎么办 |
|---|---|---|
| `post.ts:80-91` 幂等预检 | 先查后写：预检键只有 3 列，`uq_ledger_source` 是 5 列，**根本不是同一个键**；:115 是裸 insert 无 `onConflictDoNothing`。真并发（READ COMMITTED）下 T2 预检看不到 T1 未提交行 → 抛 23505 → 被映射成 409「编码或关键字段已存在，请修改后重试」这句与库存毫不相干的文案 | 抄 `approval.ts:92-107`：先查快路径 + `onConflictDoNothing` 兜底，才能优雅降级为 idempotent |
| `post.ts:165-191` 防二次冲销 | 预检用 `db` 不是 `tx`，且跑在 `db.transaction` 之前；`uq_ledger_source` 抓不到它——两张红字单冲同一原单时 sourceDocId 是不同的红字单 id。防线全靠把原单身份编码进 action 字符串（:172），代码自己承认只是纵深防御（:170-171） | 新的冲销类操作，主防线放模块层（stock-doc.ts:313-318 那样给 409），别指望唯一约束 |
| 8 个 modules 文件 | 有 insert/update/delete、零 writeAudit：master/{category,supplier,warehouse,sku}.ts（审计在路由层，非原子）+ outsource/leftover.ts、inventory/batch-trace.ts、matflow/common-notes.ts、dimension/resolver.ts（后四个**完全没有审计**） | 改到这些文件就顺手补 `writeAudit(tx)` |

```bash
# 写库但无审计的模块文件
for f in $(/usr/bin/grep -rl "\.insert(\|\.update(\|\.delete(" src/server/modules --include="*.ts"); do
  /usr/bin/grep -q writeAudit "$f" || echo "$f"
done
```

---

## 六、护栏测试：PGlite 测不了并发

`tests/redteam/posting.redteam.test.ts:35-52` 用 `Promise.allSettled([post(db,ev), post(db,ev)])` 断言「两个都 fulfilled、恰好一个 posted:true」，7 passed 全绿。
但 `tests/helpers/db.ts:12` 每次 `createTestDb()` 起的是**进程内 `new PGlite()`**，查询天然串行——第二个事务开始时第一个早已提交，走的是
「预检命中 → posted:false」这条**根本不涉及并发**的路径。真 Postgres 多连接下走的是 23505 分支（见第五节第一行）。

**PGlite 能测幂等语义，测不了并发竞态。** 写「并发」测试时说清它验的是哪一条：串行重放 ≠ 并发。唯一约束、排序、`onConflictDoNothing`
三样的正确性只能靠读代码 + 读约束定义确认，别把一个绿灯当证据。

---

## 提交前

```bash
npx tsc --noEmit 2>&1 | /usr/bin/grep -v "\.next/types"
npx vitest run
# 库存写入是否绕过 post()——期望只有 src/server/posting/post.ts 两行
/usr/bin/grep -rn "insert(stockLedger)\|insert(stockBalances)\|update(stockBalances)\|delete(stockLedger)" src --include="*.ts"
```

写路径的报告只说三件事：**入口调了谁 / 事务边界在哪 / 新增了什么护栏测试**。这三句答不上来，就是没写完。
