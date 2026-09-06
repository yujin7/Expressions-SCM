import { sanitizeErrorDiagnostic } from "@/server/core/logger";

/** Only application-built counts/contract keys belong in this message. Never pass
 * provider messages here. Raw causes stay available to code, not logging outputs.
 */
export class TaskDiagnosticError extends AggregateError {}

export function isExternalTask(name: string): boolean {
  return /^(?:sync-|probe-|audit-)|^reconcile-jst$/.test(name);
}

export function taskFailureMessage(name: string, error: unknown, errorId: string): string {
  if (isExternalTask(name) && !(error instanceof TaskDiagnosticError)) {
    return `外部任务执行失败（错误码 ${errorId}）；请核对连接器状态、授权及命令用法`;
  }
  return sanitizeErrorDiagnostic(error, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
}
