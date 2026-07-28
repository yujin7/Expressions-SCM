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

    expect(scorecard).toContain('value={s ? s.suppliers : "—"}');
    expect(scorecard).toContain('value={t ? t.batches : "—"}');
    expect(mining).toContain('value={summary ? summary.totalEvents : "—"}');
    expect(versions).toContain('value={data ? data.current.lineCount : "—"}');
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
