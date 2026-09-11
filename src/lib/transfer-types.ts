/**
 * 调拨类型固定清单（D60）——零依赖纯常量模块，客户端/服务端均可值导入。
 *
 * 与 `stock_docs.transfer_type` 的 CHECK 约束一一对应（迁移 0047_director_program）；
 * 改清单必须同时改 schema 与迁移，`tests/schema/director-program.test.ts` 钉住两边一致。
 */

export const TRANSFER_TYPES = [
  "factory_to_warehouse", // 工厂发仓：加工厂/OEM → 己方仓
  "bonded_transfer", // 保税转运：保税/中转 → 发货仓
  "inter_warehouse", // 仓间调拨：己方仓之间
  "borrow", // 借调：渠道/部门间临时借用（R16）
  "return_to_factory", // 退回工厂：己方仓 → 加工厂
  "other", // 其他
] as const;

export type TransferType = (typeof TRANSFER_TYPES)[number];

export const TRANSFER_TYPE_LABELS: Record<TransferType, string> = {
  factory_to_warehouse: "工厂发仓",
  bonded_transfer: "保税转运",
  inter_warehouse: "仓间调拨",
  borrow: "借调",
  return_to_factory: "退回工厂",
  other: "其他",
};

export function isTransferType(value: unknown): value is TransferType {
  return typeof value === "string" && (TRANSFER_TYPES as readonly string[]).includes(value);
}
