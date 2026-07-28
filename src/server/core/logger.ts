/**
 * 结构化 JSON 行日志（零依赖：项目未引 pino，console + JSON.stringify 收口）。
 * 每行固定携带 ts（ISO）+ pid；level 决定输出流（error/warn → stderr 系）。
 * 用途：进程 boot 行（src/instrumentation.ts）、未预期 500 落 errorId
 * （master/common.ts errorResponse）。业务错误（ApiError）不经此处——防日志噪音。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  msg: string;
  [field: string]: unknown;
}

/** 序列化防爆：字段含循环引用/BigInt 等不可序列化值时降级为 String() */
function safeStringify(obj: Record<string, unknown>): string {
  try {
    return JSON.stringify(obj);
  } catch {
    const flat: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      try {
        JSON.stringify(v);
        flat[k] = v;
      } catch {
        flat[k] = String(v);
      }
    }
    return JSON.stringify(flat);
  }
}

export function log(entry: LogEntry): void {
  const line = safeStringify({ ts: new Date().toISOString(), pid: process.pid, ...entry });
  if (entry.level === "error") console.error(line);
  else if (entry.level === "warn") console.warn(line);
  else console.log(line);
}

/** error_logs 落库入参（errorResponse 500 路径） */
export interface ErrorLogEntry {
  errorId: string;
  message: string;
  stack?: string | null;
  path?: string | null;
  method?: string | null;
  userId?: number | null;
}

/**
 * 未预期 500 落 error_logs 表（best-effort：任何失败吞掉——留档绝不能反过来
 * 弄坏响应/边界）。@/db 延迟 import：logger 保持零依赖、edge bundle 不吃 db 权重。
 * dbArg 仅供测试注入（PGlite）。
 */
export async function persistErrorLog(entry: ErrorLogEntry, dbArg?: unknown): Promise<void> {
  try {
    // 整体包在 !== 'edge' 静态分支内：logger 被 instrumentation 拉进 edge bundle，
    // 若 @/db（→ pg → fs）的 import() 不在可折叠死分支里，edge 编译期直接 Module not found。
    if (process.env.NEXT_RUNTIME !== "edge") {
      const { errorLogs } = await import("@/db/schema");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
      const db: any = dbArg ?? (await (await import("@/db")).getDbAsync());
      await db.insert(errorLogs).values({
        errorId: entry.errorId,
        message: entry.message.slice(0, 2000),
        stack: entry.stack ? entry.stack.slice(0, 8000) : null,
        path: entry.path ?? null,
        method: entry.method ?? null,
        userId: entry.userId ?? null,
      });
    }
  } catch {
    /* swallow——日志落库失败只能认（JSON 行日志仍在） */
  }
}
