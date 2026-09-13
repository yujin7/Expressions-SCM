import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "@/server/modules/master/common";
import { GET as flDetail, PATCH as flUpdate } from "@/app/api/matflow/fl/[id]/route";
import { GET as tlDetail, PATCH as tlUpdate } from "@/app/api/matflow/tl/[id]/route";
import { GET as ctDetail, PATCH as ctUpdate } from "@/app/api/matflow/ct/[id]/route";
import { POST as ctVoid } from "@/app/api/matflow/ct/[id]/void/route";
import { GET as flList } from "@/app/api/matflow/fl/route";
import { GET as tlList } from "@/app/api/matflow/tl/route";
const h = vi.hoisted(() => ({ fresh: vi.fn(), fl: vi.fn(), tl: vi.fn(), list: vi.fn(), update: vi.fn() }));
vi.mock("@/server/modules/outsource/common", () => ({ guardFreshWrite: h.fresh }));
vi.mock("@/server/modules/matflow/fl", () => ({ getFl: h.fl, listFls: h.list, updateFl: h.update }));
vi.mock("@/server/modules/matflow/tl", () => ({ getTl: h.tl, listTls: h.list, updateTl: h.update }));
vi.mock("@/server/modules/matflow/ct", () => ({ getCt: h.tl, updateCt: h.update, voidCt: h.update }));
const actor = { id: 7, name: "当前仓管", roles: ["warehouse"], isApprover: false };
const req = new NextRequest("http://localhost/api/matflow/fl");
const ctx = { params: Promise.resolve({ id: "19" }) };
beforeEach(() => {
  vi.clearAllMocks(); h.fresh.mockResolvedValue(actor);
  h.fl.mockResolvedValue({ id: 19, price: "30", actions: { approve: false, reject: true, reason: "结算已冻结" } });
  h.tl.mockImplementation(h.fl); h.list.mockResolvedValue({ rows: [], total: 0 });
});
const patchRequest = (body: string) => new NextRequest("http://localhost/api/matflow/fl/19", { method: "PATCH", headers: { "content-type": "application/json" }, body });
it("CT void forwards fresh actor and exact version/reason and never caches the result", async () => {
  const payload = { version: 3, reason: "原采购来源选错" };
  h.update.mockResolvedValue({ id: 19, status: "void", version: 4 });
  const response = await ctVoid(patchRequest(JSON.stringify(payload)), ctx);
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(h.update).toHaveBeenCalledExactlyOnceWith(actor, 19, payload);
});
it("CT void refuses stale session, bad ID and malformed JSON before mutation", async () => {
  h.fresh.mockRejectedValueOnce(new ApiError(401, "会话失效"));
  expect((await ctVoid(patchRequest("{}"), ctx)).status).toBe(401);
  expect((await ctVoid(patchRequest("{"), ctx)).status).toBe(400);
  expect((await ctVoid(patchRequest("{}"), { params: Promise.resolve({ id: "bad" }) })).status).toBe(400);
  expect(h.update).not.toHaveBeenCalled();
});
it("CT void preserves the actionable conflict and does not retry", async () => {
  h.update.mockRejectedValueOnce(new ApiError(409, "单据版本已变化，请重新读取"));
  const response = await ctVoid(patchRequest("{}"), ctx);
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "单据版本已变化，请重新读取" });
  expect(h.update).toHaveBeenCalledOnce();
});
it("draft PATCH forwards fresh actor and exact payload, with no automatic retry", async () => {
  const payload = { version: 3, fromWarehouseId: 1, toWarehouseId: 2, lines: [{ skuId: 1, qty: "1", batchId: null }] };
  h.update.mockResolvedValue({ id: 19, version: 4, status: "draft" });
  expect((await flUpdate(patchRequest(JSON.stringify(payload)), ctx)).status).toBe(200);
  expect(h.update).toHaveBeenCalledExactlyOnceWith(actor, 19, payload);
});
it("draft PATCH rejects stale session before service invocation", async () => {
  h.fresh.mockRejectedValue(new ApiError(401, "会话失效"));
  expect((await flUpdate(patchRequest("{}"), ctx)).status).toBe(401);
  expect(h.update).not.toHaveBeenCalled();
});
it("draft PATCH rejects malformed JSON and invalid IDs without calling the write", async () => {
  expect((await flUpdate(patchRequest("{"), ctx)).status).toBe(400);
  expect((await flUpdate(patchRequest("{}"), { params: Promise.resolve({ id: "bad" }) })).status).toBe(400);
  expect(h.update).not.toHaveBeenCalled();
});
it("draft PATCH preserves a useful version conflict, not a generic 500", async () => {
  h.update.mockRejectedValue(new ApiError(409, "版本已变化，请重新读取"));
  const response = await flUpdate(patchRequest("{}"), ctx);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: "版本已变化，请重新读取" });
  expect(h.update).toHaveBeenCalledTimes(1);
});
it("TL correction forwards only the fresh actor and exact original-line payload", async () => {
  const payload = { version: 3, toWarehouseId: 2, lines: [{ id: 17, qty: "1.25", reason: "defect_exchange" }] };
  h.update.mockResolvedValue({ id: 19, version: 4, status: "draft" });
  expect((await tlUpdate(patchRequest(JSON.stringify(payload)), ctx)).status).toBe(200);
  expect(h.update).toHaveBeenCalledExactlyOnceWith(actor, 19, payload);
});
it("TL correction refuses stale identity, malformed JSON and invalid IDs before mutation", async () => {
  h.fresh.mockRejectedValueOnce(new ApiError(401, "会话失效"));
  expect((await tlUpdate(patchRequest("{}"), ctx)).status).toBe(401);
  expect((await tlUpdate(patchRequest("{"), ctx)).status).toBe(400);
  expect((await tlUpdate(patchRequest("{}"), { params: Promise.resolve({ id: "bad" }) })).status).toBe(400);
  expect(h.update).not.toHaveBeenCalled();
});
it.each([flDetail, tlDetail, ctDetail, flList, tlList])("invalid current session fails before loading material facts", async handler => {
  h.fresh.mockRejectedValue(new ApiError(401, "会话已失效"));
  expect((await handler(req, ctx)).status).toBe(401);
  expect(h.fl).not.toHaveBeenCalled(); expect(h.tl).not.toHaveBeenCalled(); expect(h.list).not.toHaveBeenCalled();
});
it.each([flDetail, tlDetail, ctDetail])("detail forwards current identity and preserves masking", async handler => {
  const response = await handler(req, ctx), body = await response.json();
  expect(response.status).toBe(200);
  expect(handler === flDetail ? h.fl : h.tl).toHaveBeenCalledWith(19, undefined, actor);
  expect(body).not.toHaveProperty("price");
  expect(body.actions).toMatchObject({ approve: false, reject: true, reason: "结算已冻结" });
});
it("CT original-line correction uses fresh identity and returns unchanged conflict guidance", async () => {
  const payload = { version: 3, lines: [{ id: 17, qty: "1.2345", reason: "核对" }] };
  h.update.mockResolvedValueOnce({ id: 19, version: 4, status: "draft" });
  expect((await ctUpdate(patchRequest(JSON.stringify(payload)), ctx)).status).toBe(200);
  expect(h.update).toHaveBeenCalledExactlyOnceWith(actor, 19, payload);
  h.update.mockRejectedValueOnce(new ApiError(409, "版本已变化，请重新读取"));
  const response = await ctUpdate(patchRequest(JSON.stringify(payload)), ctx);
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "版本已变化，请重新读取" });
});
it("CT refuses stale identity, malformed JSON and invalid ID before mutation", async () => {
  h.fresh.mockRejectedValueOnce(new ApiError(401, "会话失效"));
  expect((await ctUpdate(patchRequest("{}"), ctx)).status).toBe(401);
  expect((await ctUpdate(patchRequest("{"), ctx)).status).toBe(400);
  expect((await ctUpdate(patchRequest("{}"), { params: Promise.resolve({ id: "bad" }) })).status).toBe(400);
  expect(h.update).not.toHaveBeenCalled();
});
it.each(["warehouse", "admin", "ops", "finance"])("both lists return current %s creation permission", async role => {
  h.fresh.mockResolvedValue({ ...actor, roles: [role] });
  for (const handler of [flList, tlList]) {
    expect((await (await handler(req)).json()).actions).toEqual({ create: ["warehouse", "admin"].includes(role) });
  }
});
