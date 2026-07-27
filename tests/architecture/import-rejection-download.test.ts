import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("导入拒收明细能力的端到端可达性护栏", () => {
  it("新任务的统一 finalize/fail 收口都会生成拒收明细", () => {
    const staging = read("src/server/import/staging.ts");
    expect(staging).toContain("createImportRejectionArtifact");
    expect(staging.match(/createImportRejectionArtifact/g)).toHaveLength(3);
    expect(staging).toContain("errorFile");
  });

  it("列表、展开、生成和下载均回查新鲜角色，下载只能走受控存储解析器", () => {
    const listRoute = read("src/app/api/import/jobs/route.ts");
    const summaryRoute = read("src/app/api/import/jobs/[id]/route.ts");
    const errorRoute = read("src/app/api/import/jobs/[id]/errors/route.ts");
    const client = read("src/app/(app)/import/jobs/jobs-client.tsx");
    for (const source of [listRoute, summaryRoute, errorRoute]) {
      expect(source).toContain("guardFreshWrite");
    }
    expect(errorRoute).toContain("getAuthorizedImportJob");
    expect(errorRoute).toContain("resolveImportRejectionArtifact");
    expect(errorRoute).toContain('"Cache-Control": "private, no-store"');
    expect(client).toContain("/errors");
    expect(client).toContain("生成");
    expect(client).toContain("下载");
  });
});
