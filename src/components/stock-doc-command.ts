import { fetchJson } from "./fetchJson";

/** Validate only the response of this request; a later GET is current state, not proof of who changed it. */
export async function postStockDocCommand(apiBase: string, doc: { id: number; version: number }, path: string,
  body: unknown, timeoutMs = 20_000) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    reject(Error("响应超时，操作可能已完成；请核对原单状态，不重复提交")); controller.abort();
  }, timeoutMs); });
  try {
    const result = await Promise.race([fetchJson<Record<string, unknown>>(`${apiBase}/${doc.id}/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal,
    }), timeout]);
    const targets: Record<string, string> = { submit: "pending", withdraw: "draft", void: "void", "short-close": "closed" };
    const { reason, action } = body as { reason?: string; action?: string };
    const approvalTarget = action === "approve" ? "completed" : action === "reject" ? "draft" : null;
    const valid = result && typeof result === "object" && (targets[path]
      ? result.id === doc.id && result.version === doc.version + 1 && result.status === targets[path]
        && (reason == null || result.closedReason === reason)
      : path === "reverse" ? Number.isSafeInteger(result.id) && Number(result.id) > 0 && result.reversalOfId === doc.id && result.status === "draft"
      : path === "approve" && approvalTarget != null && typeof result.idempotent === "boolean"
        && (result.idempotent ? ["approved", "draft", "in_progress", "completed", "closed"].includes(String(result.status)) : result.status === approvalTarget));
    if (!valid) throw Error("操作响应与原单不符，请核对原单状态，不重复提交");
    return result;
  } finally { clearTimeout(timer); }
}
