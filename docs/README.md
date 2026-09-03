# 项目资料总导航（中文）

本页是所有需求、数据、架构、集成、运行与历史资料的统一入口。它只做导航，不复制事实；
同一状态、口径或数据只允许有一个权威来源，避免文档越整理越多、结论彼此冲突。

## 先看这四份

| 你要回答的问题 | 唯一入口 |
|---|---|
| 系统现在做到哪里、还缺什么 | [`NOW.md`](NOW.md) |
| 当前生效的产品/架构决策 | [`spec/CURRENT.md`](spec/CURRENT.md) |
| 数据如何分层、去重、关联和利用 | [`data/README.md`](data/README.md) |
| 聚水潭、简道云、用友、飞书真实可用到哪一层 | [`integrations/EXTERNAL-SYSTEMS.md`](integrations/EXTERNAL-SYSTEMS.md) |

## 按工作类型进入

### 产品、需求与会议决议

- 当前规格入口：[`spec/CURRENT.md`](spec/CURRENT.md)
- 系统演进总 PRD：[`spec/14-系统进化总PRD.md`](spec/14-系统进化总PRD.md)
- 0724 会议落地：[`spec/09-0724会议决议与落地计划.md`](spec/09-0724会议决议与落地计划.md)
- UAT 场景：[`spec/07-UAT场景矩阵与并行运行手册.md`](spec/07-UAT场景矩阵与并行运行手册.md)
- 旧版规格、审计和快照只作为历史证据；冲突时以 `CURRENT.md` 为准。

### 数据、文件与指标

- 数据治理总入口：[`data/README.md`](data/README.md)
- 源文件血缘与覆盖：[`data/DATA-LINEAGE-AUDIT-2026-07-27.md`](data/DATA-LINEAGE-AUDIT-2026-07-27.md)
- 三方数据融合蓝图：[`data/三方数据融合与组织蓝图-2026-08-12.md`](data/三方数据融合与组织蓝图-2026-08-12.md)
- 原始 Excel/PDF 不复制进 Git；用文件 hash、导入批次和来源截止日连接到 staging 与正式事实。
- 指标和决策产品必须在代码目录中登记，页面不得另写同名不同公式。

### 外部系统与业务验收

- 总契约和状态：[`integrations/EXTERNAL-SYSTEMS.md`](integrations/EXTERNAL-SYSTEMS.md)
- 只能由平台管理员完成的动作：[`integrations/待办-控制台动作清单.md`](integrations/待办-控制台动作清单.md)
- 可直接转发的授权说明：[`integrations/授权操作手册-可直接转发.md`](integrations/授权操作手册-可直接转发.md)
- 简道云业务核对：[`integrations/简道云外部需求-UAT操作手册.md`](integrations/简道云外部需求-UAT操作手册.md)
- 天猫金额桥财务核对：[`integrations/简道云天猫金额桥-财务UAT操作手册.md`](integrations/简道云天猫金额桥-财务UAT操作手册.md)
- 公网访问（快速隧道 + 守护、换址、审计结论）：[`guides/对外访问方案-选型与步骤.md`](guides/对外访问方案-选型与步骤.md)
- 三方数据融合计划与事实（身份桥、时间窗契约、全渠道观察）：[`engineering/外部数据融合-决策增强计划-2026-09-02.md`](engineering/外部数据融合-决策增强计划-2026-09-02.md)
- 简道云 297 张表单时效普查（选表前先看）：[`integrations/简道云表单时效普查-2026-08-04.md`](integrations/简道云表单时效普查-2026-08-04.md)

### 操作、部署与恢复

- 日常命令和开发启动：项目根目录 [`../README.md`](../README.md)
- 本机生产容器实跑、账号发放、线上冒烟：[`engineering/本机实跑指南.md`](engineering/本机实跑指南.md)
- 编码/命名标准裁决简报（用实跑数据算过）：[`engineering/CODING-STANDARD-DECISION-2026-08-07.md`](engineering/CODING-STANDARD-DECISION-2026-08-07.md)
- 一次性运维脚本清单与历史脚本说明：项目根目录 `scripts/README.md`
- 变更日志：本项目不维护单独 CHANGELOG；`git log` 是唯一变更史，状态结论只写进 `NOW.md`
- 生产发布：项目根目录 `ops/deploy.sh`
- 发布门禁：项目根目录 `ops/SCM-AUDIT-RELEASE-CHECKLIST.md`
- 恢复演练：项目根目录 `ops/RESTORE-DRILL.md`
- 运行密钥只在受保护环境文件中；文档、Git、日志、截图和交接包均不得保存口令、token 或 secret。

## 信息分层与更新规则

1. **原始输入**：Excel、PDF、会议纪要保留原件和 hash，不重命名出多个“最终版”。
2. **当前决策**：只更新 `NOW.md`、`spec/CURRENT.md` 与对应领域入口。
3. **实现证据**：代码、迁移、测试和 CI 是“已实现”的证据；设计文档不是完成证明。
4. **运行证据**：健康检查、真实探针、控制总量和恢复记录单独保存，不能由单元测试代替。
5. **业务验收**：财务、库存、订单和自动执行必须由责任人 UAT/签认；token 成功不等于业务数据可用。
6. **历史材料**：过期方案移到 `archive/` 或 `skill-history/`，不得继续作为当前操作指引。

## 当前三方系统角色

| 系统 | 在整体架构中的角色 | 当前权限边界 |
|---|---|---|
| 简道云 | 经营信号与现行人工流程观察 | 当前部署已选择 19 条显式契约（含天猫日销/退款/对照、拼多多订单时间窗、唯品会店铺交易、天猫宝贝损益）；未完成控制总量/UAT前保持观察层 |
| 聚水潭 | 电商订单、仓配、出库与库存运营事实 | 代码和签名就绪；平台权限/IP 白名单未通过前不进入正式事实 |
| 用友 | 组织、采购、库存、成本、凭证与财务权威 | token 可取；8 条只读 API 授权和 tenant/org 未齐前保持关闭 |
| SCM | 统一身份、受控 staging、库存账、单据、审批、对账与决策产品 | 任何外部源都不能绕过 release/posting 直接改账 |

新增系统或文件时，只登记来源、owner、权威等级、身份 scope、业务截止日、控制总量、SLA、
允许用途和放行门禁，然后接入既有 L0→L5 数据路径；不要另建一套旁路数据库或孤立看板。

## 需求输入（业务原文存档）

- [2026-09-02 供应链总监会议纪要](requirements/2026-09-02-供应链总监会议纪要.md) — 三期建设、四屏驾驶舱、预警、调拨、待办、分级权限、备货权责、账期
- [2026-09-03 四屏数据需求表](requirements/2026-09-03-四屏数据需求表.md) — 每屏要展示的数据与交互方式
