/**
 * 适配器⑮：SKU 单位成本批量导入（毛利视角基准）→ 直接 upsert sku_costs。
 *
 * 口径：sku_costs 为「手工录入基准」（成本自动口径 D2 未定），本适配器为毛利视角 func#15
 * 提供批量入口——单表逐行录入对 1000+ SKU 不可用。
 * 语义与既有单条 upsertSkuCost（report/margin.ts）一致：skuCode→skuId（先精确 skus.code，
 * 再走 sku_code 别名），onConflict 覆盖 unitCost，updatedBy=导入人。
 *
 * 放行语义：成本是简单主数据 upsert，无复杂放行分支——故在 stage 阶段内联直写
 * （不入 staging 待放行），全程包在 createImportJob/finalizeImportJob 内留审计痕。
 * 未解析编码=计数上报，不致命（非精确/无别名的行不写，仅 unresolved++）。
 */
import { eq } from "drizzle-orm";
import { readWorkbook, type CellValue, type SheetData } from "../parse/xlsx";
import { createImportJob, finalizeImportJob, type AnyDb } from "../staging";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { resolveAlias, type DimDb } from "@/server/modules/dimension/resolver";

export const SKU_COST_TEMPLATE = "sku_cost";

/** 编码列候选（优先级：商家编码 > SKU编码 > 编码） */
const CODE_KEYS = ["商家编码", "SKU编码", "编码"];

const str = (v: CellValue): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

/**
 * 解析单位成本：数字或字符串（去千分位）→ 正数，至多 4 位小数（numeric(14,4)）。
 * 非正/非法/空 → null（调用方计入 badValue）。四舍五入去浮点噪声后剥离尾零。
 */
export function parseCost(v: CellValue): string | null {
  if (v == null) return null;
  const raw = typeof v === "number" ? v : Number(String(v).trim().replace(/,/g, ""));
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const s = (Math.round(raw * 10000) / 10000).toFixed(4).replace(/\.?0+$/, "");
  return s === "" || s === "0" ? null : s;
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
  rows: { code: string; unitCost: string }[];
  /** 扫描的数据行数（有内容） */
  scanned: number;
  /** 无编码 或 成本非正/非法 */
  badValue: number;
}

/** 纯解析：找表头 → 逐行取 编码 + 单位成本；非法/空编码计 badValue。表头缺失抛错。 */
export function parseSkuCostSheet(sheet: SheetData): SkuCostParse {
  const h = findHeader(sheet);
  if (!h) throw new Error("表头未找到（需含 商家编码/SKU编码/编码 之一 且 含「成本」的列）");
  const out: { code: string; unitCost: string }[] = [];
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
      continue;
    }
    out.push({ code, unitCost });
  }
  return { rows: out, scanned, badValue };
}

/**
 * 全链路：createImportJob（幂等 supersede）→ 解析 → 逐行 skuId 解析 + upsert sku_costs
 * → finalizeImportJob → writeAudit（entity=sku_cost_import，任务级 1 行）。
 */
export async function stageSkuCost(db: AnyDb, filePath: string, userId: number) {
  const wb = await readWorkbook(filePath, { forceRaw: true });
  const parsed = parseSkuCostSheet(wb.sheets[0]);
  const job = await createImportJob(db, { template: SKU_COST_TEMPLATE, filePath, createdBy: userId });

  let upserted = 0;
  let unresolved = 0;
  const skuIdCache = new Map<string, number | null>();

  await db.transaction(async (tx: AnyDb) => {
    for (const { code, unitCost } of parsed.rows) {
      let skuId = skuIdCache.get(code);
      if (skuId === undefined) {
        const [sku]: { id: number }[] = await tx
          .select({ id: schema.skus.id })
          .from(schema.skus)
          .where(eq(schema.skus.code, code));
        skuId = sku ? sku.id : await resolveAlias(tx as DimDb, "sku_code", code);
        skuIdCache.set(code, skuId);
      }
      if (skuId == null) {
        unresolved++;
        continue;
      }
      await tx
        .insert(schema.skuCosts)
        .values({ skuId, unitCost, updatedBy: userId, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: schema.skuCosts.skuId,
          set: { unitCost, updatedBy: userId, updatedAt: new Date() },
        });
      upserted++;
    }
    await writeAudit(tx, {
      userId,
      entity: "sku_cost_import",
      action: "import",
      after: { jobId: job.id, rows: parsed.scanned, upserted, unresolved, badValue: parsed.badValue },
    });
  });

  await finalizeImportJob(db, job.id, { okRows: upserted, failRows: unresolved + parsed.badValue });
  return { jobId: job.id, stats: { rows: parsed.scanned, upserted, unresolved, badValue: parsed.badValue } };
}
