import { NextRequest, NextResponse } from "next/server";
import { errorResponse, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { createReplenishDraftSchema } from "@/server/modules/replenish/service";
import { bhRequestKeySchema, createBhRequest } from "@/server/modules/outsource/bh-create-request";

const requestSchema = createReplenishDraftSchema.extend({ requestKey: bhRequestKeySchema });

/** 补货建议 → ONE 张 BH 备货申请草稿（R13 人工闸；pmc/admin，新鲜会话回查） */
export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite(); // 角色（pmc/admin）在 service 内校验
    const value = requestSchema.parse(await readJson(req));
    return NextResponse.json(await createBhRequest(user, {
      requestKey: value.requestKey, remark: value.remark, lines: value.items,
    }, "replenish"), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
