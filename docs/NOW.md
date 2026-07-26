# 当前工作入口

更新日期：2026-07-26

## 产品方向

以现有单体系统为核心持续演进，不重写。优先让计划、采购、库存、委外、质量和新品协同形成可验证的端到端闭环，再按真实负载拆分或缓存。

## 当前工程状态

- Next.js + React + Ant Design，服务端模块与 PGlite/Postgres 数据层共仓。
- 库存账、过账、审计、精度、权限和迁移是高风险边界。
- 普通开发使用 Turbopack、独立 `.next-dev`、关闭后台任务；webpack 保留为回退。
- `npm run check:fast` 是日常反馈门，`check:pr` 是合并门，`check:release` 是交付门。
- 并行工作使用独立 worktree、端口、缓存和数据库路径。
- 身份变更使用 `users.session_version` 立即作废旧 JWT；逐 SKU 临期阈值已贯通风险动作/展示/导出。
- CI 同时验证静态门、全量测试、生产容器和真实 PostgreSQL 迁移契约。
- 决策可视化已收口到统一图卡/指标/颜色契约；经营驾驶舱、库存分析、需求达成和总库存核对
  已完成首批迁移，统一来源、时点、覆盖、限制、五态、数据表、分享和全屏分析。

## 当前优先级

1. 在 staging 完成真实 PostgreSQL 迁移、HTTP/浏览器冒烟、权限脱敏和 41 场景 UAT。
2. 轮换密钥并完成出主机备份/恢复演练、监控告警、发布与回滚签字。
3. 补齐海外仓/其他部门库存覆盖，再迁移历史批次并 UAT FEFO 全出入库链。
4. 按 [`engineering/DECISION-VISUAL-PLATFORM.md`](engineering/DECISION-VISUAL-PLATFORM.md)
   继续迁移计划、采购、供应商、委外、质量和 NPD 的高频决策闭环；缺事实的图表保持数据闸门。
5. 缩短编辑到可信反馈的时间，保持小批量、低 WIP；构建缓存超过 1 GiB 先清理。
6. 用实际用户闭环验证计划与协同能力，再增加智能推荐；只在测量证明必要时拆分或缓存。

## 权威入口

- 现行决议和规格导航：[`spec/CURRENT.md`](spec/CURRENT.md)
- 项目工程约定：[`../CLAUDE.md`](../CLAUDE.md)
- 交付方式：[`../CONTRIBUTING.md`](../CONTRIBUTING.md)
- 规格快照来源：见 [`spec/SNAPSHOT.md`](spec/SNAPSHOT.md)

## 维护规则

完成一个有业务意义的增量时，只更新本页的状态和下一优先级；细节进入对应规格、代码、测试或决议。不要把聊天纪要、历史审计和当前承诺混在一起。
