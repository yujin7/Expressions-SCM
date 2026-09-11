import React, { type MouseEvent } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DocumentTargetLink from "@/components/DocumentTargetLink";

vi.mock("antd", () => ({ Typography: { Link: "a" } }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/inventory/count",
  useSearchParams: () => new URLSearchParams("q=PD&page=2&docId=1"),
}));
beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());
const event = (patch = {}) => ({ button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false,
  altKey: false, shiftKey: false, preventDefault: vi.fn(), ...patch }) as unknown as MouseEvent<HTMLAnchorElement>;

it("has one rectangular hit area even when the document number wraps", () => {
  const link = DocumentTargetLink({ id: 2, onOpen: vi.fn(), children: "PD-20260911-0002" });
  expect(link.props.style).toMatchObject({ display: "inline-block", minHeight: 24, maxWidth: "100%" });
  expect(link.props.children).toBe("PD-20260911-0002");
});
it("exposes a native href preserving list context and replacing only document identity", () => {
  const link = DocumentTargetLink({ id: 2, onOpen: vi.fn(), children: "PD-2" });
  expect(link.props.href).toBe("/inventory/count?q=PD&page=2&docId=2");
});
it("ordinary pointer or keyboard activation opens the drawer without a document reload", () => {
  const open = vi.fn(); const link = DocumentTargetLink({ id: 2, onOpen: open, children: "PD-2" });
  const e = event(); link.props.onClick(e);
  expect(e.preventDefault).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledExactlyOnceWith(2);
});
it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }])(
  "retains native modified-click behavior %j", patch => {
    const open = vi.fn(); const link = DocumentTargetLink({ id: 2, onOpen: open, children: "PD-2" });
    const e = event(patch); link.props.onClick(e);
    expect(open).not.toHaveBeenCalled(); expect(e.preventDefault).not.toHaveBeenCalled();
  },
);
