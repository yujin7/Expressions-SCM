import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";
import type { AnyDb } from "@/server/core/svc";

/** Call inside the owning transaction; hold identity/role/session authority through commit. */
export async function currentWriteActor(tx: AnyDb, user: SessionUser): Promise<SessionUser> {
  const [current]: (typeof users.$inferSelect)[] = await tx.select().from(users).where(eq(users.id, user.id)).for("share");
  if (!current?.active) throw new ApiError(403, "账号已停用或不存在，请重新登录核对权限");
  if (user.sessionVersion != null && user.sessionVersion !== current.sessionVersion) {
    throw new ApiError(401, "登录状态已失效，请重新登录");
  }
  return { id: current.id, name: current.name, roles: current.roles, isApprover: current.isApprover };
}
