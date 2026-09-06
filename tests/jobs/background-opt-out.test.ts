import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureIntervalJobsStarted } from "@/jobs/interval-runner";
import { ensureSchedulerStarted, start } from "@/jobs/scheduler";

afterEach(() => vi.unstubAllEnvs());

describe("explicit production opt-out at direct scheduler entry points", () => {
  it("registers no interval timers", () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("SCM_RUN_JOBS", "0");
    vi.stubEnv("DATABASE_URL", "pglite:synthetic");
    const key = Symbol.for("supply-chain.interval-runner");
    const globals = globalThis as unknown as Record<symbol, unknown>;
    const before = globals[key];
    ensureIntervalJobsStarted();
    expect(globals[key]).toBe(before);
  });

  it("creates no pg-boss client or singleton", async () => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("SCM_RUN_JOBS", "0");
    vi.stubEnv("DATABASE_URL", "postgres://synthetic.invalid/do-not-connect");
    const key = Symbol.for("supply-chain.pg-boss-scheduler");
    const globals = globalThis as unknown as Record<symbol, unknown>;
    const before = globals[key];
    await expect(start()).resolves.toBeNull();
    await expect(ensureSchedulerStarted()).resolves.toBeNull();
    expect(globals[key]).toBe(before);
  });
});
