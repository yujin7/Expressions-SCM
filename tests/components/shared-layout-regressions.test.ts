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
    expect(toolbar).toContain('className="list-toolbar__right"');
    expect(toolbar).toContain('className="list-toolbar__primary-actions"');
    expect(toolbar).toContain('role="toolbar"');
    expect(toolbar).toContain('<ConfigProvider componentSize="small">');
    expect(styles).toMatch(
      /\.supplier-scorecard-kpis\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(styles).toMatch(
      /@container app-surface \(max-width:\s*760px\)[\s\S]*\.supplier-scorecard-kpis\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(styles).toMatch(
      /@container app-surface \(max-width:\s*760px\)[\s\S]*\.process-mining-kpis,[\s\S]*\.plan-version-kpis\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(styles).toMatch(
      /@container app-surface \(max-width:\s*520px\)[\s\S]*\.process-mining-kpis,[\s\S]*\.plan-version-kpis\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(styles).toMatch(
      /\.list-toolbar\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*100%;[^}]*padding:\s*6px;/s,
    );
    expect(styles).toMatch(
      /\.list-toolbar--actions-only \.list-toolbar__right\s*\{[^}]*width:\s*auto;/s,
    );
    expect(styles).toMatch(
      /@container app-surface \(max-width:\s*760px\)[\s\S]*\.list-toolbar__right\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto;[^}]*margin-left:\s*0;[^}]*justify-content:\s*stretch;/s,
    );
    expect(styles).toMatch(
      /@container app-surface \(max-width:\s*760px\)[\s\S]*\.list-toolbar__actions\s*\{[^}]*justify-content:\s*flex-start;/s,
    );
    expect(toolbar).toContain('className="list-toolbar__utility-label"');
    expect(toolbar).toContain('className="list-toolbar__utility-value"');
    expect(toolbar).toContain("列表视图与显示");
    expect(toolbar).toContain('key: "__copy"');
    expect(toolbar).toContain('key: "__reset"');
    expect(toolbar).toContain('key: "__density"');
    expect(toolbar).not.toContain('aria-label="复制当前视图链接"');
    expect(styles).toMatch(
      /@container app-surface \(max-width:\s*520px\)[\s\S]*\.list-toolbar__right\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto;/s,
    );
    expect(styles).toMatch(
      /@container app-surface \(max-width:\s*320px\)[\s\S]*\.list-toolbar__right\s*\{[^}]*grid-template-columns:\s*1fr;/s,
    );
  });

  it("keeps KPI summaries compact across legacy report layouts", () => {
    const styles = read("src/app/globals.css");
    const kpiRows = [
      "src/app/(app)/jobs/recon/recon-client.tsx",
      "src/app/(app)/inventory/locations/locations-client.tsx",
      "src/app/(app)/report/closed-loop/closed-loop-client.tsx",
      "src/app/(app)/report/forecast-accuracy/forecast-accuracy-client.tsx",
      "src/app/(app)/report/leadtime-learning/leadtime-learning-client.tsx",
      "src/app/(app)/report/margin/margin-client.tsx",
      "src/app/(app)/report/wip/wip-client.tsx",
    ];
    const statStrips = [
      "src/app/(app)/report/auto-replenish/auto-replenish-client.tsx",
      "src/app/(app)/report/data-health/data-health-client.tsx",
      "src/app/(app)/report/detectors/detectors-client.tsx",
      "src/app/(app)/report/material-demand/material-demand-client.tsx",
      "src/app/(app)/report/price-compare/price-compare-client.tsx",
      "src/app/(app)/report/transfer-suggest/transfer-suggest-client.tsx",
    ];

    for (const file of kpiRows) {
      expect(read(file), file).toContain('className="compact-kpi-row"');
    }
    for (const file of statStrips) {
      expect(read(file), file).toContain("compact-stat-strip");
    }
    expect(styles).toMatch(
      /\.compact-kpi-row\s*\{[^}]*display:\s*grid\s*!important;[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*140px\),\s*1fr\)\);/s,
    );
    expect(styles).toMatch(
      /\.compact-kpi-row > \.ant-col\s*\{[^}]*flex:\s*none;[^}]*max-width:\s*none;[^}]*padding-inline:\s*0\s*!important;/s,
    );
    expect(styles).toMatch(
      /\.compact-stat-strip\.ant-space\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(150px,\s*220px\)\);/s,
    );
    expect(styles).toMatch(
      /\.decision-metric \.ant-card-body\s*\{[^}]*min-height:\s*166px;[^}]*padding:\s*14px;/s,
    );
  });

  it("summarizes structural data warnings without dumping the full evidence list", () => {
    const health = read("src/app/(app)/report/data-health/data-health-client.tsx");
    const styles = read("src/app/globals.css");

    expect(health).toContain('className="data-health-warning__details"');
    expect(health).toContain("查看完整影响与范围");
    expect(health).toContain("plainWarningText");
    expect(health).toContain('placeholder="全部缺失维度"');
    expect(health).toContain('aria-label="按缺失维度筛选"');
    expect(health).not.toContain("DIMENSIONS.map((d) => (");
    expect(styles).toMatch(
      /\.data-health-warning__samples\s*\{[^}]*max-height:\s*96px;[^}]*overflow:\s*auto;/s,
    );
  });

  it("keeps import and audit controls inside narrow app surfaces", () => {
    const release = read("src/app/(app)/import/release/release-client.tsx");
    const upload = read("src/app/(app)/import/upload/upload-client.tsx");
    const audit = read("src/app/(app)/admin/audit/audit-client.tsx");
    const expiry = read("src/app/(app)/inventory/expiry/expiry-client.tsx");
    const styles = read("src/app/globals.css");

    expect(release).toContain('className="release-job-picker"');
    expect(release).not.toContain("minWidth: 520");
    expect(upload).toContain('width: "min(100%, 360px)"');
    expect(audit).toContain('className="audit-filter-grid"');
    expect(expiry).toContain('className="expiry-bucket-filter"');
    expect(expiry).toContain('className="expiry-bucket-filter__count"');
    expect(styles).toMatch(
      /\.audit-filter-grid\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(130px,\s*1fr\)\);/s,
    );
    expect(styles).toMatch(
      /@container app-surface \(max-width:\s*520px\)[\s\S]*\.audit-filter-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.5fr\) minmax\(0,\s*1fr\);/s,
    );
    expect(styles).toMatch(
      /@container app-surface \(max-width:\s*520px\)[\s\S]*\.expiry-bucket-filter__count\s*\{[^}]*display:\s*none;/s,
    );
    expect(styles).toMatch(
      /\.release-job-picker > \.ant-space-item:has\(\.ant-select\)\s*\{[^}]*flex:\s*1 1 260px;[^}]*min-width:\s*0;[^}]*max-width:\s*520px;/s,
    );
  });

  it("merges page-level primary actions into the shared list toolbar", () => {
    const pc = read("src/app/(app)/outsource/pc/pc-client.tsx");
    const toolbar = read("src/components/ListToolbar.tsx");

    expect(toolbar).toContain("primaryActions?: React.ReactNode");
    expect(pc).toContain("primaryActions={");
    expect(pc).toContain('scroll={{ x: "max-content" }}');
    expect(pc).not.toContain('style={{ marginBottom: 12, display: "flex", justifyContent: "flex-end" }}');
  });

  it("uses the shared action band and safe horizontal viewport across transaction lists", () => {
    const transactionPages = [
      "src/app/(app)/outsource/bh/bh-client.tsx",
      "src/app/(app)/outsource/wo/wo-client.tsx",
      "src/app/(app)/outsource/po/po-client.tsx",
      "src/app/(app)/outsource/pc/pc-client.tsx",
      "src/app/(app)/outsource/jg/jg-client.tsx",
      "src/app/(app)/matflow/fl/fl-client.tsx",
      "src/app/(app)/matflow/sh/sh-client.tsx",
      "src/app/(app)/matflow/tl/tl-client.tsx",
      "src/app/(app)/matflow/ct/ct-client.tsx",
      "src/app/(app)/inventory/count/count-client.tsx",
      "src/app/(app)/inventory/docs/docs-client.tsx",
      "src/app/(app)/settlement/js/js-client.tsx",
    ];

    for (const file of transactionPages) {
      const source = read(file);
      expect(source, file).toContain("primaryActions={");
      expect(source, file).toContain("scroll={{ x:");
      expect(source, file).not.toMatch(
        /<Space style=\{\{[^}]*marginBottom:[^}]*justifyContent:\s*"flex-end"/,
      );
    }
  });

  it("keeps operational controls out of the toolbar filter region", () => {
    const actionPages = [
      "src/app/(app)/admin/audit/audit-client.tsx",
      "src/app/(app)/import/exceptions/exceptions-client.tsx",
      "src/app/(app)/import/jobs/jobs-client.tsx",
      "src/app/(app)/inventory/balance/balance-client.tsx",
      "src/app/(app)/inventory/ledger/ledger-client.tsx",
    ];

    for (const file of actionPages) {
      expect(read(file), file).toContain("primaryActions={");
    }
  });

  it("clears the desktop metadata flex basis after dashboard headers stack", () => {
    const styles = read("src/app/globals.css");
    expect(styles).toMatch(
      /@media \(max-width:\s*991px\)[\s\S]*\.dashboard-header__meta\s*\{[^}]*flex:\s*0 0 auto;[^}]*width:\s*100%;/s,
    );
  });

  it("keeps route failures compact, recoverable, and identifiable", () => {
    const errorBoundary = read("src/app/(app)/error.tsx");
    const styles = read("src/app/globals.css");

    expect(errorBoundary).toContain('className="app-error-boundary"');
    expect(errorBoundary).toContain("error.digest");
    expect(errorBoundary).toContain("重试本页");
    expect(errorBoundary).toContain('href="/workbench"');
    expect(styles).toMatch(
      /\.app-error-boundary\s*\{[^}]*place-items:\s*center;[^}]*min-height:\s*min\(460px,\s*calc\(100vh - 150px\)\);/s,
    );
    expect(styles).toMatch(
      /\.app-error-boundary \.ant-result\s*\{[^}]*width:\s*min\(100%,\s*560px\);[^}]*padding:\s*28px 24px;/s,
    );
  });

  it("submits the live input value when Enter follows typing before React state commits", () => {
    const source = read("src/components/SearchInput.tsx");
    expect(source).toContain("onSearch?.(event.currentTarget.value, event)");
    expect(source).not.toContain("if (!event.defaultPrevented) submit(event)");
  });
});
