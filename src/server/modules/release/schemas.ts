/**
 * DW2 放行引擎路由入参（《04》§4：staging→人工闸→审批入库）。
 * 约定：dryRun 缺省 true——放行是不可逆写主档的动作，默认只预演。
 */
import { z } from "zod";
import { businessDateSchema } from "@/server/core/business-date-schema";

/** 所有放行动作必须明确绑定输入任务，禁止“把全库待处理行都放掉”。 */
const jobIds = z.array(z.number().int().positive()).min(1, "至少选择一个导入任务");
const preflightOverrides = z
  .record(
    z.object({
      token: z.string().length(64),
      reason: z.string().trim().min(5, "预检覆盖说明至少 5 个字").max(500),
    }),
  )
  .optional();

/** SPU 放行：review 簇必须显式 override，引擎绝不替人归组（§4.1） */
export const releaseSpusBody = z.object({
  jobIds,
  overrides: z
    .record(
      z.object({
        action: z.enum(["accept", "mergeInto"]),
        targetSpuKey: z.string().trim().optional(),
        nameOverride: z.string().trim().min(1).optional(),
      }),
    )
    .optional(),
  preflightOverrides,
  dryRun: z.boolean().default(true),
});
export type ReleaseSpusBody = z.infer<typeof releaseSpusBody>;

export const releaseSkusBody = z.object({ jobIds, preflightOverrides, dryRun: z.boolean().default(true) });
export type ReleaseSkusBody = z.infer<typeof releaseSkusBody>;

/** BOM 放行：歧义块（§4.3）必须携带 resolutions[stagingRowId] 人工裁决 */
export const releaseBomsBody = z.object({
  jobIds,
  resolutions: z
    .record(z.object({ decision: z.enum(["active", "retired", "skip"]) }))
    .optional(),
  preflightOverrides,
  dryRun: z.boolean().default(true),
});
export type ReleaseBomsBody = z.infer<typeof releaseBomsBody>;

/** 批量生效审批（§4.3）：runId 与显式 bomIds 二选一 */
export const activateBomsBody = z.object({
  releaseRunId: z.number().int().positive().optional(),
  bomIds: z.array(z.number().int().positive()).optional(),
  dryRun: z.boolean().default(true),
});
export type ActivateBomsBody = z.infer<typeof activateBomsBody>;

export const releasePlainBody = z.object({ jobIds, preflightOverrides, dryRun: z.boolean().default(true) });
export type ReleasePlainBody = z.infer<typeof releasePlainBody>;

/** 快照刷新（D20 运营环）：bizDate 必填——快照必须有数据日期 */
export const releaseSnapshotsBody = z.object({
  jobIds: z.array(z.number().int().positive()).length(1, "快照刷新每次必须且只能选择一个导入任务"),
  bizDate: businessDateSchema,
  expectedDigest: z.string().length(64).optional(),
  preflightOverrides,
  dryRun: z.boolean().default(true),
});
export type ReleaseSnapshotsBody = z.infer<typeof releaseSnapshotsBody>;
