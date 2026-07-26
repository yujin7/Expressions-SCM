import { hash } from "@node-rs/argon2";
import { eq, sql } from "drizzle-orm";
import { getDbAsync, schema } from "../src/db/index";

try {
  process.loadEnvFile?.();
} catch {
  // The caller may provide the required variables directly.
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  if (!databaseUrl.startsWith("pglite:") || process.env.NODE_ENV === "production") {
    throw new Error("安全拒绝：本命令只允许重置本机 PGlite 开发库");
  }

  const password = process.env.SCM_ADMIN_RESET_PASSWORD?.trim();
  if (!password || password.length < 12) {
    throw new Error("请显式设置至少 12 位的 SCM_ADMIN_RESET_PASSWORD");
  }

  const db = await getDbAsync();
  const [admin] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, "admin"))
    .limit(1);
  if (!admin) throw new Error("本地库中不存在 admin 账号");

  await db
    .update(schema.users)
    .set({
      passwordHash: await hash(password),
      mustChangePassword: true,
      failedLogins: 0,
      lockedUntil: null,
      sessionVersion: sql`${schema.users.sessionVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(schema.users.id, admin.id));

  console.log("本地 admin 密码已重置；下次登录必须立即修改密码。");
}

void main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
