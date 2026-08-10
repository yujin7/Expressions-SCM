/** 快速隧道守护必须看端到端健康，不能只看进程 PID。 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const daemon = readFileSync("scripts/public-tunnel-daemon.sh", "utf8");

describe("公网快速隧道 watchdog", () => {
  it("健康判据同时覆盖 /api/health 与登录回跳", () => {
    expect(daemon).toContain("public_probe()");
    expect(daemon).toContain('"${url}/api/health"');
    expect(daemon).toContain("%{redirect_url}");
    expect(daemon).toContain('[[ "$redir" == "${url}"* ]]');
  });

  it("PID 存活但公网连续失败时清状态、终止旧隧道并回到外层重建", () => {
    expect(daemon).toContain("TUNNEL_FAILURE_LIMIT=3");
    expect(daemon).toContain("PUBLIC_FAILURES=$((PUBLIC_FAILURES + 1))");
    expect(daemon).toContain('rm -f "$URL_FILE"');
    expect(daemon).toContain('kill "$CF_PID"');
    expect(daemon).toContain('wait "$CF_PID"');
  });

  it("新地址必须先完成端到端验活，失败立即丢弃", () => {
    expect(daemon).toContain('if ! apply_url "$URL"; then');
    expect(daemon).toContain("新隧道未能通过端到端验活，立即重建");
  });
});
