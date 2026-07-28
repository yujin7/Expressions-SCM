/**
 * NPD 1.x 项目跟踪（D19 激活，spec/13 §三 D——轻量：非单据流，无审批）。
 *
 * - 模板 = transit_refs kind=npd_node（69 节点标准，只读底稿）；
 * - 建项目即按 rules/npd-schedule.ts 拓扑实例化任务计划（自然日）；
 * - 任务状态 pending/doing/done/skipped 人工推进；done 记 doneAt（默认当日 Asia/Shanghai）；
 * - 写路径：pmc/ops（admin 兜底），writeAudit 全覆盖；项目完成/取消仅改状态（无删除）。
 */
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { ApiError, todayShanghai } from "@/server/modules/master/common";
import { scheduleNpd, type NpdTemplateNode } from "@/server/rules/npd-schedule";
import { createBh } from "@/server/modules/outsource/bh";
import { resolveAlias } from "@/server/modules/dimension/resolver";
import { resolveDb } from "@/server/core/svc";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyDb = any;


const DAY_MS = 86_400_000;
/** 自然日推算（与 rules/npd-schedule 同口径，UTC 基准避免时区漂移） */
function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
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
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "启动日期格式 YYYY-MM-DD"),
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
  const tasks = scheduleNpd(template, v.startDate);

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

export async function getNpdProject(id: number, dbArg?: AnyDb) {
  const db = await resolveDb(dbArg);
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
  return { project, tasks };
}

export const updateNpdTaskSchema = z.object({
  taskId: z.number().int().positive(),
  status: z.enum(["pending", "doing", "done", "skipped"]),
  note: z.string().trim().max(300).optional(),
});

export async function updateNpdTask(user: SessionUser, input: unknown, dbArg?: AnyDb) {
  requireAnyRole(user, "pmc", "ops");
  const v = updateNpdTaskSchema.parse(input);
  const db = await resolveDb(dbArg);
  const [task] = await db.select().from(schema.npdTasks).where(eq(schema.npdTasks.id, v.taskId));
  if (!task) throw new ApiError(404, "任务不存在");
  const doneAt = v.status === "done" ? todayShanghai() : null;
  await db.transaction(async (tx: AnyDb) => {
    await tx
      .update(schema.npdTasks)
      .set({ status: v.status, doneAt, note: v.note?.trim() || task.note, updatedAt: new Date() })
      .where(eq(schema.npdTasks.id, v.taskId));
    await writeAudit(tx, {
      userId: user.id,
      entity: "npd_task",
      entityId: v.taskId,
      action: "update_status",
      before: { status: task.status },
      after: { status: v.status, doneAt, note: v.note ?? null },
    });
  });
  return { ok: true };
}

export const updateNpdProjectSchema = z.object({
  projectId: z.number().int().positive(),
  status: z.enum(["active", "done", "cancelled"]),
});

export async function updateNpdProject(user: SessionUser, input: unknown, dbArg?: AnyDb) {
  requireAnyRole(user, "pmc", "ops");
  const v = updateNpdProjectSchema.parse(input);
  const db = await resolveDb(dbArg);
  const [proj] = await db.select().from(schema.npdProjects).where(eq(schema.npdProjects.id, v.projectId));
  if (!proj) throw new ApiError(404, "项目不存在");
  await db.transaction(async (tx: AnyDb) => {
    await tx
      .update(schema.npdProjects)
      .set({ status: v.status, updatedAt: new Date() })
      .where(eq(schema.npdProjects.id, v.projectId));
    await writeAudit(tx, {
      userId: user.id,
      entity: "npd_project",
      entityId: v.projectId,
      action: "update_status",
      before: { status: proj.status },
      after: { status: v.status },
    });
  });
  return { ok: true };
}

export const setNpdSkuCodeSchema = z.object({
  projectId: z.number().int().positive(),
  skuCode: z.string().trim().min(1, "目标 SKU 不能为空").max(60),
});

/** #18：项目目标 SKU 补录（可后补承诺兑现）——alias-first 解析，收敛为规范编码后写回，writeAudit */
export async function updateNpdProjectSkuCode(user: SessionUser, input: unknown, dbArg?: AnyDb) {
  requireAnyRole(user, "pmc", "ops");
  const v = setNpdSkuCodeSchema.parse(input);
  const db = await resolveDb(dbArg);
  const [proj] = await db.select().from(schema.npdProjects).where(eq(schema.npdProjects.id, v.projectId));
  if (!proj) throw new ApiError(404, "项目不存在");
  const hit = await resolveSkuByCodeOrAlias(db, v.skuCode);
  if (!hit) throw new ApiError(400, `目标 SKU「${v.skuCode}」未建档或无此别名——请先建档/认领别名`);
  await db.transaction(async (tx: AnyDb) => {
    await tx
      .update(schema.npdProjects)
      .set({ skuCode: hit.code, updatedAt: new Date() })
      .where(eq(schema.npdProjects.id, v.projectId));
    await writeAudit(tx, {
      userId: user.id,
      entity: "npd_project",
      entityId: v.projectId,
      action: "set_sku_code",
      before: { skuCode: proj.skuCode },
      after: { skuCode: hit.code },
    });
  });
  return { ok: true, skuCode: hit.code };
}

export const rescheduleNpdSchema = z.object({
  projectId: z.number().int().positive(),
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
  const [proj] = await db.select().from(schema.npdProjects).where(eq(schema.npdProjects.id, v.projectId));
  if (!proj) throw new ApiError(404, "项目不存在");
  const tasks: (typeof schema.npdTasks.$inferSelect)[] = await db
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
  await db.transaction(async (tx: AnyDb) => {
    for (const u of updates) {
      await tx
        .update(schema.npdTasks)
        .set({ planStart: u.planStart, planEnd: u.planEnd, updatedAt: new Date() })
        .where(eq(schema.npdTasks.id, u.id));
    }
    await writeAudit(tx, {
      userId: user.id,
      entity: "npd_project",
      entityId: v.projectId,
      action: "reschedule",
      after: { changed: updates.length, planEnd: cursor },
    });
  });
  return { ok: true, changed: updates.length, planEnd: cursor };
}

export const npdFirstOrderSchema = z.object({
  projectId: z.number().int().positive(),
  qty: z.union([z.string(), z.number()]).transform((v) => String(v).trim()).refine((v) => /^\d+(\.\d+)?$/.test(v) && Number(v) > 0, "数量必须为正数"),
});

/** #13：NPD 项目 → 新品首单 BH 草稿（目标 SKU 必须已建档；走正常审批，R13 人工闸） */
export async function createNpdFirstOrder(user: SessionUser, input: unknown, dbArg?: AnyDb) {
  requireAnyRole(user, "pmc", "ops");
  const v = npdFirstOrderSchema.parse(input);
  const db = await resolveDb(dbArg);
  const [proj] = await db.select().from(schema.npdProjects).where(eq(schema.npdProjects.id, v.projectId));
  if (!proj) throw new ApiError(404, "项目不存在");
  if (!proj.skuCode) throw new ApiError(400, "项目未设置目标 SKU——请先在主数据建档并补录到项目");
  const sku = await resolveSkuByCodeOrAlias(db, proj.skuCode);
  if (!sku) throw new ApiError(400, `目标 SKU「${proj.skuCode}」未建档或无此别名`);
  const delegate: SessionUser = user.roles.includes("ops") ? user : { ...user, roles: [...user.roles, "ops"] };
  const doc = await createBh(
    delegate,
    { remark: `NPD 首单：项目《${proj.name}》#${proj.id}（新品首单，人工确认后提交审批）`, lines: [{ skuId: sku.id, qty: v.qty }] },
    db,
  );
  await writeAudit(db, {
    userId: user.id,
    entity: "npd_project",
    entityId: proj.id,
    action: "first_order_draft",
    after: { docNo: doc.docNo, skuCode: proj.skuCode, qty: v.qty },
  });
  return { id: doc.id, docNo: doc.docNo };
}
