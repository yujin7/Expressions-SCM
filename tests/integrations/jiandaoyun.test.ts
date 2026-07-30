import { describe, expect, it, vi } from "vitest";
import {
  JiandaoyunClient,
  jiandaoyunConfigFromEnv,
  jiandaoyunSchemaHash,
} from "@/server/integrations/jiandaoyun";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("简道云 OpenAPI 客户端", () => {
  it("分页目录和数据，使用 app+entry 身份且不把凭据写入错误", async () => {
    const appId = "a".repeat(24);
    const entryId = "b".repeat(24);
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret-key");
      if (path.endsWith("/app/list")) {
        return response({ apps: [{ app_id: appId, name: "供应中心" }] });
      }
      if (path.endsWith("/app/entry/list")) {
        expect(body.app_id).toBe(appId);
        return response({ forms: [{ app_id: appId, entry_id: entryId, name: "货品档案" }] });
      }
      if (path.endsWith("/app/entry/widget/list")) {
        return response({
          widgets: [{
            name: "_widget_code",
            label: "货品编码",
            type: "text",
            items: [],
          }],
        });
      }
      if (path.endsWith("/app/entry/data/list")) {
        if (body.data_id) return response({ data: [] });
        return response({
          data: Array.from({ length: 100 }, (_, index) => ({
            _id: index.toString(16).padStart(24, "0"),
            _widget_code: `SKU-${index}`,
          })),
        });
      }
      return response({}, 404);
    }) as unknown as typeof fetch;
    const client = new JiandaoyunClient({
      apiKey: "secret-key",
      baseUrl: "https://example.invalid/api/v5",
    }, { fetchImpl, retries: 0 });

    await expect(client.listApps()).resolves.toEqual([{ appId, name: "供应中心" }]);
    await expect(client.listForms(appId)).resolves.toEqual([
      { appId, entryId, name: "货品档案" },
    ]);
    const widgets = await client.listWidgets(appId, entryId);
    expect(jiandaoyunSchemaHash(widgets)).toMatch(/^[0-9a-f]{64}$/);
    await expect(client.listRecords(appId, entryId)).resolves.toHaveLength(100);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("只接受 HTTPS 基址并允许 API key 独立于 MCP token", () => {
    expect(jiandaoyunConfigFromEnv({
      JIANDAOYUN_API_KEY: " api-key ",
    } as unknown as NodeJS.ProcessEnv)).toEqual({
      apiKey: "api-key",
      baseUrl: "https://api.jiandaoyun.com/api/v5",
    });
    expect(() => jiandaoyunConfigFromEnv({
      JIANDAOYUN_API_KEY: "api-key",
      JIANDAOYUN_BASE_URL: "http://example.invalid",
    } as unknown as NodeJS.ProcessEnv)).toThrow("必须使用 HTTPS");
  });
});
