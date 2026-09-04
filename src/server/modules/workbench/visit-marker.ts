/**
 * 工作台「自上次访问以来有什么变化」（W2）。
 *
 * 问题：控制塔每次进页面现算例外，对访问者**没有任何记忆**。一个每天早上开工作台的总监
 * 看到的永远是完整一整屏——哪几条昨天就在、哪一条是今早新冒出来的，只能靠人脑记。
 * W9 补的 `exception_dismissals` 是**全局**记忆（挂了几天、谁打的盹），
 * 回答不了「对我而言有什么变化」。
 *
 * 做法（只做事实比对，不评分、不排序、不改判定）：
 *  - 每个用户一行 `workbench_visits`，两层字段：
 *    `baseline_*` = **上一段会话**结束时的快照与时刻（整段会话内固定，就是界面上的「上次访问」）；
 *    `last_seen_*` = 最近一次请求的滚动快照与时刻；
 *  - 本次可见键里不在 `baseline_keys` 中的 = 「上次访问后新增」，仅在行上打一个标；
 *  - 首次访问不标任何一条为新增——第一次见到就整屏飘红等于没有信息。
 *
 * 为什么要两层（`WORKBENCH_VISIT_GAP_MS`）：一次「访问」是一段工作会话，不是一次页面刷新。
 * 若只存一份快照并每次请求都覆盖，用户按一下刷新、或页面自己重载一次，
 * 刚才那条「新增」就永远消失了——那正是这个功能要解决的问题本身。
 * 距上一次请求超过 30 分钟才算新会话：此时把 `last_seen_*` 顺移成新的 `baseline_*`。
 *
 * 纪律：
 *  - 纯展示增益：不写审计、不改告警/待办、不参与任何记账（与 W9 的连续天数同性质；
 *    打盹要写审计是因为它是**全局**业务动作，会影响别人看到什么）；
 *  - 任何失败都降级为「没有新增标记」，绝不让工作台首屏 500——控制塔的可用性优先。
 */
import { eq, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { resolveDb, type AnyDb } from "@/server/core/svc";

/** 会话断开阈值：距上一次请求超过它才算「新的一次访问」（刷新不该抹掉「新增」标记） */
export const WORKBENCH_VISIT_GAP_MS = 30 * 60 * 1000;

export interface WorkbenchVisitDelta {
  /** 本次相对上次访问新增的例外键（首次访问恒为空） */
  newKeys: string[];
  /** 比对基线对应的上次访问时刻（ISO；首次访问 = null） */
  since: string | null;
  /** 本次是否为该用户的首次访问（首次不标新增） */
  firstVisit: boolean;
}

const EMPTY: WorkbenchVisitDelta = { newKeys: [], since: null, firstVisit: true };

/** jsonb 读回来可能是数组、也可能是字符串（不同驱动行为不同）；脏值一律当空基线 */
export function parseSeenKeys(raw: unknown): string[] {
  const value = typeof raw === "string" ? safeJson(raw) : raw;
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 纯函数：给定基线与本次可见键，算出「新增」。
 * 首次访问（basline=null）不标新增；顺序保持本次传入的顺序（调用方已按严重度排好）。
 */
export function newSinceLastVisit(baseline: readonly string[] | null, currentKeys: readonly string[]): string[] {
  if (baseline === null) return [];
  const seen = new Set(baseline);
  return currentKeys.filter((k) => !seen.has(k));
}

/** 距上一次请求是否已超过会话断开阈值（到点才算新的一次访问，基线顺移） */
export function isNewVisit(lastSeenAt: Date | null, now: Date, gapMs = WORKBENCH_VISIT_GAP_MS): boolean {
  if (!lastSeenAt) return true;
  return now.getTime() - lastSeenAt.getTime() >= gapMs;
}

/**
 * 读取本段会话的比对基线，并（新会话时）把上一段的滚动快照顺移成基线。
 * @param currentKeys 本次可见的例外键（已过滤打盹）
 */
export async function markWorkbenchVisit(
  dbArg: AnyDb,
  userId: number,
  currentKeys: readonly string[],
  now: Date = new Date(),
): Promise<WorkbenchVisitDelta> {
  if (!Number.isInteger(userId) || userId <= 0) return EMPTY;
  try {
    const db = await resolveDb(dbArg);
    const [row]: {
      id: number;
      baselineAt: Date | string | null;
      baselineKeys: unknown;
      lastSeenAt: Date | string | null;
      lastSeenKeys: unknown;
    }[] = await db
      .select({
        id: schema.workbenchVisits.id,
        baselineAt: schema.workbenchVisits.baselineAt,
        baselineKeys: schema.workbenchVisits.baselineKeys,
        lastSeenAt: schema.workbenchVisits.lastSeenAt,
        lastSeenKeys: schema.workbenchVisits.lastSeenKeys,
      })
      .from(schema.workbenchVisits)
      .where(eq(schema.workbenchVisits.userId, userId))
      .limit(1);

    const keysJson = JSON.stringify([...currentKeys]);
    const nowIso = now.toISOString();

    /* 首次访问：只记事实，不标新增 */
    if (row == null) {
      await db.execute(sql`
        INSERT INTO workbench_visits (user_id, baseline_at, baseline_keys, last_seen_at, last_seen_keys)
        VALUES (${userId}, ${nowIso}::timestamptz, ${keysJson}::jsonb, ${nowIso}::timestamptz, ${keysJson}::jsonb)
        ON CONFLICT (user_id) DO NOTHING`);
      return { newKeys: [], since: null, firstVisit: true };
    }

    const lastSeenAt = row.lastSeenAt == null ? null : new Date(row.lastSeenAt);
    const newSession = isNewVisit(lastSeenAt, now);
    /* 新会话：上一段的滚动快照顺移成本段基线；同一段会话内基线不动（刷新不吃掉标记） */
    const baseline = newSession ? parseSeenKeys(row.lastSeenKeys) : parseSeenKeys(row.baselineKeys);
    const baselineAt = newSession
      ? lastSeenAt
      : row.baselineAt == null ? null : new Date(row.baselineAt);

    const delta: WorkbenchVisitDelta = {
      newKeys: newSinceLastVisit(baseline, currentKeys),
      since: baselineAt ? baselineAt.toISOString() : null,
      firstVisit: false,
    };

    if (newSession) {
      const baselineJson = JSON.stringify(baseline);
      await db.execute(sql`
        UPDATE workbench_visits SET
          baseline_at = ${baselineAt ? baselineAt.toISOString() : nowIso}::timestamptz,
          baseline_keys = ${baselineJson}::jsonb,
          last_seen_at = ${nowIso}::timestamptz,
          last_seen_keys = ${keysJson}::jsonb,
          updated_at = now()
        WHERE user_id = ${userId}`);
    } else {
      await db.execute(sql`
        UPDATE workbench_visits SET
          last_seen_at = ${nowIso}::timestamptz,
          last_seen_keys = ${keysJson}::jsonb,
          updated_at = now()
        WHERE user_id = ${userId}`);
    }
    return delta;
  } catch {
    // 表不可用（迁移未跑）等一律降级为「没有新增标记」，首屏照常渲染
    return EMPTY;
  }
}
