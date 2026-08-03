export type YonyouContractDomain =
  | "organization"
  | "master_data"
  | "procurement"
  | "inventory"
  | "finance";

export interface YonyouReadContract {
  name: string;
  method: "POST";
  path: string;
  domain: YonyouContractDomain;
  purpose: string;
}

/**
 * Read-only contracts verified in the target YonBIP tenant's official API catalog on 2026-08-03.
 * Adding or replacing a contract is a reviewed code change so an environment typo cannot widen
 * the credential's data scope or silently select a deprecated endpoint.
 */
export const YONYOU_READ_CONTRACTS = [
  {
    name: "分页查询当前租户组织架构",
    method: "POST",
    path: "/yonbip/uspace/org/page_list",
    domain: "organization",
    purpose: "resolve and reconcile the target organization before any business-data read",
  },
  {
    name: "供应商档案列表查询",
    method: "POST",
    path: "/yonbip/digitalModel/vendor/list",
    domain: "master_data",
    purpose: "supplier identity and external-code reconciliation",
  },
  {
    name: "物料档案分页查询 V2",
    method: "POST",
    path: "/yonbip/digitalModel/product/listproductbycondition",
    domain: "master_data",
    purpose: "SKU and item identity reconciliation without changing S1 master codes",
  },
  {
    name: "采购订单列表查询",
    method: "POST",
    path: "/yonbip/scm/purchaseorder/list",
    domain: "procurement",
    purpose: "purchase-order status and external-document reconciliation",
  },
  {
    name: "采购入库列表查询",
    method: "POST",
    path: "/yonbip/scm/purinrecord/list",
    domain: "procurement",
    purpose: "purchase receipt control totals and document reconciliation",
  },
  {
    name: "现存量查询 V2",
    method: "POST",
    path: "/yonbip/scm/stock/QueryCurrentStocksByCondition",
    domain: "inventory",
    purpose: "read-only inventory comparison; never posts directly into the SCM ledger",
  },
  {
    name: "存货成本查询",
    method: "POST",
    path: "/yonbip/EFI/fieia/queryBalance",
    domain: "finance",
    purpose: "period inventory-cost authority and variance analysis",
  },
  {
    name: "凭证列表查询",
    method: "POST",
    path: "/yonbip/fi/ficloud/openapi/voucher/queryVouchers",
    domain: "finance",
    purpose: "voucher existence and posting-status reconciliation",
  },
] as const satisfies readonly YonyouReadContract[];

export type YonyouReadContractName = (typeof YONYOU_READ_CONTRACTS)[number]["name"];

const contractByName = new Map<string, YonyouReadContract>(
  YONYOU_READ_CONTRACTS.map((contract) => [contract.name, contract]),
);

export function yonyouReadContractByName(name: string): YonyouReadContract | null {
  return contractByName.get(name) ?? null;
}

export function areKnownYonyouReadContracts(names: readonly string[]): boolean {
  return names.length > 0 && names.every((name) => contractByName.has(name));
}
