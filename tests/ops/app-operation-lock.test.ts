import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const helper = path.resolve("scripts/app-operation-lock.sh");
const children: ChildProcess[] = [];
const ownedLockFiles = new Set<string>();
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
  }
  // Only unique synthetic keys from this test, after their holders have exited.
  for (const file of ownedLockFiles) rmSync(file, { force: true });
  ownedLockFiles.clear();
});
const project = () => `qa-lock-${process.pid}-${Math.random().toString(16).slice(2)}`;
function setup(name: string, daemon = "qa-daemon-only") {
  const key = createHash("sha256").update(`${daemon}\n${name}`).digest("hex");
  ownedLockFiles.add(`/tmp/exp-scm-app-operations-${process.getuid?.()}/${key}.lock`);
  return `source ${JSON.stringify(helper)} || exit 99
docker() { [ "$1" = info ] || return 98; printf '%s\\n' '${daemon}'; }
compose() { printf '%s\\n' '${JSON.stringify({ name })}'; }
`;
}
function attempt(name: string, suffix = "", daemon?: string) {
  return spawnSync("/bin/bash", ["-c", `${setup(name, daemon)}
app_operation_acquire compose || exit $?
echo ACQUIRED
${suffix}`], { encoding: "utf8", timeout: 3000 });
}
async function hold(name: string) {
  const child = spawn("/bin/bash", ["-c", `${setup(name)}
app_operation_acquire compose || exit $?
echo HELD
read -r finish
`], { stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("lock holder not ready")), 2500);
    child.stdout?.once("data", data => {
      clearTimeout(timer);
      if (String(data).includes("HELD")) resolve(); else reject(new Error(String(data)));
    });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`holder exited ${code}`)); });
  });
  return child;
}
describe("application operations share a kernel lock", () => {
  it("holds the inherited file lock after the Python acquisition process exits", async () => {
    const name = project(); await hold(name);
    const r = attempt(name); expect(r.status).toBe(75); expect(r.stdout).not.toContain("ACQUIRED");
  });
  it("releases on process death, without stale PID stealing or file deletion", async () => {
    const name = project(); const child = await hold(name);
    const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
    expect(attempt(name).status).toBe(0);
  });
  it("does not serialize separate Compose projects or Docker daemons", async () => {
    const name = project(); await hold(name);
    expect(attempt(`${name}-other`).status).toBe(0);
    expect(attempt(name, "", "qa-another-daemon").status).toBe(0);
  });
  it("does not depend on checkout cwd or launchd TMPDIR", async () => {
    const name = project(); await hold(name);
    const r = spawnSync("/bin/bash", ["-c", `${setup(name)}\napp_operation_acquire compose`],
      { cwd: "/tmp", env: { ...process.env, TMPDIR: "/tmp/synthetic-unused" }, encoding: "utf8", timeout: 3000 });
    expect(r.status).toBe(75);
  });
  it.each(["deploy", "tunnel"])("blocks the actual %s entry before any Docker mutation", async entry => {
    const name = project(); await hold(name);
    const deploy = readFileSync("ops/deploy.sh", "utf8");
    const from = deploy.indexOf('APP_OPERATION_PROJECT=""');
    const to = deploy.indexOf('echo "==> 构建镜像"', from);
    const code = entry === "deploy" ? deploy.slice(from, to) : `source ${JSON.stringify(path.resolve("scripts/tunnel-app-guard.sh"))}
      tunnel_sync_url https://synthetic-lock-only.trycloudflare.com || exit $?`;
    const r = spawnSync("/bin/bash", ["-c", `set -uo pipefail
      ENV_FILE=synthetic.env COMPOSE_FILE=synthetic.yml PROJECT=${name}
      COMPOSE_PROD=synthetic.yml COMPOSE_LOCAL=local.yml RUNTIME_DIR=/tmp
      docker() {
        if [ "$1" = info ]; then echo qa-daemon-only;
        elif [[ "$*" == *'config --format json'* ]]; then echo '${JSON.stringify({ name })}';
        else echo MUTATION_ATTEMPTED; return 99; fi
      }
      ${code}
    `], { encoding: "utf8", timeout: 3000 });
    expect(r.status).toBe(75); expect(r.stdout).not.toContain("MUTATION_ATTEMPTED");
  });
  it.each(["", "../other", "UPPER", "name with spaces"])("rejects invalid project identity %s", name => {
    const r = attempt(name); expect(r.status).not.toBe(0); expect(r.stdout).not.toContain("ACQUIRED");
  });
  it("fails closed if target discovery fails, and does not echo config secrets", () => {
    const r = attempt(project(), "", ""); expect(r.status).not.toBe(0);
    const bad = spawnSync("/bin/bash", ["-c", `${setup(project())}\ncompose() { echo secret-value; return 1; }; app_operation_acquire compose`], { encoding: "utf8" });
    expect(bad.status).not.toBe(0); expect(`${bad.stdout}${bad.stderr}`).not.toContain("secret-value");
  });
  it("guards deploy before rollback mutations and public sync before image capture", () => {
    const deploy = readFileSync("ops/deploy.sh", "utf8");
    expect(deploy.indexOf("app_operation_acquire compose")).toBeGreaterThan(0);
    expect(deploy.indexOf("app_operation_acquire compose")).toBeLessThan(deploy.indexOf("docker tag"));
    const guard = readFileSync("scripts/tunnel-app-guard.sh", "utf8").split("tunnel_sync_url() {")[1];
    expect(guard.indexOf("app_operation_acquire tunnel_compose")).toBeGreaterThan(0);
    expect(guard.indexOf("app_operation_acquire tunnel_compose")).toBeLessThan(guard.indexOf("tunnel_capture_app"));
  });
});
