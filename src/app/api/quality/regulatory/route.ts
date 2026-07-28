import { NextRequest, NextResponse } from "next/server";
import {
  errorResponse,
  readJson,
} from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import {
  createRegulatoryRecord,
  listRegulatoryRecords,
} from "@/server/modules/quality/service";

export async function GET(req: NextRequest) {
  try {
    // 监管证据含受控载荷和证据引用；读也必须回查当前账号、角色和 session_version。
    const user = await guardFreshWrite();
    const searchParams = new URL(req.url).searchParams;
    return NextResponse.json(await listRegulatoryRecords(user, {
      q: searchParams.get("q") ?? undefined,
      marketCode: searchParams.get("marketCode") ?? undefined,
      recordType: searchParams.get("recordType") ?? undefined,
    }));
  } catch (e) {
    return errorResponse(e, { path: "/api/quality/regulatory", method: "GET" });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const created = await createRegulatoryRecord(user, await readJson(req));
    return NextResponse.json(created, { status: 201 });
  } catch (e) {
    return errorResponse(e, { path: "/api/quality/regulatory", method: "POST" });
  }
}
