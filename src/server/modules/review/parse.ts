/**
 * 复核清单 md 解析器（FEATURE 复核工作台）：
 * reports/复核清单-YYYY-MM-DD.md 的自动代决记录 → review_items 行。
 * 纯函数，seed 脚本与单测共用；不触库。
 */

export interface ParsedReviewItem {
  category: string; // spu_cluster/bom_version/segment/shell_brand/blocked_sku/activation_sample/uncoded/other
  refType: string | null; // spu/bom/sku
  refKey: string | null; // 可跳转的编码
  title: string;
  detail: string | null;
}

/** 业务编码：N006-001 / DEV005-000-0301 / N02-032-a / TYCL01-022 / N052-0602(1) 等 */
const CODE_RE = /[A-Z]{1,6}\d{1,5}(?:-[A-Za-z0-9()]+)*/;

/** 前缀 → 类别 + 引用类型（按声明顺序匹配） */
const RULES: { test: (s: string) => boolean; category: string; refType: string | null }[] = [
  { test: (s) => s.startsWith("SPU 簇代决"), category: "spu_cluster", refType: "spu" },
  { test: (s) => s.startsWith("BOM 歧义代决"), category: "bom_version", refType: "bom" },
  { test: (s) => s.startsWith("物料代决分类"), category: "segment", refType: "sku" },
  { test: (s) => s.includes("壳档") || s.startsWith("壳 SKU"), category: "shell_brand", refType: "sku" },
  { test: (s) => s.startsWith("SKU 放行受阻"), category: "blocked_sku", refType: "sku" },
  { test: (s) => s.startsWith("BOM 放行受阻"), category: "blocked_sku", refType: "bom" },
  { test: (s) => s.startsWith("BOM 生效抽检"), category: "activation_sample", refType: "bom" },
  { test: (s) => s.startsWith("无编码物料"), category: "uncoded", refType: null },
];

/**
 * 标题/详情拆分：`前缀：CODE（详情）——尾注` → title=前缀：CODE，detail=详情——尾注。
 * 不匹配该结构（如壳档品牌行、物料代决半角括号行）则整行为 title。
 */
function splitTitleDetail(text: string): { title: string; detail: string | null } {
  const m = /^([^（]+)（(.+)）(——[^（）]*)?$/.exec(text);
  if (m) {
    const tail = m[3] ? m[3].trim() : "";
    return { title: m[1].trim(), detail: `${m[2]}${tail ? tail : ""}`.trim() || null };
  }
  return { title: text, detail: null };
}

/** 解析单行；非条目行（标题/空行/正文）返回 null */
export function parseReviewLine(raw: string): ParsedReviewItem | null {
  const line = raw.trim();
  if (!line.startsWith("- ")) return null;
  const text = line.slice(2).trim();
  if (!text) return null;

  const rule = RULES.find((r) => r.test(text));
  const category = rule?.category ?? "other";
  let refType = rule?.refType ?? null;
  let refKey: string | null = null;

  if (refType) {
    // 编码取「：」之后首个业务码（含斜杠并列时取第一个）
    const idx = text.indexOf("：");
    const scope = idx >= 0 ? text.slice(idx + 1) : text;
    const m = CODE_RE.exec(scope);
    refKey = m ? m[0] : null;
    if (!refKey) refType = null; // 无可解析编码则不留悬空 refType
  }

  const { title, detail } = splitTitleDetail(text);
  return { category, refType, refKey, title: title.slice(0, 300), detail };
}

/** 全文解析 + 按 title 去重（补遗轮存在与主轮重复的行） */
export function parseReviewMarkdown(md: string): ParsedReviewItem[] {
  const out: ParsedReviewItem[] = [];
  const seen = new Set<string>();
  for (const raw of md.split(/\r?\n/)) {
    const item = parseReviewLine(raw);
    if (!item || seen.has(item.title)) continue;
    seen.add(item.title);
    out.push(item);
  }
  return out;
}
