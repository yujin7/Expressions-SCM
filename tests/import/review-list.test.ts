import { describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { listExceptions } from "@/server/modules/import-review/service";
import { createTestDb } from "../helpers/db";

describe("别名异常精准定位", () => {
  it("按来源、类型和完整原始值精确筛选，不混入相似条码", async () => {
    const { db, client } = await createTestDb();
    try {
      await db.insert(schema.aliasExceptions).values([
        { aliasType: "sku_barcode", scope: "JIANDAOYUN", rawValue: "690000000001", status: "open" },
        { aliasType: "sku_barcode", scope: "JIANDAOYUN", rawValue: "6900000000019", status: "open" },
        { aliasType: "sku_barcode", scope: "JST", rawValue: "690000000001", status: "open" },
      ]);

      const result = await listExceptions({
        status: "open",
        aliasType: "sku_barcode",
        scope: "JIANDAOYUN",
        rawValue: " 690000000001 ",
        page: 1,
        pageSize: 20,
      }, db);

      expect(result.total).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(result.data[0]).toMatchObject({
        scope: "JIANDAOYUN",
        aliasType: "sku_barcode",
        rawValue: "690000000001",
      });
    } finally {
      await client.close();
    }
  });
});
