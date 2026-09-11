import { z } from "zod";
import { checkCode } from "@/server/rules/code-rule";
import { shanghaiDay } from "@/server/core/business-day";
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
  /** 新建时留空由服务端按 S1 原子取号；历史码只可经受控迁移入口录入。 */
  code: z.preprocess(
    emptyToUndef,
    z.string().trim().refine((c) => checkCode(c).ok, (c) => ({ message: checkCode(c).reason ?? "编码不合规" })).optional(),
  ),
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
  /** 加工周期（sku_params.normal_lead_days，与周期主数据补录页同一行）；空=尚未维护，预警/补货走 default_production_lead_days。 */
  normalLeadDays: z.number().int().min(0).max(365).nullable().optional(),
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

const blankToNull = (value: unknown) => typeof value === "string" && value.trim() === "" ? null : value;
/** Updates preserve omitted fields; null/blank explicitly clears nullable master data, never state. */
export const skuUpdateSchema = skuSchema.extend({
  active: z.boolean().optional(),
  spec: z.preprocess(blankToNull, skuSchema.shape.spec.nullable()),
  version: z.preprocess(blankToNull, skuSchema.shape.version.nullable()),
  prodMode: z.preprocess(blankToNull, skuSchema.shape.prodMode.nullable()),
  shortName: z.preprocess(blankToNull, skuSchema.shape.shortName.nullable()),
  lossCategory: z.preprocess(blankToNull, skuSchema.shape.lossCategory.nullable()),
});

export const SKU_CREATE_MODES = ["governed_s1", "historical_migration"] as const;
/**
 * 主数据交互式新建契约。默认只能由系统生成 S1；历史码例外还须在 service 内
 * 重新校验管理员身份和原因。skuSchema 仍是更新/内部回填的基础字段契约。
 */
export const skuCreateSchema = skuSchema.extend({
  creationMode: z.enum(SKU_CREATE_MODES).optional().default("governed_s1"),
  historicalMigrationReason: z.preprocess(
    emptyToUndef,
    z.string().trim().min(10, "历史迁移原因至少 10 个字").max(500, "历史迁移原因最多 500 个字").optional(),
  ),
});
export type SkuCreateInput = z.infer<typeof skuCreateSchema>;

// ---------- 分类 ----------
export const categorySchema = z.object({
  name: z.string().trim().min(1, "分类名称必填"),
  parentId: z.number().int().positive().nullable().optional(),
});
export type CategoryInput = z.infer<typeof categorySchema>;

// ---------- 渠道 ----------
/**
 * 渠道主数据（审计 #11）：此前只有 seed 能写，六个页面却拿它当选择器——
 * 新开一个店/一个部门就得改 seed 重播，业务侧等于没有这条主数据。
 * `code` 是别名解析与外部映射的稳定业务键：建后不可改（改码=改身份，历史关系会静默错位）。
 */
export const CHANNEL_KINDS = ["platform", "dept"] as const;
export const channelSchema = z.object({
  code: z.string().trim().min(1, "渠道编码必填").max(30).regex(/^[a-z0-9_-]+$/, "渠道编码只允许小写字母、数字、下划线与连字符"),
  name: z.string().trim().min(1, "渠道名称必填").max(50),
  kind: z.enum(CHANNEL_KINDS, { errorMap: () => ({ message: "渠道类型只能是 platform（平台）或 dept（部门）" }) }),
  active: z.boolean().optional(),
});
export type ChannelInput = z.infer<typeof channelSchema>;

/** 改名 / 启停（不含 code：主码稳定） */
export const channelUpdateSchema = channelSchema.omit({ code: true }).partial().refine(
  (v) => v.name !== undefined || v.kind !== undefined || v.active !== undefined,
  "至少提供一个要修改的字段",
);

// ---------- 供应商 ----------
export const SUPPLIER_KINDS = ["raw", "packaging", "processor", "service"] as const; // +服务（04 §3）
export const SUPPLIER_LEVELS = ["S", "A", "B", "C", "D"] as const;
export const PAYMENT_TERM_TYPES = ["prepay", "on_delivery", "monthly_credit"] as const;
const paymentTermDate = dateStr.refine((value) => shanghaiDay(value) != null, "生效日必须是有效的日历日期");
const capacityDate = dateStr.refine((value) => shanghaiDay(value) != null, "产能有效期必须是有效的日历日期");
// 供应商详情 DTO 的可空文本会原样回传；保留原请求键，由 service 区分明确清空与未传。
// 不放宽其他主档的入参，也不把非法非空邮箱吞成空值。
const supplierEmptyToUndef = (v: unknown) => v === null ? undefined : emptyToUndef(v);
const supplierOptionalStr = z.preprocess(supplierEmptyToUndef, z.string().trim().optional());
// 对齐 numeric(14,4)，避免非法大数到数据库才变成500。
const declaredCapacityQty = z.preprocess(emptyToUndef,
  z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,10}(\.\d{1,4})?$/, "月产能须为非负数（整数最多10位、小数最多4位）")).nullable().optional());
const capacityEvidenceFields = {
  capacityValidFrom: z.preprocess(emptyToUndef, capacityDate.nullable().optional()),
  capacityValidUntil: z.preprocess(emptyToUndef, capacityDate.nullable().optional()),
  capacityEvidence: z.preprocess(emptyToUndef, z.string().trim().max(1000).nullable().optional()),
};

function refineCapacity(v: { declaredMonthlyCapacity?: string | null; capacityUom?: string | null; capacityValidFrom?: string | null; capacityValidUntil?: string | null; capacityEvidence?: string | null }, ctx: z.RefinementCtx) {
  if (v.declaredMonthlyCapacity != null && !v.capacityUom) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capacityUom"], message: "申报月产能必须带申报单位" });
  if (v.capacityValidFrom || v.capacityValidUntil) {
    if (!v.capacityValidFrom || !v.capacityValidUntil || v.capacityValidFrom > v.capacityValidUntil) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capacityValidUntil"], message: "产能有效期须完整填写且结束日不早于开始日" });
    if (!v.capacityEvidence?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["capacityEvidence"], message: "登记有效期须填写供应商申报依据" });
    if (v.declaredMonthlyCapacity == null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["declaredMonthlyCapacity"], message: "登记有效期须有申报月产能" });
  }
}

export const supplierSchema = z.object({
  code: z.string().trim().min(1, "编码必填").refine((c) => checkCode(c).ok, (c) => ({ message: checkCode(c).reason ?? "编码不合规" })),
  name: z.string().trim().min(1, "名称必填"),
  kinds: z.array(z.enum(SUPPLIER_KINDS)).min(1, "至少选择一种供应商类型"),
  contact: supplierOptionalStr,
  phone: supplierOptionalStr,
  email: z.preprocess(supplierEmptyToUndef, z.string().trim().email("邮箱格式不正确").optional()),
  address: supplierOptionalStr,
  paymentTerm: supplierOptionalStr, // 款到发货/月结30/月结60…
  bankAccount: supplierOptionalStr, // 敏感：出口经 maskSensitive
  level: z.enum(SUPPLIER_LEVELS).nullable().optional(), // S–D 分级（D7 评分 P1 前人工维护）
  licenseExpiry: z.preprocess(emptyToUndef, dateStr.nullable().optional()),
  // 状态变化走 supplier-lifecycle；保留可选入参仅供 seed/迁移显式建档。
  status: z.enum(["pending", "qualified", "paused", "blacklisted"]).optional(),
  // ── D64 账期结构化（payment_term 文本保留作原文；口径以下三列为准）──
  paymentTermType: z.enum(PAYMENT_TERM_TYPES).nullable().optional(),
  creditDays: z.preprocess(emptyToUndef, z.coerce.number().int().min(0).max(180).nullable().optional()),
  paymentTermEffectiveFrom: z.preprocess(emptyToUndef, paymentTermDate.nullable().optional()),
  // ── 产能申报（申报单位原样存，不换算）──
  declaredMonthlyCapacity: declaredCapacityQty,
  capacityUom: supplierOptionalStr,
  surgeCapacityPct: z.preprocess(emptyToUndef, z.coerce.number().int().min(0).max(300).nullable().optional()),
  ...capacityEvidenceFields,
}).superRefine((v, ctx) => { refinePaymentTerm(v, ctx); refineCapacity(v, ctx); });
export type SupplierInput = z.infer<typeof supplierSchema>;

/** 月结必须有天数；非月结不得带天数；填了类型必须带生效日 */
function refinePaymentTerm(
  v: { paymentTermType?: string | null; creditDays?: number | null; paymentTermEffectiveFrom?: string | null },
  ctx: z.RefinementCtx,
) {
  if (v.paymentTermType === "monthly_credit" && v.creditDays == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["creditDays"], message: "月结必须填写账期天数" });
  }
  if (v.paymentTermType != null && v.paymentTermType !== "monthly_credit" && v.creditDays != null && v.creditDays !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["creditDays"], message: "预付/款到发货不应带账期天数" });
  }
  if (v.paymentTermType != null && !v.paymentTermEffectiveFrom) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["paymentTermEffectiveFrom"], message: "登记账期必须填写生效日" });
  }
}

/** D64 账期专用写路径入参（PUT /api/master/supplier/[id]/payment-term） */
export const supplierPaymentTermSchema = z.object({
  paymentTermType: z.enum(PAYMENT_TERM_TYPES).nullable(),
  creditDays: z.preprocess(emptyToUndef, z.coerce.number().int().min(0).max(180).nullable().optional()),
  paymentTermEffectiveFrom: z.preprocess(emptyToUndef, paymentTermDate.nullable().optional()),
  paymentTerm: optionalStr, // 原文（可空：不改）
  note: optionalStr,
}).superRefine((v, ctx) => refinePaymentTerm(v, ctx));
export type SupplierPaymentTermInput = z.infer<typeof supplierPaymentTermSchema>;

/** 产能申报专用写路径入参（PUT /api/master/supplier/[id]/capacity） */
export const supplierCapacitySchema = z.object({
  declaredMonthlyCapacity: declaredCapacityQty,
  capacityUom: supplierOptionalStr,
  surgeCapacityPct: z.preprocess(emptyToUndef, z.coerce.number().int().min(0).max(300).nullable().optional()),
  note: optionalStr,
  ...capacityEvidenceFields,
}).superRefine(refineCapacity);
export type SupplierCapacityInput = z.infer<typeof supplierCapacitySchema>;

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
