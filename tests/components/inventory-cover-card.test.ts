import React, { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InternalDemandCell, InventoryCoverCard, LedgerDemandCell } from "@/app/(app)/inventory/alerts/alerts-client";
import ContextHelp from "@/components/ContextHelp";

beforeAll(() => vi.stubGlobal("React", React));
afterAll(() => vi.unstubAllGlobals());
type CardRow = Parameters<typeof InventoryCoverCard>[0]["row"];
const row: CardRow = {
  code: "G02-SALE", name: "需要完整阅读而不是截断的中文产品名称及规格", brand: "EXPRESSIONS",
  tier: "S", tierSource: "policy", primary: "out_of_stock", tags: [], onHand: "0",
  primaryDaily: 9, primaryDailySource: "ledger", coverDays: 0, alertDays: 50,
  usedDefault: true, alertBasis: "加工30（缺省）+物流15（缺省）+缓冲5", statusBasis: "在途供给须独立复核",
  daily: { external: null, internal: null, ledger: 9 }, net30External: null,
  ledgerDemand: { startDay: "2026-08-09", endDayExclusive: "2026-09-08", days: 30, salesNetQty: "270.0000", operationsOutQty: "600.0000" },
  internalDemand: { startDay: "2026-01-01", endDayExclusive: "2026-07-01", days: 181, salesQty: null, observedMonths: 0 },
};
const render = (patch: Partial<CardRow> = {}, actions: ReactNode = null, detail: ReactNode = null) => renderToStaticMarkup(createElement(InventoryCoverCard, {
  row: { ...row, ...patch }, ack: "未开告警", actions, detail,
}));

function helpContent(node: ReactNode): ReactNode {
  if (Array.isArray(node)) { for (const child of node) { const found = helpContent(child); if (found) return found; } }
  if (!isValidElement<{ children?: ReactNode; content?: ReactNode }>(node)) return null;
  return node.type === ContextHelp ? node.props.content : helpContent(node.props.children);
}

describe("库存预警紧凑卡片与同源口径", () => {
  it("内部月销帮助展示同一分母与起止；缺月份提示不藏在帮助后", () => {
    const r = { ...row, daily: { ...row.daily, internal: 0.000003 }, internalDemand: { ...row.internalDemand, salesQty: "0.0006", observedMonths: 1 } };
    const html = renderToStaticMarkup(createElement(InternalDemandCell, { row: r }));
    expect(html).toContain("0.000003"); expect(html).toContain("仅1/6月有记录");
    expect(html).toMatch(/<button[^>]*aria-label="G02-SALE内部月销口径"/);
    const help = renderToStaticMarkup(createElement(React.Fragment, null, helpContent(InternalDemandCell({ row: r }))));
    for (const text of ["2026-01-01", "2026-07-01", "181", "0.0006", "不证明每月", "三个月91天"]) expect(help).toContain(text);
    const card = render({ ...r, primaryDailySource: "internal", primaryDaily: 0.000003 });
    expect(card.slice(0, card.indexOf("<details"))).toContain("月销仅1/6月有记录，需核对缺失数据。");
  });
  it("keeps identity, sales, stock, threshold and operations visible before disclosure", () => {
    const html = render(); const visible = html.slice(0, html.indexOf("<details"));
    for (const value of [row.name, row.code, "EXPRESSIONS", "断货", "在库", "主日销 /日", "9", "0天", "50", "含缺省周期", "作业 600", "窗口合计", "作业量不作需求"]) expect(visible).toContain(value);
    expect(html).not.toContain("ellipsis");
    expect(html).toContain('aria-label="G02-SALE 库存预警"');
  });
  it("shows no positive demand separately from a zero net sales observation", () => {
    const html = render({ primary: null, primaryDaily: null, primaryDailySource: null, coverDays: null, daily: { external: null, internal: null, ledger: 0 } });
    expect(html).toContain("无正日销"); expect(html).toContain("未取得正日销");
    expect(html).toContain("0 /日"); expect(html).toContain("未形成主预警");
    expect(html).not.toContain(">正常<");
  });
  it("preserves null, negative and tiny sales without rounding them to zero", () => {
    for (const [ledger, expected] of [[null, "— /日"], [-1, "-1 /日"], [0.000003, "0.000003 /日"]] as const) {
      const html = renderToStaticMarkup(createElement(LedgerDemandCell, { row: { ...row, daily: { ...row.daily, ledger } } }));
      expect(html).toContain(expected);
    }
  });
  it("uses the existing native-button help with precise window and correction evidence", () => {
    const html = renderToStaticMarkup(createElement(LedgerDemandCell, { row }));
    expect(html).toMatch(/<button[^>]*aria-label="G02-SALE销售与作业口径"/);
    expect(html).toContain('aria-haspopup="dialog"');
    const help = renderToStaticMarkup(createElement(React.Fragment, null, helpContent(LedgerDemandCell({ row }))));
    for (const value of ["2026-08-09", "（含）", "2026-09-08", "（不含）", "270", "纠正日净减", "未扣正向冲销", "不参与需求判断", "不证明零需求或全渠道覆盖"]) expect(help).toContain(value);
  });
  it("retains secondary source values and full threshold/supply explanation", () => {
    const html = render({ daily: { external: 1, internal: 2, ledger: 9 }, net30External: "30.0000" });
    expect(html).toMatch(/<details[^>]*><summary>其他口径与阈值依据<\/summary>/);
    for (const value of ["外部日销", "内部日销", "外部30天净件", row.alertBasis, row.statusBasis!]) expect(html).toContain(value);
  });
  it("keeps caller-authorized actions and source evidence without inventing writes", () => {
    const html = render({}, createElement("a", { href: "/report/transfer-suggest?skuIds=7" }, "调拨"), createElement("p", null, "真实告警依据与允许的处置"));
    expect(html).toContain('href="/report/transfer-suggest?skuIds=7"');
    expect(html).toContain("告警证据与处置"); expect(html).toContain("真实告警依据与允许的处置");
    expect(render()).not.toContain("告警证据与处置");
    expect(render()).not.toContain("关闭告警");
  });
});
