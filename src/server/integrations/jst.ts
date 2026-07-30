import { createHash } from "node:crypto";
import { fetchJson, type FetchJsonOptions } from "./http";

const DEFAULT_BASE_URL = "https://openapi.jushuitan.com";
const OFFICIAL_API_HOST = "openapi.jushuitan.com";
const RATE_LIMIT_CODES = new Set([199, 200]);
const MAX_CURSOR_PAGES = 10_000;

export interface JstConfig {
  appKey: string;
  appSecret: string;
  accessToken: string;
  baseUrl?: string;
}

export interface JstOutboundItem {
  skuCode: string;
  qty: string;
  itemId: string | null;
  lineId: string | null;
  batchId: string | null;
  productionDate: string | null;
  expirationDate: string | null;
}

export interface JstOutboundBatch {
  batchNo: string | null;
  lineId: string | null;
  skuCode: string;
  qty: string;
  productionDate: string | null;
  expirationDate: string | null;
}

export interface JstOutboundOrder {
  ioId: string;
  orderId: string | null;
  salesOrderId: string | null;
  shopId: string | null;
  warehouseCode: string | null;
  status: string;
  ioDate: string;
  modifiedAt: string | null;
  cursor: string;
  items: JstOutboundItem[];
  batches: JstOutboundBatch[];
}

export interface JstInventoryRow {
  skuCode: string;
  itemId: string | null;
  name: string | null;
  warehouseCode: string | null;
  qty: string;
  orderLockQty: string | null;
  pickLockQty: string | null;
  inventoryLockQty: string | null;
  virtualQty: string | null;
  purchaseQty: string | null;
  returnQty: string | null;
  inboundQty: string | null;
  transferInboundQty: string | null;
  saleRefundInboundQty: string | null;
  defectiveQty: string | null;
  minQty: string | null;
  maxQty: string | null;
  modifiedAt: string | null;
  cursor: string;
}

export interface JstWarehouse {
  warehouseCode: string;
  companyCode: string;
  name: string;
  isMain: boolean;
  status: string | null;
  partnerRemark: string | null;
  merchantRemark: string | null;
}

export interface JstPage<T> {
  rows: T[];
  hasNext: boolean | null;
}

export function normalizeJstBaseUrl(
  raw: string | null | undefined,
): string | null {
  const value = raw?.trim() || DEFAULT_BASE_URL;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.hostname.toLowerCase() !== OFFICIAL_API_HOST
      || (url.port !== "" && url.port !== "443")
      || url.username
      || url.password
      || url.search
      || url.hash
      || !["", "/"].includes(url.pathname)
    ) return null;
    return DEFAULT_BASE_URL;
  } catch {
    return null;
  }
}

export class JstApiError extends Error {
  readonly code: number;
  readonly retryable: boolean;

  constructor(code: number, message: string) {
    super(`聚水潭 API ${code}: ${message || "未知错误"}`);
    this.name = "JstApiError";
    this.code = code;
    this.retryable = RATE_LIMIT_CODES.has(code);
  }
}

function nonEmpty(value: unknown): string | null {
  if (value == null) return null;
  const result = String(value).trim();
  return result === "" ? null : result;
}

function required(value: unknown, field: string): string {
  const result = nonEmpty(value);
  if (result === null) throw new Error(`聚水潭响应缺少 ${field}`);
  return result;
}

function decimalString(value: unknown, field: string): string {
  const result = required(value, field);
  if (!/^-?\d+(?:\.\d+)?$/.test(result)) throw new Error(`聚水潭响应 ${field} 不是十进制数`);
  return result;
}

function optionalDecimalString(value: unknown, field: string): string | null {
  const result = nonEmpty(value);
  if (result === null) return null;
  if (!/^-?\d+(?:\.\d+)?$/.test(result)) throw new Error(`聚水潭响应 ${field} 不是十进制数`);
  return result;
}

function cursorString(value: unknown, field: string): string {
  const result = required(value, field);
  if (!/^\d+$/.test(result)) throw new Error(`聚水潭响应 ${field} 不是有效 ts 游标`);
  return result;
}

function assertInventoryWindow(begin: string, end: string): void {
  const format = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  if (!format.test(begin) || !format.test(end)) {
    throw new Error("聚水潭库存修改时间须为 YYYY-MM-DD HH:mm:ss");
  }
  const beginMs = Date.parse(`${begin.replace(" ", "T")}Z`);
  const endMs = Date.parse(`${end.replace(" ", "T")}Z`);
  if (!Number.isFinite(beginMs) || !Number.isFinite(endMs) || endMs < beginMs) {
    throw new Error("聚水潭库存修改时间范围非法");
  }
  if (endMs - beginMs > 7 * 24 * 60 * 60 * 1000) {
    throw new Error("聚水潭库存修改时间范围不能超过七天");
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`聚水潭响应 ${label} 结构非法`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`聚水潭响应 ${label} 不是数组`);
  return value;
}

function extractRows(data: Record<string, unknown>): unknown[] {
  for (const key of ["datas", "items", "inventorys", "orders"]) {
    if (Array.isArray(data[key])) return data[key] as unknown[];
  }
  throw new Error("聚水潭响应未包含已知数据数组");
}

function parseHasNext(data: Record<string, unknown>): boolean | null {
  const value = data.has_next ?? data.hasNext;
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return null;
}

/**
 * 聚水潭 v2 signing contract: remove sign/empty values, sort keys, concatenate key+value,
 * prefix app_secret, MD5 UTF-8, lower-case hex. `biz` is signed as the exact JSON string sent.
 */
export function signJstParams(appSecret: string, params: Record<string, string | null | undefined>): string {
  const joined = Object.entries(params)
    .filter(([key, value]) => key !== "sign" && value != null && value !== "")
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, value]) => `${key}${value}`)
    .join("");
  return createHash("md5").update(`${appSecret}${joined}`, "utf8").digest("hex");
}

export function jstConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JstConfig | null {
  const appKey = env.JST_APP_KEY?.trim();
  const appSecret = env.JST_APP_SECRET?.trim();
  const accessToken = env.JST_ACCESS_TOKEN?.trim();
  if (!appKey || !appSecret || !accessToken) return null;
  const baseUrl = normalizeJstBaseUrl(env.JST_BASE_URL);
  if (!baseUrl) throw new Error("JST_BASE_URL 必须是聚水潭官方 HTTPS API 基址");
  return {
    appKey,
    appSecret,
    accessToken,
    baseUrl,
  };
}

export class JstClient {
  private readonly config: Required<JstConfig>;
  private readonly transport: FetchJsonOptions;
  private readonly now: () => Date;

  constructor(
    config: JstConfig,
    options: FetchJsonOptions & { now?: () => Date } = {},
  ) {
    this.config = {
      ...config,
      baseUrl: (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    };
    this.transport = options;
    this.now = options.now ?? (() => new Date());
  }

  async call(path: string, biz: Record<string, unknown>): Promise<Record<string, unknown>> {
    const bizJson = JSON.stringify(biz);
    const params: Record<string, string> = {
      access_token: this.config.accessToken,
      app_key: this.config.appKey,
      biz: bizJson,
      charset: "utf-8",
      timestamp: String(Math.floor(this.now().getTime() / 1000)),
      version: "2",
    };
    params.sign = signJstParams(this.config.appSecret, params);

    for (let attempt = 0; attempt < 3; attempt++) {
      const payload = await fetchJson(
        "聚水潭",
        `${this.config.baseUrl}${path}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body: new URLSearchParams(params).toString(),
        },
        this.transport,
      );
      const envelope = asObject(payload, "envelope");
      const code = Number(envelope.code);
      if (!Number.isFinite(code)) throw new Error("聚水潭响应缺少数值 code");
      if (code === 0) return asObject(envelope.data, "data");
      const apiError = new JstApiError(code, nonEmpty(envelope.msg ?? envelope.message) ?? "");
      if (!apiError.retryable || attempt === 2) throw apiError;
      const sleep = this.transport.sleep ?? ((ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms)));
      await sleep(500 * 2 ** attempt);
    }
    throw new Error("聚水潭 API 重试结束但未返回结果");
  }

  async queryOutboundOrdersPage(biz: Record<string, unknown>): Promise<JstPage<JstOutboundOrder>> {
    const data = await this.call("/open/orders/out/simple/query", biz);
    const rows = extractRows(data).map((raw, orderIndex) => {
      const order = asObject(raw, `orders[${orderIndex}]`);
      const rawItems = asArray(order.items ?? order.item_list ?? order.order_items ?? [], `orders[${orderIndex}].items`);
      const rawBatches = asArray(order.batchs ?? [], `orders[${orderIndex}].batchs`);
      return {
        ioId: required(order.io_id, "io_id"),
        orderId: nonEmpty(order.o_id),
        salesOrderId: nonEmpty(order.so_id),
        shopId: nonEmpty(order.shop_id),
        warehouseCode: nonEmpty(order.wms_co_id),
        status: required(order.status, "status"),
        ioDate: required(order.io_date, "io_date"),
        modifiedAt: nonEmpty(order.modified),
        cursor: cursorString(order.ts, "ts"),
        items: rawItems.map((rawItem, itemIndex) => {
          const item = asObject(rawItem, `orders[${orderIndex}].items[${itemIndex}]`);
          return {
            skuCode: required(item.sku_id, "items.sku_id"),
            qty: decimalString(item.qty, "items.qty"),
            itemId: nonEmpty(item.i_id),
            lineId: nonEmpty(item.ioi_id),
            batchId: nonEmpty(item.batch_id),
            productionDate: nonEmpty(item.product_date),
            expirationDate: nonEmpty(item.expiration_date),
          };
        }),
        batches: rawBatches.map((rawBatch, batchIndex) => {
          const batch = asObject(rawBatch, `orders[${orderIndex}].batchs[${batchIndex}]`);
          return {
            batchNo: nonEmpty(batch.batch_no),
            lineId: nonEmpty(batch.ioi_id),
            skuCode: required(batch.sku_id, "batchs.sku_id"),
            qty: decimalString(batch.qty, "batchs.qty"),
            productionDate: nonEmpty(batch.product_date),
            expirationDate: nonEmpty(batch.expiration_date),
          };
        }),
      };
    });
    return { rows, hasNext: parseHasNext(data) };
  }

  async fetchOutboundOrdersForDay(bizDate: string): Promise<JstOutboundOrder[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bizDate)) throw new Error("bizDate 须为 YYYY-MM-DD");
    let cursor = "1";
    const latestByOrder = new Map<string, JstOutboundOrder>();
    let complete = false;
    for (let page = 0; page < MAX_CURSOR_PAGES; page++) {
      const result = await this.queryOutboundOrdersPage({
        modified_begin: `${bizDate} 00:00:00`,
        modified_end: `${bizDate} 23:59:59`,
        date_type: 2,
        start_ts: cursor,
        page_index: 1,
        page_size: 50,
        is_get_total: false,
      });
      if (result.rows.length === 0) {
        complete = true;
        break;
      }
      let maxCursor = cursor;
      for (const row of result.rows) {
        const previous = latestByOrder.get(row.ioId);
        if (!previous || BigInt(row.cursor) > BigInt(previous.cursor)) {
          latestByOrder.set(row.ioId, row);
        }
        if (BigInt(row.cursor) > BigInt(maxCursor)) maxCursor = row.cursor;
      }
      if (BigInt(maxCursor) <= BigInt(cursor)) {
        throw new Error("聚水潭出库游标未前进，已中止以避免无限重放");
      }
      cursor = maxCursor;
    }
    if (!complete) throw new Error("聚水潭出库游标分页超过安全上限，拒绝返回不完整结果");
    return [...latestByOrder.values()];
  }

  async queryInventoryPage(biz: Record<string, unknown>): Promise<JstPage<JstInventoryRow>> {
    const data = await this.call("/open/inventory/query", biz);
    const rows = extractRows(data).map((raw, index) => {
      const row = asObject(raw, `inventorys[${index}]`);
      return {
        skuCode: required(row.sku_id, "sku_id"),
        itemId: nonEmpty(row.i_id),
        name: nonEmpty(row.name),
        warehouseCode: nonEmpty(row.wms_co_id),
        qty: decimalString(row.qty, "qty"),
        orderLockQty: optionalDecimalString(row.order_lock, "order_lock"),
        pickLockQty: optionalDecimalString(row.pick_lock, "pick_lock"),
        inventoryLockQty: optionalDecimalString(row.lock_qty, "lock_qty"),
        virtualQty: optionalDecimalString(row.virtual_qty, "virtual_qty"),
        purchaseQty: optionalDecimalString(row.purchase_qty, "purchase_qty"),
        returnQty: optionalDecimalString(row.return_qty, "return_qty"),
        inboundQty: optionalDecimalString(row.in_qty, "in_qty"),
        transferInboundQty: optionalDecimalString(row.allocate_qty, "allocate_qty"),
        saleRefundInboundQty: optionalDecimalString(row.sale_refund_qty, "sale_refund_qty"),
        defectiveQty: optionalDecimalString(row.defective_qty, "defective_qty"),
        minQty: optionalDecimalString(row.min_qty, "min_qty"),
        maxQty: optionalDecimalString(row.max_qty, "max_qty"),
        modifiedAt: nonEmpty(row.modified),
        cursor: cursorString(row.ts, "ts"),
      };
    });
    return { rows, hasNext: parseHasNext(data) };
  }

  async fetchInventoryChanged(input: {
    warehouseCode?: string;
    startCursor?: string;
    modifiedBegin?: string;
    modifiedEnd?: string;
    includeLockQty?: boolean;
  }): Promise<JstInventoryRow[]> {
    const cursorMode = input.startCursor !== undefined;
    const timeMode = input.modifiedBegin !== undefined || input.modifiedEnd !== undefined;
    if (cursorMode === timeMode) {
      throw new Error("聚水潭库存查询须且只能选择 ts 游标或修改时间范围");
    }
    if (timeMode) {
      if (!input.modifiedBegin || !input.modifiedEnd) {
        throw new Error("聚水潭库存修改起止时间必须同时提供");
      }
      assertInventoryWindow(input.modifiedBegin, input.modifiedEnd);
    }

    let cursor = cursorMode ? cursorString(input.startCursor, "startCursor") : null;
    const latestBySkuWarehouse = new Map<string, JstInventoryRow>();
    let complete = false;
    for (let page = 0; page < MAX_CURSOR_PAGES; page++) {
      const result = await this.queryInventoryPage(cursorMode ? {
        ts: cursor,
        page_index: 1,
        page_size: 100,
        ...(input.includeLockQty ? { has_lock_qty: true } : {}),
        ...(input.warehouseCode ? { wms_co_id: input.warehouseCode } : {}),
      } : {
        modified_begin: input.modifiedBegin,
        modified_end: input.modifiedEnd,
        page_index: page + 1,
        page_size: 100,
        ...(input.includeLockQty ? { has_lock_qty: true } : {}),
        ...(input.warehouseCode ? { wms_co_id: input.warehouseCode } : {}),
      });
      if (result.rows.length === 0) {
        complete = true;
        break;
      }
      let maxCursor = cursor;
      for (const sourceRow of result.rows) {
        // The inventory response contract does not guarantee wms_co_id in each row. When the
        // request is scoped to one warehouse, preserve that request grain explicitly.
        const row = sourceRow.warehouseCode === null && input.warehouseCode
          ? { ...sourceRow, warehouseCode: input.warehouseCode }
          : sourceRow;
        const identity = `${row.skuCode}\0${row.warehouseCode ?? ""}`;
        const previous = latestBySkuWarehouse.get(identity);
        if (!previous || BigInt(row.cursor) > BigInt(previous.cursor)) {
          latestBySkuWarehouse.set(identity, row);
        }
        if (cursorMode && maxCursor !== null && BigInt(row.cursor) > BigInt(maxCursor)) {
          maxCursor = row.cursor;
        }
      }
      if (cursorMode) {
        if (maxCursor === null || cursor === null || BigInt(maxCursor) <= BigInt(cursor)) {
          throw new Error("聚水潭库存游标未前进，已中止以避免无限重放");
        }
        cursor = maxCursor;
      } else if (result.hasNext === false || (result.hasNext === null && result.rows.length < 100)) {
        complete = true;
        break;
      }
    }
    if (!complete) throw new Error("聚水潭库存分页超过安全上限，拒绝返回不完整结果");
    return [...latestBySkuWarehouse.values()];
  }

  async queryWarehousesPage(
    pageIndex: number,
    pageSize = 30,
  ): Promise<JstPage<JstWarehouse>> {
    if (!Number.isInteger(pageIndex) || pageIndex < 1) throw new Error("聚水潭仓库页码必须从 1 开始");
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new Error("聚水潭仓库每页数量必须为 1–100");
    }
    const data = await this.call("/open/wms/partner/query", {
      page_index: pageIndex,
      page_size: pageSize,
    });
    const rows = extractRows(data).map((raw, index) => {
      const row = asObject(raw, `warehouses[${index}]`);
      return {
        warehouseCode: required(row.wms_co_id, "wms_co_id"),
        companyCode: required(row.co_id, "co_id"),
        name: required(row.name, "name"),
        isMain: row.is_main === true || row.is_main === 1 || row.is_main === "1",
        status: nonEmpty(row.status),
        partnerRemark: nonEmpty(row.remark1),
        merchantRemark: nonEmpty(row.remark2),
      };
    });
    return { rows, hasNext: parseHasNext(data) };
  }

  async fetchWarehouses(): Promise<JstWarehouse[]> {
    const pageSize = 30;
    const byCode = new Map<string, JstWarehouse>();
    let complete = false;
    for (let pageIndex = 1; pageIndex <= MAX_CURSOR_PAGES; pageIndex++) {
      const page = await this.queryWarehousesPage(pageIndex, pageSize);
      for (const row of page.rows) byCode.set(row.warehouseCode, row);
      if (page.hasNext === false || (page.hasNext === null && page.rows.length < pageSize)) {
        complete = true;
        break;
      }
    }
    if (!complete) throw new Error("聚水潭仓库分页超过安全上限，拒绝返回不完整结果");
    return [...byCode.values()].sort((left, right) =>
      left.warehouseCode.localeCompare(right.warehouseCode, "en"));
  }
}
