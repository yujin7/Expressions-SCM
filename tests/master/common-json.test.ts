import { describe, expect, it } from "vitest";
import { ApiError, readJson, readOptionalJson } from "@/server/modules/master/common";

describe("master/common 请求体解析", () => {
  it("readJson 将坏 JSON 归类为 400，而不是系统 500", async () => {
    const req = new Request("http://local.test", { method: "POST", body: "{" });
    await expect(readJson(req)).rejects.toMatchObject({ status: 400 });
  });

  it("readOptionalJson 只允许真正的空体回落为空对象", async () => {
    const empty = new Request("http://local.test", { method: "POST" });
    await expect(readOptionalJson(empty)).resolves.toEqual({});

    const malformed = new Request("http://local.test", { method: "POST", body: "{" });
    await expect(readOptionalJson(malformed)).rejects.toBeInstanceOf(ApiError);
    await expect(readOptionalJson(new Request("http://local.test", { method: "POST", body: "{" })))
      .rejects.toMatchObject({ status: 400 });
  });

  it("readOptionalJson 保留合法 JSON，由端点 schema 决定允许字段", async () => {
    const req = new Request("http://local.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    await expect(readOptionalJson(req)).resolves.toEqual({ force: true });
  });
});
