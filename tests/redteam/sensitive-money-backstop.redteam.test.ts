/**
 * 安全审计 S7：把「只靠读模型手工置空」的金额键补进 SENSITIVE_FIELDS 当兜底。
 *
 * netAmount / grossAmount（采购下单金额）与 previousAmount（手工改写前的销售金额）此前只由
 * stripPurchaseOrderMoney / listManualOverrides 按角色置空——手工闸门漏一处，整条链路就裸奔；
 * 进黑名单后 maskSensitive 在 R9 唯一收口再删一次（两道闸，且新出口默认安全）。
 *
 * 同时钉住**为什么没有把 `spend` 一起收录**：它在 supplier-payment-term 读模型里不是金额标量，
 * 而是 `SupplierYearSpend[]` 容器（year / rank / rankOf + 金额），而名次按产品口径对全员可见。
 * 把键加进黑名单会把整个数组删掉，记分卡「账期候选」Tab 的 `r.spend[0].total` 直接 TypeError。
 * 下面第二个用例就是这条决策的守门人：谁要收录 `spend`，必须先给容器改名（并按约定升版缓存键），
 * 否则这个用例会红。
 */
import { describe, expect, it } from "vitest";
import { SENSITIVE_FIELDS } from "@/server/core/constants";
import { maskSensitive } from "@/server/core/dto";
import { stripSupplierPaymentTermMoney, type SupplierPaymentTermModel } from "@/server/modules/report/supplier-payment-term";

const NON_PRICE = ["ops", "warehouse", "quality"];
const PRICE = ["purchasing", "pmc", "finance", "admin"];

describe("S7 金额键兜底：netAmount / grossAmount / previousAmount", () => {
  it("三个键都在黑名单里", () => {
    for (const k of ["netAmount", "grossAmount", "previousAmount"]) {
      expect(SENSITIVE_FIELDS, k).toContain(k);
    }
  });

  it("非价格角色深剥（含数组与嵌套），价格角色原样保留，且入参不可变", () => {
    const payload = {
      year: 2026,
      summary: { ytd: { netAmount: "2000.00", grossAmount: "2260.00", orderedBaseQty: "205.0000" } },
      byMonth: [{ month: "2026-03", poCount: 1, netAmount: "1100.00", grossAmount: "1243.00" }],
      overrides: [{ yearMonth: "2026-07", previousAmount: "1000.00", scopeLabel: "全公司" }],
    };
    for (const role of NON_PRICE) {
      const masked = maskSensitive(payload, [role]);
      const text = JSON.stringify(masked);
      for (const k of ["netAmount", "grossAmount", "previousAmount"]) expect(text, `${role}/${k}`).not.toContain(k);
      // 非金额同层字段照常保留（黑名单不是把整块删掉）
      expect(text).toContain("orderedBaseQty");
      expect(text).toContain("全公司");
    }
    for (const role of PRICE) {
      expect(JSON.stringify(maskSensitive(payload, [role]))).toContain("2260.00");
    }
    expect(payload.summary.ytd.netAmount).toBe("2000.00");
  });
});

describe("S7 决策守门：`spend` 暂不入黑名单（容器里还装着全员可见的名次）", () => {
  it("账期读模型对非价格角色：金额置空但 spend 容器与名次仍在——收录该键会删掉整个数组并让记分卡崩", () => {
    const model = {
      key: "supplier-payment-term/v1",
      rows: [{
        supplierId: 1, code: "S1", name: "供应商一",
        spend: [{ year: 2026, poNet: "3000.00", jsSettle: null, total: "3000.00", rank: 1, rankOf: 2 }],
      }],
      summary: { totalSpend: "3000.00", creditTermSpend: null, byPool: [] },
    } as unknown as SupplierPaymentTermModel;
    const stripped = stripSupplierPaymentTermMoney(model, ["warehouse"]);
    const masked = maskSensitive(stripped, ["warehouse"]) as unknown as SupplierPaymentTermModel;
    const row = masked.rows[0];
    expect(Array.isArray(row.spend)).toBe(true); // ← 收录 `spend` 会让这里变成 undefined
    expect(row.spend[0].rank).toBe(1); // 名次对全员可见（见 /api/report/supplier-payment-term 路由说明）
    expect(row.spend[0].total).toBeNull(); // 金额由 stripSupplierPaymentTermMoney 置空
    expect(SENSITIVE_FIELDS).not.toContain("spend");
  });
});

/**
 * 2026-09-04 安全审计（同型第二轮）：两张只读报表的金额键此前一个兜底都没有。
 *
 * · `move-or-buy` 的 `laneMedianUnitFee` / `laneEstCost`（「挪还是买」的成本对比）
 *   只靠 service 里 `stripLaneMoney` 那一道手工闸；
 * · `price-compare` 的 `bestPrice` / `worstPrice` / `spreadPct` 连手工闸都没有——
 *   而该模块的文件头当时还写着「此处需接入 maskSensitive……并把 bestPrice / worstPrice
 *   一并纳入遮蔽字段」，读起来像是已经处理好了。**一句与代码相反的注释比没有注释更危险**，
 *   现已连同代码一起改正。
 * `spreadPct` 必须一起收录：(最高−最低)/最低，任一价格已知即可反推另一个。
 */
describe("只读报表金额键兜底：move-or-buy 与 price-compare", () => {
  it("五个键都在黑名单里（含可反推价格的 spreadPct）", () => {
    for (const k of ["laneMedianUnitFee", "laneEstCost", "bestPrice", "worstPrice", "spreadPct"]) {
      expect(SENSITIVE_FIELDS, k).toContain(k);
    }
  });

  it("非价格角色拿不到这些键，价格角色原样保留", () => {
    const payload = {
      rows: [{
        skuId: 1, code: "CP1", baseUom: "支",
        quotes: [{ supplierId: 9, supplierName: "甲", price: "10.00", isBest: true }],
        bestPrice: "10.00", worstPrice: "18.00", spreadPct: 80,
        transfers: [{ qty: 30, laneMedianUnitFee: "1.2000", laneEstCost: "36.00", laneSamples: 9 }],
      }],
      summary: { skuCount: 1, avgSpreadPct: 80, maxSpreadPct: 80 },
    };
    for (const role of NON_PRICE) {
      const text = JSON.stringify(maskSensitive(payload, [role]));
      for (const k of ["laneMedianUnitFee", "laneEstCost", "bestPrice", "worstPrice", "spreadPct", '"price"']) {
        expect(text, `${role}/${k}`).not.toContain(k);
      }
      // 非金额的同层字段照常保留（黑名单删的是键，不是整块）
      expect(text).toContain("laneSamples");
      expect(text).toContain("skuCount");
    }
    for (const role of PRICE) {
      const text = JSON.stringify(maskSensitive(payload, [role]));
      expect(text).toContain("18.00");
      expect(text).toContain("1.2000");
    }
  });

  it("price-compare 的模块头不得再声称「需要时才接入」——它现在确实脱敏了", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "../..");
    const header = readFileSync(path.join(root, "src/server/modules/report/price-compare.ts"), "utf8").slice(0, 3000);
    expect(header, "注释必须描述现状，不是待办").toContain("SENSITIVE_FIELDS");
    expect(header, "三个键必须在注释里点名，改了代码没改注释就是下一次事故")
      .toMatch(/bestPrice[\s\S]{0,80}worstPrice[\s\S]{0,80}spreadPct/);
    expect(header, "不得再把「更细的价格权限」说成未来的事——canSeePrices 早就存在")
      .toContain("更细的价格权限**早就存在**");
    // move-or-buy 的出口也真的过了唯一收口
    const route = readFileSync(path.join(root, "src/app/api/replenish/move-or-buy/route.ts"), "utf8");
    expect(route).toContain("maskSensitive(data, user.roles)");
  });
});
