import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson, JsonRequestError, patchJson, postJson, putJson } from "@/components/fetchJson";

afterEach(() => vi.unstubAllGlobals());

function respond(body: BodyInit | null, status = 200) {
  const request = vi.fn().mockResolvedValue(new Response(body, { status }));
  vi.stubGlobal("fetch", request);
  return request;
}

/** Real Response parsing, with independently controlled arrival of the response body. */
function delayedBody(status = 200) {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const reading = Promise.withResolvers<void>();
  const body = new ReadableStream<Uint8Array>({
    start(controller) { streamController = controller; },
    pull() { reading.resolve(); },
  }, { highWaterMark: 0 });
  const request = vi.fn().mockResolvedValue(new Response(body, { status }));
  vi.stubGlobal("fetch", request);
  return {
    request,
    reading: reading.promise,
    finish(value: string) {
      streamController.enqueue(new TextEncoder().encode(value));
      streamController.close();
    },
    fail(error: unknown) { streamController.error(error); },
  };
}

describe("shared JSON request contract", () => {
  it("preserves bounded error code and status for workflow decisions without retaining response data", async () => {
    respond(JSON.stringify({ error: "用量负差待核对", code: "SURPLUS_UNACKED", secret: "never retain" }), 409);
    const error = await postJson("/api/example", {}).catch(e => e);
    expect(error).toBeInstanceOf(JsonRequestError);
    expect(error).toMatchObject({ message: "用量负差待核对", code: "SURPLUS_UNACKED", status: 409 });
    expect(error).not.toHaveProperty("secret"); expect(error).not.toHaveProperty("body");
  });
  it.each([undefined, null, {}, 42, "bad code", "<html>", "X".repeat(81), "CODE\n", "code"])("rejects unsafe/non-contract machine code %j", async code => {
    respond(JSON.stringify({ error: "结余 acknowledgeSurplus 只是普通错误文本", code }), 403);
    await expect(postJson("/api/example", {})).rejects.toMatchObject({ status: 403, code: undefined });
  });
  it.each([{ rows: [] }, [], null, 0, false, "已完成"])("preserves valid JSON %j without imposing a DTO shape", async (value) => {
    const request = respond(JSON.stringify(value));
    await expect(fetchJson("/api/example")).resolves.toEqual(value);
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/example", undefined);
  });

  it.each(["", "   ", "{", "<html>proxy unavailable</html>"])("rejects a malformed/empty successful body %j instead of returning {}", async (body) => {
    const request = respond(body);
    await expect(fetchJson("/api/example")).rejects.toThrow("服务器响应不是有效的 JSON");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([204, 205])("rejects no-content %i: this helper requires JSON even for successful commands", async (status) => {
    respond(null, status);
    await expect(fetchJson("/api/example")).rejects.toThrow("服务器响应不是有效的 JSON");
  });

  it.each([400, 401, 403, 409, 500])("retains a bounded plain-text service error for HTTP %i", async (status) => {
    respond(JSON.stringify({ error: "  库存不足，请核对数量  ", internal: "never show this" }), status);
    await expect(fetchJson("/api/example")).rejects.toThrow(/^库存不足，请核对数量$/);
  });

  it.each([{}, null, [], { error: null }, { error: 42 }, { error: {} }, { error: " " },
    { error: "x".repeat(501) }, { error: "<html>错误</html>" }, { error: "错误\n stack trace" },
    { error: "错误\u202E隐藏" },
  ])("uses the HTTP fallback for an unsafe or absent error field %j", async (body) => {
    respond(JSON.stringify(body), 502);
    await expect(fetchJson("/api/example")).rejects.toThrow(/^请求失败（502）$/);
  });

  it.each(["", "<html>upstream failure</html>", "{broken"])("does not expose a non-JSON failure body %j", async (body) => {
    respond(body, 503);
    await expect(fetchJson("/api/example")).rejects.toThrow(/^请求失败（503）$/);
  });

  it("keeps ordinary comparisons in user-facing validation messages", async () => {
    respond(JSON.stringify({ error: "数量必须 > 0 且 <= 100" }), 400);
    await expect(fetchJson("/api/example")).rejects.toThrow(/^数量必须 > 0 且 <= 100$/);
  });

  it("waits for the real response body rather than treating headers as completion", async () => {
    const body = delayedBody();
    const success = vi.fn();
    const pending = fetchJson("/api/example").then(success);
    await body.reading;
    expect(success).not.toHaveBeenCalled();
    body.finish('{"rows":[1]}');
    await pending;
    expect(success).toHaveBeenCalledExactlyOnceWith({ rows: [1] });
  });

  it("does not send an already cancelled request, including a custom abort reason", async () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    controller.abort(reason);
    await expect(fetchJson("/api/example", { signal: controller.signal })).rejects.toBe(reason);
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves request-stage AbortError rather than reporting a network failure", async () => {
    const error = new DOMException("cancelled", "AbortError");
    const request = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("fetch", request);
    await expect(fetchJson("/api/example")).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("respects cancellation after headers even when a synthetic fetch ignores the signal", async () => {
    const controller = new AbortController();
    const response = new Response('{"rows":[]}');
    vi.stubGlobal("fetch", vi.fn(async () => { controller.abort(); return response; }));
    await expect(fetchJson("/api/example", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(response.bodyUsed).toBe(false);
  });

  it.each([200, 503])("preserves body-stage AbortError with HTTP %i", async (status) => {
    const body = delayedBody(status);
    const error = new DOMException("cancelled body", "AbortError");
    const pending = expect(fetchJson("/api/example")).rejects.toBe(error);
    await body.reading;
    body.fail(error);
    await pending;
    expect(body.request).toHaveBeenCalledTimes(1);
  });

  it.each(['{"rows":[1]}', "{broken"])("a cancelled signal wins over late body data %j", async (value) => {
    const body = delayedBody();
    const controller = new AbortController();
    const reason = new Error("superseded request");
    const pending = expect(fetchJson("/api/example", { signal: controller.signal })).rejects.toBe(reason);
    await body.reading;
    controller.abort(reason);
    body.finish(value);
    await pending;
  });

  it("reports a broken response stream without exposing its raw transport details", async () => {
    const body = delayedBody();
    const pending = expect(fetchJson("/api/example")).rejects.toThrow(/^服务器响应不是有效的 JSON$/);
    await body.reading;
    body.fail(new Error("transport internal detail"));
    await pending;
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("does not retry an ambiguous %s or encourage duplicate submission", async (method) => {
    const request = respond("{broken");
    await expect(fetchJson("/api/example", { method })).rejects.toThrow("操作可能已在服务端完成，请先核对结果，勿重复提交");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("preserves a service error ID while warning about an ambiguous server-side write failure", async () => {
    respond(JSON.stringify({ error: "系统错误，请联系管理员（错误码 abcd1234）" }), 500);
    await expect(postJson("/api/example", {})).rejects.toThrow(/^系统错误，请联系管理员（错误码 abcd1234）。操作可能已在服务端完成，请先核对结果，勿重复提交$/);
  });

  it.each(["GET", "POST"])("does not retry a %s network failure or expose transport details", async (method) => {
    const request = vi.fn().mockRejectedValue(new TypeError("private transport details"));
    vi.stubGlobal("fetch", request);
    const pending = fetchJson("/api/example", { method });
    await expect(pending).rejects.toThrow("网络连接异常，未能获取服务器响应");
    await expect(pending).rejects.not.toThrow("private transport details");
    if (method === "POST") await expect(pending).rejects.toThrow("勿重复提交");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([["POST", postJson], ["PATCH", patchJson], ["PUT", putJson]] as const)("keeps the %s helper's request contract", async (method, command) => {
    const request = respond('{"ok":true}', 201);
    await expect(command("/api/example", { id: 7 })).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledExactlyOnceWith("/api/example", {
      method, headers: { "Content-Type": "application/json" }, body: '{"id":7}',
    });
  });
});
