import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(path, "utf8");

const SURFACES = [
  {
    route: "src/app/api/report/inbound-calendar/route.ts",
    client: "src/app/(app)/report/inbound-calendar/inbound-calendar-client.tsx",
    product: "supply-commitment",
  },
  {
    route: "src/app/api/report/inventory-analytics/route.ts",
    client: "src/app/(app)/report/inventory-analytics/inventory-analytics-client.tsx",
    product: "unified-inventory",
  },
  {
    route: "src/app/api/report/supplier-scorecard/route.ts",
    client: "src/app/(app)/report/supplier-scorecard/supplier-scorecard-client.tsx",
    product: "supplier-360",
  },
  {
    route: "src/app/api/npd/projects/route.ts",
    client: "src/app/(app)/npd/npd-projects-client.tsx",
    product: "launch-readiness",
  },
] as const;

describe("三方决策证据业务表面", () => {
  it.each(SURFACES)("$product 由服务端装配安全摘要并在业务页直接显示", ({ route, client, product }) => {
    expect(read(route)).toContain(`buildProductExternalDecisionEvidenceBrief("${product}"`);
    expect(read(client)).toContain("ProductExternalDecisionEvidenceCard");
    expect(read(client)).toContain("externalDecisionEvidence");
  });

  it("库存图表副请求不重复装配同一份三方门禁", () => {
    expect(read("src/app/(app)/report/inventory-analytics/inventory-analytics-client.tsx"))
      .toContain('includeExternalEvidence: "0"');
    expect(read("src/app/api/report/inventory-analytics/route.ts"))
      .toContain('searchParams.get("includeExternalEvidence") !== "0"');
  });
});
