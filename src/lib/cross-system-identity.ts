/**
 * 跨系统统一身份维度。
 *
 * 这里只定义业务语义与可用状态，不承载外部原值。外部原值仍留在
 * scoped aliases / sku identifiers / external document references / immutable staging 中。
 */

export type CrossSystemIdentityDomain =
  | "sku"
  | "warehouse"
  | "supplier"
  | "channel"
  | "shop"
  | "organization"
  | "document";

export type CrossSystemIdentityState =
  | "ready"
  | "partial"
  | "missing"
  | "not_implemented";

export type CrossSystemIdentityGovernance =
  | "scoped_alias"
  | "external_reference"
  | "planned_master";

export const CROSS_SYSTEM_IDENTITY_LABEL: Record<CrossSystemIdentityDomain, string> = {
  sku: "SKU / 条码",
  warehouse: "仓库",
  supplier: "供应商",
  channel: "渠道",
  shop: "店铺",
  organization: "组织",
  document: "业务单号",
};

export const CROSS_SYSTEM_IDENTITY_ORDER: CrossSystemIdentityDomain[] = [
  "sku",
  "warehouse",
  "supplier",
  "channel",
  "shop",
  "organization",
  "document",
];

export interface CrossSystemIdentityCoverage {
  domain: CrossSystemIdentityDomain;
  label: string;
  governance: CrossSystemIdentityGovernance;
  state: CrossSystemIdentityState;
  /** 去重后外部身份候选数；没有候选证据时为 0，不表示业务真实为零。 */
  observed: number;
  /** 已由当前来源 scope 精确认领的身份数。 */
  governed: number;
  open: number;
  ignored: number;
  coveragePct: number | null;
  reason: string;
  nextAction: string;
}
