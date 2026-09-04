/**
 * 种子数据（幂等：按唯一键先查后插，可重复执行）
 * 运行：npm run db:seed（需 DATABASE_URL 与 SEED_ADMIN_PASSWORD）
 */
import { and, eq, isNull } from "drizzle-orm";
import { hash } from "@node-rs/argon2";
import { getDbAsync, schema } from "./index";
import { seedDimensions } from "./seed-dimensions";
import type { Role } from "@/server/core/constants";
import { todayShanghai } from "@/server/core/business-day";

// tsx 不自动加载 .env
try {
  process.loadEnvFile?.();
} catch {
  /* .env 不存在时忽略 */
}

const counts: Record<string, { inserted: number; skipped: number }> = {};
function bump(table: string, inserted: boolean) {
  counts[table] ??= { inserted: 0, skipped: 0 };
  counts[table][inserted ? "inserted" : "skipped"]++;
}

async function main() {
  const db = await getDbAsync();
  const password = process.env.SEED_ADMIN_PASSWORD?.trim();
  if (!password) {
    throw new Error("缺少 SEED_ADMIN_PASSWORD：拒绝以公开默认口令创建账号");
  }
  if (password.length < 12) {
    throw new Error("SEED_ADMIN_PASSWORD 至少需要 12 个字符");
  }
  const passwordHash = await hash(password);

  // ---------- 用户 ----------
  const userSeeds: { username: string; name: string; roles: Role[]; isApprover: boolean }[] = [
    { username: "admin", name: "系统管理员", roles: ["admin"], isApprover: true },
    { username: "ops01", name: "运营01", roles: ["ops"], isApprover: false },
    { username: "purchasing01", name: "采购01", roles: ["purchasing"], isApprover: true },
    { username: "warehouse01", name: "仓管01", roles: ["warehouse"], isApprover: true },
    { username: "warehouse02", name: "仓管02", roles: ["warehouse"], isApprover: true },
    { username: "quality01", name: "质量合规01", roles: ["quality"], isApprover: true },
    { username: "pmc01", name: "生产计划01", roles: ["pmc"], isApprover: true },
    { username: "finance01", name: "财务01", roles: ["finance"], isApprover: true },
    // 制单人（非审批人）：用于演示 审批人≠制单人 的职责分离
    { username: "pmc02", name: "生产计划02", roles: ["pmc"], isApprover: false },
  ];
  for (const u of userSeeds) {
    const [exists] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, u.username));
    if (exists) {
      bump("users", false);
      continue;
    }
    await db.insert(schema.users).values({
      ...u,
      passwordHash,
      active: true,
      // 所有种子账号共享同一初始口令，只能作为一次性引导凭证。
      mustChangePassword: true,
    });
    bump("users", true);
  }

  // ---------- 审批配置（《01》§6 默认表，单一权威） ----------
  const approvalSeeds: [string, Role][] = [
    ["bh", "pmc"],
    ["wo", "pmc"],
    ["bom", "pmc"],
    ["po", "purchasing"],
    ["pc", "purchasing"],
    ["fl", "warehouse"],
    ["tl", "warehouse"],
    ["sh", "warehouse"],
    ["ct", "warehouse"],
    ["stock_doc", "warehouse"],
    ["jg", "pmc"],
    ["opening", "finance"],
    ["count", "finance"],
    ["js", "finance"],
  ];
  for (const [docType, approverRole] of approvalSeeds) {
    const [exists] = await db
      .select({ id: schema.approvalConfigs.id })
      .from(schema.approvalConfigs)
      .where(eq(schema.approvalConfigs.docType, docType));
    if (exists) {
      bump("approval_configs", false);
      continue;
    }
    await db.insert(schema.approvalConfigs).values({ docType, approverRole });
    bump("approval_configs", true);
  }

  // ---------- 系统参数 ----------
  const paramSeeds: [string, string, string, string | null][] = [
    ["global", "price_tolerance_pct", "3", "价格异动容差%（R1）"],
    ["global", "over_receive_tolerance_pct", "0", "超收容差%（R4）"],
    ["global", "concession_price_ratio", "100", "让步默认价率%（D6 待财务确认）"],
    ["global", "batch_posting_enabled", "0", "批次过账与 FEFO 闸门（迁移/UAT 完成前保持关闭）"],
    ["category:packaging", "loss_rate_pct", "5", "包材品类允许损耗率%（R2）"],
    ["category:raw", "loss_rate_pct", "2", "原料品类允许损耗率%（D5 待定）"],
  ];
  for (const [scope, key, value, note] of paramSeeds) {
    const [exists] = await db
      .select({ id: schema.sysParams.id })
      .from(schema.sysParams)
      .where(and(eq(schema.sysParams.scope, scope), eq(schema.sysParams.key, key)));
    if (exists) {
      bump("sys_params", false);
      continue;
    }
    await db.insert(schema.sysParams).values({ scope, key, value, note });
    bump("sys_params", true);
  }

  // ---------- 分类 ----------
  const categoryIds: Record<string, number> = {};
  for (const name of ["食品", "包装"]) {
    const [exists] = await db
      .select()
      .from(schema.categories)
      .where(and(eq(schema.categories.name, name), isNull(schema.categories.parentId)));
    if (exists) {
      categoryIds[name] = exists.id;
      bump("categories", false);
      continue;
    }
    const [created] = await db.insert(schema.categories).values({ name, level: 1 }).returning();
    categoryIds[name] = created.id;
    bump("categories", true);
  }

  // ---------- SPU ----------
  const spuSeeds = [
    { code: "P00001", nameCn: "胶原蛋白肽饮品", nameEn: "Collagen Peptide Drink", categoryId: categoryIds["食品"] },
    { code: "P00002", nameCn: "复合果汁饮品", nameEn: "Mixed Juice Drink", categoryId: categoryIds["食品"] },
  ];
  const spuIds: Record<string, number> = {};
  for (const s of spuSeeds) {
    const [exists] = await db.select().from(schema.spus).where(eq(schema.spus.code, s.code));
    if (exists) {
      spuIds[s.code] = exists.id;
      bump("spus", false);
      continue;
    }
    const [created] = await db.insert(schema.spus).values(s).returning();
    spuIds[s.code] = created.id;
    bump("spus", true);
  }

  // ---------- SKU（原料/包材演示数据挂在成品 SPU P00001 下，spec 承载物料名） ----------
  const skuSeeds = [
    { code: "CP00001", name: "胶原蛋白肽饮品 50ml×10", spuId: spuIds["P00001"], skuType: "finished" as const, baseUom: "盒", spec: "50ml×10", lossCategory: null },
    { code: "YL00001", name: "胶原蛋白肽粉", spuId: spuIds["P00001"], skuType: "raw" as const, baseUom: "kg", spec: "食品级", lossCategory: "raw" },
    { code: "BC00001", name: "瓶身50ml", spuId: spuIds["P00001"], skuType: "packaging" as const, baseUom: "个", spec: "PET", lossCategory: "packaging" },
    { code: "BC00002", name: "彩盒", spuId: spuIds["P00001"], skuType: "packaging" as const, baseUom: "个", spec: "350g白卡", lossCategory: "packaging" },
  ];
  const skuIds: Record<string, number> = {};
  for (const s of skuSeeds) {
    const [exists] = await db.select().from(schema.skus).where(eq(schema.skus.code, s.code));
    if (exists) {
      skuIds[s.code] = exists.id;
      bump("skus", false);
      continue;
    }
    const [created] = await db.insert(schema.skus).values(s).returning();
    skuIds[s.code] = created.id;
    bump("skus", true);
  }

  // ---------- 供应商 ----------
  const supplierSeeds = [
    { code: "SUP001", name: "原料供应商A", kinds: ["raw"], status: "qualified" as const },
    { code: "SUP002", name: "包材供应商B", kinds: ["packaging"], status: "qualified" as const },
    { code: "SUP003", name: "加工厂C", kinds: ["processor"], status: "qualified" as const },
  ];
  const supplierIds: Record<string, number> = {};
  for (const s of supplierSeeds) {
    const [exists] = await db.select().from(schema.suppliers).where(eq(schema.suppliers.code, s.code));
    if (exists) {
      supplierIds[s.code] = exists.id;
      bump("suppliers", false);
      continue;
    }
    const [created] = await db.insert(schema.suppliers).values(s).returning();
    supplierIds[s.code] = created.id;
    bump("suppliers", true);
  }

  // ---------- 仓库 ----------
  const warehouseSeeds = [
    { code: "WH-CP", name: "成品仓", kind: "finished" as const, supplierId: null },
    { code: "WH-YL", name: "原料仓", kind: "raw" as const, supplierId: null },
    { code: "WH-BC", name: "包材仓", kind: "packaging" as const, supplierId: null },
    { code: "WH-WX-SUP003", name: "委外仓-加工厂C", kind: "outsource" as const, supplierId: supplierIds["SUP003"] },
    { code: "WH-ZT", name: "调拨在途", kind: "transit" as const, supplierId: null },
  ];
  for (const w of warehouseSeeds) {
    const [exists] = await db.select({ id: schema.warehouses.id }).from(schema.warehouses).where(eq(schema.warehouses.code, w.code));
    if (exists) {
      bump("warehouses", false);
      continue;
    }
    await db.insert(schema.warehouses).values({ ...w, accountingMode: "realtime" });
    bump("warehouses", true);
  }

  // ---------- 价格表（R1 基准兜底：生效日≤今日的最新行） ----------
  const priceSeeds: [string, string, string, string][] = [
    // [skuCode, supplierCode, price(基础单位未税), effectiveDate]
    ["YL00001", "SUP001", "120.00", "2026-01-01"],
    ["BC00001", "SUP002", "0.45", "2026-01-01"],
    ["BC00002", "SUP002", "1.20", "2026-01-01"],
  ];
  for (const [skuCode, supCode, price, effectiveDate] of priceSeeds) {
    const skuId = skuIds[skuCode];
    const supplierId = supplierIds[supCode];
    const [exists] = await db
      .select({ id: schema.priceLists.id })
      .from(schema.priceLists)
      .where(
        and(
          eq(schema.priceLists.skuId, skuId),
          eq(schema.priceLists.supplierId, supplierId),
          eq(schema.priceLists.effectiveDate, effectiveDate),
        ),
      );
    if (exists) {
      bump("price_lists", false);
      continue;
    }
    await db.insert(schema.priceLists).values({ skuId, supplierId, price, effectiveDate });
    bump("price_lists", true);
  }

  // ---------- BOM（CP00001 V1 生效） ----------
  const productSkuId = skuIds["CP00001"];
  const [bomExists] = await db
    .select({ id: schema.boms.id })
    .from(schema.boms)
    .where(and(eq(schema.boms.productSkuId, productSkuId), eq(schema.boms.versionNo, "V1")));
  if (bomExists) {
    bump("boms", false);
  } else {
    await db.transaction(async (tx) => {
      const [bom] = await tx
        .insert(schema.boms)
        .values({ productSkuId, versionNo: "V1", status: "active", effectiveDate: todayShanghai() })
        .returning();
      await tx.insert(schema.bomLines).values([
        { bomId: bom.id, materialSkuId: skuIds["YL00001"], qtyPer: "0.05", lossRatePct: "2" },
        { bomId: bom.id, materialSkuId: skuIds["BC00001"], qtyPer: "10", lossRatePct: "5" },
        { bomId: bom.id, materialSkuId: skuIds["BC00002"], qtyPer: "1", lossRatePct: "5" },
      ]);
    });
    bump("boms", true);
    counts["bom_lines"] = { inserted: 3, skipped: 0 };
  }

  // ---------- 单位换算（R11：MOQ/订货倍数） ----------
  const uomSeeds: { skuCode: string; purchaseUom: string; factor: string; moq: string | null; orderMultiple: string | null }[] = [
    { skuCode: "YL00001", purchaseUom: "袋", factor: "25", moq: "50", orderMultiple: "25" },
    { skuCode: "BC00001", purchaseUom: "箱", factor: "1000", moq: null, orderMultiple: "1000" },
  ];
  for (const u of uomSeeds) {
    const skuId = skuIds[u.skuCode];
    const [exists] = await db
      .select({ id: schema.uomConvs.id })
      .from(schema.uomConvs)
      .where(and(eq(schema.uomConvs.skuId, skuId), eq(schema.uomConvs.purchaseUom, u.purchaseUom)));
    if (exists) {
      bump("uom_convs", false);
      continue;
    }
    await db.insert(schema.uomConvs).values({ skuId, purchaseUom: u.purchaseUom, factor: u.factor, moq: u.moq, orderMultiple: u.orderMultiple });
    bump("uom_convs", true);
  }

  // ---------- 发布冒烟 PO（R9：详情价格按角色脱敏；草稿不计入在途/审批） ----------
  // 固定自然键让重复 seed 幂等；单据与行分别补齐，亦可修复上次中断留下的半成品。
  const smokePoDocNo = "PO-SEED-0001";
  const [adminUser] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, "admin"));
  if (!adminUser) throw new Error("种子管理员不存在，无法创建发布冒烟 PO");

  let [smokePo] = await db
    .select({ id: schema.poDocs.id })
    .from(schema.poDocs)
    .where(eq(schema.poDocs.docNo, smokePoDocNo));
  if (smokePo) {
    bump("po_docs", false);
  } else {
    [smokePo] = await db
      .insert(schema.poDocs)
      .values({
        docNo: smokePoDocNo,
        status: "draft",
        supplierId: supplierIds["SUP001"],
        createdBy: adminUser.id,
        remark: "发布冒烟：验证 PO 详情价格按角色脱敏",
      })
      .returning({ id: schema.poDocs.id });
    bump("po_docs", true);
  }

  const [smokePoLine] = await db
    .select({ id: schema.poLines.id })
    .from(schema.poLines)
    .where(and(eq(schema.poLines.poId, smokePo.id), eq(schema.poLines.skuId, skuIds["YL00001"])));
  if (smokePoLine) {
    bump("po_lines", false);
  } else {
    await db.insert(schema.poLines).values({
      poId: smokePo.id,
      skuId: skuIds["YL00001"],
      lineType: "raw",
      purchaseUom: "袋",
      uomFactor: "25",
      qty: "2",
      price: "3000.00",
      taxIncluded: false,
      taxRatePct: "13",
    });
    bump("po_lines", true);
  }

  // ---------- DW1 维度（品牌/渠道/别名，幂等模块化——见 seed-dimensions.ts） ----------
  const dimCounts = await seedDimensions(db);
  for (const [table, c] of Object.entries(dimCounts)) {
    counts[table] ??= { inserted: 0, skipped: 0 };
    counts[table].inserted += c.inserted;
    counts[table].skipped += c.skipped;
  }

  // ---------- 汇总 ----------
  console.log("种子数据执行完成：");
  for (const [table, c] of Object.entries(counts)) {
    console.log(`  ${table}: 新增 ${c.inserted}，已存在跳过 ${c.skipped}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("种子数据执行失败:", e);
    process.exit(1);
  });
