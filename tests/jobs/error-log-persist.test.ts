/**
 * TASK1：errorResponse 未预期 500 路径落 error_logs（best-effort、fire-and-forget）。
 * vi.mock @/db → 测试 PGlite；插入为异步浮动 promise，轮询等待落库。
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { createTestDb } from "../helpers/db";
import { errorLogs } from "@/db/schema";
import { persistErrorLog } from "@/server/core/logger";

const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("@/db", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return { ...orig, getDbAsync: async () => h.db };
});

import { ApiError, errorResponse } from "@/server/modules/master/common";

type Db = Awaited<ReturnType<typeof createTestDb>>["db"];

async function pollRows(db: Db, pred: (rows: (typeof errorLogs.$inferSelect)[]) => boolean): Promise<(typeof errorLogs.$inferSelect)[]> {
  for (let i = 0; i < 50; i++) {
    const rows = await db.select().from(errorLogs);
    if (pred(rows)) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return db.select().from(errorLogs);
}

describe("errorResponse → error_logs 留档", () => {
  let db: Db;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    h.db = db;
  });

  it("未预期错误：500 + errorId，异步落 error_logs（含 ctx path/method/userId）", async () => {
    const res = errorResponse(new Error("数据库炸了"), { path: "/api/x", method: "GET", userId: 7 });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; errorId: string };
    expect(body.errorId).toMatch(/^[0-9a-f]{8}$/);

    const rows = await pollRows(db, (r) => r.some((x) => x.errorId === body.errorId));
    const row = rows.find((x) => x.errorId === body.errorId);
    expect(row).toBeDefined();
    expect(row?.message).toContain("数据库炸了");
    expect(row?.path).toBe("/api/x");
    expect(row?.method).toBe("GET");
    expect(row?.userId).toBe(7);
    expect(row?.stack).toBeTruthy();
  });

  it("无 ctx 调用（现有调用方形态）：path/method 为 null 亦可落库", async () => {
    const res = errorResponse(new TypeError("boom-no-ctx"));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { errorId: string };
    const rows = await pollRows(db, (r) => r.some((x) => x.errorId === body.errorId));
    const row = rows.find((x) => x.errorId === body.errorId);
    expect(row?.path).toBeNull();
    expect(row?.method).toBeNull();
    expect(row?.message).toContain("boom-no-ctx");
  });

  it("业务错误（ApiError/Zod/唯一键冲突）不落 error_logs", async () => {
    const before = (await db.select().from(errorLogs)).length;
    const res = errorResponse(new ApiError(404, "找不到"));
    expect(res.status).toBe(404);
    await new Promise((r) => setTimeout(r, 200));
    expect((await db.select().from(errorLogs)).length).toBe(before);
  });

  it("persistErrorLog 落库失败静默吞掉（不破坏响应路径）", async () => {
    await expect(
      persistErrorLog({ errorId: "deadbeef", message: "x" }, { insert: () => { throw new Error("db down"); } }),
    ).resolves.toBeUndefined();
  });
});
