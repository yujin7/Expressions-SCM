import { expect, it } from "vitest";
import { qualityLegacyPath, qualityTab, qualityTabPath } from "@/lib/quality-navigation";
import { documentHref } from "@/lib/document-links";

it("exact quality links select the case workspace independently of list filters and old tabs", () => {
  expect(documentHref("quality_case", 42)).toBe("/quality?docId=42");
  expect(qualityTab("tab=regulatory&docId=42&qc_q=no-match&qc_page=999")).toBe("cases");
  expect(qualityTab("tab=labels")).toBe("labels");
  expect(qualityTab("tab=unknown")).toBe("cases");
  expect(qualityTab("tab=labels&docId=bad")).toBe("cases"); // retain the visible invalid-target error
});

it("tab navigation preserves all sibling filters and removes only selection", () => {
  expect(qualityTabPath("/quality", "qc_q=A&reg_q=B&el_page=2&docId=42", "labels", "#note"))
    .toBe("/quality?qc_q=A&reg_q=B&el_page=2&tab=labels#note");
});

it("old q bookmarks migrate once, without guessing an identity or overwriting qc_q", () => {
  expect(qualityLegacyPath("/quality", "tab=cases&q=QI-001&reg_q=keep", "#note"))
    .toBe("/quality?tab=cases&reg_q=keep&qc_q=QI-001#note");
  expect(qualityLegacyPath("/quality", "q=old&qc_q=new")).toBe("/quality?qc_q=new");
  expect(qualityLegacyPath("/quality", "q=old&qc_q=")).toBe("/quality?qc_q=");
  expect(qualityLegacyPath("/quality", "qc_q=new")).toBeNull();
  expect(qualityLegacyPath("/quality", "tab=regulatory&q=old")).toBeNull();
});
