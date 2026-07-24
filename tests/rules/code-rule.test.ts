/** E1-05 编码规范纯规则测试 */
import { describe, expect, it } from "vitest";
import { auditCodes, checkCode } from "@/server/rules/code-rule";

describe("checkCode", () => {
  it("拒收幽灵编码 0 与占位短数字", () => {
    expect(checkCode("0").ok).toBe(false);
    expect(checkCode("12").ok).toBe(false);
    expect(checkCode("0").reason).toContain("占位");
  });
  it("拒收空/空格/全角/超长", () => {
    expect(checkCode("").ok).toBe(false);
    expect(checkCode("E01 001").ok).toBe(false);
    expect(checkCode("Ｅ０１").ok).toBe(false);
    expect(checkCode("x".repeat(61)).ok).toBe(false);
  });
  it("接受本司真实编码", () => {
    expect(checkCode("E054-000").ok).toBe(true);
    expect(checkCode("N02-028-a").ok).toBe(true);
    expect(checkCode("DEV01-018").ok).toBe(true);
    expect(checkCode("E054-000").suspicious).toBeUndefined();
  });
  it("长纯数字（条码型）接受但标可疑", () => {
    const v = checkCode("690001234");
    expect(v.ok).toBe(true);
    expect(v.suspicious).toContain("纯数字");
  });
  it("含中文接受但标可疑", () => {
    expect(checkCode("面膜-001").suspicious).toContain("中文");
  });
});

describe("auditCodes 批量体检", () => {
  it("分离不合规与可疑", () => {
    const r = auditCodes(["E054-000", "0", "690001234", "N02-028-a"]);
    expect(r.invalid.map((i) => i.code)).toEqual(["0"]);
    expect(r.suspicious.map((i) => i.code)).toEqual(["690001234"]);
  });
});
