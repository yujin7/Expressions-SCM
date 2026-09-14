import { afterEach, expect, it, vi } from "vitest";
import { postStockDocCommand } from "@/components/stock-doc-command";
const fetchMock = vi.fn<typeof fetch>(), doc = { id: 7, version: 2 };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); fetchMock.mockReset(); });
it.each([["submit", "pending"], ["withdraw", "draft"], ["void", "void"], ["short-close", "closed"]])("%s validates exact document, version and target", async (path, status) => {
  vi.stubGlobal("fetch", fetchMock); const response = { id: 7, version: 3, status, closedReason: "核对后退出" };
  fetchMock.mockResolvedValueOnce(Response.json(response));
  expect(await postStockDocCommand("/api/inventory/stock-doc", doc, path, { version: 2, reason: "核对后退出" })).toEqual(response);
  expect(fetchMock.mock.calls[0][0]).toBe(`/api/inventory/stock-doc/7/${path}`);
});
it.each([{ id: 8 }, { version: 4 }, { status: "draft" }, { closedReason: "别人的理由" }])("wrong response %j remains unconfirmed", async override => {
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockResolvedValueOnce(Response.json({ id: 7, version: 3, status: "void", closedReason: "核对后退出", ...override }));
  await expect(postStockDocCommand("/api/inventory/stock-doc", doc, "void", { reason: "核对后退出" })).rejects.toThrow("响应与原单不符");
});
it("timeout is bounded even when transport ignores abort, and a late response cannot settle success", async () => {
  vi.useFakeTimers(); vi.stubGlobal("fetch", fetchMock); const held = Promise.withResolvers<Response>(); fetchMock.mockReturnValueOnce(held.promise);
  const call = postStockDocCommand("/api/inventory/stock-doc", doc, "void", {}, 100); const rejected = expect(call).rejects.toThrow("响应超时");
  await vi.advanceTimersByTimeAsync(100); await rejected;
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true); held.resolve(Response.json({ id: 7, version: 3, status: "void" }));
});
it.each([false, true])("approval completed response retains existing idempotency contract (%s)", async idempotent => {
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockResolvedValueOnce(Response.json({ status: "completed", idempotent }));
  expect(await postStockDocCommand("/api/inventory/stock-doc", doc, "approve", { action: "approve" })).toEqual({ status: "completed", idempotent });
});
it("reversal creation must refer to the requested original", async () => {
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockResolvedValueOnce(Response.json({ id: 12, reversalOfId: 8, status: "draft" }));
  await expect(postStockDocCommand("/api/inventory/stock-doc", doc, "reverse", {})).rejects.toThrow("响应与原单不符");
});
it.each([["approve", "draft"], ["reject", "completed"]])("%s cannot accept the opposite decision %s", async (action, status) => {
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockResolvedValueOnce(Response.json({ status, idempotent: false }));
  await expect(postStockDocCommand("/api/inventory/stock-doc", doc, "approve", { action })).rejects.toThrow("响应与原单不符");
});
it("reject and valid original-linked reversal remain accepted", async () => {
  vi.stubGlobal("fetch", fetchMock); fetchMock.mockResolvedValueOnce(Response.json({ status: "draft", idempotent: false }))
    .mockResolvedValueOnce(Response.json({ id: 12, reversalOfId: 7, status: "draft" }));
  await expect(postStockDocCommand("/api/inventory/stock-doc", doc, "approve", { action: "reject" })).resolves.toMatchObject({ status: "draft" });
  await expect(postStockDocCommand("/api/inventory/stock-doc", doc, "reverse", {})).resolves.toMatchObject({ reversalOfId: 7 });
});
