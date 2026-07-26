import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

describe("shared layout regressions", () => {
  it("keeps nested expanded-table headers inside their clipping viewport", () => {
    const styles = read("src/app/globals.css");

    expect(styles).toContain(
      ".app-surface .ant-table-wrapper .ant-table-expanded-row .ant-table-wrapper .ant-table",
    );
    expect(styles).toMatch(
      /\.app-surface \.ant-table-wrapper \.ant-table-expanded-row \.ant-table-wrapper \.ant-table\s*\{[^}]*margin:\s*0\s*!important;/s,
    );
  });

  it("lets inventory reconciliation content size naturally above its toolbar", () => {
    const demand = read("src/app/(app)/report/demand/demand-client.tsx");
    const styles = read("src/app/globals.css");

    const stockVisual = demand.slice(demand.indexOf('title="库存事实覆盖与一致性"'));
    expect(stockVisual.slice(0, 3_500)).toContain("fitContent");
    expect(styles).toMatch(
      /\.decision-visual \+ \.list-toolbar\s*\{[^}]*margin-top:\s*12px;/s,
    );
  });
});
