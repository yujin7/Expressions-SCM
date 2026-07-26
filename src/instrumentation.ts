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
  // 只启动一个调度权威：PostgreSQL=pg-boss；PGlite=进程内 interval 回退。
  // 必须包在 NEXT_RUNTIME==='nodejs' 静态分支里：webpack 常量折叠会把 edge bundle
  // 中的该分支整体消除——否则 @/db → pg → fs 在 edge 编译期就炸（Module not found）。
  const runJobs =
    process.env.NODE_ENV !== "development" ||
    process.env.SCM_RUN_JOBS === "1";
  if (process.env.NEXT_RUNTIME === "nodejs" && runJobs) {
    if ((process.env.DATABASE_URL ?? "").startsWith("postgres")) {
      const { ensureSchedulerStarted } = await import("@/jobs/scheduler");
      try {
        await ensureSchedulerStarted();
      } catch (error) {
        log({ level: "error", msg: "pg-boss scheduler start failed", error: String(error) });
      }
    } else {
      const { ensureIntervalJobsStarted } = await import("@/jobs/interval-runner");
      ensureIntervalJobsStarted();
    }
  }
}
