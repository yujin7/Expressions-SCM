import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

describe("NPD client rendering boundary", () => {
  it("keeps the Ant Design-heavy NPD workspace behind a deliberate client-only boundary", () => {
    const page = read("src/app/(app)/npd/page.tsx");
    const boundary = read("src/app/(app)/npd/npd-client-only.tsx");
    const client = read("src/app/(app)/npd/npd-projects-client.tsx");

    expect(page).toContain('import NpdClientOnly from "./npd-client-only"');
    expect(page).toContain("<NpdClientOnly />");
    expect(boundary.trimStart().startsWith('"use client";')).toBe(true);
    expect(boundary).toContain('dynamic(() => import("./npd-projects-client")');
    expect(boundary).toMatch(/ssr:\s*false/);
    expect(boundary).toContain('role="status"');
    expect(client).toContain("<DecisionVisual");
  });
});
