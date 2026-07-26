import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("CRUD 编辑不得用列表行覆盖完整主数据", () => {
  it("通用表格支持详情读取，供应商与仓库均显式启用", () => {
    const root = resolve(process.cwd());
    const crud = readFileSync(resolve(root, "src/components/CrudTable.tsx"), "utf8");
    const supplier = readFileSync(
      resolve(root, "src/app/(app)/master/supplier/supplier-client.tsx"),
      "utf8",
    );
    const warehouse = readFileSync(
      resolve(root, "src/app/(app)/master/warehouse/warehouse-client.tsx"),
      "utf8",
    );

    expect(crud).toContain("loadDetailOnEdit");
    expect(crud).toContain("await fetchJson<T>(`${apiPath}/${record.id}`)");
    expect(supplier).toMatch(/<CrudTable<SupplierRow>[\s\S]*?loadDetailOnEdit/);
    expect(warehouse).toMatch(/<CrudTable<WarehouseRow>[\s\S]*?loadDetailOnEdit/);
    expect(warehouse).toContain('name="parentId"');
  });
});
