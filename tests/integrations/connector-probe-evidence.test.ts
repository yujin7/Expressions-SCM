import { describe, expect, it } from "vitest";
import {
  connectorProbeEvidence,
  parseConnectorProbeEvidence,
} from "@/server/integrations/connector-probe-evidence";

describe("连接器探测证据契约", () => {
  it("强制固定检查数、重算通过数并丢弃非安全结果", () => {
    const evidence = connectorProbeEvidence({
      c: "jst",
      s: "partial",
      a: "validated",
      p: 99,
      t: 99,
      r: ["ok", "api_code_190", "token=must-not-survive"],
      b: "JST1_12345678ABCDEF00",
    });
    expect(evidence).toMatchObject({
      v: "connector-probe/v1",
      c: "jst",
      s: "partial",
      p: 1,
      t: 6,
      w: false,
      r: ["ok", "api_code_190", "unexpected_response", "not_checked", "not_checked", "not_checked"],
    });
    expect(JSON.stringify(evidence)).not.toContain("must-not-survive");
    expect(parseConnectorProbeEvidence(JSON.stringify(evidence))).toEqual(evidence);
  });

  it("拒绝被截断、通过数伪造或可写的留痕", () => {
    const valid = connectorProbeEvidence({
      c: "yy",
      s: "succeeded",
      a: "validated",
      p: 8,
      t: 8,
      r: Array(8).fill("ok"),
      b: "YY1_12345678ABCDEF00",
    });
    expect(parseConnectorProbeEvidence(JSON.stringify({ ...valid, p: 7 }))).toBeNull();
    expect(parseConnectorProbeEvidence(JSON.stringify({ ...valid, w: true }))).toBeNull();
    expect(parseConnectorProbeEvidence(JSON.stringify(valid).slice(0, -1))).toBeNull();
    expect(parseConnectorProbeEvidence("x".repeat(501))).toBeNull();
  });
});
