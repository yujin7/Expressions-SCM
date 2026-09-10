import { expect, it } from "vitest";
import { canCreateCountTask, countTaskActions } from "@/server/modules/inventory/count";
const user = (id: number, roles: string[], isApprover = false) => ({ id, roles, isApprover, name: "合成账号" });
const draft = { status: "draft", createdBy: 1 }, pending = { ...draft, status: "pending" };

it("warehouse maker creates, edits and submits; colleague only records", () => {
  expect(canCreateCountTask(user(1, ["warehouse"]))).toBe(true);
  expect(countTaskActions(user(1, ["warehouse"]), draft, "finance")).toMatchObject({ edit: true, submit: true, approve: false });
  expect(countTaskActions(user(2, ["warehouse"]), draft, "finance")).toMatchObject({ edit: true, submit: false, reason: expect.stringContaining("制单人") });
});
it("financial and ops readers cannot enter warehouse HTTP actions, even if a historical maker", () => {
  for (const roles of [["finance"], ["ops"]]) {
    const actor = user(1, roles, true);
    expect(canCreateCountTask(actor)).toBe(false);
    expect(countTaskActions(actor, draft, "finance")).toMatchObject({ edit: false, submit: false, approve: false });
  }
});
it("financial approval needs current configuration, approver flag and separate maker", () => {
  expect(countTaskActions(user(2, ["finance"], true), pending, "finance").approve).toBe(true);
  for (const [actor, role] of [[user(2, ["warehouse"], true), "finance"], [user(2, ["finance"]), "finance"], [user(2, ["finance"], true), "pmc"], [user(2, ["admin"]), null], [user(1, ["admin"]), "finance"]] as const) {
    expect(countTaskActions(actor, pending, role)).toMatchObject({ approve: false, reason: expect.any(String) });
  }
  expect(countTaskActions(user(2, ["pmc"], true), pending, "pmc").approve).toBe(true);
  expect(countTaskActions(user(2, ["admin"]), pending, "finance").approve).toBe(true);
});
it("completed tasks expose no write action", () => {
  expect(countTaskActions(user(2, ["admin"]), { ...draft, status: "completed" }, "finance")).toEqual({ edit: false, submit: false, approve: false, reason: null });
});
