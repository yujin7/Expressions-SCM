import { z } from "zod";
import { dZero } from "@/server/core/decimal";

/** W4 委外结算 JS 输入校验。十进制字符串，禁 float（CLAUDE.md）。 */

const decStr = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((s) => /^-?\d+(\.\d+)?$/.test(s), "必须是十进制数字");

// ---------- JS 创建（一 JG 一 JS，schema UNIQUE 兜底） ----------

export const createJsSchema = z
  .object({
    jgId: z.number().int().positive({ message: "必须选择 JG" }),
    /** 手工调整（可正可负）；≠0 时必须留痕说明（审批留痕，R5） */
    manualAdj: decStr.optional().default("0"),
    manualAdjNote: z.string().trim().max(500).optional(),
    remark: z.string().trim().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (!dZero(v.manualAdj) && !v.manualAdjNote) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["manualAdjNote"],
        message: "手工调整不为 0 时必须填写调整说明（留痕）",
      });
    }
  });
export type CreateJsInput = z.infer<typeof createJsSchema>;

// ---------- 提交 ----------

export const submitJsSchema = z.object({
  version: z.number().int().positive(),
});

export const refreshJsBasisSchema = submitJsSchema.extend({
  basisToken: z.string().regex(/^[a-f0-9]{64}$/, "请先读取并核对当前结算依据"),
  note: z.string().trim().min(1, "请填写依据更新说明").max(500),
});

// ---------- 审批（财务；结余物料须确认或先退料 TL） ----------

export const approveJsSchema = z
  .object({
    action: z.enum(["approve", "reject"]),
    comment: z.string().trim().max(500).optional(),
    version: z.number().int().positive(),
    /** 存在负实际损耗（结余）物料时，财务显式确认后方可通过 */
    acknowledgeSurplus: z.boolean().optional().default(false),
    surplusNote: z.string().trim().max(500).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.acknowledgeSurplus && !v.surplusNote) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["surplusNote"],
        message: "确认结余必须填写短溢说明（留痕）",
      });
    }
  });
export type ApproveJsInput = z.infer<typeof approveJsSchema>;

// ---------- JG 收货关闭（in_progress → completed，开结算的门） ----------

export const closeJgSchema = z.object({
  jgId: z.number().int().positive(),
  version: z.number().int().positive(),
});
