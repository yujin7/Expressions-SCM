import { beforeAll, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { listPos } from "@/server/modules/outsource/po";
import { poDocs, suppliers, users } from "@/db/schema";
let db: TestDb, eligible: number, draft: number;
beforeAll(async () => {
  ({ db } = await createTestDb());
  const [u] = await db.insert(users).values({ name: "options-only", roles: ["warehouse"] }).returning();
  const [s] = await db.insert(suppliers).values({ code: "OPTS", name: "候选测试", kinds: ["raw"] }).returning();
  const rows = await db.insert(poDocs).values([
    { docNo: "PO-OLD-ELIGIBLE", supplierId: s.id, createdBy: u.id, status: "completed" as const },
    ...Array.from({ length: 501 }, (_, i) => ({ docNo: `PO-DRAFT-${i}`, supplierId: s.id, createdBy: u.id, status: "draft" as const })),
  ]).returning(); eligible = rows[0].id; draft = rows[1].id;
});
it("eligible purchase options filter before pagination, so older completed orders remain discoverable", async () => {
  const opts = { page: 1, pageSize: 50, returnEligible: true };
  const result = await listPos("", opts, db); expect(result.total).toBe(1); expect(result.rows).toMatchObject([{ id: eligible }]);
});
it("selected identity lookup is exact and intersects eligibility", async () => {
  const opts = { page: 9, pageSize: 1, returnEligible: true, selectedValues: [eligible, draft] };
  const result = await listPos("", opts, db); expect(result.total).toBe(1); expect(result.rows).toMatchObject([{ id: eligible }]);
  expect((await listPos("", { ...opts, selectedValues: [] }, db)).total).toBe(0);
});
