import { describe, expect, it } from "vitest";
import { compareDeclaredCapacity, type CapacityDeclaration } from "@/server/rules/declared-capacity";

const declaration: CapacityDeclaration = {
  declaredMonthlyCapacity: "1000", capacityUom: "支", surgeCapacityPct: 20,
  capacityValidFrom: "2026-09-01", capacityValidUntil: "2026-12-31", capacityEvidence: "签认单CAP-9",
};
const context = { baseUom: "支", dueDate: "2026-10-20", asOfDay: "2026-09-09", projectedQty: "1100", undatedOrders: 0 };
const compare = (d: Partial<CapacityDeclaration> = {}, c: Partial<typeof context> = {}) => compareDeclaredCapacity({ ...declaration, ...d }, { ...context, ...c });

describe("G04 独立申报情景，不等于可承诺产能", () => {
  it("当前有效且覆盖整月时比较，超正常但未超加班，保留负差额", () => {
    expect(compare()).toMatchObject({ state: "comparable", basis: "supplier_declared_monthly_scenario", targetMonth: "2026-10",
      normalLimitQty: "1000.0000", surgeLimitQty: "1200.0000", normalHeadroomQty: "-100.0000", surgeHeadroomQty: "100.0000",
      normalLoadPct: "110.00", overNormal: true, overSurge: false });
  });
  it("精确相等不报警，微量超限不被浮点抹掉", () => {
    expect(compare({}, { projectedQty: "1200" })).toMatchObject({ overSurge: false, surgeHeadroomQty: "0.0000" });
    expect(compare({}, { projectedQty: "1200.0001" })).toMatchObject({ overSurge: true, surgeHeadroomQty: "-0.0001" });
    expect(compare({ declaredMonthlyCapacity: "0.1", surgeCapacityPct: 200 }, { projectedQty: "0.3" })).toMatchObject({ surgeLimitQty: "0.3000", overSurge: false });
  });
  it("0申报是有效零，未知加班不是0加班", () => {
    expect(compare({ declaredMonthlyCapacity: "0", surgeCapacityPct: null })).toMatchObject({ state: "comparable", normalLimitQty: "0.0000", normalLoadPct: null, overNormal: true, surgeLimitQty: null, overSurge: null });
    expect(compare({ surgeCapacityPct: 0 })).toMatchObject({ surgeLimitQty: "1000.0000", overSurge: true });
  });
  it.each([
    [{ declaredMonthlyCapacity: null }, "missing"],
    [{ capacityEvidence: "  " }, "unqualified"],
    [{ capacityValidFrom: null }, "unqualified"],
    [{ capacityValidUntil: "2026-02-30" }, "unqualified"],
    [{ capacityValidFrom: "2027-01-01" }, "unqualified"],
    [{ declaredMonthlyCapacity: "-1" }, "unqualified"],
    [{ declaredMonthlyCapacity: "NaN" }, "unqualified"],
    [{ capacityUom: "万支" }, "unit_mismatch"],
    [{ capacityUom: null }, "unit_mismatch"],
    [{ capacityValidFrom: "2026-10-01" }, "outside_validity"],
    [{ capacityValidUntil: "2026-10-20" }, "outside_validity"],
    [{ capacityValidUntil: "2026-09-30" }, "outside_validity"],
  ] as const)("缺证/单位/日期边界 %j → %s，所有可比较值留空", (d, state) => {
    expect(compare(d)).toMatchObject({ state, normalLimitQty: null, surgeLimitQty: null, normalHeadroomQty: null, normalLoadPct: null, overNormal: null });
  });
  it("缺交期不以建单月猜代，缺其他单交期不虚报完整负荷", () => {
    expect(compareDeclaredCapacity(declaration, { ...context, dueDate: null }).state).toBe("missing_due_date");
    expect(compare({}, { dueDate: "2026-13-01" }).state).toBe("missing_due_date");
    expect(compare({}, { undatedOrders: 1 })).toMatchObject({ state: "incomplete_schedule", normalHeadroomQty: null });
  });
  it("曾有效但目前已过期或当前日非法，不能继续沿用", () => {
    expect(compare({}, { asOfDay: "2027-01-01" }).state).toBe("outside_validity");
    expect(compare({}, { asOfDay: "2026-02-30" }).state).toBe("outside_validity");
  });
  it("闰年二月要求完整29天，非闰年28天覆盖足够", () => {
    const d = { capacityValidFrom: "2028-02-01", capacityValidUntil: "2028-02-28" };
    expect(compare(d, { dueDate: "2028-02-10", asOfDay: "2028-02-02" }).state).toBe("outside_validity");
    expect(compare({ ...d, capacityValidUntil: "2028-02-29" }, { dueDate: "2028-02-10", asOfDay: "2028-02-02" }).state).toBe("comparable");
    expect(compare({ capacityValidFrom: "2027-02-01", capacityValidUntil: "2027-02-28" }, { dueDate: "2027-02-10", asOfDay: "2027-02-02" }).state).toBe("comparable");
  });
});
