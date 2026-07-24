import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseId } from "@/server/modules/master/common";
import { getAttachmentFile, mimeOf } from "@/server/modules/attachment/service";

/** 附件下载：仅经鉴权路由（uploads/ 不静态托管）；行缺失/磁盘缺失均 404 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardRead();
    const { id } = await ctx.params;
    const found = await getAttachmentFile(parseId(id));
    if (!found) return NextResponse.json({ error: "附件不存在或文件已缺失" }, { status: 404 });
    return new NextResponse(new Uint8Array(found.data), {
      headers: {
        "Content-Type": mimeOf(found.meta.filename),
        "Content-Length": String(found.data.byteLength),
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(found.meta.filename)}`,
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
