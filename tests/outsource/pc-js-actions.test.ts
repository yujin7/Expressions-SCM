import { describe, expect, it } from "vitest";
import { pcTaskActions } from "@/server/modules/outsource/pc-detail";
import { jsTaskActions } from "@/server/modules/settlement/js";
const user = { id: 12, name: "合成审批人", roles: ["purchasing"], isApprover: true };
const pending = { status: "pending", createdBy: 11 };

describe("PC and JS action qualification", () => {
  it.each(["ops", "warehouse", "quality"])("JS configured %s checker cannot approve masked money but can reject", role => {
    expect(jsTaskActions({ ...user, roles: [role] }, pending, role))
      .toMatchObject({ approve: false, reject: true, reason: expect.stringContaining("不可查看结算金额") });
    expect(jsTaskActions({ ...user, roles: [role, "finance"] }, pending, role))
      .toMatchObject({ approve: true, reject: true });
  });
  for (const actions of [pcTaskActions, jsTaskActions]) {
    it(`${actions.name}: follows configured role, not a hardcoded department`, () => {
      expect(actions(user, pending, "purchasing")).toMatchObject({ approve: true, reject: true });
      expect(actions(user, pending, "finance")).toMatchObject({ approve: false, reject: false });
    });
    it(`${actions.name}: isApprover and missing configuration fail closed; admin does not bypass missing config`, () => {
      expect(actions({ ...user, isApprover: false }, pending, "purchasing")).toMatchObject({ approve: false, reject: false });
      expect(actions({ ...user, roles: ["admin"], isApprover: false }, pending, "finance")).toMatchObject({ approve: true, reject: true });
      expect(actions({ ...user, roles: ["admin"] }, pending, null)).toMatchObject({ approve: false, reject: false, reason: "缺少审批配置" });
    });
    it.each(["admin", "purchasing", "finance"])(`${actions.name}: maker with %s cannot self-approve or reject`, role => {
      expect(actions({ ...user, id: pending.createdBy, roles: [role] }, pending, role))
        .toMatchObject({ approve: false, reject: false, reason: expect.stringContaining("制单人不可自审") });
    });
    it.each(["approved", "completed", "closed", "void", "unknown"])(`${actions.name}: %s is read-only`, status => {
      const result = actions({ ...user, roles: ["admin"] }, { ...pending, status }, "finance");
      expect(result).toMatchObject({ approve: false, reject: false });
      if ("submit" in result) expect(result).toMatchObject({ submit: false, refreshFee: false });
    });
  }
  it("a blocked fee effect preserves the qualified rejection exit, without granting an unqualified reader any action", () => {
    expect(pcTaskActions(user, pending, "purchasing", "已冻结"))
      .toMatchObject({ approve: false, reject: true, reason: "已冻结" });
    expect(pcTaskActions({ ...user, roles: ["ops"] }, pending, "purchasing", "已冻结"))
      .toMatchObject({ approve: false, reject: false });
  });
  it("draft submission preserves maker privilege; fee refresh remains PMC/admin only", () => {
    const draft = { status: "draft", createdBy: user.id };
    expect(jsTaskActions({ ...user, roles: ["ops"] }, draft, "finance"))
      .toMatchObject({ submit: true, refreshFee: false, approve: false });
    expect(jsTaskActions({ ...user, id: 99, roles: ["pmc"] }, draft, "finance"))
      .toMatchObject({ submit: true, refreshFee: true, approve: false });
    expect(jsTaskActions({ ...user, id: 99, roles: ["finance"] }, draft, "finance"))
      .toMatchObject({ submit: false, refreshFee: false, approve: false });
  });
});
