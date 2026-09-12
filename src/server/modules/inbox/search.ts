import { and, ilike, or } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import { match } from "pinyin-pro";
import {
  npdProjects,
  bhDocs, ctDocs, flDocs, jgDocs, jsDocs, pcDocs, pdDocs, poDocs,
  shDocs, skus, stockDocs, suppliers, tlDocs, woDocs,
} from "@/db/schema";
import { getDbAsync } from "@/db";
import type { AnyDb } from "@/server/docflow/doc-no";
import { INBOX_DOC_TYPE_LABELS, INBOX_PAGE_HREFS } from "./service";
import { bhReadScope, type BhReadUser } from "@/server/core/bh-read-scope";
import { loadDestinationReader } from "./read-access";

/**
 * 全局搜索（只读聚合）：SKU（编码/名称/拼音）、单据号（前缀匹配）、
 * 供应商与 NPD（编码/名称/拼音）。
 * 快速返回：全部查询 Promise.all 并行，总量上限 ~25 行。
 *
 * 中文与编码仍走数据库 ILIKE；只有纯罗马字母输入且直接命中不足时才加载轻量名称目录做
 * 拼音/首字母匹配。生产目录缓存 60 秒，主数据刚修改后的短暂陈旧只影响导航建议，不影响事实。
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
const HAN_TEXT = /[\u3400-\u9fff]/;
const ROMANIZED_QUERY = /^[a-zA-ZüÜvV\s'-]+$/;
const CATALOG_TTL_MS = 60_000;

interface NamedCode {
  code: string;
  name: string;
}

interface NamedId {
  id: number;
  name: string;
}

interface RomanizedCatalog {
  skus: NamedCode[];
  suppliers: NamedCode[];
  npd: NamedId[];
}

let catalogCache: { expiresAt: number; value: RomanizedCatalog } | null = null;

function isRomanizedQuery(value: string): boolean {
  return value.length >= 2 && ROMANIZED_QUERY.test(value) && /[a-zA-ZüÜvV]/.test(value);
}

export function matchesRomanizedName(name: string, query: string): boolean {
  if (!HAN_TEXT.test(name) || !isRomanizedQuery(query)) return false;
  const normalized = query.toLocaleLowerCase("zh-CN").replace(/[\s'-]+/g, "");
  // Cosmetics names commonly wrap brands/specifications in punctuation, e.g.
  // "（微初）水杨酸…(25ml×15片)". Punctuation must not split a continuous
  // pinyin query; native Chinese/code search still uses the untouched name.
  const hanName = [...name].filter((character) => HAN_TEXT.test(character)).join("");
  return match(hanName, normalized, {
    continuous: true,
    v: true,
  }) != null;
}

async function loadRomanizedCatalog(db: AnyDb, cacheable: boolean): Promise<RomanizedCatalog> {
  const now = Date.now();
  if (cacheable && catalogCache && catalogCache.expiresAt > now) return catalogCache.value;
  const [skuRows, supplierRows, npdRows] = await Promise.all([
    db.select({ code: skus.code, name: skus.name }).from(skus).orderBy(skus.code),
    db.select({ code: suppliers.code, name: suppliers.name }).from(suppliers).orderBy(suppliers.code),
    db.select({ id: npdProjects.id, name: npdProjects.name }).from(npdProjects).orderBy(npdProjects.id),
  ]);
  const value = {
    skus: skuRows as NamedCode[],
    suppliers: supplierRows as NamedCode[],
    npd: npdRows as NamedId[],
  };
  if (cacheable) catalogCache = { expiresAt: now + CATALOG_TTL_MS, value };
  return value;
}

function appendRomanized<T extends { name: string }>(
  direct: T[],
  catalog: T[],
  query: string,
  cap: number,
  identity: (row: T) => string | number,
): T[] {
  if (direct.length >= cap) return direct.slice(0, cap);
  const seen = new Set(direct.map(identity));
  const appended = catalog.filter((row) => {
    const key = identity(row);
    if (seen.has(key) || !matchesRomanizedName(row.name, query)) return false;
    seen.add(key);
    return true;
  });
  return [...direct, ...appended].slice(0, cap);
}

export async function searchAll(qRaw: string, dbArg?: AnyDb, user?: BhReadUser): Promise<SearchResult> {
  const q = qRaw.trim();
  if (q.length < 2) return { groups: [] };
  const db = dbArg ?? (await getDbAsync());
  const contains = `%${escapeLike(q)}%`;
  const prefix = `${escapeLike(q)}%`;
  // Internal tests/background callers may omit actor; HTTP always supplies the session.
  const mayNavigate = user ? await loadDestinationReader(db, user) : () => true;

  const [directSkuRows, directSupplierRows, directNpdRows, ...docRows] = await Promise.all([
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
    ...DOC_TABLES.map(({ table, docType }) =>
      !mayNavigate(INBOX_PAGE_HREFS[docType]) ? Promise.resolve([]) : db
        .select({ id: table.id, docNo: table.docNo })
        .from(table as AnyPgTable)
        .where(and(ilike(table.docNo, prefix), docType === "bh" ? bhReadScope(db, user) : undefined))
        .orderBy(table.docNo)
        .limit(3),
    ),
  ]);

  let skuRows = directSkuRows as NamedCode[];
  let supplierRows = directSupplierRows as NamedCode[];
  let npdRows = directNpdRows as NamedId[];
  if (isRomanizedQuery(q)) {
    const catalog = await loadRomanizedCatalog(db, dbArg == null);
    skuRows = appendRomanized(skuRows, catalog.skus, q, 5, (row) => row.code);
    supplierRows = appendRomanized(supplierRows, catalog.suppliers, q, 3, (row) => row.code);
    npdRows = appendRomanized(npdRows, catalog.npd, q, 3, (row) => row.id);
  }

  const groups: SearchResult["groups"] = [];

  const skuItems: SearchItem[] = skuRows.map((r) => ({
    label: `${r.code} ${r.name}`,
    href: `/inventory/balance?q=${encodeURIComponent(r.code)}`,
    tag: "SKU",
  }));
  if (skuItems.length > 0) groups.push({ title: "商品", items: skuItems });

  const npdItems: SearchItem[] = npdRows.map((r) => ({
    label: r.name,
    href: documentHref("npd", r.id)!,
    tag: "NPD",
  }));
  if (npdItems.length > 0) groups.push({ title: "NPD 项目", items: npdItems });

  const docItems: SearchItem[] = DOC_TABLES.flatMap(({ docType }, idx) =>
    (docRows[idx] as { id: number; docNo: string }[]).map((r) => ({
      label: r.docNo,
      href: documentHref(docType, r.id) ?? "/",
      tag: INBOX_DOC_TYPE_LABELS[docType] ?? docType,
    })),
  );
  const supplierItems: SearchItem[] = supplierRows.map((r) => ({
    label: `${r.code} ${r.name}`,
    href: `/master/supplier?q=${encodeURIComponent(r.code)}`,
    tag: "供应商",
  }));

  // 总量封顶：单据组吃剩余额度
  const docCap = Math.max(
    0,
    TOTAL_CAP - skuItems.length - supplierItems.length - npdItems.length,
  );
  if (docItems.length > 0 && docCap > 0) groups.push({ title: "单据", items: docItems.slice(0, docCap) });
  if (supplierItems.length > 0) groups.push({ title: "供应商", items: supplierItems });

  return { groups };
}
import { documentHref } from "@/lib/document-links";
