/**
 * NPD 1.x 项目跟踪（D19 激活，spec/13 §三 D——轻量：非单据流，无审批）。
 *
 * - 模板 = transit_refs kind=npd_node（69 节点标准，只读底稿）；
 * - 建项目即按 rules/npd-schedule.ts 拓扑实例化任务计划（自然日）；
 * - 任务状态 pending/doing/done/skipped 人工推进；done 记 doneAt（默认当日 Asia/Shanghai）；
 * - 写路径：pmc/ops（admin 兜底），writeAudit 全覆盖；项目完成/取消仅改状态（无删除）。
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { scheduleNpd, type NpdTemplateNode } from "@/server/rules/npd-schedule";
import { createBh } from "@/server/modules/outsource/bh";
import { createBhSchema } from "@/server/modules/outsource/schemas";
import { dQty } from "@/server/core/decimal";
import { shanghaiDay } from "@/server/core/business-day";
import { bhReadScope } from "@/server/core/bh-read-scope";
import { resolveAlias } from "@/server/modules/dimension/resolver";
import { resolveDb } from "@/server/core/svc";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;


const DAY_MS = 86_400_000;
const versionSchema = z.number().int().positive().max(2_147_483_646);
const projectDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式须为 YYYY-MM-DD")
  .refine(value => !value.startsWith("0000-") && shanghaiDay(value) === value, "日期不存在");
type Project = typeof schema.npdProjects.$inferSelect;

/** Every NPD mutation locks the aggregate before reading mutable node/project state. */
async function lockProject(tx: AnyDb, id: number): Promise<Project> {
  const [project] = await tx.select().from(schema.npdProjects).where(eq(schema.npdProjects.id, id)).for("update");
  if (!project) throw new ApiError(404, "项目不存在");
  return project;
}

function assertWritable(project: Project, version: number, active = true) {
  if (project.version !== version) throw new ApiError(409, "项目已被更新，请刷新核对后再操作；未覆盖新状态");
  if (active && project.status !== "active") throw new ApiError(409, "项目已关闭，请先明确恢复为进行中再操作");
}

async function bumpVersion(tx: AnyDb, project: Project) {
  const version = project.version + 1;
  await tx.update(schema.npdProjects).set({ version, updatedAt: new Date() }).where(eq(schema.npdProjects.id, project.id));
  return version;
}
/** 自然日推算（与 rules/npd-schedule 同口径，UTC 基准避免时区漂移） */
function addDays(ymd: string, days: number): string {
  const at = new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS);
  const value = Number.isFinite(at.getTime()) ? at.toISOString().slice(0, 10) : "";
  if (!projectDateSchema.safeParse(value).success) throw new ApiError(400, "排期超出支持的日期范围，请核对节点天数和启动日");
  return value;
}

/**
 * SKU 编码 → skuId 的系统统一解析（alias-first，复用 dimension/resolver）：
 * 先按 skus.code 精确命中；未命中再走 aliases(sku_code) 别名解析——与导入管道/放行引擎同口径。
 * 命中返回规范档案 { id, code }；确实未建档且无别名返回 null。
 */
async function resolveSkuByCodeOrAlias(db: AnyDb, rawCode: string): Promise<{ id: number; code: string } | null> {
  const raw = rawCode.trim();
  if (!raw) return null;
  const [exact] = await db
    .select({ id: schema.skus.id, code: schema.skus.code })
    .from(schema.skus)
    .where(eq(schema.skus.code, raw));
  if (exact) return exact;
  const skuId = await resolveAlias(db, "sku_code", raw);
  if (skuId != null) {
    const [row] = await db
      .select({ id: schema.skus.id, code: schema.skus.code })
      .from(schema.skus)
      .where(eq(schema.skus.id, skuId));
    if (row) return row;
  }
  return null;
}

/** 模板节点读取（transit_refs kind=npd_node → NpdTemplateNode） */
export async function loadNpdTemplate(dbArg?: AnyDb): Promise<NpdTemplateNode[]> {
  const db = await resolveDb(dbArg);
  const t = schema.transitRefs;
  const rows: { approvalNo: string | null; materialName: string | null; orderType: string | null; follower: string | null; qty: string | null; extra: unknown }[] =
    await db
      .select({ approvalNo: t.approvalNo, materialName: t.materialName, orderType: t.orderType, follower: t.follower, qty: t.qty, extra: t.extra })
      .from(t)
      .where(eq(t.kind, "npd_node"))
      .orderBy(asc(t.id));
  return rows
    .filter((r) => r.materialName)
    .map((r) => ({
      nodeNo: r.approvalNo,
      name: r.materialName!,
      stage: r.orderType,
      dept: r.follower,
      days: r.qty == null ? 0 : Math.max(0, Math.round(Number(r.qty))),
      prev: ((r.extra as Record<string, unknown> | null)?.上一节点 as string | null) ?? null,
    }));
}

export const createNpdProjectSchema = z.object({
  name: z.string().trim().min(2, "项目名称至少 2 字").max(120),
  skuCode: z.string().trim().max(60).optional(),
  brand: z.string().trim().max(60).optional(),
  startDate: projectDateSchema,
  remark: z.string().trim().max(500).optional(),
});

export async function createNpdProject(user: SessionUser, input: unknown, dbArg?: AnyDb) {
  requireAnyRole(user, "pmc", "ops");
  const v = createNpdProjectSchema.parse(input);
  const db = await resolveDb(dbArg);
  let canonicalSkuCode: string | null = null;
  if (v.skuCode?.trim()) {
    const hit = await resolveSkuByCodeOrAlias(db, v.skuCode);
    if (!hit) throw new ApiError(400, `目标 SKU「${v.skuCode.trim()}」未建档或无此别名——请先建档/认领别名或留空后补`);
    canonicalSkuCode = hit.code; // 存规范编码，别名统一收敛
  }
  const template = await loadNpdTemplate(db);
  if (template.length === 0) throw new ApiError(400, "NPD 节点模板为空（transit_refs kind=npd_node）——请先导入各节点核心说明");
  let tasks: ReturnType<typeof scheduleNpd>;
  try {
    tasks = scheduleNpd(template, v.startDate);
  } catch (error) {
    if (error instanceof RangeError) throw new ApiError(400, "排期超出支持的日期范围，请核对节点天数和启动日");
    throw error;
  }
  if (tasks.some(task => !projectDateSchema.safeParse(task.planStart).success || !projectDateSchema.safeParse(task.planEnd).success)) {
    throw new ApiError(400, "排期超出支持的日期范围，请核对节点天数和启动日");
  }

  return db.transaction(async (tx: AnyDb) => {
    const [proj] = await tx
      .insert(schema.npdProjects)
      .values({
        name: v.name,
        skuCode: canonicalSkuCode,
        brand: v.brand?.trim() || null,
        startDate: v.startDate,
        remark: v.remark?.trim() || null,
        createdBy: user.id,
      })
      .returning();
    await tx.insert(schema.npdTasks).values(
      tasks.map((t) => ({
        projectId: proj.id,
        seq: t.seq,
        nodeNo: t.nodeNo,
        name: t.name,
        stage: t.stage,
        dept: t.dept,
        days: t.days,
        planStart: t.planStart,
        planEnd: t.planEnd,
      })),
    );
    await writeAudit(tx, {
      userId: user.id,
      entity: "npd_project",
      entityId: proj.id,
      action: "create",
      after: { name: v.name, startDate: v.startDate, taskCount: tasks.length },
    });
    // #4：与列表页同口径 = max(planEnd)
    const planEnd = tasks.reduce((m, t) => (t.planEnd > m ? t.planEnd : m), v.startDate);
    return { id: proj.id, taskCount: tasks.length, planEnd };
  });
}

export async function listNpdProjects(dbArg?: AnyDb) {
  const db = await resolveDb(dbArg);
  const p = schema.npdProjects;
  const t = schema.npdTasks;
  const today = todayShanghai();
  const projects = await db.select().from(p).orderBy(desc(p.id));
  const tasks: { projectId: number; status: string; planEnd: string | null }[] = await db
    .select({ projectId: t.projectId, status: t.status, planEnd: t.planEnd })
    .from(t);
  const agg = new Map<number, { total: number; done: number; planEnd: string | null; overdue: number }>();
  for (const row of tasks) {
    const cur = agg.get(row.projectId) ?? { total: 0, done: 0, planEnd: null, overdue: 0 };
    cur.total++;
    if (row.status === "done" || row.status === "skipped") cur.done++;
    else if (row.planEnd && row.planEnd < today) cur.overdue++; // 未完成且计划完成日已过
    if (row.planEnd && (cur.planEnd == null || row.planEnd > cur.planEnd)) cur.planEnd = row.planEnd;
    agg.set(row.projectId, cur);
  }
  return projects.map((proj: typeof schema.npdProjects.$inferSelect) => ({
    ...proj,
    taskTotal: agg.get(proj.id)?.total ?? 0,
    taskDone: agg.get(proj.id)?.done ?? 0,
    planEnd: agg.get(proj.id)?.planEnd ?? null,
    overdueTasks: agg.get(proj.id)?.overdue ?? 0,
  }));
}

export async function getNpdProject(id: number, dbArg?: AnyDb, user?: SessionUser) {
  const db = await resolveDb(dbArg);
  // Keep version, nodes and receipts in one read snapshot without blocking project writers.
  return db.transaction(async (db: AnyDb) => {
    const [project] = await db.select().from(schema.npdProjects).where(eq(schema.npdProjects.id, id));
    if (!project) throw new ApiError(404, "项目不存在");
    const today = todayShanghai();
    const rawTasks = await db
      .select()
      .from(schema.npdTasks)
      .where(eq(schema.npdTasks.projectId, id))
      .orderBy(asc(schema.npdTasks.seq));
    const tasks = rawTasks.map((t: typeof schema.npdTasks.$inferSelect) => ({
      ...t,
      overdue: t.status !== "done" && t.status !== "skipped" && t.planEnd != null && t.planEnd < today,
    }));
    // No actor means no BH history. Never let an omitted identity imply unrestricted disclosure.
    const firstOrders = user ? await db.select({
      id: schema.bhDocs.id, docNo: schema.bhDocs.docNo, status: schema.bhDocs.status,
      skuCode: schema.skus.code, baseUom: schema.skus.baseUom, qty: schema.npdFirstOrders.qty, createdAt: schema.npdFirstOrders.createdAt,
    }).from(schema.npdFirstOrders)
      .innerJoin(schema.bhDocs, eq(schema.bhDocs.id, schema.npdFirstOrders.bhId))
      .innerJoin(schema.skus, eq(schema.skus.id, schema.npdFirstOrders.skuId))
      .where(and(eq(schema.npdFirstOrders.projectId, id), bhReadScope(db, user)))
      .orderBy(desc(schema.npdFirstOrders.id)).limit(20) : [];
    return { project, tasks, firstOrders };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export const updateNpdTaskSchema = z.object({
  taskId: z.number().int().positive(),
  version: versionSchema,
  status: z.enum(["pending", "doing", "done", "skipped"]),
  note: z.string().trim().max(300).optional(),
});

export async function updateNpdTask(user: SessionUser, input: unknown, dbArg?: AnyDb) {
  requireAnyRole(user, "pmc", "ops");
  const v = updateNpdTaskSchema.parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const [target] = await tx.select({ projectId: schema.npdTasks.projectId }).from(schema.npdTasks).where(eq(schema.npdTasks.id, v.taskId));
    if (!target) throw new ApiError(404, "任务不存在");
    const project = await lockProject(tx, target.projectId);
    assertWritable(project, v.version);
    const [task] = await tx.select().from(schema.npdTasks).where(eq(schema.npdTasks.id, v.taskId));
    if (!task) throw new ApiError(404, "任务不存在");
    const doneAt = v.status === "done" ? task.status === "done" ? task.doneAt : todayShanghai() : null;
    const note = v.note === undefined ? task.note : v.note || null;
    if (task.status === v.status && task.note === note && task.doneAt === doneAt) return { ok: true, version: project.version };
    await tx
      .update(schema.npdTasks)
      .set({ status: v.status, doneAt, note, updatedAt: new Date() })
      .where(eq(schema.npdTasks.id, v.taskId));
    const version = await bumpVersion(tx, project);
    await writeAudit(tx, {
      userId: user.id,
      entity: "npd_task",
      entityId: v.taskId,
      action: "update_status",
      before: { status: task.status, doneAt: task.doneAt, note: task.note, projectVersion: project.version },
      after: { status: v.status, doneAt, note, projectVersion: version },
    });
    return { ok: true, version };
  });
}

export const updateNpdProjectSchema = z.object({
  projectId: z.number().int().positive(),
  version: versionSchema,
  status: z.enum(["active", "done", "cancelled"]),
});

export async function updateNpdProject(user: SessionUser, input: unknown, dbArg?: AnyDb) {
  requireAnyRole(user, "pmc", "ops");
  const v = updateNpdProjectSchema.parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const proj = await lockProject(tx, v.projectId);
    assertWritable(proj, v.version, false);
    if (proj.status === v.status) return { ok: true, version: proj.version };
    await tx
      .update(schema.npdProjects)
      .set({ status: v.status, updatedAt: new Date() })
      .where(eq(schema.npdProjects.id, v.projectId));
    const version = await bumpVersion(tx, proj);
    await writeAudit(tx, {
      userId: user.id,
      entity: "npd_project",
      entityId: v.projectId,
      action: "update_status",
      before: { status: proj.status, version: proj.version },
      after: { status: v.status, version },
    });
    return { ok: true, version };
  });
}

export const setNpdSkuCodeSchema = z.object({
  projectId: z.number().int().positive(),
  version: versionSchema,
  skuCode: z.string().trim().min(1, "目标 SKU 不能为空").max(60),
});

/** #18：项目目标 SKU 补录（可后补承诺兑现）——alias-first 解析，收敛为规范编码后写回，writeAudit */
export async function updateNpdProjectSkuCode(user: SessionUser, input: unknown, dbArg?: AnyDb) {
  requireAnyRole(user, "pmc", "ops");
  const v = setNpdSkuCodeSchema.parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const proj = await lockProject(tx, v.projectId);
    assertWritable(proj, v.version);
    const hit = await resolveSkuByCodeOrAlias(tx, v.skuCode);
    if (!hit) throw new ApiError(400, `目标 SKU「${v.skuCode}」未建档或无此别名——请先建档/认领别名`);
    if (proj.skuCode === hit.code) return { ok: true, skuCode: hit.code, version: proj.version };
    await tx
      .update(schema.npdProjects)
      .set({ skuCode: hit.code, updatedAt: new Date() })
      .where(eq(schema.npdProjects.id, v.projectId));
    const version = await bumpVersion(tx, proj);
    await writeAudit(tx, {
      userId: user.id,
      entity: "npd_project",
      entityId: v.projectId,
      action: "set_sku_code",
      before: { skuCode: proj.skuCode, version: proj.version },
      after: { skuCode: hit.code, version },
    });
    return { ok: true, skuCode: hit.code, version };
  });
}

export const rescheduleNpdSchema = z.object({
  projectId: z.number().int().positive(),
  version: versionSchema,
});

/**
 * #19：计划重排（完成早/晚推移后继）——按 seq 前向重算 planStart/planEnd（确定性，todayShanghai 锚今天）：
 * - 游标 = 上一任务 planEnd（起点=项目启动日）；
 * - 未完成（pending/doing）任务若排到过去，则顶到今天（不排在过去）；
 * - 已完成任务以实际 doneAt 收尾（后继据实衔接）；跳过任务视为零工期直通。
 */
export async function rescheduleNpd(user: SessionUser, input: unknown, dbArg?: AnyDb) {
  requireAnyRole(user, "pmc", "ops");
  const v = rescheduleNpdSchema.parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const proj = await lockProject(tx, v.projectId);
    assertWritable(proj, v.version);
    const tasks: (typeof schema.npdTasks.$inferSelect)[] = await tx
      .select()
      .from(schema.npdTasks)
      .where(eq(schema.npdTasks.projectId, v.projectId))
      .orderBy(asc(schema.npdTasks.seq));
    const today = todayShanghai();
    let cursor = proj.startDate; // 前向游标（上一任务 planEnd）
    const updates: { id: number; planStart: string; planEnd: string }[] = [];
    for (const t of tasks) {
      let start = cursor;
      let end: string;
      if (t.status === "skipped") {
        end = start; // 零工期直通，不推移后继
      } else if (t.status === "done") {
        const at = t.doneAt ?? addDays(start, t.days); // 据实收尾
        if (at < start) start = at; // 避免窗口反向
        end = at;
      } else {
        if (start < today) start = today; // 未完成任务不排在过去
        end = addDays(start, t.days);
      }
      cursor = end;
      if (start !== t.planStart || end !== t.planEnd) updates.push({ id: t.id, planStart: start, planEnd: end });
    }
    if (!updates.length) return { ok: true, changed: 0, planEnd: cursor, version: proj.version };
    for (const u of updates) {
      await tx
        .update(schema.npdTasks)
        .set({ planStart: u.planStart, planEnd: u.planEnd, updatedAt: new Date() })
        .where(eq(schema.npdTasks.id, u.id));
    }
    const version = await bumpVersion(tx, proj);
    await writeAudit(tx, {
      userId: user.id,
      entity: "npd_project",
      entityId: v.projectId,
      action: "reschedule",
      before: { version: proj.version },
      after: { changed: updates.length, planEnd: cursor, version },
    });
    return { ok: true, changed: updates.length, planEnd: cursor, version };
  });
}

export const npdFirstOrderSchema = z.object({
  projectId: z.number().int().positive(),
  version: versionSchema,
  requestKey: z.string().uuid("请保留原请求标识重试，或刷新后明确发起新需求").transform(value => value.toLowerCase()),
  qty: createBhSchema.shape.lines.element.shape.qty.transform(dQty),
});

type FirstOrderInput = z.infer<typeof npdFirstOrderSchema>;
async function replayFirstOrder(db: AnyDb, user: SessionUser, input: FirstOrderInput) {
  const [receipt] = await db.select().from(schema.npdFirstOrders).where(and(
    eq(schema.npdFirstOrders.requestedBy, user.id), eq(schema.npdFirstOrders.requestKey, input.requestKey),
  ));
  if (!receipt) return null;
  if (receipt.projectId !== input.projectId || receipt.projectVersion !== input.version || dQty(receipt.qty) !== input.qty) {
    throw new ApiError(409, "请求标识已用于不同内容；请核对原草稿，不要修改原请求后重试");
  }
  const [doc] = await db.select({ id: schema.bhDocs.id, docNo: schema.bhDocs.docNo }).from(schema.bhDocs)
    .where(and(eq(schema.bhDocs.id, receipt.bhId), bhReadScope(db, user)));
  if (!doc) throw new ApiError(403, "原首单已不在当前可读范围，请联系负责人核对");
  return { ...doc, replayed: true };
}

function isRequestCollision(error: unknown): boolean {
  // Drizzle wraps PostgreSQL/PGlite causes. Only this exact constraint means replay.
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const cause = current as { code?: string; constraint?: string; cause?: unknown };
    if (cause.code === "23505" && cause.constraint === "uq_npd_first_order_request") return true;
    current = cause.cause;
  }
  return false;
}

/** #13：NPD 项目 → 新品首单 BH 草稿（目标 SKU 必须已建档；走正常审批，R13 人工闸） */
export async function createNpdFirstOrder(user: SessionUser, input: unknown, dbArg?: AnyDb) {
  requireAnyRole(user, "pmc", "ops");
  const v = npdFirstOrderSchema.parse(input);
  const db = await resolveDb(dbArg);
  try {
    return await db.transaction(async (tx: AnyDb) => {
      const proj = await lockProject(tx, v.projectId);
      // A committed request remains recoverable after later edits or closure. Permission still applies.
      const replay = await replayFirstOrder(tx, user, v);
      if (replay) return replay;
      assertWritable(proj, v.version);
      if (!proj.skuCode) throw new ApiError(400, "项目未设置目标 SKU——请先在主数据建档并补录到项目");
      const sku = await resolveSkuByCodeOrAlias(tx, proj.skuCode);
      if (!sku) throw new ApiError(400, `目标 SKU「${proj.skuCode}」未建档或无此别名`);
      // Keep active/type validation in createBh stable through its nested transaction.
      await tx.select({ id: schema.skus.id }).from(schema.skus).where(eq(schema.skus.id, sku.id)).for("share");
      const delegate: SessionUser = user.roles.includes("ops") ? user : { ...user, roles: [...user.roles, "ops"] };
      /* 审计必须在 createBh 的**事务内**（CLAUDE.md 写路径纪律）：
         此前 writeAudit 写在 createBh 之后、事务之外——BH 已提交而审计失败，
         就留下一张没人知道从哪来的 NPD 首单草稿。走 inTx 钩子，抛错即整单回滚。 */
      const doc = await createBh(
        delegate,
        { remark: `NPD 首单：项目《${proj.name}》#${proj.id}（新品首单，人工确认后提交审批）`, lines: [{ skuId: sku.id, qty: v.qty }] },
        tx,
        {
          inTx: async (tx, created) => {
            await tx.insert(schema.npdFirstOrders).values({
              projectId: proj.id, projectVersion: v.version, bhId: created.id, skuId: sku.id,
              qty: v.qty, requestedBy: user.id, requestKey: v.requestKey,
            });
            const version = await bumpVersion(tx, proj);
            await writeAudit(tx, {
              userId: user.id,
              entity: "npd_project",
              entityId: proj.id,
              action: "first_order_draft",
              before: { version: proj.version },
              after: { docNo: created.docNo, bhId: created.id, skuCode: proj.skuCode, qty: v.qty, version, requestKey: v.requestKey },
            });
          },
        },
      );
      return { id: doc.id, docNo: doc.docNo, replayed: false };
    });
  } catch (error) {
    // Different projects can race on one actor's key; the unique constraint rolls back the loser entirely.
    if (isRequestCollision(error)) {
      const replay = await replayFirstOrder(db, user, v);
      if (replay) return replay;
    }
    throw error;
  }
}
