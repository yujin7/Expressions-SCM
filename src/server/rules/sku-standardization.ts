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
}

export interface StandardNameAssessment {
  suggestion: string | null;
  missing: ("brand" | "shortName")[];
  ready: boolean;
}

const clean = (value: string | null | undefined): string =>
  (value ?? "").replace(/\s+/g, " ").trim();

/**
 * 0727 会议标准：品牌 + 渠道 + 产品简称 + 版本 + 规格。
 * 品牌与简称是最小必填；渠道/版本/规格没有业务事实时跳过，绝不补猜。
 */
export function assessSkuStandardName(input: StandardNameInput): StandardNameAssessment {
  const brand = clean(input.brand);
  const shortName = clean(input.shortName);
  const missing: StandardNameAssessment["missing"] = [];
  if (!brand) missing.push("brand");
  if (!shortName) missing.push("shortName");
  if (missing.length) return { suggestion: null, missing, ready: false };

  const parts = [brand, clean(input.channel), shortName, clean(input.version), clean(input.spec)]
    .filter(Boolean)
    .filter((part, index, all) => index === 0 || part.toLocaleLowerCase("zh-CN") !== all[index - 1].toLocaleLowerCase("zh-CN"));
  return { suggestion: parts.join(" "), missing: [], ready: true };
}

export function unicodeLength(value: string): number {
  return Array.from(value).length;
}
