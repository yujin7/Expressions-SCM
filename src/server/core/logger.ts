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
