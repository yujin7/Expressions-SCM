/**
 * 给已建账号批量设置初始密码，并强制首次登录修改。
 *
 * `DATABASE_URL=... npx tsx scripts/set-initial-passwords.ts`
 *
 * 用途：系统刚部署好、需要把账号发给同事时用一次。
 *
 * 纪律：
 *  - 每个账号**各自独立**的随机密码，不共用一个——共用等于没有账号隔离，
 *    一个人泄露全员沦陷，事后也分不清是谁操作的；
 *  - 一律置 `mustChangePassword=true`，首登强制改，初始密码只是一次性通行证；
 *  - 密码只打印到标准输出，**不写任何文件**，避免留在仓库或备份里。
 */
import { hash } from "@node-rs/argon2";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { randomInt } from "node:crypto";
import * as schema from "../src/db/schema";

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // 去掉 l/o/0/1 等易混字符
const WORDS = ["Scm", "Plan", "Ship", "Stock", "Flow", "Batch"];

function makePassword(): string {
  const word = WORDS[randomInt(WORDS.length)];
  let tail = "";
  for (let i = 0; i < 10; i++) tail += ALPHABET[randomInt(ALPHABET.length)];
  return `${word}-${tail}`;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url?.startsWith("postgres")) {
    console.error("需要 PostgreSQL 的 DATABASE_URL");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });

  const users = await db
    .select({ id: schema.users.id, username: schema.users.username, name: schema.users.name })
    .from(schema.users)
    .orderBy(schema.users.id);

  if (users.length === 0) {
    console.error("没有账号——先跑 npm run db:seed");
    process.exit(1);
  }

  const rows: { username: string; name: string; password: string }[] = [];
  for (const user of users) {
    const password = makePassword();
    await db.update(schema.users)
      .set({ passwordHash: await hash(password), mustChangePassword: true })
      .where(eq(schema.users.id, user.id));
    // username 在 schema 里可空（本地账号兜底），name 才是 notNull
    rows.push({ username: user.username ?? `#${user.id}`, name: user.name, password });
  }

  const width = Math.max(...rows.map((r) => r.username.length), 8);
  console.log("\n账号一览（每个账号密码独立；首次登录会强制要求修改）\n");
  console.log(`${"用户名".padEnd(width + 2)}${"姓名".padEnd(12)}初始密码`);
  console.log("-".repeat(width + 2 + 12 + 16));
  for (const r of rows) {
    console.log(`${r.username.padEnd(width + 2)}${r.name.padEnd(12)}${r.password}`);
  }
  console.log("\n⚠ 这些是一次性初始密码：请分别发给对应的人，不要群发同一份清单——");
  console.log("  账号隔离的意义就在于事后能分清谁做了什么。首登强制改密已开启。\n");

  await pool.end();
}

void main().catch((error) => {
  console.error("失败：", (error as Error).message);
  process.exit(1);
});
