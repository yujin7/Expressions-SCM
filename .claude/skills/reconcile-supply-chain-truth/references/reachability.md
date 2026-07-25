# 先找读的人，再说它做完了

> 本文件保存 `$reconcile-supply-chain-truth` 的 reachability 扫描法与历史事故样本。
> 下文的行数、路径、调用点、表数据与“已确认清单”只证明当时发生过什么；它们不是当前
> backlog。每次引用前必须在当前 revision 重新扫描定义、写端、读端、入口条件和真实数据。

效期文件里写着 1095 天。适配器认认真真解析出来，还顺手统计了「有多少条是 1095」
（`src/server/import/adapters/expiry.ts:89-92`，:105 写进 payload），3131 行 staging 里 3122 行带着这个数字。
而 `select count(*) from skus where active=true and sku_type='finished' and shelf_life_days is null` 的答案是
**1026——一个都没填上**（全表 5376 行，非空 0 行）。中间那步「写回主档」，从来没人写。
代价不是报表少一列：天猫按 `max(保质期×2/10, 100天)` 判临期，我们连自己的保质期是多少都答不上来。货压在仓里，系统判健康，渠道判临期。
结局更值得记住：这个洞后来真被修了（commit 336d72f，`release/engine.ts:1261-1273` 同事务回填、带 `is null or <= 0` 守卫、配 5 个测试）——
**但它永远不会触发**。回填走 `loadStagedRows`（`engine.ts:52-63`）硬性 `inArray(status,["pending","validated"])`，
而那 3131 行早已全部 `committed`。管子终于接上了，阀门却在上游被永久关死。

---

## 一、先判形态：三种「不通」，处置完全相反

| 证据 | 形态 | 该做什么 |
|---|---|---|
| 有写入方，src 全域 0 处 `.from()` / import | ①**写了没人读** | 报「零消费者」；二选一：接上读端，或连表带 job 一起删 |
| 解析到位、staging/中间表有值，目标主档 0 行有值 | ②**解析了没落库** | 找回填点，**并验证入口条件在存量数据上成立**（见上面那 3131 行） |
| 消费端在热路径且真被调用，上游表 0 行 | ③**接通了没数据** | **不是缺陷**。报为数据待办，写清缺哪一类单据 |
| 注释明写「预留」，DB 0 行 | 诚实预留位 | 不动，不报 |
| 写端读端都在，但读端自己又算了一遍同一个量 | 重复口径 | 报口径风险（caliber-change），不是死管道 |

③ 的样板：`replenish/service.ts:306-326` 批量读 `rollupSupplierLead.leadStdevDays` 喂安全库存，是热路径，代码完全正确；
表 0 行的原因不是 PO 少，而是 `jobs/rollup.ts:151-160` 要求 PO 与同 (PO,SKU) 最早一张 approved/in_progress/completed 的 SH 配对，
实测 `sh_docs where source_type='po'` = **0**，每一行 PO 都 `continue`。**改代码没用，只能等收货单产生。**
④ 的样板：`bom_lines.substituteSkuId`（`schema/bom.ts:40`）注释写「P0 预留字段」，DB 0/5161 ——
和沉默的死列现象一模一样，判定相反。**把它写进缺陷清单，会让整张清单失去信用。**

---

## 二、三层机械扫描（十分钟，别靠肉眼读代码）

```bash
# 1) 表级：除 schema 定义与写入方外，还有谁读
/usr/bin/grep -rn "rollupSkuMonth\|rollupWarehouseSku\|rollup_sku_month\|rollup_warehouse_sku" \
  --include="*.ts" --include="*.tsx" src tests scripts
# 实测命中只有 src/db/schema/rollup.ts（定义）、src/jobs/rollup.ts（写入 :76/:114）、drizzle/0017_productive_thanos.sql（建表）

# 2) 列级：抽出 schema 里全部列名，逐个排除 schema 目录后反查
/usr/bin/grep -rhoE '^[[:space:]]+[a-zA-Z][a-zA-Z0-9]*: (text|integer|numeric|date|timestamp|boolean|jsonb)\(' src/db/schema \
  | sed -E 's/[[:space:]]*([a-zA-Z0-9]+):.*/\1/' | sort -u | while read c; do
      n=$(/usr/bin/grep -rlw --include="*.ts" --include="*.tsx" "$c" src | /usr/bin/grep -cv '^src/db/schema/')
      [ "$n" -eq 0 ] && echo "DEAD COLUMN $c"
    done
# 实测 311 个列名 → 18 个零引用

# 3) 路由级：拿 route 的 URL 前缀在 src 全域反查（排除 src/app/api 自身）
for r in $(find src/app/api -name route.ts); do
  u=$(echo "${r#src/app}" | sed 's#/route.ts##')
  /usr/bin/grep -rq -- "$u" --include="*.ts" --include="*.tsx" src --exclude-dir=api || echo "NO CALLER $u"
done
# 实测 46 个 route → 3 个零引用
```

本项目的 `grep` 被包装注入 `-G`，**必须写 `/usr/bin/grep`**；扫完再逐条按第一节判形态，不要直接下「未使用」结论。

---

## 三、历史已确认样本（拿它学判型，不要当当前结论）

| 死在哪 | 位置 | 实测 |
|---|---|---|
| 夜跑汇总表零读取 | `jobs/rollup.ts:76,:114` 写 | 2436 / 344 行，8 轮 job_runs 全 ok，最近 2026-07-25T06:40:28Z，src 0 处 `.from()` |
| 报表宁可全表扫也不用它 | `report/dashboard.ts:67,:81`、`report/auto-replenish.ts:66` | 15 个 modules 文件读 `salesMonthly`、15 个读 `stockBalances`、**0 个读 rollup**，各挂 60s 缓存 |
| 汇总表自称的用途被绕过 | `schema/rollup.ts:35` 称是「调拨建议的需求代理」 | 真调拨建议 `report/transfer-suggest.ts:119-133` 自己从 `stock_balances` + 近 90 天 `stock_ledger` 重算 |
| 完整规则模块零消费者 | `rules/spc.ts:85,120`（15 个 it）、`rules/kitting-atp.ts:67`（12 个 it） | grep 命中只有自身与自身测试；spc 文件头写的「128 条告警里 106 条误报」至今照发 |
| barrel 无人 import | `rules/index.ts` | `from "@/server/rules"` 全仓 0 命中，所有人直接 import 具体文件 |
| 只到 schema 的 token | `schema/docs.ts:136-138` reportToken / reportTokenExpiresAt | 无生成、无校验、无路由，JG 打印页不印码；对照活着的 `outsource/po-confirm.ts:28-147` + `/api/public/po-confirm/[token]` |
| 落库了没人读的列 | `adapters/transit.ts:181` → `engine.ts:1695` → `transit_refs.revised_date` | 9182 行中 253 行有值，12 个读 `transitRefs` 的文件里 `revisedDate` 0 命中 |
| 类型接住了、界面不渲染 | `report/transit/transit-client.tsx:25,39` | `feishuNo` 3512 行、`urgentDept` 106 行有值，无任何 dataIndex；对照 `:200` 的 `replyDate` 是真有列的 |
| 三层齐备、无人调用 | `api/inventory/fefo-suggest/route.ts`（← `modules/inventory/fefo.ts` ← `rules/fefo.ts`） | 零引用；仓管点不到 FEFO 建议，只能靠脑内地图挑批次（commit 7483c51 自称「第 2 步」） |
| 建了表连写入方都没有 | `schema/rollup.ts:74,:93,:110`、`schema/dimensions.ts:98` | `approval_routes`（注释承诺「服务层按 docType + 金额匹配」——服务层不存在，5 万件和 50 件走同一审批人）、`approval_delegations`、`bins`、`external_doc_refs`、`sales_velocity`（唯一引用是 `tests/dimensions/resolver.test.ts:171-184` 在测它的约束） |
| 只写不读 | `modules/matflow/sh.ts:439-449` 插 `offset_pools` | src 全域 0 处 select；`writeoffDocId`（`schema/inventory.ts:63`）全仓仅 schema 一处，`amount` 恒写 `"0"` |
| 一次性脚本写、无人读的列 | `suppliers.shortName`（`schema/masters.ts:85`） | **153/156 行有值**，写自 `scripts/populate-stage.ts:98`、`scripts/fixup-fee-suppliers.ts:28`，读取 0 |
| 功能从未落地的列 | `import_jobs.errorFile`（`schema/system.ts:71`） | 0/17 有值、无写无读；而 `staging_rows` 里 `status='error'` 有 704 行——「导入失败明细下载」根本不存在 |
| 算了就扔 | `jobs/rollup.ts:37` 钳制 months，`:197` `void months;` | 整个 `opts` 是装饰品，唯一调用方 `jobs/interval-runner.ts:47` 写 `runRollup(db)` 从不传参；`:198` `void isNotNull;` 是没用上的 import |

---

## 四、四种最容易骗过 review 的伪装

- **注释里的「复用 X 模式」**：`schema/docs.ts:136-138` 写着「复用供应商门户 token 模式」，读起来像做完了。
  两条列名几乎一样的字段，一条通到底、一条只到 schema。**看到「复用」二字，去 grep 被复用的那一头有没有路由。**
- **修好了但扫不到**：`engine.ts` 回填 + 5 个测试全绿，`skus.shelf_life_days` 依旧 0/5376。
  提交信息自己承认「需重放一次效期文件放行（未在本提交内执行）」——**代码里没有任何机制保证这次重放发生，也没有告警在它没发生时叫一声。**
- **不可达分支把失败伪装成成功**：`workbench-client.tsx:159` 的空态 Alert 是 `type="success"`，而 `workbench/focus.ts:357-363`
  的 queues 是无条件五元素字面量，正常路径 `length` 恒为 5，这个分支永远渲染不出来。它唯一能出现的场合是 fetchJson 抛错：
  `.catch` 只弹 message.error、`setQueues` 从未调用（:132 在 then 里）、`.finally` 把 loading 置 false（:134）——
  **接口挂掉的用户看到一条绿色的「当前没有待你处理的单据」，然后回家了。**
- **旧诊断文案指向已修好的根因**：`report/data-health.ts:192` 至今写着「放行引擎未把它写回 skus.shelf_life_days」，
  而 336d72f 已经把引擎修好且没动这个文件。用户会照着它去改一个不需要改的地方。

另：`runRollup` 每晚写 2780 行，`tests/jobs/` 下 9 个 job 测试文件里 grep `runRollup` **0 命中**。零消费者的东西也常常零测试——两者是一起出现的。

---

## 报告口径

- **先说是哪一种形态。**「rollup 没用上」是三句不同的话：删得掉（①）、接得上（②）、只能等单据（③）。混为一谈会让人去改一个不该改的地方。
- **给数字不给形容词**：「2436 行 / 8 轮夜跑 / 0 处 `.from()`」可以行动，「疑似未使用」不能。每条结论配 file:line 或 DB 计数。
- **修完追问一句「新代码在存量数据上会被触发吗」**，并把答案写进提交信息。触发不了就必须同时给出数据动作或告警，否则等于没修。
- **顺手 grep 一遍旧文案**：修了根因不改诊断文案，等于埋下第二个错误结论。
- **删除前确认没有迁移/外部消费者**：表可以删，但 `drizzle/` 里的历史迁移不能改；删表要新开一份迁移。
