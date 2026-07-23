/**
 * 双通道 xlsx 读取器（《04》§4.5：事实核查裁决）。
 * 通道1 exceljs；失败（真实数据中 NING/EXPRESSIONS BOM 与在途表的畸形 richText/sharedStrings
 * 会使其崩溃）→ 通道2 原生 OOXML（fflate 解 zip + 手工解析 sharedStrings/sheet XML）。
 * 输出统一为「值矩阵」：公式取缓存结果；日期序列数不在此层转换（用 excelSerialToISO 按列语义转）。
 */
import { readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";

export type CellValue = string | number | null;

export interface SheetData {
  name: string;
  /** 1-based 行导出为数组下标 0-based；空单元格=null；宽度=该行最右非空列 */
  rows: CellValue[][];
  hidden: boolean;
}

export interface WorkbookData {
  sheets: SheetData[];
  channel: "exceljs" | "ooxml";
}

export async function readWorkbook(filePath: string): Promise<WorkbookData> {
  try {
    return { sheets: await readViaExceljs(filePath), channel: "exceljs" };
  } catch {
    return { sheets: readViaOoxml(filePath), channel: "ooxml" };
  }
}

async function readViaExceljs(filePath: string): Promise<SheetData[]> {
  const mod = (await import("exceljs")) as { Workbook?: unknown; default?: { Workbook: unknown } };
  const ExcelJS = (mod.Workbook ? mod : mod.default) as typeof import("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const sheets: SheetData[] = [];
  for (const ws of wb.worksheets) {
    const rows: CellValue[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, rowNo) => {
      const vals: CellValue[] = [];
      row.eachCell({ includeEmpty: true }, (cell, colNo) => {
        vals[colNo - 1] = normalizeExceljsValue(cell.value);
      });
      rows[rowNo - 1] = vals;
    });
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    sheets.push({ name: ws.name, rows, hidden: ws.state !== "visible" });
  }
  return sheets;
}

function normalizeExceljsValue(v: unknown): CellValue {
  if (v == null) return null;
  if (typeof v === "number" || typeof v === "string") return v === "" ? null : v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return normalizeExceljsValue(o.result); // 公式：取缓存结果
    if ("richText" in o && Array.isArray(o.richText)) {
      return (o.richText as { text?: string }[]).map((t) => t.text ?? "").join("") || null;
    }
    if ("text" in o && typeof o.text === "string") return o.text || null; // 超链接
    if ("error" in o) return null;
  }
  return String(v);
}

/* ── 通道2：原生 OOXML ───────────────────────────── */

function readViaOoxml(filePath: string): SheetData[] {
  const zip = unzipSync(readFileSync(filePath));
  const get = (p: string): string | null => (zip[p] ? strFromU8(zip[p]) : null);

  // sharedStrings：<si> 内取全部 <t> 拼接（覆盖 richText 分段）
  const shared: string[] = [];
  const ss = get("xl/sharedStrings.xml");
  if (ss) {
    for (const si of ss.matchAll(/<si[\s>][\s\S]*?<\/si>|<si\/>/g)) {
      const ts = [...si[0].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]));
      shared.push(ts.join(""));
    }
  }

  // workbook.xml + rels：sheet 名/顺序/隐藏 → 物理文件
  const wbXml = get("xl/workbook.xml") ?? "";
  const relsXml = get("xl/_rels/workbook.xml.rels") ?? "";
  const relMap = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    relMap.set(m[1], m[2].replace(/^\//, "").replace(/^(?!xl\/)/, "xl/"));
  }
  const sheets: SheetData[] = [];
  for (const m of wbXml.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const attrs = m[1];
    const nameM = /name="([^"]+)"/.exec(attrs);
    const ridM = /r:id="([^"]+)"/.exec(attrs);
    if (!nameM || !ridM) continue;
    const name = decodeXml(nameM[1]);
    const hidden = /state="(hidden|veryHidden)"/.test(attrs);
    const target = relMap.get(ridM[1]);
    const xml = target ? get(target) : null;
    if (!xml) continue;
    sheets.push({ name, rows: parseSheetXml(xml, shared), hidden });
  }
  return sheets;
}

function parseSheetXml(xml: string, shared: string[]): CellValue[][] {
  const rows: CellValue[][] = [];
  for (const rowM of xml.matchAll(/<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const rowIdx = Number(rowM[1]) - 1;
    const vals: CellValue[] = [];
    for (const cellM of rowM[2].matchAll(/<c\s([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellM[1];
      const inner = cellM[2] ?? "";
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
      if (!ref) continue;
      const col = colToIndex(ref);
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      let value: CellValue = null;
      if (type === "s") {
        const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "-1");
        value = shared[idx] ?? null;
      } else if (type === "inlineStr") {
        const ts = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]));
        value = ts.join("") || null;
      } else if (type === "str") {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "") || null;
      } else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        value = raw == null || raw === "" ? null : Number(raw);
        if (typeof value === "number" && Number.isNaN(value)) value = null;
      }
      if (value === "") value = null;
      vals[col] = value;
    }
    rows[rowIdx] = vals;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

function colToIndex(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

/** Excel 日期序列数 → ISO 日期（1900 体系，含闰年 bug 补偿）；非法输入返回 null */
export function excelSerialToISO(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 200000) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** 单元格日期归一（《04》：四种编码并存，须逐格判断）：序列数/ISO串/JSDate串/YYYY-MM-DD → YYYY-MM-DD or null */
export function normalizeDateCell(v: CellValue): string | null {
  if (v == null) return null;
  if (typeof v === "number") return excelSerialToISO(v);
  const s = String(v).trim();
  if (!s || s === "-") return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const cn = /^(\d{4})[/.年](\d{1,2})[/.月](\d{1,2})/.exec(s);
  if (cn) return `${cn[1]}-${cn[2].padStart(2, "0")}-${cn[3].padStart(2, "0")}`;
  const js = new Date(s);
  if (!Number.isNaN(js.getTime()) && js.getFullYear() > 1990) return js.toISOString().slice(0, 10);
  return null;
}
