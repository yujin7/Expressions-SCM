/**
 * 供应商状态 → 能否接新单（纯规则，零依赖）。
 *
 * 生命周期页「整改 · 发起时暂停新订单」把供应商置为 `paused`，语义与黑名单一样是「禁新单，
 * 存量收尾」；此前委外工单/生成单据/自动链只拦 `blacklisted`，`paused` 形同虚设。
 * 三处调用（createWo / generateDocs / auto-chain 预演）统一读这里，避免再次各写一份。
 */
export type SupplierOrderBlock = { blocked: false } | { blocked: true; label: string; reason: string };

const BLOCKED: Record<string, string> = {
  blacklisted: "黑名单",
  paused: "暂停新订单",
};

/** 该状态是否禁止新单；返回可直接拼进错误文案的标签与原因 */
export function supplierNewOrderBlock(status: string | null | undefined): SupplierOrderBlock {
  const label = status ? BLOCKED[status] : undefined;
  if (!label) return { blocked: false };
  return {
    blocked: true,
    label,
    reason: status === "paused"
      ? "供应商处于整改暂停期，禁止新单（存量单据可继续收尾）"
      : "供应商已列入黑名单，禁止新单（存量单据可继续收尾）",
  };
}

/** 供应商能否进入新单：blacklisted / paused 皆否 */
export function supplierAcceptsNewOrders(status: string | null | undefined): boolean {
  return !supplierNewOrderBlock(status).blocked;
}
