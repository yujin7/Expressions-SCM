/**
 * 自助改密码 + 首登强制修改（UAT 缺口 #1）：
 * - 原密码错 → 400；新=旧 → 400；短密码 → zod 拒绝；
 * - 成功后 mustChangePassword/failedLogins/lockedUntil 清除，新哈希可 verify；
 * - createUser 恒置 mustChangePassword=true；updateUser 重置密码亦置 true；
 * - 审计不落任何密码材料。
 */
import { describe, it, expect } from "vitest";
import { hash, verify } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/db";
import * as schema from "@/db/schema";
import { changeOwnPassword, createUser, updateUser } from "@/server/modules/admin/users";

const ADMIN = { id: 999, name: "管理员", roles: ["admin"], isApprover: false };

async function seedUser(db: Awaited<ReturnType<typeof createTestDb>>["db"], password: string) {
  const [u] = await db
    .insert(schema.users)
    .values({
      username: "tester01",
      name: "测试员",
      passwordHash: await hash(password),
      roles: ["ops"],
      mustChangePassword: true,
      failedLogins: 3,
      lockedUntil: new Date(Date.now() + 60_000),
    })
    .returning();
  return u;
}

describe("changeOwnPassword", () => {
  it("原密码错误 → 400，不改任何状态", async () => {
    const { db } = await createTestDb();
    const u = await seedUser(db, "oldpass123");
    await expect(
      changeOwnPassword(u.id, { oldPassword: "wrongpass", newPassword: "newpass456" }, db),
    ).rejects.toThrow("原密码不正确");
    const [after] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(after.mustChangePassword).toBe(true);
    expect(await verify(after.passwordHash!, "oldpass123")).toBe(true);
  });

  it("新密码与原密码相同 → 400", async () => {
    const { db } = await createTestDb();
    const u = await seedUser(db, "oldpass123");
    await expect(
      changeOwnPassword(u.id, { oldPassword: "oldpass123", newPassword: "oldpass123" }, db),
    ).rejects.toThrow("不能与原密码相同");
  });

  it("新密码不足 8 位 → zod 拒绝", async () => {
    const { db } = await createTestDb();
    const u = await seedUser(db, "oldpass123");
    await expect(
      changeOwnPassword(u.id, { oldPassword: "oldpass123", newPassword: "short" }, db),
    ).rejects.toThrow();
  });

  it("成功：新哈希生效，mustChangePassword/failedLogins/lockedUntil 清除，审计无密码材料", async () => {
    const { db } = await createTestDb();
    const u = await seedUser(db, "oldpass123");
    await changeOwnPassword(u.id, { oldPassword: "oldpass123", newPassword: "newpass456" }, db);

    const [after] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(after.mustChangePassword).toBe(false);
    expect(after.failedLogins).toBe(0);
    expect(after.lockedUntil).toBeNull();
    expect(after.sessionVersion).toBe(u.sessionVersion + 1);
    expect(await verify(after.passwordHash!, "newpass456")).toBe(true);
    expect(await verify(after.passwordHash!, "oldpass123")).toBe(false);

    const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "user"));
    const log = logs.find((l) => l.action === "change_password");
    expect(log).toBeTruthy();
    expect(log!.userId).toBe(u.id);
    const dumped = JSON.stringify({ before: log!.before, after: log!.after });
    expect(dumped).not.toContain("oldpass123");
    expect(dumped).not.toContain("newpass456");
    expect(dumped.toLowerCase()).not.toContain("hash");
  });

  it("停用账号 → 401", async () => {
    const { db } = await createTestDb();
    const u = await seedUser(db, "oldpass123");
    await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, u.id));
    await expect(
      changeOwnPassword(u.id, { oldPassword: "oldpass123", newPassword: "newpass456" }, db),
    ).rejects.toThrow();
  });
});

describe("mustChangePassword 置位", () => {
  it("createUser 新账号恒 mustChangePassword=true（UserRow 暴露该位）", async () => {
    const { db } = await createTestDb();
    const row = await createUser(
      ADMIN,
      { username: "newbie01", name: "新人", password: "initpass99", roles: ["ops"], isApprover: false },
      db,
    );
    expect(row.mustChangePassword).toBe(true);
  });

  it("updateUser 重置密码 → mustChangePassword=true；不重置密码不影响该位", async () => {
    const { db } = await createTestDb();
    const u = await seedUser(db, "oldpass123");
    await changeOwnPassword(u.id, { oldPassword: "oldpass123", newPassword: "newpass456" }, db); // → false
    const noPw = await updateUser(ADMIN, u.id, { name: "改名" }, db);
    expect(noPw.mustChangePassword).toBe(false);
    const [afterRename] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(afterRename.sessionVersion).toBe(1);
    const reset = await updateUser(ADMIN, u.id, { password: "resetpass77" }, db);
    expect(reset.mustChangePassword).toBe(true);
    const [afterReset] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(afterReset.sessionVersion).toBe(2);
  });

  it("角色、审批权和停用变化均使旧会话失效；仅改名不递增", async () => {
    const { db } = await createTestDb();
    const u = await seedUser(db, "oldpass123");
    await updateUser(ADMIN, u.id, { name: "只改名" }, db);
    let [after] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(after.sessionVersion).toBe(0);
    await updateUser(ADMIN, u.id, { roles: ["finance"] }, db);
    [after] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(after.sessionVersion).toBe(1);
    await updateUser(ADMIN, u.id, { isApprover: true }, db);
    [after] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(after.sessionVersion).toBe(2);
    await updateUser(ADMIN, u.id, { active: false }, db);
    [after] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(after.sessionVersion).toBe(3);
  });
});
