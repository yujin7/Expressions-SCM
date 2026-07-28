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

  it("proves import-job metadata is not exposed through direct API calls", () => {
    const smoke = read("scripts/smoke-e2e.ts");
    expect(smoke).toContain('getJson(null, "/api/import/jobs?pageSize=1")');
    expect(smoke).toContain('getJson(ops, "/api/import/jobs?pageSize=1")');
    expect(smoke).toContain('getJson(admin, "/api/import/jobs?pageSize=1")');
    expect(smoke).toContain("匿名 → /api/import/jobs 应 401");
    expect(smoke).toContain("越权 ops01 → /api/import/jobs 应 403");
  });

  it("covers the quality hub and public electronic-label boundary", () => {
    const smoke = read("scripts/smoke-e2e.ts");
    expect(smoke).toContain('getJson(admin, "/api/quality/cases?page=1&pageSize=1")');
    expect(smoke).toContain('getJson(admin, "/api/quality/regulatory")');
    expect(smoke).toContain('getJson(admin, "/api/quality/labels")');
    expect(smoke).toContain('getJson(null, "/api/quality/cases?pageSize=1")');
    expect(smoke).toContain('getJson(null, "/api/public/e-label/not-a-real-token")');
    expect(smoke).toContain("匿名 → /api/quality/cases 应 401");
    expect(smoke).toContain("无效公开电子标签应 404");
  });

  it("supports distinct administrator and role credentials without embedded defaults", () => {
    const smoke = read("scripts/smoke-e2e.ts");
    const checklist = read("ops/SCM-AUDIT-RELEASE-CHECKLIST.md");
    expect(smoke).toContain("SMOKE_ADMIN_PASSWORD");
    expect(smoke).toContain("SMOKE_ROLE_PASSWORD");
    expect(smoke).toContain("SMOKE_QUALITY_PASSWORD");
    expect(smoke).toContain('"quality01"');
    expect(smoke).toContain('u === "quality01"');
    expect(smoke).toContain('getJson(quality, "/api/quality/cases?page=1&pageSize=1")');
    expect(smoke).toContain('getJson(quality, "/api/admin/users")');
    expect(smoke).toContain("越权 quality01 → /api/admin/users 应 403");
    expect(smoke).not.toContain('?? "admin123"');
    expect(checklist).toContain("SMOKE_ADMIN_PASSWORD");
    expect(checklist).toContain("SMOKE_ROLE_PASSWORD");
    expect(checklist).toContain("SMOKE_QUALITY_PASSWORD");
    expect(checklist).toContain("quality、pmc、finance 七类账号");
  });
});
