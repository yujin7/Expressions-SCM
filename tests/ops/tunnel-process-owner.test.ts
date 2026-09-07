import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const helper = path.resolve("scripts/tunnel-process-owner.py");
const dirs: string[] = [];
const children: ChildProcess[] = [];
let bin: string;
beforeAll(() => {
  bin = mkdtempSync(path.join(tmpdir(), "scm-owned-tunnel-bin-"));
  // A native, network-free process gives ps the same argv shape as cloudflared.
  const r = spawnSync("cc", ["-x", "c", "-", "-o", path.join(bin, "cloudflared")], {
    input: '#include <unistd.h>\n#include <stdio.h>\nint main(void) { puts("https://owned-process-qa.trycloudflare.com"); fflush(stdout); for (;;) pause(); }\n', encoding: "utf8", timeout: 15000,
  });
  expect(r.error).toBeUndefined(); expect(r.status, r.stderr).toBe(0);
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const done = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await done;
  }
  for (const dir of dirs.splice(0)) {
    run(dir, "stop"); // Only this test's private receipt/native fixture, never host tunnels.
    rmSync(dir, { recursive: true, force: true });
  }
});
afterAll(() => { rmSync(bin, { recursive: true, force: true }); });
function state() {
  const dir = mkdtempSync(path.join(tmpdir(), "scm-owned-tunnel-state-")); dirs.push(dir); chmodSync(dir, 0o700); return dir;
}
function env() { return { ...process.env, PATH: `${bin}:${process.env.PATH}` }; }
function run(dir: string, action: string, ...args: string[]) {
  return spawnSync("python3", [helper, dir, "39871", action, ...args], { env: env(), encoding: "utf8", timeout: 8000 });
}
async function owned(dir: string) {
  const child = spawn("/bin/bash", ["-c", `
    "${bin}/cloudflared" tunnel --no-autoupdate --protocol http2 --pidfile "$QA_STATE/cloudflared.pid" --url http://localhost:39871 >/dev/null &
    tunnel_pid=$!
    trap 'kill "$tunnel_pid" 2>/dev/null; wait "$tunnel_pid" 2>/dev/null' EXIT
    for trial in $(seq 1 50); do
      python3 "$QA_HELPER" "$QA_STATE" 39871 record "$tunnel_pid" 2>/dev/null && break
      sleep 0.02
    done
    python3 "$QA_HELPER" "$QA_STATE" 39871 status || exit 2
    read -r finish
  `], { env: { ...env(), QA_STATE: dir, QA_HELPER: helper }, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  const pid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("owned process not ready")), 5000);
    child.stdout?.once("data", data => { clearTimeout(timer); resolve(Number(String(data).trim())); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`launcher exited ${code}`)); });
  });
  expect(pid).toBeGreaterThan(1); return { child, pid };
}

describe("quick tunnel process ownership", () => {
  it("records a direct child and lets a later helper verify its exact identity", async () => {
    const dir = state(); const { pid } = await owned(dir);
    const r = run(dir, "status"); expect(r.status, r.stderr).toBe(0); expect(Number(r.stdout)).toBe(pid);
    expect(run(dir, "preflight").status).toBe(0);
  });
  it("stops only the recorded process while an unrelated tunnel stays alive", async () => {
    const dir = state(); const { pid } = await owned(dir);
    const unrelated = spawn(path.join(bin, "cloudflared"), ["tunnel", "--no-autoupdate", "--url", "http://localhost:39872"]);
    children.push(unrelated);
    const r = run(dir, "stop"); expect(r.status, r.stderr).toBe(0);
    expect(run(dir, "status").stdout.trim()).toBe("");
    expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it("can verify and stop the same recorded tunnel after its launcher crashes", async () => {
    const dir = state(); const { child, pid } = await owned(dir);
    const done = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await done;
    try {
      expect(Number(run(dir, "status").stdout)).toBe(pid);
      expect(run(dir, "preflight").status).toBe(0);
    } finally {
      expect(run(dir, "stop").status).toBe(0);
    }
  });
  it.each(["pid", "start", "command", "uid"])("rejects a changed %s receipt without signalling", async field => {
    const dir = state(); const { pid } = await owned(dir);
    const file = path.join(dir, "tunnel-owner.json");
    const receipt = JSON.parse(readFileSync(file, "utf8"));
    receipt[field] = field === "pid" ? process.pid : field === "uid" ? -1 : "wrong identity";
    writeFileSync(file, JSON.stringify(receipt));
    const r = run(dir, "stop"); expect(r.status).toBe(1);
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(r.stderr).not.toContain("wrong identity");
  });
  it("refuses an unrecorded same-origin tunnel instead of adopting or killing it", async () => {
    const dir = state(); const { pid } = await owned(dir);
    rmSync(path.join(dir, "tunnel-owner.json"));
    expect(run(dir, "preflight").status).toBe(1); expect(run(dir, "stop").status).toBe(1);
    expect(() => process.kill(pid, 0)).not.toThrow();
  });
  it("refuses registering someone else's live process", async () => {
    const dir = state(); const { pid } = await owned(dir);
    // This helper is a child of Node, not of the shell that launched cloudflared.
    expect(run(dir, "record", String(pid)).status).toBe(1);
  });
  it("does not stop an unrelated reused PID or permanently block a new tunnel", async () => {
    const dir = state(); await owned(dir);
    expect(run(dir, "stop").status).toBe(0);
    const other = spawn(path.join(bin, "cloudflared"), ["tunnel", "--no-autoupdate", "--url", "http://localhost:39872"]);
    children.push(other);
    const file = path.join(dir, "tunnel-owner.json");
    const receipt = JSON.parse(readFileSync(file, "utf8")); receipt.pid = other.pid;
    writeFileSync(file, JSON.stringify(receipt));
    expect(run(dir, "status").stdout.trim()).toBe("");
    expect(run(dir, "stop").status).toBe(0);
    expect(() => process.kill(other.pid!, 0)).not.toThrow();
    const next = await owned(dir); expect(Number(run(dir, "status").stdout)).toBe(next.pid);
  });
  it("fails closed for corrupt or world-readable receipts", async () => {
    const dir = state(); const { pid } = await owned(dir);
    const file = path.join(dir, "tunnel-owner.json"); chmodSync(file, 0o644);
    expect(run(dir, "stop").status).toBe(1); chmodSync(file, 0o600);
    writeFileSync(file, "not-json secret-fixture");
    const r = run(dir, "stop"); expect(r.status).toBe(1); expect(r.stderr).not.toContain("secret-fixture");
    expect(() => process.kill(pid, 0)).not.toThrow();
  });
  it("refuses a second daemon lock holder and releases when its shell exits", async () => {
    const dir = state(); const lock = path.join(dir, "tunnel-daemon.lock"); writeFileSync(lock, "", { mode: 0o600 });
    const code = `exec 8>>"$QA_STATE/tunnel-daemon.lock"; python3 "$QA_HELPER" "$QA_STATE" 39871 lock || exit $?; echo HELD`;
    const child = spawn("/bin/bash", ["-c", `${code}; read -r finish`], { env: { ...env(), QA_STATE: dir, QA_HELPER: helper } }); children.push(child);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("lock holder timeout")), 5000);
      child.stdout?.once("data", () => { clearTimeout(timer); resolve(); });
    });
    const attempt = () => spawnSync("/bin/bash", ["-c", code], { env: { ...env(), QA_STATE: dir, QA_HELPER: helper }, encoding: "utf8", timeout: 3000 });
    expect(attempt().status).toBe(75);
    const done = new Promise(resolve => child.once("exit", resolve)); child.stdin?.end("finish\n"); await done;
    expect(attempt().status).toBe(0);
  });
  it("actual daemon restart retains its detached tunnel and refuses a competing daemon", async () => {
    const dir = state();
    for (const file of ["tunnel-process-owner.py", "tunnel-app-guard.sh", "app-operation-lock.sh"]) {
      writeFileSync(path.join(dir, file), readFileSync(`scripts/${file}`));
    }
    // Keep the actual lifecycle/locking/launch/adoption code. Substitute only
    // external Docker/HTTP/application operations and the private QA environment.
    const daemon = readFileSync("scripts/public-tunnel-daemon.sh", "utf8")
      .replace(/^export PATH=.*$/m, `export PATH=${JSON.stringify(env().PATH)}`)
      .replace(/^STATE_DIR=.*$/m, `STATE_DIR=${JSON.stringify(dir)}`)
      .replace("LOCAL_PORT=3100", "LOCAL_PORT=39871")
      .replace("# One daemon owns", `wait_for_docker() { return 0; }
apply_url() { printf '%s\\n' "$1" > "$URL_FILE"; echo QA_APPLIED; }
ensure_url() { return 0; }
sleep() { /bin/sleep 0.03; }
# One daemon owns`);
    const file = path.join(dir, "public-tunnel-daemon.sh"); writeFileSync(file, daemon);
    async function startDaemon() {
      const child = spawn("/bin/bash", [file], { env: env() }); children.push(child);
      await new Promise<void>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error(`daemon timeout: ${output}`)), 8000);
        child.stdout?.on("data", data => {
          output += String(data);
          if (output.includes("QA_APPLIED")) { clearTimeout(timer); resolve(); }
        });
        child.once("exit", code => { clearTimeout(timer); reject(new Error(`daemon exited ${code}: ${output}`)); });
      });
      return child;
    }
    const first = await startDaemon();
    const pid = Number(run(dir, "status").stdout); expect(pid).toBeGreaterThan(1);
    const conflict = spawnSync("/bin/bash", [file], { env: env(), encoding: "utf8", timeout: 3000 });
    expect(conflict.status).toBe(75);
    const exited = new Promise(resolve => first.once("exit", resolve)); first.kill("SIGTERM"); await exited;
    expect(Number(run(dir, "status").stdout)).toBe(pid);
    await startDaemon();
    expect(Number(run(dir, "status").stdout)).toBe(pid);
    expect(readFileSync(path.join(dir, "current-url.txt"), "utf8").trim()).toBe("https://owned-process-qa.trycloudflare.com");
  }, 15000);
  it("all lifecycle entrypoints use ownership and never bulk-match processes", () => {
    for (const file of ["public-tunnel-daemon.sh", "install-public-tunnel.sh", "remove-public-tunnel.sh"]) {
      const src = readFileSync(`scripts/${file}`, "utf8");
      expect(src).not.toMatch(/^\s*(?:\S*\/)?p(?:kill|grep)\b/m);
      expect(src).toContain("tunnel-process-owner.py");
      expect(src).not.toMatch(/kill\s+"\$(?:CF_PID|EXISTING_PID)"/);
    }
    const daemon = readFileSync("scripts/public-tunnel-daemon.sh", "utf8");
    expect(daemon).toContain('8>&- 9>&-');
    expect(daemon.indexOf("tunnel_process lock")).toBeLessThan(daemon.indexOf('while true; do'));
    const cleanup = daemon.split("cleanup() {")[1].split("\n}")[0];
    expect(cleanup).not.toMatch(/kill|stop_tunnel/);
  });
});
