import { describe, expect, it, vi } from "vitest";
import { JstClient, signJstParams } from "@/server/integrations/jst";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("聚水潭 v2 client", () => {
  it("按官方 key 排序/secret 前缀/MD5 小写规则签名，且忽略空值与 sign", () => {
    expect(signJstParams("secret", {
      access_token: "token",
      app_key: "app",
      biz: "{\"page_index\":1,\"page_size\":50}",
      charset: "utf-8",
      timestamp: "1785312000",
      version: "2",
      sign: "must-not-sign-itself",
      empty: "",
    })).toBe("63b407c8cb9317b230c24ec1536f4fa2");
  });

  it("以表单 POST 发送完全相同的 biz 字符串与签名，不把 secret 放进载荷", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      response({ code: 0, data: { datas: [], has_next: false } }));
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const client = new JstClient({
      appKey: "app",
      appSecret: "secret",
      accessToken: "token",
      baseUrl: "https://example.invalid",
    }, {
      fetchImpl,
      now: () => new Date("2026-07-29T00:00:00Z"),
      retries: 0,
    });

    await client.queryOutboundOrdersPage({ page_index: 1, page_size: 50 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.invalid/open/orders/out/simple/query");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    });
    const form = new URLSearchParams(String(init.body));
    expect(form.get("biz")).toBe("{\"page_index\":1,\"page_size\":50}");
    expect(form.get("sign")).toMatch(/^[a-f0-9]{32}$/);
    expect(String(init.body)).not.toContain("secret");
  });

  it("按最大 ts 游标无重复翻页，并限制页面为官方最大 50 行", async () => {
    const pages = [
      {
        code: 0,
        data: {
          has_next: true,
          datas: [{
            io_id: "IO-1",
            status: "Confirmed",
            io_date: "2026-07-28 10:00:00",
            ts: 101,
            items: [{ sku_id: "SKU-A", qty: "2.0000", ioi_id: "L1" }],
          }],
        },
      },
      {
        code: 0,
        data: {
          has_next: false,
          datas: [{
            io_id: "IO-2",
            status: "Archive",
            io_date: "2026-07-28 11:00:00",
            ts: 103,
            items: [{ sku_id: "SKU-A", qty: "3", ioi_id: "L2" }],
          }],
        },
      },
      { code: 0, data: { has_next: false, datas: [] } },
    ];
    const fetchMock = vi.fn(async () => response(pages.shift()));
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const client = new JstClient({
      appKey: "app",
      appSecret: "secret",
      accessToken: "token",
      baseUrl: "https://example.invalid",
    }, { fetchImpl, retries: 0 });

    const orders = await client.fetchOutboundOrdersForDay("2026-07-28");

    expect(orders.map((row) => row.ioId)).toEqual(["IO-1", "IO-2"]);
    const first = new URLSearchParams(String((fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1].body));
    const second = new URLSearchParams(String((fetchMock.mock.calls[1] as unknown as [unknown, RequestInit])[1].body));
    expect(JSON.parse(first.get("biz")!)).toMatchObject({ start_ts: "1", page_size: 50, date_type: 2 });
    expect(JSON.parse(second.get("biz")!)).toMatchObject({ start_ts: "101", page_size: 50, date_type: 2 });
  });

  it("同一出库单扫描中再次变更时保留最大 ts 的最新版本", async () => {
    const pages = [
      {
        code: 0,
        data: {
          datas: [{
            io_id: "IO-1",
            status: "WaitConfirm",
            io_date: "2026-07-28 10:00:00",
            ts: 101,
            items: [{ sku_id: "SKU-A", qty: "1", ioi_id: "L1" }],
          }],
        },
      },
      {
        code: 0,
        data: {
          datas: [{
            io_id: "IO-1",
            status: "Confirmed",
            io_date: "2026-07-28 10:00:00",
            ts: 102,
            items: [{ sku_id: "SKU-A", qty: "2", ioi_id: "L1" }],
            batchs: [{
              batch_no: "LOT-1",
              ioi_id: "L1",
              sku_id: "SKU-A",
              qty: "2",
              product_date: "2026-06-01",
              expiration_date: "2028-06-01",
            }],
          }],
        },
      },
      { code: 0, data: { datas: [] } },
    ];
    const fetchImpl = vi.fn(async () => response(pages.shift())) as unknown as typeof fetch;
    const client = new JstClient({
      appKey: "app",
      appSecret: "secret",
      accessToken: "token",
      baseUrl: "https://example.invalid",
    }, { fetchImpl, retries: 0 });

    const orders = await client.fetchOutboundOrdersForDay("2026-07-28");

    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      ioId: "IO-1",
      status: "Confirmed",
      cursor: "102",
      items: [{ skuCode: "SKU-A", qty: "2" }],
      batches: [{
        batchNo: "LOT-1",
        lineId: "L1",
        skuCode: "SKU-A",
        qty: "2",
        productionDate: "2026-06-01",
        expirationDate: "2028-06-01",
      }],
    });
  });

  it("游标不前进时拒绝无限重放", async () => {
    const fetchImpl = vi.fn(async () => response({
      code: 0,
      data: {
        has_next: true,
        datas: [{
          io_id: "IO-1",
          status: "Confirmed",
          io_date: "2026-07-28 10:00:00",
          ts: 1,
          items: [{ sku_id: "SKU-A", qty: "1" }],
        }],
      },
    })) as unknown as typeof fetch;
    const client = new JstClient({
      appKey: "app",
      appSecret: "secret",
      accessToken: "token",
      baseUrl: "https://example.invalid",
    }, { fetchImpl, retries: 0 });

    await expect(client.fetchOutboundOrdersForDay("2026-07-28"))
      .rejects.toThrow("游标未前进");
  });

  it("对官方业务限流码退避后重试，但不会把 token 失效伪装成瞬时成功", async () => {
    const bodies = [
      { code: 199, msg: "frequency limit" },
      { code: 0, data: { datas: [], has_next: false } },
    ];
    const sleep = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => response(bodies.shift())) as unknown as typeof fetch;
    const client = new JstClient({
      appKey: "app",
      appSecret: "secret",
      accessToken: "token",
      baseUrl: "https://example.invalid",
    }, { fetchImpl, retries: 0, sleep });

    await client.queryOutboundOrdersPage({ page_size: 50 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("库存查询使用 100 行页上限与 ts 游标", async () => {
    const pages = [
      {
        code: 0,
        data: {
          has_next: false,
          inventorys: [{
            sku_id: "SKU-A",
            wms_co_id: "10",
            qty: "12.5000",
            ts: 500,
          }],
        },
      },
      { code: 0, data: { has_next: false, inventorys: [] } },
    ];
    const fetchMock = vi.fn(async () => response(pages.shift()));
    const client = new JstClient({
      appKey: "app",
      appSecret: "secret",
      accessToken: "token",
      baseUrl: "https://example.invalid",
    }, { fetchImpl: fetchMock as unknown as typeof fetch, retries: 0 });

    const rows = await client.fetchInventoryChanged({
      startCursor: "1",
      warehouseCode: "10",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ skuCode: "SKU-A", qty: "12.5000", cursor: "500" });
    const form = new URLSearchParams(
      String((fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1].body),
    );
    expect(JSON.parse(form.get("biz")!)).toMatchObject({
      ts: "1",
      page_size: 100,
      wms_co_id: "10",
    });
    expect(JSON.parse(form.get("biz")!)).not.toHaveProperty("modified_begin");
    expect(JSON.parse(form.get("biz")!)).not.toHaveProperty("modified_end");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("库存响应缺仓库字段时保留请求仓粒度，并校验扩展库存数量", async () => {
    const pages = [
      {
        code: 0,
        data: {
          has_next: false,
          inventorys: [{
            sku_id: "SKU-A",
            i_id: "ITEM-A",
            name: "测试商品",
            qty: "12.5000",
            order_lock: "2",
            pick_lock: "1",
            lock_qty: "3",
            virtual_qty: "-1",
            purchase_qty: "5",
            return_qty: "0",
            in_qty: "4",
            allocate_qty: "2",
            sale_refund_qty: "1",
            defective_qty: "0.5",
            min_qty: "6",
            max_qty: "20",
            ts: 500,
          }],
        },
      },
      { code: 0, data: { has_next: false, inventorys: [] } },
    ];
    const fetchMock = vi.fn(async () => response(pages.shift()));
    const client = new JstClient({
      appKey: "app",
      appSecret: "secret",
      accessToken: "token",
      baseUrl: "https://example.invalid",
    }, { fetchImpl: fetchMock as unknown as typeof fetch, retries: 0 });

    const rows = await client.fetchInventoryChanged({
      startCursor: "1",
      warehouseCode: "10",
      includeLockQty: true,
    });

    expect(rows[0]).toMatchObject({
      skuCode: "SKU-A",
      itemId: "ITEM-A",
      name: "测试商品",
      warehouseCode: "10",
      qty: "12.5000",
      orderLockQty: "2",
      pickLockQty: "1",
      inventoryLockQty: "3",
      virtualQty: "-1",
      purchaseQty: "5",
      returnQty: "0",
      inboundQty: "4",
      transferInboundQty: "2",
      saleRefundInboundQty: "1",
      defectiveQty: "0.5",
      minQty: "6",
      maxQty: "20",
    });
    const form = new URLSearchParams(
      String((fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1].body),
    );
    expect(JSON.parse(form.get("biz")!)).toMatchObject({
      wms_co_id: "10",
      has_lock_qty: true,
    });
  });

  it("库存时间窗口查询不混入 ts，并按 page_index 翻页", async () => {
    const fetchMock = vi.fn(async () => response({
      code: 0,
      data: {
        has_next: false,
        inventorys: [{
          sku_id: "SKU-A",
          wms_co_id: "10",
          qty: "5",
          ts: 501,
        }],
      },
    }));
    const client = new JstClient({
      appKey: "app",
      appSecret: "secret",
      accessToken: "token",
      baseUrl: "https://example.invalid",
    }, { fetchImpl: fetchMock as unknown as typeof fetch, retries: 0 });

    await client.fetchInventoryChanged({
      modifiedBegin: "2026-07-28 00:00:00",
      modifiedEnd: "2026-07-28 23:59:59",
    });

    const form = new URLSearchParams(
      String((fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1].body),
    );
    const biz = JSON.parse(form.get("biz")!);
    expect(biz).toMatchObject({
      modified_begin: "2026-07-28 00:00:00",
      modified_end: "2026-07-28 23:59:59",
      page_index: 1,
      page_size: 100,
    });
    expect(biz).not.toHaveProperty("ts");
  });

  it("库存查询拒绝同时提供 ts 与时间窗口，避免违反官方互斥契约", async () => {
    const client = new JstClient({
      appKey: "app",
      appSecret: "secret",
      accessToken: "token",
      baseUrl: "https://example.invalid",
    }, { fetchImpl: vi.fn() as unknown as typeof fetch, retries: 0 });

    await expect(client.fetchInventoryChanged({
      startCursor: "1",
      modifiedBegin: "2026-07-28 00:00:00",
      modifiedEnd: "2026-07-28 23:59:59",
    })).rejects.toThrow("只能选择");
  });

  it("仓库目录按官方 has_next 分页并只保留生效返回项", async () => {
    const pages = [
      {
        code: 0,
        data: {
          has_next: true,
          datas: [{
            wms_co_id: 20,
            co_id: 100,
            name: "二号仓",
            is_main: false,
            status: "active",
          }],
        },
      },
      {
        code: 0,
        data: {
          has_next: false,
          datas: [{
            wms_co_id: 10,
            co_id: 100,
            name: "主仓",
            is_main: true,
            remark1: "三方",
          }],
        },
      },
    ];
    const fetchMock = vi.fn(async () => response(pages.shift()));
    const client = new JstClient({
      appKey: "app",
      appSecret: "secret",
      accessToken: "token",
      baseUrl: "https://example.invalid",
    }, { fetchImpl: fetchMock as unknown as typeof fetch, retries: 0 });

    const rows = await client.fetchWarehouses();

    expect(rows).toEqual([
      {
        warehouseCode: "10",
        companyCode: "100",
        name: "主仓",
        isMain: true,
        status: null,
        partnerRemark: "三方",
        merchantRemark: null,
      },
      {
        warehouseCode: "20",
        companyCode: "100",
        name: "二号仓",
        isMain: false,
        status: "active",
        partnerRemark: null,
        merchantRemark: null,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
