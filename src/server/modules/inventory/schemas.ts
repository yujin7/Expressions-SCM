import { z } from "zod";
import { dCmp } from "@/server/core/decimal";

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

const qtyPositive = decStr.refine((s) => dCmp(s, "0") > 0, "数量必须大于 0");
const priceNonNegative = decStr.refine((s) => dCmp(s, "0") >= 0, "单价不能为负");

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
    remark: z.string().trim().max(500).optional(),
    lines: z.array(stockDocLineSchema).min(1, "至少需要一行"),
  })
  .superRefine((v, ctx) => {
    if (v.subtype !== "opening" && v.lines.some((l) => l.price != null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lines"], message: "仅期初单可填单价" });
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
