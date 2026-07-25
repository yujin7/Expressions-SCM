---
name: verify-claim
description: Proves or kills a claim about this codebase before it is reported, planned around, or fixed. Use whenever about to tell the user something is missing, broken, unimplemented, a gap, a TODO, or "not wired up" — and whenever a comment, TODO, doc, spec, register, or another agent's report asserts that state. Comments in this repo have twice described finished work as pending and produced two false defects; the cost of one grep is far below the cost of a wrong finding. Also use before acting on any second-hand claim about the code. Do not use for claims already verified this session, or for questions about intent and design rather than facts.
---

# 先证伪，再上报

这个仓库里**注释会撒谎**。已经发生两次：`TODO(W3)` 说 BOM 生效没走审批（实际
SoD 早已实现）、`E2-01+` 注释读着像待办（实际交期波动早已接进安全库存）。
两次都各烧掉一轮完整排查，并差点作为「缺陷」上报给用户。

一次 grep 的成本 ≈ 5 秒。一个错误发现的成本 ≈ 用户按错的前提做决策。

---

## 三步

### 1. 把主张写成可证伪的一句话

「BOM 生效没走审批」不可证伪——太模糊。
「`activateBom()` 里没有 `审批人≠制单人` 的检查」可证伪。

主张必须落到**具体符号或路径**：函数名、字段名、文件名、表名。落不到就先落。

### 2. 直接找证据，不找注释

```bash
# 符号是否存在、在哪被调用
/usr/bin/grep -rn "functionName" src/ | /usr/bin/grep -av Binary

# 路径是否真的存在（注释里的路径经常是历史遗迹）
ls -la src/server/core/dto.ts

# 字段是否有消费者（"实现了没人用" 与 "没实现" 是两回事）
/usr/bin/grep -rn "shelfLifeDays" src/ | /usr/bin/grep -v "schema/"
```

**读实现，不读它上面的注释。** 注释是主张，代码是证据。

### 3. 分类，然后才决定说什么

| 证据 | 结论 | 该做什么 |
|---|---|---|
| 符号不存在 / 无调用方 | 真缺 | 报，并给影响 |
| 符号存在且被调用 | **注释过时** | 改注释，**不要报成缺陷** |
| 存在但只有部分调用方 | 覆盖不全 | 报，说清哪些路径没接 |
| 存在、被调用，但数据为空 | 能力在、数据没跑起来 | 报为数据待办，别报成 bug |
| 路径不存在 | 文档/注释指向幽灵 | 就地改掉（含 CLAUDE.md） |

最后一类真出现过：`CLAUDE.md` 把脱敏收口写成 `src/server/modules/*/dto.ts`，
`find` 结果为空，真实位置是 `src/server/core/dto.ts`。**常驻上下文里的错路径会污染每一次会话。**

---

## 三个高频陷阱

- **「计算了」≠「被读了」**：`rollup_sku_month` 每晚构建 2436 行，**零消费者**。
  发现「已实现」后再问一句：谁在用？
- **「接通了」≠「有数据」**：交期波动公式早已接进安全库存，但 `rollup_supplier_lead`
  是 0 行——因为系统里只有 3 条 PO。**代码就绪、数据未至，不是缺陷。**
- **「有默认值」≠「没问题」**：`nearExpiryDays ?? 90` 读着正常，但主档 1026/1026 为空，
  全靠兜底在撑。查字段时连它的**实际填充率**一起查。

---

## 报告口径

证实了就直说，并给影响与位置（`file:line`）。
证伪了就**不要提**——不用汇报「我本来以为 X 但其实不是」，那是噪声。
上一轮已经报错过，就一句话订正，然后继续，不要复盘自己的心路。
