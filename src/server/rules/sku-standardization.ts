export const COMMERCIAL_ROLES = [
  "unclassified",
  "retail",
  "sample",
  "gift",
  "tester",
  "internal",
] as const;

export type CommercialRole = (typeof COMMERCIAL_ROLES)[number];

const NON_SALES_ROLES = new Set<CommercialRole>(["sample", "gift", "tester", "internal"]);

/** 样品等仍属于库存真相，但不应制造正常销售的无动销/滞销告警。 */
export function participatesInNormalSalesMovement(
  role: CommercialRole | string | null | undefined,
): boolean {
  return !NON_SALES_ROLES.has((role ?? "unclassified") as CommercialRole);
}

export const COMMERCIAL_ROLE_LABELS: Record<CommercialRole, string> = {
  unclassified: "未分类",
  retail: "正常销售",
  sample: "样品",
  gift: "赠品",
  tester: "试用/测试装",
  internal: "内部使用",
};

export interface StandardNameInput {
  brand: string | null | undefined;
  channel: string | null | undefined;
  shortName: string | null | undefined;
  version: string | null | undefined;
  spec: string | null | undefined;
  /** 当前货品名称。用于识别「已按公司公布标准命名」的行，避免被建议名覆盖。 */
  name?: string | null | undefined;
}

export interface StandardNameAssessment {
  suggestion: string | null;
  missing: ("brand" | "shortName")[];
  ready: boolean;
  /** 现名已符合公司公布的 `(品牌)产品全称(规格)` 格式——不得改写。 */
  publishedFormat: boolean;
}

/**
 * 公司《系统-物料资料标准基础规则-可发布》的成品/小样名称格式：
 * `(品牌)产品全称(规格)`，可带版本类型后缀（JPN / KOR / TK-CHN / AMZ-KOR …）。
 *
 * 存在两套并行的命名口径：本文件的 `品牌 渠道 简称 版本 规格`（0727 会议结构）与上面这一套。
 * 在业务裁决用哪一套之前，**已经符合公布格式的名称不能被建议名静默覆盖**——
 * 那是不可逆的降级（实跑库 322 行命中公布格式）。
 */
const PUBLISHED_VERSION_SUFFIX = "(?:JPN|KOR|JPN-GT|KOR-GT|TK-CHN|TK-KOR|AMZ-CHN|AMZ-KOR|SGP-CHN|SGP-KOR)";
/** 实跑数据里成品名常带 ①②③ 之类的同名区分标记；带标记仍是公司格式，同样不得改写。 */
const PUBLISHED_VARIANT_MARK = "[\\u2460-\\u2473]";
const PUBLISHED_NAME_RE = new RegExp(
  `^\\(.+?\\).*\\([^()]+\\)\\s*(?:${PUBLISHED_VERSION_SUFFIX})?\\s*(?:${PUBLISHED_VARIANT_MARK})?$`,
);

export function matchesPublishedNameFormat(name: string | null | undefined): boolean {
  const value = (name ?? "").trim();
  return value.length > 0 && PUBLISHED_NAME_RE.test(value);
}

const clean = (value: string | null | undefined): string =>
  (value ?? "").replace(/\s+/g, " ").trim();

/**
 * 0727 会议标准：品牌 + 渠道 + 产品简称 + 版本 + 规格。
 * 品牌与简称是最小必填；渠道/版本/规格没有业务事实时跳过，绝不补猜。
 */
export function assessSkuStandardName(input: StandardNameInput): StandardNameAssessment {
  // 现名已符合公司公布格式：不给建议，也就不会出现「采用标准名」按钮。
  if (matchesPublishedNameFormat(input.name)) {
    return { suggestion: null, missing: [], ready: false, publishedFormat: true };
  }
  const brand = clean(input.brand);
  const shortName = clean(input.shortName);
  const missing: StandardNameAssessment["missing"] = [];
  if (!brand) missing.push("brand");
  if (!shortName) missing.push("shortName");
  if (missing.length) return { suggestion: null, missing, ready: false, publishedFormat: false };

  const parts = [brand, clean(input.channel), shortName, clean(input.version), clean(input.spec)]
    .filter(Boolean)
    .filter((part, index, all) => index === 0 || part.toLocaleLowerCase("zh-CN") !== all[index - 1].toLocaleLowerCase("zh-CN"));
  return { suggestion: parts.join(" "), missing: [], ready: true, publishedFormat: false };
}

export function unicodeLength(value: string): number {
  return Array.from(value).length;
}
