/**
 * PostgreSQL 管理员应急恢复。
 *
 * 仅在常规管理员均无法登录时使用。要求三重显式开关，重置后强制首登改密、使旧 JWT
 * 立即失效，并把操作写进同一事务的追加审计。脚本从环境读取口令，绝不打印或落文件。
 *
 * 调用示例（口令请通过当前 shell 环境安全注入）：
 *   SCM_ADMIN_RESET_ALLOW_POSTGRES=1 SCM_ADMIN_RESET_CONFIRM=RESET-admin \
 *   node --env-file=.env.prod --import tsx scripts/reset-admin-emergency.ts
 */
import { hash } from "@node-rs/argon2";
import { eq, sql } from "drizzle-orm";
import { getDbAsync, schema } from "../src/db/index";
import { writeAudit } from "../src/server/core/audit";

async function main(): Promise<void> {
  const composePassword = process.env.POSTGRES_PASSWORD ?? "";
  const databaseUrl = process.env.DATABASE_URL?.trim()
    || (composePassword
      ? `postgres://scm:${encodeURIComponent(composePassword)}@${process.env.SCM_ADMIN_RESET_DB_HOST ?? "127.0.0.1"}:${process.env.SCM_ADMIN_RESET_DB_PORT ?? "15432"}/scm`
      : "");
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) {
    throw new Error("安全拒绝：本命令只允许显式 PostgreSQL DATABASE_URL");
  }
  if (process.env.SCM_ADMIN_RESET_ALLOW_POSTGRES !== "1") {
    throw new Error("安全拒绝：必须显式设置 SCM_ADMIN_RESET_ALLOW_POSTGRES=1");
  }
  if (process.env.SCM_ADMIN_RESET_CONFIRM !== "RESET-admin") {
    throw new Error("安全拒绝：必须显式设置 SCM_ADMIN_RESET_CONFIRM=RESET-admin");
  }

  // getDbAsync 在首次调用时读取 DATABASE_URL；允许直接配合 docker compose 的 .env.prod，
  // 无需把 env 文件当 shell 脚本 source（其中合法的逗号/括号值会被 shell 误执行）。
  process.env.DATABASE_URL = databaseUrl;

  const password = process.env.SCM_ADMIN_RESET_PASSWORD ?? "";
  if (password.length < 8 || password.length > 128) {
    throw new Error("SCM_ADMIN_RESET_PASSWORD 必须为 8–128 位临时口令");
  }
  if (password.toLowerCase().includes("admin")) {
    throw new Error("临时口令不得包含 admin");
  }

  const db = await getDbAsync();
  const passwordHash = await hash(password);
  await db.transaction(async (tx) => {
    const [admin] = await tx
      .select({
        id: schema.users.id,
        active: schema.users.active,
        sessionVersion: schema.users.sessionVersion,
        mustChangePassword: schema.users.mustChangePassword,
      })
      .from(schema.users)
      .where(eq(schema.users.username, "admin"))
      .limit(1);
    if (!admin) throw new Error("数据库中不存在 admin 账号");

    await tx
      .update(schema.users)
      .set({
        passwordHash,
        active: true,
        mustChangePassword: true,
        failedLogins: 0,
        lockedUntil: null,
        sessionVersion: sql`${schema.users.sessionVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, admin.id));

    await writeAudit(tx, {
      userId: admin.id,
      entity: "user",
      entityId: admin.id,
      action: "emergency_password_reset",
      before: {
        active: admin.active,
        mustChangePassword: admin.mustChangePassword,
        sessionVersion: admin.sessionVersion,
      },
      after: {
        active: true,
        mustChangePassword: true,
        sessionVersion: admin.sessionVersion + 1,
        operatorRecovery: true,
      },
    });
  });

  console.log("admin 已恢复；旧会话已失效，下次登录必须立即修改密码。审计已追加。");
}

void main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
