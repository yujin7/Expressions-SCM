import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ApprovalTimeline from "@/components/ApprovalTimeline";
vi.mock("antd", () => ({ Timeline: "timeline", Typography: { Text: "text" } }));
beforeEach(() => { vi.stubGlobal("React", React); vi.stubEnv("TZ", "UTC"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it.each(["2026-09-11T06:35:00Z", new Date("2026-09-11T06:35:00Z")])("approval time uses Shanghai regardless of browser/server timezone: %s", createdAt => {
  const tree = ApprovalTimeline({ items: [{ approverName: "财务", action: "approve", comment: "已核对", createdAt }] });
  expect(JSON.stringify(tree)).toContain("2026-09-11 14:35");
});
it("missing-zone timestamps remain unknown instead of guessed local time", () => {
  const tree = ApprovalTimeline({ items: [{ approverName: null, action: "reject", comment: "复核", createdAt: "2026-09-11T06:35:00" }] });
  expect(JSON.stringify(tree)).not.toContain("2026-09-11 06:35");
});
