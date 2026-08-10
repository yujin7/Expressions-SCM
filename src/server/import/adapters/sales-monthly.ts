/**
 * 适配器③：26年产品销量汇总 → sales_monthly（SKU×渠道×月长表化）。
 * 结构：各品牌页（EXP销量/NING销量/DEV销量/B2F销量/国内品牌销量；跳过 汇总/生产周期统计）
 * 多层表头：横幅行「{月}销量明细」× 表头行渠道（天猫|拼多多|京东|唯品会|抖音商品卡|商务|私域|
 * 品牌|海外|渠道，个别月含 抖音运营部/北美TK 变体——按名捕获，不硬编码白名单）。
 *
 * 年度事实核查（与任务基准的偏差，已验证）：年份横幅「20XX 年 销 量 数 据」只存在于
 * 「汇总」页（2023–2026 四段，品牌×月宽表，按清洁摄取原则不导入）；品牌明细页仅一套
 * 12 个月块，其「总计」行与汇总页 2026 年段逐月完全一致（如 EXP 1–6 月
 * 224688/198086/267196/252481/218913/180576）——即品牌页为 2026 年当年数据，
 * 而非 2023/24 历史。故年份推导：页内表头上方横幅有 20XX 年者优先，否则回退文件名
 * 「NN年」（本文件 → 2026）。2023–24 SKU 级历史在本工作簿中不存在。
 *
 * 公式壳：exceljs 无缓存结果的公式格到达时为 null 或 "[object Object]" 字符串——
 * 均非 number，按 0/跳过处理（只收非零数值格）。
 */
import { readWorkbook } from "../parse/xlsx";
import {
  cellToString,
  findCol,
  stagePipeline,
  type Adapter,
  type AdapterReject,
  type AdapterRow,
  type StageSummary,
} from "./types";
import type { AnyDb } from "../staging";

const TARGET_TABLE = "sales_monthly";
export const SALES_MONTHLY_TEMPLATE = "sales_monthly_summary";

const MONTH_BANNER_RE = /^(\d{1,2})\s*月销量明细$/;
const YEAR_RE = /(20\d{2})\s*年/;

function isBrandSheet(name: string): boolean {
  const n = name.trim();
  return n.includes("销量") && !n.includes("汇总") && !n.includes("生产周期");
}

export const salesMonthlyAdapter: Adapter = async (filePath) => {
  const wb = await readWorkbook(filePath);
  const fileName = filePath.split("/").pop() ?? filePath;

  const rows: AdapterRow[] = [];
  const rejects: AdapterReject[] = [];
  let sheetsParsed = 0;
  const skuSet = new Set<string>();

  for (const sheet of wb.sheets) {
    if (!isBrandSheet(sheet.name)) continue;
    const headerIdx = sheet.rows.findIndex((r) => r != null && findCol(r, "货品编号") >= 0);
    if (headerIdx < 0) {
      rejects.push({ rowNo: 0, sheet: sheet.name, reason: "未找到表头行（货品编号）", raw: null });
      continue;
    }
    const hdr = sheet.rows[headerIdx];
    const banner = headerIdx > 0 ? sheet.rows[headerIdx - 1] ?? [] : [];
    const cSku = findCol(hdr, "货品编号");

    // 年份：表头上方横幅「20XX年」优先，回退文件名「NN年」
    let year: number | null = null;
    for (let i = 0; i < headerIdx && year === null; i++) {
      for (const c of sheet.rows[i] ?? []) {
        const m = typeof c === "string" ? YEAR_RE.exec(c.replace(/\s+/g, "")) : null;
        if (m) {
          year = Number(m[1]);
          break;
        }
      }
    }
    if (year === null) {
      const fm = /^(\d{2,4})\s*年/.exec(fileName.trim());
      if (fm) year = fm[1].length === 2 ? 2000 + Number(fm[1]) : Number(fm[1]);
    }
    if (year === null) {
      rejects.push({ rowNo: headerIdx + 1, sheet: sheet.name, reason: "无法确定年份（横幅/文件名均无 NN年）", raw: null });
      continue;
    }

    // 月块×渠道列映射：横幅=「{月}销量明细」且表头为渠道名（排除 总销量 汇总列）
    const cols: { col: number; yearMonth: string; channelRaw: string }[] = [];
    const width = Math.max(hdr.length, banner.length);
    for (let c = 0; c < width; c++) {
      const b = banner[c];
      const h = hdr[c];
      const m = typeof b === "string" ? MONTH_BANNER_RE.exec(b.trim()) : null;
      if (!m || typeof h !== "string") continue;
      const channelRaw = h.trim();
      if (channelRaw === "" || channelRaw === "总销量") continue;
      const month = Number(m[1]);
      if (month < 1 || month > 12) continue;
      cols.push({ col: c, yearMonth: `${year}-${String(month).padStart(2, "0")}`, channelRaw });
    }
    if (cols.length === 0) {
      rejects.push({ rowNo: headerIdx + 1, sheet: sheet.name, reason: "未识别到任何月×渠道列", raw: null });
      continue;
    }
    sheetsParsed++;

    const brandSheet = sheet.name.trim();
    for (let i = headerIdx + 1; i < sheet.rows.length; i++) {
      const r = sheet.rows[i] ?? [];
      const skuCode = cellToString(r[cSku]);
      if (skuCode === null || skuCode === "总计") continue; // 空行/合计行静默跳过
      skuSet.add(skuCode);
      for (const { col, yearMonth, channelRaw } of cols) {
        const v = r[col];
        if (typeof v !== "number" || !Number.isFinite(v) || v === 0) continue; // 公式壳/空/零→跳过
        rows.push({
          rowNo: i + 1,
          targetTable: TARGET_TABLE,
          payload: { brandSheet, skuCode, yearMonth, channelRaw, qty: v },
        });
      }
    }
  }

  return {
    rows,
    rejects,
    stats: {
      sheetsParsed,
      dataRows: rows.length,
      rejected: rejects.length,
      distinctSkus: skuSet.size,
    },
  };
};

/** 全链路：别名解析 sku_code + channel */
/**
 * `sourceAsOf` 是**这份文件反映的业务时点**，不是代码写死的常量。
 *
 * 事故背景（2026-08-04）：这里原本硬编码 "2026-06-30"——那是最初一次性导入的那份文件的日期。
 * 但本函数同时被 `/api/import/upload`（业务自助上传）调用，于是**以后每次重传都会被
 * 盖上同一个过去的日期**：9 月传的库存会被记成 7 月的。后果不只是显示不准——
 * `month-close.ts` 正是按 sourceAsOf 做月份区间过滤，数据会进错月份的结账证据。
 *
 * 现在改为参数：一次性回填脚本显式传历史日期；上传路径不传，
 * 留 null 由 `month-close` 按既有约定回落 createdAt（真实上传时刻），
 * 宁可"没有声明源时点"，也不要"声明一个错的"。
 */
export async function stageSalesMonthly(db: AnyDb, filePath: string, userId: number, sourceAsOf: string | null = null): Promise<StageSummary> {
  return stagePipeline(db, {
    filePath,
    template: SALES_MONTHLY_TEMPLATE,
    userId,
    adapter: salesMonthlyAdapter,
    targetTable: TARGET_TABLE,
    job: {
      sourceAsOf,
      schemaVersion: "sales-monthly-v2",
      scope: { mode: "full", target: "sales_monthly", monthFrom: "2026-01", monthTo: "2026-06" },
    },
    aliasRefs: (row) => [
      { field: "sku", aliasType: "sku_code", value: row.payload.skuCode as string | null },
      { field: "channel", aliasType: "channel", value: row.payload.channelRaw as string | null },
    ],
  });
}
