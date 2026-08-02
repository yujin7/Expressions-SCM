import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { writeStagingRows } from "@/server/import/staging";
import {
  releaseBoms,
  releaseSkus,
  releaseSkusForLegacyLocalMigration,
  type ReleaseUser,
} from "@/server/modules/release/engine";
import { parseGovernedSkuCode } from "@/server/rules/sku-code";

import { createTestDb, type TestDb } from "../helpers/db";

const operator: ReleaseUser = {
  id: 91,
  name: "SKU 身份放行员",
  roles: ["pmc"],
  isApprover: false,
};

type IdentityMode = "historical_preserve" | "new_master";

async function seedJob(
  db: TestDb,
  identityMode?: IdentityMode,
): Promise<number> {
  await db.insert(schema.brands).values([
    { code: "EXP", nameCn: "EXPRESSIONS" },
    { code: "NING", nameCn: "NING" },
  ]).onConflictDoNothing();
  const [job] = await db
    .insert(schema.importJobs)
    .values({
      template: "bom",
      filename: `${identityMode ?? "missing"}.xlsx`,
      status: "done",
      createdBy: operator.id,
      scope: identityMode ? { mode: "full", identityMode } : null,
    })
    .returning({ id: schema.importJobs.id });
  return job.id;
}

function line(over: Partial<Record<string, unknown>> = {}) {
  return {
    materialCode: null,
    materialName: "",
    materialSpec: "",
    texture: "",
    qtyPer: 1,
    qtyPerRaw: "1",
    uomGuess: "count",
    supplierRaw: "",
    segment: "raw_bulk",
    ...over,
  };
}

function block(over: Partial<Record<string, unknown>> = {}) {
  return {
    sheet: "S1",
    brandCode: "EXP",
    productCode: null,
    productName: "",
    productSpec: "",
    versionMarker: "none",
    barcode: null,
    ambiguous: false,
    lines: [],
    feeLines: [],
    ...over,
  };
}

async function seedReleasedSpu(
  db: TestDb,
  jobId: number,
  members: string[],
): Promise<number> {
  const [spu] = await db
    .insert(schema.spus)
    .values({ code: `P${String(jobId).padStart(5, "0")}`, nameCn: `任务 ${jobId}` })
    .returning();
  await db.insert(schema.stagingRows).values({
    importJobId: jobId,
    rowNo: 900,
    targetTable: "spu_suggestion",
    payload: {
      spuKey: `JOB-${jobId}`,
      suggestedName: `任务 ${jobId}`,
      members,
      confidence: "auto",
      reasons: [],
    },
    status: "committed",
    targetId: spu.id,
  });
  return spu.id;
}

describe("BOM SKU 身份模式", () => {
  it("new_master：dry-run 不取号；S1、legacy INTERNAL 标识和审计同事务落地；重放不重复", async () => {
    const { db } = await createTestDb();
    const jobId = await seedJob(db, "new_master");
    await seedReleasedSpu(db, jobId, ["NEW-001"]);
    await writeStagingRows(db, jobId, [{
      rowNo: 1,
      targetTable: "bom_block",
      payload: block({
        productCode: "NEW-001",
        productName: "新主档成品",
        productSpec: "30ml",
        lines: [line({
          materialCode: "NEW-001-0101",
          materialName: "新主档原料",
          materialSpec: "食品级",
        })],
      }),
    }]);

    const preview = await releaseSkus(operator, { jobIds: [jobId], dryRun: true }, db);
    expect(preview.identityMode).toBe("new_master");
    expect(preview.createdCodes).toEqual([]);
    expect(preview.plannedSourceCodes).toEqual(["NEW-001", "NEW-001-0101"]);
    expect(preview.identityMappings).toEqual([
      { sourceCode: "NEW-001", skuCode: null, skuId: null, kind: "finished" },
      { sourceCode: "NEW-001-0101", skuCode: null, skuId: null, kind: "material" },
    ]);
    expect(await db.select().from(schema.docCounters)).toHaveLength(0);

    // createdBy is a real FK on sku_identifiers. Failure after S1 allocation proves the whole
    // allocator + SKU + identifier unit rolls back, including the counter.
    await expect(releaseSkus(operator, { jobIds: [jobId], dryRun: false }, db)).rejects.toThrow();
    expect(await db.select().from(schema.skus)).toHaveLength(0);
    expect(await db.select().from(schema.skuIdentifiers)).toHaveLength(0);
    expect(await db.select().from(schema.docCounters)).toHaveLength(0);

    await db.insert(schema.users).values({
      id: operator.id,
      username: "sku-identity-operator",
      name: operator.name,
      roles: operator.roles,
    });
    const released = await releaseSkus(operator, { jobIds: [jobId], dryRun: false }, db);
    expect(released.createdCodes).toHaveLength(2);
    expect(released.identityMappings).toHaveLength(2);
    expect(parseGovernedSkuCode(released.identityMappings[0].skuCode!)).toMatchObject({
      skuType: "finished",
      sequence: 1,
    });
    expect(parseGovernedSkuCode(released.identityMappings[1].skuCode!)).toMatchObject({
      skuType: "raw",
      sequence: 2,
    });
    const identifiers = await db.select().from(schema.skuIdentifiers);
    expect(identifiers.map((row) => [row.kind, row.scope, row.value, row.isPrimary])).toEqual([
      ["legacy", "INTERNAL", "NEW-001", true],
      ["legacy", "INTERNAL", "NEW-001-0101", true],
    ]);
    const [audit] = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.entity, "release_sku"));
    expect(audit.after).toMatchObject({
      identityMode: "new_master",
      identityMappings: released.identityMappings,
    });

    const replay = await releaseSkus(operator, { jobIds: [jobId], dryRun: false }, db);
    expect(replay.createdCodes).toEqual([]);
    expect(replay.identityMappings).toEqual([]);
    expect(replay.existing).toBe(2);
    expect(await db.select().from(schema.skus)).toHaveLength(2);
    expect(await db.select().from(schema.skuIdentifiers)).toHaveLength(2);
  });

  it("historical_preserve：明确保留已建立的来源码，不批量改码或补造 S1", async () => {
    const { db } = await createTestDb();
    await db.insert(schema.users).values({
      id: operator.id,
      username: "sku-history-operator",
      name: operator.name,
      roles: operator.roles,
    });
    const jobId = await seedJob(db, "historical_preserve");
    await seedReleasedSpu(db, jobId, ["N02-003-a"]);
    await writeStagingRows(db, jobId, [{
      rowNo: 1,
      targetTable: "bom_block",
      payload: block({
        productCode: "N02-003-a",
        productName: "历史在用成品",
        productSpec: "100ml",
      }),
    }]);

    const preview = await releaseSkus(operator, { jobIds: [jobId], dryRun: true }, db);
    expect(preview.createdCodes).toEqual(["N02-003-a"]);
    expect(preview.identityMappings).toEqual([]);
    const released = await releaseSkus(operator, { jobIds: [jobId], dryRun: false }, db);
    expect(released.createdCodes).toEqual(["N02-003-a"]);
    expect((await db.select().from(schema.skus))[0].code).toBe("N02-003-a");
    expect(await db.select().from(schema.skuIdentifiers)).toHaveLength(0);
    expect(await db.select().from(schema.docCounters)).toHaveLength(0);
  });

  it("显式 jobIds 缺少身份模式或混合模式时 fail closed；仅显式本地迁移入口保持历史兼容", async () => {
    const { db } = await createTestDb();
    const missing = await seedJob(db);
    const historical = await seedJob(db, "historical_preserve");
    const fresh = await seedJob(db, "new_master");

    await expect(releaseSkus(operator, { jobIds: [missing], dryRun: true }, db))
      .rejects.toThrow("未声明 SKU 身份模式");
    await expect(releaseSkus(operator, { jobIds: [historical, fresh], dryRun: true }, db))
      .rejects.toThrow("混合了历史保留与新主档模式");
    await expect(releaseSkus(operator, { dryRun: true } as never, db))
      .rejects.toThrow("必须显式绑定导入任务");
    const internalPreview = await releaseSkusForLegacyLocalMigration(operator, { dryRun: true }, db);
    expect(internalPreview.identityMode).toBe("historical_preserve");
  });

  it("同源编码的名称/规格/类型冲突以及短数字、斜杠组合码在 dry-run 与执行中一致阻断", async () => {
    const { db } = await createTestDb();
    await db.insert(schema.users).values({
      id: operator.id,
      username: "sku-conflict-operator",
      name: operator.name,
      roles: operator.roles,
    });
    const jobId = await seedJob(db, "new_master");
    await seedReleasedSpu(db, jobId, ["DUP-001"]);
    await writeStagingRows(db, jobId, [
      {
        rowNo: 1,
        targetTable: "bom_block",
        payload: block({
          productCode: "DUP-001",
          productName: "冲突名称 A",
          productSpec: "30ml",
          lines: [
            line({ materialCode: "76", materialName: "短数字料" }),
            line({ materialCode: "RAW/BOX", materialName: "组合料" }),
            line({ materialCode: "MIX-001", materialName: "混合料", segment: "raw_bulk" }),
          ],
        }),
      },
      {
        rowNo: 2,
        targetTable: "bom_block",
        payload: block({
          productCode: "DUP-001",
          productName: "冲突名称 B",
          productSpec: "50ml",
          lines: [
            line({ materialCode: "MIX-001", materialName: "混合料", segment: "primary_pack" }),
          ],
        }),
      },
    ]);

    const preview = await releaseSkus(operator, { jobIds: [jobId], dryRun: true }, db);
    const released = await releaseSkus(operator, { jobIds: [jobId], dryRun: false }, db);
    const summary = (result: typeof preview) => result.blocked
      .map(({ code, reason }) => [code, reason])
      .sort(([a], [b]) => a.localeCompare(b));
    expect(summary(released)).toEqual(summary(preview));
    expect(preview.blocked.find((item) => item.code === "DUP-001")?.reason).toMatch(/不同名称.*不同规格/);
    expect(preview.blocked.find((item) => item.code === "MIX-001")?.reason).toContain("不同类型");
    expect(preview.blocked.find((item) => item.code === "76")?.reason).toContain("裸短数字");
    expect(preview.blocked.find((item) => item.code === "RAW/BOX")?.reason).toContain("斜杠组合码");
    expect(await db.select().from(schema.skus)).toHaveLength(0);
  });

  it("显式任务还必须是已完成 BOM；new_master 在解析既有码前先拒绝 S1 来源", async () => {
    const { db } = await createTestDb();
    const [wrongTemplate, unfinished] = await db.insert(schema.importJobs).values([
      {
        template: "inventory",
        filename: "wrong.xlsx",
        status: "done",
        scope: { identityMode: "new_master" },
        createdBy: operator.id,
      },
      {
        template: "bom",
        filename: "pending.xlsx",
        status: "pending",
        scope: { identityMode: "new_master" },
        createdBy: operator.id,
      },
    ]).returning();
    await expect(releaseSkus(operator, { jobIds: [wrongTemplate.id], dryRun: true }, db))
      .rejects.toThrow("不是 BOM 模板");
    await expect(releaseSkus(operator, { jobIds: [unfinished.id], dryRun: true }, db))
      .rejects.toThrow("尚未解析完成");

    const jobId = await seedJob(db, "new_master");
    const [spu] = await db.insert(schema.spus).values({ code: "P99001", nameCn: "伪造 S1" }).returning();
    await db.insert(schema.skus).values({
      code: "S1-GEN-FG-000001-00",
      name: "伪造 S1",
      spuId: spu.id,
      skuType: "finished",
      baseUom: "件",
    });
    await writeStagingRows(db, jobId, [{
      rowNo: 1,
      targetTable: "bom_block",
      payload: block({
        productCode: "S1-GEN-FG-000001-00",
        productName: "伪造 S1",
      }),
    }]);
    const result = await releaseSkus(operator, { jobIds: [jobId], dryRun: true }, db);
    expect(result.existing).toBe(0);
    expect(result.blocked[0].reason).toContain("S1 系统命名空间");
  });

  it("生产解析只接受 canonical/GLOBAL/INTERNAL legacy；歧义显式阻断，外部 scope 不串主档", async () => {
    const { db } = await createTestDb();
    const [spu] = await db.insert(schema.spus).values({ code: "P99002", nameCn: "身份歧义" }).returning();
    const [canonical, legacyOwner, externalOwner] = await db.insert(schema.skus).values([
      { code: "AMB-001", name: "主码", spuId: spu.id, skuType: "finished", baseUom: "件" },
      { code: "OTHER-001", name: "历史码归属", spuId: spu.id, skuType: "finished", baseUom: "件" },
      { code: "OTHER-002", name: "外部码归属", spuId: spu.id, skuType: "finished", baseUom: "件" },
    ]).returning();
    await db.insert(schema.skuIdentifiers).values([
      { skuId: legacyOwner.id, kind: "legacy", value: "AMB-001", scope: "INTERNAL", active: true },
      { skuId: externalOwner.id, kind: "external", value: "EXT-ONLY", scope: "JST", active: true },
    ]);
    const jobId = await seedJob(db, "new_master");
    await seedReleasedSpu(db, jobId, ["AMB-001", "EXT-ONLY"]);
    await writeStagingRows(db, jobId, [
      {
        rowNo: 1,
        targetTable: "bom_block",
        payload: block({ productCode: "AMB-001", productName: canonical.name }),
      },
      {
        rowNo: 2,
        targetTable: "bom_block",
        payload: block({ productCode: "EXT-ONLY", productName: "新成品" }),
      },
    ]);
    const result = await releaseSkus(operator, { jobIds: [jobId], dryRun: true }, db);
    expect(result.blocked.find((item) => item.code === "AMB-001")?.reason).toContain("INTERNAL 身份歧义");
    expect(result.plannedSourceCodes).toContain("EXT-ONLY");
    expect(result.existing).toBe(0);
  });

  it("BOM 不能绕过 SKU 身份放行；有效 GTIN 注册 GS1，重复与坏校验位阻断", async () => {
    const { db } = await createTestDb();
    await db.insert(schema.users).values({
      id: operator.id,
      username: "sku-gtin-operator",
      name: operator.name,
      roles: operator.roles,
    });
    const jobId = await seedJob(db, "new_master");
    await seedReleasedSpu(db, jobId, ["GTIN-001"]);
    await writeStagingRows(db, jobId, [{
      rowNo: 1,
      targetTable: "bom_block",
      payload: block({
        productCode: "GTIN-001",
        productName: "带条码成品",
        barcode: "4006381333931",
        lines: [line({ materialCode: "GTIN-001-R", materialName: "原料" })],
      }),
    }]);

    const bypass = await releaseBoms(operator, { jobIds: [jobId], dryRun: true }, db);
    expect(bypass.created).toBe(0);
    expect(bypass.blocked[0].reason).toContain("先完成 SKU 身份放行");

    await releaseSkus(operator, { jobIds: [jobId], dryRun: false }, db);
    const [gtin] = await db.select().from(schema.skuIdentifiers).where(eq(schema.skuIdentifiers.kind, "gtin"));
    expect(gtin).toMatchObject({
      value: "4006381333931",
      scope: "GS1",
      packagingLevel: "each",
      isPrimary: true,
      active: true,
    });
    const [product] = await db.select().from(schema.skus).where(eq(schema.skus.barcode, "4006381333931"));
    expect(product.barcodeStatus).toBe("valid");
    const bomPreview = await releaseBoms(operator, { jobIds: [jobId], dryRun: true }, db);
    expect(bomPreview.created).toBe(1);

    const unrelatedJob = await seedJob(db, "historical_preserve");
    await writeStagingRows(db, unrelatedJob, [{
      rowNo: 1,
      targetTable: "bom_block",
      payload: block({
        productCode: "GTIN-001",
        productName: "带条码成品",
        lines: [line({ materialCode: "GTIN-001-R", materialName: "原料" })],
      }),
    }]);
    const crossJobBypass = await releaseBoms(operator, { jobIds: [unrelatedJob], dryRun: true }, db);
    expect(crossJobBypass.created).toBe(0);
    expect(crossJobBypass.blocked[0].reason).toContain("先完成 SKU 身份放行");

    const secondJob = await seedJob(db, "new_master");
    await seedReleasedSpu(db, secondJob, ["GTIN-002", "GTIN-003"]);
    await writeStagingRows(db, secondJob, [
      {
        rowNo: 1,
        targetTable: "bom_block",
        payload: block({ productCode: "GTIN-002", productName: "重复条码", barcode: "4006381333931" }),
      },
      {
        rowNo: 2,
        targetTable: "bom_block",
        payload: block({ productCode: "GTIN-003", productName: "坏条码", barcode: "4006381333932" }),
      },
    ]);
    const conflicts = await releaseSkus(operator, { jobIds: [secondJob], dryRun: true }, db);
    expect(conflicts.blocked.find((item) => item.code === "GTIN-002")?.reason).toContain("已归属 SKU");
    expect(conflicts.blocked.find((item) => item.code === "GTIN-003")?.reason).toContain("校验位无效");
  });

  it("跨品牌共享物料统一使用 GEN 来源，不受首行品牌顺序影响", async () => {
    const { db } = await createTestDb();
    await db.insert(schema.users).values({
      id: operator.id,
      username: "sku-shared-origin-operator",
      name: operator.name,
      roles: operator.roles,
    });
    const jobId = await seedJob(db, "new_master");
    await seedReleasedSpu(db, jobId, ["EXP-NEW", "NING-NEW"]);
    await writeStagingRows(db, jobId, [
      {
        rowNo: 1,
        targetTable: "bom_block",
        payload: block({
          brandCode: "EXP",
          productCode: "EXP-NEW",
          productName: "EXP 新品",
          lines: [line({ materialCode: "SHARED-R", materialName: "共享原料" })],
        }),
      },
      {
        rowNo: 2,
        targetTable: "bom_block",
        payload: block({
          brandCode: "NING",
          productCode: "NING-NEW",
          productName: "NING 新品",
          lines: [line({ materialCode: "SHARED-R", materialName: "共享原料" })],
        }),
      },
    ]);
    const released = await releaseSkus(operator, { jobIds: [jobId], dryRun: false }, db);
    const shared = released.identityMappings.find((mapping) => mapping.sourceCode === "SHARED-R");
    expect(parseGovernedSkuCode(shared!.skuCode!)).toMatchObject({ origin: "GEN", skuType: "raw" });
  });

  it("停用 INTERNAL 历史标识与停用 GTIN 均保留身份，dry-run 不得重用", async () => {
    const { db } = await createTestDb();
    const jobId = await seedJob(db, "new_master");
    const [spu] = await db.insert(schema.spus).values({ code: "P99101", nameCn: "保留身份" }).returning();
    const [owner] = await db.insert(schema.skus).values({
      code: "OWNER-RESERVED",
      name: "保留归属",
      spuId: spu.id,
      skuType: "finished",
      baseUom: "件",
    }).returning();
    await db.insert(schema.skuIdentifiers).values([
      {
        skuId: owner.id,
        kind: "legacy",
        value: "RESERVED-SOURCE",
        scope: "INTERNAL",
        active: false,
      },
      {
        skuId: owner.id,
        kind: "gtin",
        value: "4006381333931",
        scope: "GS1",
        packagingLevel: "each",
        active: false,
      },
    ]);
    await seedReleasedSpu(db, jobId, ["RESERVED-SOURCE", "NEW-GTIN"]);
    await writeStagingRows(db, jobId, [
      {
        rowNo: 1,
        targetTable: "bom_block",
        payload: block({ productCode: "RESERVED-SOURCE", productName: "重用历史码" }),
      },
      {
        rowNo: 2,
        targetTable: "bom_block",
        payload: block({ productCode: "NEW-GTIN", productName: "重用停用 GTIN", barcode: "4006381333931" }),
      },
    ]);

    const preview = await releaseSkus(operator, { jobIds: [jobId], dryRun: true }, db);
    expect(preview.blocked.find((item) => item.code === "RESERVED-SOURCE")?.reason).toContain("历史标识已停用");
    expect(preview.blocked.find((item) => item.code === "NEW-GTIN")?.reason).toContain("GTIN 4006381333931 已停用");
  });

  it("已有 SKU 也验证 GTIN：无主 GTIN 则登记，同主已有则 no-op，坏码与他主归属阻断", async () => {
    const { db } = await createTestDb();
    await db.insert(schema.users).values({
      id: operator.id,
      username: "sku-existing-gtin-operator",
      name: operator.name,
      roles: operator.roles,
    });
    const jobId = await seedJob(db, "new_master");
    const [spu] = await db.insert(schema.spus).values({ code: "P99102", nameCn: "已有 GTIN" }).returning();
    const [invalid, register, noop, otherOwner, collide] = await db.insert(schema.skus).values([
      { code: "EXIST-INVALID", name: "坏码", spuId: spu.id, skuType: "finished", baseUom: "件" },
      { code: "EXIST-REGISTER", name: "待登记", spuId: spu.id, skuType: "finished", baseUom: "件" },
      { code: "EXIST-NOOP", name: "已登记", spuId: spu.id, skuType: "finished", baseUom: "件", barcode: "4006381333931", barcodeStatus: "valid" },
      { code: "OTHER-OWNER", name: "他主", spuId: spu.id, skuType: "finished", baseUom: "件", barcode: "5901234123457", barcodeStatus: "valid" },
      { code: "EXIST-COLLIDE", name: "冲突码", spuId: spu.id, skuType: "finished", baseUom: "件" },
    ]).returning();
    await db.insert(schema.skuIdentifiers).values([
      { skuId: noop.id, kind: "gtin", value: "4006381333931", scope: "GS1", packagingLevel: "each", isPrimary: true, active: true },
      { skuId: otherOwner.id, kind: "gtin", value: "5901234123457", scope: "GS1", packagingLevel: "each", isPrimary: true, active: true },
    ]);
    await writeStagingRows(db, jobId, [
      { rowNo: 1, targetTable: "bom_block", payload: block({ productCode: invalid.code, productName: invalid.name, barcode: "4006381333932" }) },
      { rowNo: 2, targetTable: "bom_block", payload: block({ productCode: register.code, productName: register.name, barcode: "5012345678900" }) },
      { rowNo: 3, targetTable: "bom_block", payload: block({ productCode: noop.code, productName: noop.name, barcode: "4006381333931" }) },
      { rowNo: 4, targetTable: "bom_block", payload: block({ productCode: collide.code, productName: collide.name, barcode: "5901234123457" }) },
    ]);

    const preview = await releaseSkus(operator, { jobIds: [jobId], dryRun: true }, db);
    expect(preview.blocked.find((item) => item.code === invalid.code)?.reason).toContain("校验位无效");
    expect(preview.blocked.find((item) => item.code === collide.code)?.reason).toContain(`已归属 SKU #${otherOwner.id}`);
    const before = await db.select().from(schema.skuIdentifiers);
    await releaseSkus(operator, { jobIds: [jobId], dryRun: false }, db);
    const after = await db.select().from(schema.skuIdentifiers);
    expect(after).toHaveLength(before.length + 1);
    expect(after.find((item) => item.skuId === register.id && item.kind === "gtin")).toMatchObject({
      value: "5012345678900",
      packagingLevel: "each",
      isPrimary: true,
      active: true,
    });
    const [synced] = await db.select().from(schema.skus).where(eq(schema.skus.id, register.id));
    expect(synced).toMatchObject({ barcode: "5012345678900", barcodeStatus: "valid" });
  });

  it("new_master 只用解析后品牌主档编码取号；未解析品牌阻断", async () => {
    const { db } = await createTestDb();
    await db.insert(schema.users).values({
      id: operator.id,
      username: "sku-canonical-brand-operator",
      name: operator.name,
      roles: operator.roles,
    });
    const jobId = await seedJob(db, "new_master");
    const [exp] = await db.select().from(schema.brands).where(eq(schema.brands.code, "EXP"));
    await db.insert(schema.aliases).values({
      aliasType: "brand",
      scope: "GLOBAL",
      rawValue: "EXP ALIAS",
      targetId: exp.id,
    });
    await seedReleasedSpu(db, jobId, ["ALIAS-PRODUCT", "UNKNOWN-BRAND"]);
    await writeStagingRows(db, jobId, [
      {
        rowNo: 1,
        targetTable: "bom_block",
        payload: block({ brandCode: "EXP ALIAS", productCode: "ALIAS-PRODUCT", productName: "别名品牌" }),
      },
      {
        rowNo: 2,
        targetTable: "bom_block",
        payload: block({ brandCode: "UNKNOWN", productCode: "UNKNOWN-BRAND", productName: "未解析品牌" }),
      },
    ]);

    const released = await releaseSkus(operator, { jobIds: [jobId], dryRun: false }, db);
    const aliasProduct = released.identityMappings.find((item) => item.sourceCode === "ALIAS-PRODUCT");
    expect(parseGovernedSkuCode(aliasProduct!.skuCode!)).toMatchObject({ origin: "EXP", skuType: "finished" });
    expect(released.blocked.find((item) => item.code === "UNKNOWN-BRAND")?.reason).toContain("未能唯一解析");
  });
});
