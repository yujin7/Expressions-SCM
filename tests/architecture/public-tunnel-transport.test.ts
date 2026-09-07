/**
 * 公网隧道必须走 HTTP/2 传输（实测护栏）。
 *
 * cloudflared 默认用 QUIC(UDP)。2026-09-02 同一时刻、同一应用、同一台机器实测：
 *   - QUIC 隧道：/api/health 往返 0.65–1.4 s；并发拉取工作台的 33 个前端分块墙钟 4.3–7.8 s
 *   - HTTP/2 隧道：/api/health 0.32–0.42 s；同样 33 个分块墙钟 2.0–2.8 s
 * 本机直连同一接口只要 8–15 ms，所以用户感受到的"慢"几乎全在出境这一跳，
 * 而传输协议是唯一不花钱就能砍掉一半的杠杆。谁把这个开关删了，页面就会慢一倍。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("公网隧道传输协议", () => {
  it("守护脚本启动 cloudflared 时必须带 --protocol http2", () => {
    const src = readFileSync("scripts/public-tunnel-daemon.sh", "utf8");
    const launch = src.split("\n").find((l) => /^\s*"\$CLOUDFLARED_BIN" tunnel .*--url/.test(l));
    expect(launch, "找不到 cloudflared 启动行").toBeDefined();
    expect(launch).toContain("--protocol http2");
  });
});
