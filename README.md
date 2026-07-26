# 供应链系统（委外闭环 MVP 1.0）

内部供应链管理系统。当前入口见 [`docs/NOW.md`](docs/NOW.md)，规格与决议见
[`docs/spec/CURRENT.md`](docs/spec/CURRENT.md)。

## 技术栈
Next.js 15 · TypeScript · Ant Design 5 · PostgreSQL 16 · Drizzle ORM · NextAuth v5 · pg-boss · vitest(+PGlite)

## 本地启动（零依赖模式，默认）

无需 Docker：`DATABASE_URL=pglite:.data/dev`（默认）时使用内嵌 PGlite，首次启动自动建表。

```bash
cp .env.example .env   # AUTH_SECRET 用 openssl rand -base64 32 生成；DATABASE_URL 留 pglite:.data/dev
npm install
SEED_ADMIN_PASSWORD='请使用至少12位强口令' npm run db:seed
npm run dev            # Turbopack；普通开发不启动后台任务
```

并行开发使用 `npm run dev:session -- <name>`，自动隔离 worktree、分支、缓存、端口、PGlite
和附件目录。它不会复制主工作区 `.env` 或继承应用密钥；每个会话生成自己的 0600 `.env`
和 `AUTH_SECRET`。若目标 worktree 已有非本脚本生成的 `.env`，脚本会拒绝覆盖，须先人工复核。
需要验证后台任务时使用 `npm run dev:jobs`；遇到 Turbopack 兼容问题可临时用
`npm run dev:webpack`。

## 联调/部署模式（PostgreSQL）

```bash
docker compose up -d db
# .env 改为 DATABASE_URL=postgres://scm:scm_dev_password@localhost:5433/scm
npm run db:migrate && npm run db:seed && npm run dev
```
注意：PGlite 数据（.data/）与 PG 数据互不相通；schema 变更后必须 `npm run db:generate`（迁移 SQL 同时供测试与 PGlite 模式使用）。

## 常用命令
| 命令 | 说明 |
|---|---|
| `npm run check:fast` | 日常内循环：应用类型、改动 lint、架构/规则与关联测试 |
| `npm run check:pr` | 合并门：全量 lint、三作用域类型检查、全部测试 |
| `SCM_VERIFY_LIVE=1 npm run check:release` | 发布门：仅接受干净且验证期间不变的候选；含 PostgreSQL 契约、生产构建和必跑 live smoke，任一失败/跳过均 `NOT READY` |
| `npm run scm -- doctor` | 环境和共享工作树快速诊断 |
| `npm run test` | 全部测试（规则/过账/单据流用 PGlite，无需 Docker） |
| `npm run db:generate` | schema 变更后生成迁移（变更后必须重跑，测试依赖 drizzle/*.sql） |
| `npm run db:seed` | 幂等种子数据 |
| `SCM_ADMIN_RESET_PASSWORD='至少12位临时强口令' npm run admin:reset-local` | 仅限停机后的本机 PGlite：重置 admin、解除锁定并强制首登改密 |
| `npm run db:backup` | dev/PGlite 停机备份；检测到外置锁或打开文件即拒绝 |
| `npm run db:restore-drill` | 从最近的停机归档恢复到临时目录并核对核心表 |
| `npm run db:restore -- /absolute/path/dev_*.tgz` | 停机恢复；原库保留为带时间戳副本 |

发布门的 `READY` 还要求 `DATABASE_URL` 指向已迁移的 PostgreSQL，并显式提供可访问的
`SMOKE_BASE` 与 `SMOKE_PASSWORD`；缺少 live 条件会如实产出 `NOT READY`，不会代替业务方接受风险。

## 演示账号（seed）
admin / ops01 / purchasing01 / warehouse01 / pmc01(审批人) / pmc02(非审批人) / finance01
使用执行 `db:seed` 时显式提供的 `SEED_ADMIN_PASSWORD`；系统不再接受公开默认口令。

## 架构要点（详见 CLAUDE.md 与 docs/spec/01 §4-§6）
- 库存唯一入口：`src/server/posting/`（过账表 registry；流水仅追加；纠错走红字）
- 单据流：`src/server/docflow/`（doc_counters 取号 / 统一状态机 / 审批人≠制单人）
- 业务规则：`src/server/rules/`（R1 价格异动 / R5 逐物料结算 / R11 净需求，纯函数+单测）
- 脱敏收口：`src/server/core/dto.ts`（运营/仓管不可见成本与加工费，含导出）

## 里程碑
阶段索引与决策登记见 `docs/spec/CURRENT.md`。当前阶段与决策以该文件为准（本文件不再复制阶段号与 commit 号）。

## 生产部署（staging 同构）
```bash
cp .env.example .env.prod   # 填 POSTGRES_PASSWORD/AUTH_SECRET/AUTH_URL
cp .env.backup.example .env.backup  # 填异地 BACKUP_REMOTE
ops/deploy.sh               # 自动加载两份环境文件；备份→迁移门禁→滚动重启→健康检查
```
部署默认显式读取 `.env.prod` 和 `.env.backup`；迁移前会生成 DB+附件的完整异地备份集。每日 02:30 自动备份，
每小时验证配对清单、SHA-256、压缩结构与新鲜度。每季运行
`npm run db:restore-drill:prod`，详见 `ops/RESTORE-DRILL.md`。
独立审计整改的迁移、账号、批次 UAT、HTTP 扫描、停止阈值与签字门禁见
`ops/SCM-AUDIT-RELEASE-CHECKLIST.md`。

项目的 Claude/Codex hooks 只提供 advisory 提醒，不是安全或发布门禁。Codex 项目 hooks
仅在从本仓目录启动、仓库受信任且当前定义经 `/hooks` 审阅后运行；未运行 hook 不构成验证通过。
