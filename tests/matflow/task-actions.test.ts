import { describe, expect, it } from "vitest";
import { canCreateMaterialDoc, materialExcess, materialTaskActions } from "@/server/modules/matflow/task-actions";
import type { SessionUser } from "@/server/core/dto";

const checker: SessionUser = { id: 2, name: "审批人", roles: ["warehouse"], isApprover: true };
const pending = { status: "pending", createdBy: 1 };
describe("物料处理资格与逐物料数量", () => {
  it.each(["warehouse", "admin", "ops", "finance"])("%s 新建资格不等于审批资格", role => {
    expect(canCreateMaterialDoc({ ...checker, roles: [role] })).toBe(["warehouse", "admin"].includes(role));
  });
  it.each(["warehouse", "admin"])("%s 制单人不能自审或自驳回", role => {
    expect(materialTaskActions({ ...checker, id: 1, roles: [role] }, pending, "warehouse", null, null))
      .toMatchObject({ submit: false, approve: false, reject: false, reason: expect.stringContaining("制单人") });
  });
  it.each([
    [null, checker, "配置"], ["ops", checker, "角色"],
    ["warehouse", { ...checker, isApprover: false }, "不是审批人"],
  ] as const)("当前审批配置与审批人标记：%s", (role, user, text) => {
    expect(materialTaskActions(user, pending, role, null, null)).toMatchObject({ approve: false, reject: false, reason: expect.stringContaining(text) });
  });
  it("配置角色不是仓管也能按真实资格处理；管理员仍需有配置", () => {
    expect(materialTaskActions({ ...checker, roles: ["ops"] }, pending, "ops", null, null)).toMatchObject({ approve: true, reject: true });
    expect(materialTaskActions({ ...checker, roles: ["admin"] }, pending, null, null, null)).toMatchObject({ approve: false, reject: false });
  });
  it.each(["结算已冻结", "JG已关闭"])("%s 阻止提交/批准而不封死驳回", block => {
    expect(materialTaskActions(checker, pending, "warehouse", block, null)).toMatchObject({ approve: false, reject: true, reason: expect.stringContaining("仍可驳回") });
    expect(materialTaskActions(checker, { ...pending, status: "draft" }, "warehouse", block, null)).toMatchObject({ submit: false, approve: false, reject: false });
  });
  it("数量阻塞不抢走驳回出口；提交不是过账，保留草稿提交资格", () => {
    expect(materialTaskActions(checker, pending, "warehouse", null, "超发需管理员")).toMatchObject({ approve: false, reject: true });
    expect(materialTaskActions(checker, { ...pending, status: "draft" }, "warehouse", null, "超发需管理员")).toMatchObject({ submit: true });
  });
  it("当前有效制单人即使是运营仍可提交，非制单运营不行", () => {
    expect(materialTaskActions({ ...checker, id: 1, roles: ["ops"] }, { ...pending, status: "draft" }, "warehouse", null, null).submit).toBe(true);
    expect(materialTaskActions({ ...checker, roles: ["ops"] }, { ...pending, status: "draft" }, "warehouse", null, null).submit).toBe(false);
  });
  it.each(["approved", "in_progress", "completed", "closed", "void"])("%s 只读，不能显示新动作", status => {
    expect(materialTaskActions(checker, { ...pending, status }, "warehouse", null, null)).toMatchObject({ submit: false, approve: false, reject: false });
  });
  it("小数与重复行先逐SKU合计，不损坏输入或跨SKU抵扣", () => {
    const cumulative = new Map([[1, "8.6"], [2, "0"]]), limits = new Map([[1, "8.9"], [2, "1000"]]);
    expect(materialExcess([{ skuId: 1, qty: "0.1" }, { skuId: 1, qty: "0.2" }], cumulative, limits)).toBeNull();
    expect(materialExcess([{ skuId: 1, qty: "0.3001" }], cumulative, limits)).toEqual({ skuId: 1, qty: "8.9001", limit: "8.9" });
    expect(cumulative.get(1)).toBe("8.6");
    expect(materialExcess([{ skuId: 3, qty: "0.0001" }], new Map(), limits)).toMatchObject({ skuId: 3, limit: "0" });
  });
});
