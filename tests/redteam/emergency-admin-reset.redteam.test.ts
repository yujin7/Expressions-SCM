/** 应急改密必须显式、强制换密、作废旧会话且同事务审计。 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync("scripts/reset-admin-emergency.ts", "utf8");

describe("管理员应急恢复", () => {
  it("具备三重门、无默认口令，并强制首登改密与会话失效", () => {
    expect(source).toContain("SCM_ADMIN_RESET_ALLOW_POSTGRES");
    expect(source).toContain("SCM_ADMIN_RESET_CONFIRM");
    expect(source).toContain("SCM_ADMIN_RESET_PASSWORD");
    expect(source).toContain("encodeURIComponent(composePassword)");
    expect(source).toContain("process.env.DATABASE_URL = databaseUrl");
    expect(source).toContain("mustChangePassword: true");
    expect(source).toContain("sessionVersion} + 1");
    expect(source).not.toMatch(/PASSWORD\s*\?\?\s*["'][^"']+["']/);
  });

  it("改密与追加审计在同一数据库事务", () => {
    expect(source).toContain("db.transaction(async (tx)");
    expect(source).toContain("writeAudit(tx");
    expect(source).toContain('action: "emergency_password_reset"');
    const auditPayload = source.slice(source.indexOf("await writeAudit(tx"));
    expect(auditPayload).not.toContain("passwordHash");
    expect(auditPayload).not.toContain("SCM_ADMIN_RESET_PASSWORD");
  });
});
