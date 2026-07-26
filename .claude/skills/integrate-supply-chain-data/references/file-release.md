# 数据放行

> 本文件是 `integrate-supply-chain-data` 的项目文件放行模式参考。事故数量、文件行数、
> 主档填充率和路径均为历史证据；运行前必须在当前 revision 与当前数据上重新核实。

这条管道决定主数据长什么样，而主数据错了，下游每个数字都错。
**45% 的新品上市延迟源于主数据缺陷**——这里省的每一步，后面都要加倍还。

```
适配器 → staging_rows → 校验 → 复核工作台（人工闸）→ 既有审批+过账 → 正式库
```

---

## 铁律五条

1. **dry-run 先行**。所有放行函数吃 `{ dryRun }`，dry-run 返回完整计数/冲突/待复核清单、
   **零写入**。没跑过 dry-run 就执行 = 拿真库赌。
2. **幂等**。重导走 superseded 机制（7,065 行实证）；快照/汇总按 `(template + bizDate)` 覆盖；
   主数据按编码 upsert。重放两次结果必须一致。
3. **别名优先**。`aliases` 表 `UNIQUE(aliasType, rawValue)`。碰撞 → 进 `alias_exceptions`
   标歧义码，**认领前禁止解析**。曾因别名把 5 组 12 个仓混成一个，
   修复后重建 923 个快照键、纠正 1,601 行批次。
4. **绝不猜**。BOM 同名多块无文字标记 → **100% 人工裁决**，启发式自动生效被禁止
   （判错会污染 `wo_line` 快照与结算基数，且事后极难发现）。
   猜不出单位/分类就打 `attrs.needsReview` 标，不静默瞎填。
5. **不伪造历史**。存量单走新旧划断（D16）；例外经审批后走 `migration_opening` 过账子类。

---

## 摄取纪律

- **只导长表**。所有宽表透视一律用视图重建，**永不导入**。
- **双通道解析**：exceljs 优先，自动回退原始 OOXML（三个最高价值文件让 exceljs 崩过）。
  逐文件解析行数须在复核基线 **±0.5%** 内，否则拒绝。
- **脏值走显式拒绝道**（"此规格不做了"这类），不要塞进主档。

---

## 排查：字段解析了却没落库

这类最隐蔽——文件里有、staging 里有、主档没有，页面显示"缺失"，看着像源数据没给。

真实案例：`skus.shelf_life_days` **1026/1026 在售成品为空**。
`import/adapters/expiry.ts:89` 一直在解析保质期（还统计 1095 天的条数），
但 `releaseBatchStocks` 的 `Payload` 接口里**根本没有这个字段**，于是它在 staging 里躺着。

```bash
# 三处逐一对照：适配器解析了吗？放行接口读了吗？主档写了吗？
/usr/bin/grep -n "fieldName" src/server/import/adapters/*.ts
/usr/bin/grep -RIn --include="*.ts" -- "fieldName" src/server/modules/release/engine
/usr/bin/grep -n "fieldName" src/db/schema/*.ts
```

补写主档字段时的三条纪律（照抄 `releaseBatchStocks` 的保质期回填）：
① **只填空**（`IS NULL OR <= 0`），绝不覆盖人工已设的值——主档以人为准；
② 同一实体在文件内出现**矛盾值** → 记 `conflicted`、一个都不写，不要二选一；
③ 与主写入**同事务同审计**，dry-run 零写入。①的 `IS NULL` 条件同时带来天然幂等。

---

## 运行

```bash
# .data/dev 只能有一个写者：先确认精确端口/PID，只停止自己启动且再次核实过的进程
lsof -nP -iTCP:3000 -sTCP:LISTEN
# 确认 PID 的命令、工作目录和归属后，才可执行：kill <owned-dev-pid>
npx tsx scripts/db-peek.ts
```

临时探查脚本写在 `scripts/` 下（相对导入 `../src/db` 才解析得了别名），**用完删掉**。

放行后必查：
- `releaseStatus` 的 blocked / unresolved 计数——**不为 0 就不算完**，逐条给出原因与去向。
- 新鲜度看门狗（`src/jobs/freshness.ts`）：stock_summary/fg_order 7 天、pallet/demand 40 天、
  月销 45 天超期自动开复核项，重传自动关闭。

---

## 报告口径

报**三个数**：提交行数 / 受阻行数 / 未解析别名数。
受阻不是失败，是**待人工**——但必须说清是谁、为什么、下一步找谁。
「全部成功」这种话在这条管道上通常意味着没看 blocked 列表。
