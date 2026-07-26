import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(relative: string): string {
  return readFileSync(path.join(root, relative), "utf8");
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return /\.(tsx|ts)$/.test(entry.name) ? [absolute] : [];
  });
}

describe("authenticated UI runtime contract", () => {
  it("does not SSR the Ant Design workspace tree", () => {
    const shell = read("src/components/AppShell.tsx");

    expect(shell).toContain("if (!mounted)");
    expect(shell).toContain('role="status"');
    expect(shell.indexOf("if (!mounted)")).toBeLessThan(shell.indexOf("<MeProvider"));
  });

  it("uses the SSR-safe search composition throughout the product", () => {
    const files = sourceFiles(path.join(root, "src"));
    const unsafe = files.filter((file) => readFileSync(file, "utf8").includes("<Input.Search"));

    expect(unsafe).toEqual([]);
    expect(read("src/components/SearchInput.tsx")).toContain("<Input");
    expect(read("src/components/SearchInput.tsx")).toContain("<Button");
  });

  it("hydrates SKU 360 from both supported deep-link parameters", () => {
    const page = read("src/app/(app)/report/sku-360/page.tsx");
    const client = read("src/app/(app)/report/sku-360/sku-360-client.tsx");

    expect(page).toContain("params.sku ?? params.q");
    expect(client).toContain("if (initialSku) void load(initialSku)");
  });
});
