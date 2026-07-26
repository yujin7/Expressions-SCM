# 工程铁律与事故护栏

> 目录：一、违反即数据损坏（9 条）· 二、事故→护栏（9 起真实事故）·
> 三、共享层唯一权威 · 四、分层架构 · 五、测试约定

> `CLAUDE.md` 常驻上下文，列的是**规则本身**。本页补的是**规则背后的事故**——
> 知道一条规则为什么存在，你才不会在它碍事的时候绕过它。
> 下文事故数量、路径和覆盖数是历史样本，不是当前基线；当前状态只看 `docs/NOW.md`，
> 当前决议只看 `docs/spec/CURRENT.md`，引用样本前须在当前 revision 复核。

---

## 一、违反即数据损坏

| 铁律 | 唯一入口 | 违反的后果 |
|---|---|---|
| 禁止 float 运算 | `src/server/core/decimal.ts`（`dAdd/dSub/dMul/dDiv/dCmp`，十进制字符串，内部 BigInt，scale 6） | 金额/数量出现 0.1+0.2 类误差，结算逐物料轧不平，红队第二轮实测出系统性向下舍入偏差 |
| 库存只经过账表 | `src/server/posting/registry.ts` 的 `post()` | 直接写 `stock_balances`/`stock_ledger` ＝ 绕过幂等 UNIQUE、绕过审计、台账与余额永久劈叉 |
| 台账/审计只追加 | 红字冲销纠错 | 改/删已过账数据 ＝ 失去纠错能力（红队一轮原话：「没有冲销的追加式台账等于没有纠错能力」） |
| 所有写路径 `writeAudit` | `src/server/core/audit.ts` | 红队二轮实测：审计表**零写入**——规格写了「全留痕」但没人调 |
| 脱敏唯一收口 | `src/server/core/dto.ts` 的 `maskSensitive` | 红队二轮实测：函数定义了但**从未被调用**。前端隐藏不算数——RSC 载荷/导出/报表都要过 |
| 取号走 doc_counters | `src/server/docflow/doc-no.ts` | `MAX+1` 并发下必然重号 |
| 余额更新排序 | 事务内按 `(skuId, warehouseId, batchId)` | 不排序 → 并发死锁 |
| 幂等键含 cycle | 审批引擎 | 红队二轮：驳回→重提→再驳回被幂等短路，第二次驳回静默丢失 |
| DTO 禁 Map/Set/class | 用 plain object/array | `maskSensitive` 只穿透 plain object/array——Map 里的敏感字段会**原样漏出** |

---

## 二、事故 → 护栏

每一条都真实发生过。括号里是现在拦住它的东西。

### 1. 客户端组件值导入服务端模块 → 全应用 500

`report/exports/exports-client.tsx`（`"use client"`）为了取一个标签常量，
值导入了 `@/server/modules/report/export`。链路：

```
report/export → core/dto → auth/index → auth/config → @node-rs/argon2（原生模块）+ pg
```

webpack 解析原生模块失败后**模块图被污染**，此后 68 页里 23 页连锁 500，
连 `/api/health` 一起 500，且现象随编译顺序漂移，极难定位。
同时把鉴权配置流向前端本身就是安全问题。

> **护栏**：`tests/architecture/client-server-boundary.test.ts`——扫描所有 `"use client"` 文件，
> 禁止 `from "@/server/..."` 的值导入（`import type` 可以，编译期擦除）。
> 白名单只放零依赖纯常量模块，且带**防腐化断言**（白名单模块一旦引入 import 就失败）。
>
> **要常量怎么办**：由服务端 API 下发（如 `/api/export/jobs` 每行带 `kindLabel`），
> 或放进零依赖纯常量模块。

### 2. 24 页整页水合失败

`useListState` 内部用 `useSearchParams`。`page.tsx` 缺 `<Suspense>` 边界时，
React 的 `useId` 序列在 SSR/CSR 之间错位 → **整页水合失败**，
页面退化成无交互静态 HTML：Tab 变纯文字、表头重复、什么都点不动。
**HTTP 仍然 200，单测全绿。**

> **护栏**：CLAUDE.md 硬性约定 + 全页扫描的「thead 数 > 表格容器数」指纹。
> 用列表状态平台的页面，`page.tsx` **必须**包 `<Suspense>`。参考 `report/risk/page.tsx`。

### 3. 同页多 Tab 列表互相清空

列表状态平台原先重建整个查询串，第二个实例写入时把第一个的参数抹掉了。

> **护栏**：同页多个独立列表**必须**各给不同 `paramPrefix`（URL 参数变 `fg_q`/`fg_page`），
> 写入只增删自己的参数、保留兄弟。fetch 查询串不带前缀，后端参数名不变。

### 4. ABC 分层两处实现、判定不一致

分层页与补货页各写一遍帕累托，**边界约定不同 + 窗口不同** → 441 个 SKU 里 41 个分层不一致。
同一个 SKU 在两个页面是 A 类和 B 类。

> **护栏**：`src/server/rules/abc.ts` 的 `classifyAbc` 是唯一权威（标准帕累托，窗口统一近 6 月）。
> 统一后实测 0 处不一致。

### 5. 在库口径 12 个模块各写一遍

「取最新快照」子查询逐字复制了 9 份。口径修正要改 12 处，改漏一处就是新的劈叉。

> **护栏**：`src/server/core/stock-view.ts` 唯一权威（`getOnHandBySku` / `getLatestSnapshotRows`）。

### 6. 缺参 500 而非 400

`throw new Error("缺少 sku 参数")` 被全局兜底转成
「系统错误，请联系管理员（错误码 22d78296）」并写进 `error_logs`。
用户输入错误被当成系统故障：既误导用户，又把噪声灌进错误库。

> **护栏**：一律 `throw new ApiError(400, "...")`（`@/server/modules/master/common`）。

### 7. 内部消费者静默截断

MRP 只看到 999 个产品；自动补货 join 到 500/1026 个 SKU。**没报错，数字只是偏小。**

> **护栏**：内部消费者传 `allRows: true`；任何封顶必须 `log()` 说明丢了什么。
> 静默截断是本项目反复出现的缺陷类——**看到分页默认值就要问「这个调用方需要全量吗」**。

### 8. 仓库 hex 碰撞

别名解析把 5 组共 12 个仓混成一个。修复后重建 923 个快照键、纠正 1,601 行批次。

> **护栏**：`aliases` 表 `UNIQUE(aliasType, rawValue)`；碰撞进 `alias_exceptions` 标歧义码，
> **认领前禁止解析**。

### 9. 月销同键未聚合

同一 (sku, 月) 多行没合并，少记 2,354 件。

> **护栏**：导入按自然键聚合 + 幂等重放测试。

---

## 三、共享层唯一权威（禁止本地重实现）

口径漂移的根因就是「反正就几行，我这儿自己写一遍」。

| 口径 | 唯一权威 |
|---|---|
| 在库 / 快照 | `core/stock-view.ts` — `getOnHandBySku` / `getLatestSnapshotRows` / `coverDays` / `daysLeftOf` |
| 在途 / 未结供给 | `core/supply.ts` — `getOpenSupplyLines` |
| 销速窗口 / 日均 | `core/velocity.ts` — `lastMonths` / `dailyFromWindow` / `monthlyToDaily` |
| ABC 分层 | `rules/abc.ts` — `classifyAbc`（窗口统一近 6 月） |
| 服务脚手架 | `core/svc.ts` — `AnyDb` / `num` / `r1` / `r2` / `resolveDb` |
| 单据状态中文 | `labels.DOC_STATUS_LABELS` |
| SKU 供应参数 | `master/sku-supply-params.ts`（生产周期/MOQ/订货倍数的唯一读 facade） |

**新增共享口径的判据**：同一个计算出现第 2 次时就抽出来，不要等第 3 次。

---

## 四、分层架构

```
src/server/rules/      纯函数业务规则——无 IO、无 DB、无时间副作用（today 由调用方传入）
                       每个模块头注释写清：解决什么问题、口径来源、诚实降级条件
                       ↓
src/server/modules/    服务层——取数 + 组合规则 + 事务 + writeAudit + dto 脱敏
                       ↓
src/app/api/           路由层——鉴权守卫（guardRead/guardWrite）+ 参数校验（ApiError 400）
                       ↓
src/app/(app)/         页面——"use client" 组件，禁止值导入 @/server/*
```

**判据**：能写成纯函数的一律进 `rules/` 并配单测。
`rules/` 里出现 `await db.` 就是分层错了。

---

## 五、测试约定

| 目录 | 用途 |
|---|---|
| `tests/rules/` | 纯函数直测，不碰 DB，跑得飞快 |
| `tests/<域>/` | 涉库测试用 PGlite（`tests/helpers/db.ts`），不依赖 Docker |
| `tests/redteam/*.redteam.test.ts` | **对抗测试**：并发、幂等碰撞、边界攻击、脱敏穿透、二次冲销 |
| `tests/architecture/` | 架构护栏（客户端/服务端边界等），含**防白名单腐化**断言 |

`createTestDb()` 返回 `{ db, client }`——要解构：`({ db } = await createTestDb())`。

写新护栏测试时**必须验证它真的会失败**：把 bug 重新引入一次，确认测试变红，再改回来。
只会通过的测试是装饰品。

**红队测试是一等公民**，不是补充。写完正常路径就问：并发会怎样？重放会怎样？
换个没权限的角色会怎样？驳回后重提再驳回会怎样？
