import { describe, expect, it } from "vitest";
import {
  alertToCandidate,
  fingerprintOf,
  priorityFromSeverity,
  projectTodoCandidates,
  reviewOwnerRole,
  reviewToCandidate,
} from "@/server/rules/task-triggers";

describe("rules/task-triggers：告警/复核 → 待办候选（纯函数）", () => {
  it("指纹 = sourceKind:sourceRef，告警按 id 稳定", () => {
    const c = alertToCandidate({ id: 12, category: "sales_spike", refKey: "sku:CP1", title: "爆单", detail: null, severity: "high" });
    expect(c.fingerprint).toBe("alert:12");
    expect(c.fingerprint).toBe(fingerprintOf("alert", "12"));
    expect(c.ownerRole).toBe("pmc");
    expect(c.priority).toBe("high");
    expect(c.href).toContain("/alerts?category=sales_spike");
  });

  it("严重度映射：critical/high→high，medium→normal，其余 low；未知告警类别落 admin", () => {
    expect(priorityFromSeverity("critical")).toBe("high");
    expect(priorityFromSeverity("medium")).toBe("normal");
    expect(priorityFromSeverity(null)).toBe("low");
    expect(alertToCandidate({ id: 1, category: "brand_new_kind", refKey: null, title: "t", detail: null, severity: null }).ownerRole).toBe("admin");
  });

  it("复核类别按前缀归责；blocked* 高优先", () => {
    expect(reviewOwnerRole("blocked_release")).toBe("pmc");
    expect(reviewOwnerRole("supplier_dup")).toBe("purchasing");
    expect(reviewOwnerRole("platform_identity")).toBe("ops");
    expect(reviewOwnerRole("something_else")).toBe("pmc");
    const c = reviewToCandidate({ id: 7, category: "blocked_bom", refType: "bom", refKey: "B1", title: "BOM 阻断", detail: "d", severity: null } as never);
    expect(c.fingerprint).toBe("review:7");
    expect(c.priority).toBe("high");
  });

  it("批量投影：同指纹去重、告警在前、同类按 id 升序（多轮稳定）", () => {
    const out = projectTodoCandidates({
      alerts: [
        { id: 5, category: "doc_aging", refKey: "po:PO1", title: "a5", detail: null, severity: "medium" },
        { id: 2, category: "doc_aging", refKey: "po:PO2", title: "a2", detail: null, severity: "high" },
        { id: 5, category: "doc_aging", refKey: "po:PO1", title: "dup", detail: null, severity: "medium" },
      ],
      reviews: [{ id: 9, category: "blocked_x", refType: null, refKey: null, title: "r9", detail: null }],
    });
    expect(out.map((c) => c.fingerprint)).toEqual(["alert:2", "alert:5", "review:9"]);
    expect(out[0].title).toBe("a2");
  });
});
