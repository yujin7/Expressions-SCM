import { NextRequest, NextResponse } from "next/server";
import { and, ilike, or, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import { brands } from "@/db/schema";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { parseSelectedValues, selectedOptionsPredicate, SELECTED_OPTIONS_LIMIT } from "@/server/core/selected-options";

/** 品牌列表（UX 走查 #5：SKU 表单品牌下拉的数据源；管理页 1.x） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const selectedValues = parseSelectedValues(searchParams);
    const db = await getDbAsync();
    const where = and(
      q ? or(ilike(brands.code, `%${q}%`), ilike(brands.nameCn, `%${q}%`)) : undefined,
      selectedOptionsPredicate(selectedValues, { id: brands.id, text: [brands.code, brands.nameCn] }),
    );
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(brands).where(where);
    const exact = selectedValues !== undefined;
    const data = await db.select().from(brands).where(where).orderBy(brands.sortOrder, brands.id)
      .limit(exact ? SELECTED_OPTIONS_LIMIT : pageSize).offset(exact ? 0 : (page - 1) * pageSize);
    return NextResponse.json({ data, total: count });
  } catch (e) {
    return errorResponse(e);
  }
}
