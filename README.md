# 供应链系统（委外闭环 MVP 1.0）

内部供应链管理系统。规格见 `../spec/`（01=完整规格 v2.1，02=MVP 构建规格）。

## 技术栈
Next.js 15 · TypeScript · Ant Design 5 · PostgreSQL 16 · Drizzle ORM · NextAuth v5 · pg-boss · vitest(+PGlite)

## 本地启动（零依赖模式，默认）

无需 Docker：`DATABASE_URL=pglite:.data/dev`（默认）时使用内嵌 PGlite，首次启动自动建表。

```bash
cp .env.example .env   # AUTH_SECRET 用 openssl rand -base64 32 生成；DATABASE_URL 留 pglite:.data/dev
npm install
npm run db:seed        # admin/admin123 及演示主数据（密码可用 SEED_ADMIN_PASSWORD 覆盖）
npm run dev            # http://localhost:3000
```

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
| `npm run typecheck` | TS 严格检查 |
| `npm run test` | 全部测试（规则/过账/单据流用 PGlite，无需 Docker） |
| `npm run db:generate` | schema 变更后生成迁移（变更后必须重跑，测试依赖 drizzle/*.sql） |
| `npm run db:seed` | 幂等种子数据 |

## 演示账号（seed）
admin / ops01 / purchasing01 / warehouse01 / pmc01(审批人) / pmc02(非审批人) / finance01，默认密码 `admin123`。

## 架构要点（详见 CLAUDE.md 与 spec/01 §4-§6）
- 库存唯一入口：`src/server/posting/`（过账表 registry；流水仅追加；纠错走红字）
- 单据流：`src/server/docflow/`（doc_counter 取号 / 统一状态机 / 审批人≠制单人）
- 业务规则：`src/server/rules/`（R1 价格异动 / R5 逐物料结算 / R11 净需求，纯函数+单测）
- 脱敏收口：`src/server/core/dto.ts`（运营/仓管不可见成本与加工费，含导出）

## 里程碑
阶段索引与决策登记见 `../spec/CURRENT.md`。当前：**DW1**（W1/W2/DW1-core 已完成，commit 1103347）；上线门待 D15。

## 生产部署（staging 同构）
```bash
cp .env.example .env.prod   # 填 POSTGRES_PASSWORD/AUTH_SECRET/AUTH_URL
ops/deploy.sh               # 构建→迁移门禁→滚动重启→健康检查
```
备份：`ops/backup.sh`（crontab 每日 02:00；必须配置 BACKUP_REMOTE 出主机）。恢复演练：`ops/RESTORE-DRILL.md`（每季）。
