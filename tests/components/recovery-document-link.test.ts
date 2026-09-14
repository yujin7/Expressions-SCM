import React, { type MouseEvent } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import RecoveryDocumentLink from "@/components/RecoveryDocumentLink";
import DocumentDrawer from "@/components/DocumentDrawer";

const h = vi.hoisted(() => ({ path: "/inventory/docs", query: "q=KEPT&page=3&status=void", push: vi.fn() }));
vi.mock("next/link", () => ({ default: "a" }));
vi.mock("next/navigation", () => ({ usePathname: () => h.path, useSearchParams: () => new URLSearchParams(h.query) }));
vi.mock("antd", () => ({ Alert: "alert", Button: "button", Drawer: "drawer", Space: "space" }));
const event = (patch = {}) => ({ button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
  preventDefault: vi.fn(), ...patch }) as unknown as MouseEvent<HTMLAnchorElement>;
beforeEach(() => { vi.clearAllMocks(); h.path = "/inventory/docs"; h.query = "q=KEPT&page=3&status=void"; vi.stubGlobal("React", React);
  vi.stubGlobal("window", { location: new URL(`http://localhost${h.path}?${h.query}#rows`), history: { pushState: h.push } }); });
afterEach(() => vi.unstubAllGlobals());
it("same-page native activation closes the owning modal and opens exact detail without reload or business call", () => {
  const onOpen = vi.fn(), link = RecoveryDocumentLink({ docType: "stock_doc", id: 81, onOpen, children: "查看本次创建的库存单" });
  expect(link.props.href).toBe("/inventory/docs?q=KEPT&page=3&status=void&docId=81");
  expect(link.props.prefetch).toBe(false); const e = event(); link.props.onClick(e);
  expect(e.preventDefault).toHaveBeenCalledOnce(); expect(onOpen).toHaveBeenCalledOnce();
  expect(h.push).toHaveBeenCalledWith(null, "", "/inventory/docs?q=KEPT&page=3&status=void&docId=81#rows");
});
it("activation uses latest URL, not the render-time query", () => {
  const link = RecoveryDocumentLink({ docType: "stock_doc", id: 81, children: "单据" });
  vi.stubGlobal("window", { location: new URL("http://localhost/inventory/docs?q=LATEST&page=9"), history: { pushState: h.push } });
  link.props.onClick(event()); expect(h.push).toHaveBeenCalledWith(null, "", "/inventory/docs?q=LATEST&page=9&docId=81");
});
it.each([{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }])("modified activation %j preserves native browser behavior", patch => {
  const onOpen = vi.fn(), link = RecoveryDocumentLink({ docType: "stock_doc", id: 81, onOpen, children: "单据" }), e = event(patch);
  link.props.onClick(e); expect(onOpen).not.toHaveBeenCalled(); expect(h.push).not.toHaveBeenCalled(); expect(e.preventDefault).not.toHaveBeenCalled();
});
it("cross-page activation follows its copyable Next link and carries bounded return context", () => {
  h.path = "/replenish/move-or-buy"; h.query = "q=SKU&page=3";
  vi.stubGlobal("window", { location: new URL(`http://localhost${h.path}?${h.query}`), history: { pushState: h.push } });
  const onOpen = vi.fn(), link = RecoveryDocumentLink({ docType: "stock_doc", id: 81, onOpen, children: "单据" }), e = event();
  expect(link.props.href).toBe("/inventory/docs?docId=81&workFrom=%2Freplenish%2Fmove-or-buy%3Fq%3DSKU%26page%3D3");
  link.props.onClick(e); expect(e.preventDefault).not.toHaveBeenCalled(); expect(h.push).not.toHaveBeenCalled(); expect(onOpen).not.toHaveBeenCalled();
});
it("invalid result id is plain text, not an unsafe link", () => {
  const link = RecoveryDocumentLink({ docType: "stock_doc", id: 0, children: "未知" });
  expect(link.type).toBe("span"); expect(link.props.href).toBeUndefined();
});
it("read failure still offers a safe return but removes stale business actions", () => {
  const drawer = DocumentDrawer({ readError: "不可读取", extra: "STALE ACTION", workReturn: { href: "/replenish?q=SKU", label: "do not trust supplied label" } });
  const extra = drawer.props.extra as React.ReactElement<{ children: [React.ReactElement<{ href: string; children: unknown[] }>, unknown] }>;
  expect(extra.props.children[0].props.href).toBe("/replenish?q=SKU");
  expect(extra.props.children[0].props.children).toEqual(["返回", "补货建议"]); expect(extra.props.children[1]).toBeNull();
});
it("a forged drawer return is rejected while unrelated existing drawer actions remain", () => {
  const drawer = DocumentDrawer({ extra: "ALLOWED ACTION", workReturn: { href: "https://evil.test", label: "bad" } });
  expect(drawer.props.extra).toBe("ALLOWED ACTION");
});
