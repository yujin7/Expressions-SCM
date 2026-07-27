/**
 * 适配器⑮：SKU 单位成本批量导入（毛利视角基准）→ staging。
 *
 * 成本属于财务主数据：上传只解析和暂存，绝不在适配器里改 sku_costs。
 * 正式写入统一走 releaseSkuCosts（finance/admin 新鲜权限、dry-run、预检、事务审计）。
 */
import { readWorkbook, type CellValue, type SheetData } from "../parse/xlsx";
import { stagePipeline, type AdapterResult } from "./types";
import type { AnyDb } from "../staging";
import { dCmp, dQty } from "@/server/core/decimal";

export const SKU_COST_TEMPLATE = "sku_cost";

/** 编码列候选（优先级：商家编码 > SKU编码 > 编码） */
const CODE_KEYS = ["商家编码", "SKU编码", "编码"];

const str = (v: CellValue): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

/**
 * 解析单位成本：数字或字符串（去千分位）→ 正数，按 numeric(14,4) 半进位。
 * 统一走 decimal 工具，禁止用 Math/Number 做金额舍入。
 */
export function parseCost(v: CellValue): string | null {
  if (v == null) return null;
  const raw = typeof v === "number" ? String(v) : String(v).trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(raw)) return null;
  try {
    const fixed = dQty(raw);
    if (dCmp(fixed, "0") <= 0) return null;
    return fixed.replace(/\.?0+$/, "");
  } catch {
    return null;
  }
}

/** 定位表头：某行同时含（编码列之一）与（含「成本」的列）——返回行号与两列下标 */
function findHeader(sheet: SheetData): { hi: number; codeCol: number; costCol: number } | null {
  for (let i = 0; i < sheet.rows.length; i++) {
    const cells = (sheet.rows[i] ?? []).map((c) => (typeof c === "string" ? c.replace(/\s/g, "") : ""));
    const costCol = cells.findIndex((c) => c.includes("成本"));
    if (costCol < 0) continue;
    let codeCol = -1;
    for (const key of CODE_KEYS) {
      const idx = cells.findIndex((c) => c.includes(key));
      if (idx >= 0) {
        codeCol = idx;
        break;
      }
    }
    if (codeCol < 0) continue;
    return { hi: i, codeCol, costCol };
  }
  return null;
}

export interface SkuCostParse {
  rows: { rowNo: number; code: string; unitCost: string }[];
  rejects: { rowNo: number; reason: string; raw: unknown }[];
  /** 扫描的数据行数（有内容） */
  scanned: number;
  /** 无编码 或 成本非正/非法 */
  badValue: number;
}

/** 纯解析：找表头 → 逐行取 编码 + 单位成本；非法/空编码计 badValue。表头缺失抛错。 */
export function parseSkuCostSheet(sheet: SheetData): SkuCostParse {
  const h = findHeader(sheet);
  if (!h) throw new Error("表头未找到（需含 商家编码/SKU编码/编码 之一 且 含「成本」的列）");
  const out: { rowNo: number; code: string; unitCost: string }[] = [];
  const rejects: { rowNo: number; reason: string; raw: unknown }[] = [];
  let scanned = 0;
  let badValue = 0;
  for (let i = h.hi + 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i] ?? [];
    if (!r.some((c) => c != null && String(c).trim() !== "")) continue; // 整行空跳过（不计）
    scanned++;
    const code = str(r[h.codeCol]);
    const unitCost = parseCost(r[h.costCol]);
    if (!code || !unitCost) {
      badValue++;
      rejects.push({
        rowNo: i + 1,
        reason: !code ? "SKU 编码为空" : "单位成本须为正数且可按 4 位小数表示",
        raw: { code: r[h.codeCol] ?? null, unitCost: r[h.costCol] ?? null },
      });
      continue;
    }
    out.push({ rowNo: i + 1, code, unitCost });
  }
  return { rows: out, rejects, scanned, badValue };
}

/**
 * 全链路：createImportJob → 解析 → SKU 别名解析/排队 → staging → finalize。
 * 正式成本表保持零写入，直到财务在放行工作台预演并执行。
 */
export async function stageSkuCost(db: AnyDb, filePath: string, userId: number) {
  return stagePipeline(db, {
    filePath,
    template: SKU_COST_TEMPLATE,
    userId,
    targetTable: "sku_cost",
    adapter: async (path): Promise<AdapterResult> => {
      const wb = await readWorkbook(path, { forceRaw: true });
      const parsed = parseSkuCostSheet(wb.sheets[0]);
      return {
        rows: parsed.rows.map((row) => ({
          rowNo: row.rowNo,
          targetTable: "sku_cost",
          payload: { skuCode: row.code, unitCost: row.unitCost },
        })),
        rejects: parsed.rejects.map((reject) => ({
          rowNo: reject.rowNo,
          sheet: wb.sheets[0]?.name ?? "(unknown)",
          reason: reject.reason,
          raw: reject.raw,
        })),
        stats: {
          scanned: parsed.scanned,
          valid: parsed.rows.length,
          rejected: parsed.badValue,
        },
      };
    },
    aliasRefs: (row) => [
      {
        field: "sku",
        aliasType: "sku_code",
        value: typeof row.payload.skuCode === "string" ? row.payload.skuCode : null,
      },
    ],
    job: {
      schemaVersion: "sku-cost-v2",
      scope: { mode: "full", targetKinds: ["sku_cost"] },
    },
  });
}
