---
name: decision-log
description: Read or record authoritative business rulings in docs/spec/CURRENT.md. Use before hard-coding a business threshold, policy, approval domain, or phase decision; when the user makes or changes such a ruling; or when specifications conflict. Do not use for implementation choices without a business owner.
---

> **ARCHIVE ONLY** — Historical evidence, not executable guidance. Do not run commands or follow
> routing in this file; use [the quarantine index](README.md) and current `.claude/skills/`.

# 决议登记

**`docs/spec/CURRENT.md` 是当前意图入口与决策登记簿。** 改判先改它，再改宿主文档。
它存在的原因很具体：曾有 19 条决议只活在聊天记录里，规格集退化成互相打补丁的链条，
没人答得上「现在到底按哪条」。

---

## 读：先查再问

要一个阈值/口径/范围的答案时，**先查 CURRENT.md，别翻 01/04 原文**——
原文里有大量已过期段落（打了 ⚠ 锚点但容易漏看）。

```bash
/usr/bin/grep -n "D[0-9]\+" "docs/spec/CURRENT.md" | head -40
/usr/bin/grep -n "关键词" "docs/spec/CURRENT.md"
```

CURRENT.md 里的「当前答案速查」表每行 = 一个唯一权威。典型过期陷阱：

| 问题 | 现行答案 | 过期说法（别用） |
|---|---|---|
| SKU 编码规则 | 存量商家编码冻结；未来新建/替代使用 S1 前向标准（D10/D31/spec 19） | 01-R8 的「品类2位+5位」 |
| 供应商评分 | 质量40/交付40/价格20，季度（D7） | 01 的准交40/质量40/配合20 |
| 计划损耗 | 行级双损耗，毛=净×(1+来料)×(1+生产) | 旧的单一 `lossRatePct` |
| 报表数量 | 4 张（含结算汇总） | 01 §2 的「3 张」 |

---

## 写：什么时候必须登记

用户拍板下列任何一类，**先落 CURRENT.md 再写代码**：

- 数值阈值（价格容差、损耗率、保质期、临期天数、服务水平、滞销阈值）
- 口径归属（哪个数算哪个层、谁是真相源）
- 审批域（谁批哪类单）
- 范围与分期（进 MVP 还是 1.1/P1/P2）
- 代理口径（用 A 暂代 B，直到某条件满足）

**判据**：如果你正准备在代码里写一个业务常量，而它不是从 `sys_params` 读的，
那它就该先有个 D 编号。

## 登记格式

追加到 CURRENT.md 的决议登记簿表格（**编号取当前最大值 +1，先 grep 确认，别硬记**）：

```markdown
| D<下一个未用编号> | 临期阈值口径 | 运营 | **已决 YYYY-MM-DD**：按渠道合同逐 SKU 设定，
默认沿用 max(保质期×2/10, 100天) | 天猫美妆类目口径；主档 `skus.near_expiry_days` 承载 |
```

四个字段一个都不能省：**编号 / 事项 / 拍板人 / 裁决内容+日期**，备注写口径来源与落点。

代决（用户授权"你来定"）要**显式标注**：`已代决 YYYY-MM-DD（提案值）`，
并写清校准时机（通常是 UAT）。代决不是拍脑袋——要给出依据，且业务可随时改判。

---

## 三条纪律

1. **先登记后写码**。反过来做，代码里的常量就成了事实上的决议，
   而没人知道它是谁定的、能不能改。
2. **代理口径必须打标、必须单点**。D23 就是范例：结算扣款价用价目表代理，
   直到 P1 成本引擎——**在 DTO 上打标，切换只改一处**。
3. **改判走红字，不走覆盖**。已按旧决议产生的数据不要静默改写；
   新决议生效日之前的数据保持原样，需要纠正就走红字冲销。

---

## 与代码的接口

阈值优先进 `sys_params`（可参数化、可分域覆盖），而不是常量：
分域解析器支持 `sku > brand > segment > global` 的优先级
（见 `makeResolver` / `getNumParam`）。

写死常量只在两种情况可接受：会议定死且永不变（如包材损耗 5%），
或纯技术常量（与业务无关）。两种都要在代码注释里写上 D 编号。
