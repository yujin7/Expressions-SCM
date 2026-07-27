import type { Role } from "@/server/core/constants";

export type NextActionPriority = "high" | "medium";

export type NextActionRuleId =
  | "bh.create_wo"
  | "wo.generate_execution_docs"
  | "po.confirm_due_date"
  | "jg.confirm_production"
  | "sh.finish_qc_inbound"
  | "jg.create_settlement";

export interface NextActionDefinition {
  id: NextActionRuleId;
  triggerEntity: "bh" | "wo" | "po" | "jg" | "sh";
  triggerAction: "approve" | "complete";
  ownerRole: Exclude<Role, "admin">;
  roles: readonly Role[];
  priority: NextActionPriority;
}

/**
 * C153 finite registry. A registry entry only says which audited transition may
 * open a recommendation. The read service must still prove the current document
 * state and the absence/presence of downstream facts before returning it.
 */
export const NEXT_ACTION_DEFINITIONS: readonly NextActionDefinition[] = [
  {
    id: "bh.create_wo",
    triggerEntity: "bh",
    triggerAction: "approve",
    ownerRole: "pmc",
    roles: ["pmc", "admin"],
    priority: "high",
  },
  {
    id: "wo.generate_execution_docs",
    triggerEntity: "wo",
    triggerAction: "approve",
    ownerRole: "pmc",
    roles: ["pmc", "admin"],
    priority: "high",
  },
  {
    id: "po.confirm_due_date",
    triggerEntity: "po",
    triggerAction: "approve",
    ownerRole: "purchasing",
    roles: ["purchasing", "admin"],
    priority: "high",
  },
  {
    id: "jg.confirm_production",
    triggerEntity: "jg",
    triggerAction: "approve",
    ownerRole: "pmc",
    roles: ["pmc", "admin"],
    priority: "medium",
  },
  {
    id: "sh.finish_qc_inbound",
    triggerEntity: "sh",
    triggerAction: "approve",
    ownerRole: "warehouse",
    roles: ["warehouse", "admin"],
    priority: "high",
  },
  {
    id: "jg.create_settlement",
    triggerEntity: "jg",
    triggerAction: "complete",
    ownerRole: "pmc",
    roles: ["pmc", "admin"],
    priority: "high",
  },
] as const;

export function nextActionDefinitionsForRoles(roles: readonly string[]): NextActionDefinition[] {
  const isAdmin = roles.includes("admin");
  return NEXT_ACTION_DEFINITIONS.filter(
    (definition) => isAdmin || definition.roles.some((role) => roles.includes(role)),
  );
}
