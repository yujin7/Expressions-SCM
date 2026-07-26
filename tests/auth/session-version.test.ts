import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../helpers/db";
import { users } from "@/db/schema";
import { refreshSessionIdentity } from "@/server/auth/session-version";

describe("session version", () => {
  it("版本一致时刷新姓名、角色和审批权", async () => {
    const { db } = await createTestDb();
    const [u] = await db.insert(users).values({
      username: "session-ok",
      name: "新姓名",
      roles: ["finance"],
      isApprover: true,
      sessionVersion: 3,
    }).returning();
    const refreshed = await refreshSessionIdentity({
      userId: u.id,
      sessionVersion: 3,
      name: "旧姓名",
      roles: ["ops"],
      isApprover: false,
    }, db);
    expect(refreshed).toMatchObject({
      userId: u.id,
      sessionVersion: 3,
      name: "新姓名",
      roles: ["finance"],
      isApprover: true,
    });
  });

  it("旧 token、缺版本 token、停用或删除用户全部失效", async () => {
    const { db } = await createTestDb();
    const [u] = await db.insert(users).values({
      username: "session-stale",
      name: "测试",
      roles: ["ops"],
      sessionVersion: 2,
    }).returning();
    expect(await refreshSessionIdentity({ userId: u.id, sessionVersion: 1 }, db)).toBeNull();
    expect(await refreshSessionIdentity({ userId: u.id }, db)).toBeNull();
    await db.update(users).set({ active: false }).where(eq(users.id, u.id));
    expect(await refreshSessionIdentity({ userId: u.id, sessionVersion: 2 }, db)).toBeNull();
    expect(await refreshSessionIdentity({ userId: 999999, sessionVersion: 0 }, db)).toBeNull();
  });
});
