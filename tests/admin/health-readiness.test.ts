/** Real helper + public route + SQL construction; only filesystem and database I/O are stubbed. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mocks = vi.hoisted(() => ({ readdirSync: vi.fn(), getDbAsync: vi.fn(), execute: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  readdirSync: mocks.readdirSync,
}));
vi.mock("@/db", () => ({ getDbAsync: mocks.getDbAsync }));

import { GET } from "@/app/api/health/route";
import { readMigrationReadiness } from "@/server/core/migration-readiness";

const dialect = new PgDialect();
const queryText = (query: SQL) => dialect.sqlToQuery(query).sql;
const pgliteLedger = "SELECT count(*)::int AS c FROM _migrations";
const postgresLedger = "SELECT count(*)::int AS c FROM drizzle.__drizzle_migrations";
const privateError = "SYNTHETIC_PRIVATE_CONNECTION_SQL_OR_PATH";
const missingTable = () => Object.assign(new Error(privateError), { code: "42P01" });
const countResult = (c: unknown) => ({ rows: [{ c }] });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.readdirSync.mockReturnValue(["0000_first.sql", "0001_second.sql", "meta", "README.md"]);
  mocks.getDbAsync.mockResolvedValue({ execute: mocks.execute });
  mocks.execute.mockImplementation(async (query: SQL) => {
    const text = queryText(query);
    if (text === "SELECT 1") return { rows: [{ alive: 1 }] };
    if (text === pgliteLedger) return countResult(2);
    if (text === postgresLedger) throw missingTable();
    throw new Error(`Unexpected synthetic SQL: ${text}`);
  });
});

async function response() {
  const result = await GET();
  const body = await result.json();
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(JSON.stringify(body)).not.toContain(privateError);
  return { result, body };
}

async function expectUnknown(extra: Record<string, unknown> = {}) {
  const { result, body } = await response();
  expect(result.status).toBe(503);
  expect(body).toMatchObject({ ok: false, dbOk: true, applied: -1, drift: false, migrationState: "unknown", ...extra });
  expect(body.hint).toMatch(/[\u4e00-\u9fff]/);
  return body;
}

describe("migration readiness is known and fail-closed", () => {
  it("PGlite 的唯一账本与文件数一致才就绪，并保留兼容字段", async () => {
    const { result, body } = await response();
    expect(result.status).toBe(200);
    expect(body).toEqual({ ok: true, dbOk: true, migrationFiles: 2, applied: 2, drift: false, migrationState: "current" });
    expect(mocks.execute.mock.calls.map(([query]) => queryText(query))).toEqual(["SELECT 1", pgliteLedger, postgresLedger]);
  });

  it("PGlite 账本明确缺表后可确认 PG 账本，支持 Drizzle cause 包装", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error(privateError, { cause: missingTable() }))
      .mockResolvedValueOnce(countResult("2"));
    const { result, body } = await response();
    expect(result.status).toBe(200);
    expect(body).toMatchObject({ applied: 2, migrationState: "current", ok: true });
  });

  it.each([
    { applied: 0, state: "behind" },
    { applied: 1, state: "behind" },
    { applied: 3, state: "ahead" },
  ])("已应用 $applied 明确为 $state，而非正常", async ({ applied, state }) => {
    mocks.execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce(countResult(applied));
    const { result, body } = await response();
    expect(result.status).toBe(503);
    expect(body).toMatchObject({ ok: false, dbOk: true, applied, drift: true, migrationState: state });
    expect(body.hint).toContain(state === "behind" ? "迁移落后" : "迁移超前");
  });

  it("两个账本均缺失不是 PG 模式绿灯", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(missingTable());
    await expectUnknown();
  });

  it.each([2, 1, 3])("两个账本同时存在（第二份 %s）不挑匹配项放行", async (second) => {
    mocks.execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce(countResult(2)).mockResolvedValueOnce(countResult(second));
    const body = await expectUnknown();
    expect(body.hint).toContain("人工核对");
    expect(body.hint).toContain("勿直接删除账本");
  });

  it.each(["42501", "08006", "XX000", undefined])("%s 错误不能当缺表回落到另一账本", async (code) => {
    const failure = Object.assign(new Error(privateError), code ? { code } : {});
    mocks.execute.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error(privateError, { cause: failure }));
    await expectUnknown();
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });

  it("一张账本计数匹配但另一张权限失败仍不能就绪", async () => {
    mocks.execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce(countResult(2))
      .mockRejectedValueOnce(Object.assign(new Error(privateError), { code: "42501" }));
    await expectUnknown();
  });

  it("外层明确错误码不能被内层缺表码洗掉", async () => {
    const error = Object.assign(new Error(privateError, { cause: missingTable() }), { code: "42501" });
    mocks.execute.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(error);
    await expectUnknown();
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });

  it("循环 cause 不挂起或泄露错误", async () => {
    const error: { message: string; cause?: unknown } = { message: privateError };
    error.cause = error;
    mocks.execute.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(error);
    await expectUnknown();
  });

  it.each([
    undefined, null, false, true, "", " ", " 2 ", "2.0", "+2", "0x2", "2e0", "NaN",
    -1, -2, 1.5, NaN, Infinity, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1,
  ])("非法计数 %s 不得转换为零或假成功", async (count) => {
    mocks.execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce(countResult(count));
    await expectUnknown();
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });

  it.each([null, {}, { rows: [] }, { rows: [null] }, { rows: [{ c: 2 }, { c: 2 }] }])("畸形账本响应 %# 必须未知", async (value) => {
    mocks.execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce(value);
    await expectUnknown();
  });

  it("数据库初始化失败安全返回不可用，不泄露路径/连接串", async () => {
    mocks.getDbAsync.mockRejectedValue(new Error(privateError));
    const body = await expectUnknown({ dbOk: false });
    expect(body.error).toBe(body.hint);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("SELECT 1 失败不可被账本 fallback 伪装为健康", async () => {
    mocks.execute.mockRejectedValueOnce(new Error(privateError));
    await expectUnknown({ dbOk: false });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it("文件不可读不泄露路径；DB 探活与迁移未知分别报告", async () => {
    mocks.readdirSync.mockImplementation(() => { throw new Error(privateError); });
    await expectUnknown({ migrationFiles: -1, applied: 2 });
    expect(mocks.execute).toHaveBeenCalledTimes(3);
  });

  it("空迁移目录和零应用数不构成 0/0 假就绪", async () => {
    mocks.readdirSync.mockReturnValue(["meta", "README.md"]);
    mocks.execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce(countResult(0));
    await expectUnknown({ migrationFiles: 0, applied: 0 });
  });

  it("共享服务结果明确携带 ready，供管理页使用而非再算一套", async () => {
    const result = await readMigrationReadiness(mocks.getDbAsync);
    expect(result).toEqual({ dbOk: true, migrations: { files: 2, applied: 2, drift: false, state: "current", ready: true } });
    mocks.execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce(countResult(3));
    expect(await readMigrationReadiness(mocks.getDbAsync)).toMatchObject({
      dbOk: true, migrations: { files: 2, applied: 3, drift: true, state: "ahead", ready: false },
    });
  });
});
