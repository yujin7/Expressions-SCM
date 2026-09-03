/**
 * 总监需求实施计划共享基座（D50–D66）schema 契约：
 * 迁移 0047_director_program 可在 PGlite 上应用；每张新表能写入、CHECK/UNIQUE/自引用按设计拒绝；
 * 常量清单（src/lib/transfer-types.ts、core/constants ROLES）与迁移 SQL 里的 CHECK 逐一对得上。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  channels,
  dataQualityReviews,
  departmentGoals,
  opsDemandSubmissions,
  opsPlanEvents,
  salesAmountMonthly,
  skuParams,
  skuPlanningPolicy,
  skus,
  spus,
  stockDocs,
  suppliers,
  transferFees,
  userDataScopes,
  users,
  workItems,
} from "@/db/schema";
import { ROLES } from "@/server/core/constants";
import { TRANSFER_TYPES, TRANSFER_TYPE_LABELS, isTransferType } from "@/lib/transfer-types";
import { createTestDb, type TestDb } from "../helpers/db";

const MIGRATION = readFileSync(path.resolve(__dirname, "../../drizzle/0047_director_program.sql"), "utf8");

/** drizzle-pglite 把约束错误包成 "Failed query"，约束名在 cause.message */
const violates = (re: RegExp) => ({ cause: { message: expect.stringMatching(re) } });

async function seed(db: TestDb) {
  const [user] = await db.insert(users).values({ name: "基座测试员", roles: ["admin"] }).returning();
  const [spu] = await db.insert(spus).values({ code: "P47001", nameCn: "基座测试品" }).returning();
  const [sku] = await db.insert(skus).values({ code: "D47001", name: "基座测试 SKU", spuId: spu.id, baseUom: "支", skuType: "finished" }).returning();
  const [channel] = await db.insert(channels).values({ code: "TMALL47", name: "天猫", kind: "platform" }).returning();
  const [doc] = await db.insert(stockDocs).values({ docNo: "DB47000001", subtype: "transfer", createdBy: user.id, transferType: "inter_warehouse" }).returning();
  return { user, spu, sku, channel, doc };
}

describe("0047_director_program：迁移与常量清单一致", () => {
  it("迁移文件不再重复建 report_read_model_cache（0046 已建，重复即生产失败）", () => {
    expect(MIGRATION).not.toContain('CREATE TABLE "report_read_model_cache"');
  });

  it("stock_docs.transfer_type 的 CHECK 与 src/lib/transfer-types.ts 清单逐项一致，且都有中文标签", () => {
    const m = MIGRATION.match(/"ck_stock_docs_transfer_type" CHECK \([^\n]*?IN \(([^)]*)\)/);
    expect(m, "迁移里找不到 ck_stock_docs_transfer_type").not.toBeNull();
    const inSql = m![1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    expect(inSql).toEqual([...TRANSFER_TYPES]);
    for (const t of TRANSFER_TYPES) expect(TRANSFER_TYPE_LABELS[t]).toMatch(/[一-龥]/);
    expect(isTransferType("borrow")).toBe(true);
    expect(isTransferType("teleport")).toBe(false);
  });

  it("department_goals.dept_key / work_items.owner_role 的 CHECK 与 ROLES 一致", () => {
    for (const name of ["ck_department_goals_dept", "ck_work_items_owner_role"]) {
      const m = MIGRATION.match(new RegExp(`"${name}" CHECK \\([^\n]*?IN \\(([^)]*)\\)`));
      expect(m, `迁移里找不到 ${name}`).not.toBeNull();
      const inSql = m![1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
      expect(inSql).toEqual([...ROLES]);
    }
  });
});

describe("0047_director_program：表能写、约束会拒", () => {
  it("transfer_fees：四类费用、红字必须负额且只能冲一次、原行不得为负", async () => {
    const { db } = await createTestDb();
    const { user, doc } = await seed(db);
    const [fee] = await db.insert(transferFees).values({
      stockDocId: doc.id, feeType: "freight", amount: "120.50", bizDate: "2026-09-01", createdBy: user.id,
    }).returning();
    expect(fee.currency).toBe("CNY");
    expect(fee.source).toBe("manual");
    await expect(db.insert(transferFees).values({
      stockDocId: doc.id, feeType: "tip", amount: "1", bizDate: "2026-09-01", createdBy: user.id,
    })).rejects.toMatchObject(violates(/ck_transfer_fees_type/));
    await expect(db.insert(transferFees).values({
      stockDocId: doc.id, feeType: "freight", amount: "-1", bizDate: "2026-09-01", createdBy: user.id,
    })).rejects.toMatchObject(violates(/ck_transfer_fees_sign/));
    await expect(db.insert(transferFees).values({
      stockDocId: doc.id, feeType: "freight", amount: "120.50", bizDate: "2026-09-02", createdBy: user.id, reversalOfId: fee.id,
    })).rejects.toMatchObject(violates(/ck_transfer_fees_sign/));
    await db.insert(transferFees).values({
      stockDocId: doc.id, feeType: "freight", amount: "-120.50", bizDate: "2026-09-02", createdBy: user.id, reversalOfId: fee.id,
    });
    await expect(db.insert(transferFees).values({
      stockDocId: doc.id, feeType: "freight", amount: "-120.50", bizDate: "2026-09-03", createdBy: user.id, reversalOfId: fee.id,
    })).rejects.toMatchObject(violates(/uq_transfer_fees_reversal_of/));
    await expect(db.insert(transferFees).values({
      stockDocId: doc.id, feeType: "freight", amount: "1", bizDate: "2026-09-01", createdBy: user.id, reversalOfId: 999999,
    })).rejects.toThrow();
  });

  it("stock_docs.transfer_type：可空；清单外值被拒", async () => {
    const { db } = await createTestDb();
    const { user } = await seed(db);
    await db.insert(stockDocs).values({ docNo: "DB47000002", subtype: "transfer", createdBy: user.id });
    await expect(db.insert(stockDocs).values({
      docNo: "DB47000003", subtype: "transfer", createdBy: user.id, transferType: "teleport",
    })).rejects.toMatchObject(violates(/ck_stock_docs_transfer_type/));
  });

  it("sales_amount_monthly：company 不带 scope_id、brand/channel 必带；月份格式；supersedes 单向唯一", async () => {
    const { db } = await createTestDb();
    const { user, channel } = await seed(db);
    const [row] = await db.insert(salesAmountMonthly).values({
      yearMonth: "2026-08", scopeKind: "company", amount: "1234567.89", createdBy: user.id,
    }).returning();
    await db.insert(salesAmountMonthly).values({
      yearMonth: "2026-08", scopeKind: "channel", scopeId: channel.id, amount: "1000.00", source: "prefill_observation", sourceRef: "jdy:tmall_daily:2026-08", createdBy: user.id,
    });
    await expect(db.insert(salesAmountMonthly).values({
      yearMonth: "2026-08", scopeKind: "company", scopeId: 1, amount: "1", createdBy: user.id,
    })).rejects.toMatchObject(violates(/ck_sales_amount_monthly_scope_id/));
    await expect(db.insert(salesAmountMonthly).values({
      yearMonth: "2026-08", scopeKind: "brand", amount: "1", createdBy: user.id,
    })).rejects.toMatchObject(violates(/ck_sales_amount_monthly_scope_id/));
    await expect(db.insert(salesAmountMonthly).values({
      yearMonth: "2026-13", scopeKind: "company", amount: "1", createdBy: user.id,
    })).rejects.toMatchObject(violates(/ck_sales_amount_monthly_ym/));
    await expect(db.insert(salesAmountMonthly).values({
      yearMonth: "2026-08", scopeKind: "company", amount: "1", source: "guess", createdBy: user.id,
    })).rejects.toMatchObject(violates(/ck_sales_amount_monthly_source/));
    await db.insert(salesAmountMonthly).values({
      yearMonth: "2026-08", scopeKind: "company", amount: "1234600.00", supersedesId: row.id, createdBy: user.id,
    });
    await expect(db.insert(salesAmountMonthly).values({
      yearMonth: "2026-08", scopeKind: "company", amount: "1", supersedesId: row.id, createdBy: user.id,
    })).rejects.toMatchObject(violates(/uq_sales_amount_monthly_supersedes/));
  });

  it("user_data_scopes：UNIQUE(user, kind, target)；kind 只认 channel|dept", async () => {
    const { db } = await createTestDb();
    const { user, channel } = await seed(db);
    await db.insert(userDataScopes).values({ userId: user.id, scopeKind: "channel", targetId: channel.id, createdBy: user.id });
    await expect(db.insert(userDataScopes).values({
      userId: user.id, scopeKind: "channel", targetId: channel.id, createdBy: user.id,
    })).rejects.toMatchObject(violates(/uq_user_data_scopes/));
    await expect(db.insert(userDataScopes).values({
      userId: user.id, scopeKind: "brand", targetId: 1, createdBy: user.id,
    })).rejects.toMatchObject(violates(/ck_user_data_scopes_kind/));
  });

  it("work_items：默认 open/normal；done 必带 completed_at、非 done 不得带；owner_role 只认角色", async () => {
    const { db } = await createTestDb();
    const { user } = await seed(db);
    const [item] = await db.insert(workItems).values({
      title: "核对 8 月保税仓快照", assigneeId: user.id, assignerId: user.id, ownerRole: "warehouse", dueDate: "2026-09-10", createdBy: user.id, sourceKind: "alert", sourceRef: "42",
    }).returning();
    expect(item.status).toBe("open");
    expect(item.priority).toBe("normal");
    await expect(db.insert(workItems).values({
      title: "x", assigneeId: user.id, assignerId: user.id, status: "done", createdBy: user.id,
    })).rejects.toMatchObject(violates(/ck_work_items_completed/));
    await expect(db.insert(workItems).values({
      title: "x", assigneeId: user.id, assignerId: user.id, completedAt: new Date(), createdBy: user.id,
    })).rejects.toMatchObject(violates(/ck_work_items_completed/));
    await expect(db.insert(workItems).values({
      title: "x", assigneeId: user.id, assignerId: user.id, ownerRole: "ceo", createdBy: user.id,
    })).rejects.toMatchObject(violates(/ck_work_items_owner_role/));
    await expect(db.insert(workItems).values({
      title: "x", assigneeId: user.id, assignerId: user.id, priority: "urgent", createdBy: user.id,
    })).rejects.toMatchObject(violates(/ck_work_items_priority/));
    await db.update(workItems).set({ status: "done", completedAt: new Date() }).where(sql`${workItems.id} = ${item.id}`);
  });

  it("department_goals：月/季 period；UNIQUE(dept, period, metric)；actual 成对", async () => {
    const { db } = await createTestDb();
    const { user } = await seed(db);
    await db.insert(departmentGoals).values({ deptKey: "pmc", period: "2026-Q3", metricKey: "inventory_sales_ratio", targetValue: "46.0000", direction: "down", createdBy: user.id });
    await db.insert(departmentGoals).values({ deptKey: "pmc", period: "2026-09", metricKey: "inventory_sales_ratio", targetValue: "46.0000", direction: "down", actualValue: "48.1234", actualSource: "auto", createdBy: user.id });
    await expect(db.insert(departmentGoals).values({
      deptKey: "pmc", period: "2026-Q3", metricKey: "inventory_sales_ratio", targetValue: "1", direction: "down", createdBy: user.id,
    })).rejects.toMatchObject(violates(/uq_department_goals/));
    await expect(db.insert(departmentGoals).values({
      deptKey: "pmc", period: "2026-Q5", metricKey: "m", targetValue: "1", direction: "down", createdBy: user.id,
    })).rejects.toMatchObject(violates(/ck_department_goals_period/));
    await expect(db.insert(departmentGoals).values({
      deptKey: "sales", period: "2026-09", metricKey: "m", targetValue: "1", direction: "down", createdBy: user.id,
    })).rejects.toMatchObject(violates(/ck_department_goals_dept/));
    await expect(db.insert(departmentGoals).values({
      deptKey: "pmc", period: "2026-09", metricKey: "m2", targetValue: "1", direction: "down", actualValue: "2", createdBy: user.id,
    })).rejects.toMatchObject(violates(/ck_department_goals_actual_pair/));
  });

  it("sku_planning_policy：UNIQUE(sku, period)；tier 四档、ownership 三值；覆写须带覆写人", async () => {
    const { db } = await createTestDb();
    const { user, sku } = await seed(db);
    const [p] = await db.insert(skuPlanningPolicy).values({
      skuId: sku.id, period: "2026-09", tier: "S", abc: "A", xyz: "X", ownership: "supply_chain_direct",
    }).returning();
    expect(p.pilot).toBe(false);
    await expect(db.insert(skuPlanningPolicy).values({
      skuId: sku.id, period: "2026-09", tier: "A", abc: "A", ownership: "joint_review",
    })).rejects.toMatchObject(violates(/uq_sku_planning_policy_period/));
    await expect(db.insert(skuPlanningPolicy).values({
      skuId: sku.id, period: "2026-10", tier: "D", abc: "C", ownership: "ops_fallback",
    })).rejects.toMatchObject(violates(/ck_sku_planning_policy_tier/));
    await expect(db.insert(skuPlanningPolicy).values({
      skuId: sku.id, period: "2026-10", tier: "C", abc: "C", ownership: "nobody",
    })).rejects.toMatchObject(violates(/ck_sku_planning_policy_ownership/));
    await expect(db.insert(skuPlanningPolicy).values({
      skuId: sku.id, period: "2026-10", tier: "C", abc: "C", ownership: "ops_fallback", overrideTier: "B",
    })).rejects.toMatchObject(violates(/ck_sku_planning_policy_override_pair/));
    await db.insert(skuPlanningPolicy).values({
      skuId: sku.id, period: "2026-10", tier: "C", abc: "C", ownership: "ops_fallback", overrideTier: "B", overrideBy: user.id, overrideNote: "新品试销",
    });
  });

  it("data_quality_reviews：周键 YYYY-Www / 月键 YYYY-MM；UNIQUE 三元；完成必带核对人", async () => {
    const { db } = await createTestDb();
    const { user } = await seed(db);
    await db.insert(dataQualityReviews).values({ periodKind: "week", periodKey: "2026-W36", sourceClass: "rpa_warehouse" });
    await db.insert(dataQualityReviews).values({
      periodKind: "month", periodKey: "2026-08", sourceClass: "external_platform", status: "completed", reviewedBy: user.id, reviewedAt: new Date(), evidence: { matched: 980, total: 1000 },
    });
    await expect(db.insert(dataQualityReviews).values({
      periodKind: "week", periodKey: "2026-W36", sourceClass: "rpa_warehouse",
    })).rejects.toMatchObject(violates(/uq_data_quality_reviews/));
    await expect(db.insert(dataQualityReviews).values({
      periodKind: "week", periodKey: "2026-08", sourceClass: "rpa_warehouse",
    })).rejects.toMatchObject(violates(/ck_data_quality_reviews_key/));
    await expect(db.insert(dataQualityReviews).values({
      periodKind: "month", periodKey: "2026-08", sourceClass: "rpa_warehouse", status: "completed",
    })).rejects.toMatchObject(violates(/ck_data_quality_reviews_reviewed/));
    await expect(db.insert(dataQualityReviews).values({
      periodKind: "month", periodKey: "2026-08", sourceClass: "oracle",
    })).rejects.toMatchObject(violates(/ck_data_quality_reviews_source/));
  });

  it("ops_demand_submissions：qty ≥ 0、月份格式、supersedes 单向；ops_plan_events：sku/spu 至少一个、结束≥开始", async () => {
    const { db } = await createTestDb();
    const { user, sku, spu, channel } = await seed(db);
    const [s1] = await db.insert(opsDemandSubmissions).values({
      skuId: sku.id, channelId: channel.id, period: "2026-10", qty: "1500.0000", basis: "双 11 预估", submittedBy: user.id,
    }).returning();
    await db.insert(opsDemandSubmissions).values({ skuId: sku.id, channelId: channel.id, period: "2026-10", qty: "1800", submittedBy: user.id, supersedesId: s1.id });
    await expect(db.insert(opsDemandSubmissions).values({
      skuId: sku.id, period: "2026-10", qty: "1", submittedBy: user.id, supersedesId: s1.id,
    })).rejects.toMatchObject(violates(/uq_ops_demand_submissions_supersedes/));
    await expect(db.insert(opsDemandSubmissions).values({
      skuId: sku.id, period: "2026-10", qty: "-1", submittedBy: user.id,
    })).rejects.toMatchObject(violates(/ck_ops_demand_submissions_qty/));
    await expect(db.insert(opsDemandSubmissions).values({
      skuId: sku.id, period: "202610", qty: "1", submittedBy: user.id,
    })).rejects.toMatchObject(violates(/ck_ops_demand_submissions_period/));

    await db.insert(opsPlanEvents).values({ spuId: spu.id, channelId: channel.id, kind: "promo", startDate: "2026-11-01", endDate: "2026-11-11", expectedUpliftPct: 200, createdBy: user.id });
    await db.insert(opsPlanEvents).values({ skuId: sku.id, kind: "delist", startDate: "2026-12-01", expectedUpliftPct: -100, createdBy: user.id });
    await expect(db.insert(opsPlanEvents).values({
      channelId: channel.id, kind: "promo", startDate: "2026-11-01", createdBy: user.id,
    })).rejects.toMatchObject(violates(/ck_ops_plan_events_target/));
    await expect(db.insert(opsPlanEvents).values({
      skuId: sku.id, kind: "promo", startDate: "2026-11-11", endDate: "2026-11-01", createdBy: user.id,
    })).rejects.toMatchObject(violates(/ck_ops_plan_events_window/));
    await expect(db.insert(opsPlanEvents).values({
      skuId: sku.id, kind: "party", startDate: "2026-11-11", createdBy: user.id,
    })).rejects.toMatchObject(violates(/ck_ops_plan_events_kind/));
  });

  it("suppliers 账期/产能增列与 sku_params.purchase_lead_days：可空、越界被拒", async () => {
    const { db } = await createTestDb();
    const { sku } = await seed(db);
    const [sup] = await db.insert(suppliers).values({
      code: "S47001", name: "基座测试厂", paymentTermType: "monthly_credit", creditDays: 60, paymentTermEffectiveFrom: "2026-01-01", declaredMonthlyCapacity: "50000.0000", capacityUom: "支", surgeCapacityPct: 30,
    }).returning();
    expect(sup.creditDays).toBe(60);
    await db.insert(suppliers).values({ code: "S47002", name: "空账期厂" });
    await expect(db.insert(suppliers).values({ code: "S47003", name: "x", paymentTermType: "barter" })).rejects.toMatchObject(violates(/ck_suppliers_payment_term_type/));
    await expect(db.insert(suppliers).values({ code: "S47004", name: "x", creditDays: 181 })).rejects.toMatchObject(violates(/ck_suppliers_credit_days/));
    await expect(db.insert(suppliers).values({ code: "S47005", name: "x", surgeCapacityPct: 301 })).rejects.toMatchObject(violates(/ck_suppliers_surge_capacity_pct/));
    await expect(db.insert(suppliers).values({ code: "S47006", name: "x", declaredMonthlyCapacity: "-1" })).rejects.toMatchObject(violates(/ck_suppliers_declared_capacity/));

    await db.insert(skuParams).values({ skuId: sku.id, purchaseLeadDays: 45 });
    await expect(db.update(skuParams).set({ purchaseLeadDays: 366 }).where(sql`${skuParams.skuId} = ${sku.id}`)).rejects.toMatchObject(violates(/ck_sku_params_purchase_lead_days/));
  });
});
