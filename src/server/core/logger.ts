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

const REDACTED = "[REDACTED]";
const SECRET_KEY = /password|passwd|secret|token|apikey|authorization|cookie|connectionstring|databaseurl|privatekey|bankaccount/i;
const RAW_DATA_KEY = /^(?:sql|query|params|parameters|detail|body|payload|request|response|headers)$/i;
// Node 24 exposes Error.stack as a native accessor; allow only that exact getter,
// never an application's custom accessor. Older runtimes expose a plain value.
const NATIVE_STACK_GETTER = Object.getOwnPropertyDescriptor(new Error(), "stack")?.get;
const NATIVE_ERROR_PROTOTYPES = [Error.prototype, TypeError.prototype, RangeError.prototype,
  ReferenceError.prototype, SyntaxError.prototype, URIError.prototype, EvalError.prototype, AggregateError.prototype];

/** Diagnostic-only sanitization, never a business DTO or source-evidence transformation.
 * Unknown provider prose can contain unlabelled secrets: callers must use a fixed summary
 * for those failures, not assume pattern matching can recognize arbitrary sensitive text.
 */
export function sanitizeDiagnosticText(text: string): string {
  let safe = text.slice(0, 32_000);
  safe = safe.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, REDACTED);
  safe = safe.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED);
  // Drizzle messages include SQL + bind values; PostgreSQL DETAIL can contain the row itself.
  // Keep stack locations, not a partially scrubbed query whose literals could still leak.
  if (/failed query:|(?:^|\n)\s*(?:query|sql|params|parameters|detail)\s*:|Key\s*\([^)]+\)\s*=|\b(?:insert\s+into|delete\s+from|select\s+[\s\S]+?\s+from|update\s+\S+\s+set)\b/i.test(safe)) {
    safe = "[DATABASE_DIAGNOSTIC_REDACTED]" + safe.split("\n")
      .filter((line) => /^\s+at\s+.+:\d+:\d+\)?$/.test(line)).map((line) => `\n${line}`).join("");
  }
  safe = safe.replace(/\b(?:https?|postgres(?:ql)?):\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      const url = new URL(raw);
      if (url.username || url.password) { url.username = "redacted"; url.password = ""; }
      if (url.search) url.search = "redacted";
      if (url.hash) url.hash = "redacted";
      return url.toString();
    } catch { return "[URL_REDACTED]"; }
  });
  safe = safe.replace(/(\/api\/public\/po-confirm\/)[^\s/?#"']+/gi, `$1${REDACTED}`);
  safe = safe.replace(/(\/api\/[^\s?#"']*)[?#][^\s"']*/g, `$1?${REDACTED}`);
  safe = safe.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, `Authorization ${REDACTED}`);
  safe = safe.replace(/\b(?:set-cookie|cookie)\s*:\s*[^\r\n]+/gi, `cookie: ${REDACTED}`);
  safe = safe.replace(/(["']?\b[\w-]*(?:password|passwd|secret|token|api[_-]?key|authorization|connection[_-]?string|database[_-]?url|private[_-]?key|bank[_-]?account)[\w-]*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi, `$1"${REDACTED}"`);
  return safe.slice(0, 8_000);
}

/** Paths are diagnostic labels, not a place to retain search terms, auth codes or tokens. */
function diagnosticPath(path: string): string {
  return sanitizeDiagnosticText(path).replace(/[?#][\s\S]*$/, "?[REDACTED]");
}

function sqlStateOf(error: unknown): string | undefined {
  try {
    for (let depth = 0; depth < 6 && error && typeof error === "object"; depth++) {
      const fields = Object.getOwnPropertyDescriptors(error);
      const code = fields.code?.value;
      if (typeof code === "string" && /^[A-Z0-9]{5}$/.test(code)) return code;
      error = fields.cause?.value;
    }
  } catch { /* Uninspectable errors cannot supply a diagnostic code. */ }
  return undefined;
}

/** SQLSTATE proves this is a DB error even when PostgreSQL's message only quotes
 * an invalid input value (no SQL/params label). Keep code + frames, never that value.
 */
export function sanitizeErrorDiagnostic(error: unknown, text: string): string {
  const code = sqlStateOf(error);
  return code ? `SQLSTATE ${code}: ${sanitizeDiagnosticText(`Failed query:\n${text}`)}` : sanitizeDiagnosticText(text);
}

function diagnosticValue(value: unknown, seen: WeakSet<object>, depth = 0): unknown {
  if (typeof value === "string") return sanitizeDiagnosticText(value);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "object") return "[UNSUPPORTED]";
  if (depth >= 6 || seen.has(value)) return "[OMITTED]";
  seen.add(value);
  // Descriptors avoid invoking getters/toJSON while handling untrusted error metadata.
  const fields = Object.getOwnPropertyDescriptors(value);
  if (value instanceof Error) {
    const result: Record<string, unknown> = { name: "Error" };
    for (const key of ["name", "message", "stack", "code", "cause"]) {
      const field = fields[key];
      if (field && "value" in field) result[key] = (key === "message" || key === "stack") && typeof field.value === "string"
        ? sanitizeErrorDiagnostic(value, field.value) : diagnosticValue(field.value, seen, depth + 1);
    }
    const stack = fields.stack;
    if (NATIVE_STACK_GETTER && stack?.get === NATIVE_STACK_GETTER
      && NATIVE_ERROR_PROTOTYPES.includes(Object.getPrototypeOf(value))
      && (!fields.name || "value" in fields.name) && (!fields.message || "value" in fields.message)
    ) {
      const stackText: unknown = NATIVE_STACK_GETTER.call(value);
      result.stack = typeof stackText === "string" ? sanitizeErrorDiagnostic(value, stackText) : "[OMITTED]";
    }
    return result;
  }
  if (Array.isArray(value)) return Array.from({ length: Math.min(value.length, 50) }, (_, i) => {
    const field = fields[String(i)];
    return field && "value" in field ? diagnosticValue(field.value, seen, depth + 1) : "[OMITTED]";
  });
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return "[UNSUPPORTED]";
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, field] of Object.entries(fields).slice(0, 50)) {
    if (!field.enumerable || key === "toJSON") continue;
    if (SECRET_KEY.test(key.replace(/[_-]/g, "")) || RAW_DATA_KEY.test(key)) result[key] = REDACTED;
    else if (!("value" in field)) result[key] = "[OMITTED]";
    else if (key === "path" && typeof field.value === "string") result[key] = diagnosticPath(field.value);
    else if (["message", "stack", "error"].includes(key) && typeof field.value === "string") result[key] = sanitizeErrorDiagnostic(value, field.value);
    else result[key] = diagnosticValue(field.value, seen, depth + 1);
  }
  return result;
}

export function log(entry: LogEntry): void {
  let safe: unknown;
  try { safe = diagnosticValue(entry, new WeakSet()); }
  catch { safe = { level: entry.level, msg: "日志内容无法安全序列化" }; }
  const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...safe as Record<string, unknown> });
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
        message: sanitizeDiagnosticText(entry.message).slice(0, 2000),
        stack: entry.stack ? sanitizeDiagnosticText(entry.stack) : null,
        path: entry.path ? diagnosticPath(entry.path) : null,
        method: entry.method ?? null,
        userId: entry.userId ?? null,
      });
    }
  } catch {
    /* swallow——日志落库失败只能认（JSON 行日志仍在） */
  }
}
