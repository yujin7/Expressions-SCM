import { and, asc, eq, inArray } from "drizzle-orm";
import {
  bhDocs, ctDocs, flDocs, jgDocs, jsDocs, poDocs, shDocs, tlDocs, woDocs,
} from "@/db/schema";
import { DOC_STATUS_LABELS } from "@/components/labels";
import { ApiError } from "@/server/modules/master/common";
import { type AnyDb, resolveDb } from "./common";
import { bhReadScope, type BhReadUser } from "@/server/core/bh-read-scope";
import { canReadInboxDestination } from "@/server/modules/inbox/read-access";
import { INBOX_PAGE_HREFS } from "@/server/modules/inbox/service";

/**
 * 链路视图：以 WO 为中心解析委外全链 BH→WO→PO→JG→FL/TL→SH→CT→JS。
 * 缺失环节直接省略（不造假节点）；CT 虽不在《01》主链叙述中，但作为 PO 分支的
 * 退货环节纳入展示（挂载页之一即 /matflow/ct，否则该页无 current 节点）。
 */

export type ChainDocType = "bh" | "wo" | "po" | "jg" | "fl" | "tl" | "sh" | "ct" | "js";

export const CHAIN_DOC_TYPES: readonly ChainDocType[] = ["bh", "wo", "po", "jg", "fl", "tl", "sh", "ct", "js"];

const NODE_LABELS: Record<ChainDocType, string> = {
  bh: "备货申请",
  wo: "委外工单",
  po: "采购订单",
  jg: "加工通知",
  fl: "发料",
  tl: "退料",
  sh: "收货",
  ct: "采购退货",
  js: "结算",
};

export interface ChainNode {
  docType: ChainDocType;
  label: string;
  id: number;
  docNo: string;
  status: string;
  statusLabel: string;
  current: boolean;
}

type SlimDoc = { id: number; docNo: string; status: string };

function toNode(docType: ChainDocType, d: SlimDoc, input: { docType: ChainDocType; id: number }, labelSuffix = ""): ChainNode {
  return {
    docType,
    label: `${NODE_LABELS[docType]}${labelSuffix}`,
    id: d.id,
    docNo: d.docNo,
    status: d.status,
    statusLabel: DOC_STATUS_LABELS[d.status] ?? d.status,
    current: docType === input.docType && d.id === input.id,
  };
}

async function one<T>(rows: T[]): Promise<T> {
  if (rows.length === 0) throw new ApiError(404, "单据不存在");
  return rows[0];
}

/**
 * 解析中心 WO 集合。返回 woIds（可空——独立 PO / 未派生 BH 等无 WO 场景）
 * 以及独立 PO id（poDocs.woId 为空时以 PO 为中心组装局部链）。
 */
async function resolveCenter(
  db: AnyDb,
  input: { docType: ChainDocType; id: number },
  user?: BhReadUser,
): Promise<{ woIds: number[]; soloPoIds: number[]; soloBhId: number | null }> {
  const { docType, id } = input;
  switch (docType) {
    case "bh": {
      await one(await db.select({ id: bhDocs.id }).from(bhDocs).where(and(eq(bhDocs.id, id), bhReadScope(db, user))));
      const wos = await db.select({ id: woDocs.id }).from(woDocs).where(eq(woDocs.bhId, id));
      return { woIds: wos.map((w) => w.id), soloPoIds: [], soloBhId: wos.length === 0 ? id : null };
    }
    case "wo": {
      await one(await db.select({ id: woDocs.id }).from(woDocs).where(eq(woDocs.id, id)));
      return { woIds: [id], soloPoIds: [], soloBhId: null };
    }
    case "po": {
      const po = await one(await db.select({ id: poDocs.id, woId: poDocs.woId }).from(poDocs).where(eq(poDocs.id, id)));
      return po.woId != null
        ? { woIds: [po.woId], soloPoIds: [], soloBhId: null }
        : { woIds: [], soloPoIds: [id], soloBhId: null };
    }
    case "jg": {
      const jg = await one(await db.select({ woId: jgDocs.woId }).from(jgDocs).where(eq(jgDocs.id, id)));
      return { woIds: [jg.woId], soloPoIds: [], soloBhId: null };
    }
    case "fl": {
      const fl = await one(await db.select({ jgId: flDocs.jgId }).from(flDocs).where(eq(flDocs.id, id)));
      const jg = await one(await db.select({ woId: jgDocs.woId }).from(jgDocs).where(eq(jgDocs.id, fl.jgId)));
      return { woIds: [jg.woId], soloPoIds: [], soloBhId: null };
    }
    case "tl": {
      const tl = await one(await db.select({ jgId: tlDocs.jgId }).from(tlDocs).where(eq(tlDocs.id, id)));
      const jg = await one(await db.select({ woId: jgDocs.woId }).from(jgDocs).where(eq(jgDocs.id, tl.jgId)));
      return { woIds: [jg.woId], soloPoIds: [], soloBhId: null };
    }
    case "sh": {
      const sh = await one(
        await db.select({ sourceType: shDocs.sourceType, sourceId: shDocs.sourceId }).from(shDocs).where(eq(shDocs.id, id)),
      );
      if (sh.sourceType === "jg") {
        const jg = await one(await db.select({ woId: jgDocs.woId }).from(jgDocs).where(eq(jgDocs.id, sh.sourceId)));
        return { woIds: [jg.woId], soloPoIds: [], soloBhId: null };
      }
      const po = await one(await db.select({ id: poDocs.id, woId: poDocs.woId }).from(poDocs).where(eq(poDocs.id, sh.sourceId)));
      return po.woId != null
        ? { woIds: [po.woId], soloPoIds: [], soloBhId: null }
        : { woIds: [], soloPoIds: [po.id], soloBhId: null };
    }
    case "ct": {
      const ct = await one(await db.select({ poId: ctDocs.poId }).from(ctDocs).where(eq(ctDocs.id, id)));
      const po = await one(await db.select({ id: poDocs.id, woId: poDocs.woId }).from(poDocs).where(eq(poDocs.id, ct.poId)));
      return po.woId != null
        ? { woIds: [po.woId], soloPoIds: [], soloBhId: null }
        : { woIds: [], soloPoIds: [po.id], soloBhId: null };
    }
    case "js": {
      const js = await one(await db.select({ jgId: jsDocs.jgId }).from(jsDocs).where(eq(jsDocs.id, id)));
      const jg = await one(await db.select({ woId: jgDocs.woId }).from(jgDocs).where(eq(jgDocs.id, js.jgId)));
      return { woIds: [jg.woId], soloPoIds: [], soloBhId: null };
    }
  }
}

export async function getChain(
  input: { docType: ChainDocType; id: number },
  dbArg?: AnyDb,
  user?: BhReadUser,
): Promise<{ nodes: ChainNode[] }> {
  const mayRead = (docType: ChainDocType) => !user || canReadInboxDestination(INBOX_PAGE_HREFS[docType], user);
  if (!mayRead(input.docType)) throw new ApiError(404, "单据不存在");
  const db = await resolveDb(dbArg);
  const { woIds, soloPoIds, soloBhId } = await resolveCenter(db, input, user);
  const nodes: ChainNode[] = [];

  // 无 WO 的孤立 BH：仅自身
  if (soloBhId != null) {
    const [bh] = await db
      .select({ id: bhDocs.id, docNo: bhDocs.docNo, status: bhDocs.status })
      .from(bhDocs)
      .where(and(eq(bhDocs.id, soloBhId), bhReadScope(db, user)));
    if (bh) nodes.push(toNode("bh", bh, input));
    return { nodes };
  }

  // 以 WO 为中心：拉全链各环节（缺失=省略）
  const pos =
    woIds.length > 0
      ? await db
          .select({ id: poDocs.id, docNo: poDocs.docNo, status: poDocs.status, woId: poDocs.woId })
          .from(poDocs)
          .where(inArray(poDocs.woId, woIds))
          .orderBy(asc(poDocs.id))
      : soloPoIds.length > 0
        ? await db
            .select({ id: poDocs.id, docNo: poDocs.docNo, status: poDocs.status, woId: poDocs.woId })
            .from(poDocs)
            .where(inArray(poDocs.id, soloPoIds))
        : [];
  const poIds = pos.map((p) => p.id);

  const wos =
    woIds.length > 0
      ? await db
          .select({ id: woDocs.id, docNo: woDocs.docNo, status: woDocs.status, bhId: woDocs.bhId })
          .from(woDocs)
          .where(inArray(woDocs.id, woIds))
          .orderBy(asc(woDocs.id))
      : [];
  const bhIds = [...new Set(wos.map((w) => w.bhId).filter((v): v is number => v != null))];

  const bhs =
    bhIds.length > 0
      ? await db
          .select({ id: bhDocs.id, docNo: bhDocs.docNo, status: bhDocs.status })
          .from(bhDocs)
          .where(and(inArray(bhDocs.id, bhIds), bhReadScope(db, user)))
          .orderBy(asc(bhDocs.id))
      : [];

  let jgs: (SlimDoc & { batchSeq: number })[] = [];
  if (woIds.length > 0) {
    try {
      jgs = await db
        .select({ id: jgDocs.id, docNo: jgDocs.docNo, status: jgDocs.status, batchSeq: jgDocs.batchSeq })
        .from(jgDocs)
        .where(inArray(jgDocs.woId, woIds))
        .orderBy(asc(jgDocs.batchSeq), asc(jgDocs.id));
    } catch {
      // 兼容迁移 0012（jg_docs.batch_seq）未应用的漂移库（/api/health drift=true，
      // PGlite 迁移仅在 dev server 重启时应用）：降级为无批次列查询，batchSeq 视为 1
      const rows = await db
        .select({ id: jgDocs.id, docNo: jgDocs.docNo, status: jgDocs.status })
        .from(jgDocs)
        .where(inArray(jgDocs.woId, woIds))
        .orderBy(asc(jgDocs.id));
      jgs = rows.map((r) => ({ ...r, batchSeq: 1 }));
    }
  }
  const jgIds = jgs.map((j) => j.id);

  const [fls, tls, jss] = await Promise.all([
    jgIds.length > 0
      ? db
          .select({ id: flDocs.id, docNo: flDocs.docNo, status: flDocs.status })
          .from(flDocs)
          .where(inArray(flDocs.jgId, jgIds))
          .orderBy(asc(flDocs.id))
      : Promise.resolve([]),
    jgIds.length > 0
      ? db
          .select({ id: tlDocs.id, docNo: tlDocs.docNo, status: tlDocs.status })
          .from(tlDocs)
          .where(inArray(tlDocs.jgId, jgIds))
          .orderBy(asc(tlDocs.id))
      : Promise.resolve([]),
    jgIds.length > 0
      ? db
          .select({ id: jsDocs.id, docNo: jsDocs.docNo, status: jsDocs.status })
          .from(jsDocs)
          .where(inArray(jsDocs.jgId, jgIds))
          .orderBy(asc(jsDocs.id))
      : Promise.resolve([]),
  ]);

  // SH：JG 收货 + PO 收货两路（sourceType+sourceId 无 DB 级 FK，按类型分别限定）
  const shs: SlimDoc[] = [];
  if (jgIds.length > 0) {
    const rows = await db
      .select({ id: shDocs.id, docNo: shDocs.docNo, status: shDocs.status })
      .from(shDocs)
      .where(and(eq(shDocs.sourceType, "jg"), inArray(shDocs.sourceId, jgIds)))
      .orderBy(asc(shDocs.id));
    shs.push(...rows);
  }
  if (poIds.length > 0) {
    const rows = await db
      .select({ id: shDocs.id, docNo: shDocs.docNo, status: shDocs.status })
      .from(shDocs)
      .where(and(eq(shDocs.sourceType, "po"), inArray(shDocs.sourceId, poIds)))
      .orderBy(asc(shDocs.id));
    shs.push(...rows);
  }
  shs.sort((a, b) => a.id - b.id);

  const cts =
    poIds.length > 0
      ? await db
          .select({ id: ctDocs.id, docNo: ctDocs.docNo, status: ctDocs.status })
          .from(ctDocs)
          .where(inArray(ctDocs.poId, poIds))
          .orderBy(asc(ctDocs.id))
      : [];

  for (const d of bhs) nodes.push(toNode("bh", d, input));
  for (const d of wos) nodes.push(toNode("wo", d, input));
  for (const d of pos) nodes.push(toNode("po", d, input));
  for (const d of jgs) nodes.push(toNode("jg", d, input, jgs.length > 1 || d.batchSeq > 1 ? `·批${d.batchSeq}` : ""));
  for (const d of fls) nodes.push(toNode("fl", d, input));
  for (const d of tls) nodes.push(toNode("tl", d, input));
  for (const d of shs) nodes.push(toNode("sh", d, input));
  for (const d of cts) nodes.push(toNode("ct", d, input));
  for (const d of jss) nodes.push(toNode("js", d, input));

  return { nodes: nodes.filter(node => mayRead(node.docType)) };
}
