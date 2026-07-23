import { SENSITIVE_FIELDS } from "@/server/core/constants";
import { canSeePrices } from "@/server/core/dto";

/**
 * CSV 导出基础设施（W5）。
 * - UTF-8 带 BOM（Excel 直开不乱码）、CRLF 行结束、RFC4180 引号转义；
 * - decimal 字符串原样输出（禁 float 重格式化——CLAUDE.md）；
 * - 行数上限 EXPORT_ROW_CAP：命中后追加截断提示行（路由另设 X-Truncated 头）；
 * - 脱敏（R9 含导出）：canSeePrices=false 的用户，金额列**整列剔除**（非置空）。
 */

export const EXPORT_ROW_CAP = 50000;
export const TRUNCATION_ROW_TEXT = "……已达导出上限 50000 行，请缩小筛选范围";

export interface CsvColumn {
  key: string;
  title: string;
}

const SENSITIVE_SET: ReadonlySet<string> = new Set<string>(SENSITIVE_FIELDS);

/** maskSensitive 的列级等价物：非价格可见角色 → 剔除黑名单键对应的整列 */
export function stripMoneyColumns(columns: CsvColumn[], roles: string[]): CsvColumn[] {
  if (canSeePrices(roles)) return columns;
  return columns.filter((c) => !SENSITIVE_SET.has(c.key));
}

function csvCell(v: unknown): string {
  if (v == null) return "";
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else s = String(v);
  // 含分隔符/引号/换行 → 引号包裹，内部引号加倍（RFC4180）
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** rows → CSV 文本：BOM + 标题行 + 数据行，CRLF；decimal 字符串逐字输出 */
export function toCsv(rows: Record<string, unknown>[], columns: CsvColumn[]): string {
  const header = columns.map((c) => csvCell(c.title)).join(",");
  const body = rows.map((r) => columns.map((c) => csvCell(r[c.key])).join(","));
  return "\uFEFF" + [header, ...body].join("\r\n") + "\r\n";
}

/** 截断时在末尾追加提示行（占第一列） */
export function buildCsv(
  rows: Record<string, unknown>[],
  columns: CsvColumn[],
  opts?: { truncated?: boolean },
): string {
  const all = opts?.truncated && columns.length > 0
    ? [...rows, { [columns[0].key]: TRUNCATION_ROW_TEXT }]
    : rows;
  return toCsv(all, columns);
}

/** Content-Disposition：RFC5987 中文文件名 */
export function csvDisposition(nameCn: string): string {
  return `attachment; filename="export.csv"; filename*=UTF-8''${encodeURIComponent(nameCn)}.csv`;
}

const SH_TZ_FMT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});

/** 业务时间列：Asia/Shanghai "YYYY-MM-DD HH:mm:ss"（sv-SE locale 恰为该格式） */
export function fmtShanghai(v: Date | string | null | undefined): string {
  if (v == null) return "";
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return SH_TZ_FMT.format(d);
}
