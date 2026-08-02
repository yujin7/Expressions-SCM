import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { ignoreException } from "@/server/modules/import-review/service";
import { ApiError } from "@/server/modules/master/common";
import { createTestDb } from "../helpers/db";

describe("ignoreException 原子状态转移", () => {
  it("并发忽略只有一个成功，且只产生一条审计", async () => {
    const { db } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "异常复核人" }).returning();
    const user: SessionUser = {
      id: actor.id,
      name: actor.name,
      roles: ["pmc"],
      isApprover: false,
    };
    const [exception] = await db
      .insert(schema.aliasExceptions)
      .values({ aliasType: "sku_code", rawValue: "DUP-IGNORE", context: { row: 1 } })
      .returning();

    const results = await Promise.allSettled([
      ignoreException(user, exception.id, "第一个请求", db),
      ignoreException(user, exception.id, "并发请求", db),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [rejected] = results.filter((result) => result.status === "rejected");
    expect(rejected).toBeDefined();
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(ApiError);
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ status: 409 });

    const [after] = await db
      .select()
      .from(schema.aliasExceptions)
      .where(eq(schema.aliasExceptions.id, exception.id));
    expect(after).toMatchObject({ status: "ignored", resolvedBy: actor.id });
    expect(after.resolvedAt).not.toBeNull();
    const audits = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.entityId, exception.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entity: "alias_exception",
      action: "ignore",
      userId: actor.id,
    });
  });

  it("审计写失败时回滚 ignored 状态，不留未审计的半步成功", async () => {
    const { db } = await createTestDb();
    const [actor] = await db.insert(schema.users).values({ name: "回滚验证人" }).returning();
    const user: SessionUser = {
      id: actor.id,
      name: actor.name,
      roles: ["pmc"],
      isApprover: false,
    };
    const [exception] = await db
      .insert(schema.aliasExceptions)
      .values({ aliasType: "warehouse", rawValue: "ROLLBACK-IGNORE" })
      .returning();

    const failingAuditDb = {
      transaction: (callback: (tx: unknown) => Promise<unknown>) => db.transaction(async (tx) => {
        const txWithFailingAudit = new Proxy(tx, {
          get(target, property, receiver) {
            if (property === "insert") {
              return () => {
                throw new Error("模拟审计写入失败");
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return callback(txWithFailingAudit);
      }),
    };

    await expect(
      ignoreException(user, exception.id, "应当回滚", failingAuditDb),
    ).rejects.toThrow("模拟审计写入失败");

    const [after] = await db
      .select()
      .from(schema.aliasExceptions)
      .where(eq(schema.aliasExceptions.id, exception.id));
    expect(after).toMatchObject({ status: "open", resolvedBy: null, resolvedAt: null });
    expect(await db.select().from(schema.auditLogs)).toHaveLength(0);
  });
});
