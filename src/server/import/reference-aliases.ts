/**
 * 自定义参考层适配器的别名治理桥：
 * 这些适配器不走通用 stagePipeline，但仍必须让未解析维度进入人工认领队列。
 */
import type { AliasType } from "@/db/schema";
import {
  resolveKnownOrQueue,
  type DimDb,
} from "@/server/modules/dimension/resolver";
import type { AliasRef } from "./adapters/types";
import type { AnyDb, StagingRowInput } from "./staging";

export interface ReferenceAliasSummary {
  rows: StagingRowInput[];
  validated: number;
  pending: number;
  unresolved: Partial<Record<AliasType, number>>;
}

const PLACEHOLDERS = new Set(["/", "-", "—"]);

export async function resolveReferenceAliases(
  db: AnyDb,
  args: {
    filePath: string;
    template: string;
    rows: StagingRowInput[];
    aliasRefs: (row: StagingRowInput) => AliasRef[];
  },
): Promise<ReferenceAliasSummary> {
  const file = args.filePath.split("/").pop() ?? args.filePath;
  const cache = new Map<string, number | null>();
  const unresolvedValues = new Map<AliasType, Set<string>>();
  const rows: StagingRowInput[] = [];
  let validated = 0;
  let pending = 0;

  for (const row of args.rows) {
    const misses: string[] = [];
    const resolved: Record<string, number> = {};
    for (const ref of args.aliasRefs(row)) {
      const raw = ref.value == null ? "" : String(ref.value).trim();
      if (!raw || PLACEHOLDERS.has(raw)) continue;
      const key = `${ref.aliasType}\0${raw}`;
      let id = cache.get(key);
      if (id === undefined) {
        id = await resolveKnownOrQueue(db as DimDb, ref.aliasType, raw, {
          file,
          template: args.template,
          rowNo: row.rowNo,
          field: ref.field,
        });
        cache.set(key, id);
      }
      if (id === null) {
        misses.push(`${ref.field}=${raw}`);
        let values = unresolvedValues.get(ref.aliasType);
        if (!values) unresolvedValues.set(ref.aliasType, (values = new Set()));
        values.add(raw);
      } else {
        resolved[`${ref.field}Id`] = id;
      }
    }

    const payload = row.payload && typeof row.payload === "object"
      ? { ...(row.payload as Record<string, unknown>), _resolved: resolved }
      : { value: row.payload, _resolved: resolved };
    const ok = misses.length === 0;
    if (ok) validated++;
    else pending++;
    rows.push({
      ...row,
      payload,
      status: ok ? "validated" : "pending",
      errorMsg: ok ? null : `未解析别名: ${misses.join("; ")}`,
    });
  }

  const unresolved: Partial<Record<AliasType, number>> = {};
  for (const [type, values] of unresolvedValues) unresolved[type] = values.size;
  return { rows, validated, pending, unresolved };
}
