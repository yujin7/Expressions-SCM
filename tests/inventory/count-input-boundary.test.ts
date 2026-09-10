import { expect, it } from "vitest";
import { createCountTaskSchema, updateCountsSchema, listCountTasks, listCountLinesForExport } from "@/server/modules/inventory/count";
import type { AnyDb } from "@/server/core/svc";

it.each(["2026-02-30", "2026-02-29", "2026-04-31", "2026-13-01", "0000-01-01"])("rejects nonexistent count date %s before writing", bizDate => {
  expect(createCountTaskSchema.safeParse({ warehouseId: 1, mode: "full", bizDate }).success).toBe(false);
});
it.each(["2024-02-29", "2026-02-28", "2026-12-31"])("preserves valid count date %s", bizDate => {
  expect(createCountTaskSchema.parse({ warehouseId: 1, mode: "full", bizDate }).bizDate).toBe(bizDate);
});
it.each(["2026-13", "2026-00", "2026-2", "0000-01", "2026-02-28", "invalid"])("list and export reject invalid period %s before querying", async period => {
  const noDb = {} as AnyDb;
  await expect(listCountTasks("", { period, page: 1, pageSize: 20 }, noDb)).rejects.toMatchObject({ status: 400 });
  await expect(listCountLinesForExport({ period, limit: 5000 }, noDb)).rejects.toMatchObject({ status: 400 });
});
it.each(["0.1", "0.4"])("duplicate count line is refused even when second value is %s", second => {
  const result = updateCountsSchema.safeParse({ version: 1, lines: [{ lineId: 2, countedQty: "0.1" }, { lineId: 2, countedQty: second }] });
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["lines", 1, "lineId"], message: expect.stringContaining("重复") }));
});
