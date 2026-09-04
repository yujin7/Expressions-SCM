/**
 * `defaultAssigneeForRole` 是**占位实现**，本套测试钉住的是「当前口径」而不是「最佳口径」。
 *
 * 现状：取该角色里 id 最小的在职账号，永远同一个人。2026-09-05 生产实况——
 * 3 个 pmc 账号、136 条投影待办全落在一个人身上，另外两个的「我的待办」是空的。
 *
 * 不直接改成轮转/最少负载，是因为那是**派工决定**：取决于另外两个 pmc 是不是真的在做计划工作。
 * 若他们其实不看系统，摊派只会把 136 条拆成三份、其中两份没人看，反而藏起工作量。
 * 业务确认后再改；到那天这套测试会红，而那正是它存在的意义——让改动是有意的。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { defaultAssigneeForRole } from "@/server/modules/todo/service";

describe("默认负责人（占位实现）", () => {
  it("永远取该角色里 id 最小的在职账号——没有轮转，没有按负载分配", async () => {
    const { db, client } = await createTestDb();
    try {
      const [first] = await db.insert(schema.users).values({ name: "计划一", roles: ["pmc"] }).returning();
      await db.insert(schema.users).values({ name: "计划二", roles: ["pmc"] });
      await db.insert(schema.users).values({ name: "计划三", roles: ["pmc"] });
      for (let i = 0; i < 3; i++) {
        expect(await defaultAssigneeForRole(db, "pmc"), "三次调用都指向同一个人").toBe(first.id);
      }
    } finally {
      await client.close();
    }
  });

  it("停用最小 id 后顺延到下一个在职账号（停用的人不该继续接活）", async () => {
    const { db, client } = await createTestDb();
    try {
      const [first] = await db.insert(schema.users).values({ name: "计划一", roles: ["pmc"] }).returning();
      const [second] = await db.insert(schema.users).values({ name: "计划二", roles: ["pmc"] }).returning();
      await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, first.id));
      expect(await defaultAssigneeForRole(db, "pmc")).toBe(second.id);
    } finally {
      await client.close();
    }
  });

  it("该角色无人在职时回退到 admin——待办不能因为没人挂靠就静默消失", async () => {
    const { db, client } = await createTestDb();
    try {
      const [admin] = await db.insert(schema.users).values({ name: "管理员", roles: ["admin"] }).returning();
      expect(await defaultAssigneeForRole(db, "pmc")).toBe(admin.id);
    } finally {
      await client.close();
    }
  });
});
