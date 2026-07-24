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
import { getDbAsync } from "@/db";
import * as schema from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { requireAnyRole } from "@/server/modules/outsource/common";
import { todayShanghai } from "@/server/modules/master/common";
import { scheduleNpd, type NpdTemplateNode } from "@/server/rules/npd-schedule";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

async function resolveDb(db?: AnyDb): Promise<AnyDb> {
  return db ?? (await getDbAsync());
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
  if (v.skuCode?.trim()) {
    const [hit] = await db.select({ id: schema.skus.id }).from(schema.skus).where(eq(schema.skus.code, v.skuCode.trim()));
    if (!hit) throw new Error(`目标 SKU「${v.skuCode.trim()}」未建档——请先建档或留空后补`);
  }
  const template = await loadNpdTemplate(db);
  if (template.length === 0) throw new Error("NPD 节点模板为空（transit_refs kind=npd_node）——请先导入各节点核心说明");
  const tasks = scheduleNpd(template, v.startDate);

  return db.transaction(async (tx: AnyDb) => {
    const [proj] = await tx
      .insert(schema.npdProjects)
      .values({
        name: v.name,
        skuCode: v.skuCode?.trim() || null,
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
  const projects = await db.select().from(p).orderBy(desc(p.id));
  const tasks: { projectId: number; status: string; planEnd: string | null }[] = await db
    .select({ projectId: t.projectId, status: t.status, planEnd: t.planEnd })
    .from(t);
  const agg = new Map<number, { total: number; done: number; planEnd: string | null }>();
  for (const row of tasks) {
    const cur = agg.get(row.projectId) ?? { total: 0, done: 0, planEnd: null };
    cur.total++;
    if (row.status === "done" || row.status === "skipped") cur.done++;
    if (row.planEnd && (cur.planEnd == null || row.planEnd > cur.planEnd)) cur.planEnd = row.planEnd;
    agg.set(row.projectId, cur);
  }
  return projects.map((proj: typeof schema.npdProjects.$inferSelect) => ({
    ...proj,
    taskTotal: agg.get(proj.id)?.total ?? 0,
    taskDone: agg.get(proj.id)?.done ?? 0,
    planEnd: agg.get(proj.id)?.planEnd ?? null,
  }));
}

export async function getNpdProject(id: number, dbArg?: AnyDb) {
  const db = await resolveDb(dbArg);
  const [project] = await db.select().from(schema.npdProjects).where(eq(schema.npdProjects.id, id));
  if (!project) throw new Error("项目不存在");
  const tasks = await db
    .select()
    .from(schema.npdTasks)
    .where(eq(schema.npdTasks.projectId, id))
    .orderBy(asc(schema.npdTasks.seq));
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
  if (!task) throw new Error("任务不存在");
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
  if (!proj) throw new Error("项目不存在");
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
