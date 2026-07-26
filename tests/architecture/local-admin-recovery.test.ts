import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("local admin recovery contract", () => {
  it("is explicit, local-only, and forces credential rotation", () => {
    const source = readFileSync(
      path.join(process.cwd(), "scripts/reset-local-admin.ts"),
      "utf8",
    );

    expect(source).toContain('databaseUrl.startsWith("pglite:")');
    expect(source).toContain('process.env.NODE_ENV === "production"');
    expect(source).toContain("SCM_ADMIN_RESET_PASSWORD");
    expect(source).toContain("password.length < 12");
    expect(source).toContain("mustChangePassword: true");
    expect(source).toContain("sessionVersion:");
    expect(source).not.toContain("admin123");
  });
});
