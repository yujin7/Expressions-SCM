import { describe, expect, it } from "vitest";
import { channels } from "@/db/schema";
import { listChannels } from "@/server/modules/master/channel";
import { createTestDb } from "../helpers/db";

describe("渠道主数据列表", () => {
  it("按编码稳定分页，返回真实总数与最小选项 DTO", async () => {
    const { db } = await createTestDb();
    await db.insert(channels).values([
      { code: "vip", name: "唯品会", kind: "platform", active: false },
      { code: "tmall", name: "天猫", kind: "platform" },
      { code: "biz", name: "业务部", kind: "dept" },
    ]);

    const result = await listChannels("", 2, 2, db);

    expect(result.total).toBe(3);
    expect(result.data).toEqual([
      { id: expect.any(Number), code: "vip", name: "唯品会", kind: "platform", active: false },
    ]);
    expect(Object.keys(result.data[0]).sort()).toEqual(["active", "code", "id", "kind", "name"]);
  });

  it("编码或中文名都可搜索，停用渠道不会从存量 SKU 编辑中消失", async () => {
    const { db } = await createTestDb();
    await db.insert(channels).values([
      { code: "tmall", name: "天猫", kind: "platform" },
      { code: "vip", name: "唯品会", kind: "platform", active: false },
    ]);

    await expect(listChannels("TM", 1, 20, db)).resolves.toMatchObject({
      total: 1,
      data: [{ code: "tmall", name: "天猫", active: true }],
    });
    await expect(listChannels("唯品", 1, 20, db)).resolves.toMatchObject({
      total: 1,
      data: [{ code: "vip", name: "唯品会", active: false }],
    });
  });
});
