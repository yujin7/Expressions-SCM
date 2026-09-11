import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const guard = readFileSync("scripts/tunnel-app-guard.sh", "utf8");
const revision = "a".repeat(40);
const image = `sha256:${"b".repeat(64)}`;
const otherImage = `sha256:${"c".repeat(64)}`;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("public access requires an identified, healthy HTTPS build", () => {
  const good = { ok: true, dbOk: true, drift: false, migrationState: "current", migrationFiles: 61, applied: 61,
    build: { revision, source: "build-arg" } };
  function probe(body: unknown = good, hsts = "max-age=31536000; includeSubDomains", httpOk = true) {
    const script = /TUNNEL_APP_HEALTH='([^']+)'/.exec(guard)?.[1];
    expect(script).toBeTruthy();
    return spawnSync(process.execPath, ["-e", `
      global.fetch = async (url, options) => {
        if (url !== "http://127.0.0.1:3000/api/health" || !options.signal || options.redirect !== "error" || options.cache !== "no-store") process.exit(99);
        return { ok: ${httpOk}, headers: new Headers(${JSON.stringify({ "strict-transport-security": hsts })}), json: async () => (${JSON.stringify(body)}) };
      };
      ${script}
    `], { encoding: "utf8", timeout: 3000 });
  }
  it("outputs only the verified commit, no config or payload", () => {
    const r = probe(); expect(r.status).toBe(0); expect(r.stdout).toBe(revision);
  });
  it.each(["", "max-age=0", "max-age=-1", "max-age=unknown", "x-max-age=31536000"])("rejects absent or invalid HSTS: %s", (hsts) => {
    expect(probe(good, hsts).status).toBe(1);
  });
  it.each([null, {}, { ...good, dbOk: false }, { ...good, drift: true }, { ...good, applied: 60 },
    { ...good, migrationState: "unknown" }, { ...good, build: { revision, source: "git-dirty" } },
    { ...good, build: { revision: null, source: "unknown" } }])("rejects unready runtime %j", (body) => {
    expect(probe(body).status).toBe(1);
  });
  it("rejects HTTP failure even with a valid-looking payload", () => { expect(probe(good, "max-age=1", false).status).toBe(1); });
});

describe("address changes preserve the deployed image and database", () => {
  function sync(scenario: string, url = "https://test-access-only-qa.trycloudflare.com") {
    const dir = mkdtempSync(path.join(tmpdir(), "scm-tunnel-guard-")); dirs.push(dir);
    const r = spawnSync("/bin/bash", ["-c", `
      set -uo pipefail
      PROJECT=synthetic-only ENV_FILE=synthetic.env COMPOSE_PROD=prod.yml COMPOSE_LOCAL=local.yml
      RUNTIME_DIR="$QA_DIR"
      docker() {
        case "$1" in
          info) echo qa-tunnel-guard ;;
          inspect)
            [ "$QA_SCENARIO" != inspect-fails ] || return 12
            if [ "$QA_SCENARIO" = invalid-image ]; then echo 'bad';
            elif [ -f "$QA_DIR/updated" ] && [ "$QA_SCENARIO" = image-changed ]; then echo '${otherImage}';
            else echo '${image}'; fi ;;
          exec)
            [ "$QA_SCENARIO" != health-fails ] || return 13
            if [ -f "$QA_DIR/updated" ] && [ "$QA_SCENARIO" = revision-changed ]; then echo '${"d".repeat(40)}'; else echo '${revision}'; fi ;;
          compose)
            if [[ "$*" == *'config --format json'* ]]; then
              printf '{"name":"qa-tunnel-%s"}\\n' "$QA_SCENARIO"
            elif [[ "$*" == *'ps -q app'* ]]; then
              [ "$QA_SCENARIO" != ps-fails ] || return 11
              case "$QA_SCENARIO" in
                absent) : ;;
                multiple) printf 'one\\ntwo\\n' ;;
                race) if [ -f "$QA_DIR/read" ]; then echo changed; else touch "$QA_DIR/read"; echo one; fi ;;
                *) echo one ;;
              esac
            elif [[ "$*" == *'up -d'* ]]; then
              printf 'UPDATE %s AUTH_URL=%s\\n' "$*" "$AUTH_URL" >> "$QA_DIR/commands"
              local arg
              for arg in "$@"; do
                case "$arg" in "$QA_DIR"/.app-image.*) cat "$arg" >> "$QA_DIR/commands" ;; esac
              done
              touch "$QA_DIR/updated"
              [ "$QA_SCENARIO" != up-fails ] || return 14
            else return 98; fi ;;
          *) return 99 ;;
        esac
      }
      source ${JSON.stringify(path.resolve("scripts/tunnel-app-guard.sh"))}
      tunnel_sync_url "$QA_URL" || exit 1
      tunnel_verify_same_app || exit 2
      echo VERIFIED
    `], { encoding: "utf8", timeout: 3000,
      env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", QA_DIR: dir, QA_SCENARIO: scenario, QA_URL: url } });
    expect(readdirSync(dir).filter(f => f.startsWith(".app-image."))).toEqual([]);
    return { ...r, commands: existsSync(path.join(dir, "commands")) ? readFileSync(path.join(dir, "commands"), "utf8") : "" };
  }
  it("pins the observed image ID, never pulls/builds/migrates or starts dependencies", () => {
    const r = sync("good"); expect(r.status).toBe(0);
    expect(r.commands).toContain(`image: "${image}"`);
    expect(r.commands).toContain("up -d --no-build --no-deps --pull never app");
    expect(r.commands).toContain("AUTH_URL=https://test-access-only-qa.trycloudflare.com");
    expect(r.stdout).toContain("VERIFIED");
  });
  it.each(["ps-fails", "absent", "multiple", "inspect-fails", "invalid-image", "health-fails", "race"])("rejects %s before reconfiguration", scenario => {
    const r = sync(scenario); expect(r.status).toBe(1); expect(r.commands).not.toContain("UPDATE");
  });
  it("propagates a failed reconfiguration", () => { expect(sync("up-fails").status).toBe(1); });
  it.each(["image-changed", "revision-changed"])("does not publish success after %s", scenario => {
    const r = sync(scenario); expect(r.status).toBe(2); expect(r.stdout).not.toContain("VERIFIED");
  });
  it.each(["http://test-access-only-qa.trycloudflare.com", "https://api.trycloudflare.com", "https://test-access-only-qa.trycloudflare.com.evil.invalid", "https://test-access-only-qa.trycloudflare.com/path"])("rejects a non-tunnel origin %s", url => {
    const r = sync("good", url); expect(r.status).toBe(1); expect(r.commands).not.toContain("UPDATE");
  });
});
