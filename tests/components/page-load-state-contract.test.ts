import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

describe("page load-state contract", () => {
  it("keeps operational list failures visible and retryable", () => {
    const files = [
      "src/app/(app)/replenish/sop/sop-client.tsx",
      "src/app/(app)/outsource/jg/jg-client.tsx",
      "src/app/(app)/report/supplier-scorecard/supplier-scorecard-client.tsx",
      "src/app/(app)/report/process-mining/process-mining-client.tsx",
      "src/app/(app)/replenish/versions/plan-versions-client.tsx",
      "src/app/(app)/replenish/replenish-client.tsx",
    ];

    for (const file of files) {
      const source = read(file);
      expect(source, file).toContain("loadError");
      expect(source, file).toContain('type="error"');
      expect(source, file).toContain("重试");
    }

    expect(read("src/app/(app)/outsource/jg/jg-client.tsx")).toContain("数据未加载");
    expect(read("src/app/(app)/report/process-mining/process-mining-client.tsx")).toContain("数据未加载");
    expect(read("src/app/(app)/replenish/versions/plan-versions-client.tsx")).toContain("数据未加载");
    expect(read("src/app/(app)/replenish/replenish-client.tsx")).toContain("数据未加载");
  });

  it("keeps decision-critical reports honest, retryable, and race-safe", () => {
    const files = [
      "src/app/(app)/report/transfer-suggest/transfer-suggest-client.tsx",
      "src/app/(app)/report/material-demand/material-demand-client.tsx",
      "src/app/(app)/report/margin/margin-client.tsx",
      "src/app/(app)/report/data-health/data-health-client.tsx",
      "src/app/(app)/report/inventory-analytics/inventory-analytics-client.tsx",
      "src/app/(app)/report/demand/demand-client.tsx",
    ];

    for (const file of files) {
      const source = read(file);
      expect(source, file).toContain("LoadErrorAlert");
      expect(source, file).toContain("AbortController");
      expect(source, file).toContain("signal: controller.signal");
      expect(source, file).toContain("数据未加载");
    }

    const inbox = read("src/app/(app)/inbox/inbox-client.tsx");
    const lifecycle = read("src/app/(app)/master/supplier/lifecycle/supplier-lifecycle-client.tsx");
    const auto = read("src/app/(app)/report/auto-replenish/auto-replenish-client.tsx");
    expect(inbox).toContain("LoadErrorAlert");
    expect(inbox).toContain('data ? data.total : "—"');
    expect(lifecycle).toContain("LoadErrorAlert");
    expect(lifecycle).toContain('value={data ? data.summary.open : "—"}');
    expect(auto).toContain("LoadErrorAlert");
    expect(auto).toContain('value={data ? data.summary.candidateCount : "—"}');
  });

  it("does not present missing KPI payloads as valid zeroes", () => {
    const scorecard = read(
      "src/app/(app)/report/supplier-scorecard/supplier-scorecard-client.tsx",
    );
    const mining = read(
      "src/app/(app)/report/process-mining/process-mining-client.tsx",
    );
    const versions = read(
      "src/app/(app)/replenish/versions/plan-versions-client.tsx",
    );
    const studio = read(
      "src/app/(app)/report/decision-studio/decision-studio-client.tsx",
    );
    const platformGap = read(
      "src/app/(app)/report/decision-studio/platform-sku-gap-card.tsx",
    );

    expect(scorecard).toContain('value={s ? s.suppliers : "—"}');
    expect(scorecard).toContain('value={t ? t.batches : "—"}');
    expect(mining).toContain('value={summary ? summary.totalEvents : "—"}');
    expect(versions).toContain('value={data ? data.current.lineCount : "—"}');
    expect(studio).toContain('value={data?.comparison.current ?? "—"}');
    expect(studio).not.toContain("comparison.current ?? 0");
    expect(platformGap).toContain('value={totals ? totals.byStatus.not_in_crosswalk.skus : "—"}');
    expect(platformGap).toContain('message="平台 SKU 身份缺口加载失败"');
    expect(platformGap).toContain('onClick={() => void load()}');
    expect(platformGap).not.toContain("not_in_crosswalk.skus ?? 0");
  });

  it("keeps decision-studio navigation fast without making refresh stale", () => {
    const studio = read(
      "src/app/(app)/report/decision-studio/decision-studio-client.tsx",
    );

    expect(studio).toContain("responseCache");
    expect(studio).toContain("responseCache.current.size > 12");
    expect(studio).toContain("Date.now() - cached.cachedAt < 30_000");
    expect(studio).toContain("onClick={() => void load(true)}");
  });

  it("gates genuine-empty guidance behind a successful load", () => {
    const sop = read("src/app/(app)/replenish/sop/sop-client.tsx");
    const versions = read(
      "src/app/(app)/replenish/versions/plan-versions-client.tsx",
    );
    const replenish = read(
      "src/app/(app)/replenish/replenish-client.tsx",
    );

    expect(sop).toContain("!cycle && !loadError");
    expect(sop).toContain("!loading && data");
    expect(versions).toContain("!loadError && !loadingVersions && versions.length === 0");
    expect(replenish).toContain(
      'locale={{ emptyText: loadError ? "数据未加载" : "当前条件下没有补货建议" }}',
    );
    expect(replenish).toContain('message="包材信息加载失败"');
  });

  it("keeps dense planning controls responsive without global overrides", () => {
    const mining = read(
      "src/app/(app)/report/process-mining/process-mining-client.tsx",
    );
    const versions = read(
      "src/app/(app)/replenish/versions/plan-versions-client.tsx",
    );
    const sop = read("src/app/(app)/replenish/sop/sop-client.tsx");

    expect(mining).toContain("width={screens.lg ? 190 : screens.sm ? 132 : 96}");
    expect(versions.match(/minWidth:\s*0/g)?.length).toBeGreaterThanOrEqual(4);
    expect(sop).toContain("<Typography.Title level={4}");
    expect(sop.match(/minWidth:\s*0/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
