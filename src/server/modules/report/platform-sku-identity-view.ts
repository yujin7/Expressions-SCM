import { canSeePrices, maskSensitive } from "@/server/core/dto";
import type { PlatformSkuIdentityGap } from "./platform-sku-identity-gap";

// D53/D62: operational identity facts remain readable; amounts and ratios of
// amounts follow the price-visible roles. Never mutate the shared cached model.
const FINANCIAL_KEYS = [
  "paidAmount", "mappedPaidAmount", "unmappedPaidAmount", "mappedAmountPct",
  "coverableAmountPct", "effectiveAmountPct", "amountPct", "exactHitAmountPct",
] as const;
type FinancialKey = typeof FINANCIAL_KEYS[number];
type Masked<T> = T extends object ? {
  [K in keyof T]: K extends FinancialKey ? T[K] | undefined : Masked<T[K]>
} : T;
export type PlatformSkuIdentityView = Masked<PlatformSkuIdentityGap> & {
  permissions: { canSeeAmounts: boolean; canClaim: boolean };
};
export type PlatformSkuIdentityRowView = PlatformSkuIdentityView["top"][number];

export function platformSkuIdentityView(data: PlatformSkuIdentityGap, roles: string[]): PlatformSkuIdentityView {
  return {
    ...maskSensitive(data, roles, FINANCIAL_KEYS),
    permissions: {
      canSeeAmounts: canSeePrices(roles),
      canClaim: roles.some((role) => ["admin", "pmc", "purchasing", "warehouse"].includes(role)),
    },
  };
}
