/**
 * BOM 块解析适配器（《04》§4.3/§4.5）：三品牌 BOM 工作簿（NING/EXPRESSIONS/DEVIANCE）。
 *
 * 结构：每 sheet 堆叠一个或多个成品块——可选标题行（含【…】/版本标记文字）→
 * 表头行（首个非空单元格=序号，列序 ~18 种变体，按"包含"匹配列名）→ N 条物料行 →
 * 汇总行（含 条形码/产品条码/产品单价/首批成本总计/汇总）。
 * 多块 = 规格变体（不同 SKU）或被替代旧版（同 SKU）——文字标记：旧版不使用 / 后面下单以这个为主。
 *
 * 硬规则：
 * - 加工费行（名称/编码含"加工费"）只进 feeLines，绝不混入物料行；
 * - 产品编码脏值（此规格不做了/工艺未确认/条形码数字/裸短数字/"/"）走显式拒收道（§4.5）；
 * - 同名多块且至少一块无版本标记 → ambiguous=true，100% 人工闸（§4.3），禁止启发式定 active。
 *
 * 注：DEVIANCE 走 exceljs 通道（合并单元格值在每格重复），NING/EXPRESSIONS 走 ooxml
 * 通道（合并单元格只有左上格有值）——块起点判定用"产品编码值变化"而非"产品编码非空"，
 * 两种通道下均正确。
 */
import { readWorkbook, type CellValue, type SheetData } from "@/server/import/parse/xlsx";
import type { SkuImportIdentityMode } from "@/server/import/sku-identity-mode";

/* ── 类型（本波次 bom 局部定义，允许与其他适配器重复） ───────────── */

export type BomVersionMarker = "retired" | "preferred" | "none";
export type BomUomGuess = "count" | "gram_ml" | "percent" | "unknown";
export type BomSegment =
  | "raw_bulk"
  | "primary_pack"
  | "secondary_pack"
  | "box"
  | "self_supplied"
  | "semi_finished"
  | "consumable"
  | "fee"
  | "uncoded"
  | "unknown";

export interface BomLine {
  materialCode: string | null;
  materialName: string;
  materialSpec: string;
  texture: string;
  qtyPer: number | null;
  /** 原文保真（百分比/分数/「100/箱」等原样保留） */
  qtyPerRaw: string;
  uomGuess: BomUomGuess;
  supplierRaw: string;
  segment: BomSegment;
}

export interface BomFeeLine {
  supplierRaw: string;
  note: string;
}

export interface BomBlock {
  sheet: string;
  brandCode: string;
  productCode: string | null;
  productName: string;
  productSpec: string;
  versionMarker: BomVersionMarker;
  /** 汇总行提取的 EAN 类条码（12–14 位数字），无则 null */
  barcode: string | null;
  /** §4.3 人工闸：同名多块且至少一块无标记 → true（涉事各块均置 true） */
  ambiguous: boolean;
  lines: BomLine[];
  feeLines: BomFeeLine[];
}

export interface BomReject {
  sheet: string;
  /** 1-based Excel 行号 */
  rowNo: number;
  reason: string;
  raw: string;
}

export interface BomStats {
  sheets: number;
  blocks: number;
  materialLines: number;
  feeLines: number;
  rejects: number;
  distinctProductCodes: number;
  ambiguousBlocks: number;
  channel: "exceljs" | "ooxml";
  parseMs: number;
}

export interface BomParseResult {
  blocks: BomBlock[];
  rejects: BomReject[];
  stats: BomStats;
}

/* ── 文本工具 ───────────────────────────────────── */

function cellStr(v: CellValue): string {
  if (v == null) return "";
  return String(v).trim();
}

/** 全角→半角 + 去所有空白（列名/编码比较用） */
function fold(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x3000) continue;
    else if (cp >= 0xff01 && cp <= 0xff5e) out += String.fromCodePoint(cp - 0xfee0);
    else out += ch;
  }
  return out.replace(/\s+/g, "");
}

const CJK_RE = /[一-鿿]/;

/**
 * 成品名归一（§4.3 同名判定 / §4.1 SPU 双证之一）：
 * 去品牌 token → 去括号段（中英文括号，含嵌套逐层剥）→ 去版本后缀词 → 折叠空白。
 */
export function normalizeBomProductName(raw: string): string {
  let s = fold(raw);
  s = s.replace(/NING\s*DERMOLOGIE/gi, "").replace(/EXPRESSIONS/gi, "").replace(/DEVIANCE/gi, "");
  s = s.replace(/爱碧生/g, "").replace(/\bNING\b/gi, "");
  // 括号段剥离（（）/()，最多迭代 5 层处理嵌套）
  for (let i = 0; i < 5 && /[（(].*?[)）]/.test(s); i++) {
    s = s.replace(/[（(][^（()）]*[)）]/g, "");
  }
  s = s.replace(/升级版|新版|旧版|新包装/g, "");
  return s.replace(/[\s()（）【】\-—_/]+/g, "").trim();
}

/* ── 表头列映射（按包含匹配，序无关） ───────────────── */

interface ColMap {
  productCode: number;
  productName: number;
  productSpec: number;
  materialCode: number;
  materialName: number;
  texture: number;
  materialSpec: number;
  qtyPer: number;
  supplier: number;
  note: number;
}

/**
 * 表头行判定：首个非空单元格为「序号」，或行内出现「原材料编码/原材料名称」列名
 * （NING 有 9+ 张 sheet 无序号列，表头以产品编码起头——实测变体）。
 */
function isHeaderRow(row: CellValue[]): boolean {
  let first = true;
  for (const c of row) {
    const s = cellStr(c);
    if (!s) continue;
    const f = fold(s);
    if (first) {
      if (f.startsWith("序号")) return true;
      first = false;
    }
    if (f.includes("原材料编码") || f.includes("原材料名称")) return true;
  }
  return false;
}

/**
 * 横幅标题行判定（exceljs 通道合并单元格值逐格重复——DEVIANCE 实测）：
 * ≥3 个非空单元格且值全部相同 → 视为标题横幅，不作物料行。
 */
function isBannerRow(row: CellValue[]): boolean {
  let firstVal: string | null = null;
  let n = 0;
  for (const c of row) {
    const s = cellStr(c);
    if (!s) continue;
    if (firstVal === null) firstVal = s;
    else if (s !== firstVal) return false;
    n++;
  }
  return n >= 3 && firstVal !== null && CJK_RE.test(firstVal);
}

function buildColMap(row: CellValue[]): ColMap {
  const m: ColMap = {
    productCode: -1, productName: -1, productSpec: -1, materialCode: -1,
    materialName: -1, texture: -1, materialSpec: -1, qtyPer: -1, supplier: -1, note: -1,
  };
  for (let i = 0; i < row.length; i++) {
    const h = fold(cellStr(row[i]));
    if (!h) continue;
    if (h.includes("产品编码")) m.productCode = i;
    else if (h.includes("产品名称")) m.productName = i;
    else if (h.includes("原材料编码") || h.includes("原料编码") || h.includes("材料编码")) m.materialCode = i;
    else if (h.includes("原材料名称") || h.includes("原料名称") || h.includes("材料名称")) m.materialName = i;
    else if (h.includes("材质") || h.includes("颜色")) m.texture = i;
    else if (h.includes("单位用量") || h.includes("用量")) m.qtyPer = i;
    else if (h.includes("供应商")) m.supplier = i;
    else if (h.includes("备注")) m.note = i;
    else if (h.includes("规格")) {
      // 首个位于产品名称之后、原材料区之前的规格 = 成品规格；原材料区内的规格 = 物料规格
      if (m.materialName === -1 && m.materialCode === -1 && m.productSpec === -1) m.productSpec = i;
      else if (m.materialSpec === -1) m.materialSpec = i;
    }
  }
  return m;
}

/**
 * 物料编码特征：四位分类码后缀、专用箱段，或公布标准里的独立前缀族。
 * 只用于「数据锚定」定位原材料编码列，宁可多认不可少认——少认会导致整段列映射平移错位。
 */
const MAT_CODE_RE = /^(?:ZC(?:LY|YL)|TYCL01-|TYFY01-|ZYTY0\d-|P01-|F01-|FY-)|-(?:0\d{3}|ZY\d*|X0\d{2})/i;

/**
 * 列映射数据校正（实测两类表头谎报列位：①产品批号/版本号列重复导致原材料区右移 2 列；
 * ②表头缺原材料编码列但数据含编码列）。以数据中物料编码特征列为锚，
 * 与表头声明不符时整体平移原材料区各列。
 */
function refineColMap(m: ColMap, dataRows: CellValue[][]): ColMap {
  const counts = new Map<number, number>();
  for (const row of dataRows) {
    if (isBannerRow(row) || isSummaryRow(row) || isHeaderRow(row)) continue;
    for (let j = Math.max(m.productName, 0) + 1; j < row.length; j++) {
      const s = fold(cellStr(row[j] ?? null));
      if (s && !CJK_RE.test(s) && MAT_CODE_RE.test(s)) counts.set(j, (counts.get(j) ?? 0) + 1);
    }
  }
  let best = -1;
  let bestN = 0;
  for (const [j, n] of counts) {
    if (n > bestN) {
      best = j;
      bestN = n;
    }
  }
  if (best < 0 || bestN < 2) return m;
  const headerN = counts.get(m.materialCode) ?? 0;
  if (m.materialCode === best || headerN * 2 >= bestN) return m;

  const out = { ...m };
  const shiftFrom = (from: number, delta: number): void => {
    for (const k of ["materialCode", "materialName", "texture", "materialSpec", "qtyPer", "supplier", "note"] as const) {
      if (out[k] >= from) out[k] += delta;
    }
  };
  if (m.materialCode >= 0) {
    shiftFrom(Math.min(m.materialCode, best), best - m.materialCode);
    out.materialCode = best;
  } else if (m.materialName === best) {
    shiftFrom(best, 1); // 表头缺编码列：编码占了名称列位，其后各列右移 1
    out.materialCode = best;
  } else {
    out.materialCode = best;
  }
  return out;
}

/* ── 行分类 ─────────────────────────────────────── */

const SUMMARY_KEYWORDS = ["条形码", "产品条码", "产品单价", "首批成本总计", "汇总"];

function isSummaryRow(row: CellValue[]): boolean {
  for (const c of row) {
    const s = cellStr(c);
    if (!s) continue;
    for (const kw of SUMMARY_KEYWORDS) if (s.includes(kw)) return true;
  }
  return false;
}

function rowText(row: CellValue[]): string {
  return row.map(cellStr).filter(Boolean).join("｜");
}

function extractBarcode(row: CellValue[]): string | null {
  for (const c of row) {
    // 允许尾注（「8886477213653（新商标条码）」）与前导引号：取独立 12–14 位数字串
    const m = /(?:^|[^\d])(\d{12,14})(?!\d)/.exec(cellStr(c));
    if (m) return m[1];
  }
  return null;
}

/* ── 产品编码脏值判定（§4.5 显式拒收道） ─────────────── */

const PRODUCT_CODE_RE = /^[A-Za-z]{1,6}\d/;

function classifyProductCode(raw: string): { code: string | null; reject: string | null } {
  const s = fold(raw);
  if (!s || s === "/") return { code: null, reject: s === "/" ? "无效编码「/」" : null };
  if (s.includes("不做")) return { code: null, reject: "此规格不做了" };
  if (s.includes("未确认")) return { code: null, reject: "工艺未确认" };
  if (/^\d+$/.test(s)) return { code: null, reject: s.length >= 8 ? "条形码误填为产品编码" : "裸短数字" };
  if (CJK_RE.test(s) || !PRODUCT_CODE_RE.test(s)) return { code: null, reject: `无效编码「${s.slice(0, 40)}」` };
  return { code: s, reject: null };
}

/* ── 物料编码 → 段位 ────────────────────────────── */

/**
 * 公司《系统-物料资料标准基础规则-可发布》的四位分类码字典。
 *
 * 此前只认 0101/0201/0401/0402/0801 五个分类码，其余（标贴 0301、中英文标签 0501/0502、
 * 膜布膜袋 0601-0603、封套 0403、进口内料 0102、热缩膜 0701…）一律落 unknown，
 * 并在放行时被 `物料段位无法判定` 硬阻断——实跑库里 270 行物料码命中这一路径。
 * 键 = 分类码，值 = 段位，注释 = 公布标准里的明细分类原文。
 */
const CATEGORY_SEGMENTS: Readonly<Record<string, BomSegment>> = {
  "0101": "raw_bulk", // 料体-普通内料
  "0102": "raw_bulk", // 料体-进口内料
  "0111": "semi_finished", // 半成品-裸支入仓产品
  "0201": "primary_pack", // 内包-瓶子及对应组件 / 软管及对应组件 / 勺子刮板（-1/-2/-3 顺延）
  "0301": "secondary_pack", // 外包-标贴：瓶身标 / 瓶盖标 / 泵头标
  "0302": "secondary_pack", // 外包-标贴：地址不干胶
  "0303": "secondary_pack", // 外包-标贴：外盒不干胶
  "0304": "secondary_pack", // 外包-标贴：其他标签 / 成分信息标 / 透明封口贴
  "0401": "secondary_pack", // 外包-外盒：彩盒
  "0402": "secondary_pack", // 外包-外盒：内托
  "0403": "secondary_pack", // 外包-外盒：封套
  "0501": "secondary_pack", // 外包-中文标签
  "0502": "secondary_pack", // 外包-英文标签
  "0601": "primary_pack", // 内包-膜布膜袋类：膜布
  "0602": "primary_pack", // 内包-膜布膜袋类：膜袋
  "0603": "primary_pack", // 内包-网纱衬/珠光膜 与 内包其他类（棉棒/棉布/pe袋/染发工具）
  "0701": "secondary_pack", // 其他材料-热缩膜
  "0801": "secondary_pack", // 外包-说明书
  "0901": "fee", // 生产费用-对应成品的费用：过膜费 / 加工费 / 返工费
};

/**
 * 不跟成品序号的独立前缀族（公布标准「通用材料 / 通用生产费用 / 包装物 / 消耗品 / 其他费用类」）。
 * 顺序敏感：ZYTY 必须排在 ZY 之前，否则会被专用箱规则吞掉。
 */
const PREFIX_SEGMENTS: ReadonlyArray<readonly [RegExp, BomSegment]> = [
  // 真实编码为 ZCLY（自供原料拼音序），ZCYL 为早期基线笔误——两式并认（2026-07-24 补遗轮实证）
  [/^ZC(?:LY|YL)/, "self_supplied"], // 料体-自采原料 ZCYL-序号
  [/^TYCL01-/, "primary_pack"], // 通用材料：海绵头 / 通用模具
  [/^TYFY01-/, "fee"], // 通用生产费用：通用贴标费 / 通用加工费
  [/^ZYTY0\d-/, "box"], // 包装物：通用专用箱 / 通用垫板 / 通用刀卡
  [/^P01-/, "box"], // 包装物-打包纸箱 与 消耗品-耗材（包裹卡/气泡袋/缠绕膜/托盘）
  [/^F01-/, "consumable"], // 消耗品-其他：香薰灯 / 天猫精灵 / 蜡烛
  [/^FY-/, "fee"], // 其他费用类：打样费 / 加工费 / 模具费 / 翻译费
];

/** 末位四位分类码（允许 0201-1 的顺延段与 0101a 的多料体字母后缀）。 */
const CATEGORY_RE = /-(\d{4})(?!\d)/g;

function segmentOf(code: string | null): BomSegment {
  if (code == null) return "uncoded";
  const c = code.toUpperCase();
  for (const [re, segment] of PREFIX_SEGMENTS) if (re.test(c)) return segment;
  // 专用箱 成品编码-ZY001/002/003；X001 为实测周转箱写法
  if (c.includes("-ZY") || c.includes("X001")) return "box";
  const matched = [...c.matchAll(CATEGORY_RE)];
  if (matched.length > 0) {
    const category = matched[matched.length - 1][1];
    const segment = CATEGORY_SEGMENTS[category];
    if (segment) return segment;
  }
  return "unknown";
}

/** 供测试与放行侧引用：已受支持的分类码，用于把「无法判定」的报错写成可操作的提示。 */
export const SUPPORTED_MATERIAL_CATEGORIES = Object.freeze(Object.keys(CATEGORY_SEGMENTS));

/**
 * 公布标准列出的费用名目。费用不是物料，不得建成 SKU；
 * 「加工费」保留原有字面判定（历史表格里大量出现在汇总行上，往往没有编码）。
 */
const FEE_NAME_RE = /(加工费|过膜费|返工费|贴标费|打样费|模具费|翻译费|报废费)/;

function isFeeLine(matName: string, matCode: string, cleanCode: string | null): boolean {
  if (FEE_NAME_RE.test(matName) || FEE_NAME_RE.test(matCode)) return true;
  return segmentOf(cleanCode) === "fee";
}

function cleanMaterialCode(raw: string): string | null {
  const s = fold(raw);
  if (!s || s === "/" || CJK_RE.test(s)) return null;
  return s;
}

/* ── 用量解析 ───────────────────────────────────── */

function parseQty(raw: CellValue): { qtyPer: number | null; qtyPerRaw: string; uomGuess: BomUomGuess } {
  if (typeof raw === "number") {
    return { qtyPer: raw, qtyPerRaw: String(raw), uomGuess: Number.isInteger(raw) ? "count" : "gram_ml" };
  }
  const s = cellStr(raw);
  if (!s || s === "/") return { qtyPer: null, qtyPerRaw: s, uomGuess: "unknown" };
  const pct = /^(\d+(?:\.\d+)?)\s*[%％]$/.exec(fold(s));
  if (pct) return { qtyPer: Number(pct[1]) / 100, qtyPerRaw: s, uomGuess: "percent" };
  const n = Number(fold(s));
  if (Number.isFinite(n)) {
    return { qtyPer: n, qtyPerRaw: s, uomGuess: Number.isInteger(n) ? "count" : "gram_ml" };
  }
  // 分数/「100/箱」/「（箱规/）」等：原文保留，数值置空——不入拒收道，uomGuess=unknown 已足够标记
  return { qtyPer: null, qtyPerRaw: s, uomGuess: "unknown" };
}

/* ── 块解析主体 ─────────────────────────────────── */

interface OpenBlock {
  block: BomBlock;
  productCodeRaw: string; // fold 后的编码原值（含脏值），块边界比较用
  startRowNo: number;
  markerText: string[];
}

export function parseBomSheets(sheets: SheetData[], brandCode: string): { blocks: BomBlock[]; rejects: BomReject[] } {
  const blocks: BomBlock[] = [];
  const rejects: BomReject[] = [];

  for (const sheet of sheets) {
    let colMap: ColMap | null = null;
    let open: OpenBlock | null = null;
    let pendingTitle: string[] = [];

    const at = (row: CellValue[], idx: number): CellValue => (idx >= 0 ? row[idx] ?? null : null);

    const closeBlock = (barcode: string | null): void => {
      if (!open) return;
      const text = open.markerText.join("｜");
      open.block.versionMarker = text.includes("旧版")
        ? "retired"
        : text.includes("以这个为主") || text.includes("以此为主")
          ? "preferred"
          : "none";
      if (barcode) open.block.barcode = barcode;
      blocks.push(open.block);
      open = null;
    };

    const startBlock = (row: CellValue[], rowIdx: number, m: ColMap): void => {
      const codeRaw = fold(cellStr(at(row, m.productCode)));
      const { code, reject } = classifyProductCode(codeRaw);
      if (reject) {
        rejects.push({ sheet: sheet.name, rowNo: rowIdx + 1, reason: reject, raw: codeRaw });
      }
      open = {
        block: {
          sheet: sheet.name,
          brandCode,
          productCode: code,
          productName: cellStr(at(row, m.productName)),
          productSpec: cellStr(at(row, m.productSpec)),
          versionMarker: "none",
          barcode: null,
          ambiguous: false,
          lines: [],
          feeLines: [],
        },
        productCodeRaw: codeRaw,
        startRowNo: rowIdx + 1,
        markerText: [...pendingTitle],
      };
      pendingTitle = [];
    };

    // 处理单行（表头行之外的所有行）；返回前 colMap 已就位
    const processRow = (row: CellValue[], r: number): void => {
      const m = colMap as ColMap;

      if (isBannerRow(row)) {
        const t = cellStr(row.find((c) => cellStr(c) !== "") ?? null);
        if (open) (open as OpenBlock).markerText.push(t);
        else pendingTitle.push(t);
        return;
      }

      const summary = isSummaryRow(row);
      const matCode = cellStr(at(row, m.materialCode));
      const matName = cellStr(at(row, m.materialName));
      const isMaterial = matCode !== "" || matName !== "";

      if (!isMaterial && !summary) {
        const t = rowText(row);
        if (!t) return;
        if (open) (open as OpenBlock).markerText.push(t);
        else pendingTitle.push(t);
        return;
      }

      if (isMaterial) {
        // 块边界：产品编码值变化（合并单元格逐行重复不触发；NING/EXP 只有块首行有编码）
        const codeCell = fold(cellStr(at(row, m.productCode)));
        if (open && codeCell && codeCell !== (open as OpenBlock).productCodeRaw && !summary) closeBlock(null);
        if (!open) startBlock(row, r, m);
        const ob = open as unknown as OpenBlock;

        ob.markerText.push(rowText(row));

        const supplierRaw = cellStr(at(row, m.supplier));
        const note = cellStr(at(row, m.note));

        // 费用行 → feeLines，绝不入物料行（实测常与汇总行同行——先收费再关块）。
        // 除字面「加工费」外，还认公布标准的三个费用编码族（成品序号-0901 / TYFY01 / FY）
        // 与其余费用名目：过膜费、返工费、贴标费等此前会掉进物料行并被段位判定拦下。
        const cleanCode = cleanMaterialCode(matCode);
        if (isFeeLine(matName, matCode, cleanCode)) {
          ob.block.feeLines.push({
            supplierRaw,
            note: [matName || matCode, note].filter(Boolean).join(" | "),
          });
        } else {
          const qty = parseQty(at(row, m.qtyPer));
          ob.block.lines.push({
            materialCode: cleanCode,
            materialName: matName || matCode,
            materialSpec: cellStr(at(row, m.materialSpec)),
            texture: cellStr(at(row, m.texture)),
            qtyPer: qty.qtyPer,
            qtyPerRaw: qty.qtyPerRaw,
            uomGuess: qty.uomGuess,
            supplierRaw,
            segment: segmentOf(cleanCode),
          });
        }
      }

      if (summary) {
        if (open) (open as OpenBlock).markerText.push(rowText(row));
        closeBlock(extractBarcode(row));
        pendingTitle = [];
      }
    };

    // 分段：以表头行切分；每段用「数据锚定」校正列映射后再逐行处理
    const headerIdxs: number[] = [];
    for (let r = 0; r < sheet.rows.length; r++) {
      if (isHeaderRow(sheet.rows[r] ?? [])) headerIdxs.push(r);
    }
    // 首个表头前的标题行归属第一个块
    const preEnd = headerIdxs.length > 0 ? headerIdxs[0] : 0;
    for (let r = 0; r < preEnd; r++) {
      const row = sheet.rows[r] ?? [];
      const t = isBannerRow(row) ? cellStr(row.find((c) => cellStr(c) !== "") ?? null) : rowText(row);
      if (t) pendingTitle.push(t);
    }
    for (let h = 0; h < headerIdxs.length; h++) {
      const start = headerIdxs[h] + 1;
      const end = h + 1 < headerIdxs.length ? headerIdxs[h + 1] : sheet.rows.length;
      closeBlock(null); // 新表头 = 新块区段
      colMap = refineColMap(buildColMap(sheet.rows[headerIdxs[h]] ?? []), sheet.rows.slice(start, end));
      for (let r = start; r < end; r++) processRow(sheet.rows[r] ?? [], r);
    }
    closeBlock(null);
  }

  markAmbiguity(blocks);
  return { blocks, rejects };
}

/** §4.3 人工闸：同一归一化成品名 >1 块，且至少一块无版本标记 → 涉事各块 ambiguous=true */
function markAmbiguity(blocks: BomBlock[]): void {
  const byName = new Map<string, BomBlock[]>();
  for (const b of blocks) {
    const key = normalizeBomProductName(b.productName);
    if (!key) continue;
    const arr = byName.get(key);
    if (arr) arr.push(b);
    else byName.set(key, [b]);
  }
  for (const group of byName.values()) {
    if (group.length > 1 && group.some((b) => b.versionMarker === "none")) {
      for (const b of group) b.ambiguous = true;
    }
  }
}

export async function parseBomWorkbook(filePath: string, brandCode: string): Promise<BomParseResult> {
  const t0 = Date.now();
  const wb = await readWorkbook(filePath);
  const { blocks, rejects } = parseBomSheets(wb.sheets, brandCode);
  const distinct = new Set<string>();
  let materialLines = 0;
  let feeLines = 0;
  let ambiguousBlocks = 0;
  for (const b of blocks) {
    if (b.productCode) distinct.add(b.productCode);
    materialLines += b.lines.length;
    feeLines += b.feeLines.length;
    if (b.ambiguous) ambiguousBlocks++;
  }
  return {
    blocks,
    rejects,
    stats: {
      sheets: wb.sheets.length,
      blocks: blocks.length,
      materialLines,
      feeLines,
      rejects: rejects.length,
      distinctProductCodes: distinct.size,
      ambiguousBlocks,
      channel: wb.channel,
      parseMs: Date.now() - t0,
    },
  };
}

/* ── staging 入库（适配器→staging，绝不直写正式表） ────── */

import {
  createImportJob,
  failImportJob,
  finalizeImportJob,
  writeStagingRows,
  type StagingRowInput,
} from "@/server/import/staging";
import { resolveOrQueue, type DimDb } from "@/server/modules/dimension/resolver";
import { suggestSpus } from "./bom-spu";

function isMeaningfulSupplier(s: string): boolean {
  return s !== "" && s !== "/" && !/^[/\\.\-—]+$/.test(s);
}

export async function stageBom(
  db: DimDb,
  filePath: string,
  brandCode: string,
  userId: number,
  identityMode: SkuImportIdentityMode = "historical_preserve",
): Promise<{ jobId: number; result: BomParseResult; stagedRows: number }> {
  const job = await createImportJob(db, {
    template: "bom",
    filePath,
    createdBy: userId,
    // 身份模式由上传人显式声明；默认仅为脚本/历史调用兼容，生产上传 API 不允许省略。
    scope: { mode: "full", brandCode, identityMode },
  });
  try {
    const result = await parseBomWorkbook(filePath, brandCode);
    if (result.blocks.length === 0) throw new Error("BOM 文件未解析到任何产品块");

    await resolveOrQueue(db, "brand", brandCode, { source: "bom", filePath });

  // 供应商 OEM 别名：去重后逐值 resolveOrQueue（异常队列 UNIQUE 幂等）
  const suppliers = new Set<string>();
  for (const b of result.blocks) {
    for (const l of b.lines) if (isMeaningfulSupplier(l.supplierRaw)) suppliers.add(l.supplierRaw);
    for (const f of b.feeLines) if (isMeaningfulSupplier(f.supplierRaw)) suppliers.add(f.supplierRaw);
  }
  for (const s of suppliers) {
    await resolveOrQueue(db, "supplier_oem", s, { source: "bom", brandCode });
  }

  const rows: StagingRowInput[] = [];
  let rowNo = 0;

  for (const b of result.blocks) {
    rows.push({ rowNo: ++rowNo, targetTable: "bom_block", payload: b });
  }

  // 加工费候选：按 (productCode, supplierRaw) 聚合去重
  const feeKeys = new Map<string, { productCode: string | null; supplierRaw: string }>();
  for (const b of result.blocks) {
    for (const f of b.feeLines) {
      const key = `${b.productCode ?? ""}\0${f.supplierRaw}`;
      if (!feeKeys.has(key)) feeKeys.set(key, { productCode: b.productCode, supplierRaw: f.supplierRaw });
    }
  }
  for (const fee of feeKeys.values()) {
    rows.push({ rowNo: ++rowNo, targetTable: "processing_fee_candidate", payload: fee });
  }

  for (const cluster of suggestSpus(result.blocks)) {
    rows.push({ rowNo: ++rowNo, targetTable: "spu_suggestion", payload: cluster });
  }

  for (const rej of result.rejects) {
    rows.push({
      rowNo: ++rowNo,
      targetTable: "bom_block",
      payload: rej,
      status: "error",
      errorMsg: rej.reason,
    });
  }

    await writeStagingRows(db, job.id, rows);
    await finalizeImportJob(db, job.id, {
      okRows: rows.length - result.rejects.length,
      failRows: result.rejects.length,
      controlRows: rows.length,
    });
    return { jobId: job.id, result, stagedRows: rows.length };
  } catch (error) {
    await failImportJob(db, job.id, "bom_block", error);
    throw error;
  }
}
