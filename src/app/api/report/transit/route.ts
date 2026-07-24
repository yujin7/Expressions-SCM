import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";

/** 在途参考层查询（D16 只读；kind=fg_order/pkg_order/pkg_stock/oem_map） */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    const kind = searchParams.get("kind") ?? "fg_order";
    const db = await getDbAsync();
    const t = schema.transitRefs;
    const conds = [eq(t.kind, kind)];
    if (q) {
      conds.push(
        or(
          ilike(t.skuCode, `%${q}%`),
          ilike(t.materialCode, `%${q}%`),
          ilike(t.materialName, `%${q}%`),
          ilike(t.approvalNo, `%${q}%`),
          ilike(t.externalNo, `%${q}%`),
        )!,
      );
    }
    const where = and(...conds);
    const [rows, [{ total }], [meta]] = await Promise.all([
      db.select().from(t).where(where).orderBy(desc(t.orderDate), desc(t.id)).limit(pageSize).offset((page - 1) * pageSize),
      db.select({ total: sql<number>`count(*)::int` }).from(t).where(where),
      db.select({ importedAt: sql<string | null>`max(${t.createdAt})` }).from(t).where(eq(t.kind, kind)),
    ]);
    return NextResponse.json({ rows, total, importedAt: meta?.importedAt ?? null });
  } catch (e) {
    return errorResponse(e);
  }
}
