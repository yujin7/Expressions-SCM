import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { submitSupplierWork, supplierWorkHref } from "@/components/supplier-lifecycle-request";

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("receipts identify a case irrespective of the previous open/owner/search filters", async () => {
  fetchMock.mockResolvedValue(Response.json({ id: 12, status: "closed" }));
  expect(await submitSupplierWork("/api/master/supplier/lifecycle/12", "PATCH", { expectedVersion: 1 })).toEqual({ id: 12, status: "closed" });
  expect(supplierWorkHref(12)).toBe("/master/supplier/lifecycle?caseId=12&status=");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("times out without automatic replay, aborts response wait and retains uncertainty", async () => {
  fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  }));
  const result = submitSupplierWork("/case", "POST", { idempotencyKey: "fixed" });
  const rejection = expect(result).rejects.toThrow("操作可能已在服务端完成");
  await vi.advanceTimersByTimeAsync(30_000); await rejection;
  expect(fetchMock).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
});
it.each([null, {}, { id: "12", status: "open" }, { id: 0, status: "closed" }, { id: 12, status: "unknown" }])("does not announce success for an invalid receipt %j", async body => {
  fetchMock.mockResolvedValue(Response.json(body));
  await expect(submitSupplierWork("/case", "POST", {})).rejects.toThrow("回执格式异常");
});
it("preserves the server conflict explanation without retrying or accepting success", async () => {
  fetchMock.mockResolvedValue(Response.json({ error: "主档已变化，请先核对" }, { status: 409 }));
  await expect(submitSupplierWork("/case", "PATCH", {})).rejects.toThrow("主档已变化，请先核对");
  expect(fetchMock).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});
