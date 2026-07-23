import { z } from "zod";

/** 空字符串 → undefined（配合可选字段） */
const emptyToUndef = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const optionalStr = z.preprocess(emptyToUndef, z.string().trim().optional());
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD");

// ---------- SPU ----------
export const spuSchema = z.object({
  code: z.preprocess(
    emptyToUndef,
    z
      .string()
      .trim()
      .regex(/^P\d{5}$/, "编码格式应为 P+5位数字")
      .optional(),
  ),
  nameCn: z.string().trim().min(1, "中文名必填"),
  nameEn: optionalStr,
  categoryId: z.number().int().positive().nullable().optional(),
});
export type SpuInput = z.infer<typeof spuSchema>;

// ---------- SKU ----------
export const SKU_TYPES = ["finished", "raw", "packaging"] as const;
export const skuSchema = z.object({
  code: z.string().trim().min(1, "编码必填"),
  name: z.string().trim().min(1, "货品名称必填"),
  spuId: z.number().int().positive({ message: "必须选择所属 SPU" }),
  skuType: z.enum(SKU_TYPES),
  baseUom: z.string().trim().min(1, "基础单位必填"),
  spec: optionalStr,
  version: optionalStr,
  prodMode: optionalStr,
  lossCategory: z.preprocess(emptyToUndef, z.enum(["raw", "packaging"]).optional()),
  brandId: z.number().int().positive().nullable().optional(),
  lifecycle: z.enum(["on_sale", "trial", "halted", "retired"]).optional(),
  active: z.boolean().optional().default(true),
});
export type SkuInput = z.infer<typeof skuSchema>;

// ---------- 分类 ----------
export const categorySchema = z.object({
  name: z.string().trim().min(1, "分类名称必填"),
  parentId: z.number().int().positive().nullable().optional(),
});
export type CategoryInput = z.infer<typeof categorySchema>;

// ---------- 供应商 ----------
export const SUPPLIER_KINDS = ["raw", "packaging", "processor"] as const;
export const supplierSchema = z.object({
  code: z.string().trim().min(1, "编码必填"),
  name: z.string().trim().min(1, "名称必填"),
  kinds: z.array(z.enum(SUPPLIER_KINDS)).min(1, "至少选择一种供应商类型"),
  contact: optionalStr,
  licenseExpiry: z.preprocess(emptyToUndef, dateStr.nullable().optional()),
  status: z.enum(["pending", "qualified", "blacklisted"]).optional().default("pending"),
});
export type SupplierInput = z.infer<typeof supplierSchema>;

// ---------- 仓库 ----------
export const WAREHOUSE_KINDS = ["finished", "raw", "packaging", "outsource", "transit", "snapshot"] as const;
export const warehouseSchema = z
  .object({
    code: z.string().trim().min(1, "编码必填"),
    name: z.string().trim().min(1, "名称必填"),
    kind: z.enum(WAREHOUSE_KINDS),
    supplierId: z.number().int().positive().nullable().optional(),
    active: z.boolean().optional().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "outsource" && !v.supplierId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["supplierId"], message: "委外仓必须指定供应商" });
    }
  });
export type WarehouseInput = z.infer<typeof warehouseSchema>;

// ---------- BOM ----------
export const bomLineSchema = z.object({
  materialSkuId: z.number().int().positive({ message: "必须选择物料 SKU" }),
  qtyPer: z.coerce.number().positive({ message: "单位用量必须大于 0" }),
  lossRatePct: z.coerce.number().min(0, "损耗率不能为负").max(100, "损耗率不能超过 100").optional().default(0),
  leadTimeDays: z.coerce.number().int().min(0).nullable().optional(),
});
export const bomSchema = z.object({
  productSkuId: z.number().int().positive({ message: "必须选择成品 SKU" }),
  versionNo: z.string().trim().min(1, "版本号必填"),
  lines: z.array(bomLineSchema).min(1, "至少需要一行物料"),
});
export type BomInput = z.infer<typeof bomSchema>;
