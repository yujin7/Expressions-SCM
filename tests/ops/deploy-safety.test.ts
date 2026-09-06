import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const deployPath = path.resolve("ops/deploy.sh");
const deploy = readFileSync(deployPath, "utf8");
const workspaces: string[] = [];
const image = `sha256:${"a".repeat(64)}`;

afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Execute the actual pre-build shell. All Docker commands are trapped; no daemon or real env. */
function rollbackProbe(scenario: string, initial = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "scm-deploy-safety-"));
  workspaces.push(dir);
  mkdirSync(path.join(dir, "bin"));
  writeFileSync(path.join(dir, "env"), "# synthetic; no credentials\n");
  writeFileSync(path.join(dir, "backup-env"), "# synthetic\n");
  writeFileSync(path.join(dir, "bin/docker"), `#!/bin/bash
printf '%s\\n' "$*" >> "$QA_COMMAND_LOG"
case "$1" in
  compose)
    case "$QA_SCENARIO" in
      ps-fails) exit 11 ;;
      absent) exit 0 ;;
      multiple) printf 'container-one\\ncontainer-two\\n' ;;
      *) printf 'container-one\\n' ;;
    esac ;;
  inspect)
    [ -n "\${4:-}" ] || exit 14
    case "$QA_SCENARIO" in
      inspect-fails) exit 12 ;;
      invalid-image) printf 'not-an-image\\n' ;;
      *) printf '%s\\n' "$QA_IMAGE" ;;
    esac ;;
  tag) [ "$QA_SCENARIO" != tag-fails ] ;;
  image)
    case "$QA_SCENARIO" in
      verify-fails) exit 13 ;;
      wrong-image) printf 'sha256:bbbb\\n' ;;
      *) printf '%s\\n' "$QA_IMAGE" ;;
    esac ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
  const end = deploy.indexOf('echo "==> 构建镜像"');
  expect(end).toBeGreaterThan(0);
  const result = spawnSync("/bin/bash", ["-c", `${deploy.slice(0, end)}\nprintf 'BUILD_ALLOWED\\n'`, deployPath], {
    encoding: "utf8", timeout: 5000,
    env: {
      NODE_ENV: "test",
      PATH: `${dir}/bin:/usr/bin:/bin`,
      SCM_ENV_FILE: path.join(dir, "env"), SCM_BACKUP_ENV_FILE: path.join(dir, "backup-env"),
      SCM_COMPOSE_FILE: path.join(dir, "synthetic-compose.yml"),
      SCM_INITIAL_DEPLOY: initial ? "1" : "0", QA_SCENARIO: scenario, QA_IMAGE: image,
      QA_COMMAND_LOG: path.join(dir, "commands"),
    },
  });
  return { ...result, commands: readFileSync(path.join(dir, "commands"), "utf8") };
}

describe("deployment rollback admission", () => {
  it.each(["ps-fails", "inspect-fails", "invalid-image", "tag-fails", "verify-fails", "wrong-image", "multiple", "absent"])(
    "%s must stop before building or touching the database", (scenario) => {
      const result = rollbackProbe(scenario);
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain("BUILD_ALLOWED");
      expect(result.stderr).toMatch(/回滚|首次|容器|镜像/);
    },
  );

  it("permits explicit first deployment only when the app container is absent", () => {
    const result = rollbackProbe("absent", true);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BUILD_ALLOWED");
    expect(result.commands).not.toMatch(/^tag /m);
  });

  it("cannot use initial deployment to skip protection for an existing app", () => {
    const result = rollbackProbe("success", true);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("BUILD_ALLOWED");
  });

  it("tags the actual previous image and verifies the tag before allowing a build", () => {
    const result = rollbackProbe("success");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BUILD_ALLOWED");
    expect(result.commands).toContain(`tag ${image} supply-chain-app:rollback-image-${image.slice(7)}`);
    expect(result.commands).toMatch(/image inspect --format .*supply-chain-app:rollback-image-/);
    expect(result.commands).toMatch(/ps -a -q app/);
  });
});

describe("deployment target readiness", () => {
  const good = { ok: true, dbOk: true, drift: false, migrationState: "current", migrationFiles: 61, applied: 61 };
  function probe(body: unknown, httpOk = true, failJson = false, failNetwork = false) {
    const match = /APP_HEALTH_CHECK='([^']+)'/.exec(deploy);
    expect(match, "health gate must execute the candidate readiness contract inside the target app").not.toBeNull();
    return spawnSync(process.execPath, ["-e", `
      global.fetch = async (url, options) => {
        if (url !== "http://127.0.0.1:3000/api/health" || options.redirect !== "error" || options.cache !== "no-store" || !options.signal) process.exit(90);
        ${failNetwork ? 'throw new Error("synthetic transport failure");' : ""}
        return { ok: ${httpOk}, json: async () => { ${failJson ? 'throw new Error("synthetic invalid JSON");' : `return ${JSON.stringify(body)};`} } };
      };
      ${match![1]}
    `], { encoding: "utf8", timeout: 3000 });
  }

  it("selects the same Compose app, never a possibly unrelated host listener", () => {
    expect(deploy).toContain('compose exec -T app node -e "$APP_HEALTH_CHECK"');
    expect(deploy).not.toMatch(/curl[^\n]*127\.0\.0\.1/);
  });
  it("accepts explicit database and migration readiness", () => expect(probe(good).status).toBe(0));
  it.each([
    null, {}, { ok: true }, { ...good, dbOk: false }, { ...good, drift: true },
    { ...good, migrationState: "unknown" }, { ...good, applied: 60 },
    { ...good, applied: "61" }, { ...good, migrationFiles: 0, applied: 0 },
    { ...good, migrationFiles: 1.5, applied: 1.5 },
  ])("rejects incomplete, unknown or inconsistent readiness: %j", (body) => {
    expect(probe(body).status).toBe(1);
  });
  it("rejects a non-success HTTP status even with a successful-looking body", () => expect(probe(good, false).status).toBe(1));
  it("rejects invalid JSON", () => expect(probe(good, true, true).status).toBe(1));
  it("rejects transport errors without exposing them", () => {
    const result = probe(good, true, false, true);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("synthetic transport");
  });

  it.each([0, 1])("shell health gate propagates container readiness exit %i before warmup", (status) => {
    const start = deploy.indexOf('echo "==> 健康检查"');
    const end = deploy.indexOf("# ==> 读模型预热", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const dir = mkdtempSync(path.join(tmpdir(), "scm-health-gate-"));
    workspaces.push(dir);
    const commandLog = path.join(dir, "commands");
    const result = spawnSync("/bin/bash", ["-c", `
      set -euo pipefail
      compose() { printf '%s\\n' "$1 $2 $3 $4 $5" >> "$QA_COMMAND_LOG"; return ${status}; }
      seq() { printf '1\\n'; }
      sleep() { :; }
      ${deploy.slice(start, end)}
      printf 'WARMUP_ALLOWED\\n'
    `], { encoding: "utf8", timeout: 3000, env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", QA_COMMAND_LOG: commandLog } });
    expect(readFileSync(commandLog, "utf8")).toBe("exec -T app node -e\n");
    expect(result.status).toBe(status);
    expect(result.stdout.includes("WARMUP_ALLOWED")).toBe(status === 0);
  });
});
