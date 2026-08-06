/**
 * 审批节点配置（单据类型 → 审批角色）。
 *
 * `approval_configs` 是审批授权的**单一权威**（approveDoc 按它判定），但此前
 * 全仓唯一的写入点是种子代码——业务想把某类单据的审批人从生产计划改成财务，
 * 只能改代码重跑或直连数据库。审计 §C 第 4 条。
 *
 * 这是 maker-checker 那道闸本身的配置，因此收得比普通参数更紧：
 * - **仅管理员**可改（与 reopen、运行参数同档）；
 * - 只能改成受控角色枚举里的值，且不接受 admin
 *   （admin 本就全域可审，把某类单据指成 admin 等于取消该类单据的角色约束）；
 * - 只能改已登记的单据类型，不能凭空造 docType（造出来没有任何单据会引用，
 *   却会让审批域看起来"配过了"）；
 * - 改动逐条写审计，before/after 都留——事后要能回答"谁在什么时候把
 *   委外工单的审批人从 PMC 改成了财务"。
 */
import { eq } from "drizzle-orm";
import { approvalConfigs } from "@/db/schema";
import { getDbAsync } from "@/db";
import { writeAudit } from "@/server/core/audit";
import { ROLE_LABELS, type Role } from "@/server/core/constants";
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;

/** 可作为审批角色的取值：排除 admin（全域可审，指成它等于取消角色约束）。 */
export const ASSIGNABLE_APPROVER_ROLES: readonly Role[] = [
  "ops", "purchasing", "warehouse", "quality", "pmc", "finance",
];

/** 审批域中文名。键必须与 approval_configs.doc_type 一致。 */
export const APPROVAL_DOMAIN_LABELS: Record<string, string> = {
  bh: "备货申请", wo: "委外工单", po: "采购订单", pc: "价格变更", jg: "加工通知",
  fl: "发料单", tl: "退料单", sh: "收货单", ct: "采购退货", js: "委外结算",
  stock_doc: "库存单据", count: "盘点调整", opening: "期初", bom: "BOM 生效",
};

export interface ApprovalConfigRow {
  docType: string;
  docTypeLabel: string;
  approverRole: string;
  approverRoleLabel: string;
}

export async function listApprovalConfigs(dbArg?: AnyDb): Promise<ApprovalConfigRow[]> {
  const db: AnyDb = dbArg ?? (await getDbAsync());
  const rows: { docType: string; approverRole: string }[] = await db
    .select({ docType: approvalConfigs.docType, approverRole: approvalConfigs.approverRole })
    .from(approvalConfigs)
    .orderBy(approvalConfigs.docType);
  return rows.map((r) => ({
    docType: r.docType,
    docTypeLabel: APPROVAL_DOMAIN_LABELS[r.docType] ?? r.docType,
    approverRole: r.approverRole,
    approverRoleLabel: ROLE_LABELS[r.approverRole as Role] ?? r.approverRole,
  }));
}

export async function updateApprovalConfig(
  user: SessionUser,
  input: { docType?: unknown; approverRole?: unknown },
  dbArg?: AnyDb,
): Promise<ApprovalConfigRow> {
  if (!user.roles.includes("admin")) {
    throw new ApiError(403, "仅管理员可修改审批节点配置");
  }
  const docType = String(input.docType ?? "").trim();
  const approverRole = String(input.approverRole ?? "").trim() as Role;
  if (!ASSIGNABLE_APPROVER_ROLES.includes(approverRole)) {
    throw new ApiError(400, `审批角色非法；管理员本就全域可审，不接受指定为 admin`);
  }

  const db: AnyDb = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyDb) => {
    const [existing] = await tx
      .select({ docType: approvalConfigs.docType, approverRole: approvalConfigs.approverRole })
      .from(approvalConfigs)
      .where(eq(approvalConfigs.docType, docType));
    // 只改已登记的审批域：凭空造 docType 不会被任何单据引用，却让配置看起来"配过了"
    if (!existing) throw new ApiError(404, `未登记的审批域：${docType || "(空)"}`);

    if (existing.approverRole === approverRole) {
      return {
        docType,
        docTypeLabel: APPROVAL_DOMAIN_LABELS[docType] ?? docType,
        approverRole,
        approverRoleLabel: ROLE_LABELS[approverRole] ?? approverRole,
      };
    }

    await tx
      .update(approvalConfigs)
      .set({ approverRole })
      .where(eq(approvalConfigs.docType, docType));

    await writeAudit(tx, {
      userId: user.id,
      entity: "approval_config",
      action: "update",
      before: { docType, approverRole: existing.approverRole },
      after: { docType, approverRole },
    });

    return {
      docType,
      docTypeLabel: APPROVAL_DOMAIN_LABELS[docType] ?? docType,
      approverRole,
      approverRoleLabel: ROLE_LABELS[approverRole] ?? approverRole,
    };
  });
}
