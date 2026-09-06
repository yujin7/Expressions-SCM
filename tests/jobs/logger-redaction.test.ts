import { afterEach, describe, expect, it, vi } from "vitest";
import { log, persistErrorLog, sanitizeDiagnosticText } from "@/server/core/logger";

afterEach(() => vi.restoreAllMocks());

function capture(entry: Parameters<typeof log>[0]) {
  const out = vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect(() => log({ ...entry, level: "error" })).not.toThrow();
  return String(out.mock.calls.at(-1)?.[0]);
}

describe("structured logging privacy boundary", () => {
  it("repeated sanitization is stable and retains SQLSTATE without query properties", () => {
    const message = sanitizeDiagnosticText("Error: token=SYNTH_TOKEN");
    expect(sanitizeDiagnosticText(message)).toBe(message);
    const cause = Object.assign(new Error('invalid input syntax for type integer: "SYNTH_PRIVATE_BIND"'), { code: "22P02", detail: "SYNTH_ROW" });
    const error = Object.assign(new Error("Failed query: insert into users values ($1)", { cause }),
      { query: "SYNTH_QUERY", params: ["SYNTH_PARAMS"] });
    const raw = capture({ level: "error", msg: "failed", error });
    expect(raw).not.toContain("SYNTH");
    expect(JSON.parse(raw).error.cause.code).toBe("22P02");
    expect(capture({ level: "error", msg: "plain db error", error: {
      code: "22P02", message: 'invalid input syntax: "SYNTH_PRIVATE_BIND"', detail: "SYNTH_ROW",
    } })).not.toContain("SYNTH");
  });

  it("redacts nested secret keys without mutating the input or losing correlation", () => {
    const input = { level: "error" as const, msg: "sync failed", errorId: "abcd1234", job: "sync-jst",
      context: { appSecret: "SYNTH_SECRET", access_token: "SYNTH_TOKEN", Authorization: "Bearer SYNTH_AUTH",
        cookie: "session=SYNTH_COOKIE", bankAccount: "SYNTH_BANK", status: 503 },
      rows: [{ password: "SYNTH_PASSWORD", skuId: 42 }] };
    const raw = capture(input);
    expect(raw).not.toContain("SYNTH_");
    expect(JSON.parse(raw)).toMatchObject({ errorId: "abcd1234", job: "sync-jst", context: { status: 503 }, rows: [{ skuId: 42 }] });
    expect(input.context.appSecret).toBe("SYNTH_SECRET");
  });

  it.each([
    'Error: token=SYNTH_TOKEN request failed',
    'Error: {"app_secret":"SYNTH_SECRET","access_token":"SYNTH_TOKEN"}',
    'Error: password="SYNTH PASSWORD WITH SPACES"',
    'Authorization: Bearer SYNTH_AUTH',
    'Authorization: Basic SYNTH_BASIC',
    'Cookie: session=SYNTH_COOKIE; other=SYNTH_OTHER',
    'GET https://user:SYNTH_PASS@example.com/api?code=SYNTH_CODE&x=SYNTH_QUERY',
    'Failed query: insert into users(name) values ($1)\nparams: SYNTH_PRIVATE',
    'error: duplicate key\nDETAIL: Key (email)=(SYNTH_EMAIL) already exists.',
    '-----BEGIN PRIVATE KEY-----\nSYNTH_KEY_MATERIAL\n-----END PRIVATE KEY-----',
    'GET /api/sync?code=SYNTH_CODE&name=SYNTH_NAME',
  ])("does not emit credential / SQL examples: %s", (error) => {
    expect(capture({ level: "error", msg: "failure", error })).not.toContain("SYNTH");
  });

  it("keeps benign messages and stack frames while removing SQL text and bind values", () => {
    const raw = capture({ level: "error", msg: "api failure", errorId: "abcdef12",
      error: new Error("Failed query: insert into suppliers values ($1)\nparams: SYNTH_BANK") });
    expect(raw).not.toContain("SYNTH_BANK");
    expect(raw).not.toContain("insert into");
    expect(raw).toContain("logger-redaction.test.ts");
    expect(capture({ level: "error", msg: "failure", error: new TypeError("connection unavailable") })).toContain("connection unavailable");
  });

  it("does not invoke toJSON / getters or stringify unsupported objects into raw secrets", () => {
    const toJSON = vi.fn(() => "SYNTH_TOJSON");
    const getter = vi.fn(() => "SYNTH_GETTER");
    const value = { toJSON, id: 2 };
    Object.defineProperty(value, "dynamic", { enumerable: true, get: getter });
    const cycle: Record<string, unknown> = { n: 2n }; cycle.self = cycle;
    const error = new Error("safe");
    Object.defineProperty(error, "stack", { get: getter });
    const inherited = new Error("safe");
    Object.setPrototypeOf(inherited, Object.create(Error.prototype, { name: { get: getter } }));
    const raw = capture({ level: "error", msg: "safe", value, cycle, error, inherited, map: new Map([["token", "SYNTH_MAP"]]) });
    expect(raw).not.toContain("SYNTH_");
    expect(toJSON).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.parse(raw).cycle.n).toBe("2");
  });

  it("uses the same redaction before persistence, including private URL query and token paths", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    await persistErrorLog({ errorId: "abcdef12", message: "access_token=SYNTH_TOKEN",
      stack: "Error: Failed query: select * from users\nparams: SYNTH_EMAIL\n    at service (/app/service.ts:1:2)",
      path: "/api/public/po-confirm/SYNTH_PATH?code=SYNTH_QUERY", method: "POST", userId: 7 }, { insert: () => ({ values }) });
    const stored = values.mock.calls[0][0];
    expect(JSON.stringify(stored)).not.toContain("SYNTH");
    expect(stored).toMatchObject({ errorId: "abcdef12", method: "POST", userId: 7 });
    expect(stored.stack).toContain("/app/service.ts:1:2");
  });
});
