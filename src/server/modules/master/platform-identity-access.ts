import type { SessionUser } from "@/server/core/dto";
import { resolveChannelScope, resolveDeptScope } from "@/server/core/data-scope";
import { ApiError } from "./common";
import { guardFreshWrite } from "@/server/modules/outsource/common";

/** Same business authority for direct claims, bulk claims and barcode fill. */
export function canWritePlatformIdentity(roles: readonly string[]): boolean {
  return roles.some(role => ["admin", "pmc", "purchasing", "warehouse"].includes(role));
}

/** D62: identity governance is cross-shop/global, registered as scopedMode=denied. */
export function assertPlatformIdentityScope(user: SessionUser): void {
  if (resolveChannelScope(user).forced || resolveDeptScope(user).forced) {
    throw new ApiError(403, "当前账号的数据范围不开放跨店铺身份治理，请联系身份治理负责人");
  }
}

export function assertPlatformIdentityWriter(user: SessionUser): void {
  if (!canWritePlatformIdentity(user.roles)) {
    throw new ApiError(403, "无权限认领平台 SKU 或补齐条码");
  }
  assertPlatformIdentityScope(user);
}

/** HTTP boundary rechecks current identity; services independently enforce policy. */
export async function guardPlatformIdentityWriter(): Promise<SessionUser> {
  const user = await guardFreshWrite();
  assertPlatformIdentityWriter(user);
  return user;
}
