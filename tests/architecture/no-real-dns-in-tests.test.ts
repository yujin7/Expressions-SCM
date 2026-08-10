/**
 * 单测不得依赖真实 DNS 解析（合并门可信度护栏）。
 *
 * 事故经过：`YonyouClient` 的出站防重绑守卫每次请求前会 `dns.lookup` 真实域名，
 * 而客户端**没有留注入点**——尽管测试注释写着"注入一个恒定公网地址，避免依赖网络"，
 * 那个注入点其实不存在。后果是挂 VPN 或断网时每条用例卡满 30 秒超时：
 * 实测 yonyou-client 5/9 失败、单文件跑 150 秒，yonyou-sync 4/4 失败，
 * 整个 `npm test` 从 63 秒膨胀到 221 秒。
 *
 * 这类失败最坏的地方在于它与被测代码无关——排查时会误以为是自己刚改的东西弄坏的。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("单测不依赖真实 DNS", () => {
  const files = walk("tests");

  it("扫描到足够多的测试文件（防止 walk 失效变成空跑）", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("凡是构造 YonyouClient 的测试都必须注入 dnsLookup", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("new YonyouClient(")) continue;
      if (!src.includes("dnsLookup")) offenders.push(file);
    }
    expect(
      offenders,
      `以下测试构造了 YonyouClient 却没注入 dnsLookup，会真去解析域名并在断网/VPN 下卡 30 秒超时：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("DNS 注入点仍然存在——被删掉的话上面那条护栏会变成空断言", async () => {
    const src = readFileSync("src/server/integrations/yonyou-client.ts", "utf8");
    expect(src).toMatch(/dnsLookup\?:\s*DnsLookup/);
    expect(src).toMatch(/assertYonyouDnsResolutionSafe\(url,\s*this\.dnsLookup\)/);
  });
});
