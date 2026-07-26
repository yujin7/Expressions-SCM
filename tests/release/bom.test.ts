/**
 * releaseBoms + activateReleasedBoms（§4.3）：
 * 无歧义链端到端（放行→批量生效审批：approvals 行 + 一版生效 + 旧版退役）；
 * 歧义块必须人工裁决；qtyPer 空行跳过留痕；SoD 与审批人角色强制；dry-run 零写入。
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/db";
import { writeStagingRows } from "@/server/import/staging";
import {
  activateReleasedBoms,
  releaseBoms,
  releaseSkus,
  releaseSpus,
  type ReleaseUser,
} from "@/server/modules/release/engine";

async function newJob(db: TestDb): Promise<number> {
  const [j] = await db
    .insert(schema.importJobs)
    .values({ template: "bom", filename: "t.xlsx", status: "done", createdBy: 1 })
    .returning({ id: schema.importJobs.id });
  return j.id;
}

async function seedUsers(db: TestDb) {
  const [releaser] = await db
    .insert(schema.users)
    .values({ name: "放行员", roles: ["pmc"], isApprover: false })
    .returning();
  const [approver] = await db
    .insert(schema.users)
    .values({ name: "PMC审批人", roles: ["pmc"], isApprover: true })
    .returning();
  return {
    releaser: { id: releaser.id, name: releaser.name, roles: releaser.roles, isApprover: false } as ReleaseUser,
    approver: { id: approver.id, name: approver.name, roles: approver.roles, isApprover: true } as ReleaseUser,
  };
}

function line(over: Partial<Record<string, unknown>>) {
  return {
    materialCode: null, materialName: "", materialSpec: "", texture: "",
    qtyPer: 1, qtyPerRaw: "1", uomGuess: "count", supplierRaw: "", segment: "uncoded",
    ...over,
  };
}
function block(over: Partial<Record<string, unknown>>) {
  return {
    sheet: "S1", brandCode: "NING", productCode: null, productName: "", productSpec: "",
    versionMarker: "none", barcode: null, ambiguous: false, lines: [], feeLines: [],
    ...over,
  };
}
const cluster = (key: string, members: string[]) => ({
  spuKey: key, suggestedName: `${key}品`, members, confidence: "auto", reasons: [],
});

describe("releaseBoms / activateReleasedBoms", () => {
  it("端到端：放行为 draft 候选 → 批审生效（approvals+旧版退役+唯一 active）；SoD/角色强制", async () => {
    const { db } = await createTestDb();
    const { releaser, approver } = await seedUsers(db);
    const [supplier] = await db
      .insert(schema.suppliers)
      .values({ code: "S001", name: "中源泰", kinds: ["processor"] })
      .returning();
    await db.insert(schema.aliases).values({ aliasType: "supplier_oem", rawValue: "ZYT", targetId: supplier.id });

    const jobId = await newJob(db);
    await writeStagingRows(db, jobId, [
      { rowNo: 1, targetTable: "spu_suggestion", payload: cluster("N006", ["N006-a"]) },
      {
        rowNo: 2,
        targetTable: "bom_block",
        payload: block({
          productCode: "N006-a",
          productName: "烟酰胺洁面乳",
          lines: [
            line({ materialCode: "N006-a-0101", materialName: "膏体", qtyPer: 2, qtyPerRaw: "2", supplierRaw: "ZYT", segment: "raw_bulk", texture: "膏状" }),
            line({ materialCode: "N006-a-0201", materialName: "外箱", qtyPer: null, qtyPerRaw: "100/箱", uomGuess: "unknown", segment: "primary_pack" }),
            line({ materialName: "合格证", segment: "uncoded" }),
          ],
        }),
      },
    ]);
    await releaseSpus(releaser, { dryRun: false }, db);
    await releaseSkus(releaser, { dryRun: false }, db);

    const productSku = (await db.select().from(schema.skus).where(eq(schema.skus.code, "N006-a")))[0];
    // 既有生效版本（后续批审应将其退役）
    await db.insert(schema.boms).values({
      productSkuId: productSku.id, versionNo: "V1", status: "active", createdBy: approver.id,
    });

    // dry-run：版本接续 V2，零写入
    const dry = await releaseBoms(releaser, { dryRun: true }, db);
    expect(dry.dryRun).toBe(true);
    expect(dry.created).toBe(1);
    expect(dry.candidates[0].versionNo).toBe("V2");
    expect(dry.releaseRunId).toBeNull();
    expect(await db.select().from(schema.boms)).toHaveLength(1);

    // 真放行：draft 候选 + 行级跳过留痕
    const run = await releaseBoms(releaser, { dryRun: false }, db);
    expect(run.created).toBe(1);
    expect(run.releaseRunId).not.toBeNull();
    expect(run.lineSkips).toHaveLength(2);
    expect(run.lineSkips.map((s) => s.reason).join("|")).toContain("无编码物料");
    expect(run.lineSkips.map((s) => s.reason).join("|")).toContain("100/箱");
    const bomId = run.candidates[0].bomId!;
    const [draft] = await db.select().from(schema.boms).where(eq(schema.boms.id, bomId));
    expect(draft.status).toBe("draft"); // 绝不直接 active——生效必须走批审
    expect(draft.versionNo).toBe("V2");
    expect(draft.createdBy).toBe(releaser.id);
    const lines = await db.select().from(schema.bomLines).where(eq(schema.bomLines.bomId, bomId));
    expect(lines).toHaveLength(1);
    expect(lines[0].preferredSupplierId).toBe(supplier.id);
    expect(lines[0].uom).toBe("计数");
    expect(Number(lines[0].qtyPer)).toBe(2);
    expect(lines[0].remark).toContain("膏状");
    const [stRow] = await db
      .select()
      .from(schema.stagingRows)
      .where(and(eq(schema.stagingRows.importJobId, jobId), eq(schema.stagingRows.rowNo, 2)));
    expect(stRow.status).toBe("committed");
    expect(stRow.targetId).toBe(bomId);

    // 角色闸：非审批人（即使 pmc）不可批审
    await expect(activateReleasedBoms(releaser, { bomIds: [bomId], dryRun: false }, db)).rejects.toThrow("审批人");
    // SoD：审批人=放行者本人（同 id 但有审批位）→ 拒绝
    await expect(
      activateReleasedBoms({ ...releaser, isApprover: true }, { bomIds: [bomId], dryRun: false }, db),
    ).rejects.toThrow("职责分离");

    // dry-run 批审：抽样清单返回、状态不动
    const actDry = await activateReleasedBoms(approver, { releaseRunId: run.releaseRunId!, dryRun: true }, db);
    expect(actDry.activated).toBe(1);
    expect(actDry.sample).toHaveLength(1);
    expect((await db.select().from(schema.boms).where(eq(schema.boms.id, bomId)))[0].status).toBe("draft");
    expect(await db.select().from(schema.approvals)).toHaveLength(0);

    // 真批审：生效 + 旧版退役 + 每 BOM 一条 approvals + 唯一 active
    const act = await activateReleasedBoms(approver, { releaseRunId: run.releaseRunId!, dryRun: false }, db);
    expect(act.activated).toBe(1);
    const boms = await db.select().from(schema.boms).where(eq(schema.boms.productSkuId, productSku.id));
    expect(boms.find((b) => b.versionNo === "V1")!.status).toBe("retired");
    const active = boms.filter((b) => b.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(bomId);
    expect(active[0].effectiveDate).toBeTruthy();
    const approvals = await db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.docType, "bom"), eq(schema.approvals.docId, bomId)));
    expect(approvals).toHaveLength(1);
    expect(approvals[0].approverId).toBe(approver.id);
    expect(approvals[0].comment).toContain("批量生效 run#");

    // 幂等重批：已生效 → alreadyActive，不再写 approvals
    const again = await activateReleasedBoms(approver, { releaseRunId: run.releaseRunId!, dryRun: false }, db);
    expect(again.activated).toBe(0);
    expect(again.alreadyActive).toBe(1);
    expect(await db.select().from(schema.approvals)).toHaveLength(1);
  });

  it("歧义块强制人工裁决（§4.3）；多候选同产品仅留最后一个候选，其余降级 retired", async () => {
    const { db } = await createTestDb();
    const { releaser } = await seedUsers(db);
    const jobId = await newJob(db);
    const mk = (code: string, marker: string, ambiguous: boolean) =>
      block({
        productCode: code, productName: `${code}品`, versionMarker: marker, ambiguous,
        lines: [line({ materialCode: `${code}-0101`, materialName: "料", segment: "raw_bulk" })],
      });
    await writeStagingRows(db, jobId, [
      { rowNo: 1, targetTable: "spu_suggestion", payload: cluster("E02", ["E02-x"]) },
      { rowNo: 2, targetTable: "spu_suggestion", payload: cluster("E03", ["E03-y"]) },
      // E02-x：两个歧义块（同名多块无标记）
      { rowNo: 3, targetTable: "bom_block", payload: mk("E02-x", "none", true) },
      { rowNo: 4, targetTable: "bom_block", payload: mk("E02-x", "none", true) },
      // E03-y：两个非歧义候选（均带 preferred 标记）→ 后者胜出
      { rowNo: 5, targetTable: "bom_block", payload: mk("E03-y", "preferred", false) },
      { rowNo: 6, targetTable: "bom_block", payload: mk("E03-y", "preferred", false) },
    ]);
    await releaseSpus(releaser, { dryRun: false }, db);
    await releaseSkus(releaser, { dryRun: false }, db);

    // 无 resolutions：歧义块 100% 阻塞（禁止启发式定 active）；E03 双候选照常放行
    const run1 = await releaseBoms(releaser, { dryRun: false }, db);
    expect(run1.blocked.filter((b) => b.reason.includes("歧义块"))).toHaveLength(2);
    expect(run1.created).toBe(2); // E03-y 两块
    expect(run1.candidates).toHaveLength(1); // 仅最后一块为候选
    expect(run1.retired).toBe(1);
    const e03Sku = (await db.select().from(schema.skus).where(eq(schema.skus.code, "E03-y")))[0];
    const e03Boms = await db.select().from(schema.boms).where(eq(schema.boms.productSkuId, e03Sku.id));
    expect(e03Boms.map((b) => [b.versionNo, b.status]).sort()).toEqual([
      ["V1", "retired"],
      ["V2", "draft"],
    ]);
    // 阻塞原因写回 staging（状态仍 pending）
    const e02Rows = await db
      .select()
      .from(schema.stagingRows)
      .where(and(eq(schema.stagingRows.importJobId, jobId), eq(schema.stagingRows.targetTable, "bom_block")));
    const amb = e02Rows.filter((r) => r.errorMsg?.includes("歧义块"));
    expect(amb).toHaveLength(2);
    expect(amb.every((r) => r.status === "pending")).toBe(true);

    // 携带人工裁决重放：旧版 retired / 新版候选
    const [rowA, rowB] = amb.sort((a, b) => a.rowNo - b.rowNo);
    const run2 = await releaseBoms(
      releaser,
      {
        resolutions: {
          [String(rowA.id)]: { decision: "retired" },
          [String(rowB.id)]: { decision: "active" },
        },
        dryRun: false,
      },
      db,
    );
    expect(run2.created).toBe(2);
    expect(run2.candidates).toHaveLength(1);
    expect(run2.retired).toBe(1);
    const e02Sku = (await db.select().from(schema.skus).where(eq(schema.skus.code, "E02-x")))[0];
    const e02Boms = await db.select().from(schema.boms).where(eq(schema.boms.productSkuId, e02Sku.id));
    expect(e02Boms.map((b) => [b.versionNo, b.status]).sort()).toEqual([
      ["V1", "retired"],
      ["V2", "draft"],
    ]);

    // skip 裁决：行不动
    const job2 = await newJob(db);
    await writeStagingRows(db, job2, [
      { rowNo: 1, targetTable: "bom_block", payload: mk("E03-y", "none", true) },
    ]);
    const [skipRow] = await db
      .select()
      .from(schema.stagingRows)
      .where(eq(schema.stagingRows.importJobId, job2));
    const run3 = await releaseBoms(
      releaser,
      { jobIds: [job2], resolutions: { [String(skipRow.id)]: { decision: "skip" } }, dryRun: false },
      db,
    );
    expect(run3.skipped).toBe(1);
    expect(run3.created).toBe(0);
  });

  it("bomIds 收口：引擎外直建的 draft BOM 非放行候选，拒绝批量生效；放行链候选照常", async () => {
    const { db } = await createTestDb();
    const { releaser, approver } = await seedUsers(db);

    // 引擎外直建（模拟单据页新建的 draft）——不在任何放行批次候选集合内
    const [spu] = await db.insert(schema.spus).values({ code: "P90001", nameCn: "外建品" }).returning();
    const [sku] = await db
      .insert(schema.skus)
      .values({ code: "Z9-x", name: "外建品", spuId: spu.id, skuType: "finished", baseUom: "件" })
      .returning();
    const [outside] = await db
      .insert(schema.boms)
      .values({ productSkuId: sku.id, versionNo: "V1", status: "draft", createdBy: releaser.id })
      .returning();

    // dry-run 同样收口（守卫先于一切写入判定）
    await expect(
      activateReleasedBoms(approver, { bomIds: [outside.id], dryRun: true }, db),
    ).rejects.toThrow("非放行候选 BOM，请走单据页逐一生效审批");

    // 放行链产出真候选
    const jobId = await newJob(db);
    await writeStagingRows(db, jobId, [
      { rowNo: 1, targetTable: "spu_suggestion", payload: cluster("G01", ["G01-a"]) },
      {
        rowNo: 2,
        targetTable: "bom_block",
        payload: block({
          productCode: "G01-a",
          productName: "G01品",
          lines: [line({ materialCode: "G01-a-0101", materialName: "料", segment: "raw_bulk" })],
        }),
      },
    ]);
    await releaseSpus(releaser, { dryRun: false }, db);
    await releaseSkus(releaser, { dryRun: false }, db);
    const run = await releaseBoms(releaser, { dryRun: false }, db);
    const candidateId = run.candidates[0].bomId!;

    // 混入外部 id：整体拒绝，报文列出违规 id
    await expect(
      activateReleasedBoms(approver, { bomIds: [candidateId, outside.id], dryRun: false }, db),
    ).rejects.toThrow(String(outside.id));
    expect((await db.select().from(schema.boms).where(eq(schema.boms.id, candidateId)))[0].status).toBe("draft");

    // 纯候选 id：照常批审生效
    const ok = await activateReleasedBoms(approver, { bomIds: [candidateId], dryRun: false }, db);
    expect(ok.activated).toBe(1);
    expect((await db.select().from(schema.boms).where(eq(schema.boms.id, candidateId)))[0].status).toBe("active");
    // 外部 draft 始终未被触碰
    expect((await db.select().from(schema.boms).where(eq(schema.boms.id, outside.id)))[0].status).toBe("draft");
  });
});
