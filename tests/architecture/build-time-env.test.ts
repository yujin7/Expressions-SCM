/**
 * 构建期环境变量必须由 Dockerfile 的 build ARG 供给（真实无效配置护栏）。
 *
 * 事故经过：为「走 HTTPS 才开 HSTS」加了 `process.env.PUBLIC_HTTPS === "1"` 门控，
 * 并把 PUBLIC_HTTPS 接在 docker-compose 的 `environment:` 上。看起来完全合理，
 * 实际**永远不会生效**——next.config.ts 的 `headers()` 由 `next build` 求值后烘焙进
 * .next/routes-manifest.json，运行期再设这个变量对已构建的镜像毫无作用。
 *
 * 2026-08-07 实测：容器 env 里确有 PUBLIC_HTTPS=1，但 routes-manifest.json 里
 * 只有 X-Frame-Options、没有 Strict-Transport-Security，响应头也确实没有。
 * 这类缺陷不会报错、不会告警，只会让人以为某个安全头已经开了——比没开更糟。
 *
 * 因此立一条不变量：next.config.ts 里读到的每个 process.env.X，
 * Dockerfile 的构建阶段都必须有对应的 `ARG X`。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const nextConfig = readFileSync("next.config.ts", "utf8");
const dockerfile = readFileSync("Dockerfile", "utf8");

/** next.config.ts 中被读取的环境变量名 */
function envNamesIn(src: string): string[] {
  const names = new Set<string>();
  for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/process\.env\[["'`]([A-Z0-9_]+)["'`]\]/g)) names.add(m[1]);
  return [...names];
}

/** Dockerfile 里声明过的 build ARG */
function declaredArgs(src: string): Set<string> {
  const args = new Set<string>();
  for (const m of src.matchAll(/^\s*ARG\s+([A-Za-z0-9_]+)/gm)) args.add(m[1]);
  return args;
}

/**
 * 刻意不接 build ARG 的构建期变量：**缺省值本身就是对的**，缺了不会造成静默错误。
 * 新增条目必须写清理由——这条清单存在的意义就是逼人显式分类，而不是随手加豁免。
 */
const INTENTIONALLY_UNPLUMBED: Record<string, string> = {
  NODE_ENV: "由 node/next 自身提供，无需外部传入",
  NEXT_DIST_DIR: "仅本地并行会话隔离用（.next-dev/.next-webpack）；Docker 内不设，回落 .next 即正确",
};

describe("构建期 env 必须有对应的 build ARG", () => {
  it("next.config.ts 读到的每个 process.env 都能在构建期真正拿到值", () => {
    const args = declaredArgs(dockerfile);
    const missing = envNamesIn(nextConfig)
      .filter((n) => !(n in INTENTIONALLY_UNPLUMBED))
      .filter((n) => !args.has(n));
    expect(
      missing,
      `next.config.ts 读了 ${missing.join(", ")}，但 Dockerfile 没有对应的 ARG。`
        + "把它接在 compose 的 environment: 上是无效的——headers()/其它 config 求值发生在 next build，"
        + "运行期再设对已构建的镜像不起作用。请在 build 阶段加 ARG + ENV，并在 compose 的 build.args 里传；"
        + "若缺省值本就正确，则登记进 INTENTIONALLY_UNPLUMBED 并写明理由。",
    ).toEqual([]);
  });

  it("PUBLIC_HTTPS 只能出现在 app 的 build.args，不能出现在运行期 environment", () => {
    const compose = readFileSync("docker-compose.prod.yml", "utf8");
    // 精确切到 app 服务块（db/migrate 也各有 environment:，整文件切会取错）
    const appBlock = compose.slice(compose.indexOf("\n  app:"));
    const envIdx = appBlock.indexOf("environment:");
    expect(envIdx, "app 服务应当有 environment: 区块").toBeGreaterThan(-1);

    const buildSection = appBlock.slice(0, envIdx);
    const runtimeSection = appBlock.slice(envIdx);

    expect(buildSection, "PUBLIC_HTTPS 必须作为 build arg 传入").toMatch(/args:[\s\S]*PUBLIC_HTTPS/);
    expect(
      runtimeSection.match(/^\s+PUBLIC_HTTPS:/m),
      "PUBLIC_HTTPS 不得出现在运行期 environment：它对已构建的镜像不起作用，"
        + "放在这里只会让人以为改了就生效",
    ).toBeNull();
  });

  it("公网安装核对已构建的 HTTPS 镜像，更新地址不能隐式发布另一镜像", () => {
    const installer = readFileSync("scripts/install-public-tunnel.sh", "utf8");
    const daemon = readFileSync("scripts/public-tunnel-daemon.sh", "utf8");
    const guard = readFileSync("scripts/tunnel-app-guard.sh", "utf8");
    expect(installer).toContain("tunnel_capture_app");
    expect(installer).not.toMatch(/build app/);
    expect(daemon).toContain('tunnel_sync_url "$url"');
    expect(guard).toContain("strict-transport-security");
    expect(guard).toContain("up -d --no-build --no-deps --pull never app");
  });
});
