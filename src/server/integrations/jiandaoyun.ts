import { createHash } from "node:crypto";
import { fetchJson, type FetchJsonOptions } from "./http";

const DEFAULT_BASE_URL = "https://api.jiandaoyun.com/api/v5";
const PAGE_SIZE = 100;
const MAX_CATALOG_PAGES = 1_000;
const MAX_DATA_PAGES = 1_000;
const OBJECT_ID = /^[0-9a-f]{24}$/;

export interface JiandaoyunConfig {
  apiKey: string;
  baseUrl: string;
}

export interface JiandaoyunApp {
  appId: string;
  name: string;
}

export interface JiandaoyunForm {
  appId: string;
  entryId: string;
  name: string;
}

export interface JiandaoyunWidget {
  name: string;
  label: string;
  type: string;
  items: JiandaoyunWidget[];
}

export interface JiandaoyunRecord {
  _id: string;
  [key: string]: unknown;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`简道云响应 ${label} 结构非法`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const result = String(value).trim();
  return result === "" ? null : result;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`简道云响应 ${label} 结构非法`);
  return value;
}

function objectId(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!OBJECT_ID.test(normalized)) throw new Error(`${label} 非法`);
  return normalized;
}

function parseApps(payload: unknown): JiandaoyunApp[] {
  return array(object(payload, "app.list").apps, "app.list.apps").map((raw, index) => {
    const row = object(raw, `app.list.apps[${index}]`);
    const appId = text(row.app_id);
    const name = text(row.name);
    if (!appId || !name) throw new Error(`简道云响应 app.list.apps[${index}] 缺少 app_id/name`);
    return { appId: objectId(appId, "简道云 app_id"), name };
  });
}

function parseForms(payload: unknown, expectedAppId: string): JiandaoyunForm[] {
  return array(object(payload, "entry.list").forms, "entry.list.forms").map((raw, index) => {
    const row = object(raw, `entry.list.forms[${index}]`);
    const appId = text(row.app_id);
    const entryId = text(row.entry_id);
    const name = text(row.name);
    if (!appId || !entryId || !name) {
      throw new Error(`简道云响应 entry.list.forms[${index}] 缺少 app_id/entry_id/name`);
    }
    if (objectId(appId, "简道云 app_id") !== expectedAppId) {
      throw new Error("简道云响应 form.app_id 与请求不一致");
    }
    return { appId: expectedAppId, entryId: objectId(entryId, "简道云 entry_id"), name };
  });
}

function parseWidget(raw: unknown, label: string): JiandaoyunWidget {
  const row = object(raw, label);
  const name = text(row.name);
  const widgetLabel = text(row.label);
  const type = text(row.type);
  if (!name || !widgetLabel || !type) throw new Error(`简道云响应 ${label} 缺少 name/label/type`);
  const items = row.items == null
    ? []
    : array(row.items, `${label}.items`).map((item, index) =>
        parseWidget(item, `${label}.items[${index}]`));
  return { name, label: widgetLabel, type, items };
}

function parseWidgets(payload: unknown): JiandaoyunWidget[] {
  return array(object(payload, "widget.list").widgets, "widget.list.widgets")
    .map((raw, index) => parseWidget(raw, `widget.list.widgets[${index}]`));
}

function parseRecords(
  payload: unknown,
  expectedAppId: string,
  expectedEntryId: string,
): JiandaoyunRecord[] {
  return array(object(payload, "data.list").data, "data.list.data").map((raw, index) => {
    const row = object(raw, `data.list.data[${index}]`);
    const id = text(row._id);
    const appId = text(row.appId);
    const entryId = text(row.entryId);
    if (!id || !appId || !entryId) {
      throw new Error(`简道云响应 data.list.data[${index}] 缺少 _id/appId/entryId`);
    }
    if (
      objectId(appId, "简道云 app_id") !== expectedAppId
      || objectId(entryId, "简道云 entry_id") !== expectedEntryId
    ) {
      throw new Error(`简道云响应 data.list.data[${index}] 表单身份与请求不一致`);
    }
    return { ...row, _id: objectId(id, "简道云 data_id") };
  });
}

export function jiandaoyunConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): JiandaoyunConfig | null {
  const apiKey = env.JIANDAOYUN_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (env.JIANDAOYUN_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!/^https:\/\//i.test(baseUrl)) throw new Error("JIANDAOYUN_BASE_URL 必须使用 HTTPS");
  return { apiKey, baseUrl };
}

export function jiandaoyunSyncActorId(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const actorId = Number(env.JIANDAOYUN_SYNC_ACTOR_ID);
  return Number.isInteger(actorId) && actorId > 0 ? actorId : null;
}

export function jiandaoyunEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return ["1", "true", "yes"].includes(
    env.JIANDAOYUN_SYNC_ENABLED?.trim().toLowerCase() ?? "",
  );
}

export class JiandaoyunClient {
  private readonly config: JiandaoyunConfig;
  private readonly transport: FetchJsonOptions;

  constructor(config: JiandaoyunConfig, transport: FetchJsonOptions = {}) {
    this.config = config;
    this.transport = transport;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    return fetchJson(
      "简道云 OpenAPI",
      `${this.config.baseUrl}${path}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      },
      this.transport,
    );
  }

  async listApps(): Promise<JiandaoyunApp[]> {
    const result = new Map<string, JiandaoyunApp>();
    for (let pageNo = 1; pageNo <= MAX_CATALOG_PAGES; pageNo++) {
      const skip = (pageNo - 1) * PAGE_SIZE;
      const page = parseApps(await this.post("/app/list", { limit: PAGE_SIZE, skip }));
      for (const app of page) result.set(app.appId, app);
      if (page.length < PAGE_SIZE) {
        return [...result.values()].sort((left, right) =>
          `${left.name}\0${left.appId}`.localeCompare(`${right.name}\0${right.appId}`, "zh-CN"));
      }
    }
    throw new Error(`简道云应用目录超过安全页上限 ${MAX_CATALOG_PAGES}`);
  }

  async listForms(appIdInput: string): Promise<JiandaoyunForm[]> {
    const appId = objectId(appIdInput, "简道云 app_id");
    const result = new Map<string, JiandaoyunForm>();
    for (let pageNo = 1; pageNo <= MAX_CATALOG_PAGES; pageNo++) {
      const skip = (pageNo - 1) * PAGE_SIZE;
      const page = parseForms(
        await this.post("/app/entry/list", { app_id: appId, limit: PAGE_SIZE, skip }),
        appId,
      );
      for (const form of page) result.set(`${form.appId}:${form.entryId}`, form);
      if (page.length < PAGE_SIZE) {
        return [...result.values()].sort((left, right) =>
          `${left.name}\0${left.entryId}`.localeCompare(`${right.name}\0${right.entryId}`, "zh-CN"));
      }
    }
    throw new Error(`简道云表单目录超过安全页上限 ${MAX_CATALOG_PAGES}`);
  }

  async listWidgets(appIdInput: string, entryIdInput: string): Promise<JiandaoyunWidget[]> {
    const appId = objectId(appIdInput, "简道云 app_id");
    const entryId = objectId(entryIdInput, "简道云 entry_id");
    return parseWidgets(await this.post("/app/entry/widget/list", {
      app_id: appId,
      entry_id: entryId,
    }));
  }

  async listRecords(
    appIdInput: string,
    entryIdInput: string,
    fieldsInput?: readonly string[],
  ): Promise<JiandaoyunRecord[]> {
    const appId = objectId(appIdInput, "简道云 app_id");
    const entryId = objectId(entryIdInput, "简道云 entry_id");
    const fields = fieldsInput == null
      ? null
      : [...new Set(fieldsInput.map((field) => field.trim()).filter(Boolean))];
    if (fields !== null && fields.length === 0) {
      throw new Error("简道云 fields 不得为空");
    }
    const result = new Map<string, JiandaoyunRecord>();
    let cursor: string | null = null;
    for (let pageNo = 1; pageNo <= MAX_DATA_PAGES; pageNo++) {
      const body: Record<string, unknown> = {
        app_id: appId,
        entry_id: entryId,
        limit: PAGE_SIZE,
      };
      if (fields) body.fields = fields;
      if (cursor) body.data_id = cursor;
      const page = parseRecords(
        await this.post("/app/entry/data/list", body),
        appId,
        entryId,
      );
      for (const record of page) result.set(record._id, record);
      if (page.length < PAGE_SIZE) return [...result.values()];
      const next = page.at(-1)?._id ?? null;
      if (!next || next === cursor) throw new Error("简道云 data_id 游标未前进");
      cursor = next;
    }
    throw new Error(`简道云数据超过安全页上限 ${MAX_DATA_PAGES}，拒绝返回截断结果`);
  }
}

export function jiandaoyunSchemaHash(widgets: JiandaoyunWidget[]): string {
  const canonical = JSON.stringify(
    widgets.map((widget) => ({
      name: widget.name,
      label: widget.label,
      type: widget.type,
      items: widget.items.map((item) => ({
        name: item.name,
        label: item.label,
        type: item.type,
      })),
    })),
  );
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
