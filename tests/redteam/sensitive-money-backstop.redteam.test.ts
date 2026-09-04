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
