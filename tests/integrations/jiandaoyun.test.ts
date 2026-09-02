import { describe, expect, it, vi } from "vitest";
import {
  JiandaoyunClient,
  jiandaoyunConfigFromEnv,
  jiandaoyunSchemaHash,
  normalizeJiandaoyunBaseUrl,
} from "@/server/integrations/jiandaoyun";
import { jiandaoyunContract } from "@/server/integrations/jiandaoyun-contracts";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("简道云 OpenAPI 客户端", () => {
  it("进入需求、渠道和损益决策的数量金额字段都有数值质量门禁", () => {
    const controls = (key: string) => new Map(
      (jiandaoyunContract(key)?.numericControls ?? []).map((rule) => [rule.target, rule.scale]),
    );
    expect([...controls("pdd-order-observation")]).toEqual(expect.arrayContaining([
      ["productQuantity", 4],
    ]));
    expect([...controls("vip-shop-trading-observation")]).toEqual(expect.arrayContaining([
      ["salesAmount", 2],
      ["salesQuantity", 4],
    ]));
    expect([...controls("tmall-product-pnl-observation")]).toEqual(expect.arrayContaining([
      ["actualTransactionAmount", 2],
      ["totalSalesCost", 2],
      ["estimatedGrossProfit", 2],
      ["estimatedNetProfit", 2],
      ["paidNumber", 4],
    ]));
  });
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
            appId,
            entryId,
            _widget_code: `SKU-${index}`,
          })),
        });
      }
      return response({}, 404);
    });
    const client = new JiandaoyunClient({
      apiKey: "secret-key",
      baseUrl: "https://example.invalid/api/v5",
    }, { fetchImpl: fetchImpl as unknown as typeof fetch, retries: 0 });

    await expect(client.listApps()).resolves.toEqual([{ appId, name: "供应中心" }]);
    await expect(client.listForms(appId)).resolves.toEqual([
      { appId, entryId, name: "货品档案" },
    ]);
    const widgets = await client.listWidgets(appId, entryId);
    expect(jiandaoyunSchemaHash(widgets)).toMatch(/^[0-9a-f]{64}$/);
    await expect(client.listRecords(
      appId,
      entryId,
      [" updateTime ", "_widget_code", "_widget_code"],
    )).resolves.toHaveLength(100);
    const dataRequests = fetchImpl.mock.calls.filter(([url]) =>
      new URL(String(url)).pathname.endsWith("/app/entry/data/list"));
    expect(dataRequests).toHaveLength(2);
    for (const [, init] of dataRequests) {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        fields: ["updateTime", "_widget_code"],
      });
    }
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("只接受简道云官方 HTTPS 基址并允许 API key 独立于 MCP token", () => {
    expect(jiandaoyunConfigFromEnv({
      JIANDAOYUN_API_KEY: " api-key ",
    } as unknown as NodeJS.ProcessEnv)).toEqual({
      apiKey: "api-key",
      baseUrl: "https://api.jiandaoyun.com/api/v5",
    });
    expect(() => jiandaoyunConfigFromEnv({
      JIANDAOYUN_API_KEY: "api-key",
      JIANDAOYUN_BASE_URL: "http://example.invalid",
    } as unknown as NodeJS.ProcessEnv)).toThrow("官方 HTTPS API 基址");
    expect(() => jiandaoyunConfigFromEnv({
      JIANDAOYUN_API_KEY: "api-key",
      JIANDAOYUN_BASE_URL: "https://attacker.example/api/v5",
    } as unknown as NodeJS.ProcessEnv)).toThrow("官方 HTTPS API 基址");
    expect(normalizeJiandaoyunBaseUrl(
      "https://api.jiandaoyun.com/api/v5/",
    )).toBe("https://api.jiandaoyun.com/api/v5");
    expect(normalizeJiandaoyunBaseUrl(
      "https://api.jiandaoyun.com/api/v5?redirect=1",
    )).toBeNull();
  });

  it("窗口订单同时回采近期业务日和近期更新，捕获迟到取消/退款", async () => {
    const appId = "a".repeat(24);
    const entryId = "b".repeat(24);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      response({ data: [] }));
    const client = new JiandaoyunClient({
      apiKey: "secret-key",
      baseUrl: "https://example.invalid/api/v5",
    }, { fetchImpl: fetchImpl as unknown as typeof fetch, retries: 0 });

    await client.listRecords(appId, entryId, ["updateTime", "_widget_date"], {
      field: "_widget_date",
      sinceDays: 3,
      includeUpdatedSince: true,
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      filter: { rel: string; cond: Array<{ field: string; value: string[] }> };
    };
    expect(body.filter.rel).toBe("or");
    expect(body.filter.cond.map((condition) => condition.field)).toEqual([
      "_widget_date",
      "updateTime",
    ]);
    expect(body.filter.cond[0]?.value).toEqual(body.filter.cond[1]?.value);
  });

  it("显式 fields 为空时拒绝退化为全字段下载", async () => {
    const client = new JiandaoyunClient({
      apiKey: "secret-key",
      baseUrl: "https://example.invalid/api/v5",
    }, {
      fetchImpl: vi.fn() as unknown as typeof fetch,
      retries: 0,
    });
    await expect(client.listRecords(
      "a".repeat(24),
      "b".repeat(24),
      [" ", ""],
    )).rejects.toThrow("fields 不得为空");
  });

  it("数据行的 appId/entryId 与请求不一致时拒绝跨表污染", async () => {
    const client = new JiandaoyunClient({
      apiKey: "secret-key",
      baseUrl: "https://example.invalid/api/v5",
    }, {
      retries: 0,
      fetchImpl: vi.fn(async () => response({
        data: [{
          _id: "c".repeat(24),
          appId: "d".repeat(24),
          entryId: "b".repeat(24),
        }],
      })) as unknown as typeof fetch,
    });
    await expect(client.listRecords(
      "a".repeat(24),
      "b".repeat(24),
      ["updateTime"],
    )).rejects.toThrow("表单身份与请求不一致");
  });
});
