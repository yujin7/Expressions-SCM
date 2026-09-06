import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tsx = createRequire(import.meta.url).resolve("tsx");
const revision = "a".repeat(40);
const ready = { ok: true, dbOk: true, drift: false, migrationState: "current", migrationFiles: 61, applied: 61 };

function probe(build: unknown, expected = revision) {
  // Only this child sees the synthetic fetch; no socket, credentials or external calls.
  const preload = `globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/health')) return Response.json(${JSON.stringify({ ...ready, build })});
    console.log('AUTH_REQUEST');
    return Response.json({});
  };`;
  return spawnSync(process.execPath, ["--import", tsx, "--import", `data:text/javascript,${encodeURIComponent(preload)}`,
    path.resolve("scripts/smoke-e2e.ts")], {
    encoding: "utf8", timeout: 5000,
    env: { ...process.env, SMOKE_BASE: "http://127.0.0.1:1", SMOKE_PASSWORD: "synthetic-unused-password",
      SCM_EXPECTED_REVISION: expected },
  });
}

describe("live smoke version admission before credential use", () => {
  it.each([
    undefined, null, {}, { revision: "b".repeat(40), source: "git-clean" },
    { revision, source: "git-dirty" }, { revision, source: "unknown" },
  ])("rejects missing/stale/dirty build %j without trying accounts", (build) => {
    const result = probe(build);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("运行源码版本");
    expect(result.stdout).not.toContain("AUTH_REQUEST");
  });
  it("rejects malformed expected revisions without trying accounts", () => {
    const result = probe({ revision, source: "git-clean" }, "main");
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("AUTH_REQUEST");
  });
  it.each(["git-clean", "build-arg"])("only proceeds to account checks for matching %s", (source) => {
    const result = probe({ revision, source });
    expect(result.stdout).toContain("[PASS] 运行源码版本");
    expect(result.stdout).toContain("AUTH_REQUEST");
    // Synthetic auth intentionally fails: version success cannot imply full smoke success.
    expect(result.status).toBe(1);
  });
});
