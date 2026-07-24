/**
 * 适配器⑩：NPD 各节点核心说明（三件套）→ staging(transit_ref, kind='npd_node'/'npd_role')。
 * D19 口径：NPD 核心=1.x——本登记为节点标准/角色分配的只读参考（1.x 实现时的配置底稿）。
 * 三文件合并：基表(说明) ⊕ 时间节点模拟(模拟起止) ⊕ 角色及分配逻辑；节点名称为合并键。
 */
import { normalizeDateCell, readWorkbook, type CellValue, type SheetData } from "../parse/xlsx";
import { createImportJob, finalizeImportJob, writeStagingRows, type AnyDb, type StagingRowInput } from "../staging";
import type { TransitPayload } from "./transit";

export const NPD_TEMPLATE = "npd";
const TARGET_TABLE = "transit_ref";

const str = (v: CellValue): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const num = (v: CellValue): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const emptyP = (): Omit<TransitPayload, "kind"> => ({
  brandRaw: null, skuCode: null, materialCode: null, materialName: null, oemRaw: null,
  externalNo: null, approvalNo: null, feishuNo: null, orderType: null,
  qty: null, doneQty: null, inboundQty: null, closedQty: null, usedQty: null, remainQty: null,
  orderDate: null, needDate: null, replyDate: null, revisedDate: null, expectDate: null, startDate: null,
  progress: null, urgentDept: null, follower: null, exception: null, extra: null,
});

export function parseNodes(sheet: SheetData): Map<string, Record<string, unknown>> {
  const hi = sheet.rows.findIndex((r) => r.some((c) => typeof c === "string" && c.includes("节点名称")));
  const out = new Map<string, Record<string, unknown>>();
  if (hi < 0) return out;
  const col = new Map<string, number>();
  (sheet.rows[hi] ?? []).forEach((c, i) => { if (typeof c === "string") col.set(c.replace(/\s/g, ""), i); });
  const c = (k: string) => col.get(k) ?? -1;
  for (let i = hi + 1; i < sheet.rows.length; i++) {
    const r = sheet.rows[i] ?? [];
    const name = str(r[c("节点名称")]);
    if (!name) continue;
    out.set(name, {
      节点名称: name,
      节点阶段: str(r[c("节点阶段")]),
      责任部门: str(r[c("责任部门")]),
      执行岗位: str(r[c("执行岗位")]),
      节点职责说明: str(r[c("节点职责说明")]),
      上下游需求: str(r[c("对上下游或平行部门需求/要求")]),
      交付物模板: str(r[c("交付物模板")]),
      交付事项标准: str(r[c("交付事项标准")]),
      执行天数: num(r[c("执行时间标准（天）")]),
      模拟开始: normalizeDateCell(r[c("模拟开始时间")] ?? null),
      模拟结束: normalizeDateCell(r[c("模拟结束时间")] ?? null),
      上一节点: str(r[c("上一节点")]),
    });
  }
  return out;
}

export async function stageNpd(
  db: AnyDb,
  files: { base: string; sim: string; withRoles: string },
  userId: number,
) {
  const merged = new Map<string, Record<string, unknown>>();
  const mergeIn = (m: Map<string, Record<string, unknown>>) => {
    for (const [k, v] of m) {
      const prev = merged.get(k) ?? {};
      const next: Record<string, unknown> = { ...prev };
      for (const [f, val] of Object.entries(v)) if (val != null && next[f] == null) next[f] = val;
      merged.set(k, next);
    }
  };
  let roles: { 角色名称: string; 分配方式: string | null }[] = [];
  for (const p of [files.withRoles, files.base, files.sim]) {
    const wb = await readWorkbook(p, { forceRaw: true });
    const data = wb.sheets.find((s) => s.name.includes("数据表"));
    if (data) mergeIn(parseNodes(data));
    const roleSheet = wb.sheets.find((s) => s.name.includes("角色"));
    if (roleSheet && roles.length === 0) {
      const hi = roleSheet.rows.findIndex((r) => r.some((c) => typeof c === "string" && String(c).includes("角色名称")));
      for (let i = hi + 1; i < roleSheet.rows.length; i++) {
        const r = roleSheet.rows[i] ?? [];
        const name = str(r[1]);
        if (name) roles.push({ 角色名称: name, 分配方式: str(r[2]) });
      }
    }
  }
  const rows: StagingRowInput[] = [];
  let rowNo = 0;
  for (const n of merged.values()) {
    const p: TransitPayload = {
      ...emptyP(),
      kind: "npd_node" as TransitPayload["kind"],
      approvalNo: String(n.节点名称).split(" ")[0] ?? null, // 节点编号（a.1 等）
      materialName: n.节点名称 as string,
      orderType: (n.节点阶段 as string) ?? null,
      follower: [n.责任部门, n.执行岗位].filter(Boolean).join(" / ") || null,
      qty: (n.执行天数 as number) ?? null, // 天数承载于 qty 槽（列注见 UI）
      orderDate: (n.模拟开始 as string) ?? null,
      expectDate: (n.模拟结束 as string) ?? null,
      exception: (n.节点职责说明 as string) ?? null,
      extra: {
        上下游需求: n.上下游需求 ?? null,
        交付物模板: n.交付物模板 ?? null,
        交付事项标准: n.交付事项标准 ?? null,
        上一节点: n.上一节点 ?? null,
      },
    };
    rows.push({ rowNo: ++rowNo, targetTable: TARGET_TABLE, payload: p });
  }
  for (const r of roles) {
    rows.push({
      rowNo: ++rowNo,
      targetTable: TARGET_TABLE,
      payload: { ...emptyP(), kind: "npd_role" as TransitPayload["kind"], materialName: r.角色名称, follower: r.分配方式, extra: null },
    });
  }
  const job = await createImportJob(db, { template: NPD_TEMPLATE, filePath: files.withRoles, createdBy: userId });
  await writeStagingRows(db, job.id, rows);
  await finalizeImportJob(db, job.id, { okRows: rows.length, failRows: 0 });
  return { jobId: job.id, stats: { nodes: merged.size, roles: roles.length, stagedRows: rows.length } };
}
