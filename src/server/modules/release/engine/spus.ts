/** release 流水线：spus（自 engine.ts 拆出，行为未变） */
import { and, eq, isNotNull } from "drizzle-orm";

import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";


import type { SpuCluster } from "@/server/import/adapters/bom-spu";
import { type AnyDb, type ReleaseUser, resolveDb, loadStagedRows, commitRows, nextSpuCodeIn } from "./common";

export interface SpuOverride {
  action: "accept" | "mergeInto";
  targetSpuKey?: string;
  nameOverride?: string;
}

export interface ReleaseSpusResult {
  dryRun: boolean;
  created: { spuKey: string; spuId: number | null; code: string | null; name: string }[];
  existing: number;
  merged: number;
  needsReview: { spuKey: string; members: string[]; reason: string }[];
}

export async function releaseSpus(
  user: ReleaseUser,
  args: { jobIds?: number[]; overrides?: Record<string, SpuOverride>; dryRun: boolean },
  dbArg?: AnyDb,
): Promise<ReleaseSpusResult> {
  const db = await resolveDb(dbArg);
  const rows = await loadStagedRows(db, "spu_suggestion", args.jobIds);

  // 同 spuKey 跨 job 去重（payload 首见为准，行集合并）
  const clusters = new Map<string, { payload: SpuCluster; rowIds: number[] }>();
  for (const r of rows) {
    const p = r.payload as Partial<SpuCluster>;
    if (typeof p.spuKey !== "string" || !Array.isArray(p.members)) continue;
    const c = clusters.get(p.spuKey);
    if (c) c.rowIds.push(r.id);
    else clusters.set(p.spuKey, { payload: p as SpuCluster, rowIds: [r.id] });
  }

  // 既往已放行的簇（跨 job）：spuKey → spuId
  const committed: { payload: unknown; targetId: number | null }[] = await db
    .select({ payload: schema.stagingRows.payload, targetId: schema.stagingRows.targetId })
    .from(schema.stagingRows)
    .where(
      and(
        eq(schema.stagingRows.targetTable, "spu_suggestion"),
        eq(schema.stagingRows.status, "committed"),
        isNotNull(schema.stagingRows.targetId),
      ),
    );
  const committedByKey = new Map<string, number>();
  for (const r of committed) {
    const p = r.payload as Partial<SpuCluster>;
    if (typeof p.spuKey === "string" && r.targetId != null) committedByKey.set(p.spuKey, r.targetId);
  }

  const overrides = args.overrides ?? {};
  const creates: { spuKey: string; name: string; members: string[]; rowIds: number[] }[] = [];
  const merges: { spuKey: string; targetSpuKey: string; members: string[]; rowIds: number[] }[] = [];
  const existings: { rowIds: number[]; targetId: number }[] = [];
  const needsReview: ReleaseSpusResult["needsReview"] = [];

  for (const [key, c] of [...clusters.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const done = committedByKey.get(key);
    if (done != null) {
      existings.push({ rowIds: c.rowIds, targetId: done });
      continue;
    }
    const ov = overrides[key];
    if (ov?.action === "mergeInto") {
      if (!ov.targetSpuKey) {
        needsReview.push({ spuKey: key, members: c.payload.members, reason: "mergeInto 缺 targetSpuKey" });
      } else {
        merges.push({ spuKey: key, targetSpuKey: ov.targetSpuKey, members: c.payload.members, rowIds: c.rowIds });
      }
      continue;
    }
    if (c.payload.confidence === "auto" || ov?.action === "accept") {
      creates.push({
        spuKey: key,
        name: ov?.nameOverride ?? c.payload.suggestedName,
        members: c.payload.members,
        rowIds: c.rowIds,
      });
      continue;
    }
    // §4.1：review 簇无人工裁决 → 100% 留待人工，引擎不归组
    needsReview.push({
      spuKey: key,
      members: c.payload.members,
      reason: (c.payload.reasons ?? []).join("；") || "需人工归组（§4.1 双证不一致）",
    });
  }

  // merge 目标必须已放行或本轮被接受——否则退回待复核（绝不空指）
  const createKeys = new Set(creates.map((c) => c.spuKey));
  const validMerges = merges.filter((m) => {
    const ok = committedByKey.has(m.targetSpuKey) || createKeys.has(m.targetSpuKey);
    if (!ok) needsReview.push({ spuKey: m.spuKey, members: m.members, reason: `合并目标 SPU 未放行：${m.targetSpuKey}` });
    return ok;
  });

  if (args.dryRun) {
    return {
      dryRun: true,
      created: creates.map((c) => ({ spuKey: c.spuKey, spuId: null, code: null, name: c.name })),
      existing: existings.length,
      merged: validMerges.length,
      needsReview,
    };
  }

  const createdOut: ReleaseSpusResult["created"] = [];
  await db.transaction(async (tx: AnyDb) => {
    const idByKey = new Map<string, number>(committedByKey);
    for (const c of creates) {
      const code = await nextSpuCodeIn(tx);
      const [spu] = await tx
        .insert(schema.spus)
        .values({ code, nameCn: c.name })
        .returning({ id: schema.spus.id });
      idByKey.set(c.spuKey, spu.id);
      await commitRows(tx, c.rowIds, spu.id);
      createdOut.push({ spuKey: c.spuKey, spuId: spu.id, code, name: c.name });
    }
    for (const m of validMerges) {
      await commitRows(tx, m.rowIds, idByKey.get(m.targetSpuKey)!);
    }
    for (const e of existings) await commitRows(tx, e.rowIds, e.targetId);
    await writeAudit(tx, {
      userId: user.id,
      entity: "release_spu",
      action: "release",
      after: {
        jobIds: args.jobIds ?? null,
        created: createdOut.length,
        existing: existings.length,
        merged: validMerges.length,
        needsReview: needsReview.length,
      },
    });
  });

  return { dryRun: false, created: createdOut, existing: existings.length, merged: validMerges.length, needsReview };
}
