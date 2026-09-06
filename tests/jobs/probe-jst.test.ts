import { describe, expect, it, vi } from "vitest";
import { probeJstReadiness, runJstPermissionProbe } from "@/jobs/probe-jst";
import { JstApiError } from "@/server/integrations/jst";

const env = {
  NODE_ENV: "test",
  JST_APP_KEY: "app",
  JST_APP_SECRET: "secret",
  JST_ACCESS_TOKEN: "token",
  JST_SYNC_ACTOR_ID: "2",
} satisfies NodeJS.ProcessEnv;

describe("聚水潭只读权限探针", () => {
  it("验证六个最小读取面但不返回源标识或执行写入", async () => {
    const page = { rows: [{ secretVendorIdentifier: "must-not-leak" }], hasNext: false };
    const client = {
      queryShopsPage: vi.fn(async () => page),
      queryWarehousesPage: vi.fn(async () => page),
      queryOutboundOrdersPage: vi.fn(async () => page),
      queryInventoryPage: vi.fn(async () => page),
      queryItemsPage: vi.fn(async () => page),
      queryInboundReceiptsPage: vi.fn(async () => page),
    };

    const result = await probeJstReadiness({
      env,
      client: client as never,
      bizDate: "2026-08-02",
    });

    expect(result).toMatchObject({
      status: "succeeded",
      authentication: "validated_by_signed_call",
      actor: { configured: true, id: 2 },
      bizDate: "2026-08-02",
      writesPerformed: false,
      exercises: {
        shops: { status: "succeeded", rows: 1, hasMore: false },
        warehouses: { status: "succeeded", rows: 1, hasMore: false },
        outboundSales: { status: "succeeded", rows: 1, hasMore: false },
        inventory: { status: "succeeded", rows: 1, hasMore: false },
        itemMaster: { status: "succeeded", rows: 1, hasMore: false },
        inboundReceipts: { status: "succeeded", rows: 1, hasMore: false },
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("token");
    expect(client.queryInventoryPage).toHaveBeenCalledWith(expect.objectContaining({
      modified_begin: "2026-08-02 00:00:00",
      modified_end: "2026-08-02 23:59:59",
      page_size: 1,
      has_lock_qty: true,
    }));
  });

  it("保留逐权限失败且只输出安全错误分类", async () => {
    const client = {
      queryShopsPage: vi.fn(async () => ({ rows: [], hasNext: false })),
      queryWarehousesPage: vi.fn(async () => { throw new JstApiError(401); }),
      queryOutboundOrdersPage: vi.fn(async () => { throw new Error("raw vendor payload"); }),
      queryInventoryPage: vi.fn(async () => ({ rows: [], hasNext: null })),
      queryItemsPage: vi.fn(async () => ({ rows: [], hasNext: false })),
      queryInboundReceiptsPage: vi.fn(async () => ({ rows: [], hasNext: false })),
    };

    const result = await probeJstReadiness({ env, client: client as never });

    expect(result).toMatchObject({
      status: "partial",
      authentication: "validated_by_signed_call",
      exercises: {
        warehouses: { status: "failed", error: "api_code_401" },
        outboundSales: { status: "failed", error: "unexpected_response" },
      },
      writesPerformed: false,
    });
    expect(JSON.stringify(result)).not.toContain("sensitive");
    expect(JSON.stringify(result)).not.toContain("raw vendor payload");
  });

  it("缺 access_token 时显式跳过且不调用外部 API", async () => {
    const client = {
      queryShopsPage: vi.fn(),
      queryWarehousesPage: vi.fn(),
      queryOutboundOrdersPage: vi.fn(),
      queryInventoryPage: vi.fn(),
      queryItemsPage: vi.fn(),
      queryInboundReceiptsPage: vi.fn(),
    };
    const result = await probeJstReadiness({
      env: { ...env, JST_ACCESS_TOKEN: "" },
      client: client as never,
    });
    expect(result).toMatchObject({ status: "skipped" });
    expect(client.queryShopsPage).not.toHaveBeenCalled();
  });

  it("调度留痕只保留有界权限结果，不保留源行", async () => {
    const client = {
      queryShopsPage: vi.fn(async () => ({ rows: [{ secret: "never" }], hasNext: false })),
      queryWarehousesPage: vi.fn(async () => { throw new JstApiError(190); }),
      queryOutboundOrdersPage: vi.fn(async () => { throw new JstApiError(110); }),
      queryInventoryPage: vi.fn(async () => ({ rows: [], hasNext: false })),
      queryItemsPage: vi.fn(async () => ({ rows: [], hasNext: false })),
      queryInboundReceiptsPage: vi.fn(async () => ({ rows: [], hasNext: false })),
    };
    const result = await runJstPermissionProbe({ env, client: client as never });
    expect(result).toMatchObject({ c: "jst", s: "partial", a: "validated", p: 4, t: 6, w: false });
    expect(result.r).toEqual(["ok", "api_code_190", "api_code_110", "ok", "ok", "ok"]);
    expect(JSON.stringify(result)).not.toContain("never");
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(500);
  });
});
