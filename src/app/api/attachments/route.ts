import { NextRequest, NextResponse } from "next/server";
import { ApiError, errorResponse, guardRead } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { listAttachments, uploadAttachment } from "@/server/modules/attachment/service";

/** 附件列表：?entity=sku|supplier|qc|sh&entityId=<id>（读权限=登录即可，同其余明细） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const sp = new URL(req.url).searchParams;
    return NextResponse.json(await listAttachments(sp.get("entity"), sp.get("entityId")));
  } catch (e) {
    return errorResponse(e);
  }
}

/** 上传（multipart：entity/entityId/file）；角色映射在 service（sku→pmc、supplier→purchasing、qc|sh→warehouse，admin 兜底） */
export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite(); // 写路径回查 DB 新鲜身份
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(400, "缺少文件");
    const dto = await uploadAttachment(user, {
      entity: form.get("entity"),
      entityId: form.get("entityId"),
      file,
    });
    return NextResponse.json(dto, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
