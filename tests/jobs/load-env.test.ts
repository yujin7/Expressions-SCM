import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadJobEnvironment } from "@/jobs/load-env";

const FILE_KEY = "SCM_JOB_ENV_TEST_FILE_VALUE";
const PROCESS_KEY = "SCM_JOB_ENV_TEST_PROCESS_VALUE";
const QUOTED_KEY = "SCM_JOB_ENV_TEST_QUOTED_VALUE";
const EXPANDED_KEY = "SCM_JOB_ENV_TEST_EXPANDED_VALUE";
const originalFileValue = process.env[FILE_KEY];
const originalProcessValue = process.env[PROCESS_KEY];
const originalQuotedValue = process.env[QUOTED_KEY];
const originalExpandedValue = process.env[EXPANDED_KEY];

afterEach(() => {
  if (originalFileValue === undefined) delete process.env[FILE_KEY];
  else process.env[FILE_KEY] = originalFileValue;
  if (originalProcessValue === undefined) delete process.env[PROCESS_KEY];
  else process.env[PROCESS_KEY] = originalProcessValue;
  if (originalQuotedValue === undefined) delete process.env[QUOTED_KEY];
  else process.env[QUOTED_KEY] = originalQuotedValue;
  if (originalExpandedValue === undefined) delete process.env[EXPANDED_KEY];
  else process.env[EXPANDED_KEY] = originalExpandedValue;
});

describe("standalone job environment", () => {
  it("loads ignored Next-compatible env files and preserves explicit process values", () => {
    const dir = mkdtempSync(join(tmpdir(), "scm-job-env-"));
    try {
      writeFileSync(
        join(dir, ".env"),
        `${FILE_KEY}=from-file\n` +
          `${PROCESS_KEY}=from-file\n` +
          `${QUOTED_KEY}="value with spaces # kept" # outside comment\n` +
          `${EXPANDED_KEY}=\${${FILE_KEY}}-expanded\n`,
        { mode: 0o600 },
      );
      delete process.env[FILE_KEY];
      delete process.env[QUOTED_KEY];
      delete process.env[EXPANDED_KEY];
      process.env[PROCESS_KEY] = "from-process";
      loadJobEnvironment(dir, { forceReload: true });
      expect(process.env[FILE_KEY]).toBe("from-file");
      expect(process.env[PROCESS_KEY]).toBe("from-process");
      expect(process.env[QUOTED_KEY]).toBe("value with spaces # kept");
      expect(process.env[EXPANDED_KEY]).toBe("from-file-expanded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
