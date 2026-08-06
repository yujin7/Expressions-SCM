import { and, eq, getTableColumns, sql } from "drizzle-orm";
import type { AnyPgTable, PgColumn } from "drizzle-orm/pg-core";
import { ApprovalError } from "./approval";
import type { AnyDb } from "./doc-no";
import { nextStatus, type DocAction, type DocStatus } from "./state";

/**
 * 手工状态流转：完成 / 短关 / 作废 / 重开。
 *
 * 背景（实测，非推测）：状态机里这四条边早就定义了，但全仓只有 JG 与 JS 会走到
 * `completed`——BH、WO、PO **根本没有任何路径到达完成**，而 `short_close`
 * 在整个 src/server 下零实现。后果是供应商少送尾数的 PO 永久卡在「执行中」，
 * 备货申请和委外工单永远停在半路，看板上的在办量只增不减。
 *
 * **刻意不做自动完成**：BH 什么时候算完（转完 WO/PO？还是货到？）属于业务口径，
 * 不同公司答案不同，工程不能替业务裁决。这里只补「人可以收口」的能力，
 * 与本系统「自动化只出草稿，闸门永远是人」的一贯做法一致。
 */

export type ManualAction = Extract<DocAction, "complete" | "short_close" | "void" | "reopen">;

const ACTION_LABEL: Record<ManualAction, string> = {
  complete: "完成",
  short_close: "短关",
  void: "作废",
  reopen: "重开",
};

export async function transitionDoc(
  db: AnyDb,
  i: {
    docType: string;
    table: AnyPgTable; // 须含 id/status/version/createdBy/updatedAt
    docId: number;
    user: { id: number; roles: string[] };
    action: ManualAction;
    /** 短关必须留原因（状态机注释：「短关(留原因)」）；其余可选。 */
    reason?: string;
    expectedVersion: number;
  },
): Promise<{ status: string; idempotent: boolean }> {
  if (i.action === "short_close" && !i.reason?.trim()) {
    throw new ApprovalError("BAD_STATUS", "短关必须填写原因");
  }
  // 重开是管理员的纠偏动作（state.ts 明确「仅管理员，权限在调用侧校验」）
  if (i.action === "reopen" && !i.user.roles.includes("admin")) {
    throw new ApprovalError("ROLE_FORBIDDEN", "仅管理员可重开已关闭单据");
  }

  return db.transaction(async (tx) => {
    const cols = getTableColumns(i.table) as Record<string, PgColumn>;
    const [doc] = await tx
      .select({ status: cols.status, version: cols.version, createdBy: cols.createdBy })
      .from(i.table)
      .where(eq(cols.id, i.docId));
    if (!doc) throw new ApprovalError("NOT_FOUND", `${i.docType}#${i.docId} 不存在`);

    const from = doc.status as DocStatus;

    // 幂等先于状态校验：已经到目标态说明动作已生效，重试不该报错
    let target: DocStatus;
    try {
      target = nextStatus(from, i.action);
    } catch {
      // 已在目标态 → 幂等成功；否则是真的非法流转
      const alreadyThere =
        (i.action === "complete" && from === "completed")
        || (i.action === "short_close" && from === "closed")
        || (i.action === "void" && from === "void")
        || (i.action === "reopen" && from === "in_progress");
      if (alreadyThere) return { status: from, idempotent: true };
      throw new ApprovalError(
        "BAD_STATUS",
        `当前状态「${from}」不可${ACTION_LABEL[i.action]}`,
      );
    }

    // 作废只针对自己的草稿：已提交的单据要纠错走驳回/短关/红字，不能一键抹掉
    if (i.action === "void") {
      const isAdmin = i.user.roles.includes("admin");
      if (!isAdmin && i.user.id !== (doc.createdBy as number)) {
        throw new ApprovalError("NOT_OWNER", "只有制单人本人可作废自己的草稿");
      }
    }

    const updated = await tx
      .update(i.table)
      .set({
        status: target,
        version: sql`${cols.version} + 1`,
        updatedAt: new Date(),
      } as Record<string, unknown>)
      .where(and(eq(cols.id, i.docId), eq(cols.version, i.expectedVersion)))
      .returning({ id: cols.id });
    if (updated.length === 0) {
      throw new ApprovalError("VERSION_CONFLICT", `期望版本 ${i.expectedVersion} 已过期`);
    }
    return { status: target, idempotent: false };
  });
}
