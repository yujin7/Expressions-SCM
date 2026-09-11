import { NextRequest, NextResponse } from "next/server";
import { getChannel, updateChannel } from "@/server/modules/master/channel";
import { errorResponse, guardRead, guardWrite, parseId, readJson } from "@/server/modules/master/common";

/** 单条渠道（CrudTable 编辑前读完整记录） */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await guardRead();
    const { id } = await ctx.params;
    return NextResponse.json(await getChannel(parseId(id)));
  } catch (error) {
    return errorResponse(error, { path: "/api/master/channel/[id]", method: "GET" });
  }
}

/**
 * 改名 / 改类型 / 启停（编码不可改——它是别名解析与外部映射的稳定业务键）。
 * 审计随写入落在同一事务内（master/channel.ts）。
 */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWrite("channel");
    const { id } = await ctx.params;
    return NextResponse.json(await updateChannel(parseId(id), await readJson(req), user));
  } catch (error) {
    return errorResponse(error, { path: "/api/master/channel/[id]", method: "PUT" });
  }
}

/** PATCH 与 PUT 等价（只改传来的字段）：启停按钮走这条更贴切 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await guardWrite("channel");
    const { id } = await ctx.params;
    return NextResponse.json(await updateChannel(parseId(id), await readJson(req), user));
  } catch (error) {
    return errorResponse(error, { path: "/api/master/channel/[id]", method: "PATCH" });
  }
}
