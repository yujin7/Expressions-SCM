import React from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import SupplierPage from "@/app/(app)/master/supplier/page";

vi.mock("@/app/(app)/master/supplier/supplier-client", () => ({ default: "supplier-client" }));
beforeAll(() => vi.stubGlobal("React", React));
afterAll(() => vi.unstubAllGlobals());

describe("supplier search deep-link boundary", () => {
  const cases: [{ q?: string | string[] }, string][] = [
    [{ q: " QA-SPIKE-SUP " }, "QA-SPIKE-SUP"],
    [{}, ""],
    [{ q: ["SUP001", "SUP002"] }, "SUP001"],
    [{ q: [] }, ""],
  ];
  it.each(cases)("passes the URL query to the client: %j", async (params, expected) => {
    const tree = await SupplierPage({ searchParams: Promise.resolve(params) });
    expect(tree.props.initialQuery).toBe(expected);
  });
  it("resets the table for a new navigation query and initializes visible and submitted search equally", () => {
    const client = readFileSync("src/app/(app)/master/supplier/supplier-client.tsx", "utf8");
    const table = readFileSync("src/components/CrudTable.tsx", "utf8");
    expect(client).toMatch(/<CrudTable<SupplierRow>\s+key=\{initialQuery\}\s+initialQuery=\{initialQuery\}/);
    expect(table).toContain("const [q, setQ] = useState(initialQuery)");
    expect(table).toMatch(/<SearchInput\s+defaultValue=\{initialQuery\}/);
  });
});
