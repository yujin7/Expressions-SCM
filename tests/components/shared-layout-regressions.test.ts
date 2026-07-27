import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

describe("shared layout regressions", () => {
  it("keeps nested expanded-table headers inside their clipping viewport", () => {
    const styles = read("src/app/globals.css");
    const scorecard = read(
      "src/app/(app)/report/supplier-scorecard/supplier-scorecard-client.tsx",
    );

    expect(styles).toContain(
      ".app-surface .ant-table-wrapper .ant-table-expanded-row .ant-table-wrapper .ant-table",
    );
    expect(styles).toMatch(
      /\.app-surface \.ant-table-wrapper \.ant-table-expanded-row \.ant-table-wrapper \.ant-table\s*\{[^}]*margin:\s*0\s*!important;/s,
    );
    expect(scorecard).toContain('className="supplier-scorecard-breakdown"');
    expect(scorecard).toContain('className="supplier-scorecard-table"');
    expect(scorecard).toContain('tableLayout="fixed"');
    expect(styles).toMatch(
      /\.supplier-scorecard-breakdown\s*\{[^}]*position:\s*sticky;[^}]*width:\s*calc\(100cqw - 34px\);/s,
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

  it("uses responsive report KPIs and shared toolbar regions", () => {
    const scorecard = read(
      "src/app/(app)/report/supplier-scorecard/supplier-scorecard-client.tsx",
    );
    const toolbar = read("src/components/ListToolbar.tsx");
    const styles = read("src/app/globals.css");

    expect(scorecard).toContain('className="supplier-scorecard-kpis"');
    expect(scorecard).toContain("查看完整评分口径与数据限制");
    expect(toolbar).toContain('className="list-toolbar__filters"');
    expect(toolbar).toContain('className="list-toolbar__actions"');
    expect(styles).toMatch(
      /\.supplier-scorecard-kpis\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(styles).toMatch(
      /@media \(max-width:\s*575px\)[\s\S]*\.list-toolbar__filters,[\s\S]*\.list-toolbar__actions\s*\{[^}]*width:\s*100%;/s,
    );
  });

  it("clears the desktop metadata flex basis after dashboard headers stack", () => {
    const styles = read("src/app/globals.css");
    expect(styles).toMatch(
      /@media \(max-width:\s*991px\)[\s\S]*\.dashboard-header__meta\s*\{[^}]*flex:\s*0 0 auto;[^}]*width:\s*100%;/s,
    );
  });
});
