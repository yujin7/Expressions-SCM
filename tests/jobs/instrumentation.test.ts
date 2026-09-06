import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ log: vi.fn(), pg: vi.fn(), interval: vi.fn() }));
vi.mock("@/server/core/logger", () => ({ log: mocks.log }));
vi.mock("@/jobs/scheduler", () => ({ ensureSchedulerStarted: mocks.pg }));
vi.mock("@/jobs/interval-runner", () => ({ ensureIntervalJobsStarted: mocks.interval }));
import { register } from "@/instrumentation";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
});
afterEach(() => vi.unstubAllEnvs());

describe("background scheduling admission at application boot", () => {
  it.each(["pglite:synthetic", "postgres://synthetic.invalid/test"])("production explicit opt-out prevents either scheduler: %s", async (url) => {
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("SCM_RUN_JOBS", "0"); vi.stubEnv("DATABASE_URL", url);
    await register();
    expect(mocks.log).toHaveBeenCalledOnce();
    expect(mocks.pg).not.toHaveBeenCalled(); expect(mocks.interval).not.toHaveBeenCalled();
  });

  it.each([undefined, "0", "1"])("test never boots background tasks, including explicit enable %s", async (flag) => {
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("SCM_RUN_JOBS", flag); vi.stubEnv("DATABASE_URL", "postgres://synthetic.invalid/test");
    await register();
    expect(mocks.pg).not.toHaveBeenCalled(); expect(mocks.interval).not.toHaveBeenCalled();
  });

  it.each([undefined, "0"])("development stays disabled without opt-in %s", async (flag) => {
    vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("SCM_RUN_JOBS", flag);
    await register();
    expect(mocks.pg).not.toHaveBeenCalled(); expect(mocks.interval).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "production", flag: undefined, pg: true },
    { mode: "production", flag: "1", pg: false },
    { mode: "development", flag: "1", pg: true },
    { mode: "development", flag: "1", pg: false },
  ])("keeps exactly one enabled scheduler: $mode / $flag / PG=$pg", async ({ mode, flag, pg }) => {
    vi.stubEnv("NODE_ENV", mode); vi.stubEnv("SCM_RUN_JOBS", flag);
    vi.stubEnv("DATABASE_URL", pg ? "postgres://synthetic.invalid/test" : "pglite:synthetic");
    await register();
    expect(mocks.pg).toHaveBeenCalledTimes(pg ? 1 : 0);
    expect(mocks.interval).toHaveBeenCalledTimes(pg ? 0 : 1);
  });

  it("does not import/start Node scheduling in the Edge branch", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge"); vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("SCM_RUN_JOBS", "1");
    await register();
    expect(mocks.log).not.toHaveBeenCalled(); expect(mocks.pg).not.toHaveBeenCalled(); expect(mocks.interval).not.toHaveBeenCalled();
  });
});
