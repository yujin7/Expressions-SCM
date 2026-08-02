import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

const wideTableConsumers = [
  "src/app/(app)/review/checklist/checklist-client.tsx",
  "src/app/(app)/admin/users/users-client.tsx",
  "src/app/(app)/admin/params/params-client.tsx",
  "src/app/(app)/report/exports/exports-client.tsx",
  "src/app/(app)/report/inbound-calendar/inbound-calendar-client.tsx",
  "src/app/(app)/admin/health/health-client.tsx",
];

describe("wide table overflow contract", () => {
  it.each(wideTableConsumers)("%s gives every table its own horizontal viewport", (file) => {
    const source = read(file);
    const tableCount = (source.match(/<Table(?:<[^>]+>)?(?:\s|\/|>)/g) ?? []).length;
    const horizontalViewportCount = (
      source.match(/\bscroll\s*=\s*\{\{\s*x\s*:\s*(?:["'][^"']+["']|[\d_]+)\s*\}\}/g) ?? []
    ).length;

    expect(tableCount, `${file} must contain an audited table`).toBeGreaterThan(0);
    expect(
      horizontalViewportCount,
      `${file} must give every wide table an Ant Design x-scroll viewport`,
    ).toBe(tableCount);
  });

  it("exposes a stable responsive wrapper for the composite search input", () => {
    const source = read("src/components/SearchInput.tsx");
    const styles = read("src/app/globals.css");

    expect(source).toContain('"app-search-input"');
    expect(source).toMatch(
      /<span\s+className=\{\["app-search-input", className\]\.filter\(Boolean\)\.join\(" "\)\}/,
    );
    expect(styles).toContain(".list-toolbar__filters .app-search-input");
    expect(styles).toContain(".list-toolbar__filters > .app-search-input");
  });

  it("routes checklist filters and permission-gated actions through ListToolbar", () => {
    const source = read("src/app/(app)/review/checklist/checklist-client.tsx");

    expect(source).toContain('import ListToolbar from "@/components/ListToolbar"');
    expect(source).toContain("<ListToolbar");
    expect(source).toContain("state={listState}");
    expect(source).toContain("extra={");
    expect(source).toContain("primaryActions={");
    expect(source).toContain("canDecide ? (");
    expect(source).not.toContain('<Space style={{ marginBottom: 12 }} wrap>');
  });

  it("routes replenishment filters and refresh through ListToolbar", () => {
    const source = read("src/app/(app)/replenish/replenish-client.tsx");

    expect(source).toContain('import ListToolbar from "@/components/ListToolbar"');
    expect(source).toContain("<ListToolbar");
    expect(source).toContain("state={listState}");
    expect(source).toContain("extra={");
    expect(source).toContain("primaryActions={");
    expect(source).not.toContain('justifyContent: "space-between"');
  });
});
