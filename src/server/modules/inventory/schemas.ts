import { z } from "zod";
import { dCmp } from "@/server/core/decimal";
import { TRANSFER_TYPES } from "@/lib/transfer-types";

/**
 * 库存单据（W2 手工四类）输入校验。
 * 其余子类型（purchase_in / outsource_in …）由 SH/JS 等流程在 W4 生成，禁止手工创建。
 */
export const MANUAL_SUBTYPES = ["opening", "issue_out", "sales_out", "transfer"] as const;
export type ManualSubtype = (typeof MANUAL_SUBTYPES)[number];

/** 数量/单价：十进制字符串（禁 float 运算）；接受 number 输入但立即转字符串 */
const decStr = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((s) => /^-?\d+(\.\d+)?$/.test(s), "必须是十进制数字");

// Only format-valid values may reach arithmetic; ordinary input errors stay 400.
const qtyPositive = decStr.pipe(z.string().refine((s) => dCmp(s, "0") > 0, "数量必须大于 0"));
const priceNonNegative = decStr.pipe(z.string().refine((s) => dCmp(s, "0") >= 0, "单价不能为负"));

export const stockDocLineSchema = z.object({
  skuId: z.number().int().positive({ message: "必须选择 SKU" }),
  qty: qtyPositive,
  batchId: z.number().int().positive().nullable().optional(),
  price: priceNonNegative.nullable().optional(),
});

export const createStockDocSchema = z
  .object({
    subtype: z.enum(MANUAL_SUBTYPES, {
      errorMap: () => ({ message: "仅支持手工子类型：期初/领料出/销售出/调拨" }),
    }),
    warehouseId: z.number().int().positive({ message: "必须选择仓库" }),
    toWarehouseId: z.number().int().positive().nullable().optional(),
    /** R16：调拨业务原因（'借调' 触发月末部门间借调对账）；仅调拨填写 */
    reason: z.string().trim().max(50).optional(),
    /** D60：调拨类型固定清单（src/lib/transfer-types.ts）；subtype=transfer 必填，其余子类型禁止携带 */
    transferType: z.enum(TRANSFER_TYPES, { errorMap: () => ({ message: "调拨类型不在固定清单内" }) }).optional(),
    remark: z.string().trim().max(500).optional(),
    /** 风险处置登记来源；仅报废出库（issue_out）可绑定。 */
    riskDisposalId: z.number().int().positive().optional(),
    /** Explicit predecessor; never inferred from similar contents or a void reason. */
    replacementOfId: z.number().int().positive().max(2147483647).optional(),
    lines: z.array(stockDocLineSchema).min(1, "至少需要一行"),
  })
  .superRefine((v, ctx) => {
    if (v.subtype !== "opening" && v.lines.some((l) => l.price != null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lines"], message: "仅期初单可填单价" });
    }
    if (v.reason && v.subtype !== "transfer") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "业务原因仅调拨单填写（R16）" });
    }
    if (v.transferType && v.subtype !== "transfer") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["transferType"], message: "调拨类型仅调拨单填写（D60）" });
    }
    if (v.subtype === "transfer" && !v.transferType) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["transferType"], message: "调拨必须选择调拨类型（D60 固定清单）" });
    }
    if (v.riskDisposalId && v.subtype !== "issue_out") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["riskDisposalId"],
        message: "风险处置登记只能绑定领料出（报废出库）",
      });
    }
    if (v.subtype === "transfer") {
      if (!v.toWarehouseId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["toWarehouseId"], message: "调拨必须指定转入仓" });
      } else if (v.toWarehouseId === v.warehouseId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["toWarehouseId"], message: "转入仓不能与转出仓相同" });
      }
    }
  });
export type CreateStockDocInput = z.infer<typeof createStockDocSchema>;

export const submitStockDocSchema = z.object({
  version: z.number().int().positive(),
});
export type SubmitStockDocInput = z.infer<typeof submitStockDocSchema>;

export const approveStockDocSchema = z.object({
  action: z.enum(["approve", "reject"]),
  comment: z.string().trim().max(500).optional(),
  version: z.number().int().positive(),
});
export type ApproveStockDocInput = z.infer<typeof approveStockDocSchema>;

export const reverseStockDocSchema = z.object({
  reason: z.string().trim().min(1, "冲销原因必填").max(500),
});
export type ReverseStockDocInput = z.infer<typeof reverseStockDocSchema>;

/** 撤回（待审批 → 草稿）：制单人或管理员；无需原因（单据回到可编辑态） */
export const withdrawStockDocSchema = z.object({
  version: z.number().int().positive(),
});
export type WithdrawStockDocInput = z.infer<typeof withdrawStockDocSchema>;

/** 作废草稿（草稿 → 已作废）：制单人或管理员，必须留原因（草稿也是留痕对象） */
export const voidStockDocSchema = z.object({
  version: z.number().int().positive(),
  reason: z.string().trim().min(2, "作废原因必填").max(500),
});
export type VoidStockDocInput = z.infer<typeof voidStockDocSchema>;

/** 短关（已审批/执行中 → 已关闭）：必须留原因；只关剩余部分，绝不回滚已过账数量 */
export const shortCloseStockDocSchema = z.object({
  version: z.number().int().positive(),
  reason: z.string().trim().min(2, "短关原因必填").max(500),
});
export type ShortCloseStockDocInput = z.infer<typeof shortCloseStockDocSchema>;
