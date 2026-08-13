import { NextRequest, NextResponse } from "next/server";
import { getFreshSessionUser } from "@/server/core/dto";
import { getYonyouFieldProfileReview } from "@/server/modules/admin/health";
import { guardAdmin } from "@/server/modules/admin/users";
import { errorResponse, parseId, todayShanghai } from "@/server/modules/master/common";
import { csvDisposition, toCsv, type CsvColumn } from "@/server/modules/report/export";

export const dynamic = "force-dynamic";

const COLUMNS: CsvColumn[] = [
  { key: "runId", title: "运行ID" },
  { key: "stream", title: "数据流" },
  { key: "contract", title: "用友API契约" },
  { key: "schemaVersion", title: "契约版本" },
  { key: "schemaBaselineRunId", title: "结构基线运行ID" },
  { key: "schemaDrift", title: "是否结构漂移" },
  { key: "shapeFingerprintHash", title: "结构指纹SHA256" },
  { key: "totalRecords", title: "源记录数" },
  { key: "sampledRecords", title: "画像样本数" },
  { key: "profileTruncated", title: "是否有界截断" },
  { key: "fieldPath", title: "源字段路径" },
  { key: "types", title: "观察类型" },
  { key: "presentInRecords", title: "出现记录数" },
  { key: "coveragePercent", title: "样本覆盖率" },
  { key: "optional", title: "是否可选" },
  { key: "nullable", title: "是否观察到空值" },
  { key: "sensitiveCategory", title: "敏感分类键" },
  { key: "sensitiveCategoryLabel", title: "敏感分类" },
  { key: "mappingStatus", title: "映射状态" },
  { key: "businessMeaning", title: "业务含义（待填）" },
  { key: "targetEntity", title: "目标实体（待填）" },
  { key: "targetField", title: "目标字段（待填）" },
  { key: "unitOrTimezone", title: "单位/时区（待填）" },
  { key: "missingValueMeaning", title: "缺失值语义（待填）" },
  { key: "intendedUse", title: "拟用途（观察/对账/正式事实）" },
  { key: "reviewer", title: "审核人（待填）" },
  { key: "notes", title: "备注（待填）" },
];

/** 管理员下载单次用友运行的无值字段映射评审表。 */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getFreshSessionUser();
    guardAdmin(user);
    const runId = parseId((await ctx.params).id);
    const review = await getYonyouFieldProfileReview(runId);
    const rows = review.rows.map((row) => ({
      ...row,
      runId: review.runId,
      stream: review.stream,
      contract: review.contract,
      schemaVersion: review.schemaVersion,
      schemaBaselineRunId: review.schemaBaselineRunId,
      schemaDrift: review.schemaDrift ? "是" : "否",
      shapeFingerprintHash: review.shapeFingerprintHash,
      totalRecords: review.totalRecords,
      sampledRecords: review.sampledRecords,
      profileTruncated: review.truncated ? "是" : "否",
      optional: row.optional ? "是" : "否",
      nullable: row.nullable ? "是" : "否",
    }));
    return new NextResponse(toCsv(rows, COLUMNS), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": csvDisposition(`用友字段映射评审_运行${runId}_${todayShanghai()}`),
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  } catch (error) {
    return errorResponse(error, {
      path: "/api/admin/health/connector-runs/[id]/field-profile",
      method: "GET",
    });
  }
}
