import { z } from "zod";
import { dCmp } from "@/server/core/decimal";
import { ORDER_TYPES } from "@/server/core/constants";
import { shanghaiDay } from "@/server/core/business-day";

/** W3 委外链输入校验（BH/WO/PO/PC/JG）。十进制字符串，禁 float（CLAUDE.md）。 */

const decStr = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((s) => /^-?\d+(\.\d+)?$/.test(s), "必须是十进制数字");

// A failed shape refinement is not fatal to later refinements; pipe stops before decimal arithmetic.
const qtyPositive = decStr.pipe(z.string().refine((s) => dCmp(s, "0") > 0, "数量必须大于 0"));
const pricePositive = decStr.pipe(z.string().refine((s) => dCmp(s, "0") > 0, "单价必须大于 0"));
const priceNonNegative = decStr.pipe(z.string().refine((s) => dCmp(s, "0") >= 0, "单价不能为负"));
const pctNonNegative = decStr.pipe(z.string().refine((s) => dCmp(s, "0") >= 0, "税率不能为负"));

/** 订单类型（NPD 钩子；月备货存 "MONTH_STOCK:<n>"） */
const orderType = z
  .string()
  .trim()
  .refine(
    (v) => (ORDER_TYPES as readonly string[]).includes(v) || /^MONTH_STOCK:\d+$/.test(v),
    "订单类型非法",
  );

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式须为 YYYY-MM-DD");

// ---------- BH 备货申请 ----------

export const createBhSchema = z.object({
  remark: z.string().trim().max(500).optional(),
  orderType: orderType.optional(),
  lines: z
    .array(
      z.object({
        skuId: z.number().int().positive({ message: "必须选择 SKU" }),
        qty: qtyPositive.refine(s => /^\d{1,10}(\.\d{1,4})?$/.test(s) && dCmp(s, "10000000000") < 0, "数量最多10位整数、4位小数，且必须可精确存储"),
        expectDate: dateStr.refine(s => shanghaiDay(s) === s, "日期不存在").nullable().optional(),
      }),
    )
    .min(1, "至少需要一行"),
});
export type CreateBhInput = z.infer<typeof createBhSchema>;
/** 完整草稿替换；必须携带版本和修改原因，不把缺字段静默当PATCH。 */
export const updateBhSchema = createBhSchema.extend({
  version: z.number().int().positive(),
  reason: z.string().trim().min(1, "请填写修改原因").max(500),
}).strict();

// ---------- 通用 提交/审批 ----------

export const submitDocSchema = z.object({
  version: z.number().int().positive(),
});

export const approveDocSchema = z.object({
  action: z.enum(["approve", "reject"]),
  comment: z.string().trim().max(500).optional(),
  version: z.number().int().positive(),
});

/** 撤回：只需乐观锁版本；不带 comment（不是审批动作，不进审批轨迹） */
export const withdrawDocSchema = z.object({
  version: z.number().int().positive(),
});

/** 手工状态流转：完成/短关/作废/重开。短关必须留原因（服务层同样再校验一次）。 */
export const transitionDocSchema = z.object({
  action: z.enum(["complete", "short_close", "void", "reopen"]),
  reason: z.string().trim().max(500).optional(),
  version: z.number().int().positive(),
}).refine(
  (v) => v.action !== "short_close" || (v.reason?.trim().length ?? 0) > 0,
  { message: "短关必须填写原因", path: ["reason"] },
);

export const confirmDocSchema = z.object({
  version: z.number().int().positive(),
  note: z.string().trim().max(500).optional(),
});

// ---------- WO 委外工单 ----------

export const createWoSchema = z.object({
  bhId: z.number().int().positive().nullable().optional(),
  productSkuId: z.number().int().positive({ message: "必须选择成品 SKU" }),
  qty: qtyPositive,
  supplierId: z.number().int().positive({ message: "必须选择加工厂" }),
  feeRatePlan: pricePositive,
  dueDate: dateStr.nullable().optional(),
  orderType: orderType.optional(),
  remark: z.string().trim().max(500).optional(),
});
export type CreateWoInput = z.infer<typeof createWoSchema>;

/** WO 审批通过后一键生成 0..n 张 PO + 恰 1 张 JG */
export const generateDocsSchema = z.object({
  poGroups: z
    .array(
      z.object({
        supplierId: z.number().int().positive(),
        lines: z
          .array(
            z.object({
              materialSkuId: z.number().int().positive(),
              qty: qtyPositive,
              purchaseUom: z.string().trim().min(1).max(20).optional(),
              uomFactor: qtyPositive.optional(),
              price: priceNonNegative,
              taxIncluded: z.boolean().optional(),
              taxRatePct: pctNonNegative.optional(),
            }),
          )
          .min(1, "PO 至少需要一行"),
      }),
    )
    .default([]),
  jg: z
    .object({
      qty: qtyPositive.optional(),
      dueDate: dateStr.nullable().optional(),
    })
    .optional(),
});
export type GenerateDocsInput = z.infer<typeof generateDocsSchema>;

// ---------- PC 价格变更（jg_fee 手工发起；po_line 由 R1 自动生成） ----------

export const createPcForJgFeeSchema = z.object({
  jgId: z.number().int().positive({ message: "必须选择 JG" }),
  newPrice: pricePositive,
  scope: z.enum(["unreceived_only", "retroactive"], {
    errorMap: () => ({ message: "生效范围必填：仅未收/含已收追溯" }),
  }),
  remark: z.string().trim().max(500).optional(),
});
export type CreatePcForJgFeeInput = z.infer<typeof createPcForJgFeeSchema>;
