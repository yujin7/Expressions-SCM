/** 业务规则统一出口（R1 价格 / R5 委外结算 / R11 净需求） */
export { normalizeToBaseNet, checkPriceDeviation } from "./price";
export type { NormalizeInput, DeviationInput, DeviationResult } from "./price";
export { settle } from "./settlement";
export type { SettleMaterial, SettleInput, SettleLine, SettleResult } from "./settlement";
export { suggestQty } from "./netreq";
export type { SuggestQtyInput } from "./netreq";
