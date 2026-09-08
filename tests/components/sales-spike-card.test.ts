import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { SalesSpikeCard } from "@/app/(app)/inventory/alerts/alerts-client";
import AlertEvidence from "@/components/AlertEvidence";
beforeAll(() => vi.stubGlobal("React", React));
afterAll(() => vi.unstubAllGlobals());
const row = {
  kind: "sku" as const, skuId: 7, code: "SPIKE-CHAIN-QA-HOT-LONG-CODE", name: "需要完整阅读的长产品中文名和规格", shopName: "QA旗舰店,华东|直营",
  platformSkuId: null, anchorDate: "2026-09-08", days: [{ date: "2026-09-06", qty: "20", risePct: "100" }, { date: "2026-09-07", qty: "25", risePct: "150" }, { date: "2026-09-08", qty: "30", risePct: "200" }],
  baseline: "10", threshold: "15", risePct: "200", href: "/replenish?q=HOT", reason: "连续三天", gaps: 0, expected: false, planEventRef: null, expectedUpliftPct: null, planEventWindow: null,
};
it("narrow spike view keeps full identity, shop, dated quantities, threshold and permitted action", () => {
  const html = renderToStaticMarkup(createElement(SalesSpikeCard, { row, ack: "已知悉 · PMC", action: createElement("a", { href: row.href }, "看补货") }));
  for (const value of [row.code, row.name, row.shopName, "2026-09-06", "2026-09-07", "2026-09-08", "20", "25", "30", "10", "15", "+200%", "已知悉 · PMC", "看补货"]) expect(html).toContain(value);
  expect(html).not.toContain("ellipsis");expect(html).toContain('aria-label="'+row.code+' 爆单"');
});
it("unmapped identity stays unmapped and promotion is not presented as resolved", () => {
  const html = renderToStaticMarkup(createElement(SalesSpikeCard, { row: { ...row, kind: "platform", skuId: null, code: null, name: null, platformSkuId: "PLATFORM-LONG", expected: true }, ack: "未知悉", action: "认领身份" }));
  for (const value of ["未映射", "PLATFORM-LONG", "大促预期内", "认领身份"]) expect(html).toContain(value);
  expect(html).not.toContain("已解决");
});
it("shared evidence retains long raw params in bounded wrapping entries", () => {
  const reason = "长触发依据".repeat(20);
  const html = renderToStaticMarkup(createElement(AlertEvidence, { alert: { sourceRule: "rules/sales-spike", paramsSnapshot: { reason, baseline: "10.0000", gaps: 0 } } }));
  expect(html).toContain(reason);expect(html).toContain('aria-label="参数快照"');
  const css = readFileSync("src/components/AlertEvidence.module.css", "utf8");
  expect(css).toContain("overflow-wrap: anywhere");expect(css).toContain("minmax(0, 1fr)");
  expect(css).not.toMatch(/overflow:\s*hidden|text-overflow:\s*ellipsis/);
});
it("one paginated table chooses compact cards without duplicating rows or removing sorting", () => {
  const src = readFileSync("src/app/(app)/inventory/alerts/alerts-client.tsx", "utf8").split("export function SpikeTab()")[1];
  expect(src).toContain("columns={wide ? columns : compactColumns}");
  expect(src).toContain('title: "爆单 · 涨幅"');expect(src).toContain('defaultSortOrder: "descend"');
  expect(src).toContain("x: wide ? 1200 : undefined");
});
