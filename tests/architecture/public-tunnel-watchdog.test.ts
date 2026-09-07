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
    // 阈值 3 → 5（2026-09-02）：隧道往返本就 0.6–1.4 s，30 秒一探、3 次即判死曾把正常抖动当故障，
    // 8/22 起每天换址 2–8 次。放宽到 5 次（2.5 分钟）仍能在真实中断时重建。
    expect(daemon).toContain("TUNNEL_FAILURE_LIMIT=5");
    expect(daemon).toContain("PUBLIC_FAILURES=$((PUBLIC_FAILURES + 1))");
    expect(daemon).toContain('rm -f "$URL_FILE"');
    expect(daemon).toContain('kill "$CF_PID"');
    expect(daemon).toContain('wait "$CF_PID"');
  });

  it("新地址必须先完成端到端验活，操作忙碌先重试，真正失败才丢弃", () => {
    expect(daemon).toContain('apply_url "$URL" || APPLY_STATUS=$?');
    expect(daemon).toContain('while [[ "$APPLY_STATUS" == 75 ]]');
    expect(daemon).toContain('if [[ "$APPLY_STATUS" != 0 ]]; then');
    expect(daemon).toContain("新隧道未能通过端到端验活，立即重建");
  });

  it("只接受带连字符的快速隧道域名，不把 API 控制端点当公网地址", () => {
    expect(daemon).toContain(
      "https://[a-z0-9]+(-[a-z0-9]+)+\\.trycloudflare\\.com",
    );
    expect(daemon).not.toContain("https://[a-z0-9-]+\\.trycloudflare\\.com");
  });
});

describe("Docker 退出自恢复（2026-09-04 实况）", () => {
  it("daemon 不可用时守护会拉起 Docker Desktop 再轮询，而不是干等 5 分钟后放弃", () => {
    expect(daemon).toContain("open -a Docker");
    expect(daemon).toMatch(/wait_for_docker\(\) \{[\s\S]*open -a Docker[\s\S]*return 1\n\}/);
  });
});
