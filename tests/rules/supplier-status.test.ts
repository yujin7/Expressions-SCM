/**
 * 供应商状态 → 能否接新单（纯规则）。
 * 事故：生命周期页「整改 · 发起时暂停新订单」把状态置为 paused，但 createWo / generateDocs / auto-chain
 * 只拦 blacklisted——「暂停」成了只改标签不改行为的假开关。三处现统一读本规则。
 */
import { describe, expect, it } from "vitest";
import { supplierAcceptsNewOrders, supplierNewOrderBlock } from "@/server/rules/supplier-status";

describe("rules/supplier-status", () => {
  it("blacklisted 与 paused 都禁新单，且各有可读标签", () => {
    expect(supplierNewOrderBlock("blacklisted")).toMatchObject({ blocked: true, label: "黑名单" });
    expect(supplierNewOrderBlock("paused")).toMatchObject({ blocked: true, label: "暂停新订单" });
    expect(supplierAcceptsNewOrders("paused")).toBe(false);
    expect(supplierAcceptsNewOrders("blacklisted")).toBe(false);
  });

  it("qualified / pending / 未知 / 空 都放行（准入中的供应商由准入流程另管）", () => {
    for (const s of ["qualified", "pending", "whatever", null, undefined]) {
      expect(supplierNewOrderBlock(s)).toEqual({ blocked: false });
      expect(supplierAcceptsNewOrders(s)).toBe(true);
    }
  });
});
