import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

describe("种子账号密码策略", () => {
  it("必须显式提供强口令，不允许回退到公开默认密码", async () => {
    const source = await readFile(path.join(process.cwd(), "src/db/seed.ts"), "utf8");
    expect(source).toContain("SEED_ADMIN_PASSWORD?.trim()");
    expect(source).toContain("password.length < 12");
    expect(source).not.toContain('?? "admin123"');
  });

  it("HTTP smoke 也必须显式传入口令，不允许继续沿用旧 seed 默认值", async () => {
    const source = await readFile(path.join(process.cwd(), "scripts/smoke-e2e.ts"), "utf8");
    expect(source).toContain("必须显式设置 SMOKE_PASSWORD");
    expect(source).toContain("SMOKE_ADMIN_PASSWORD");
    expect(source).toContain("SMOKE_ROLE_PASSWORD");
    expect(source).toContain("SMOKE_QUALITY_PASSWORD");
    expect(source).not.toContain('?? "admin123"');
  });
});
