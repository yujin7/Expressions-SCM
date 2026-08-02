/**
 * DW2 导入适配器公共契约（《04》§4 管道：适配器→staging→校验→复核→审批入库）。
 *
 * 分层：
 * - Adapter = 纯解析+归一（读文件→AdapterResult），不触库、不打印（噪音走 stats/rejects）；
 * - stagePipeline = 组合器：createImportJob → adapter → resolveKnownOrQueue
 *   （别名优先，再匹配主档自然键与受治理外部标识）
 *   （全部命中→validated；任一未命中→pending，errorMsg 记录未解析字段）→
 *   writeStagingRows（拒收行以 status=error 入 staging 留痕）→ finalizeImportJob。
 */
import {
  createImportJob,
  failImportJob,
  finalizeImportJob,
  writeStagingRows,
  type AnyDb,
  type StagingRowInput,
} from "../staging";
import {
  resolveKnownOrQueue,
  type AliasResolutionOptions,
  type DimDb,
} from "@/server/modules/dimension/resolver";
import type { AliasType } from "@/db/schema";
import type { CellValue } from "../parse/xlsx";

export interface AdapterRow {
  rowNo: number;
  targetTable: string;
  payload: Record<string, unknown>;
}

export interface AdapterReject {
  rowNo: number;
  sheet: string;
  reason: string;
  raw: unknown;
}

export interface AdapterResult {
  rows: AdapterRow[];
  rejects: AdapterReject[];
  stats: Record<string, number>;
}

export type Adapter = (filePath: string) => Promise<AdapterResult>;

/* ── 共享纯工具 ─────────────────────────────────── */

/** 整行皆空（undefined/null）？ */
export function isBlankRow(row: CellValue[] | undefined): boolean {
  return !row || row.every((c) => c == null);
}

/** 单元格→非空字符串；空白/空值→null（数字也转字符串，如条码/编码列） */
export function cellToString(v: CellValue): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * 容错数值：number 直通（NaN/Infinity→null）；数字串→Number；
 * 业务脏值（待确认 / "/" / "-" / "—" / 空）→ null；其余非数字串→null。
 */
export function toNumberTolerant(v: CellValue): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "" || s === "待确认" || s === "/" || s === "-" || s === "—") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 表头行内按名取列（trim 后精确匹配；找不到 -1） */
export function findCol(header: CellValue[], name: string): number {
  return header.findIndex((c) => typeof c === "string" && c.trim() === name);
}

/* ── stage 组合器 ───────────────────────────────── */

/** 行内别名引用：field 为语义名（warehouse/sku/channel/oem），用于 errorMsg 与 _resolved 键 */
export interface AliasRef {
  field: string;
  aliasType: AliasType;
  value: string | null | undefined;
}

export interface StageSummary {
  jobId: number;
  /** 入 staging 的业务行数（validated + pending，不含拒收） */
  staged: number;
  validated: number;
  pending: number;
  rejected: number;
  /** 未解析别名的去重原值数（按类型） */
  unresolved: Partial<Record<AliasType, number>>;
  stats: Record<string, number>;
}

export async function stagePipeline(
  db: AnyDb,
  args: {
    filePath: string;
    template: string;
    userId: number;
    adapter: Adapter;
    /** 拒收行落 staging 时使用的 targetTable */
    targetTable: string;
    aliasRefs: (row: AdapterRow) => AliasRef[];
    /** External-system imports must select their identity scope explicitly. */
    aliasResolution?: AliasResolutionOptions;
    /** 文件级血缘（业务截止日/解析契约/全量或增量范围） */
    job?: {
      sourceAsOf?: string | null;
      schemaVersion?: string;
      scope?: Record<string, unknown> | null;
    };
  },
): Promise<StageSummary> {
  const job = await createImportJob(db, {
    template: args.template,
    filePath: args.filePath,
    createdBy: args.userId,
    sourceAsOf: args.job?.sourceAsOf,
    schemaVersion: args.job?.schemaVersion,
    scope: args.job?.scope,
  });
  try {
    const result = await args.adapter(args.filePath);
    if (result.rows.length === 0) {
      const reason = result.rejects.length > 0
        ? `模板未产生可导入行（${result.rejects.length} 条解析拒收）`
        : "模板未产生任何业务行";
      const rejectedOnly: StagingRowInput[] = result.rejects.map((rej) => ({
        rowNo: rej.rowNo,
        targetTable: args.targetTable,
        payload: { sheet: rej.sheet, raw: rej.raw },
        status: "error",
        errorMsg: rej.reason,
      }));
      if (rejectedOnly.length > 0) await writeStagingRows(db, job.id, rejectedOnly);
      throw new Error(reason);
    }
    const file = args.filePath.split("/").pop() ?? args.filePath;

    const cache = new Map<string, number | null>(); // 同值只查/排队一次（会话内）
    const unresolvedValues = new Map<AliasType, Set<string>>();
    const staging: StagingRowInput[] = [];
    let validated = 0;
    let pending = 0;

    for (const row of result.rows) {
      const misses: string[] = [];
      const resolved: Record<string, number> = {};
      for (const ref of args.aliasRefs(row)) {
        if (ref.value == null || String(ref.value).trim() === "") continue;
        const raw = String(ref.value);
        const key = `${ref.aliasType}\0${raw}`;
        let id: number | null;
        if (cache.has(key)) {
          id = cache.get(key)!;
        } else {
          id = await resolveKnownOrQueue(db as DimDb, ref.aliasType, raw, {
            file,
            template: args.template,
            rowNo: row.rowNo,
            field: ref.field,
          }, args.aliasResolution);
          cache.set(key, id);
        }
        if (id === null) {
          misses.push(`${ref.field}=${raw}`);
          let set = unresolvedValues.get(ref.aliasType);
          if (!set) unresolvedValues.set(ref.aliasType, (set = new Set()));
          set.add(raw);
        } else {
          resolved[`${ref.field}Id`] = id;
        }
      }
      const ok = misses.length === 0;
      if (ok) validated++;
      else pending++;
      staging.push({
        rowNo: row.rowNo,
        targetTable: row.targetTable,
        payload: { ...row.payload, _resolved: resolved },
        status: ok ? "validated" : "pending",
        errorMsg: ok ? null : `未解析别名: ${misses.join("; ")}`,
      });
    }

    for (const rej of result.rejects) {
      staging.push({
        rowNo: rej.rowNo,
        targetTable: args.targetTable,
        payload: { sheet: rej.sheet, raw: rej.raw },
        status: "error",
        errorMsg: rej.reason,
      });
    }

    await writeStagingRows(db, job.id, staging);
    await finalizeImportJob(db, job.id, {
      okRows: result.rows.length,
      failRows: result.rejects.length,
      controlRows: result.rows.length + result.rejects.length,
    });

    const unresolved: Partial<Record<AliasType, number>> = {};
    for (const [t, set] of unresolvedValues) unresolved[t] = set.size;

    return {
      jobId: job.id,
      staged: result.rows.length,
      validated,
      pending,
      rejected: result.rejects.length,
      unresolved,
      stats: result.stats,
    };
  } catch (error) {
    await failImportJob(db, job.id, args.targetTable, error);
    throw error;
  }
}
