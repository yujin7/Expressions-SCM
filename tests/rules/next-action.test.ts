import { describe, expect, it } from "vitest";

import {
  NEXT_ACTION_DEFINITIONS,
  nextActionDefinitionsForRoles,
} from "@/server/rules/next-action";

describe("C153 下一步建议有限注册表", () => {
  it("规则 ID 与触发器唯一，且每条规则都有非管理员责任角色", () => {
    expect(NEXT_ACTION_DEFINITIONS).toHaveLength(6);
    expect(new Set(NEXT_ACTION_DEFINITIONS.map((item) => item.id)).size).toBe(
      NEXT_ACTION_DEFINITIONS.length,
    );
    for (const item of NEXT_ACTION_DEFINITIONS) {
      expect(item.roles).toContain("admin");
      expect(item.ownerRole).not.toBe("admin");
      expect(["approve", "complete"]).toContain(item.triggerAction);
    }
  });

  it("按责任角色过滤；管理员可见全部，运营不被推送无权动作", () => {
    expect(nextActionDefinitionsForRoles(["pmc"]).map((item) => item.id)).toEqual([
      "bh.create_wo",
      "wo.generate_execution_docs",
      "jg.confirm_production",
      "jg.create_settlement",
    ]);
    expect(nextActionDefinitionsForRoles(["purchasing"]).map((item) => item.id)).toEqual([
      "po.confirm_due_date",
    ]);
    expect(nextActionDefinitionsForRoles(["warehouse"]).map((item) => item.id)).toEqual([
      "sh.finish_qc_inbound",
    ]);
    expect(nextActionDefinitionsForRoles(["ops"])).toEqual([]);
    expect(nextActionDefinitionsForRoles(["admin"])).toHaveLength(6);
  });
});
