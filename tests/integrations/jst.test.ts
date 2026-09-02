import { describe, expect, it, vi } from "vitest";
import {
  JstClient,
  jstEvidenceRefHasLiveBinding,
  jstConfigFromEnv,
  jstLiveEvidenceBinding,
  normalizeJstBaseUrl,
  signJstParams,
} from "@/server/integrations/jst";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("聚水潭 v2 client", () => {
  it("机器凭据只允许发送到聚水潭官方 HTTPS API 主机", () => {
    const env = {
      JST_APP_KEY: "app",
      JST_APP_SECRET: "secret",
      JST_ACCESS_TOKEN: "token",
      JST_BASE_URL: "https://openapi.jushuitan.com/",
    } as unknown as NodeJS.ProcessEnv;
    expect(jstConfigFromEnv(env)?.baseUrl).toBe("https://openapi.jushuitan.com");
    expect(normalizeJstBaseUrl("https://attacker.example")).toBeNull();
    expect(normalizeJstBaseUrl("https://openapi.jushuitan.com.evil.example")).toBeNull();
    expect(() => jstConfigFromEnv({
      ...env,
      JST_BASE_URL: "https://attacker.example",
    })).toThrow("官方 HTTPS API 基址");
  });

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

  it("店铺目录按 shop_id 去重分页且只保留非敏感授权元数据", async () => {
    const pages = [
      {
        code: 0,
        data: {
          has_next: true,
          shops: [{
            shop_id: 20,
            shop_name: "二号店",
            co_id: 100,
            shop_site: "tmall",
            auth_status: 2,
          }],
        },
      },
      {
        code: 0,
        data: {
          has_next: false,
          shops: [{
            shop_id: 10,
            platform_shop_name: "主店",
            co_id: 100,
            platform: "douyin",
            authorization_status: "authorized",
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

    await expect(client.fetchShops()).resolves.toEqual([
      {
        shopId: "10",
        name: "主店",
        companyCode: "100",
        platform: "douyin",
        authorizationStatus: "authorized",
      },
      {
        shopId: "20",
        name: "二号店",
        companyCode: "100",
        platform: "tmall",
        authorizationStatus: "2",
      },
    ]);
  });

  it("商品主档按修改窗口分页，只保留身份与生命周期字段", async () => {
    const fetchMock = vi.fn(async () => response({
      code: 0,
      data: {
        has_next: false,
        datas: [{
          sku_id: "SKU-A",
          i_id: "ITEM-A",
          name: "测试商品",
          properties_value: "50ml",
          enabled: 1,
          brand: "EXPRESSIONS",
          supplier_id: 8,
          modified: "2026-08-13 10:00:00",
          cost_price: "99.99",
          pic: "https://example.invalid/private.jpg",
          mobile: "13800000000",
        }],
      },
    }));
    const client = new JstClient({
      appKey: "app", appSecret: "secret", accessToken: "token", baseUrl: "https://example.invalid",
    }, { fetchImpl: fetchMock as unknown as typeof fetch, retries: 0 });

    const rows = await client.fetchItemsModified(
      "2026-08-13 00:00:00",
      "2026-08-13 23:59:59",
    );

    expect(rows).toEqual([{
      skuCode: "SKU-A",
      itemId: "ITEM-A",
      name: "测试商品",
      propertiesValue: "50ml",
      enabled: "1",
      brand: "EXPRESSIONS",
      supplierId: "8",
      modifiedAt: "2026-08-13 10:00:00",
    }]);
    expect(JSON.stringify(rows)).not.toContain("99.99");
    expect(JSON.stringify(rows)).not.toContain("13800000000");
    expect(JSON.stringify(rows)).not.toContain("private.jpg");
    const form = new URLSearchParams(
      String((fetchMock.mock.calls[0] as unknown as [unknown, RequestInit])[1].body),
    );
    expect(JSON.parse(form.get("biz")!)).toMatchObject({
      modified_begin: "2026-08-13 00:00:00",
      modified_end: "2026-08-13 23:59:59",
      page_index: 1,
      page_size: 50,
    });
  });

  it("采购入库只读解析保留批次谱系并排除成本、备注与联系人字段", async () => {
    const fetchMock = vi.fn(async () => response({
      code: 0,
      data: {
        has_next: false,
        datas: [{
          io_id: 100,
          po_id: 200,
          so_id: "EXT-1",
          supplier_id: 8,
          supplier_name: "合规供应商",
          wms_co_id: 10,
          status: "Confirmed",
          io_date: "2026-08-13 11:00:00",
          modified: "2026-08-13 11:05:00",
          type: "采购入库",
          receiver_mobile: "13800000000",
          remark: "敏感备注",
          items: [{
            ioi_id: 300,
            sku_id: "SKU-A",
            i_id: "ITEM-A",
            name: "测试商品",
            qty: "2.0000",
            cost_price: "99.99",
            cost_amount: "199.98",
          }],
          batchs: [{
            batch_no: "LOT-1",
            ioi_id: 300,
            sku_id: "SKU-A",
            qty: "2",
            product_date: "2026-07-01",
            expiration_date: "2028-07-01",
          }],
        }],
      },
    }));
    const client = new JstClient({
      appKey: "app", appSecret: "secret", accessToken: "token", baseUrl: "https://example.invalid",
    }, { fetchImpl: fetchMock as unknown as typeof fetch, retries: 0 });

    const rows = await client.fetchInboundReceiptsModified(
      "2026-08-13 00:00:00",
      "2026-08-13 23:59:59",
    );

    expect(rows).toEqual([expect.objectContaining({
      receiptId: "100",
      purchaseOrderId: "200",
      warehouseCode: "10",
      items: [expect.objectContaining({ skuCode: "SKU-A", qty: "2.0000" })],
      batches: [expect.objectContaining({
        batchNo: "LOT-1",
        skuCode: "SKU-A",
        expirationDate: "2028-07-01",
      })],
    })]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("13800000000");
    expect(serialized).not.toContain("敏感备注");
    expect(serialized).not.toContain("99.99");
    expect(serialized).not.toContain("199.98");
  });

  it("UAT 证据绑定应用和启用能力；打开库存或新增观察流后旧证据自动失效", () => {
    const env = {
      NODE_ENV: "test",
      JST_APP_KEY: "app-one",
      JST_INVENTORY_SYNC_ENABLED: "false",
    } satisfies NodeJS.ProcessEnv;
    const salesOnly = jstLiveEvidenceBinding(env);
    expect(salesOnly).toMatch(/^JST1_[A-F0-9]{24}$/);
    expect(jstEvidenceRefHasLiveBinding(`UAT-20260803-${salesOnly}`, env)).toBe(true);

    const inventoryEnabled = {
      ...env,
      JST_INVENTORY_SYNC_ENABLED: "true",
    } satisfies NodeJS.ProcessEnv;
    expect(jstLiveEvidenceBinding(inventoryEnabled)).not.toBe(salesOnly);
    expect(jstEvidenceRefHasLiveBinding(`UAT-20260803-${salesOnly}`, inventoryEnabled)).toBe(false);

    const itemMasterEnabled = {
      ...env,
      JST_OBSERVATION_SYNC_CONTRACTS: "item-master",
    } satisfies NodeJS.ProcessEnv;
    expect(jstLiveEvidenceBinding(itemMasterEnabled)).not.toBe(salesOnly);
    expect(jstEvidenceRefHasLiveBinding(`UAT-20260803-${salesOnly}`, itemMasterEnabled)).toBe(false);
  });
});
