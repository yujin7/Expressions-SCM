/** 新库种子用户必须首登改密，不能把共享引导口令当长期凭据。 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("种子账号口令策略", () => {
  it("拒绝默认口令、要求足够长度，并显式强制首登改密", () => {
    const seed = readFileSync("src/db/seed.ts", "utf8");
    expect(seed).toContain("SEED_ADMIN_PASSWORD");
    expect(seed).toContain("password.length < 12");
    expect(seed).toContain("mustChangePassword: true");
    expect(seed).not.toContain('?? "admin123"');
  });
});
