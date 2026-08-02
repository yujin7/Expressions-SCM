import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import {
  bindFeishuIdentity,
  listUsers,
  unbindFeishuIdentity,
} from "@/server/modules/admin/users";
import { createTestDb } from "../helpers/db";

const ADMIN = { id: 900, name: "管理员", roles: ["admin"], isApprover: false };
const OPS = { id: 901, name: "运营", roles: ["ops"], isApprover: false };
let userSequence = 0;

async function seedUser(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  values: Partial<typeof schema.users.$inferInsert> = {},
) {
  userSequence += 1;
  const [row] = await db
    .insert(schema.users)
    .values({ username: `feishu-${userSequence}`, name: "测试用户", roles: ["ops"], ...values })
    .returning();
  return row;
}

describe("管理员飞书身份绑定", () => {
  it("只允许 admin，并拒绝空值和超长 union ID", async () => {
    const { db } = await createTestDb();
    const target = await seedUser(db);
    await expect(bindFeishuIdentity(OPS, target.id, { unionId: "ou_denied" }, db)).rejects.toThrow(
      "仅管理员",
    );
    await expect(bindFeishuIdentity(ADMIN, target.id, { unionId: "   " }, db)).rejects.toThrow();
    await expect(bindFeishuIdentity(ADMIN, target.id, { unionId: "x".repeat(129) }, db)).rejects.toThrow();
  });

  it("全局唯一：同一 union ID 不可绑定给第二个用户", async () => {
    const { db } = await createTestDb();
    const first = await seedUser(db);
    const second = await seedUser(db);
    await bindFeishuIdentity(ADMIN, first.id, { unionId: "ou_global_unique" }, db);
    await expect(
      bindFeishuIdentity(ADMIN, second.id, { unionId: "ou_global_unique" }, db),
    ).rejects.toThrow("已绑定其他用户");
    const [after] = await db.select().from(schema.users).where(eq(schema.users.id, second.id));
    expect(after.feishuUnionId).toBeNull();
  });

  it("停用或不存在的用户无法绑定或解绑", async () => {
    const { db } = await createTestDb();
    const inactive = await seedUser(db, { active: false, feishuUnionId: "ou_inactive" });
    await expect(bindFeishuIdentity(ADMIN, inactive.id, { unionId: "ou_new" }, db)).rejects.toThrow("停用用户");
    await expect(unbindFeishuIdentity(ADMIN, inactive.id, db)).rejects.toThrow("停用用户");
    await expect(bindFeishuIdentity(ADMIN, 999_999, { unionId: "ou_missing" }, db)).rejects.toThrow("用户不存在");
    await expect(unbindFeishuIdentity(ADMIN, 999_999, db)).rejects.toThrow("用户不存在");
  });

  it("不允许管理员解绑自己的唯一登录方式", async () => {
    const { db } = await createTestDb();
    const target = await seedUser(db, {
      id: ADMIN.id,
      roles: ["admin"],
      feishuUnionId: "ou_admin_only_login",
      passwordHash: null,
    });
    await expect(unbindFeishuIdentity(ADMIN, target.id, db)).rejects.toThrow("唯一登录方式");
    const [after] = await db.select().from(schema.users).where(eq(schema.users.id, target.id));
    expect(after.feishuUnionId).toBe("ou_admin_only_login");

    const noUsername = await seedUser(db, {
      id: ADMIN.id + 1,
      username: null,
      roles: ["admin"],
      feishuUnionId: "ou_admin_without_username",
      passwordHash: "configured-hash",
    });
    await expect(unbindFeishuIdentity(
      { ...ADMIN, id: noUsername.id },
      noUsername.id,
      db,
    )).rejects.toThrow("唯一登录方式");
  });

  it("绑定/解绑重放幂等：只改一次会话版本、只各记一条审计", async () => {
    const { db } = await createTestDb();
    const target = await seedUser(db);
    const first = await bindFeishuIdentity(ADMIN, target.id, { unionId: "  ou_replay  " }, db);
    const replay = await bindFeishuIdentity(ADMIN, target.id, { unionId: "ou_replay" }, db);
    expect(first.feishuBound).toBe(true);
    expect(replay.feishuBound).toBe(true);

    let [stored] = await db.select().from(schema.users).where(eq(schema.users.id, target.id));
    expect(stored.sessionVersion).toBe(target.sessionVersion + 1);
    expect(stored.feishuUnionId).toBe("ou_replay");

    await unbindFeishuIdentity(ADMIN, target.id, db);
    await unbindFeishuIdentity(ADMIN, target.id, db);
    [stored] = await db.select().from(schema.users).where(eq(schema.users.id, target.id));
    expect(stored.sessionVersion).toBe(target.sessionVersion + 2);
    expect(stored.feishuUnionId).toBeNull();

    const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entityId, target.id));
    expect(logs.map((row) => row.action)).toEqual(["bind_feishu_identity", "unbind_feishu_identity"]);
    expect(JSON.stringify(logs)).not.toContain("ou_replay");
    const [bindLog, unbindLog] = logs;
    expect((bindLog.after as Record<string, unknown>).bindingFingerprint).toMatch(/^[a-f0-9]{20}$/);
    expect((unbindLog.before as Record<string, unknown>).bindingFingerprint).toBe(
      (bindLog.after as Record<string, unknown>).bindingFingerprint,
    );
  });

  it("审计写入失败时回滚绑定和会话版本", async () => {
    const { db, client } = await createTestDb();
    const target = await seedUser(db);
    await client.exec(`
      CREATE FUNCTION reject_test_feishu_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.entity = 'user' AND NEW.action = 'bind_feishu_identity' THEN
          RAISE EXCEPTION 'forced audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_test_feishu_audit
      BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION reject_test_feishu_audit();
    `);

    await expect(bindFeishuIdentity(ADMIN, target.id, { unionId: "ou_rollback" }, db)).rejects.toThrow();
    const [after] = await db.select().from(schema.users).where(eq(schema.users.id, target.id));
    expect(after.feishuUnionId).toBeNull();
    expect(after.sessionVersion).toBe(target.sessionVersion);
  });

  it("列表 DTO 只暴露绑定状态，不暴露 union ID", async () => {
    const { db } = await createTestDb();
    await seedUser(db, { feishuUnionId: "ou_never_serialize" });
    const rows = await listUsers(db);
    expect(rows.some((row) => row.feishuBound)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("ou_never_serialize");
    expect(rows.every((row) => !("feishuUnionId" in row))).toBe(true);
  });

  it("数据库故障错误不包含 union ID，避免通过 500 日志泄漏", async () => {
    const { db, client } = await createTestDb();
    const target = await seedUser(db);
    const unionId = "ou_must_never_reach_error_logs";
    await client.exec(`
      CREATE FUNCTION reject_test_feishu_user_update() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced user update failure';
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_test_feishu_user_update_trigger
      BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION reject_test_feishu_user_update();
    `);

    let caught: unknown;
    try {
      await bindFeishuIdentity(ADMIN, target.id, { unionId }, db);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toContain("数据库操作失败");
    expect(JSON.stringify({
      message: (caught as Error).message,
      stack: (caught as Error).stack,
    })).not.toContain(unionId);
  });
});
