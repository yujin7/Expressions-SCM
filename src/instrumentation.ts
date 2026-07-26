/**
 * Next.js instrumentation（Next 15 默认启用，无需 experimental 开关）：
 * 进程启动打一条结构化 boot 日志——版本/环境可从容器日志首行直读。
 */
export async function register(): Promise<void> {
  // 必须使用正向的精确 Node 分支：webpack 会把整个分支从 Edge 包中消除。
  // 早退写法不足以保证 dead-code elimination，会让 pg-boss → pg → fs 泄入 Edge。
  if (process.env.NEXT_RUNTIME === "nodejs") {
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
    const runJobs =
      process.env.NODE_ENV !== "development" ||
      process.env.SCM_RUN_JOBS === "1";
    if (runJobs) {
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
}
