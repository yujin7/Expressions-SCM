import { describe, expect, it } from "vitest";
import { clearSavedSupplyDraft, DRAFT_TTL_MS, editSupplyDraft, restoreSupplyDrafts, serializeSupplyDrafts, supplyDraftConflicts } from "@/lib/supply-param-drafts";

const a = { skuId: 1, code: "A", normalLeadDays: null, logisticsLeadDays: 0, purchaseLeadDays: null };
const b = { ...a, skuId: 2, code: "B" };
describe("周期本地草稿不冒充服务器事实", () => {
  it("saving A removes only submitted A fields and retains every B edit", () => {
    const one = editSupplyDraft({}, a, "normalLeadDays", 30);
    const two = editSupplyDraft(one, b, "normalLeadDays", 40);
    expect(clearSavedSupplyDraft(two, one[1])).toEqual({ 2: two[2] });
  });
  it("late save receipt cannot delete newer input on the same field", () => {
    const sent = editSupplyDraft({}, a, "normalLeadDays", 30);
    const next = editSupplyDraft(sent, a, "normalLeadDays", 40);
    expect(clearSavedSupplyDraft(next, sent[1])).toEqual(next);
  });
  it("keeps the original base across re-reads, and detects only real conflicting fields", () => {
    const first = editSupplyDraft({}, a, "normalLeadDays", 30);
    const updated = editSupplyDraft(first, { ...a, normalLeadDays: 15 }, "normalLeadDays", 40);
    expect(updated[1].base.normalLeadDays).toBeNull();
    expect(supplyDraftConflicts(updated[1], { ...a, normalLeadDays: 15 })).toEqual(["normalLeadDays"]);
    expect(supplyDraftConflicts(updated[1], { ...a, normalLeadDays: 40 })).toEqual([]);
    expect(supplyDraftConflicts(updated[1], { ...a, logisticsLeadDays: 9 })).toEqual([]);
  });
  it("zero, missing and explicit clear remain distinct; reverting removes the draft", () => {
    const draft = editSupplyDraft({}, a, "logisticsLeadDays", null);
    expect(draft[1]).toMatchObject({ base: { logisticsLeadDays: 0 }, values: { logisticsLeadDays: null } });
    expect(editSupplyDraft(draft, a, "logisticsLeadDays", 0)).toEqual({});
  });
  it("tab refresh restores bounded valid drafts, but not expired or future evidence", () => {
    const draft = editSupplyDraft({}, a, "normalLeadDays", 30);
    const packed = serializeSupplyDrafts(draft, 1000);
    expect(restoreSupplyDrafts(packed, 1100)).toEqual(draft);
    expect(restoreSupplyDrafts(packed, 1001 + DRAFT_TTL_MS)).toEqual({});
    expect(restoreSupplyDrafts(packed, 999)).toEqual({});
  });
  it("rejects malformed and unbounded storage without hydrating arbitrary fields", () => {
    for (const raw of ["{", "null", JSON.stringify({ version: 1, savedAt: 0, rows: [{ skuId: 1, code: "A", base: {}, values: { normalLeadDays: 30 } }] }),
      JSON.stringify({ version: 1, savedAt: 0, rows: [{ skuId: 1, code: "A", base: { normalLeadDays: null }, values: { normalLeadDays: 366 } }] }),
      JSON.stringify({ version: 1, savedAt: 0, rows: Array(501).fill({}) })]) expect(restoreSupplyDrafts(raw, 0)).toEqual({});
  });
});
