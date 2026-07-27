import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("SKU 成本导入边界", () => {
  it("适配器只能写 staging，不能直接碰财务成本表", () => {
    const source = read("src/server/import/adapters/sku-cost.ts");
    expect(source).toContain("stagePipeline");
    expect(source).not.toMatch(/insert\s*\(\s*schema\.skuCosts/);
    expect(source).not.toMatch(/update\s*\(\s*schema\.skuCosts/);
  });

  it("正式成本写入集中在财务放行服务，并同时具备权限、事务和审计", () => {
    const source = read("src/server/modules/release/engine/sku-costs.ts");
    expect(source).toContain('requireAnyRole(user, "finance")');
    expect(source).toContain("assertImportPreflight");
    expect(source).toContain("db.transaction");
    expect(source).toContain("writeAudit");
    expect(source).toContain("commitRows");
  });

  it("财务角色同时拥有上传、任务和放行入口；PMC 不因页面可见获得成本写权", () => {
    const uploadRoute = read("src/app/api/import/upload/route.ts");
    const shell = read("src/components/AppShell.tsx");
    const palette = read("src/components/CommandPalette.tsx");
    const releasePage = read("src/app/(app)/import/release/page.tsx");
    expect(uploadRoute).toContain('v.template === "sku_cost"');
    expect(uploadRoute).toContain('requireAnyRole(user, "finance")');
    expect(shell).toContain('"/import/upload": ["pmc", "finance"]');
    expect(shell).toContain('"/import/release": ["pmc", "finance"]');
    expect(palette).toContain('roles: ["pmc","finance"]');
    expect(releasePage).toContain('"finance"');
  });
});
