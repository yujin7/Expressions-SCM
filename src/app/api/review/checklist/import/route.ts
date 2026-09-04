import { NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardReviewImport, importReviewChecklist } from "@/server/modules/review/checklist";

/**
 * 代决清单导入（W2）：把 `scripts/seed-review-items.ts` 唯一能做的那件事搬进应用。
 * 仅管理员（角色判定在 service 内）；新鲜会话回查；同事务写审计；按 title 幂等，可重复导入。
 */
export async function POST(req: NextRequest) {
  try {
    const user = await guardReviewImport();
    return NextResponse.json(await importReviewChecklist(user, await readJson(req)), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
