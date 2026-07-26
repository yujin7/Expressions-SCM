import { NextRequest, NextResponse } from "next/server";
import { ilike, or } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { brands } from "@/db/schema";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";

/** 品牌列表（UX 走查 #5：SKU 表单品牌下拉的数据源；管理页 1.x） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize } = parseListQuery(req.url);
    const db = await getDbAsync();
    const where = q ? or(ilike(brands.code, `%${q}%`), ilike(brands.nameCn, `%${q}%`)) : undefined;
    const data = await db.select().from(brands).where(where).orderBy(brands.sortOrder).limit(pageSize).offset((page - 1) * pageSize);
    return NextResponse.json({ data, total: data.length });
  } catch (e) {
    return errorResponse(e);
  }
}
