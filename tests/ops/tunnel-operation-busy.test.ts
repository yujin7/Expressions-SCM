import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const daemon = readFileSync("scripts/public-tunnel-daemon.sh", "utf8");
const start = daemon.indexOf("apply_url() (");
const end = daemon.indexOf("# 确保应用当前真的在用这个地址", start);
const apply = daemon.slice(start, end);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("busy application operations do not churn public access", () => {
  function run(status: number) {
    const dir = mkdtempSync(path.join(tmpdir(), "scm-busy-tunnel-")); dirs.push(dir);
    const r = spawnSync("/bin/bash", ["-c", `set -uo pipefail
      URL_FILE="$QA_DIR/url"
      log() { echo "$*"; }
      tunnel_sync_url() { return ${status}; }
      public_probe() { echo PROBED; return 0; }
      tunnel_verify_same_app() { return 0; }
      announce() { echo ANNOUNCED; }
      sleep() { :; }
      ${apply}
      apply_url https://synthetic-only-qa.trycloudflare.com
    `], { encoding: "utf8", timeout: 3000, env: { ...process.env, QA_DIR: dir } });
    return { ...r, published: existsSync(path.join(dir, "url")) };
  }
  it("returns busy without probing, publishing, or announcing an unverified URL", () => {
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const r = run(75); expect(r.status).toBe(75); expect(r.published).toBe(false);
    expect(r.stdout).not.toMatch(/PROBED|ANNOUNCED/);
  });
  it("keeps actual sync errors distinct from contention", () => {
    const r = run(1); expect(r.status).toBe(1); expect(r.published).toBe(false);
  });
  it("publishes only after sync and verification succeed", () => {
    const r = run(0); expect(r.status).toBe(0); expect(r.published).toBe(true);
    expect(r.stdout).toContain("ANNOUNCED");
  });
  it("retries the same tunnel after contention without entering the teardown branch", () => {
    const from = daemon.indexOf("  APPLY_STATUS=0");
    const to = daemon.indexOf('  if [[ "$APPLY_STATUS" != 0 ]]', from);
    expect(from).toBeGreaterThan(0); expect(to).toBeGreaterThan(from);
    const r = spawnSync("/bin/bash", ["-c", `set -uo pipefail
      attempts=0 CF_PID=123 URL=https://synthetic-only-qa.trycloudflare.com TUNNEL_CHECK_SECONDS=30
      apply_url() { attempts=$((attempts+1)); echo "ATTEMPT $attempts $1"; [ "$attempts" = 3 ] || return 75; }
      kill() { [ "$1" = -0 ] || { echo KILLED; return 1; }; }
      tunnel_process() { echo 123; }
      sleep() { :; }
      ${daemon.slice(from, to)}
      echo "FINAL $APPLY_STATUS"
    `], { encoding: "utf8", timeout: 3000 });
    expect(r.status).toBe(0); expect(r.stdout.match(/ATTEMPT/g)).toHaveLength(3);
    expect(r.stdout).toContain("FINAL 0"); expect(r.stdout).not.toContain("KILLED");
  });
  it("does not count busy checks toward killing an established tunnel", () => {
    const from = daemon.indexOf("    ENSURE_STATUS=0");
    const to = daemon.indexOf('    log "公网验活连续失败', from);
    expect(from).toBeGreaterThan(0); expect(to).toBeGreaterThan(from);
    const r = spawnSync("/bin/bash", ["-c", `set -uo pipefail
      PUBLIC_FAILURES=2 URL=https://synthetic-only-qa.trycloudflare.com
      ensure_url() { return 75; }
      for trial in 1 2 3; do
        ${daemon.slice(from, to)}
      done
      echo "FAILURES $PUBLIC_FAILURES"
    `], { encoding: "utf8", timeout: 3000 });
    expect(r.status).toBe(0); expect(r.stdout).toContain("FAILURES 2");
  });
  it("copies the lock helper and releases installer ownership before daemon startup", () => {
    const installer = readFileSync("scripts/install-public-tunnel.sh", "utf8");
    expect(installer).toContain('cp "$REPO/scripts/app-operation-lock.sh" "$STATE_DIR/app-operation-lock.sh"');
    const release = installer.indexOf("exec 9>&-");
    expect(release).toBeGreaterThan(installer.indexOf('cp "$REPO/.env.prod"'));
    expect(release).toBeLessThan(installer.indexOf("launchctl bootout"));
  });
});
