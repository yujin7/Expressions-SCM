import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import { createWo, listWos } from "@/server/modules/outsource/wo";
import { createWoRequestSchema } from "@/server/modules/outsource/schemas";

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    return NextResponse.json(
      await listWos(q, {
        status: searchParams.get("status") ?? undefined,
        // 制单时间窗（全链漏斗回链）
        from: searchParams.get("from") ?? undefined,
        to: searchParams.get("to") ?? undefined,
        page,
        pageSize,
      }),
    );
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite(); // 角色（pmc）在 service 内校验
    const input = createWoRequestSchema.parse(await readJson(req));
    const doc = await createWo(user, input);
    return NextResponse.json({ requestKey: input.requestKey, document: { id: doc.id, docNo: doc.docNo, status: doc.status } }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
