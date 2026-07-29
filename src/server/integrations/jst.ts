import { createHash } from "node:crypto";
import { fetchJson, type FetchJsonOptions } from "./http";

const DEFAULT_BASE_URL = "https://openapi.jushuitan.com";
const RATE_LIMIT_CODES = new Set([199, 200]);

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
}

export interface JstInventoryRow {
  skuCode: string;
  itemId: string | null;
  warehouseCode: string | null;
  qty: string;
  orderLockQty: string | null;
  pickLockQty: string | null;
  virtualQty: string | null;
  purchaseQty: string | null;
  defectiveQty: string | null;
  modifiedAt: string | null;
  cursor: string;
}

export interface JstPage<T> {
  rows: T[];
  hasNext: boolean | null;
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
  return {
    appKey,
    appSecret,
    accessToken,
    baseUrl: env.JST_BASE_URL?.trim() || DEFAULT_BASE_URL,
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
      return {
        ioId: required(order.io_id, "io_id"),
        orderId: nonEmpty(order.o_id),
        salesOrderId: nonEmpty(order.so_id),
        shopId: nonEmpty(order.shop_id),
        warehouseCode: nonEmpty(order.wms_co_id),
        status: required(order.status, "status"),
        ioDate: required(order.io_date, "io_date"),
        modifiedAt: nonEmpty(order.modified),
        cursor: required(order.ts, "ts"),
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
      };
    });
    return { rows, hasNext: parseHasNext(data) };
  }

  async fetchOutboundOrdersForDay(bizDate: string): Promise<JstOutboundOrder[]> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bizDate)) throw new Error("bizDate 须为 YYYY-MM-DD");
    let cursor = "1";
    const all: JstOutboundOrder[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < 10_000; page++) {
      const result = await this.queryOutboundOrdersPage({
        modified_begin: `${bizDate} 00:00:00`,
        modified_end: `${bizDate} 23:59:59`,
        date_type: 2,
        start_ts: cursor,
        page_index: 1,
        page_size: 50,
        is_get_total: false,
      });
      if (result.rows.length === 0) break;
      let maxCursor = cursor;
      for (const row of result.rows) {
        if (!seen.has(row.ioId)) {
          seen.add(row.ioId);
          all.push(row);
        }
        if (BigInt(row.cursor) > BigInt(maxCursor)) maxCursor = row.cursor;
      }
      if (BigInt(maxCursor) <= BigInt(cursor)) {
        throw new Error("聚水潭出库游标未前进，已中止以避免无限重放");
      }
      cursor = maxCursor;
      if (result.hasNext === false) break;
    }
    return all;
  }

  async queryInventoryPage(biz: Record<string, unknown>): Promise<JstPage<JstInventoryRow>> {
    const data = await this.call("/open/inventory/query", biz);
    const rows = extractRows(data).map((raw, index) => {
      const row = asObject(raw, `inventorys[${index}]`);
      return {
        skuCode: required(row.sku_id, "sku_id"),
        itemId: nonEmpty(row.i_id),
        warehouseCode: nonEmpty(row.wms_co_id),
        qty: decimalString(row.qty, "qty"),
        orderLockQty: nonEmpty(row.order_lock),
        pickLockQty: nonEmpty(row.pick_lock),
        virtualQty: nonEmpty(row.virtual_qty),
        purchaseQty: nonEmpty(row.purchase_qty),
        defectiveQty: nonEmpty(row.defective_qty),
        modifiedAt: nonEmpty(row.modified),
        cursor: required(row.ts, "ts"),
      };
    });
    return { rows, hasNext: parseHasNext(data) };
  }

  async fetchInventoryChanged(input: {
    modifiedBegin: string;
    modifiedEnd: string;
    warehouseCode?: string;
    startCursor?: string;
  }): Promise<JstInventoryRow[]> {
    let cursor = input.startCursor ?? "1";
    const all: JstInventoryRow[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < 10_000; page++) {
      const result = await this.queryInventoryPage({
        modified_begin: input.modifiedBegin,
        modified_end: input.modifiedEnd,
        ts: cursor,
        page_index: 1,
        page_size: 100,
        ...(input.warehouseCode ? { wms_co_id: input.warehouseCode } : {}),
      });
      if (result.rows.length === 0) break;
      let maxCursor = cursor;
      for (const row of result.rows) {
        const identity = `${row.skuCode}\0${row.warehouseCode ?? ""}\0${row.cursor}`;
        if (!seen.has(identity)) {
          seen.add(identity);
          all.push(row);
        }
        if (BigInt(row.cursor) > BigInt(maxCursor)) maxCursor = row.cursor;
      }
      if (BigInt(maxCursor) <= BigInt(cursor)) {
        throw new Error("聚水潭库存游标未前进，已中止以避免无限重放");
      }
      cursor = maxCursor;
      if (result.hasNext === false) break;
    }
    return all;
  }
}
