import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import { shanghaiDayOf } from "@/server/core/business-day";
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";
import { resolveDb, type AnyDb } from "@/server/core/svc";
import { ackResetOnRehit } from "@/server/rules/alert-ack";

/**
 * 预警引擎（D56/D57；研究采纳：去重键、责任角色、动作链接、参数快照、迟滞自动关闭、人工已知悉）。
 *
 * - 幂等：同 category + dedupeKey 只保留一条 open 告警；再次命中只更新 last_hit_at / title / detail / severity。
 * - 迟滞关闭：本轮未命中的 open 告警，若 last_hit_at 距今 ≥ autoCloseAfterDays（缺省 3）才自动关闭（autoResolved=true）；
 *   期间仍命中则续命。这样一天的数据缺口不会把告警关掉又打开。
 *   两个特例（W1 迁移各看门狗时按类别语义选择，不是可调参数）：
 *     autoCloseAfterDays=0    → 不再命中即刻无条件关闭（单据流转/任务恢复/凭据刷新/门禁恢复等硬事实，不是数据缺口）；
 *     autoCloseAfterDays=null → 永不自动关闭（某周期的数据质量不达标是已发生的周期事实，
 *                               下个周期不再命中不代表它被处理了，只能人工带原因关闭）。
 * - 已知悉：人工 ackAlert 只记 acked_by/acked_at，不改 status（事实闭环仍由引擎判定），写审计。
 *   再命中时按 rules/alert-ack 决定是否清知悉（严重度升级 / 知悉 ≥ 7 天仍命中）——审计 A3(2)。
 *   清知悉本身也是历史事实，必须落 alert_events(ack_reset, note=原因)，否则台账重建不出"谁的知悉被系统撤了"。
 * - 解释载荷（审计 #4）：候选可带 why[]（label/value/source），引擎原样落进 paramsSnapshot.why——
 *   与 sourceRule/paramsSnapshot 同行持久化，页面按自身授权展示；通知正文不带。
 * - **人工关闭抑制是引擎默认策略**（红队审计 A2 起从「按需 opt-in」改为「默认生效」）：
 *   同 dedupeKey 在 `suppressManuallyClosedDays`（缺省 DEFAULT_MANUAL_CLOSE_SUPPRESS_DAYS = 30）天内
 *   被人工关闭（autoResolved=false）的候选不重开，计入 suppressed。
 *   为什么改默认：此前只有 transfer_cost 一个看门狗传了这个参数，其余 8 个类别的人工关闭
 *   下一次 cron 就被推翻——用户点「误报 / 不处理」并写了原因，第二天原样复活；
 *   data_quality 这类「永不自动关闭、只能人工关」的类别整个设计都建立在人工关闭能生效上。
 *   关闭原因决定是否抑制（原因取该告警最后一条 alert_events(close) 的 reason_code）：
 *     false_positive / wont_fix / manual → **抑制**：人已经看过并作了「不必再报」的判断；
 *     fixed                              → **不抑制**：修好的条件如果重现，那是**新事实**，必须再报；
 *     superseded                         → 不抑制：说是被更新的告警接管，可同键仍在命中就说明没被接管，宁可再报；
 *     无 close 事件（历史行、直接改库）    → 抑制：保守按"人处理过"对待，与本参数引入时的行为一致。
 *   调用方可覆盖窗口（如 transfer_cost 用 180 天），传 0 或 null 则彻底关闭抑制。
 * - 系统告警属系统写入（沿用既有看门狗先例不写审计）；ackAlert 是业务写路径，必须 writeAudit。
 * - 事件台账（闭环审计 #2）：open / refresh(每上海日一条) / ack_reset / close(auto_hysteresis) 由引擎追加到 alert_events；
 *   ack / close(人工原因) 与审计同事务追加。台账只追加（触发器），幂等键防重复落账；引擎不因台账失败回滚告警状态以外的任何事。
 */
export interface AlertWhy {
  label: string;
  value: string;
  source: string;
}

export interface AlertCandidate {
  refKey: string;
  dedupeKey: string;
  title: string;
  detail?: string | null;
  severity: "high" | "medium" | "critical";
  ownerRole?: string | null;
  actionHref?: string | null;
  sourceRule?: string | null;
  paramsSnapshot?: Record<string, unknown> | null;
  /** 解释载荷：为什么触发（落 paramsSnapshot.why） */
  why?: AlertWhy[] | null;
}

export interface UpsertAlertsResult {
  opened: number;
  refreshed: number;
  autoClosed: number;
  stillOpen: number;
  /** 因人工关闭抑制而未开（仅 suppressManuallyClosedDays 生效时计） */
  suppressed: number;
  /** 再命中时清掉的已知悉数 */
  ackReset: number;
}

/** paramsSnapshot 与 why 合并：why 非空才写入 .why */
function snapshotWith(c: AlertCandidate): Record<string, unknown> | null {
  const base = c.paramsSnapshot ?? null;
  if (!c.why || !c.why.length) return base;
  return { ...(base ?? {}), why: c.why };
}

/** alert_events 追加行（幂等键唯一；重复键静默跳过——同一轮/同一日重复落账不是错误） */
export interface AlertEventInput {
  alertId: number;
  event: schema.AlertEventKind;
  at: Date;
  actorId?: number | null;
  reasonCode?: schema.AlertCloseReasonCode | null;
  note?: string | null;
  evidenceRef?: Record<string, unknown> | null;
  idempotencyKey: string;
}

/** 告警事件的幂等日键（上海日）；换算走 core/business-day 唯一权威 */
export function alertEventDay(d: Date): string {
  return shanghaiDayOf(d);
}

/** 追加告警事件（只追加表；ON CONFLICT (idempotency_key) DO NOTHING）。返回实际落账条数。 */
export async function appendAlertEvents(db: AnyDb, rows: readonly AlertEventInput[]): Promise<number> {
  if (!rows.length) return 0;
  const inserted: { id: number }[] = await db.insert(schema.alertEvents).values(rows.map((r) => ({
    alertId: r.alertId, event: r.event, at: r.at, actorId: r.actorId ?? null, reasonCode: r.reasonCode ?? null,
    note: r.note ?? null, evidenceRef: r.evidenceRef ?? null, idempotencyKey: r.idempotencyKey,
  }))).onConflictDoNothing({ target: schema.alertEvents.idempotencyKey }).returning({ id: schema.alertEvents.id });
  return inserted.length;
}

/**
 * 去重键形状与 refKey 一致（`<category>:<refKey>`）的类别白名单——**回填的唯一准入名单**。
 *
 * 红队审计 (d)：回填此前**无条件**按 `category:refKey` 拼键，而 inventory_cover 的真实键是
 * `inventory_cover:<skuId>`、sales_spike 的是 `sales_spike:sku:<skuId>` / `sales_spike:platform:<shop>|<psku>`。
 * 对这两个类别跑一次回填，会把历史行批量打上**永远不会被候选命中**的错键：
 * 既骗过 uq_alert_open_dedupe、又让人工关闭抑制按错键查找。因此白名单外的类别一律拒绝执行，
 * 除非调用方显式传入自己的 `buildKey`（形状由调用方负责，与其候选构造同源）。
 */
export const REF_KEY_DEDUPE_CATEGORIES: readonly string[] = [
  "data_freshness", "doc_aging", "integration_token", "job_failure",
  "data_product_gate", "data_quality", "transfer_cost", "snapshot_quality",
];

/**
 * 一次性回填历史行的 dedupe_key（引擎接入前的手写告警没有去重键）。
 *
 * 幂等：只动 dedupe_key IS NULL 且 ref_key 非空的行。
 * - open 行：同 ref_key 只补 id 最小的一条（uq_alert_open_dedupe 部分唯一索引不允许两条 open 同键；
 *   多余的 open 行留空键，交给引擎迟滞关闭），且目标键未被别的 open 行占用；
 * - 非 open 行：全部补（让人工关闭抑制 suppressManuallyClosedDays 对历史关闭也生效）。
 *
 * 键构造：缺省 `<category>:<refKey>`，且**只对 REF_KEY_DEDUPE_CATEGORIES 内的类别生效**；
 * 其他类别必须传 `opts.buildKey`（与该看门狗候选的 dedupeKey 同一份构造），否则抛错拒绝执行。
 * 返回本轮回填行数（open + 已关闭）。
 */
export async function backfillAlertDedupeKeys(
  dbArg: AnyDb,
  category: string,
  opts?: { buildKey?: (refKey: string) => string },
): Promise<number> {
  if (!opts?.buildKey && !REF_KEY_DEDUPE_CATEGORIES.includes(category)) {
    throw new Error(
      `拒绝回填 dedupe_key：类别 ${category} 的去重键形状不是 <category>:<refKey>，`
      + "请传入 opts.buildKey（与该看门狗候选同一份键构造），否则会把历史行批量打上错键",
    );
  }
  const buildKey = opts?.buildKey ?? ((refKey: string) => `${category}:${refKey}`);
  const db = await resolveDb(dbArg);
  const rows: { id: number; refKey: string | null; dedupeKey: string | null; status: string }[] = await db
    .select({
      id: schema.systemAlerts.id, refKey: schema.systemAlerts.refKey,
      dedupeKey: schema.systemAlerts.dedupeKey, status: schema.systemAlerts.status,
    })
    .from(schema.systemAlerts)
    .where(eq(schema.systemAlerts.category, category))
    .orderBy(schema.systemAlerts.id);

  // open 行同 ref_key 只补最早一条；已被别的 open 行占用的键不再抢（部分唯一索引不允许同键两条 open）
  const firstOpenIdByRefKey = new Map<string, number>();
  const takenOpenKeys = new Set<string>();
  for (const r of rows) {
    if (r.status !== "open") continue;
    if (r.dedupeKey) takenOpenKeys.add(r.dedupeKey);
    if (r.refKey && !firstOpenIdByRefKey.has(r.refKey)) firstOpenIdByRefKey.set(r.refKey, r.id);
  }

  let n = 0;
  for (const r of rows) {
    if (r.dedupeKey != null || !r.refKey) continue;
    const key = buildKey(r.refKey);
    if (r.status === "open") {
      if (firstOpenIdByRefKey.get(r.refKey) !== r.id) continue;
      if (takenOpenKeys.has(key)) continue;
      takenOpenKeys.add(key);
    }
    await db.update(schema.systemAlerts).set({ dedupeKey: key }).where(eq(schema.systemAlerts.id, r.id));
    n++;
  }
  return n;
}

/** 人工关闭抑制的缺省窗口（天）——引擎默认策略，调用方可覆盖或传 0/null 关闭 */
export const DEFAULT_MANUAL_CLOSE_SUPPRESS_DAYS = 30;

/** 这些关闭原因**不**抑制重开：条件重现是新事实（fixed）/ 声称被接管但同键仍在命中（superseded） */
export const NON_SUPPRESSING_CLOSE_REASONS: ReadonlySet<string> = new Set(["fixed", "superseded"]);

/** 迟滞自动关闭的台账说明——按本类别的实际策略写，不再对 autoCloseAfterDays=0 谎称"连续 0 天未命中" */
export function autoCloseNote(autoCloseAfterDays: number | null | undefined): string {
  const days = autoCloseAfterDays ?? 3;
  return days <= 0
    ? "本轮不再命中，引擎即刻关闭（该类别为硬事实，无迟滞）"
    : `连续 ${days} 天未命中，引擎迟滞关闭`;
}

export async function upsertAlerts(
  dbArg: AnyDb,
  input: {
    category: string;
    candidates: AlertCandidate[];
    now?: Date;
    /**
     * 迟滞天数：本轮未命中的 open 告警，last_hit_at 距今 ≥ 本值才自动关闭（缺省 3）。
     * - 0 = 条件一清就关（硬事实类：单据流转、任务恢复、凭据刷新、门禁恢复）；
     * - null = **永不自动关闭**（周期性事实类：某周期的数据质量不达标是已发生的事实，
     *   下个周期不再命中不等于它被处理了——只能由人工带原因关闭）。
     */
    autoCloseAfterDays?: number | null;
    /** 提供时仅这些对象有本轮否定证据；空数组不自动关任何项。缺省保留其他类别的既有行为。 */
    autoCloseEligibleKeys?: readonly string[];
    /** Pure comparison with the same open snapshot used by the timestamp CAS; no extra write/read race. */
    autoClosePredicate?: (previous: { dedupeKey: string | null; paramsSnapshot: Record<string, unknown> | null }) => boolean;
    /**
     * 同 dedupeKey 在 N 天内被人工关闭（autoResolved=false，且关闭原因不是 fixed）则不重开。
     * **缺省 DEFAULT_MANUAL_CLOSE_SUPPRESS_DAYS（30 天）——抑制是引擎默认行为**；
     * 传 0 或 null 显式关闭抑制（只有"人工关闭本就不该黏住"的类别才这么做）。
     */
    suppressManuallyClosedDays?: number | null;
    /** 已知悉再命中多少天后清知悉（rules/alert-ack，缺省 7） */
    ackResetAfterDays?: number;
  },
): Promise<UpsertAlertsResult> {
  const db = await resolveDb(dbArg);
  const now = input.now ?? new Date();
  const neverAutoClose = input.autoCloseAfterDays === null;
  const closeAfterMs = (input.autoCloseAfterDays ?? 3) * 24 * 60 * 60 * 1000;
  const open: { id: number; dedupeKey: string | null; lastHitAt: Date | null; lastHitAtVersion: string | null; createdAt: Date; severity: string | null; ackedAt: Date | null; paramsSnapshot: Record<string, unknown> | null }[] = await db
    .select({
      id: schema.systemAlerts.id, dedupeKey: schema.systemAlerts.dedupeKey, lastHitAt: schema.systemAlerts.lastHitAt,
      // Date只保留毫秒；历史SQL写入可能有微秒，CAS保留数据库原始精度。
      lastHitAtVersion: sql<string | null>`${schema.systemAlerts.lastHitAt}::text`,
      createdAt: schema.systemAlerts.createdAt, severity: schema.systemAlerts.severity, ackedAt: schema.systemAlerts.ackedAt,
      paramsSnapshot: schema.systemAlerts.paramsSnapshot,
    })
    .from(schema.systemAlerts)
    .where(and(eq(schema.systemAlerts.category, input.category), eq(schema.systemAlerts.status, "open")));
  const openByKey = new Map(open.filter((o) => o.dedupeKey).map((o) => [o.dedupeKey as string, o]));

  // 人工关闭抑制（默认生效）：窗口内被人关掉的同键不重开，除非关闭原因是 fixed（修好的条件重现是新事实）
  const suppressDays = input.suppressManuallyClosedDays ?? DEFAULT_MANUAL_CLOSE_SUPPRESS_DAYS;
  const manuallyClosed = new Set<string>();
  if (suppressDays > 0) {
    const since = new Date(now.getTime() - suppressDays * 24 * 60 * 60 * 1000);
    const rows: { id: number; dedupeKey: string | null }[] = await db
      .select({ id: schema.systemAlerts.id, dedupeKey: schema.systemAlerts.dedupeKey })
      .from(schema.systemAlerts)
      .where(and(
        eq(schema.systemAlerts.category, input.category), eq(schema.systemAlerts.status, "resolved"),
        eq(schema.systemAlerts.autoResolved, false), sql`${schema.systemAlerts.resolvedAt} >= ${since.toISOString()}::timestamptz`,
      ));
    const keyed = rows.filter((r) => r.dedupeKey);
    if (keyed.length) {
      // 关闭原因取该告警最后一条 close 事件；查不到（历史行/直接改库）按"抑制"保守处理
      const reasons = new Map<number, string | null>();
      const closes: { alertId: number; reasonCode: string | null }[] = await db
        .select({ alertId: schema.alertEvents.alertId, reasonCode: schema.alertEvents.reasonCode })
        .from(schema.alertEvents)
        .where(and(eq(schema.alertEvents.event, "close"), inArray(schema.alertEvents.alertId, keyed.map((r) => r.id))))
        .orderBy(schema.alertEvents.id);
      for (const c of closes) reasons.set(c.alertId, c.reasonCode);
      for (const r of keyed) {
        if (!NON_SUPPRESSING_CLOSE_REASONS.has(reasons.get(r.id) ?? "")) manuallyClosed.add(r.dedupeKey as string);
      }
    }
  }

  let opened = 0, refreshed = 0, suppressed = 0, ackReset = 0;
  const hitKeys = new Set<string>();
  const events: AlertEventInput[] = [];
  const day = alertEventDay(now);
  for (const c of input.candidates) {
    if (hitKeys.has(c.dedupeKey)) continue; // 同一轮内重复候选只算一次
    hitKeys.add(c.dedupeKey);
    const existing = openByKey.get(c.dedupeKey);
    if (existing) {
      const ack = ackResetOnRehit({ ackedAt: existing.ackedAt, prevSeverity: existing.severity, nextSeverity: c.severity, now, resetAfterDays: input.ackResetAfterDays });
      // status='open' 守卫（红队 A5）：与自动关闭同一条纪律——本轮开跑后落地的人工关闭不得被刷新覆盖
      const [touched]: { id: number }[] = await db.update(schema.systemAlerts).set({
        title: c.title, detail: c.detail ?? null, severity: c.severity, ownerRole: c.ownerRole ?? null,
        actionHref: c.actionHref ?? null, sourceRule: c.sourceRule ?? null, paramsSnapshot: snapshotWith(c), lastHitAt: now,
        ...(ack.reset ? { ackedAt: null, ackedBy: null } : {}),
      }).where(and(eq(schema.systemAlerts.id, existing.id), eq(schema.systemAlerts.status, "open")))
        .returning({ id: schema.systemAlerts.id });
      if (!touched) continue; // 中途被人工关闭：不计刷新、不落刷新事件（下一轮按新事实重开或被抑制）
      refreshed++;
      events.push({ alertId: existing.id, event: "refresh", at: now, idempotencyKey: `${existing.id}:refresh:${day}` });
      if (ack.reset) {
        ackReset++;
        events.push({
          alertId: existing.id, event: "ack_reset", at: now, actorId: null,
          note: ack.reason === "severity_up"
            ? `严重度升级（${existing.severity ?? "—"} → ${c.severity}），系统清除已知悉`
            : `已知悉后仍持续命中 ≥ ${input.ackResetAfterDays ?? 7} 天，系统清除已知悉`,
          evidenceRef: {
            reason: ack.reason, prevSeverity: existing.severity, nextSeverity: c.severity,
            ackedAt: existing.ackedAt ? new Date(existing.ackedAt).toISOString() : null,
          },
          idempotencyKey: `${existing.id}:ack_reset:${day}`,
        });
      }
    } else {
      if (manuallyClosed.has(c.dedupeKey)) { suppressed++; continue; } // 人工已处理，窗口内不重开
      // 部分唯一索引 uq_alert_open_dedupe(category, dedupe_key) WHERE status='open'：
      // 与另一并发运行撞上时不插入（对方已开同键告警），按"已刷新"计数而不是双开。
      const ins: { id: number }[] = await db.insert(schema.systemAlerts).values({
        category: input.category, refKey: c.refKey, dedupeKey: c.dedupeKey, title: c.title, detail: c.detail ?? null,
        severity: c.severity, ownerRole: c.ownerRole ?? null, actionHref: c.actionHref ?? null, sourceRule: c.sourceRule ?? null,
        paramsSnapshot: snapshotWith(c), lastHitAt: now,
      }).onConflictDoNothing({ target: [schema.systemAlerts.category, schema.systemAlerts.dedupeKey], where: sql`${schema.systemAlerts.status} = 'open'` })
        .returning({ id: schema.systemAlerts.id });
      if (ins.length) {
        opened++;
        events.push({ alertId: ins[0].id, event: "open", at: now, idempotencyKey: `${ins[0].id}:open` });
      } else {
        refreshed++; // 并发对方已开同键告警：本轮不知其 id，事件由对方那轮落账
      }
    }
  }

  // 迟滞自动关闭（autoCloseAfterDays=null 的类别不自动关闭，只能人工带原因关闭）
  const closeEligible = input.autoCloseEligibleKeys === undefined ? null : new Set(input.autoCloseEligibleKeys);
  const toClose = (neverAutoClose ? [] : open)
    .filter((o) => closeEligible === null || (o.dedupeKey != null && closeEligible.has(o.dedupeKey)))
    .filter((o) => input.autoClosePredicate?.(o) ?? true)
    .filter((o) => !o.dedupeKey || !hitKeys.has(o.dedupeKey))
    // closeAfterMs=0 是"不再命中即刻关闭"：无条件关，不比时间——
    // 否则两次运行的 now 一旦不单调（补跑、时钟回拨、测试注入的历史时刻），
    // 已消失的条件会被判成"还没到迟滞时间"而永远关不掉。
    .filter((o) => closeAfterMs <= 0 || now.getTime() - new Date(o.lastHitAt ?? o.createdAt).getTime() >= closeAfterMs);
  /* status='open' 守卫 + RETURNING（红队 A5）：本轮开跑后落地的**人工关闭**不得被自动关闭覆盖——
     覆盖会把 autoResolved 翻成 true，于是人工关闭抑制失效、待办从严口径分母里溜走、
     台账再多写一条 close。只对真正被本次 UPDATE 改到的行落 close 事件。 */
  let autoClosed = 0;
  if (toClose.length) {
    const closed: { id: number }[] = await db.update(schema.systemAlerts)
      .set({ status: "resolved", autoResolved: true, resolvedAt: now })
      // 乐观并发核对：读完open快照后，另一轮看门狗若再次命中，旧评估不得将其关闭。
      // 每个id和自己的last_hit_at成对核对；不能只用一条最早/最晚时间线批量比较。
      // NULL历史值也使用IS NOT DISTINCT FROM，保留原本无last_hit_at的正常关闭能力。
      .where(and(eq(schema.systemAlerts.status, "open"), or(...toClose.map((o) => and(
        eq(schema.systemAlerts.id, o.id),
        sql`${schema.systemAlerts.lastHitAt} IS NOT DISTINCT FROM ${o.lastHitAtVersion}::timestamptz`,
      )))))
      .returning({ id: schema.systemAlerts.id });
    autoClosed = closed.length;
    for (const r of closed) {
      events.push({
        alertId: r.id, event: "close", at: now, reasonCode: "auto_hysteresis",
        note: autoCloseNote(input.autoCloseAfterDays),
        idempotencyKey: `${r.id}:close`,
      });
    }
  }
  await appendAlertEvents(db, events);
  const [still] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.systemAlerts)
    .where(and(eq(schema.systemAlerts.category, input.category), eq(schema.systemAlerts.status, "open")));
  return { opened, refreshed, autoClosed, stillOpen: Number(still?.n ?? 0), suppressed, ackReset };
}

/**
 * 人工「已知悉」：写 acked_by/acked_at + 审计；status 不变（事实闭环归引擎）。
 *
 * 权限（安全审计 S2）：与 closeAlert **同一口径**——告警 ownerRole 对应角色或 admin；
 * ownerRole 为空的历史告警只允许 admin。
 * 之前这里只校验 id/存在/未关闭，任何登录用户都能把全部类别的告警一次性"知悉"掉：
 * 知悉不改 status，但会清掉「未知悉」这个唯一的人工注意力信号，并让 ackResetAfterDays（缺省 7 天）
 * 内的再命中都不再刷新提醒——等于替责任角色把警报静音，且审计只留下"某人知悉"看不出越权。
 */
export async function ackAlert(actor: SessionUser, alertId: number, dbArg?: AnyDb, note?: string): Promise<{ id: number; ackedAt: string }> {
  const db = await resolveDb(dbArg);
  if (!Number.isInteger(alertId) || alertId <= 0) throw new ApiError(400, "告警 id 非法");
  return db.transaction(async (tx: AnyDb) => {
    // Serialize against another acknowledgement, manual close or engine update.
    // Event-key deduplication alone does not protect the state or audit receipt.
    const [row] = await tx.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.id, alertId)).limit(1).for("update");
    if (!row) throw new ApiError(404, "告警不存在");
    const isAdmin = actor.roles.includes("admin");
    const isOwner = row.ownerRole != null && actor.roles.includes(row.ownerRole);
    if (!isAdmin && !isOwner) throw new ApiError(403, `无权限知悉此告警：需要 ${row.ownerRole ?? "admin"} 角色`);
    if (row.status !== "open") throw new ApiError(409, "告警已关闭，无需知悉");
    // A retry is not a new acknowledgement and must not restart the suppression
    // clock or replace its original actor. Only the engine's reset permits a new one.
    if (row.ackedAt) return { id: alertId, ackedAt: row.ackedAt.toISOString() };
    // The row lock serializes acknowledgement generations. A real reset (including
    // same-day severity escalation) permits a new fact, linked to the last immutable
    // ack event; an ordinary retry returned above and cannot consume a generation.
    const [previousAck] = await tx.select({ id: schema.alertEvents.id }).from(schema.alertEvents)
      .where(and(eq(schema.alertEvents.alertId, alertId), eq(schema.alertEvents.event, "ack")))
      .orderBy(desc(schema.alertEvents.id)).limit(1);
    const now = new Date();
    await tx.update(schema.systemAlerts).set({ ackedBy: actor.id, ackedAt: now }).where(eq(schema.systemAlerts.id, alertId));
    await writeAudit(tx, {
      userId: actor.id, entity: "system_alert", entityId: alertId, action: "ack",
      before: { ackedBy: row.ackedBy, ackedAt: row.ackedAt }, after: { ackedBy: actor.id, ackedAt: now.toISOString(), note: note ?? null },
    });
    // Preserve the historical first-ack key; subsequent genuine acknowledgements
    // use the preceding fact's ID, not a random/request timestamp or daily dedupe.
    const ackKey = `${alertId}:ack:${alertEventDay(now)}${previousAck ? `:after:${previousAck.id}` : ""}`;
    await appendAlertEvents(tx, [{
      alertId, event: "ack", at: now, actorId: actor.id, note: note ?? null, idempotencyKey: ackKey,
    }]);
    return { id: alertId, ackedAt: now.toISOString() };
  });
}

export type ManualCloseReasonCode = (typeof schema.MANUAL_CLOSE_REASON_CODES)[number];

/**
 * 人工关闭告警（闭环审计 #2）：status→resolved、autoResolved=false、resolvedAt=now；
 * 同事务写审计（action=close）与 alert_events(close, reason_code)。
 * 权限：告警 ownerRole 对应角色或 admin（ownerRole 为空的历史告警只允许 admin）。
 * reasonCode 只接受人工原因（fixed / false_positive / wont_fix / superseded / manual）；auto_hysteresis 保留给引擎。
 * 关闭不删除告警、不阻止引擎下轮再次开新告警（同键新开是新事实，不是 reopen）。
 */
export async function closeAlert(
  actor: SessionUser,
  alertId: number,
  reasonCode: string,
  note?: string | null,
  dbArg?: AnyDb,
  opts?: { now?: Date },
): Promise<{ id: number; resolvedAt: string; reasonCode: ManualCloseReasonCode }> {
  const db = await resolveDb(dbArg);
  if (!Number.isInteger(alertId) || alertId <= 0) throw new ApiError(400, "告警 id 非法");
  if (!(schema.MANUAL_CLOSE_REASON_CODES as readonly string[]).includes(reasonCode)) {
    throw new ApiError(400, `关闭原因非法：只接受 ${schema.MANUAL_CLOSE_REASON_CODES.join(" / ")}`);
  }
  const reason = reasonCode as ManualCloseReasonCode;
  const trimmedNote = typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null;
  return db.transaction(async (tx: AnyDb) => {
    const [row] = await tx.select().from(schema.systemAlerts).where(eq(schema.systemAlerts.id, alertId)).limit(1).for("update");
    if (!row) throw new ApiError(404, "告警不存在");
    const isAdmin = actor.roles.includes("admin");
    const isOwner = row.ownerRole != null && actor.roles.includes(row.ownerRole);
    if (!isAdmin && !isOwner) throw new ApiError(403, `无权限关闭此告警：需要 ${row.ownerRole ?? "admin"} 角色`);
    if (row.status !== "open") throw new ApiError(409, "告警已关闭");
    if (reason === "manual" && !trimmedNote) throw new ApiError(400, "选择「其他（人工）」时请在备注说明原因");
    const now = opts?.now ?? new Date();
    await tx.update(schema.systemAlerts).set({ status: "resolved", autoResolved: false, resolvedAt: now })
      .where(and(eq(schema.systemAlerts.id, alertId), eq(schema.systemAlerts.status, "open")));
    await writeAudit(tx, {
      userId: actor.id, entity: "system_alert", entityId: alertId, action: "close",
      before: { status: row.status, autoResolved: row.autoResolved, resolvedAt: row.resolvedAt },
      after: { status: "resolved", autoResolved: false, resolvedAt: now.toISOString(), reasonCode: reason, note: trimmedNote },
    });
    /* 行锁后的 status 检查保证只有一位关闭者写状态、审计及事件；
       所以 `${alertId}:close` 就是它的自然键——重放同一次关闭不会再落一条。 */
    await appendAlertEvents(tx, [{
      alertId, event: "close", at: now, actorId: actor.id, reasonCode: reason, note: trimmedNote,
      idempotencyKey: `${alertId}:close`,
    }]);
    return { id: alertId, resolvedAt: now.toISOString(), reasonCode: reason };
  });
}

/** 计数：open 且（可选）未知悉 */
export async function countOpenAlerts(dbArg: AnyDb, category: string): Promise<{ open: number; unacked: number }> {
  const db = await resolveDb(dbArg);
  const [row] = await db.select({
    open: sql<number>`count(*)::int`,
    unacked: sql<number>`count(*) filter (where ${schema.systemAlerts.ackedAt} is null)::int`,
  }).from(schema.systemAlerts).where(and(eq(schema.systemAlerts.category, category), eq(schema.systemAlerts.status, "open")));
  return { open: Number(row?.open ?? 0), unacked: Number(row?.unacked ?? 0) };
}
