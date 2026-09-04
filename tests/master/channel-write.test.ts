/**
 * 渠道主数据写路径（2026-09-04 审计 #11）。
 *
 * 事故形态：`channels` 唯一的写入者是 seed，而 SKU 主档、周期补录、分层、驾驶舱等
 * 六个页面都拿它当选择器。业务新开一个店或一个部门，只能等人改 seed 重播数据库——
 * 渠道维在生产上是冻结的。
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLogs, channels, users } from "@/db/schema";
import { createChannel, getChannel, listChannels, updateChannel } from "@/server/modules/master/channel";
import type { SessionUser } from "@/server/core/dto";
import { createTestDb } from "../helpers/db";

async function world() {
  const { db } = await createTestDb();
  const [u] = await db.insert(users).values({ name: "计划", roles: ["pmc"], isApprover: false }).returning();
  const actor: SessionUser = { id: u.id, name: u.name, roles: ["pmc"], isApprover: false };
  return { db, actor };
}

describe("#11 渠道主数据写路径", () => {
  it("新建：落库 + 同事务审计；重复编码 409", async () => {
    const { db, actor } = await world();
    const created = await createChannel({ code: "douyin", name: "抖音", kind: "platform" }, actor, db);
    expect(created).toMatchObject({ code: "douyin", name: "抖音", kind: "platform", active: true });

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entity, "channel"));
    expect(audits, "写路径必须在同一事务留审计").toHaveLength(1);
    expect(audits[0].action).toBe("create");
    expect(audits[0].entityId).toBe(created.id);

    await expect(
      createChannel({ code: "douyin", name: "抖音二店", kind: "platform" }, actor, db),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("入参校验：编码格式、类型枚举、必填", async () => {
    const { db, actor } = await world();
    await expect(createChannel({ code: "抖音", name: "抖音", kind: "platform" }, actor, db)).rejects.toThrow();
    await expect(createChannel({ code: "ok", name: "", kind: "platform" }, actor, db)).rejects.toThrow();
    await expect(createChannel({ code: "ok", name: "渠道", kind: "shop" }, actor, db)).rejects.toThrow();
  });

  it("改名与启停：留审计 before/after；编码不可改（改码=改身份）", async () => {
    const { db, actor } = await world();
    const created = await createChannel({ code: "biz", name: "企业购", kind: "dept" }, actor, db);

    const renamed = await updateChannel(created.id, { name: "企业团购" }, actor, db);
    expect(renamed.name).toBe("企业团购");
    expect(renamed.kind, "未传的字段保持原值").toBe("dept");

    const off = await updateChannel(created.id, { active: false }, actor, db);
    expect(off.active).toBe(false);
    const on = await updateChannel(created.id, { active: true }, actor, db);
    expect(on.active).toBe(true);

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entity, "channel"));
    expect(audits).toHaveLength(4); // create + rename + 停用 + 启用
    const last = audits[audits.length - 1];
    expect(last.action).toBe("activate");
    expect(last.before).toMatchObject({ active: false });
    expect(last.after).toMatchObject({ active: true });

    // CrudTable 会回传整行；同值 code 属正常，改码才拒
    await expect(updateChannel(created.id, { code: "biz", name: "企业团购" }, actor, db)).resolves.toBeTruthy();
    await expect(updateChannel(created.id, { code: "biz2", name: "企业团购" }, actor, db)).rejects.toMatchObject({ status: 409 });
    const [row] = await db.select().from(channels).where(eq(channels.id, created.id));
    expect(row.code, "编码必须纹丝不动").toBe("biz");
  });

  it("停用不是删除：停用渠道仍出现在列表里（存量 SKU 还引用着它）", async () => {
    const { db, actor } = await world();
    const created = await createChannel({ code: "old", name: "旧渠道", kind: "platform" }, actor, db);
    await updateChannel(created.id, { active: false }, actor, db);
    const list = (await listChannels("", 1, 50, db)) as { data: { code: string; active: boolean }[] };
    expect(list.data.map((r) => r.code)).toContain("old");
    expect(list.data.find((r) => r.code === "old")?.active).toBe(false);
  });

  it("不存在的 id：读与写都是 404，不是 500", async () => {
    const { db, actor } = await world();
    await expect(getChannel(999999, db)).rejects.toMatchObject({ status: 404 });
    await expect(updateChannel(999999, { name: "x" }, actor, db)).rejects.toMatchObject({ status: 404 });
  });

  it("至少要传一个可改字段（空请求体不该被当成一次「什么都没改」的成功）", async () => {
    const { db, actor } = await world();
    const created = await createChannel({ code: "tmp", name: "临时", kind: "platform" }, actor, db);
    await expect(updateChannel(created.id, {}, actor, db)).rejects.toThrow();
  });
});
