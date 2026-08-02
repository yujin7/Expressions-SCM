import { describe, expect, it } from "vitest";
import {
  currentReleaseActionResult,
  isCurrentReleasePreview,
  releaseActionScope,
  type BoundReleaseActionResult,
} from "@/app/(app)/import/release/release-action-state";

describe("release action state binding", () => {
  const preview = (jobId: number, action: "sku" | "bom", token: string): BoundReleaseActionResult => ({
    scope: { action, jobId, preflightToken: token },
    data: { dryRun: true, marker: `${action}:${jobId}:${token}` },
  });

  it("only enables execution for the same job, action and current preflight", () => {
    const skuJob12 = preview(12, "sku", "pf-a");

    expect(isCurrentReleasePreview(skuJob12, releaseActionScope("sku", 12, "pf-a"))).toBe(true);
    expect(isCurrentReleasePreview(skuJob12, releaseActionScope("sku", 13, "pf-a"))).toBe(false);
    expect(isCurrentReleasePreview(skuJob12, releaseActionScope("bom", 12, "pf-a"))).toBe(false);
    expect(isCurrentReleasePreview(skuJob12, releaseActionScope("sku", 12, "pf-b"))).toBe(false);
  });

  it("does not expose a prior job's result after selection changes", () => {
    const bomJob20 = preview(20, "bom", "pf-20");

    expect(currentReleaseActionResult(bomJob20, releaseActionScope("bom", 20, "pf-20")))
      .toMatchObject({ marker: "bom:20:pf-20" });
    expect(currentReleaseActionResult(bomJob20, releaseActionScope("bom", 21, "pf-21"))).toBeNull();
    expect(currentReleaseActionResult(bomJob20, null)).toBeNull();
  });

  it("does not treat an execution response as a preview", () => {
    const scope = releaseActionScope("bom_activate", 20, null)!;
    const execution: BoundReleaseActionResult = { scope, data: { dryRun: false, activated: 3 } };
    expect(isCurrentReleasePreview(execution, scope)).toBe(false);
  });
});
