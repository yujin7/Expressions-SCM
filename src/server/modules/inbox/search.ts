import { ilike, or } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import {
  npdProjects,
  bhDocs, ctDocs, flDocs, jgDocs, jsDocs, pcDocs, pdDocs, poDocs,
  shDocs, skus, stockDocs, suppliers, tlDocs, woDocs,
} from "@/db/schema";
import { getDbAsync } from "@/db";
import type { AnyDb } from "@/server/docflow/doc-no";
import { INBOX_DOC_TYPE_LABELS, INBOX_PAGE_HREFS } from "./service";

/**
 * 全局搜索（只读聚合）：SKU（编码/名称）、单据号（前缀匹配）、供应商（编码/名称）。
 * 快速返回：全部查询 Promise.all 并行，总量上限 ~25 行。
 */

export interface SearchItem {
  label: string;
  href: string;
  tag?: string;
}

export interface SearchResult {
  groups: { title: string; items: SearchItem[] }[];
}

/** ILIKE 通配符转义（q 是用户输入） */
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (m) => `\\${m}`);
}

const DOC_TABLES: { docType: string; table: AnyPgTable & { docNo: AnyPgColumn; id: AnyPgColumn } }[] = [
  { docType: "bh", table: bhDocs },
  { docType: "wo", table: woDocs },
  { docType: "po", table: poDocs },
  { docType: "pc", table: pcDocs },
  { docType: "jg", table: jgDocs },
  { docType: "fl", table: flDocs },
  { docType: "tl", table: tlDocs },
  { docType: "sh", table: shDocs },
  { docType: "ct", table: ctDocs },
  { docType: "js", table: jsDocs },
  { docType: "stock_doc", table: stockDocs },
  { docType: "pd", table: pdDocs },
];

const TOTAL_CAP = 25;

export async function searchAll(qRaw: string, dbArg?: AnyDb): Promise<SearchResult> {
  const q = qRaw.trim();
  if (q.length < 2) return { groups: [] };
  const db = dbArg ?? (await getDbAsync());
  const contains = `%${escapeLike(q)}%`;
  const prefix = `${escapeLike(q)}%`;

  const [skuRows, supplierRows, npdRows, ...docRows] = await Promise.all([
    db
      .select({ code: skus.code, name: skus.name })
      .from(skus)
      .where(or(ilike(skus.code, contains), ilike(skus.name, contains)))
      .orderBy(skus.code)
      .limit(5),
    db
      .select({ code: suppliers.code, name: suppliers.name })
      .from(suppliers)
      .where(or(ilike(suppliers.code, contains), ilike(suppliers.name, contains)))
      .orderBy(suppliers.code)
      .limit(3),
    db
      .select({ id: npdProjects.id, name: npdProjects.name })
      .from(npdProjects)
      .where(or(ilike(npdProjects.name, contains), ilike(npdProjects.skuCode, contains)))
      .orderBy(npdProjects.id)
      .limit(3),
    ...DOC_TABLES.map(({ table }) =>
      db
        .select({ id: table.id, docNo: table.docNo })
        .from(table as AnyPgTable)
        .where(ilike(table.docNo, prefix))
        .orderBy(table.docNo)
        .limit(3),
    ),
  ]);

  const groups: SearchResult["groups"] = [];

  const skuItems: SearchItem[] = skuRows.map((r) => ({
    label: `${r.code} ${r.name}`,
    href: `/inventory/balance?q=${encodeURIComponent(r.code)}`,
    tag: "SKU",
  }));
  if (skuItems.length > 0) groups.push({ title: "商品", items: skuItems });

  const npdItems: SearchItem[] = (npdRows as { id: number; name: string }[]).map((r) => ({
    label: r.name,
    href: "/npd",
    tag: "NPD",
  }));
  if (npdItems.length > 0) groups.push({ title: "NPD 项目", items: npdItems });

  const docItems: SearchItem[] = DOC_TABLES.flatMap(({ docType }, idx) =>
    (docRows[idx] as { id: number; docNo: string }[]).map((r) => ({
      label: r.docNo,
      href: INBOX_PAGE_HREFS[docType] ?? "/",
      tag: INBOX_DOC_TYPE_LABELS[docType] ?? docType,
    })),
  );
  const supplierItems: SearchItem[] = supplierRows.map((r) => ({
    label: `${r.code} ${r.name}`,
    href: `/master/supplier?q=${encodeURIComponent(r.code)}`,
    tag: "供应商",
  }));

  // 总量封顶：单据组吃剩余额度
  const docCap = Math.max(0, TOTAL_CAP - skuItems.length - supplierItems.length);
  if (docItems.length > 0 && docCap > 0) groups.push({ title: "单据", items: docItems.slice(0, docCap) });
  if (supplierItems.length > 0) groups.push({ title: "供应商", items: supplierItems });

  return { groups };
}
