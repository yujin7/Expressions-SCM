import { expect, it } from "vitest";
import { skuFormPayload } from "@/components/sku-form-payload";

it("does not resend unchanged optional values from an old edit row", () => {
  const row = { name: "精华", lifecycle: "halted", active: false, commercialRole: "sample", nearExpiryDays: 90, spec: "30ml", shortName: null };
  expect(skuFormPayload({ ...row, name: "新名称", shortName: undefined }, row)).toEqual({ name: "新名称" });
});
it("clears nullable selectors, text and numbers explicitly through JSON", () => {
  const row = { channelId: 3, lossCategory: "packaging", nearExpiryDays: 90, spec: "30ml", normalLeadDays: 35 };
  expect(JSON.parse(JSON.stringify(skuFormPayload({ channelId: undefined, lossCategory: undefined, nearExpiryDays: null, spec: "", normalLeadDays: null }, row))))
    .toEqual({ channelId: null, lossCategory: null, nearExpiryDays: null, spec: null, normalLeadDays: null });
});
it("preserves explicit false and state choices, without introducing create-only defaults into edits", () => {
  expect(skuFormPayload({ active: false, lifecycle: "retired", commercialRole: "gift" }, { active: true, lifecycle: "trial", commercialRole: "retail" }))
    .toEqual({ active: false, lifecycle: "retired", commercialRole: "gift" });
  expect(skuFormPayload({ name: "新产品", spec: null, shortName: "", normalLeadDays: undefined, active: true }, null)).toEqual({ name: "新产品", active: true });
  expect(skuFormPayload({ name: "只编辑已注册字段" }, { spec: "30ml", nearExpiryDays: 90 })).toEqual({ name: "只编辑已注册字段" });
});
