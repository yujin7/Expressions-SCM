import { z } from "zod";

export const SKU_IDENTIFIER_KINDS = ["gtin", "external", "vendor", "customer", "legacy"] as const;
export const SKU_PACKAGING_LEVELS = ["each", "inner", "case", "pallet", "other"] as const;

export type SkuIdentifierKind = (typeof SKU_IDENTIFIER_KINDS)[number];
export type SkuPackagingLevel = (typeof SKU_PACKAGING_LEVELS)[number];

export const SKU_EXTERNAL_SCOPES = ["JST", "JIANDAOYUN", "YONYOU"] as const;

const EXTERNAL_SCOPE_ALIASES: Record<string, (typeof SKU_EXTERNAL_SCOPES)[number]> = {
  JST: "JST",
  JUSHUITAN: "JST",
  "聚水潭": "JST",
  JDY: "JIANDAOYUN",
  JIANDAOYUN: "JIANDAOYUN",
  "简道云": "JIANDAOYUN",
  YY: "YONYOU",
  YONYOU: "YONYOU",
  YONSUITE: "YONYOU",
  YONBIP: "YONYOU",
  "用友": "YONYOU",
};

/** Canonicalize known system aliases while preserving explicit scopes for future systems. */
export function normalizeSkuIdentifierScope(
  kind: SkuIdentifierKind,
  raw: string | null | undefined,
): string {
  if (kind === "gtin") return "GS1";
  const normalized = (raw ?? "INTERNAL").normalize("NFKC").trim().toUpperCase();
  if (kind === "external") return EXTERNAL_SCOPE_ALIASES[normalized] ?? normalized;
  return normalized;
}

/** GS1 Mod-10；支持 GTIN-8/12/13/14。 */
export function isValidGtin(raw: string): boolean {
  const value = raw.trim();
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(value)) return false;
  const digits = [...value].map(Number);
  const checkDigit = digits.pop()!;
  let sum = 0;
  for (let index = digits.length - 1, position = 0; index >= 0; index--, position++) {
    sum += digits[index] * (position % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === checkDigit;
}

export const skuIdentifierSchema = z
  .object({
    kind: z.enum(SKU_IDENTIFIER_KINDS),
    value: z.string().trim().min(1, "标识值必填").max(100, "标识值最多 100 个字符"),
    scope: z.string().trim().min(1, "作用域必填").max(40).optional(),
    uom: z.string().trim().min(1).max(20).nullable().optional(),
    packagingLevel: z.enum(SKU_PACKAGING_LEVELS).nullable().optional(),
    isPrimary: z.boolean().optional().default(false),
    note: z.string().trim().max(200).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "gtin") {
      if (!isValidGtin(value.value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["value"],
          message: "GTIN 必须是校验位正确的 GTIN-8/12/13/14",
        });
      }
      if (!value.packagingLevel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["packagingLevel"],
          message: "GTIN 必须标明单品/内包/箱/托盘等包装层级",
        });
      }
      if (value.scope && value.scope.toUpperCase() !== "GS1") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scope"],
          message: "GTIN 的作用域固定为 GS1",
        });
      }
    }
    if (["external", "vendor", "customer"].includes(value.kind) && !value.scope) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope"],
        message: "外部系统/供应商/客户编码必须填写来源作用域",
      });
    }
  });

export type SkuIdentifierInput = z.infer<typeof skuIdentifierSchema>;

export function normalizeSkuIdentifier(input: SkuIdentifierInput) {
  return {
    ...input,
    value: input.value.trim(),
    scope: normalizeSkuIdentifierScope(input.kind, input.scope),
    uom: input.uom?.trim() || null,
    packagingLevel: input.packagingLevel ?? null,
    note: input.note?.trim() || null,
  };
}
