import { z } from "zod";
import { checkCode } from "@/server/rules/code-rule";
import { COMMERCIAL_ROLES, unicodeLength } from "@/server/rules/sku-standardization";

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
export const SKU_TYPES = ["finished", "semi", "raw", "packaging", "service"] as const; // 04 §3 五值
export const skuSchema = z.object({
  code: z.string().trim().min(1, "编码必填").refine((c) => checkCode(c).ok, (c) => ({ message: checkCode(c).reason ?? "编码不合规" })),
  name: z.string().trim().min(1, "货品名称必填"),
  spuId: z.number().int().positive({ message: "必须选择所属 SPU" }),
  skuType: z.enum(SKU_TYPES),
  baseUom: z.string().trim().min(1, "基础单位必填"),
  spec: optionalStr,
  version: optionalStr,
  prodMode: optionalStr,
  shortName: z.preprocess(
    emptyToUndef,
    z.string().trim().refine((value) => unicodeLength(value) <= 10, "产品简称最多 10 个字符").optional(),
  ),
  channelId: z.number().int().positive().nullable().optional(),
  commercialRole: z.enum(COMMERCIAL_ROLES).optional(),
  /** 生产周期之外的运输/调拨周期；空=尚未维护，补货暂按 0 天兼容旧口径。 */
  logisticsLeadDays: z.number().int().min(0).max(365).nullable().optional(),
  lossCategory: z.preprocess(emptyToUndef, z.enum(["raw", "packaging"]).optional()),
  brandId: z.number().int().positive().nullable().optional(),
  lifecycle: z.enum(["on_sale", "trial", "halted", "retired"]).optional(),
  active: z.boolean().optional().default(true),
  /* 效期两参（2026-07-25 审计补写入口）。
     此前 skus 表有这两列、且有两处活代码读它，却**全系统没有任何写入路径**
     （zod 无此键、create/updateSku 白名单不含、放行引擎只写 shelf_life_days、无 UI/API）：
     - shelfLifeDays 决定渠道临期口径 max(保质期×2/10, 100天) 能否比对；
     - nearExpiryDays 是 matflow/sh.ts「管效期 SKU 收货必填批次号」硬闸的唯一开关，
       实测 0/5376 非空 → 该闸结构性不可达，读代码的人会以为效期收货已受控，实则一单也拦不住。
     留空＝沿用兜底 90 天（与 report/risk 一致），不改变既有行为。 */
  shelfLifeDays: z.number().int().positive().nullable().optional(),
  nearExpiryDays: z.number().int().positive().nullable().optional(),
});
export type SkuInput = z.infer<typeof skuSchema>;

// ---------- 分类 ----------
export const categorySchema = z.object({
  name: z.string().trim().min(1, "分类名称必填"),
  parentId: z.number().int().positive().nullable().optional(),
});
export type CategoryInput = z.infer<typeof categorySchema>;

// ---------- 供应商 ----------
export const SUPPLIER_KINDS = ["raw", "packaging", "processor", "service"] as const; // +服务（04 §3）
export const SUPPLIER_LEVELS = ["S", "A", "B", "C", "D"] as const;
export const supplierSchema = z.object({
  code: z.string().trim().min(1, "编码必填").refine((c) => checkCode(c).ok, (c) => ({ message: checkCode(c).reason ?? "编码不合规" })),
  name: z.string().trim().min(1, "名称必填"),
  kinds: z.array(z.enum(SUPPLIER_KINDS)).min(1, "至少选择一种供应商类型"),
  contact: optionalStr,
  phone: optionalStr,
  email: z.preprocess(emptyToUndef, z.string().email("邮箱格式不正确").optional()),
  address: optionalStr,
  paymentTerm: optionalStr, // 款到发货/月结30/月结60…
  bankAccount: optionalStr, // 敏感：出口经 maskSensitive
  level: z.enum(SUPPLIER_LEVELS).nullable().optional(), // S–D 分级（D7 评分 P1 前人工维护）
  licenseExpiry: z.preprocess(emptyToUndef, dateStr.nullable().optional()),
  // 状态变化走 supplier-lifecycle；保留可选入参仅供 seed/迁移显式建档。
  status: z.enum(["pending", "qualified", "paused", "blacklisted"]).optional(),
});
export type SupplierInput = z.infer<typeof supplierSchema>;

// ---------- 仓库 ----------
export const WAREHOUSE_KINDS = ["finished", "raw", "packaging", "outsource", "transit", "snapshot"] as const;
export const BIN_KINDS = ["normal", "quarantine", "staging"] as const;
export const warehouseSchema = z
  .object({
    code: z.string().trim().min(1, "编码必填").refine((c) => checkCode(c).ok, (c) => ({ message: checkCode(c).reason ?? "编码不合规" })),
    name: z.string().trim().min(1, "名称必填"),
    kind: z.enum(WAREHOUSE_KINDS),
    regionCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, "区域代码须为两位大写字母").optional(),
    parentId: z.coerce.number().int().positive().nullable().optional(), // D32 树状层级
    supplierId: z.number().int().positive().nullable().optional(),
    active: z.boolean().optional().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "outsource" && !v.supplierId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["supplierId"], message: "委外仓必须指定供应商" });
    }
  });
export type WarehouseInput = z.infer<typeof warehouseSchema>;

export const binSchema = z.object({
  warehouseId: z.number().int().positive({ message: "必须选择所属仓库" }),
  code: z.string().trim().min(1, "库位编码必填").max(40),
  name: z.preprocess(emptyToUndef, z.string().trim().max(80).nullable().optional()),
  kind: z.enum(BIN_KINDS).optional().default("normal"),
  active: z.boolean().optional().default(true),
  remark: z.preprocess(emptyToUndef, z.string().trim().max(300).nullable().optional()),
});
export type BinInput = z.infer<typeof binSchema>;

// ---------- BOM ----------
export const bomLineSchema = z.object({
  materialSkuId: z.number().int().positive({ message: "必须选择物料 SKU" }),
  qtyPer: z.coerce.number().positive({ message: "单位用量必须大于 0" }),
  lossRatePct: z.coerce.number().min(0, "损耗率不能为负").max(100, "损耗率不能超过 100").optional().default(0),
  incomingLossPct: z.coerce.number().min(0, "来料损耗不能为负").max(100).optional().default(0),
  productionLossPct: z.coerce.number().min(0, "生产损耗不能为负").max(100).optional().default(0),
  leadTimeDays: z.coerce.number().int().min(0).nullable().optional(),
});
export const bomSchema = z.object({
  productSkuId: z.number().int().positive({ message: "必须选择成品 SKU" }),
  versionNo: z.string().trim().min(1, "版本号必填"),
  lines: z.array(bomLineSchema).min(1, "至少需要一行物料"),
});
export type BomInput = z.infer<typeof bomSchema>;
