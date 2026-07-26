import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

describe("release smoke data contract", () => {
  it("seeds one idempotent PO detail with a real price field", () => {
    const seed = read("src/db/seed.ts");

    expect(seed).toContain('const smokePoDocNo = "PO-SEED-0001"');
    expect(seed).toContain("eq(schema.poDocs.docNo, smokePoDocNo)");
    expect(seed).toContain("eq(schema.poLines.poId, smokePo.id)");
    expect(seed).toContain('price: "3000.00"');
  });

  it("compares admin and operations payloads for the same PO detail", () => {
    const smoke = read("scripts/smoke-e2e.ts");

    expect(smoke).toContain("getJson(admin, `/api/outsource/po/${poId}`)");
    expect(smoke).toContain("getJson(ops, `/api/outsource/po/${poId}`)");
    expect(smoke).toContain('if (!adminHasPrice)');
    expect(smoke).toContain('else if (opsHasPrice)');
    expect(smoke).not.toContain("列表层无price字段");
  });
});
