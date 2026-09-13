import { z } from "zod";
import { businessDateSchema } from "@/server/core/business-date-schema";
import { dCmp } from "@/server/core/decimal";

/** W4 物料流转链输入校验（FL/TL/SH/QC/CT）。十进制字符串，禁 float（CLAUDE.md）。 */

const decStr = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((s) => /^-?\d+(\.\d+)?$/.test(s), "必须是十进制数字");

const qtyPositive = decStr.refine((s) => dCmp(s, "0") > 0, "数量必须大于 0");
const qtyNonNegative = decStr.refine((s) => dCmp(s, "0") >= 0, "数量不能为负");

const dateStr = businessDateSchema;

// ---------- FL 发料 ----------

export const createFlSchema = z.object({
  jgId: z.number().int().positive({ message: "必须选择加工通知单" }),
  fromWarehouseId: z.number().int().positive({ message: "必须选择发料仓" }),
  toWarehouseId: z.number().int().positive().optional(),
  remark: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.object({
        skuId: z.number().int().positive({ message: "必须选择物料" }),
        qty: qtyPositive,
        batchId: z.number().int().positive().nullable().optional(),
      }),
    )
    .min(1, "至少需要一行"),
});
export type CreateFlInput = z.infer<typeof createFlSchema>;

/** Complete reviewed draft replacement; source JG is immutable and batch omission is not a clear. */
export const updateFlSchema = createFlSchema.omit({ jgId: true }).extend({
  version: z.number().int().positive(),
  toWarehouseId: z.number().int().positive(),
  lines: z.array(createFlSchema.shape.lines.element.extend({ batchId: z.number().int().positive().nullable() })).min(1),
}).strict();

// ---------- TL 退料 ----------

export const createTlSchema = z.object({
  jgId: z.number().int().positive({ message: "必须选择加工通知单" }),
  toWarehouseId: z.number().int().positive({ message: "必须选择退回仓" }),
  fromWarehouseId: z.number().int().positive().optional(),
  remark: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.object({
        skuId: z.number().int().positive({ message: "必须选择物料" }),
        qty: qtyPositive,
        batchId: z.number().int().positive().nullable().optional(),
        reason: z.enum(["surplus_return", "defect_exchange"], {
          errorMap: () => ({ message: "退料原因必填：剩料退回/不合格料退换" }),
        }),
      }),
    )
    .min(1, "至少需要一行"),
});
export type CreateTlInput = z.infer<typeof createTlSchema>;

// ---------- SH 收货 ----------

export const createShSchema = z.object({
  sourceType: z.enum(["jg", "po"], { errorMap: () => ({ message: "来源类型必须是 jg 或 po" }) }),
  sourceId: z.number().int().positive({ message: "必须选择来源单据" }),
  warehouseId: z.number().int().positive({ message: "必须选择收货仓" }),
  remark: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.object({
        skuId: z.number().int().positive({ message: "必须选择 SKU" }),
        poLineId: z.number().int().positive().optional(),
        lineType: z.enum(["normal", "rework", "spare"]).default("normal"),
        expectedQty: qtyPositive.nullable().optional(),
        actualQty: qtyPositive,
        batchNo: z.string().trim().max(50).optional(),
        prodDate: dateStr.nullable().optional(),
      }),
    )
    .min(1, "至少需要一行"),
});
export type CreateShInput = z.infer<typeof createShSchema>;

export const confirmInboundSchema = z.object({
  outsourceWarehouseId: z.number().int().positive().optional(),
}).strict();

// ---------- QC 检验 ----------

export const createQcSchema = z.object({
  shId: z.number().int().positive({ message: "必须选择收货单" }),
  conclusion: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.object({
        shLineId: z.number().int().positive({ message: "必须关联收货行" }),
        passQty: qtyNonNegative,
        failQty: qtyNonNegative,
        concessionQty: qtyNonNegative,
        failHandling: z.enum(["pending", "rework", "concession", "scrap"]).default("pending"),
      }),
    )
    .min(1, "至少需要一行"),
});
export type CreateQcInput = z.infer<typeof createQcSchema>;

// ---------- CT 采购退货 ----------

export const createCtSchema = z.object({
  poId: z.number().int().positive({ message: "必须选择采购订单" }),
  warehouseId: z.number().int().positive({ message: "必须选择退货出库仓" }),
  remark: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.object({
        poLineId: z.number().int().positive({ message: "必须关联 PO 行" }),
        skuId: z.number().int().positive({ message: "必须选择 SKU" }),
        qty: qtyPositive, // 基础单位
        batchId: z.number().int().positive().nullable().optional(),
        reason: z.string().trim().max(200).optional(),
      }),
    )
    .min(1, "至少需要一行"),
});
export type CreateCtInput = z.infer<typeof createCtSchema>;
