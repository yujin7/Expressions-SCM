---
name: redteam-pass
description: Attack consequential project changes for concurrency, replay, idempotency, authorization, masking, approval-cycle, reversal, negative-stock, precision, and aggregation failures. Use after implementing approval, posting, settlement, pricing, import, export, or other write paths and before shipping stock- or money-moving changes.
---

> **ARCHIVE ONLY** — Historical evidence, not executable guidance. Do not run commands or follow
> routing in this file; use [the quarantine index](README.md) and current `.claude/skills/`.

# 红队一遍

**五轮红队在这个仓库里找到的东西，全都是正常路径跑通之后才发现的：**

- 审计表**零写入**——规格写了"全留痕"，没人调 `writeAudit`
- `maskSensitive` 定义了但**从未被调用**
- 期初审批被劫持成仓管自审（配置与路由双重排除才堵住）
- 驳回→重提→再驳回被幂等键短路，**第二次驳回静默丢失**
- 结算公式被反例证伪：发料 11000 / 合格 10000，**扣款算出 0**（实际损耗 9.1%）
- 系统性向下舍入偏差（先截断后取整）

写完功能就问下面四组问题。答不上来的就是没测。

---

## 四问

### 1. 并发会怎样？

- 两个请求同时过账同一张单 → 有没有 `UNIQUE(sourceDocType, sourceDocId, action)` 兜底？
- 余额更新有没有按 `(skuId, warehouseId, batchId)` **排序**？不排必然死锁。
- 乐观锁与幂等键同时命中时，**幂等优先于版本冲突**（R10）——反过来会把重试变成报错。
- 多行事件里最后一行超扣 → **整个事件必须回滚**，前面的行不许留痕。

### 2. 重放会怎样？

- 同一个导入跑两次，行数会翻倍吗？（superseded 机制 / 自然键 upsert）
- 同一个幂等键第二次调用，返回缓存结果还是又写一遍？
- 红字冲销的原单能被**二次冲销**吗？（`reverse()` 必须编码原单身份并拒绝）
- 审批幂等键**含 cycle（单据版本）**吗？不含就会吃掉重提后的第二次驳回。

### 3. 换个角色会怎样？

- 用 `ops01` / `warehouse01` 登录，同一个接口还看得到价格吗？
  （黑名单：成本价/采购价/合同价/加工费单价/结算金额/扣款单价/银行账户/税率）
- 导出 CSV、RSC 载荷、报表里也脱敏了吗？**前端隐藏不算数。**
- DTO 里有没有用 Map/Set/class 装数据？`maskSensitive` 只穿透 plain object/array，
  **Map 里的敏感字段会原样漏出**。
- 审批人 = 制单人时被拒了吗？admin **不豁免**职责分离。
- 期初(opening)/盘点(count) 的审批域是**财务**，不要并回 `stock_doc` 域。

### 4. 数字会不会静默变小？

这是本项目最惯犯的一类，**不报错、不为零、只是偏小**：

- 分页默认值：内部消费者传 `allRows: true` 了吗？（MRP 曾只看到 999 个产品）
- 同键聚合：同一 (sku, 月) 多行合并了吗？（曾少记 2,354 件）
- 逐行钳零：R5 结算**禁止跨物料轧差**——省料不得抵扣他料超损。
- 封顶截断：`slice(0, 500)` 有没有 `log()` 说明丢了什么？
- 舍入方向：先截断后取整会产生系统性向下偏差。

---

## 落成测试

对抗测试是**一等公民**，不是补充：

```
tests/redteam/<域>.redteam.test.ts
```

现有 8 个可照抄：`posting`（并发/幂等/冲销）、`dto-mask`（脱敏穿透 + 原型污染）、
`approval-reject-cycle`（幂等键碰撞）、`price-rules`（R1/R5/R11 边界）、
`decimal`（定点边界）、`stock-doc`（外层事务回滚/重复行/调拨红字）。

`createTestDb()` 返回 `{ db, client }`——要解构：`({ db } = await createTestDb())`。

**新护栏必须验证它真会失败**：把 bug 重新引入一次，确认测试变红，再改回来。
只会通过的测试是装饰品。（本次保质期回填就是这么验的：删掉「只填空」条件后
"绝不覆盖"用例确实变红。）

---

## 报告

找到就报，附**可复现的输入 → 错误输出**，不要只说"可能有风险"。
没找到就说没找到——不要为了显得尽责而编造中等严重度的发现。
