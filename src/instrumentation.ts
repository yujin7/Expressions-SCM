/**
 * Next.js instrumentation（Next 15 默认启用，无需 experimental 开关）：
 * 进程启动打一条结构化 boot 日志——版本/环境可从容器日志首行直读。
 */
export async function register(): Promise<void> {
  // edge runtime 无 process.pid 等 Node 语义——boot 行只在 Node 侧打
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== "nodejs") return;
  const { log } = await import("@/server/core/logger");
  const pkg = (await import("../package.json")).default;
  log({
    level: "info",
    msg: "boot",
    app: pkg.name,
    version: pkg.version,
    nodeEnv: process.env.NODE_ENV ?? "development",
    nodeVersion: process.version,
  });
}
