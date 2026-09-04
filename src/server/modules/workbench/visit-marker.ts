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
 * ── W2 修复三处 ──
 * ① **快照要带条目数，不能只带分类键**。例外键是 `inventory_cover` / `expired_stock` 这样的**分类**，
 *    昨天 2 个 SKU、今早 200 个 SKU，键完全一样，于是页面写着「上次访问后无新增」。
 *    快照改存 `{k, c}`（键 + 条目数），键还在但条目数**变多**的记为 `grownKeys`，
 *    行上给 `previousCount`/`countDelta`，读者看得见「多了 198 个」。
 *    向后兼容：旧快照是字符串数组，读回来条目数记为 null（视为未知，不误报增长）。
 * ② **快照必须在打盹过滤之前取**。此前传进来的是过滤后的可见清单，一条被打盹 90 天的例外
 *    在打盹到期那天会作为「新增」重新飘红——它根本没消失过，只是被藏起来了。
 * ③ **表不可用 ≠ 首次访问**。迁移没跑时此前一律返回 `firstVisit: true`，界面于是**永远**显示
 *    「首次访问」，一个坏掉的功能伪装成一个正常的状态。现在区分 `state: "unavailable"`。
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

/** 一条例外在快照里的形态：分类键 + 该分类下的条目数 */
export interface VisitSnapshotEntry {
  /** 例外键（分类，如 inventory_cover） */
  k: string;
  /** 该分类下的条目数（如 SKU 个数）；旧格式快照读回来 = null（未知） */
  c: number | null;
}

/**
 * 标记状态三态——`firstVisit` 一个布尔量表达不了「表不可用」，
 * 于是迁移没跑时界面永远显示「首次访问」，坏掉的功能伪装成正常状态。
 */
export type VisitMarkerState = "first_visit" | "compared" | "unavailable";

export interface WorkbenchVisitDelta {
  /** 本次相对上次访问**新出现**的例外键（首次访问/不可用恒为空） */
  newKeys: string[];
  /** 键在上次访问时已存在、但**条目数变多**的例外键（分类不变、里面的东西变多也是新增） */
  grownKeys: string[];
  /** 逐键的上次条目数（未知/新出现 = null）——供行上展示「从 2 → 200」 */
  previousCounts: Record<string, number | null>;
  /** 比对基线对应的上次访问时刻（ISO；首次访问/不可用 = null） */
  since: string | null;
  /** 本次是否为该用户的首次访问（首次不标新增）；`state === "unavailable"` 时为 false */
  firstVisit: boolean;
  /** 三态：真首次 / 已比对 / 记忆表不可用（不可用 ≠ 首次） */
  state: VisitMarkerState;
}

/** 记忆表不可用（迁移未跑等）：不标新增，也**不谎称首次访问** */
const UNAVAILABLE: WorkbenchVisitDelta = {
  newKeys: [], grownKeys: [], previousCounts: {}, since: null, firstVisit: false, state: "unavailable",
};

/**
 * jsonb 读回来可能是数组、也可能是字符串（不同驱动行为不同）；脏值一律当空基线。
 * 两种格式都认：旧格式 `["k1","k2"]`（条目数未知 → null）、新格式 `[{k,c}]`。
 */
export function parseSeenEntries(raw: unknown): VisitSnapshotEntry[] {
  const value = typeof raw === "string" ? safeJson(raw) : raw;
  if (!Array.isArray(value)) return [];
  const out: VisitSnapshotEntry[] = [];
  for (const v of value) {
    if (typeof v === "string") { out.push({ k: v, c: null }); continue; }
    if (v != null && typeof v === "object") {
      const o = v as { k?: unknown; c?: unknown };
      if (typeof o.k !== "string") continue;
      const c = typeof o.c === "number" && Number.isFinite(o.c) ? o.c : null;
      out.push({ k: o.k, c });
    }
  }
  return out;
}

/** 仅取键（旧调用方与「首次访问」判定用） */
export function parseSeenKeys(raw: unknown): string[] {
  return parseSeenEntries(raw).map((e) => e.k);
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

/**
 * 纯函数：条目级比对。返回「新出现的键」「条目数变多的键」以及逐键的上次条目数。
 *
 * 为什么要 `grown`：例外键是**分类**，`inventory_cover` 从 2 个 SKU 涨到 200 个 SKU，
 * 键一个字都没变——只比键的话页面写「上次访问后无新增」，而这正是最该被看见的一晚。
 * 上次条目数未知（旧格式快照）时**不判增长**：宁可漏标，也不要凭空造一条假新增。
 */
export function diffVisitEntries(
  baseline: readonly VisitSnapshotEntry[] | null,
  current: readonly VisitSnapshotEntry[],
): { newKeys: string[]; grownKeys: string[]; previousCounts: Record<string, number | null> } {
  const previousCounts: Record<string, number | null> = {};
  if (baseline === null) {
    for (const e of current) previousCounts[e.k] = null;
    return { newKeys: [], grownKeys: [], previousCounts };
  }
  const prev = new Map(baseline.map((e) => [e.k, e.c]));
  const newKeys: string[] = [];
  const grownKeys: string[] = [];
  for (const e of current) {
    if (!prev.has(e.k)) {
      previousCounts[e.k] = null;
      newKeys.push(e.k);
      continue;
    }
    const before = prev.get(e.k) ?? null;
    previousCounts[e.k] = before;
    if (before != null && e.c != null && e.c > before) grownKeys.push(e.k);
  }
  return { newKeys, grownKeys, previousCounts };
}

/** 距上一次请求是否已超过会话断开阈值（到点才算新的一次访问，基线顺移） */
export function isNewVisit(lastSeenAt: Date | null, now: Date, gapMs = WORKBENCH_VISIT_GAP_MS): boolean {
  if (!lastSeenAt) return true;
  return now.getTime() - lastSeenAt.getTime() >= gapMs;
}

/**
 * 读取本段会话的比对基线，并（新会话时）把上一段的滚动快照顺移成基线。
 *
 * @param current 本次的例外快照，**必须是打盹过滤之前**的全量清单（键 + 条目数）。
 *   传过滤后的清单会让一条打盹到期的老例外冒充「新增」——它从未消失，只是被藏起来了。
 */
export async function markWorkbenchVisit(
  dbArg: AnyDb,
  userId: number,
  current: readonly VisitSnapshotEntry[],
  now: Date = new Date(),
): Promise<WorkbenchVisitDelta> {
  if (!Number.isInteger(userId) || userId <= 0) return UNAVAILABLE;
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

    const keysJson = JSON.stringify(current.map((e) => ({ k: e.k, c: e.c })));
    const nowIso = now.toISOString();

    /* 首次访问：只记事实，不标新增 */
    if (row == null) {
      await db.execute(sql`
        INSERT INTO workbench_visits (user_id, baseline_at, baseline_keys, last_seen_at, last_seen_keys)
        VALUES (${userId}, ${nowIso}::timestamptz, ${keysJson}::jsonb, ${nowIso}::timestamptz, ${keysJson}::jsonb)
        ON CONFLICT (user_id) DO NOTHING`);
      return { newKeys: [], grownKeys: [], previousCounts: {}, since: null, firstVisit: true, state: "first_visit" };
    }

    const lastSeenAt = row.lastSeenAt == null ? null : new Date(row.lastSeenAt);
    const newSession = isNewVisit(lastSeenAt, now);
    /* 新会话：上一段的滚动快照顺移成本段基线；同一段会话内基线不动（刷新不吃掉标记） */
    const baseline = newSession ? parseSeenEntries(row.lastSeenKeys) : parseSeenEntries(row.baselineKeys);
    const baselineAt = newSession
      ? lastSeenAt
      : row.baselineAt == null ? null : new Date(row.baselineAt);

    const diff = diffVisitEntries(baseline, current);
    const delta: WorkbenchVisitDelta = {
      newKeys: diff.newKeys,
      grownKeys: diff.grownKeys,
      previousCounts: diff.previousCounts,
      since: baselineAt ? baselineAt.toISOString() : null,
      firstVisit: false,
      state: "compared",
    };

    if (newSession) {
      const baselineJson = JSON.stringify(baseline.map((e) => ({ k: e.k, c: e.c })));
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
    /* 表不可用（迁移未跑）等：降级为「没有新增标记」，首屏照常渲染——
       但**不谎称首次访问**。此前一律 firstVisit:true，于是一个没跑迁移的环境
       永远显示「首次访问」，坏掉的功能长期伪装成正常状态。 */
    return UNAVAILABLE;
  }
}
