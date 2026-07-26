/**
 * 通知可见性（收件人）判定的唯一权威。
 *
 * 事故背景（2026-07-25 审计）：`/api/notifications` 有完整的收件人过滤
 * （userId 定向 + targetRole 角色定向，admin 全见），但工作台「未读通知」徽标
 * 自己数了一遍、**不带任何收件人条件**——4 类非 pmc 角色徽标恒显 8、实际可见 4；
 * 把自己能看的 4 条全部读完，徽标仍卡在 4，且「全部已读」按钮被禁用，
 * **没有任何操作能让它归零**。这是「用户学会无视徽标」最典型的成因，
 * 同时还泄露了定向给 pmc 的通知条数。
 *
 * 纪律：任何要数或列通知的地方**必须**用本模块的谓词，禁止再手写 where。
 */
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { notifications } from "@/db/schema";

/** 出现在收件箱里的状态（failed 也要能看见，否则发送失败会静默消失） */
export const NOTIFY_VISIBLE_STATUS = ["pending", "sent", "skipped", "failed"] as const;

/**
 * 当前用户可见的通知谓词。
 * - admin：全见（返回 undefined＝不加条件）
 * - 其他：无定向（userId/targetRole 均为空）的广播 + 定向给我的 + 定向给我角色的
 */
export function notifyAudienceWhere(user: { id: number; roles: string[] }) {
  if (user.roles.includes("admin")) return undefined;
  return and(
    or(isNull(notifications.userId), eq(notifications.userId, user.id)),
    or(
      isNull(notifications.targetRole),
      inArray(notifications.targetRole, user.roles.length ? user.roles : ["__none__"]),
    ),
  );
}

/** 列表用：可见状态 + 收件人 */
export function notifyVisibleWhere(user: { id: number; roles: string[] }) {
  const audience = notifyAudienceWhere(user);
  const status = inArray(notifications.status, [...NOTIFY_VISIBLE_STATUS]);
  return audience ? and(status, audience) : status;
}
