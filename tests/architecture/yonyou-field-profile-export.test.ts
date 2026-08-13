import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("用友字段映射评审导出边界", () => {
  it("路由必须新鲜回查管理员身份，且禁止缓存", () => {
    const route = readFileSync(
      "src/app/api/admin/health/connector-runs/[id]/field-profile/route.ts",
      "utf8",
    );
    expect(route).toContain("getFreshSessionUser()");
    expect(route).toContain("guardAdmin(user)");
    expect(route).toContain('"Cache-Control": "private, no-store, max-age=0"');
    expect(route).toContain('"X-Content-Type-Options": "nosniff"');
    expect(route).toContain("toCsv(rows, COLUMNS)");
    expect(route).not.toContain("requestScope");
    expect(route).not.toContain("stagingRows");
    expect(route).not.toContain("evidencePath");
  });
});
