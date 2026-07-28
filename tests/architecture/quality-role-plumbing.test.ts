import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRICE_VISIBLE_ROLES, ROLE_LABELS, ROLES } from "@/server/core/constants";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("质量合规角色接线", () => {
  it("注册质量角色但不授予敏感价格可见权限", () => {
    expect(ROLES).toContain("quality");
    expect(ROLE_LABELS.quality).toBe("质量合规");
    expect(PRICE_VISIBLE_ROLES).not.toContain("quality");
  });

  it("seed 提供质量审批账号", () => {
    const seed = read("src/db/seed.ts");
    expect(seed).toMatch(
      /\{\s*username:\s*"quality01",\s*name:\s*"质量合规01",\s*roles:\s*\["quality"\],\s*isApprover:\s*true\s*\}/,
    );
  });

  it("侧栏和命令面板共享质量入口与角色边界", () => {
    const shell = read("src/components/AppShell.tsx");
    const palette = read("src/components/CommandPalette.tsx");

    expect(shell).toContain('if (pathname.startsWith("/quality")) return "quality"');
    expect(shell).toContain('key: "/quality", label: "质量与合规"');
    expect(shell).toContain('"/quality": ["quality", "purchasing", "warehouse", "pmc", "ops"]');
    expect(palette).toContain('href: "/quality"');
    expect(palette).toContain('roles: ["quality", "purchasing", "warehouse", "pmc", "ops"]');
  });
});
