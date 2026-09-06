/**
 * 爆单预警（D56）判定窗口与锚点回归。
 *
 * 生产实测（2026-09-04）：`report/sales-spike.ts` 的重建耗时 490s。原因不是判定规则，
 * 而是取数形状：锚点 `a` 从 `s` 这个 CTE 自己 `max(d)` 推出来，于是 `s` 的 `DISTINCT ON`
 * 必须先对**整批**（68k 行、三个 jsonb 表达式排序）跑完，才轮到 `WHERE s.d > a.d − N` 把
 * 结果裁到 ~12 天。锚点改成一次独立的 `max(...)`、把日期谓词推进 `s` 的 WHERE（DISTINCT ON 之前），
 * 排序集合就只剩窗口内的行。
 *
 * ── 本文件为什么重写（W2 审计）──
 * 上一版声称「同一份种子数据（含窗口外的历史行）产出的读模型与优化前逐字一致」，但它的
 * `HISTORY_DAYS`（2026-05…07）离基线窗口十万八千里，**本来就影响不了任何输出**——那句话是空的。
 * 实测：删掉整条下推谓词，上一版仍是绿的（只有一条源码正则勉强拦住）。
 *
 * ── 关于 `+ 2` 这个余量（实测结论，与审计初判不同）──
 * `windowDays = consecutiveDays + baselineDays + 2`。判定规则只读 `[anchor−(c+b−1), anchor]` 这 c+b 天，
 * 而谓词 `d > anchor − windowDays` admits `d ≥ anchor − (windowDays − 1)`。
 * 因此**任何 ≥ 0 的余量都与输出完全等价**：`+2` 只是两天的余量，`+0` 恰好卡在下界。
 * 变异实测（本文件）：`+2 → +0` **绿**（它确实不改口径，审计所称的"off-by-two 静默丢基线日"不成立），
 * `+2 → −1` **红**（这才是真的丢掉基线首日：baseline 从 10.8571 变成 10.2857）。
 * 所以本文件对这条只做两件事：钉住**下界不能被越过**（−1 变红），以及用一条从规则本身派生的
 * 不变式断言（余量 ≥ 0）拦住"顺手把余量改成负数"——不假装一个等价改写是回归。
 *
 * 现在钉的是**行为**，不是源码字面量：
 *  ① 基线窗口的**两个边界**各放一天可辨认的量：`anchor−9`（基线首日，必须进）与 `anchor−10`
 *     （基线前一天，必须不进）。窗口一旦被缩短（`+2 → −1` 之类），basel​ine/threshold/gaps 立刻变形；
 *  ② 期望值由测试内的**独立参考实现**按 D56 规则文档算出（前 7 日日均、×1.5 门槛），
 *     不复述生产表达式——照抄生产代码的断言只能证明代码等于它自己；
 *  ③ 只在**窗口之外**存在的平台序列（P-GHOST）：谓词一旦被删，它会混进 `coverage.platformSeries`，
 *     从 2 变 3 —— 下推谓词第一次有了**行为**上的守卫，而不是只有一条源码正则；
 *  ④ `anchorOf` 的四条 WHERE（同批次 / 状态集合 / 日期格式 / skuId 非空）各配一行"诱饵"：
 *     它们的统计日都在真锚点**之后**，任一条件被删，锚点就会跑到那一天去，整个判定窗口错位、
 *     读模型直接退化成 insufficient。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import { computeSalesSpike, loadSalesSpike } from "@/server/modules/report/sales-spike";
import { runSalesSpikeWatchdog } from "@/jobs/alert-watchdogs";
import { upsertAlerts } from "@/server/modules/alerts/engine";

const source = readFileSync(
  path.resolve(__dirname, "../../src/server/modules/report/sales-spike.ts"),
  "utf8",
);

/* ── 参数与日期骨架（与 spike_* 缺省一致；测试不改参数） ── */
const CONSECUTIVE_DAYS = 3;
const BASELINE_DAYS = 7;
const RISE_PCT = 50;
const ANCHOR = "2026-09-02";

const DAY_MS = 86_400_000;
const shift = (ymd: string, n: number): string =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** 基线窗口 = [anchor−(c+b−1), anchor−c]，判定窗口 = [anchor−(c−1), anchor]（D56 规则文档） */
const BASELINE_DATES = Array.from({ length: BASELINE_DAYS }, (_, i) =>
  shift(ANCHOR, -(CONSECUTIVE_DAYS + BASELINE_DAYS - 1) + i));
const JUDGE_DATES = Array.from({ length: CONSECUTIVE_DAYS }, (_, i) =>
  shift(ANCHOR, -(CONSECUTIVE_DAYS - 1) + i));

/** 基线首日故意与其余基线日不同量：它被窗口切掉时 baseline 必然变形 */
const BASELINE_FIRST_QTY = 4;
const BASELINE_REST_QTY = 12;
/** 基线窗口**前一天**（anchor−10）：给一个大得离谱的量，混进来立刻看得出 */
const JUST_OUTSIDE_DATE = shift(ANCHOR, -(CONSECUTIVE_DAYS + BASELINE_DAYS));
const JUST_OUTSIDE_QTY = 9999;
const JUDGE_QTIES = [20, 25, 30];

/** 只存在于窗口之外的平台序列——下推谓词被删时它会混进 coverage */
const GHOST_DATES = ["2026-05-01", "2026-06-10", "2026-07-15"];

/** 4 位小数字符串（与 core/decimal 的 dQty 一致的展示形态） */
const d4 = (n: number): string => n.toFixed(4);

/**
 * 独立参考实现：按 D56 规则文档重算基线与门槛。
 * 刻意不引用 rules/sales-spike，也不复述 SQL——期望值必须能独立于被测代码成立。
 */
function expectedBaselineAndThreshold(baselineQties: number[]): { baseline: string; threshold: string } {
  const sum = baselineQties.reduce((a, b) => a + b, 0);
  const baseline = sum / BASELINE_DAYS;
  const threshold = baseline * (1 + RISE_PCT / 100);
  // 生产按 scale 4 截断/四舍五入；参考实现用同一 scale 做十进制舍入
  const round4 = (v: number) => Math.round(v * 10_000) / 10_000;
  return { baseline: d4(round4(baseline)), threshold: d4(round4(threshold)) };
}

type Db = Awaited<ReturnType<typeof createTestDb>>["db"];

async function seed(db: Db, options: { omitDate?: string; secondShopGap?: boolean; invalidQty?: string; invalidDate?: string } = {}) {
  const [actor] = await db.insert(schema.users).values({ name: "责任人", roles: ["pmc"] }).returning();
  const [spu] = await db.insert(schema.spus).values({ code: "P1", nameCn: "测试" }).returning();
  const [hot] = await db.insert(schema.skus).values({ code: "N001-000", name: "爆款", spuId: spu.id, skuType: "finished", baseUom: "支" }).returning();
  const [salesJob, cwJob, otherJob] = await db.insert(schema.importJobs).values([
    { template: "jdy_tmall_sku_sales_observation", filename: "s", sourceAsOf: ANCHOR, createdBy: actor.id, status: "done" },
    { template: "jdy_tmall_sku_crosswalk_observation", filename: "c", sourceAsOf: ANCHOR, createdBy: actor.id, status: "done" },
    // 诱饵批次：同一个 target_table，但**不是**本读模型选中的批次
    { template: "jdy_tmall_sku_sales_observation", filename: "other", sourceAsOf: ANCHOR, createdBy: actor.id, status: "done" },
  ]).returning();
  const finishedAt = new Date("2026-09-03T03:00:00.000Z");
  await db.insert(schema.integrationRuns).values([
    { connector: "jdy", stream: "tmall-sku-sales-observation", idempotencyKey: "s", status: "succeeded", importJobId: salesJob.id, finishedAt },
    { connector: "jdy", stream: "tmall-sku-crosswalk-observation", idempotencyKey: "c", status: "succeeded", importJobId: cwJob.id, finishedAt },
  ]);
  const shop = "(天猫国际)NING海外旗舰店";
  await db.insert(schema.stagingRows).values({
    importJobId: cwJob.id, rowNo: 1, status: "pending", targetTable: "jdy_tmall_sku_crosswalk_observation",
    payload: { data: { shopName: shop, platformSkuId: "P-HOT" }, _identity: { skuId: hot.id } },
  });

  const rows: {
    importJobId: number; rowNo: number; status: "pending" | "error"; targetTable: string; payload: unknown;
  }[] = [];
  let n = 1;
  const push = (
    d: string, psku: string, qty: number,
    opts: { jobId?: number; status?: "pending" | "error" } = {},
  ) => {
    if (psku === "P-HOT" && d === options.omitDate) return;
    rows.push({
      importJobId: opts.jobId ?? salesJob.id,
      rowNo: n++,
      status: opts.status ?? "pending",
      targetTable: "jdy_tmall_sku_sales_observation",
      payload: { data: { statisticalDate: d, shopName: shop, skuId: psku, paidNumber: String(qty), paidAmount: String(qty * 100) } },
    });
  };

  // 基线窗口（首日量与其余不同）+ 判定窗口
  BASELINE_DATES.forEach((d, i) => push(d, "P-HOT", i === 0 ? BASELINE_FIRST_QTY : BASELINE_REST_QTY));
  JUDGE_DATES.forEach((d, i) => push(d, "P-HOT", JUDGE_QTIES[i]));
  // 基线窗口前一天：绝不能进基线
  push(JUST_OUTSIDE_DATE, "P-HOT", JUST_OUTSIDE_QTY);
  // 同键重复（DISTINCT ON 去重；row_no 大者胜出 → 取 30）
  push(ANCHOR, "P-HOT", 30);
  if (options.invalidDate) push(options.invalidDate, "P-HOT", 999);
  if (options.invalidQty !== undefined) {
    rows.push({ importJobId: salesJob.id, rowNo: n++, status: "pending", targetTable: "jdy_tmall_sku_sales_observation",
      payload: { data: { statisticalDate: BASELINE_DATES[1], shopName: shop, skuId: "P-HOT", paidNumber: options.invalidQty } } });
  }
  if (options.secondShopGap) {
    const otherShop = "第二店铺";
    await db.insert(schema.stagingRows).values({
      importJobId: cwJob.id, rowNo: 2, status: "pending", targetTable: "jdy_tmall_sku_crosswalk_observation",
      payload: { data: { shopName: otherShop, platformSkuId: "P-SECOND" }, _identity: { skuId: hot.id } },
    });
    [...BASELINE_DATES, ...JUDGE_DATES].filter((d) => d !== BASELINE_DATES[1]).forEach((d) => {
      rows.push({ importJobId: salesJob.id, rowNo: n++, status: "pending", targetTable: "jdy_tmall_sku_sales_observation",
        payload: { data: { statisticalDate: d, shopName: otherShop, skuId: "P-SECOND", paidNumber: "1" } } });
    });
  }

  // 第二个平台序列：涨幅不足，不命中，但要出现在 coverage 里
  [...BASELINE_DATES, ...JUDGE_DATES].forEach((d, i) => push(d, "P-COLD", i < BASELINE_DAYS ? 40 : 41));

  // 只在窗口外存在的序列：下推谓词被删 → platformSeries 从 2 变 3
  for (const d of GHOST_DATES) push(d, "P-GHOST", 500);

  /* ── anchorOf 的四条 WHERE 各一行诱饵：统计日都在真锚点之后 ──
     任一条件被删，锚点就跑到诱饵那天，判定窗口整体错位（读模型退化为 insufficient）。 */
  push("2026-09-20", "P-HOT", 1, { status: "error" });                  // ① 状态集合
  push("2026-09-21", "  ", 1);                                          // ② skuId 非空（trim 后为空）
  rows.push({                                                           // ③ 日期格式正则
    importJobId: salesJob.id, rowNo: n++, status: "pending", targetTable: "jdy_tmall_sku_sales_observation",
    payload: { data: { statisticalDate: "ZZZZ-99-99", shopName: shop, skuId: "P-HOT", paidNumber: "1" } },
  });
  push("2026-09-23", "P-HOT", 1, { jobId: otherJob.id });               // ④ import_job_id

  await db.insert(schema.stagingRows).values(rows);
  return { hot, shop };
}

describe("爆单预警：判定窗口与锚点（行为回归）", () => {
  it("v2 旧缓存不能绕过新的证据资格，重建不删除旧缓存证据", async () => {
    const { db, client } = await createTestDb();
    try {
      await seed(db, { omitDate: BASELINE_DATES[1] });
      const model = await computeSalesSpike(db);
      const legacy = { ...model, key: "sales-spike/v2", hits: [{ code: "旧缓存伪命中" }] };
      await db.execute(sql`INSERT INTO report_read_model_cache (key, source_binding, payload, built_at) VALUES ('sales-spike/v2', ${model.sourceBinding}, ${JSON.stringify(legacy)}::jsonb, now())`);
      const read = await loadSalesSpike(db);
      expect(read.key).toBe("sales-spike/v3");
      expect(read.hits).toEqual([]);
      expect(read.coverage.incompleteItems).toBe(1);
      const cached = await db.select().from(schema.reportReadModelCache);
      expect(cached.map((r) => r.key).sort()).toEqual(["sales-spike/v2", "sales-spike/v3"]);
    } finally { await client.close(); }
  });
  it.each(["2026-09-31", "2026-08-32"])("非法日历日 %s 不进入 SQL 日期强转或制造有效窗口", async (invalidDate) => {
    const { db, client } = await createTestDb();
    try {
      await seed(db, { invalidDate });
      const model = await computeSalesSpike(db);
      expect(model.anchorDate).toBe(invalidDate > ANCHOR ? null : ANCHOR);
      expect(model.hits).toHaveLength(invalidDate > ANCHOR ? 0 : 1);
    } finally { await client.close(); }
  });
  it.each([BASELINE_DATES[1], JUDGE_DATES[1]])("缺日 %s 不生成命中，仍暴露不可判定覆盖", async (omitDate) => {
    const { db, client } = await createTestDb();
    try {
      const { hot } = await seed(db, { omitDate });
      const model = await computeSalesSpike(db);
      expect(model.hits).toEqual([]);
      expect(model.state).toBe("partial");
      expect(model.coverage).toMatchObject({ evaluatedItems: 1, incompleteItems: 1 });
      expect(model.evaluations.find((e) => e.dedupeKey === `sales_spike:sku:${hot.id}`)?.complete).toBe(false);
    } finally { await client.close(); }
  });

  it("完整店铺不能掩盖同一 SKU 的另一店铺缺日", async () => {
    const { db, client } = await createTestDb();
    try {
      await seed(db, { secondShopGap: true });
      const model = await computeSalesSpike(db);
      expect(model.hits).toEqual([]);
      expect(model.coverage).toMatchObject({ platformSeries: 3, mappedSeries: 2, evaluatedItems: 1, incompleteItems: 1 });
    } finally { await client.close(); }
  });

  it.each(["", "not-a-number"])("最新业务键销量非法（%s）不补零，也不复活旧有效版本", async (invalidQty) => {
    const { db, client } = await createTestDb();
    try {
      await seed(db, { invalidQty });
      const model = await computeSalesSpike(db);
      expect(model.hits).toEqual([]);
      expect(model.coverage).toMatchObject({ evaluatedItems: 1, incompleteItems: 1 });
    } finally { await client.close(); }
  });

  it("当前完整非命中可迟滞关闭；缺日、消失对象不关闭也不续命", async () => {
    const { db, client } = await createTestDb();
    try {
      const { hot, shop } = await seed(db, { omitDate: BASELINE_DATES[1] });
      const keys = [`sales_spike:sku:${hot.id}`, `sales_spike:platform:${shop}|P-COLD`, "sales_spike:sku:disappeared"];
      const previous = new Date(`${shift(ANCHOR, -10)}T03:00:00Z`);
      await upsertAlerts(db, { category: "sales_spike", now: previous, candidates: keys.map((key) => ({
        dedupeKey: key, refKey: key, title: key, severity: "high", ownerRole: "pmc", actionHref: "/inventory/alerts?tab=spike",
      })) });
      const result = await runSalesSpikeWatchdog(db, new Date(`${shift(ANCHOR, 1)}T03:00:00Z`));
      expect(result).toMatchObject({ current: true, opened: 0, refreshed: 0, autoClosed: 1 });
      const alerts = await db.select().from(schema.systemAlerts);
      expect(alerts.find((a) => a.dedupeKey === keys[1])?.status).toBe("resolved");
      for (const key of [keys[0], keys[2]]) {
        expect(alerts.find((a) => a.dedupeKey === key)).toMatchObject({ status: "open", lastHitAt: previous });
      }
      expect((await db.select().from(schema.alertEvents)).filter((e) => e.event === "refresh")).toEqual([]);
    } finally { await client.close(); }
  });

  it.each([-1, 2])("未来/过期窗口（相差 %s 日）不新增、不续命、不关闭", async (delta) => {
    const { db, client } = await createTestDb();
    try {
      const { shop } = await seed(db);
      const previous = new Date(`${shift(ANCHOR, -10)}T03:00:00Z`);
      await upsertAlerts(db, { category: "sales_spike", now: previous, candidates: [{
        dedupeKey: `sales_spike:platform:${shop}|P-COLD`, refKey: "P-COLD", title: "既有", severity: "high", ownerRole: "pmc", actionHref: "/inventory/alerts",
      }] });
      const result = await runSalesSpikeWatchdog(db, new Date(`${shift(ANCHOR, delta)}T03:00:00Z`));
      expect(result).toMatchObject({ current: false, opened: 0, refreshed: 0, autoClosed: 0, stillOpen: 1 });
      expect((await db.select().from(schema.systemAlerts))[0]).toMatchObject({ status: "open", lastHitAt: previous });
    } finally { await client.close(); }
  });
  it("锚点由独立 max(...) 查询给出，日期谓词写在 DISTINCT ON 之前的 s.WHERE 里（取数形状守卫）", () => {
    const cte = source.slice(source.indexOf("WITH s AS ("), source.indexOf("ORDER BY payload->'data'->>'shopName'"));
    expect(cte, "判定窗口谓词必须进入 s 的 WHERE（DISTINCT ON 之前），否则整批 68k 行都要先排序去重")
      .toMatch(/left\(payload->'data'->>'statisticalDate',10\)\s*>\s*to_char/);
    expect(source, "锚点不得再从 s 自身派生——那正是 DISTINCT ON 无法被裁剪的原因")
      .not.toMatch(/a AS \(SELECT max\(d::date\)/);
    expect(source, "锚点必须来自一次独立的 max(...) 查询").toMatch(/anchorOf\s*\(/);
  });

  it("窗口余量不得为负：`windowDays` 必须 ≥ consecutiveDays + baselineDays（规则读满这 c+b 天）", () => {
    /* 这条是**不变式**断言，不是"照抄当前字面量"：余量 +2 / +1 / +0 与输出等价（实测），
       负余量才会真的切掉基线首日。所以只禁负数，允许任何 ≥ 0 的余量。 */
    const m = source.match(/const windowDays = consecutiveDays \+ baselineDays\s*([+-])\s*(\d+);/);
    expect(m, "取数窗口必须仍写成 consecutiveDays + baselineDays ± 余量 的形式（口径可读）").not.toBeNull();
    const margin = (m![1] === "-" ? -1 : 1) * Number(m![2]);
    expect(
      margin,
      "余量为负会把基线首日切出取数窗口：baseline 少一天、gaps 多一天，且不会有任何报错",
    ).toBeGreaterThanOrEqual(0);
  });

  it("基线首日（anchor−9）必须进窗口、前一天（anchor−10）必须不进：baseline/threshold/gaps 逐位钉死", async () => {
    const { db, client } = await createTestDb();
    try {
      const { hot } = await seed(db);
      const model = await computeSalesSpike(db);

      expect(model.state).toBe("ready");
      expect(model.anchorDate, "锚点必须落在真数据的最大统计日上").toBe(ANCHOR);
      expect(model.params).toMatchObject({
        consecutiveDays: CONSECUTIVE_DAYS, baselineDays: BASELINE_DAYS, risePct: RISE_PCT,
      });

      expect(model.hits).toHaveLength(1);
      const [h] = model.hits;
      expect(h.skuId).toBe(hot.id);
      expect(h.days.map((d) => d.date)).toEqual(JUDGE_DATES);
      expect(h.days.map((d) => d.qty)).toEqual(JUDGE_QTIES.map(d4));

      // 期望值由独立参考实现给出（不复述生产表达式）
      const baselineQties = BASELINE_DATES.map((_, i) => (i === 0 ? BASELINE_FIRST_QTY : BASELINE_REST_QTY));
      const ref = expectedBaselineAndThreshold(baselineQties);
      expect(
        h.baseline,
        "基线 = 前 7 日日均；窗口若少切一天（anchor−9 掉出去）这里立刻变形，若多带一天（anchor−10 的 9999）会爆炸",
      ).toBe(ref.baseline);
      expect(h.threshold).toBe(ref.threshold);
      expect(h.gaps, "基线 7 天 + 判定 3 天全部有数据，缺天数必须是 0").toBe(0);

      // 同一份数据在"少一天基线"下的期望值必须与上面不同——否则这条断言没有分辨力
      const shrunk = expectedBaselineAndThreshold([0, ...baselineQties.slice(1)]);
      expect(shrunk.baseline).not.toBe(ref.baseline);
    } finally {
      await client.close();
    }
  });

  it("只在窗口外存在的平台序列不得进入任何输出（下推谓词的行为守卫）", async () => {
    const { db, client } = await createTestDb();
    try {
      await seed(db);
      const model = await computeSalesSpike(db);
      expect(
        model.coverage,
        "P-GHOST 只有 5–7 月的行；下推谓词一旦删掉，它会被读进来，platformSeries 从 2 变 3",
      ).toMatchObject({ platformSeries: 2, mappedSeries: 1, systemSkus: 1 });
      expect(model.unmappedHits.map((x) => x.platformSkuId)).not.toContain("P-GHOST");
      expect(model.hits.map((x) => x.code)).not.toContain(null);
    } finally {
      await client.close();
    }
  });

  it("anchorOf 的每条 WHERE 都在起作用：诱饵行都排在真锚点之后，任一条件被删都会让窗口整体错位", async () => {
    const { db, client } = await createTestDb();
    try {
      await seed(db);
      const model = await computeSalesSpike(db);
      /* 诱饵：2026-09-20（状态 error）/ 09-21（skuId 空）/ ZZZZ-99-99（非法日期，字典序高于任何数字）
         / 09-23（另一个 import_job）。任一过滤被删 → 锚点跳到那天 → `s` 的窗口里一行都没有
         → 读模型退化为 insufficient，下面三条断言同时变红。 */
      expect(model.state).toBe("ready");
      expect(model.anchorDate).toBe(ANCHOR);
      expect(model.hits).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});
