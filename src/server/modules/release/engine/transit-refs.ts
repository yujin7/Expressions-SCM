/** release 流水线：transit-refs（自 engine.ts 拆出，行为未变） */
import { inArray } from "drizzle-orm";

import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";



import { type AnyDb, type ReleaseUser, resolveDb, loadStagedRows, commitRows, aliasCache, loadSkuIdByCode } from "./common";
import { assertImportPreflight, type PreflightOverrides } from "./preflight";

export interface ReleaseTransitResult {
  dryRun: boolean;
  byKind: Record<string, number>;
  skuResolved: number;
  skuUnresolved: number;
  materialResolved: number;
  materialUnresolved: number;
  supplierResolved: number;
  replacedOldRows: number;
}

/**
 * staging(transit_ref) → transit_refs。语义=整类替换（同 kind 旧行删除后写入本批）——
 * 参考层月度重导即全量刷新，与快照口径一致；绝不入账本。
 * SKU/供应商解析：别名优先、码面兜底；未命中留空仍登记（参考层不因解析缺失而丢行）。
 */
export async function releaseTransitRefs(
  user: ReleaseUser,
  args: { jobIds?: number[]; preflightOverrides?: PreflightOverrides; dryRun: boolean },
  dbArg?: AnyDb,
): Promise<ReleaseTransitResult> {
  const db = await resolveDb(dbArg);
  await assertImportPreflight(db, user, args);
  const rows = await loadStagedRows(db, "transit_ref", args.jobIds);
  const resolve = aliasCache(db);

  interface P {
    kind?: string; skuCode?: string | null; materialCode?: string | null; oemRaw?: string | null;
    _resolved?: Record<string, unknown>;
    [k: string]: unknown;
  }
  const codes: string[] = [];
  for (const r of rows) {
    const p = r.payload as P;
    if (typeof p.skuCode === "string") codes.push(p.skuCode);
    if (typeof p.materialCode === "string") codes.push(p.materialCode);
  }
  const skuByCode = await loadSkuIdByCode(db, codes);

  const byKind: Record<string, number> = {};
  let skuResolved = 0, skuUnresolved = 0;
  let materialResolved = 0, materialUnresolved = 0;
  let supplierResolved = 0;
  const plans: { rowId: number; values: typeof schema.transitRefs.$inferInsert }[] = [];
  const jobIds = new Set<number>();
  const strOrNull = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : null);

  for (const r of rows) {
    const p = r.payload as P;
    const kind = typeof p.kind === "string" ? p.kind : null;
    if (!kind || !["fg_order", "pkg_order", "pkg_stock", "oem_map", "demand", "borrow", "pallet", "npd_node", "npd_role", "stock_summary"].includes(kind)) continue;
    jobIds.add(r.importJobId);
    const stagedResolved = p._resolved ?? {};
    const stagedId = (key: string): number | null => {
      const value = stagedResolved[key];
      return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
    };
    const skuCode = (p.skuCode as string | null) ?? null;
    let skuId: number | null = null;
    if (skuCode) {
      skuId = (await resolve("sku_code", skuCode)) ?? stagedId("skuId") ?? skuByCode.get(skuCode) ?? null;
      if (skuId != null) skuResolved++;
      else skuUnresolved++;
    }
    const materialCode = strOrNull(p.materialCode);
    let materialSkuId: number | null = null;
    if (materialCode) {
      materialSkuId =
        (await resolve("sku_code", materialCode))
        ?? stagedId("materialSkuId")
        ?? skuByCode.get(materialCode)
        ?? null;
      if (materialSkuId != null) materialResolved++;
      else materialUnresolved++;
    }
    let supplierId: number | null = null;
    const oemRaw = (p.oemRaw as string | null) ?? null;
    if (oemRaw && oemRaw !== "/") {
      supplierId = (await resolve("supplier_oem", oemRaw)) ?? stagedId("supplierId");
      if (supplierId != null) supplierResolved++;
    }
    const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : null);
    const ISO = /^\d{4}-\d{2}-\d{2}$/;
    const dateOrNull = (v: unknown) => (typeof v === "string" && ISO.test(v) ? v : null);
    plans.push({
      rowId: r.id,
      values: {
        kind,
        brandRaw: strOrNull(p.brandRaw),
        skuCode,
        skuId,
        materialCode,
        materialSkuId,
        materialName: strOrNull(p.materialName),
        oemRaw,
        supplierId,
        externalNo: strOrNull(p.externalNo),
        approvalNo: strOrNull(p.approvalNo),
        feishuNo: strOrNull(p.feishuNo),
        orderType: strOrNull(p.orderType),
        qty: numOrNull(p.qty),
        doneQty: numOrNull(p.doneQty),
        inboundQty: numOrNull(p.inboundQty),
        closedQty: numOrNull(p.closedQty),
        usedQty: numOrNull(p.usedQty),
        remainQty: numOrNull(p.remainQty),
        orderDate: dateOrNull(p.orderDate),
        needDate: dateOrNull(p.needDate),
        replyDate: dateOrNull(p.replyDate),
        revisedDate: dateOrNull(p.revisedDate),
        expectDate: dateOrNull(p.expectDate),
        startDate: dateOrNull(p.startDate),
        progress: strOrNull(p.progress),
        urgentDept: strOrNull(p.urgentDept),
        follower: strOrNull(p.follower),
        exception: strOrNull(p.exception),
        extra: (p.extra as Record<string, unknown> | null) ?? null,
        sourceJobId: r.importJobId,
      },
    });
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }

  if (args.dryRun) {
    return {
      dryRun: true,
      byKind,
      skuResolved,
      skuUnresolved,
      materialResolved,
      materialUnresolved,
      supplierResolved,
      replacedOldRows: 0,
    };
  }

  let replacedOldRows = 0;
  await db.transaction(async (tx: AnyDb) => {
    const kinds = Object.keys(byKind);
    if (kinds.length > 0) {
      const old = await tx
        .delete(schema.transitRefs)
        .where(inArray(schema.transitRefs.kind, kinds))
        .returning({ id: schema.transitRefs.id });
      replacedOldRows = old.length;
    }
    const CHUNK = 300;
    for (let i = 0; i < plans.length; i += CHUNK) {
      await tx.insert(schema.transitRefs).values(plans.slice(i, i + CHUNK).map((p) => p.values));
    }
    await commitRows(tx, plans.map((p) => p.rowId), null);
    await writeAudit(tx, {
      userId: user.id,
      entity: "release_transit_ref",
      action: "release",
      after: {
        jobIds: [...jobIds],
        byKind,
        skuResolved,
        skuUnresolved,
        materialResolved,
        materialUnresolved,
        supplierResolved,
        replacedOldRows,
      },
    });
  });
  return {
    dryRun: false,
    byKind,
    skuResolved,
    skuUnresolved,
    materialResolved,
    materialUnresolved,
    supplierResolved,
    replacedOldRows,
  };
}

/* ══ 9b) releaseSkuParams（生产周期 → sku_params 正式表，E 项转正） ══════ */
