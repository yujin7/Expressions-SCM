import { expect, it } from "vitest";
import { sopCycleHref, sopCycleTarget, sopCycleTargetPath } from "@/lib/sop-links";
import { notificationActionHref } from "@/lib/notify-links";

it("exact cycle link round trips while legacy home stays a latest-period entry", () => {
  expect(sopCycleHref(42)).toBe("/replenish/sop?cycleId=42");
  expect(sopCycleTarget("cycleId=42&from=notification")).toEqual({ id: 42, error: null });
  expect(sopCycleTarget("q=2026-09")).toEqual({ id: null, error: null });
  expect(sopCycleTarget("cycleId=2147483647").id).toBe(2147483647);
});
it.each(["", "0", "-1", "1.0", "01", "1e2", "+1", "%201", "NaN", "2147483648", "1&cycleId=2", "1&cycleId=1"])("invalid or repeated cycle %s is never interpreted as latest", value => {
  expect(sopCycleTarget(`cycleId=${value}`)).toEqual({ id: null, error: expect.any(String) });
});
it.each([0, -1, 1.2, NaN, Infinity, 2147483648])("refuses unsafe outgoing identity %s", id => {
  expect(sopCycleHref(id)).toBeNull();
  expect(() => sopCycleTargetPath("", id)).toThrow();
});
it("switch, close and malformed-link recovery preserve unrelated context and hash", () => {
  expect(sopCycleTargetPath("from=inbox&cycleId=1&filter=中文", 7, "#evidence"))
    .toBe("/replenish/sop?from=inbox&cycleId=7&filter=%E4%B8%AD%E6%96%87#evidence");
  expect(sopCycleTargetPath("from=inbox&cycleId=wrong&cycleId=2", null, "#evidence")).toBe("/replenish/sop?from=inbox#evidence");
  expect(sopCycleTargetPath("cycleId=1", null)).toBe("/replenish/sop");
});
it.each(["await", "reject", "frozen"])("historical %s notification uses only its structured cycle identity", kind => {
  expect(notificationActionHref("/replenish/sop", `sop:42:v3:${kind}:pmc`)).toBe("/replenish/sop?cycleId=42");
});
it.each([null, "sop:42", "sop:0:v1:await:pmc", "sop:42:v0:await:pmc", "sop:042:v1:await:pmc", "sop:42:v1:await:admin", "sop:42:v1:await:pmc:extra", "sop:2147483648:v1:await:pmc", "sop:42:v2147483648:await:pmc"])("does not guess old target from unsupported key %s", key => {
  expect(notificationActionHref("/replenish/sop", key)).toBe("/replenish/sop");
});
it("explicit, missing and unrelated links are never redirected by a SOP-shaped key", () => {
  for (const href of [null, "/replenish/sop?cycleId=9", "/other", "https://example.com/replenish/sop"]) {
    expect(notificationActionHref(href, "sop:42:v1:await:pmc")).toBe(href);
  }
});
