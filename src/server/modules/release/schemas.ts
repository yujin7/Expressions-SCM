/**
 * DW2 放行引擎路由入参（《04》§4：staging→人工闸→审批入库）。
 * 约定：dryRun 缺省 true——放行是不可逆写主档的动作，默认只预演。
 */
import { z } from "zod";

const jobIds = z.array(z.number().int().positive()).optional();

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
  dryRun: z.boolean().default(true),
});
export type ReleaseSpusBody = z.infer<typeof releaseSpusBody>;

export const releaseSkusBody = z.object({ jobIds, dryRun: z.boolean().default(true) });
export type ReleaseSkusBody = z.infer<typeof releaseSkusBody>;

/** BOM 放行：歧义块（§4.3）必须携带 resolutions[stagingRowId] 人工裁决 */
export const releaseBomsBody = z.object({
  jobIds,
  resolutions: z
    .record(z.object({ decision: z.enum(["active", "retired", "skip"]) }))
    .optional(),
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

export const releasePlainBody = z.object({ jobIds, dryRun: z.boolean().default(true) });
export type ReleasePlainBody = z.infer<typeof releasePlainBody>;

/** 快照刷新（D20 运营环）：bizDate 必填——快照必须有数据日期 */
export const releaseSnapshotsBody = z.object({
  jobIds,
  bizDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "数据日期格式须为 YYYY-MM-DD"),
  dryRun: z.boolean().default(true),
});
export type ReleaseSnapshotsBody = z.infer<typeof releaseSnapshotsBody>;
